class ExtensionConfig {
    constructor(storageArea = 'sync') {
        this.storage = chrome.storage[storageArea];
    }

    async get(keys) {
        return await this.storage.get(keys);
    }

    async set(items) {
        return await this.storage.set(items);
    }
}

class PopupController {
    constructor() {
        this.config = new ExtensionConfig();
        this._queryElements();
    }

    _queryElements() {
        this.elements = {
            mainView: document.getElementById('main-view'),
            settingsView: document.getElementById('settings-view'),
            
            translationTrigger: document.getElementById('start-translation-btn'),
            goToSettingsBtn: document.getElementById('go-to-settings-btn'),
            backToMainBtn: document.getElementById('back-to-main-btn'),

            apiKeyPersistButton: document.getElementById('save-api-config-btn'),
            apiKeyInput: document.getElementById('api-key-input'),
            apiUrlInput: document.getElementById('api-url-input'),
            modelNameInput: document.getElementById('model-name-input'),
            temperatureInput: document.getElementById('temperature-input'),
            temperatureValueSpan: document.getElementById('temperature-value'),
            languageSelect: document.getElementById('target-language-select'),
            displayPreferenceRadios: document.querySelectorAll('input[name="display-preference"]'),
        };
    }

    async initialize() {
        await this._restoreUiState();
        this._attachEventListeners();
    }

    async _restoreUiState() {
        const storedData = await this.config.get(['apiKey', 'targetLanguage', 'displayPreference', 'apiBaseUrl', 'modelName', 'temperature']);
        
        this.elements.apiKeyInput.value = storedData.apiKey || '';
        this.elements.apiUrlInput.value = storedData.apiBaseUrl || 'https://openrouter.ai/api/v1';
        this.elements.modelNameInput.value = storedData.modelName || 'google/gemini-2.5-flash-preview-05-20';
        
        const temperature = storedData.temperature !== undefined ? storedData.temperature : 0.7;
        this.elements.temperatureInput.value = temperature;
        this.elements.temperatureValueSpan.textContent = temperature;

        if (storedData.targetLanguage) {
            this.elements.languageSelect.value = storedData.targetLanguage;
        }
        if (storedData.displayPreference) {
            const radio = document.querySelector(`input[name="display-preference"][value="${storedData.displayPreference}"]`);
            if (radio) radio.checked = true;
        }
    }

    _attachEventListeners() {
        this.elements.goToSettingsBtn.addEventListener('click', () => this._showSettingsView());
        this.elements.backToMainBtn.addEventListener('click', () => this._showMainView());
        this.elements.temperatureInput.addEventListener('input', () => this._updateTemperatureDisplay());

        this.elements.apiKeyPersistButton.addEventListener('click', () => this._saveApiConfiguration());
        
        this.elements.displayPreferenceRadios.forEach(radio => {
            radio.addEventListener('change', (e) => this._saveDisplayPreference(e.target.value));
        });

        this.elements.translationTrigger.addEventListener('click', () => this._handleTranslateClick());
    }

    _showMainView() {
        this.elements.settingsView.classList.add('hidden');
        this.elements.mainView.classList.remove('hidden');
    }

    _showSettingsView() {
        this.elements.mainView.classList.add('hidden');
        this.elements.settingsView.classList.remove('hidden');
    }

    _updateTemperatureDisplay() {
        this.elements.temperatureValueSpan.textContent = this.elements.temperatureInput.value;
    }

    async _saveApiConfiguration() {
        const configToSave = {
            apiKey: this.elements.apiKeyInput.value.trim(),
            apiBaseUrl: this.elements.apiUrlInput.value.trim(),
            modelName: this.elements.modelNameInput.value.trim(),
            temperature: parseFloat(this.elements.temperatureInput.value)
        };

        if (configToSave.apiBaseUrl && configToSave.modelName) {
            await this.config.set(configToSave);
            const button = this.elements.apiKeyPersistButton;
            const originalText = button.textContent;
            button.textContent = 'Saved!';
            setTimeout(() => {
                button.textContent = originalText;
            }, 1500);
        }
    }

    async _saveDisplayPreference(preference) {
        await this.config.set({ displayPreference: preference });
    }

    async _handleTranslateClick() {
        this.elements.translationTrigger.disabled = true;
        this.elements.translationTrigger.textContent = 'Processing...';

        try {
            const targetLanguage = this.elements.languageSelect.value;
            await this.config.set({ targetLanguage });

            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

            if (tab) {
                await this._dispatchTranslationRequest(tab.id, targetLanguage);
            } else {
                console.warn('Could not find an active tab.');
            }

        } catch (error) {
            console.error('Error during translation initiation:', error);
            this.elements.translationTrigger.textContent = 'Error!';
            setTimeout(() => {
                this.elements.translationTrigger.textContent = 'Translate Subtitles';
                this.elements.translationTrigger.disabled = false;
            }, 2000);
        }
    }

    async _dispatchTranslationRequest(tabId, language) {
        const message = {
            action: 'initiate-translation',
            payload: { targetLanguage: language }
        };
        
        try {
            const response = await chrome.tabs.sendMessage(tabId, message);
            if (response?.status === 'success') {
                console.log('Translation request acknowledged.');
                window.close();
            }
        } catch (err) {
            if (err.message?.includes('Receiving end does not exist')) {
                console.log('Content script not ready. Injecting and retrying...');
                await chrome.scripting.executeScript({
                    target: { tabId: tabId },
                    files: ['content.js']
                });
                
                const retryResponse = await chrome.tabs.sendMessage(tabId, message);
                if (retryResponse?.status === 'success') {
                    console.log('Translation request successful after injection.');
                    window.close();
                }
            } else {
                throw err;
            }
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const controller = new PopupController();
    controller.initialize();
});