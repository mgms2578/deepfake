/**
 * Phishing_Chat_Voice - 오디오 스트리밍 재생기
 * LLM_TTS_TEST/minimax-tts.js의 AudioStreamPlayer 패턴 적용
 * - MediaSource API 기반 저지연 스트리밍
 * - appendChunk() / finish() / stop() 인터페이스
 * - Barge-in 지원: currentTurnId로 턴 검증
 */
export class AudioStreamPlayer {
    constructor(options = {}) {
        this.options = options;
        this.audio = options.audioElement || new Audio();
        this.mediaSource = null;
        this.sourceBuffer = null;
        this.appendQueue = [];
        this.isAppending = false;
        this.currentTurnId = 0;
        this.startedPlaying = false;
        this.manualPlayRequested = false;
        this.autoStart = options.autoStart !== false;
        this.isFinished = false;
        this.isCompleted = false;
        this.totalBytesReceived = 0;
        this.bufferGoalMs = options.initialBufferMs || 150; // 초기 버퍼 목표 (ms)
        this.startTime = 0;
        this.completionWatchdog = null;

        // 콜백 (TTSClient에서 등록)
        this.onComplete = options.onComplete || null;
        this.onFirstPacket = options.onFirstPacket || null;
        this.onPlayStart = options.onPlayStart || null;

        // iOS 등 MediaSource 미지원 감지
        this.useFallback = !!(window.MediaSource === undefined || /iPad|iPhone|iPod/.test(navigator.userAgent));
        this.fallbackChunks = [];
    }

    async init() {
        if (this.useFallback) {
            console.warn('[Audio] MediaSource 미지원 - Blob 폴백 모드');
            return;
        }

        // 이전 ObjectURL 정리
        if (this.audio.src && this.audio.src.startsWith('blob:')) {
            try { URL.revokeObjectURL(this.audio.src); } catch (e) {}
        }

        this.mediaSource = new MediaSource();
        this.audio.src = URL.createObjectURL(this.mediaSource);
        this.startedPlaying = false;
        this.manualPlayRequested = false;
        this.isFinished = false;
        this.isCompleted = false;
        this.totalBytesReceived = 0;
        this.appendQueue = [];
        this.isAppending = false;
        this.startTime = performance.now();
        if (this.completionWatchdog) {
            clearInterval(this.completionWatchdog);
            this.completionWatchdog = null;
        }

        return new Promise((resolve, reject) => {
            const onOpen = () => {
                this.mediaSource.removeEventListener('sourceopen', onOpen);
                try {
                    this.sourceBuffer = this.mediaSource.addSourceBuffer('audio/mpeg');
                    this.sourceBuffer.addEventListener('updateend', () => {
                        this.isAppending = false;
                        this._pumpQueue();
                        this._maybePlay();
                    });

                    this.audio.onended = () => {
                        console.log('[Audio] 재생 완료');
                        this._completeOnce();
                    };
                    resolve();
                } catch (e) {
                    console.warn('[Audio] SourceBuffer 생성 실패 - 폴백 전환:', e);
                    this.useFallback = true;
                    resolve();
                }
            };

            if (this.mediaSource.readyState === 'open') {
                onOpen();
            } else {
                this.mediaSource.addEventListener('sourceopen', onOpen);
                setTimeout(() => {
                    if (this.mediaSource.readyState !== 'open') {
                        this.useFallback = true;
                        resolve();
                    }
                }, 3000);
            }
        });
    }

    /**
     * 오디오 청크 추가 (TTSClient에서 호출)
     * @param {Uint8Array} chunk
     * @param {number} turnId
     */
    appendChunk(chunk, turnId) {
        if (!chunk || chunk.length === 0) return;
        if (turnId !== this.currentTurnId) return; // Barge-in 검증

        if (this.useFallback) {
            this.fallbackChunks.push(chunk);
            return;
        }

        // LLM_TTS_TEST: 첫 청크 수신 시 adaptive bufferGoal 설정
        if (this.totalBytesReceived === 0) {
            const latency = (performance.now() - this.startTime) / 1000;
            const adaptive = Math.round(latency * 150);
            this.bufferGoalMs = Math.max(150, Math.min(600, adaptive));
            this.onFirstPacket?.({ latency });
            console.log(`[Audio] 첫 청크 수신 (latency=${latency.toFixed(2)}s, bufferGoal=${this.bufferGoalMs}ms)`);
        }

        this.totalBytesReceived += chunk.length;
        this.appendQueue.push(chunk);
        this._pumpQueue();
        this._maybePlay();
    }

    /**
     * 스트림 완료 알림 (TTSClient에서 호출)
     * @param {number} turnId
     */
    finish(turnId) {
        if (turnId !== this.currentTurnId) return;

        if (this.useFallback) {
            this.isFinished = true;
            if (this.autoStart || this.manualPlayRequested) {
                this._playFallback(turnId);
            }
            return;
        }

        this.isFinished = true;
        this._pumpQueue();

        // 큐가 비워질 때까지 대기 후 endOfStream
        const check = setInterval(() => {
            if (!this.sourceBuffer?.updating && this.appendQueue.length === 0) {
                clearInterval(check);
                try {
                    if (this.mediaSource?.readyState === 'open') {
                        this.mediaSource.endOfStream();
                        setTimeout(() => {
                            if (this.audio.ended || (Number.isFinite(this.audio.duration) && this.audio.currentTime >= this.audio.duration - 0.05)) {
                                this._completeOnce();
                            }
                        }, 80);
                        this._startCompletionWatchdog();
                    }
                } catch (e) {}
            }
        }, 50);
    }

