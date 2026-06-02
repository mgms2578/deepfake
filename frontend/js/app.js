/**
 * Phishing Chat Voice - Frontend Controller
 * v4.0 - 음성 대화 모드 (전화 통화 UI) + 상태 머신
 */

import { TTSClient } from './core/TTSClient.js';
import { STTClient } from './core/STTClient.js';
import { AudioReactiveMeter } from './core/AudioReactiveMeter.js';

// 음성 대화 상태 상수
const VS = { IDLE: 'IDLE', LISTENING: 'LISTENING', PROCESSING: 'PROCESSING', SPEAKING: 'SPEAKING' };
const DEFAULT_RETURN_URL = 'https://hama.thinkpool.com/TP03AT11/main';

class App {
    constructor() {
        this.sessionId = null;
        this.openingMessage = null;
        this.currentScreen = 'screen-intro';
        this.historyEnabled = false;
        this.isRestoringHistory = false;
        this.ignoreNextPopState = false;
        this.returnUrl = this.resolveReturnUrl();
        this.pageTitles = {
            'screen-intro': '음성 딥페이크 체험',
            'screen-recording': '음성 녹음',
            'screen-cloning': '음성 복제',
            'screen-incoming-call': '전화 수신',
            'screen-chat': '대화 체험'
        };
        this.inactivityTimer = null;
        this.INACTIVITY_LIMIT = 30 * 60 * 1000;

        // 오디오 시스템
        this.ttsClient = new TTSClient();
        this.currentTurnId = 0;
        this.nextTurnId = 0;
        this.TTS_SENTENCE_MIN_LENGTH = 10;
        this.TTS_INTERMEDIATE_CHUNK_MIN_LENGTH = 250;
        this.TTS_SENTENCE_END_PATTERN = /[.!?\n]/g;
        this.CHAT_BUBBLE_MAX_LENGTH = 120;
        this.CHAT_BUBBLE_MAX_SENTENCES = 3;
        this.CHAT_BUBBLE_DELAY_MS = 300;
        this.MIN_VOICE_INPUT_LENGTH = 2;
        this.voiceSpeechStarted = false;
        this.voiceTranscriptText = '';
        this.voiceWaveLevel = 0;
        this.voiceInputStream = null;
        this.voiceInputMeter = new AudioReactiveMeter({
            fps: 30,
            gate: 0.016,
            onLevel: (level) => {
                if (this.voiceMode && this.voiceState === VS.LISTENING) {
                    this.updateWaveformLevel('voice-waveform', level);
                }
            }
        });
        this.recordingMeter = new AudioReactiveMeter({
            fps: 30,
            gate: 0.014,
            onLevel: (level) => {
                if (this.isRecording) this.updateWaveformLevel('waveform', level);
            }
        });
        this.chatBubbleTimers = [];

        // LLM 취소용 AbortController
        this.llmAbortController = null;
        this.activeRequestCount = 0;
        this.latencyTrace = null;
        this.pendingScenarioEnd = null;
        this.scenarioResultShown = false;

        // 마이크 녹음 (클로닝용)
        this.mediaRecorder = null;
        this.recordedChunks = [];
        this.isRecording = false;

        // iOS 디바이스 및 웹뷰(인앱 브라우저) 판별
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
        this.isIOS = isIOS;
        // iOS이면서 User-Agent에 'Safari'가 없으면 커스텀 웹뷰(인앱 브라우저)로 간주
        this.isIOSWebView = isIOS && !navigator.userAgent.includes('Safari');

        // STT (업로드 방식 - iOS 전용)
        this.sttClient = new STTClient();

        // STT (Web Speech API - 안드로이드/PC 전용)
        this.speechRecognition = null;
        this.sttSupported = ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);
        
        this.isListening = false;
        this.sttErrorCount = 0;
        this.STT_MAX_ERRORS = 3;

        // 음성 대화 모드
        this.voiceMode = false;
        this.voiceState = VS.IDLE;
        this.callTimer = null;
        this.callSeconds = 0;

        // DOM
        this.screens = document.querySelectorAll('.screen');
        this.messageArea = document.getElementById('message-area');
        this.chatInput = document.getElementById('chat-input');

