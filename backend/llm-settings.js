const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const SETTINGS_PATH = process.env.LLM_SETTINGS_FILE || path.join(DATA_DIR, 'llm_settings.json');

const DEFAULT_SETTINGS = {
    provider: process.env.LLM_PROVIDER || 'openai',
    model: process.env.LLM_MODEL || 'gpt-5.4-mini',
    updatedAt: null
};

const DEFAULT_VOICE_SETTINGS = {
    cloneModel: process.env.VOICE_CLONE_MODEL || process.env.CLONE_MODEL || 'speech-2.8-hd',
    ttsModel: process.env.TTS_MODEL || 'speech-2.8-turbo',
    updatedAt: null
};

fs.mkdirSync(DATA_DIR, { recursive: true });

function normalizeProvider(provider) {
    return provider === 'gemini' ? 'gemini' : 'openai';
}

function normalizeSettings(settings = {}) {
    const provider = normalizeProvider(settings.provider);
    const model = String(settings.model || DEFAULT_SETTINGS.model).trim();
    return {
        provider,
        model,
        updatedAt: settings.updatedAt || null
    };
}

function normalizeVoiceSettings(settings = {}) {
    return {
        cloneModel: String(settings.cloneModel || DEFAULT_VOICE_SETTINGS.cloneModel).trim(),
        ttsModel: String(settings.ttsModel || DEFAULT_VOICE_SETTINGS.ttsModel).trim(),
        updatedAt: settings.updatedAt || null
    };
}

function readRawSettings() {
    if (!fs.existsSync(SETTINGS_PATH)) {
        return {};
    }
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
}

function readSettings() {
    try {
        const parsed = readRawSettings();
        return normalizeSettings({ ...DEFAULT_SETTINGS, ...parsed });
    } catch (error) {
        console.warn('[LLMSettings] 설정 파일 읽기 실패, 기본값 사용:', error.message);
        return normalizeSettings(DEFAULT_SETTINGS);
    }
}

function saveSettings(nextSettings) {
    const current = (() => {
        try { return readRawSettings(); } catch (_) { return {}; }
    })();
    const settings = normalizeSettings({
        ...nextSettings,
        updatedAt: new Date().toISOString()
    });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify({
        ...current,
        ...settings
    }, null, 2), 'utf8');
    return settings;
}

function readVoiceSettings() {
    try {
        const parsed = readRawSettings();
        return normalizeVoiceSettings({ ...DEFAULT_VOICE_SETTINGS, ...(parsed.voice || {}) });
    } catch (error) {
        console.warn('[VoiceSettings] 설정 파일 읽기 실패, 기본값 사용:', error.message);
        return normalizeVoiceSettings(DEFAULT_VOICE_SETTINGS);
    }
}

function saveVoiceSettings(nextSettings) {
    const current = (() => {
        try { return readRawSettings(); } catch (_) { return {}; }
    })();
    const voice = normalizeVoiceSettings({
        ...nextSettings,
        updatedAt: new Date().toISOString()
    });
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify({
        ...current,
        voice
    }, null, 2), 'utf8');
    return voice;
}

module.exports = {
    SETTINGS_PATH,
    DEFAULT_SETTINGS: normalizeSettings(DEFAULT_SETTINGS),
    DEFAULT_VOICE_SETTINGS: normalizeVoiceSettings(DEFAULT_VOICE_SETTINGS),
    readSettings,
    saveSettings,
    readVoiceSettings,
    saveVoiceSettings,
    normalizeProvider
};