    _startCompletionWatchdog() {
        if (this.completionWatchdog) clearInterval(this.completionWatchdog);
        let lastTime = this.audio.currentTime || 0;
        let stagnantMs = 0;

        this.completionWatchdog = setInterval(() => {
            if (this.isCompleted) {
                clearInterval(this.completionWatchdog);
                this.completionWatchdog = null;
                return;
            }

            const current = this.audio.currentTime || 0;
            const duration = this.audio.duration;
            const durationKnown = Number.isFinite(duration) && duration > 0;

            if (this.audio.ended || (durationKnown && current >= duration - 0.08)) {
                clearInterval(this.completionWatchdog);
                this.completionWatchdog = null;
                this._completeOnce();
                return;
            }

            if (!this.startedPlaying) return;

            if (Math.abs(current - lastTime) < 0.01) {
                stagnantMs += 250;
            } else {
                stagnantMs = 0;
                lastTime = current;
            }

            if (this.isFinished && this.mediaSource?.readyState === 'ended' && stagnantMs >= 1500) {
                console.warn('[Audio] completion watchdog forced completion');
                clearInterval(this.completionWatchdog);
                this.completionWatchdog = null;
                this._completeOnce();
            }
        }, 250);
    }

    _pumpQueue() {
        if (this.isAppending || this.appendQueue.length === 0 || !this.sourceBuffer || this.sourceBuffer.updating) {
            return;
        }

        // LLM_TTS_TEST: 큐의 모든 청크를 합쳐서 한 번에 주입 (병목 방지)
        const totalLen = this.appendQueue.reduce((acc, c) => acc + c.length, 0);
        const merged = new Uint8Array(totalLen);
        let offset = 0;
        while (this.appendQueue.length > 0) {
            const c = this.appendQueue.shift();
            merged.set(c, offset);
            offset += c.length;
        }

        try {
            this.isAppending = true;
            this.sourceBuffer.appendBuffer(merged);
        } catch (e) {
            console.error('[Audio] appendBuffer 오류:', e);
            this.isAppending = false;
        }
    }

    _maybePlay() {
        if (this.startedPlaying || !this.sourceBuffer) return;
        const b = this.sourceBuffer.buffered;
        if (!b.length) return;

        const msAhead = (b.end(b.length - 1) - this.audio.currentTime) * 1000;
        if (msAhead >= this.bufferGoalMs || (this.isFinished && msAhead > 0)) {
            if (!this.autoStart && !this.manualPlayRequested) {
                return;
            }
            this.startedPlaying = true;
            this.onPlayStart?.({
                playStartTime: (performance.now() - this.startTime) / 1000
            });
            console.log(`[Audio] 재생 시작 (버퍼=${msAhead.toFixed(0)}ms, 목표=${this.bufferGoalMs}ms)`);
            this.audio.play().catch(e => {
                console.warn('[Audio] 재생 차단:', e);
                this.startedPlaying = false;
                this._completeOnce();
            });
        }
    }

    play() {
        this.manualPlayRequested = true;
        if (this.useFallback && this.isFinished) {
            this._playFallback(this.currentTurnId);
            return;
        }
        this._maybePlay();
    }

    _playFallback(turnId) {
        if (this.fallbackChunks.length === 0) return;
        const blob = new Blob(this.fallbackChunks, { type: 'audio/mpeg' });
        const url = URL.createObjectURL(blob);
        this.audio.src = url;
        this.audio.onended = () => this._completeOnce();
        this.audio.play().catch(e => {
            console.warn('[Audio] Fallback 재생 차단:', e);
            this._completeOnce();
        });
        this.fallbackChunks = [];
    }

    _completeOnce() {
        if (this.isCompleted) return;
        this.isCompleted = true;
        if (this.completionWatchdog) {
            clearInterval(this.completionWatchdog);
            this.completionWatchdog = null;
        }
        this.onComplete?.();
    }

    /**
     * 재생 중단 및 새 턴 시작 (Barge-in 지원)
     * @param {number|null} newTurnId
     */
    stop(newTurnId = null) {
        console.log('[Audio] 중단...');
        this.audio.pause();
        this.audio.currentTime = 0;
        this.appendQueue = [];
        this.fallbackChunks = [];
        this.isAppending = false;
        this.startedPlaying = false;
        this.manualPlayRequested = false;
        this.isFinished = false;
        this.isCompleted = true;
        this.totalBytesReceived = 0;

        if (newTurnId !== null) {
            this.currentTurnId = newTurnId;
        }

        if (this.completionWatchdog) {
            clearInterval(this.completionWatchdog);
            this.completionWatchdog = null;
        }

        // MediaSource 버퍼 초기화
        if (!this.useFallback && this.sourceBuffer && !this.sourceBuffer.updating
            && this.mediaSource && this.mediaSource.readyState === 'open') {
            try {
                this.sourceBuffer.abort();
                if (this.sourceBuffer.buffered.length > 0) {
                    this.sourceBuffer.remove(0, this.audio.duration || 1e6);
                }
            } catch (e) {}
        }
    }
}
