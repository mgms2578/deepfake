export class AudioReactiveMeter {
    constructor({
        fftSize = 256,
        fps = 30,
        gate = 0.018,
        attack = 0.55,
        release = 0.18,
        onLevel = null
    } = {}) {
        this.fftSize = fftSize;
        this.frameInterval = 1000 / fps;
        this.gate = gate;
        this.attack = attack;
        this.release = release;
        this.onLevel = onLevel;

        this.audioContext = null;
        this.analyser = null;
        this.source = null;
        this.dataArray = null;
        this.rafId = null;
        this.lastFrameAt = 0;
        this.level = 0;
        this.noiseFloor = 0.006;
        this.isRunning = false;
    }

    static getAudioContextClass() {
        return window.AudioContext || window.webkitAudioContext;
    }

    async ensureContext() {
        const AudioContextClass = AudioReactiveMeter.getAudioContextClass();
        if (!AudioContextClass) return false;

        this.audioContext = this.audioContext || new AudioContextClass();
        if (this.audioContext.state === 'suspended') {
            await this.audioContext.resume().catch(() => {});
        }
        return true;
    }

    async attachStream(stream) {
        if (!stream || !(await this.ensureContext())) return false;
        this.detachSource();
        this.prepareAnalyser();
        this.source = this.audioContext.createMediaStreamSource(stream);
        this.source.connect(this.analyser);
        return true;
    }

    async attachMediaElement(audioElement) {
        if (!audioElement || !(await this.ensureContext())) return false;
        this.detachSource();
        this.prepareAnalyser();
        this.source = this.audioContext.createMediaElementSource(audioElement);
        this.source.connect(this.analyser);
        this.analyser.connect(this.audioContext.destination);
        return true;
    }

    prepareAnalyser() {
        this.analyser = this.audioContext.createAnalyser();
        this.analyser.fftSize = this.fftSize;
        this.analyser.smoothingTimeConstant = 0.72;
        this.dataArray = new Uint8Array(this.analyser.fftSize);
    }

    detachSource() {
        if (this.source) {
            try { this.source.disconnect(); } catch (e) {}
            this.source = null;
        }
        if (this.analyser) {
            try { this.analyser.disconnect(); } catch (e) {}
            this.analyser = null;
        }
    }

    start() {
        if (!this.analyser || this.isRunning) return;
        this.isRunning = true;
        this.lastFrameAt = 0;

        const tick = (timestamp) => {
            if (!this.isRunning) return;
            if (!this.lastFrameAt || timestamp - this.lastFrameAt >= this.frameInterval) {
                this.lastFrameAt = timestamp;
                this.onLevel?.(this.readLevel());
            }
            this.rafId = requestAnimationFrame(tick);
        };

        this.rafId = requestAnimationFrame(tick);
    }

    stop({ reset = true } = {}) {
        this.isRunning = false;
        if (this.rafId) {
            cancelAnimationFrame(this.rafId);
            this.rafId = null;
        }
        if (reset) {
            this.level = 0;
            this.onLevel?.(0);
        }
    }

    readLevel() {
        this.analyser.getByteTimeDomainData(this.dataArray);

        let sum = 0;
        for (let i = 0; i < this.dataArray.length; i++) {
            const centered = (this.dataArray[i] - 128) / 128;
            sum += centered * centered;
        }

        const rms = Math.sqrt(sum / this.dataArray.length);
        if (rms < this.noiseFloor + 0.012) {
            this.noiseFloor = this.noiseFloor * 0.95 + rms * 0.05;
        }

        const signal = Math.max(0, rms - this.noiseFloor - this.gate);
        const target = Math.min(1, signal / 0.16);
        const smoothing = target > this.level ? this.attack : this.release;
        this.level = this.level + (target - this.level) * smoothing;

        return this.level < 0.015 ? 0 : this.level;
    }

    close() {
        this.stop();
        this.detachSource();
    }
}
