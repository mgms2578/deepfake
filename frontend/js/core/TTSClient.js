/**
 * Phishing_Chat_Voice - TTS 클라이언트
 * LLM_TTS_TEST의 지연 최적화 구조를 현재 앱에 맞게 적용:
 * - TTS 조각별 독립 AudioStreamPlayer 생성
 * - 합성은 큐 입력 즉시 백그라운드 시작
 * - 재생은 activeSessions 순서대로 직렬화
 */
import { AudioStreamPlayer } from './AudioStreamPlayer.js';
import { AudioReactiveMeter } from './AudioReactiveMeter.js';

export class TTSClient {
    constructor(baseUrl = '') {
        this.baseUrl = baseUrl;
        this.onComplete = null;
        this.onFirstPacket = null;
        this.onPlayStart = null;
        this.onDataComplete = null;
        this.onEvent = null;
        this.onVolume = null;

        this.queue = [];
        this.activeSessions = [];
        this.isProcessing = false;
        this.activeSessionId = null;
        this.activeTurnId = null;
        this.finishRequested = false;
        this.stopped = false;
        this.audioPool = [new Audio()];
        this.poolIndex = 0;
        this.nextChunkId = 0;
        this.outputMeter = new AudioReactiveMeter({
            fps: 30,
            gate: 0.012,
            onLevel: (level) => this.onVolume?.(level)
        });
        this.outputMeterAttached = false;
    }

    _emitEvent(step, status = 'INFO', details = {}) {
        this.onEvent?.({
            step,
            status,
            sessionId: details.sessionId || this.activeSessionId,
            turnId: details.turnId ?? this.activeTurnId,
            details
        });
    }

    _hexToUint8Array(hex) {
        if (!hex || hex.length === 0) return new Uint8Array(0);
        const bytes = new Uint8Array(hex.length / 2);
        for (let i = 0; i < hex.length; i += 2) {
            bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
        }
        return bytes;
    }

    unlock() {
        const silentSrc = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQQAAAAAAA==';
        this.audioPool.forEach((audio) => {
            audio.src = silentSrc;
            audio.play()
                .then(() => {
                    audio.pause();
                    audio.currentTime = 0;
                })
                .catch(() => {});
        });
    }

    _getNextAudioFromPool() {
        const audio = this.audioPool[this.poolIndex];
        this.poolIndex = (this.poolIndex + 1) % this.audioPool.length;
        return audio;
    }

    async _setupOutputMeter(audio) {
        if (this.outputMeterAttached || !audio) return;
        try {
            this.outputMeterAttached = await this.outputMeter.attachMediaElement(audio);
        } catch (error) {
            console.warn('[TTS] output analyser unavailable:', error.message);
        }
    }

    _startOutputVolumeMeter() {
        if (!this.onVolume) return;
        this.outputMeter.start();
    }

    _stopOutputVolumeMeter() {
        this.outputMeter.stop();
    }

    startSession(sessionId, turnId) {
        this.stop();
        this.activeSessionId = sessionId;
        this.activeTurnId = turnId;
        this.finishRequested = false;
        this.stopped = false;
        this.nextChunkId = 0;
        this._emitEvent('TTS_SESSION_START', 'START', { sessionId, turnId });
    }

    enqueue(text, sessionId = this.activeSessionId, turnId = this.activeTurnId) {
        const normalized = text?.trim();
        if (!normalized) return;

        if (this.activeSessionId !== sessionId || this.activeTurnId !== turnId) {
            this.startSession(sessionId, turnId);
        }

        const chunkId = ++this.nextChunkId;
        this.queue.push({
            chunkId,
            text: normalized,
            sessionId,
            turnId
        });

        this._emitEvent('TTS_ENQUEUE', 'SUCCESS', {
            sessionId,
            turnId,
            chunkId,
            textLength: normalized.length,
            preview: normalized.slice(0, 80),
            queueLength: this.queue.length
        });

        this._processNextInQueue();
    }

    finishSession(turnId = this.activeTurnId) {
        if (turnId !== this.activeTurnId) return;
        this.finishRequested = true;
        this._emitEvent('TTS_FINISH_REQUESTED', 'INFO', { turnId, queueLength: this.queue.length, activeSessions: this.activeSessions.length });
        this._notifyCompleteIfIdle();
    }

    async speak(text, sessionId, turnId) {
        this.startSession(sessionId, turnId);
        this.enqueue(text, sessionId, turnId);
        this.finishSession(turnId);
    }