        this.init();
    }

    resolveReturnUrl() {
        const params = new URLSearchParams(window.location.search);
        const requestedUrl = params.get('returnUrl') || params.get('return_url');
        if (!requestedUrl) return DEFAULT_RETURN_URL;

        try {
            const url = new URL(requestedUrl, window.location.origin);
            const allowedHost = url.hostname === 'hama.thinkpool.com' || url.hostname.endsWith('.hama.thinkpool.com');
            if (!allowedHost || !['http:', 'https:'].includes(url.protocol)) return DEFAULT_RETURN_URL;
            return url.href;
        } catch (error) {
            console.warn('[Navigation] invalid returnUrl:', requestedUrl);
            return DEFAULT_RETURN_URL;
        }
    }

    getChatBottomPadding() {
        const base = this.voiceMode ? '390px' : '128px';
        return `calc(${base} + var(--bottom-safe-area) + var(--keyboard-inset))`;
    }

    scrollMessagesToBottom() {
        if (!this.messageArea) return;
        requestAnimationFrame(() => {
            this.messageArea.scrollTop = this.messageArea.scrollHeight;
        });
    }

    logClientEvent(event) {
        const payload = {
            ...event,
            traceId: `turn-${event.turnId || this.currentTurnId || 'none'}`,
            sessionId: event.sessionId || this.sessionId || 'client',
            latency: this.latencyTrace?.turnId === event.turnId ? Math.round(performance.now() - this.latencyTrace.startedAt) : 0
        };

        fetch('/api/client-events', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            keepalive: true
        }).catch(() => {});
    }

    async init() {
        this.bindEvents();
        this.installViewportInsets();
        this.installBackNavigationGuard();
        this.updateServiceHeader();
        this.resetInactivityTimer();
        this.setupWaveform('waveform');
        this.setupWaveform('voice-waveform', 'voice-wave-bar');
        this.initSTT();

        // TTS 완료 콜백은 새로 생성하는 player에 붙여줄 예정
        this.ttsClient.onComplete = () => this._onTTSComplete();
        this.ttsClient.onFirstPacket = () => this.markLatency('tts_first_packet');
        this.ttsClient.onPlayStart = () => this.markLatency('audio_play_start');
        this.ttsClient.onEvent = (event) => this.logClientEvent(event);
        this.ttsClient.onVolume = (level) => {
            if (this.voiceMode && this.voiceState === VS.SPEAKING) this.updateWaveformLevel('voice-waveform', level);
        };
        this.cleanupServer();
    }

    bindEvents() {
        document.getElementById('btn-service-back').onclick = () => this.handleServiceBack();
        document.getElementById('btn-service-exit').onclick = () => this.confirmExperienceExit();
        document.getElementById('btn-start-experience').onclick = () => this.showModal('modal-consent');
        document.getElementById('btn-consent-back').onclick = () => this.closeConsentModal();
        document.getElementById('btn-consent-decline').onclick = () => this.closeConsentModal();
        document.getElementById('btn-consent-accept').onclick = () => this.startExperience();
        document.querySelectorAll('[data-exit-experience]').forEach(btn => {
            btn.onclick = () => this.endExperience();
        });

        document.getElementById('btn-record-control').onclick = () => this.toggleRecording();
        document.getElementById('input-file-upload').onchange = (e) => this.handleFileUpload(e);

        document.getElementById('btn-send').onclick = () => this.sendMessage();
        this.chatInput.onkeypress = (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); this.sendMessage(); }
        };

        document.getElementById('btn-call-accept').onclick = () => this.acceptCall();
        document.getElementById('btn-call-reject').onclick = () => this.endExperience();

        // 음성 대화 모드 ON/OFF
        document.getElementById('btn-voice-mode').onclick = () => this.toggleVoiceMode();

        // 껴들어 말하기 (TTS 중 barge-in)
        document.getElementById('btn-barge-in').onclick = () => this.bargeIn();

        // 음성대화 종료 (오버레이 내)
        document.getElementById('btn-voice-stop').onclick = () => this.stopVoiceMode();

        // 통화 종료 다이얼로그
        document.getElementById('btn-end-cancel').onclick = () => this.hideModal('modal-end-confirm');
        document.getElementById('btn-end-confirm').onclick = () => this.confirmEnd();
        document.getElementById('btn-scenario-result-finish').onclick = () => this.finishScenarioResult();

        window.onclick = () => this.resetInactivityTimer();
        window.onkeypress = () => this.resetInactivityTimer();
    }

    installViewportInsets() {
        const updateInsets = () => {
            const viewport = window.visualViewport;
            const keyboardInset = viewport
                ? Math.max(0, window.innerHeight - viewport.height - viewport.offsetTop)
                : 0;
            document.documentElement.style.setProperty('--keyboard-inset', `${Math.round(keyboardInset)}px`);
            if (this.messageArea) {
                this.messageArea.style.paddingBottom = this.getChatBottomPadding();
                this.scrollMessagesToBottom();
            }
        };

        updateInsets();
        window.visualViewport?.addEventListener('resize', updateInsets);
        window.visualViewport?.addEventListener('scroll', updateInsets);
        window.addEventListener('orientationchange', () => setTimeout(updateInsets, 250));
    }

    installBackNavigationGuard() {
        if (!history.pushState) return;
        this.historyEnabled = true;
        history.replaceState({ deepvoice: true, screen: this.currentScreen, entry: true }, '', window.location.href);
        history.pushState({ deepvoice: true, screen: this.currentScreen }, '', window.location.href);
        window.addEventListener('popstate', (event) => this.handleBrowserBack(event));
    }

    async handleBrowserBack(event) {
        const state = event.state || {};
        const consentModal = document.getElementById('modal-consent');
        const consentOpen = consentModal && consentModal.style.display === 'flex';

        if (this.ignoreNextPopState) {
            this.ignoreNextPopState = false;
            return;
        }

        if (state.deepvoiceModal === 'modal-consent') {
            this.showModal('modal-consent', { skipHistory: true });
            return;
        }
        if (consentOpen) {
            this.hideModal('modal-consent', { skipHistory: true });
            return;
        }

        if (this.currentScreen === 'screen-intro') {
            this.returnToHost();
            return;
        }

        const shouldExit = confirm('체험을 종료하고 딥보이스 메인으로 돌아가시겠습니까?');
        if (shouldExit) {
            await this.endExperience();
        } else {
            this.pushScreenHistory(this.currentScreen);
        }
    }

    async handleServiceBack() {
        if (this.currentScreen === 'screen-intro') {
            this.returnToHost();
            return;
        }

        await this.confirmExperienceExit();
    }

    updateServiceHeader() {
        const title = document.getElementById('service-page-title');
        if (title) title.innerText = this.pageTitles[this.currentScreen] || '음성 딥페이크 체험';
        const exitButton = document.getElementById('btn-service-exit');
        if (exitButton) {
            const isIntro = this.currentScreen === 'screen-intro';
            exitButton.style.visibility = isIntro ? 'hidden' : 'visible';
            exitButton.setAttribute('aria-hidden', isIntro ? 'true' : 'false');
            exitButton.tabIndex = isIntro ? -1 : 0;
        }
    }

    // ─── 화면 전환 ───
    showScreen(id, options = {}) {
        this.screens.forEach(s => s.classList.remove('active'));
        document.getElementById(id).classList.add('active');
        this.currentScreen = id;
        this.updateServiceHeader();
        if (!options.skipHistory) this.pushScreenHistory(id);

        // 전화벨 소리 제어
        const ringtone = document.getElementById('ringtone-audio');
        if (ringtone) {
            if (id === 'screen-incoming-call') {
                ringtone.currentTime = 0;
                ringtone.play().catch(e => console.log('Ringtone play blocked:', e));
            } else {
                ringtone.pause();
            }
        }
    }
    pushScreenHistory(screenId) {
        if (!this.historyEnabled || this.isRestoringHistory) return;
        const current = history.state || {};
        if (current.deepvoice && current.screen === screenId && !current.deepvoiceModal) return;
        history.pushState({ deepvoice: true, screen: screenId }, '', window.location.href);
    }

    pushModalHistory(modalId) {
        if (!this.historyEnabled || this.isRestoringHistory) return;
        history.pushState({ deepvoice: true, screen: this.currentScreen, deepvoiceModal: modalId }, '', window.location.href);
    }

    showModal(id, options = {}) {
        document.getElementById(id).style.display = 'flex';
        if (!options.skipHistory && id === 'modal-consent') this.pushModalHistory(id);
    }

    hideModal(id, options = {}) {
        document.getElementById(id).style.display = 'none';
        if (!options.skipHistory && id === 'modal-consent' && history.state?.deepvoiceModal === id) {
            this.ignoreNextPopState = true;
            history.back();
        }
    }

    closeConsentModal() {
        this.hideModal('modal-consent', { skipHistory: true });
        this.currentScreen = 'screen-intro';
        this.updateServiceHeader();
    }

    resetInactivityTimer() {
        if (this.inactivityTimer) clearTimeout(this.inactivityTimer);
        if (this.currentScreen !== 'screen-intro') {
            this.inactivityTimer = setTimeout(() => {
                alert('30분간 활동이 없어 초기 화면으로 이동합니다.');
                this.endExperience();
            }, this.INACTIVITY_LIMIT);
        }
    }

    async cleanupServer() {
        try { await fetch('/api/cleanup', { method: 'POST' }); } catch (e) {}
    }

    async cleanupCurrentSession() {
        const sessionId = this.sessionId;
        if (!sessionId) return;

        this.clearChatBubbleTimers();
        this.setCleanupStatus('체험 데이터를 삭제하는 중입니다...');

        try {
            const res = await fetch(`/api/sessions/${sessionId}`, {
                method: 'DELETE',
                keepalive: true
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            this.setCleanupStatus('삭제 요청이 완료되었습니다.');
        } catch (e) {
            console.warn('[Cleanup] session cleanup failed:', e);
            this.setCleanupStatus('삭제 요청에 실패했습니다. 서버 정리 작업에서 다시 시도합니다.');
        }
    }

    async endExperience() {
        await this.cleanupCurrentSession();
        this.goHome();
    }

    async confirmExperienceExit() {
        const shouldExit = confirm('체험을 종료하고 딥보이스 메인으로 돌아가시겠습니까?');
        if (!shouldExit) return;
        await this.cleanupCurrentSession();
        this.goHome();
    }

    returnToHost() {
        this.sessionId = null;
        this.pendingScenarioEnd = null;
        this.scenarioResultShown = false;
        this.stopRecording();
        this.stopSTT();
        this.stopVoiceMode(true);
        this.llmAbortController?.abort();
        this.ttsClient.stop();
        window.location.assign(this.returnUrl);
    }

    setCleanupStatus(message) {
        const el = document.getElementById('cleanup-status');
        if (el) el.innerText = message || '';
    }

    startLatencyTrace(turnId, text) {
        this.latencyTrace = {
            turnId,
            startedAt: performance.now(),
            marks: {},
            element: null
        };
        this.markLatency('user_send', { textLength: text.length });
    }

    markLatency(label, extra = {}) {
        const trace = this.latencyTrace;
        if (!trace || trace.marks[label] !== undefined) return;
        const elapsed = Math.round(performance.now() - trace.startedAt);
        trace.marks[label] = elapsed;
        console.log(`[Latency][turn=${trace.turnId}] ${label}=${elapsed}ms`, extra);
        this.updateLatencyElement(trace);
    }

    attachLatencyElement(messageEl, turnId) {
        const trace = this.latencyTrace;
        if (!trace || trace.turnId !== turnId || !messageEl) return;
        if (trace.element?.parentElement) trace.element.remove();
        const meta = document.createElement('div');
        meta.className = 'latency-meta';
        messageEl.appendChild(meta);
        trace.element = meta;
        this.updateLatencyElement(trace);
    }

    setMessageTextPreservingLatency(messageEl, text, turnId = this.currentTurnId) {
        if (!messageEl) return;
        const trace = this.latencyTrace;
        const shouldKeepLatency = trace?.turnId === turnId && trace.element?.parentElement === messageEl;
        const meta = shouldKeepLatency ? trace.element : null;
        messageEl.innerText = text;
        if (meta) {
            messageEl.appendChild(meta);
            this.updateLatencyElement(trace);
        }
    }

    updateLatencyElement(trace = this.latencyTrace) {
        if (!trace?.element) return;
        const marks = trace.marks || {};
        const items = [
            ['전송', 'user_send'],
            ['분류', 'classify_done'],
            ['응답 시작', 'response_llm_first_token'],
            ['첫문장', 'first_sentence_ready'],
            ['응답 완료', 'llm_done'],
            ['TTS 요청', 'tts_first_request'],
            ['TTS 응답', 'tts_first_packet'],
            ['재생', 'audio_play_start']
        ];
        trace.element.textContent = items
            .map(([label, key]) => `${label} ${marks[key] ?? '-'}ms`)
            .join(' · ');
    }

    handleServerTrace(serverTrace, turnId = this.currentTurnId) {
        if (!serverTrace?.step || this.latencyTrace?.turnId !== turnId) return;
        const stepMap = {
            CLASSIFY_DONE: 'classify_done',
            RESPONSE_LLM_REQUEST: 'response_llm_request',
            RESPONSE_LLM_FIRST_TOKEN: 'response_llm_first_token',
            RESPONSE_LLM_DONE: 'llm_done'
        };
        const label = stepMap[serverTrace.step];
        if (label && this.latencyTrace.marks[label] === undefined) {
            this.latencyTrace.marks[label] = Number(serverTrace.latency || 0);
            this.updateLatencyElement(this.latencyTrace);
        }
        this.logClientEvent({
            step: `SERVER_${serverTrace.step}`,
            status: 'INFO',
            sessionId: this.sessionId,
            turnId,
            details: serverTrace
        });
    }

    parseScenarioMetadata(content) {
        const separator = '[METADATA]';
        const index = String(content || '').indexOf(separator);
        if (index === -1) return { visibleText: content || '', metadata: null };

        const visibleText = String(content || '').slice(0, index);
        const rawMetadata = String(content || '').slice(index + separator.length).trim();
        try {
            return { visibleText, metadata: JSON.parse(rawMetadata) };
        } catch (error) {
            console.warn('[Metadata] parse failed:', error);
            return { visibleText, metadata: null };
        }
    }

    handleScenarioMetadata(metadata) {
        if (!metadata) return;
        this.logClientEvent({
            step: 'SCENARIO_METADATA',
            status: 'INFO',
            sessionId: this.sessionId,
            turnId: this.currentTurnId,
            details: metadata
        });
        if (metadata.should_end) {
            this.pendingScenarioEnd = metadata;
        }
    }

    getScenarioResultCopy(metadata = {}) {
        const type = metadata.result_type || '';
        if (type.startsWith('SCAM_SUCCESS')) {
            return {
                icon: '⚠️',
                title: '사기 피해 위험 상황입니다',
                body: type === 'SCAM_SUCCESS_PARTIAL'
                    ? '요구액보다 적더라도 송금 의사를 보이면 실제 피해로 이어질 수 있습니다. 사기범은 일부 금액이라도 받아내려 압박을 이어갑니다.'
                    : '송금 수락 또는 계좌 요청처럼 금전 제공 의사를 보였습니다. 실제 상황에서는 즉시 통화를 끊고 가족이나 기관에 직접 확인해야 합니다.'
            };
        }
        return {
            icon: '📞',
            title: '사기범이 대화를 중단했습니다',
            body: '확인, 거부, 무관한 응답, 조롱 또는 의미 없는 입력이 반복되어 사기범이 더 이상 대화를 이어가지 못한 흐름입니다.'
        };
    }

    showScenarioResult(metadata) {
        if (this.scenarioResultShown) return;
        this.scenarioResultShown = true;
        this.stopVoiceMode(true);
        const copy = this.getScenarioResultCopy(metadata);
        document.getElementById('scenario-result-icon').innerText = copy.icon;
        document.getElementById('scenario-result-title').innerText = copy.title;
        document.getElementById('scenario-result-body').innerText = copy.body;
        const cleanup = document.getElementById('scenario-cleanup-status');
        if (cleanup) cleanup.innerText = '';
        this.showModal('modal-scenario-result');
    }

    async finishScenarioResult() {
        const btn = document.getElementById('btn-scenario-result-finish');
        if (btn) btn.disabled = true;
        const cleanup = document.getElementById('scenario-cleanup-status');
        if (cleanup) cleanup.innerText = '체험 데이터를 삭제하는 중입니다...';
        await this.cleanupCurrentSession();
        this.goHome();
    }

    goHome() {
        this.sessionId = null;
        this.pendingScenarioEnd = null;
        this.scenarioResultShown = false;
        this.stopRecording();
        this.stopSTT();
        this.stopVoiceMode(true);
        this.showScreen('screen-intro');
        location.reload();
    }

    // ─── 체험 시작 ───
    async startExperience() {
        this.ttsClient.unlock();
        this.hideModal('modal-consent');
        try {
            const res = await fetch('/api/sessions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ consent: true })
            });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            this.sessionId = data.sessionId;
            this.openingMessage = data.openingMessage;
            this.showScreen('screen-recording');
        } catch (e) {
            alert('세션 생성에 실패했습니다.');
            this.goHome();
        }
    }

    // ─── 웨이브폼 ───
    setupWaveform(containerId, barClass = 'wave-bar') {
        const container = document.getElementById(containerId);
        if (!container) return;
        for (let i = 0; i < (containerId === 'voice-waveform' ? 16 : 20); i++) {
            const bar = document.createElement('div');
            bar.className = barClass;
            container.appendChild(bar);
        }
    }

    startWaveAnimation(containerId) {
        const key = `_wave_${containerId}`;
        this.stopWaveAnimation(containerId);
        const container = document.getElementById(containerId);
        if (container) container.classList.add('is-active');
        this[key] = setInterval(() => {
            const pulse = 0.25 + Math.random() * 0.18;
            this.updateWaveformLevel(containerId, pulse);
        }, 100);
    }

    stopWaveAnimation(containerId) {
        const key = `_wave_${containerId}`;
        if (this[key]) { clearInterval(this[key]); this[key] = null; }
        const container = document.getElementById(containerId);
        if (container) container.classList.remove('is-active');
        this.updateWaveformLevel(containerId, 0);
    }

    async startVoiceInputLevelMeter() {
        try {
            if (!this.voiceInputStream) {
                this.voiceInputStream = await navigator.mediaDevices.getUserMedia({ audio: true });
            }
            const attached = await this.voiceInputMeter.attachStream(this.voiceInputStream);
            if (attached) this.voiceInputMeter.start();
        } catch (error) {
            console.warn('[Voice] mic level meter unavailable:', error.message);
            this.updateWaveformLevel('voice-waveform', 0);
        }
    }

    stopVoiceInputLevelMeter() {
        this.voiceInputMeter.stop();
    }

    releaseVoiceInputLevelMeter() {
        this.voiceInputMeter.close();
        this.voiceInputStream?.getTracks().forEach(track => track.stop());
        this.voiceInputStream = null;
    }

    updateWaveformLevel(containerId, level = 0) {
        const bars = Array.from(document.querySelectorAll(`#${containerId} > div`));
        if (!bars.length) return;
        const container = document.getElementById(containerId);
        if (container && level > 0.02) container.classList.add('is-active');
        const normalized = Math.max(0, Math.min(1, Number(level) || 0));
        const center = (bars.length - 1) / 2;
        bars.forEach((bar, index) => {
            const distance = Math.abs(index - center) / Math.max(1, center);
            const shape = 1 - distance * 0.72;
            const flicker = 0.75 + ((index * 17) % 9) / 30;
            const height = 6 + normalized * shape * flicker * 58;
            bar.style.height = `${Math.max(5, Math.round(height))}px`;
            bar.style.opacity = `${0.35 + normalized * 0.65}`;
        });
    }

    // ─── 클로닝용 녹음 ───
    async toggleRecording() {
        if (this.isRecording) this.stopRecording();
        else await this.startRecording();
    }

    async getMicrophonePermissionState() {
        if (!navigator.permissions?.query) return 'unknown';
        try {
            const status = await navigator.permissions.query({ name: 'microphone' });
            return status.state || 'unknown';
        } catch {
            return 'unknown';
        }
    }

    getMicrophoneFailureMessage(error, permissionState) {
        if (!window.isSecureContext) {
            return '마이크는 HTTPS 또는 localhost에서만 사용할 수 있습니다. 보안 주소로 접속해 주세요.';
        }
        if (!navigator.mediaDevices?.getUserMedia) {
            return '이 브라우저에서는 마이크 녹음을 지원하지 않습니다. Chrome 또는 최신 브라우저를 사용해 주세요.';
        }
        if (permissionState === 'denied') {
            return '마이크 권한이 차단되어 있습니다. 주소창 또는 앱 설정에서 마이크를 허용한 뒤 다시 눌러주세요.';
        }

        const name = error?.name || '';
        if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
            return '사용 가능한 마이크를 찾지 못했습니다. 기기 마이크 연결 상태를 확인해 주세요.';
        }
        if (name === 'NotReadableError' || name === 'TrackStartError') {
            return '마이크를 다른 앱이 사용 중일 수 있습니다. 다른 앱을 닫고 다시 눌러주세요.';
        }
        if (name === 'NotAllowedError' || name === 'SecurityError') {
            return '마이크 권한 요청이 완료되지 않았습니다. 녹음하기를 다시 눌러 권한을 허용해 주세요.';
        }
        return '마이크를 시작하지 못했습니다. 녹음하기를 다시 눌러주세요.';
    }

    async startRecording() {
        const btn = document.getElementById('btn-record-control');
        const status = document.getElementById('recording-status');
        let stream = null;
        try {
            if (btn) {
                btn.disabled = true;
                btn.innerText = '마이크 권한 요청 중...';
                btn.classList.remove('is-recording');
            }
            if (status) status.innerText = '브라우저의 마이크 권한 요청을 허용해 주세요.';

            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.recordedChunks = [];
            const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
            this.mediaRecorder = new MediaRecorder(stream, { mimeType });
            this.mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) this.recordedChunks.push(e.data); };
            this.mediaRecorder.onstop = () => {
                stream.getTracks().forEach(t => t.stop());
                this.recordingMeter.close();
                this.uploadAudio(new Blob(this.recordedChunks, { type: mimeType }));
            };
            this.mediaRecorder.start(100);
            this.isRecording = true;
            const attached = await this.recordingMeter.attachStream(stream);
            if (attached) this.recordingMeter.start();
            if (btn) {
                btn.disabled = false;
                btn.innerText = '⏹ 녹음 완료';
                btn.classList.add('is-recording');
            }
            if (status) status.innerText = '🔴 녹음 중... (완료 버튼을 눌러 마무리하세요)';
        } catch (e) {
            stream?.getTracks().forEach(track => track.stop());
            this.recordingMeter.close();
            this.isRecording = false;
            this.mediaRecorder = null;
            const permissionState = await this.getMicrophonePermissionState();
            if (btn) {
                btn.disabled = false;
                btn.innerText = permissionState === 'denied' ? '마이크 권한 확인' : '🎤 녹음 다시 시도';
                btn.classList.remove('is-recording');
            }
            if (status) status.innerText = `⚠️ ${this.getMicrophoneFailureMessage(e, permissionState)}`;
        }
    }

    stopRecording() {
        if (this.mediaRecorder && this.isRecording) {
            this.mediaRecorder.stop();
            this.isRecording = false;
            this.recordingMeter.stop();
            const btn = document.getElementById('btn-record-control');
            const status = document.getElementById('recording-status');
            if (btn) { btn.innerText = '음성 처리 중...'; btn.classList.remove('is-recording'); }
            if (status) status.innerText = '음성을 처리 중입니다...';
        }
    }

    resetRecordingScreen(message = '다시 녹음해 주세요. 대본을 끝까지 또박또박 읽어주세요.') {
        this.recordingMeter.close();
        this.recordedChunks = [];
        this.mediaRecorder = null;
        this.isRecording = false;
        this.updateWaveformLevel('waveform', 0);

        const btn = document.getElementById('btn-record-control');
        const status = document.getElementById('recording-status');
        const fileInput = document.getElementById('input-file-upload');
        if (btn) {
            btn.disabled = false;
            btn.innerText = '🎤 녹음 시작하기';
            btn.classList.remove('is-recording');
        }
        if (status) status.innerText = message;
        if (fileInput) fileInput.value = '';
    }

    async handleFileUpload(e) {
        const file = e.target.files[0];
        if (file) await this.uploadAudio(file);
    }

    async prepareVoiceCloneAudio(blobOrFile) {
        const name = blobOrFile.name || '';
        if (!name) {
            return await this.encodeRecordingToWav(blobOrFile);
        }

        const ext = name.split('.').pop()?.toLowerCase() || '';
        const supportedTypes = new Set(['audio/mpeg', 'audio/mp3', 'audio/mp4', 'audio/x-m4a', 'audio/wav', 'audio/wave', 'audio/x-wav']);
        const isSupported = ['mp3', 'm4a', 'wav'].includes(ext) || supportedTypes.has((blobOrFile.type || '').toLowerCase());

        if (!isSupported) {
            throw new Error('UNSUPPORTED_VOICE_FILE');
        }
        if (blobOrFile.size > 20 * 1024 * 1024) {
            throw new Error('VOICE_FILE_TOO_LARGE');
        }

        return {
            blob: blobOrFile,
            fileName: name || `voice.${ext || 'wav'}`
        };
    }

    async encodeRecordingToWav(blob) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (!AudioContextClass) {
            throw new Error('AUDIO_CONTEXT_UNSUPPORTED');
        }

        const audioContext = new AudioContextClass();
        try {
            const arrayBuffer = await blob.arrayBuffer();
            const audioBuffer = await audioContext.decodeAudioData(arrayBuffer.slice(0));
            if (audioBuffer.duration < 10) {
                throw new Error('VOICE_SAMPLE_TOO_SHORT');
            }
            if (audioBuffer.duration > 300) {
                throw new Error('VOICE_SAMPLE_TOO_LONG');
            }

            const wavBlob = this.encodeWav(audioBuffer);
            if (wavBlob.size > 20 * 1024 * 1024) {
                throw new Error('VOICE_FILE_TOO_LARGE');
            }

            return {
                blob: wavBlob,
                fileName: 'voice.wav'
            };
        } finally {
            if (audioContext.close) {
                audioContext.close().catch(() => {});
            }
        }
    }

    encodeWav(audioBuffer) {
        const channelCount = audioBuffer.numberOfChannels;
        const sampleRate = audioBuffer.sampleRate;
        const length = audioBuffer.length;
        const samples = new Float32Array(length);

        for (let channel = 0; channel < channelCount; channel++) {
            const data = audioBuffer.getChannelData(channel);
            for (let i = 0; i < length; i++) {
                samples[i] += data[i] / channelCount;
            }
        }

        const bytesPerSample = 2;
        const blockAlign = bytesPerSample;
        const byteRate = sampleRate * blockAlign;
        const dataSize = length * bytesPerSample;
        const buffer = new ArrayBuffer(44 + dataSize);
        const view = new DataView(buffer);

        this.writeAscii(view, 0, 'RIFF');
        view.setUint32(4, 36 + dataSize, true);
        this.writeAscii(view, 8, 'WAVE');
        this.writeAscii(view, 12, 'fmt ');
        view.setUint32(16, 16, true);
        view.setUint16(20, 1, true);
        view.setUint16(22, 1, true);
        view.setUint32(24, sampleRate, true);
        view.setUint32(28, byteRate, true);
        view.setUint16(32, blockAlign, true);
        view.setUint16(34, 16, true);
        this.writeAscii(view, 36, 'data');
        view.setUint32(40, dataSize, true);

        let offset = 44;
        for (let i = 0; i < samples.length; i++, offset += 2) {
            const sample = Math.max(-1, Math.min(1, samples[i]));
            view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
        }

        return new Blob([buffer], { type: 'audio/wav' });
    }

    writeAscii(view, offset, text) {
        for (let i = 0; i < text.length; i++) {
            view.setUint8(offset + i, text.charCodeAt(i));
        }
    }

    // ─── 클로닝 업로드 ───
    async uploadAudio(blobOrFile) {
        this.showScreen('screen-cloning');
        this.startCloningUI();
        try {
            const preparedAudio = await this.prepareVoiceCloneAudio(blobOrFile);
            const formData = new FormData();
            formData.append('audio', preparedAudio.blob, preparedAudio.fileName);
            const res = await fetch(`/api/sessions/${this.sessionId}/audio`, { method: 'POST', body: formData });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const data = await res.json();
            this.completeCloningUI(data?.fallback ? 'fallback' : 'success');
        } catch (e) {
            console.warn('[VoiceClone] audio preparation/upload failed:', e);
            this.showCloningError(e, blobOrFile);
        }
    }

    startCloningUI() {
        const bar = document.getElementById('cloning-progress-bar');
        const text = document.getElementById('cloning-status-text');
        const retry = document.getElementById('cloning-retry-box');
        if (retry) retry.style.display = 'none';
        if (bar) { bar.style.width = '0%'; bar.style.background = 'var(--primary)'; }
        let progress = 0;
        this.cloningInterval = setInterval(() => {
            if (progress < 88) {
                progress = Math.min(progress + Math.random() * 3 + 1, 88);
                if (bar) bar.style.width = progress + '%';
                if (text) text.innerText = `AI가 목소리를 분석 중입니다... (${Math.round(progress)}%)`;
            }
        }, 200);
    }

    completeCloningUI(mode = 'success') {
        if (this.cloningInterval) { clearInterval(this.cloningInterval); this.cloningInterval = null; }
        const bar = document.getElementById('cloning-progress-bar');
        const text = document.getElementById('cloning-status-text');
        if (bar) bar.style.width = '100%';
        if (text) {
            text.innerText = mode === 'fallback'
                ? '복제에 실패해 기본 목소리로 진행합니다.'
                : '목소리 생성 완료! ✅';
            text.style.color = mode === 'fallback' ? 'var(--danger)' : 'var(--primary)';
        }
        setTimeout(() => this.showScreen('screen-incoming-call'), mode === 'fallback' ? 1400 : 800);
    }

    getCloningErrorMessage(error, originalBlob) {
        const code = error?.message || '';
        if (originalBlob?.size === 0) return '녹음된 음성이 없습니다. 다시 녹음해 주세요.';
        if (code.includes('VOICE_SAMPLE_TOO_SHORT')) return '녹음 시간이 너무 짧습니다. 10초 이상 다시 녹음해 주세요.';
        if (code.includes('VOICE_SAMPLE_TOO_LONG')) return '녹음 시간이 너무 깁니다. 10-20초 정도로 다시 녹음해 주세요.';
        if (code.includes('VOICE_FILE_TOO_LARGE')) return '파일 용량이 너무 큽니다. 20MB 이하 파일을 사용하거나 다시 녹음해 주세요.';
        if (code.includes('UNSUPPORTED_VOICE_FILE')) return '지원하지 않는 파일입니다. MP3, M4A, WAV 파일을 선택하거나 다시 녹음해 주세요.';
        return '목소리 생성에 실패했습니다. 다시 녹음하거나 기본 목소리로 진행하세요.';
    }

    showCloningError(error, originalBlob) {
        if (this.cloningInterval) { clearInterval(this.cloningInterval); this.cloningInterval = null; }
        const bar = document.getElementById('cloning-progress-bar');
        const text = document.getElementById('cloning-status-text');
        const retry = document.getElementById('cloning-retry-box');
        const errorMessage = this.getCloningErrorMessage(error, originalBlob);
        if (bar) { bar.style.width = '100%'; bar.style.background = 'var(--danger)'; }
        if (text) {
            text.innerText = `⚠️ ${errorMessage}`;
        }
        const messageEl = document.getElementById('cloning-error-message');
        if (messageEl) {
            messageEl.innerText = errorMessage;
        }
        if (retry) {
            retry.style.display = 'flex';
            document.getElementById('btn-cloning-retry').onclick = () => {
                retry.style.display = 'none';
                this.resetRecordingScreen();
                this.showScreen('screen-recording');
            };
            document.getElementById('btn-cloning-skip').onclick = () => { retry.style.display = 'none'; this.completeCloningUI(); };
        }
    }

    // ─── 전화 수락 ───
    async acceptCall() {
        this.ttsClient.unlock();
        this.showScreen('screen-chat');
        const firstMsg = this.openingMessage || '엄마… 나 민준인데 큰일 났어. 지금 한빛종합병원 응급실이야.';
        this.addMessage('assistant', firstMsg);
        if (this.startVoiceMode(false)) {
            const lastMessageEl = document.getElementById('voice-last-message');
            if (lastMessageEl) lastMessageEl.innerText = firstMsg;
            this._setVoiceState(VS.SPEAKING);
        }
        this.currentTurnId = ++this.nextTurnId;
        this.ttsClient.speak(firstMsg, this.sessionId, this.currentTurnId);
    }

    // ─── 종료 다이얼로그 ───
    async confirmEnd() {
        this.hideModal('modal-end-confirm');
        this.showModal('modal-end-confirm');
        this.setCleanupStatus('체험 데이터를 삭제하는 중입니다...');
        document.getElementById('btn-end-cancel').disabled = true;
        document.getElementById('btn-end-confirm').disabled = true;
        this.stopVoiceMode(true);
        this.llmAbortController?.abort();
        this.ttsClient.stop();
        this.currentTurnId = ++this.nextTurnId;
        await this.cleanupCurrentSession();
        this.goHome();
    }

    // ─── 채팅 ───
    addMessage(role, content) {
        const div = document.createElement('div');
        div.className = `message ${role}`;
        div.innerText = content;
        this.messageArea.appendChild(div);
        this.scrollMessagesToBottom();

        // 음성 모드: 최근 1턴 메시지 업데이트
        if (this.voiceMode) {
            const el = document.getElementById('voice-last-message');
            if (el) el.innerText = content;
        }
        return div;
    }

    async sendMessage() {
        const text = this.chatInput.value.trim();
        if (!text || !this.sessionId) return;

        this.chatInput.value = '';
        this.stopSTT();
        this.ttsClient.stopPlaybackOnly();

        await this.processUserMessage(text);
    }

    async processUserMessage(text) {
        text = (text || '').trim();
        if (!text) return;
        this.isSending = true;
        this.activeRequestCount++;
        this.clearChatBubbleTimers();
        this.pendingScenarioEnd = null;

        this.addMessage('user', text);

        // 새 전송 시 이전 턴은 무효화하고, 화면에 이미 출력된 내용만 유지한다.
        this.currentTurnId = ++this.nextTurnId;
        this.startLatencyTrace(this.currentTurnId, text);

        if (this.voiceMode) this._setVoiceState(VS.PROCESSING);

        const btnSend = document.getElementById('btn-send');
        btnSend.disabled = false;
            const loadingDiv = this.addMessage('assistant', '...');

            // 이 턴의 ID 캡처 (응답 도착 전 새 입력 시 무시용)
            const myTurnId = this.currentTurnId;
            this.attachLatencyElement(loadingDiv, myTurnId);

        this.llmAbortController = new AbortController();

        try {
            const res = await fetch('/v1/chat/completions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                signal: this.llmAbortController.signal,
                body: JSON.stringify({
                    sessionId: this.sessionId,
                    turnId: myTurnId,
                    messages: [{ role: 'user', content: text }],
                    stream: true
                })
            });

            if (!res.ok) throw new Error(`채팅 요청 실패: ${res.status}`);

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let fullContent = '';
            let ttsBuffer = '';
            let buffer = '';
            let firstToken = true;
            let firstSentenceSent = false;
            let intermediateChunkSent = false;
            let firstTtsRequestSent = false;
            const sentTtsTexts = new Set();

            this.ttsClient.startSession(this.sessionId, myTurnId);

            const enqueueTTS = (chunk) => {
                const normalized = chunk?.trim();
                if (!normalized || sentTtsTexts.has(normalized) || myTurnId !== this.currentTurnId) return;
                sentTtsTexts.add(normalized);
                if (!firstTtsRequestSent) this.markLatency('first_sentence_ready', { textLength: normalized.length });
                this.logClientEvent({
                    step: 'APP_TTS_ENQUEUE_ATTEMPT',
                    status: 'INFO',
                    sessionId: this.sessionId,
                    turnId: myTurnId,
                    details: {
                        textLength: normalized.length,
                        preview: normalized.slice(0, 80),
                        sentCount: sentTtsTexts.size
                    }
                });
                if (!firstTtsRequestSent) {
                    firstTtsRequestSent = true;
                    this.markLatency('tts_first_request');
                }
                if (this.voiceMode) this._setVoiceState(VS.SPEAKING);
                this.ttsClient.enqueue(normalized, this.sessionId, myTurnId);
            };

            const updateTTSBuffer = (content) => {
                ttsBuffer += content;
                const { sentences, remainder } = this.splitTtsSentences(ttsBuffer);
                if (sentences.length === 0) return;

                if (!firstSentenceSent) {
                    const firstPart = sentences.shift();
                    enqueueTTS(firstPart);
                    firstSentenceSent = true;
                    ttsBuffer = this.combineTtsBuffer(sentences, remainder);
                    return;
                }

                if (!intermediateChunkSent) {
                    const combined = sentences.join(' ').trim();
                    if (combined.length >= this.TTS_INTERMEDIATE_CHUNK_MIN_LENGTH) {
                        enqueueTTS(combined);
                        intermediateChunkSent = true;
                        ttsBuffer = remainder;
                    } else {
                        ttsBuffer = this.combineTtsBuffer(sentences, remainder);
                    }
                    return;
                }

                ttsBuffer = this.combineTtsBuffer(sentences, remainder);
            };

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                // 새 입력이 들어왔으면 스트림 중단
                if (myTurnId !== this.currentTurnId) {
                    if (!fullContent) loadingDiv.remove();
                    else loadingDiv.innerText = fullContent;
                    return;
                }

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop();

                for (const line of lines) {
                    if (!line.startsWith('data: ')) continue;
                    const dataStr = line.slice(6).trim();
                    if (dataStr === '[DONE]') continue;
                    try {
                        const data = JSON.parse(dataStr);
                        if (data.trace?.step) {
                            this.handleServerTrace(data.trace, myTurnId);
                            continue;
                        }
                        if (data.error) {
                            const streamError = new Error(data.error);
                            streamError.fatal = true;
                            throw streamError;
                        }
                        const content = data.choices?.[0]?.delta?.content;
                        if (content) {
                            const { visibleText, metadata } = this.parseScenarioMetadata(content);
                            if (metadata) this.handleScenarioMetadata(metadata);
                            if (!visibleText) continue;
                            if (firstToken) {
                                this.setMessageTextPreservingLatency(loadingDiv, '', myTurnId);
                                firstToken = false;
                                this.markLatency('response_llm_first_token');
                            }
                            fullContent += visibleText;
                            updateTTSBuffer(visibleText);
                            this.setMessageTextPreservingLatency(loadingDiv, fullContent, myTurnId);
                            this.scrollMessagesToBottom();
                            // 음성 모드: 1턴 표시 업데이트
                            if (this.voiceMode) {
                                const el = document.getElementById('voice-last-message');
                                if (el) el.innerText = fullContent;
                            }
                        }
                    } catch (e) {
                        if (e.fatal) throw e;
                    }
                }
            }

            if (!fullContent) { loadingDiv.remove(); return; }
            this.markLatency('llm_done');

            if (myTurnId === this.currentTurnId) {
                enqueueTTS(ttsBuffer);
                this.ttsClient.finishSession(myTurnId);
                if (!this.voiceMode) {
                    this.applyAssistantBubbleSplit(loadingDiv, fullContent);
                }
            }

        } catch (e) {
            if (e.name === 'AbortError') {
                loadingDiv.remove();
                return;
            }
            this.setMessageTextPreservingLatency(loadingDiv, '죄송합니다. 통화 중 오류가 발생했습니다.');
        } finally {
            this.activeRequestCount = Math.max(0, this.activeRequestCount - 1);
            this.isSending = this.activeRequestCount > 0;
            btnSend.disabled = false;
            if (!this.voiceMode) this.chatInput.focus();
        }
    }

    splitTtsSentences(text) {
        const sentences = [];
        let remaining = text || '';

        while (remaining.length >= this.TTS_SENTENCE_MIN_LENGTH) {
            this.TTS_SENTENCE_END_PATTERN.lastIndex = 0;
            const matches = Array.from(remaining.matchAll(this.TTS_SENTENCE_END_PATTERN));
            const match = matches.find(m => m.index + m[0].length >= this.TTS_SENTENCE_MIN_LENGTH);
            if (!match) break;

            const endIndex = match.index + match[0].length;
            sentences.push(remaining.slice(0, endIndex).trim());
            remaining = remaining.slice(endIndex).trim();
        }

        return { sentences, remainder: remaining };
    }

    combineTtsBuffer(sentences, remainder) {
        return `${sentences.join(' ')}${sentences.length && remainder ? ' ' : ''}${remainder || ''}`.trim();
    }

    applyAssistantBubbleSplit(firstBubble, text) {
        const bubbles = this.splitChatBubbles(text);
        if (bubbles.length <= 1) {
            this.setMessageTextPreservingLatency(firstBubble, text);
            return;
        }

        this.setMessageTextPreservingLatency(firstBubble, bubbles[0]);
        bubbles.slice(1).forEach((bubble, index) => {
            const timer = setTimeout(() => {
                const bubbleEl = this.addMessage('assistant', bubble);
                if (index === bubbles.length - 2) {
                    this.attachLatencyElement(bubbleEl, this.currentTurnId);
                }
            }, this.CHAT_BUBBLE_DELAY_MS * (index + 1));
            this.chatBubbleTimers.push(timer);
        });
    }

    splitChatBubbles(text) {
        const sentences = this.splitChatSentences(text);
        if (sentences.length <= 1 && text.length <= this.CHAT_BUBBLE_MAX_LENGTH) {
            return [text.trim()];
        }

        const bubbles = [];
        let current = '';
        let sentenceCount = 0;

        for (const sentence of sentences) {
            const candidate = current ? `${current} ${sentence}` : sentence;
            const exceedsLength = current && candidate.length > this.CHAT_BUBBLE_MAX_LENGTH;
            const exceedsSentenceCount = current && sentenceCount >= this.CHAT_BUBBLE_MAX_SENTENCES;

            if (exceedsLength || exceedsSentenceCount) {
                bubbles.push(current);
                current = sentence;
                sentenceCount = 1;
            } else {
                current = candidate;
                sentenceCount++;
            }
        }

        if (current) bubbles.push(current);
        return bubbles.length > 0 ? bubbles : [text.trim()];
    }

    splitChatSentences(text) {
        const normalized = (text || '').trim();
        if (!normalized) return [];

        const parts = normalized.match(/[^.!?\n]+[.!?\n]+|[^.!?\n]+$/g) || [normalized];
        return parts.map(part => part.trim()).filter(Boolean);
    }

    clearChatBubbleTimers() {
        this.chatBubbleTimers.forEach(timer => clearTimeout(timer));
        this.chatBubbleTimers = [];
    }

    // ─── TTS 완료 콜백 ───
    _onTTSComplete() {
        if (this.pendingScenarioEnd) {
            const metadata = this.pendingScenarioEnd;
            this.pendingScenarioEnd = null;
            setTimeout(() => this.showScenarioResult(metadata), 300);
            return;
        }
        if (!this.voiceMode) return;
        // 300ms 딜레이 후 STT 재시작 (TTS 꼬리 음성 인식 방지)
        setTimeout(() => {
            if (this.voiceMode && this.voiceState === VS.SPEAKING) {
                this._setVoiceState(VS.LISTENING);
            }
        }, 300);
    }

    // ══════════════════════════════════════════
    // 🎤 음성 대화 모드
    // ══════════════════════════════════════════
    toggleVoiceMode() {
        if (this.voiceMode) this.stopVoiceMode();
        else this.startVoiceMode();
    }

    startVoiceMode(autoListen = true) {
        // iOS는 브라우저 STT 대신 API 업로드 STT를 사용한다.
        if (!this.isIOS && !this.sttSupported) {
            alert('이 브라우저는 음성 입력을 지원하지 않습니다.\nChrome을 사용해 주세요.');
            return false;
        }
        this.voiceMode = true;
        this.sttErrorCount = 0;
        this.voiceSpeechStarted = false;
        this.voiceTranscriptText = '';

        // 입력바 음성대화 버튼 → 종료
        const btn = document.getElementById('btn-voice-mode');
        btn.innerHTML = '<span class="voice-close-icon" aria-hidden="true"></span><span class="sr-only">음성대화 종료</span>';
        btn.title = '음성대화 종료';
        btn.setAttribute('aria-label', '음성대화 종료');
        btn.classList.add('active');

        if (this.chatInput) this.chatInput.placeholder = '텍스트 입력...';
        if (this.messageArea) {
            this.messageArea.style.paddingBottom = this.getChatBottomPadding();
            this.scrollMessagesToBottom();
        }

        // 오버레이 표시
        document.getElementById('voice-mode-overlay').style.display = 'flex';

        // 통화 타이머
        this.callSeconds = 0;
        this._updateCallTimer();
        if (this.callTimer) clearInterval(this.callTimer);
        this.callTimer = setInterval(() => { this.callSeconds++; this._updateCallTimer(); }, 1000);

        // STT 시작
        if (autoListen) this._setVoiceState(VS.LISTENING);
        return true;
    }

    stopVoiceMode(force = false) {
        if (!this.voiceMode && !force) return;
        this.voiceMode = false;

        // 오버레이 숨김
        document.getElementById('voice-mode-overlay').style.display = 'none';

        // 입력바 버튼 복원
        const btn = document.getElementById('btn-voice-mode');
        btn.innerHTML = '<span class="voice-mode-icon" aria-hidden="true"><span></span><span></span><span></span><span></span></span><span class="sr-only">음성대화 시작</span>';
        btn.title = '음성대화';
        btn.setAttribute('aria-label', '음성대화 시작');
        btn.classList.remove('active');

        if (this.chatInput) this.chatInput.placeholder = '메시지 입력...';
        if (this.messageArea) this.messageArea.style.paddingBottom = this.getChatBottomPadding();

        // 타이머 중지
        if (this.callTimer) { clearInterval(this.callTimer); this.callTimer = null; }

        // STT·웨이브폼 중지
        this.stopSTT();
        this.ttsClient.stop();
        this.stopWaveAnimation('voice-waveform');
        this.releaseVoiceInputLevelMeter();
        this.voiceState = VS.IDLE;
    }

    // 껴들어 말하기 (TTS 재생 중 barge-in)
    bargeIn() {
        if (!this.voiceMode) return;
        this.stopSTT();
        this.llmAbortController?.abort();
        this.ttsClient.stop();
        this.currentTurnId = ++this.nextTurnId;
        this._setVoiceState(VS.LISTENING);
    }

    // 상태 머신 전환
    _setVoiceState(state) {
        this.voiceState = state;
        const dotsEl = document.getElementById('voice-status-dots');
        const textEl = document.getElementById('voice-status-text');
        const bargeBtn = document.getElementById('btn-barge-in');
        const interimEl = document.getElementById('voice-interim-text');

        switch (state) {
            case VS.LISTENING:
                if (dotsEl) dotsEl.style.color = '#60a5fa';
                if (textEl) textEl.innerText = '말씀하세요';
                if (bargeBtn) bargeBtn.style.display = 'none';
                if (interimEl) interimEl.innerText = '';
                document.getElementById('voice-waveform')?.classList.add('is-active');
                this.updateWaveformLevel('voice-waveform', 0);
                this.startSTT();
                break;

            case VS.PROCESSING:
                this.stopWaveAnimation('voice-waveform');
                if (dotsEl) dotsEl.style.color = '#fbbf24';
                if (textEl) textEl.innerText = '응답을 기다리는 중...';
                if (bargeBtn) bargeBtn.style.display = 'none';
                break;

            case VS.SPEAKING:
                this.stopSTT();
                document.getElementById('voice-waveform')?.classList.add('is-active');
                this.updateWaveformLevel('voice-waveform', 0);
                if (dotsEl) dotsEl.style.color = '#34d399';
                if (textEl) textEl.innerText = '상대방이 말하는 중';
                if (bargeBtn) bargeBtn.style.display = 'block';
                break;
        }
    }

    _updateCallTimer() {
        const m = Math.floor(this.callSeconds / 60);
        const s = String(this.callSeconds % 60).padStart(2, '0');
        const el = document.getElementById('voice-call-timer');
        if (el) el.innerText = `${m}:${s}`;
    }

    // ══════════════════════════════════════════
    // 🗣️ STT (Hybrid: iOS는 Upload API, 나머지는 Web Speech API)
    // ══════════════════════════════════════════
    initSTT() {
        if (this.isIOS) {
            // STTClient.js 에서 알아서 권한 처리 및 초기화 진행
            return;
        }

        // Web Speech API 초기화 (안드로이드/PC 등)
        if (!this.sttSupported) return;
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        this.speechRecognition = new SR();
        this.speechRecognition.lang = 'ko-KR';
        this.speechRecognition.continuous = true; // 보이스클론처럼 continuous로 변경
        this.speechRecognition.interimResults = true;
        this.sttTimeout = null; // 자동 전송 타이머

        this.speechRecognition.onresult = (e) => {
            let interim = '', final = '';
            for (let i = e.resultIndex; i < e.results.length; i++) {
                const t = e.results[i][0].transcript;
                if (e.results[i].isFinal) final += t;
                else interim += t;
            }
            // 음성 인식 텍스트는 키보드 입력창을 덮어쓰지 않고 오버레이에만 표시한다.
            const recognizedText = (final || interim || '').trim();
            this.voiceTranscriptText = recognizedText;
            const el = document.getElementById('voice-interim-text');
            if (el) el.innerText = recognizedText;

            // 💡 보이스클론-메인과 동일한 로직: 텍스트가 갱신될 때마다 2초 타이머 세팅
            if (this.sttTimeout) clearTimeout(this.sttTimeout);
            
            const currentText = this.voiceTranscriptText.trim();
            if (currentText) this.voiceSpeechStarted = true;
            if (currentText.length >= this.MIN_VOICE_INPUT_LENGTH && this.voiceState === VS.LISTENING) {
                this.sttTimeout = setTimeout(() => {
                    console.log('[STT] 2초 타이머 발동! 자동 전송');
                    if (this.speechRecognition) {
                        try { this.speechRecognition.stop(); } catch(err) {}
                    }
                    this.isListening = false;
                    this.sttErrorCount = 0;
                    this.processVoiceTranscript(currentText); // 2초간 텍스트 변화가 없으면 강제 전송
                }, 2000);
            }
        };

        this.speechRecognition.onend = () => {
            if (this.sttTimeout) clearTimeout(this.sttTimeout);
            
            // 이미 타이머에 의해 isListening이 false로 바뀌었다면 무시
            if (!this.isListening) return;
            
            this.isListening = false;
            const text = this.voiceTranscriptText.trim();
            if (this.voiceSpeechStarted && text.length >= this.MIN_VOICE_INPUT_LENGTH && this.voiceState === VS.LISTENING) {
                // 브라우저가 타이머(2초)보다 먼저 끊어버린 경우 여기서 전송
                this.sttErrorCount = 0;
                this.processVoiceTranscript(text);
            } else if (this.voiceMode && this.voiceState === VS.LISTENING) {
                // 말 없이 종료 → 침묵 카운트 후 재시작
                this.sttErrorCount++;
                if (this.sttErrorCount >= this.STT_MAX_ERRORS) {
                    const el = document.getElementById('voice-status-text');
                    if (el) el.innerText = '말씀이 없어 음성 대화를 종료합니다.';
                    setTimeout(() => this.stopVoiceMode(), 2000);
                } else {
                    const el = document.getElementById('voice-status-text');
                    if (this.sttErrorCount >= 2) {
                        if (el) el.innerText = '음성 입력이 없으면 음성대화를 종료합니다.\n음성을 입력해 주세요';
                    } else if (this.sttErrorCount >= 1) {
                        if (el) el.innerText = '음성을 입력해 주세요';
                    }
                    setTimeout(() => {
                        if (this.voiceMode && this.voiceState === VS.LISTENING) this.startSTT();
                    }, 500);
                }
            }
        };

        this.speechRecognition.onerror = (e) => {
            this.isListening = false;
            if (e.error === 'not-allowed') {
                alert('마이크 접근이 거부되었습니다.');
                this.stopVoiceMode();
            } else if (e.error !== 'aborted') {
                if (this.voiceMode && this.voiceState === VS.LISTENING) {
                    setTimeout(() => {
                        if (this.voiceMode && this.voiceState === VS.LISTENING) this.startSTT();
                    }, 500);
                }
            }
        };
    }

    startSTT() {
        if (this.isListening) return;
        if (this.voiceState === VS.SPEAKING) return;
        
        this.voiceSpeechStarted = false;
        this.voiceTranscriptText = '';
        const interimEl = document.getElementById('voice-interim-text');
        if (interimEl) interimEl.innerText = '';
        
        if (this.isIOS) {
            this.isListening = true;
                // STT 시작 및 콜백 등록 (iOS 전용)
            this.sttClient.start(
                // 1. Text Received
                (text) => {
                    const normalizedText = (text || '').trim();
                    this.isListening = false;
                    if (!normalizedText || normalizedText.length < this.MIN_VOICE_INPUT_LENGTH) {
                        if (this.voiceMode && this.voiceState === VS.LISTENING) {
                            setTimeout(() => {
                                if (this.voiceMode && this.voiceState === VS.LISTENING) this.startSTT();
                            }, 500);
                        }
                        return;
                    }

                    this.voiceTranscriptText = normalizedText;
                    if (interimEl) interimEl.innerText = normalizedText;
                    
                    if (this.voiceState === VS.LISTENING) {
                        this.sttErrorCount = 0;
                        this.processVoiceTranscript(normalizedText); // 자동 전송
                    }
                },
                // 2. Error
                (err) => {
                    this.isListening = false;
                    console.warn('[STT Error]', err);
                    
                    if (this.voiceMode && this.voiceState === VS.LISTENING) {
                        this.sttErrorCount++;
                        if (this.sttErrorCount >= this.STT_MAX_ERRORS) {
                            const el = document.getElementById('voice-status-text');
                            if (el) el.innerText = '음성 인식 오류로 대화를 종료합니다.';
                            setTimeout(() => this.stopVoiceMode(), 2000);
                        } else {
                            setTimeout(() => {
                                if (this.voiceMode && this.voiceState === VS.LISTENING) this.startSTT();
                            }, 1000);
                        }
                    }
                },
                // 3. onSpeechStart
                () => {
                    this.voiceSpeechStarted = true;
                    if (interimEl) interimEl.innerText = '(음성 인식 중...)';
                },
                // 4. onVolume
                (level) => {
                    if (this.voiceMode && this.voiceState === VS.LISTENING) this.updateWaveformLevel('voice-waveform', level);
                }
            );
        } else {
            // 안드로이드/PC: Web Speech API 구동
            if (!this.speechRecognition) return;
            try {
                this.startVoiceInputLevelMeter();
                this.speechRecognition.start();
                this.isListening = true;
            } catch (e) {
                this.stopVoiceInputLevelMeter();
                console.warn('[STT] start failed:', e.message);
            }
        }
    }

    processVoiceTranscript(text) {
        const normalizedText = (text || '').trim();
        if (!normalizedText || normalizedText.length < this.MIN_VOICE_INPUT_LENGTH || !this.sessionId) return;
        this.voiceTranscriptText = '';
        const interimEl = document.getElementById('voice-interim-text');
        if (interimEl) interimEl.innerText = '';
        this.stopSTT();
        this.ttsClient.stopPlaybackOnly();
        this.processUserMessage(normalizedText);
    }

    stopSTT() {
        this.stopVoiceInputLevelMeter();
        if (!this.isListening) return;
        this.isListening = false;
        
        if (this.isIOS) {
            this.sttClient.abort(); // 업로드 없이 녹음 강제 중지
        } else {
            if (this.speechRecognition) {
                try { this.speechRecognition.abort(); } catch (e) {}
            }
        }
    }
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { window.app = new App(); }, { once: true });
} else {
    window.app = new App();
}
