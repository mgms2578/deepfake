/**
 * STTClient.js
 * - MediaRecorder와 Web Audio API를 이용해 침묵 감지(VAD) 기능 제공
 * - 녹음이 완료되면 backend/api-proxy.js의 '/api/stt' 라우터로 업로드
 */

export class STTClient {
    constructor() {
        this.mediaRecorder = null;
        this.audioContext = null;
        this.analyser = null;
        this.microphone = null;
        this.silenceTimer = null;
        
        this.isRecording = false;
        this.audioChunks = [];
        this.onTextReceived = null;
        this.onError = null;
        this.onSpeechStart = null;
        this.onVolume = null;
        
        // VAD 설정값
        this.THRESHOLD = 15; // 침묵 기준 볼륨 (0~255)
        this.SILENCE_DELAY = 2000; // 말을 멈추고 몇 ms 후에 녹음을 종료할지 (통일성 위해 2초로 설정)
    }

    async init() {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            this.stream = stream;
            
            // Web Audio API 설정 (VAD용)
            this.audioContext = new (window.AudioContext || window.webkitAudioContext)();
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 256;
            this.analyser.smoothingTimeConstant = 0.8;
            this.microphone = this.audioContext.createMediaStreamSource(stream);
            this.microphone.connect(this.analyser);

            const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm';
            this.mediaRecorder = new MediaRecorder(stream, { mimeType });

            this.mediaRecorder.ondataavailable = (event) => {
                if (event.data.size > 0) {
                    this.audioChunks.push(event.data);
                }
            };

            this.mediaRecorder.onstop = () => {
                const blob = new Blob(this.audioChunks, { type: mimeType });
                this.audioChunks = [];
                this.uploadAudio(blob);
            };

            return true;
        } catch (e) {
            console.error("마이크 접근 실패:", e);
            return false;
        }
    }

    start(onTextReceivedCallback, onErrorCallback, onSpeechStartCallback, onVolumeCallback = null) {
        if (this.isRecording) return;
        
        this.onTextReceived = onTextReceivedCallback;
        this.onError = onErrorCallback;
        this.onSpeechStart = onSpeechStartCallback;
        this.onVolume = onVolumeCallback;

        if (!this.mediaRecorder) {
            this.init().then(success => {
                if(success) this._startRecording();
                else if(this.onError) this.onError("마이크 권한이 거부되었습니다.");
            });
        } else {
            this._startRecording();
        }
    }

    _startRecording() {
        this.audioChunks = [];
        this.mediaRecorder.start(100); // 100ms마다 chunk 방출
        this.isRecording = true;
        
        if (this.audioContext.state === 'suspended') {
            this.audioContext.resume();
        }

        this._startVAD();
    }

    stop() {
        if (!this.isRecording) return;
        this.isRecording = false;
        if (this.silenceTimer) cancelAnimationFrame(this.silenceTimer);
        this.onVolume?.(0);
        this.mediaRecorder.stop();
    }

    abort() {
        // 녹음만 중지하고 업로드는 하지 않음 (끼어들기 등)
        if (!this.isRecording) return;
        this.isRecording = false;
        if (this.silenceTimer) cancelAnimationFrame(this.silenceTimer);
        // onstop 이벤트에서 업로드하지 않게 콜백 제거
        this.onTextReceived = null;
        this.onVolume?.(0);
        this.mediaRecorder.stop();
    }

    _startVAD() {
        const bufferLength = this.analyser.frequencyBinCount;
        const dataArray = new Uint8Array(bufferLength);
        let silenceStartTime = 0;
        let hasSpoken = false;

        const checkVolume = () => {
            if (!this.isRecording) return;

            this.analyser.getByteFrequencyData(dataArray);
            let sum = 0;
            for (let i = 0; i < bufferLength; i++) {
                sum += dataArray[i];
            }
            const averageVolume = sum / bufferLength;
            if (this.onVolume) this.onVolume(Math.min(1, averageVolume / 80));

            if (averageVolume > this.THRESHOLD) {
                // 말하고 있음
                if (!hasSpoken) {
                    hasSpoken = true;
                    if (this.onSpeechStart) this.onSpeechStart();
                }
                silenceStartTime = 0;
            } else {
                // 침묵 중
                if (hasSpoken) {
                    if (silenceStartTime === 0) {
                        silenceStartTime = Date.now();
                    } else if (Date.now() - silenceStartTime > this.SILENCE_DELAY) {
                        // 일정 시간 이상 침묵 시 자동 종료
                        this.stop();
                        return;
                    }
                }
            }

            this.silenceTimer = requestAnimationFrame(checkVolume);
        };

        checkVolume();
    }

    async uploadAudio(blob) {
        if (!this.onTextReceived) return; // abort()된 경우 무시
        try {
            const formData = new FormData();
            formData.append('audio', blob, 'voice.webm');

            const res = await fetch('/api/stt', {
                method: 'POST',
                body: formData
            });

            if (!res.ok) throw new Error(`STT Server Error ${res.status}`);
            
            const data = await res.json();
            if (data.success && data.text) {
                this.onTextReceived(data.text);
            } else {
                if (this.onError) this.onError(data.error || "STT 인식 결과가 없습니다.");
            }
        } catch (e) {
            console.error("STT Upload Error:", e);
            if (this.onError) this.onError("음성 전송 중 오류가 발생했습니다.");
        }
    }
}