    async _processNextInQueue() {
        if (this.isProcessing || this.queue.length === 0 || this.stopped) return;

        this.isProcessing = true;
        const config = this.queue.shift();
        this._emitEvent('TTS_REQUEST_START', 'START', {
            sessionId: config.sessionId,
            turnId: config.turnId,
            chunkId: config.chunkId,
            textLength: config.text.length,
            queueLength: this.queue.length
        });

        try {
            const player = new AudioStreamPlayer({
                autoStart: false,
                audioElement: this._getNextAudioFromPool(),
                onFirstPacket: (data) => {
                    this._emitEvent('TTS_FIRST_PACKET', 'SUCCESS', { ...config, latencySec: data?.latency });
                    this.onFirstPacket?.(data);
                },
                onPlayStart: (data) => {
                    this._emitEvent('TTS_PLAY_START', 'SUCCESS', { ...config, playStartSec: data?.playStartTime });
                    this.onPlayStart?.(data);
                },
                onComplete: () => this._handleSessionComplete(player)
            });
            player.currentTurnId = config.turnId;
            await player.init();
            await this._setupOutputMeter(player.audio);

            const abortController = new AbortController();
            const session = {
                player,
                abortController,
                text: config.text,
                turnId: config.turnId,
                sessionId: config.sessionId
            };
            this.activeSessions.push(session);

            this._streamTextToPlayer(config, player, abortController)
                .then(() => {
                    if (this.stopped || this.activeTurnId !== config.turnId) return;
                    this.onDataComplete?.();
                    this._emitEvent('TTS_REQUEST_DONE', 'SUCCESS', {
                        ...config,
                        bytes: player.totalBytesReceived
                    });
                    if (player.totalBytesReceived > 0) {
                        player.finish(config.turnId);
                    } else {
                        this._handleSessionComplete(player);
                    }
                })
                .catch(error => {
                    if (error.name !== 'AbortError') {
                        console.error('[TTS] 백그라운드 합성 오류:', error);
                    }
                    this._emitEvent('TTS_REQUEST_ERROR', error.name === 'AbortError' ? 'ABORT' : 'ERROR', {
                        ...config,
                        error: error.message
                    });
                    this._handleSessionComplete(player);
                });

            this._playCurrentSession();
        } catch (error) {
            console.error('[TTS] 세션 생성 오류:', error);
            this._emitEvent('TTS_REQUEST_ERROR', 'ERROR', {
                ...config,
                error: error.message
            });
            this.isProcessing = false;
            this._processNextInQueue();
        }
    }

    async _streamTextToPlayer(config, player, abortController) {
        let sseBuffer = '';
        const url = `${this.baseUrl}/api/tts/stream?text=${encodeURIComponent(config.text)}&session_id=${config.sessionId}`;
        const response = await fetch(url, { signal: abortController.signal });

        if (!response.ok) throw new Error(`TTS HTTP ${response.status}`);
        this._emitEvent('TTS_HTTP_OPEN', 'SUCCESS', {
            ...config,
            httpStatus: response.status
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder();

        while (true) {
            const { done, value } = await reader.read();

            if (this.stopped) {
                await reader.cancel();
                return;
            }

            if (done) break;

            sseBuffer += decoder.decode(value, { stream: true });
            const lines = sseBuffer.split('\n');
            sseBuffer = lines.pop() || '';

            if (player.currentTurnId === config.turnId && this.activeTurnId === config.turnId) {
                for (const line of lines) {
                    this._handleSseLine(line, player, config.turnId);
                }
            }
        }

        if (sseBuffer.trim() && player.currentTurnId === config.turnId && this.activeTurnId === config.turnId) {
            this._handleSseLine(sseBuffer, player, config.turnId);
        }
    }

    _handleSseLine(line, player, turnId) {
        const trimmed = line.trim();
        if (!trimmed) return;

        const jsonStr = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
        if (jsonStr === '[DONE]') return;

        try {
            const msg = JSON.parse(jsonStr);
            if (msg.base_resp && msg.base_resp.status_code !== 0) {
                console.error('[TTS] MiniMax 오류:', msg.base_resp);
                return;
            }
            if (msg.data?.audio && !msg.is_final) {
                player.appendChunk(this._hexToUint8Array(msg.data.audio), turnId);
            }
        } catch (e) {
            // JSON 파싱 오류 무시
        }
    }

    _playCurrentSession() {
        const session = this.activeSessions[0];
        if (!session || session.turnId !== this.activeTurnId) return;
        this._startOutputVolumeMeter();
        session.player.play();
    }

    _handleSessionComplete(finishedPlayer) {
        const index = this.activeSessions.findIndex(session => session.player === finishedPlayer);
        if (index !== -1) {
            const [session] = this.activeSessions.splice(index, 1);
            this._emitEvent('TTS_CHUNK_COMPLETE', 'SUCCESS', {
                sessionId: session.sessionId,
                turnId: session.turnId,
                chunkId: session.chunkId,
                textLength: session.text.length,
                remainingQueue: this.queue.length,
                remainingActive: this.activeSessions.length
            });
            this._stopOutputVolumeMeter();
            session.player.stop();
        }

        this.isProcessing = false;

        if (this.queue.length > 0 && !this.stopped) {
            this._processNextInQueue();
        } else {
            this._notifyCompleteIfIdle();
        }
    }

    _notifyCompleteIfIdle() {
        if (this.finishRequested && this.queue.length === 0 && this.activeSessions.length === 0 && !this.isProcessing) {
            this._emitEvent('TTS_SESSION_COMPLETE', 'SUCCESS', { turnId: this.activeTurnId });
            this.onComplete?.();
        }
    }

    stop() {
        this._emitEvent('TTS_STOP', 'INFO', { queueLength: this.queue.length, activeSessions: this.activeSessions.length });
        this.stopped = true;
        this.queue = [];
        this.isProcessing = false;
        this.finishRequested = false;

        this.activeSessions.forEach(session => {
            session.abortController?.abort();
            session.player?.stop();
        });
        this._stopOutputVolumeMeter();
        this.activeSessions = [];
        this.activeSessionId = null;
        this.activeTurnId = null;
    }

    stopPlaybackOnly() {
        this._emitEvent('TTS_STOP_PLAYBACK_ONLY', 'INFO', { queueLength: this.queue.length, activeSessions: this.activeSessions.length });
        this.queue = [];
        this.finishRequested = false;

        this.activeSessions.forEach(session => {
            session.player.currentTurnId = -1;
            session.player.stop();
        });
        this.activeSessions = [];
        this._stopOutputVolumeMeter();
    }
}
