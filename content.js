/**
 * Utility for creating and manipulating DOM elements.
 */
const DOMHelper = {
    createElement(tag, options = {}) {
        const el = document.createElement(tag);
        if (options.className) el.className = options.className;
        if (options.text) el.textContent = options.text;
        if (options.style) Object.assign(el.style, options.style);
        if (options.attributes) {
            for (const [key, value] of Object.entries(options.attributes)) {
                el.setAttribute(key, value);
            }
        }
        return el;
    }
};

/**
 * Manages configuration stored in chrome.storage.
 */
class ExtensionConfig {
    constructor(storageArea = 'sync') {
        this.storage = chrome.storage[storageArea];
    }
    async get(keys) {
        return await this.storage.get(keys);
    }
}

/**
 * Handles communication with the translation API.
 */
class TranslationAPI {
    constructor(config) {
        this.config = config;
        this.translationCache = new Map();
    }

    async fetchTranslation(text, { prevText = '', nextText = '', language }) {
        const cacheKey = `${language}:${text}`;
        if (this.translationCache.has(cacheKey)) {
            return this.translationCache.get(cacheKey);
        }
        
        const languageMap = {
            'zh': 'Chinese',
            'en': 'English',
            'fr': 'French',
            'de': 'German',
            'hi': 'Hindi',
            'ja': 'Japanese',
            'ko': 'Korean',
            'pt': 'Portuguese',
            'ru': 'Russian',
            'es': 'Spanish',
            'vi': 'Vietnamese'
        };
        const fullLanguageName = languageMap[language] || language;

        const { apiKey, apiBaseUrl, modelName, temperature } = await this.config.get(['apiKey', 'apiBaseUrl', 'modelName', 'temperature']);
        if (!apiKey || !apiBaseUrl || !modelName) {
            throw new Error('API configuration is incomplete. Please set it in the extension popup.');
        }

        const prompt = `You are a professional subtitle translator. Translate the following English subtitle into ${fullLanguageName}.
        Provide only the translation, without any additional text or explanations.
        Previous line for context: "${prevText}"
        Next line for context: "${nextText}"
        Line to translate: "${text}"`;

        const response = await fetch(`${apiBaseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model: modelName,
                messages: [{ role: 'user', content: prompt }],
            }),
        });

        if (!response.ok) {
            const errorData = await response.json();
            throw new Error(`API request failed: ${errorData.error?.message || response.statusText}`);
        }

        const data = await response.json();
        const translatedText = data.choices[0]?.message?.content.trim();
        
        if (translatedText) {
            this.translationCache.set(cacheKey, translatedText);
        }
        
        return translatedText;
    }
}


/**
 * Abstract base class for site-specific subtitle handling.
 */
class SiteAdapter {
    constructor(translator, config) {
        if (this.constructor === SiteAdapter) {
            throw new Error("Abstract classes can't be instantiated.");
        }
        this.translator = translator;
        this.config = config;
        this.progressIndicator = null;
    }

    async processSubtitles(language) {
        throw new Error('Method "processSubtitles" must be implemented.');
    }

    _showProgress(total) {
        this._removeProgress();
        this.progressIndicator = DOMHelper.createElement('div', {
            className: 'subtitle-enhancer-progress',
            text: 'Starting translation...',
            style: {
                position: 'fixed', bottom: '20px', right: '20px',
                background: 'linear-gradient(45deg, #3b82f6, #6366f1)',
                color: 'white', padding: '12px 20px', borderRadius: '8px',
                zIndex: '99999', boxShadow: '0 4px 15px rgba(0,0,0,0.2)',
                fontSize: '16px', fontWeight: '500'
            }
        });
        document.body.appendChild(this.progressIndicator);
    }
    _updateProgress(done, total) {
        if (this.progressIndicator) {
            this.progressIndicator.textContent = `Translating... (${done}/${total})`;
        }
    }
    _removeProgress() {
        if (this.progressIndicator) {
            this.progressIndicator.remove();
            this.progressIndicator = null;
        }
    }
}


/**
 * Adapter for Coursera.
 */
class CourseraAdapter extends SiteAdapter {
    constructor(translator, config) {
        super(translator, config);
        this.sourceCueText = null;
    }
    
    async processSubtitles(language) {
        const englishTrackElement = Array.from(document.getElementsByTagName("track"))
            .find(t => t.srclang === 'en');
            
        if (!englishTrackElement || !englishTrackElement.track) {
            console.warn('No English subtitle track found.');
            return;
        }

        englishTrackElement.track.mode = "showing";
        await new Promise(resolve => setTimeout(resolve, 500)); // Wait for cues to load

        let cues = Array.from(englishTrackElement.track.cues);
        if (!cues.length) return;

        if (!this.sourceCueText) {
            this.sourceCueText = cues.map(cue => cue.text);
        } else {
            // Restore original text before re-translating
            cues.forEach((cue, i) => cue.text = this.sourceCueText[i]);
        }

        this._showProgress(cues.length);
        const { displayPreference } = await this.config.get('displayPreference');
        const mode = displayPreference || 'bilingual';
        const BATCH_SIZE = 10;
        let translatedCount = 0;

        for (let i = 0; i < cues.length; i += BATCH_SIZE) {
            const batch = cues.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(async (cue, indexInBatch) => {
                const cueIndex = i + indexInBatch;
                const originalText = this.sourceCueText[cueIndex];
                const context = {
                    prevText: this.sourceCueText[cueIndex - 1] || '',
                    nextText: this.sourceCueText[cueIndex + 1] || '',
                    language
                };
                
                try {
                    const translatedText = await this.translator.fetchTranslation(originalText, context);
                    if (cues[cueIndex] && translatedText) {
                        cues[cueIndex].text = mode === 'bilingual'
                            ? `${translatedText}\n${originalText}`
                            : translatedText;
                    }
                } catch (error) {
                    console.error('Failed to translate a cue:', error);
                    // You might want to stop or show an error message. For now, we continue.
                } finally {
                    translatedCount++;
                    this._updateProgress(translatedCount, cues.length);
                }
            }));
        }
        this._removeProgress();
    }
}

/**
 * Main orchestrator for the content script.
 */
class ContentOrchestrator {
    constructor() {
        this.config = new ExtensionConfig();
        this.translator = new TranslationAPI(this.config);
        this.siteAdapter = this._createSiteAdapter();
        this._initializeMessageListener();
    }

    _createSiteAdapter() {
        const { href } = window.location;
        if (href.includes('coursera.org')) {
            return new CourseraAdapter(this.translator, this.config);
        }
        return null;
    }

    _initializeMessageListener() {
        chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
            if (request.action === 'initiate-translation') {
                if (this.siteAdapter) {
                    const lang = request.payload.targetLanguage;
                    this.siteAdapter.processSubtitles(lang)
                        .then(() => {
                            sendResponse({ status: 'success' });
                        })
                        .catch(error => {
                            console.error('Subtitle processing failed:', error);
                            sendResponse({ status: 'error', message: error.message });
                        });
                    return true; // Indicates async response
                } else {
                    console.warn('No suitable site adapter found for this page.');
                    sendResponse({ status: 'error', message: 'Site not supported' });
                }
            }
        });
    }
}

// Prevents running the script multiple times on the same page
if (!window.contentOrchestrator) {
    window.contentOrchestrator = new ContentOrchestrator();
} 