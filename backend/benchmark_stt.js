require('dotenv').config();
const fs = require('fs');
const path = require('path');
const https = require('https');
const FormData = require('form-data');
const { performance } = require('perf_hooks');

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_API_KEY) {
    console.error("❌ OPENAI_API_KEY가 .env 파일에 없습니다.");
    process.exit(1);
}

// 프로젝트 루트에 있는 B02.mp3 사용
const AUDIO_FILE_PATH = path.join(__dirname, '../B02.mp3');

async function testWhisper() {
    console.log("\n▶️ [Test 1] whisper-1 모델 테스트 시작...");
    const startTime = performance.now();
    
    const form = new FormData();
    form.append('file', fs.createReadStream(AUDIO_FILE_PATH));
    form.append('model', 'whisper-1');
    form.append('language', 'ko');

    return new Promise((resolve) => {
        const req = https.request('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                ...form.getHeaders()
            }
        }, (res) => {
            let body = '';
            res.on('data', d => body += d);
            res.on('end', () => {
                const endTime = performance.now();
                const latency = (endTime - startTime).toFixed(2);
                try {
                    const data = JSON.parse(body);
                    if (data.error) {
                        console.error("❌ [whisper-1] Error:", data.error.message);
                    } else {
                        console.log(`✅ [whisper-1] 인식 결과: "${data.text}"`);
                        console.log(`⏱️ [whisper-1] 소요 시간: ${latency} ms`);
                    }
                    resolve();
                } catch(e) {
                    console.error("Parse Error:", body);
                    resolve();
                }
            });
        });
        req.on('error', console.error);
        form.pipe(req);
    });
}

async function testGpt4oMini() {
    console.log("\n▶️ [Test 2] gpt-4o-mini-transcribe 모델 테스트 시작...");
    const startTime = performance.now();
    
    const form = new FormData();
    form.append('file', fs.createReadStream(AUDIO_FILE_PATH));
    form.append('model', 'gpt-4o-mini-transcribe'); // 사용자가 찾아준 STT 전용 모델
    form.append('language', 'ko');

    return new Promise((resolve) => {
        const req = https.request('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${OPENAI_API_KEY}`,
                ...form.getHeaders()
            }
        }, (res) => {
            let body = '';
            res.on('data', d => body += d);
            res.on('end', () => {
                const endTime = performance.now();
                const latency = (endTime - startTime).toFixed(2);
                try {
                    const data = JSON.parse(body);
                    if (data.error) {
                        console.error("❌ [gpt-4o-mini-transcribe] Error:", data.error.message);
                    } else {
                        console.log(`✅ [gpt-4o-mini-transcribe] 인식 결과: "${data.text}"`);
                        console.log(`⏱️ [gpt-4o-mini-transcribe] 소요 시간: ${latency} ms`);
                    }
                    resolve();
                } catch(e) {
                    console.error("Parse Error:", body);
                    resolve();
                }
            });
        });
        req.on('error', console.error);
        form.pipe(req);
    });
}

async function runBenchmark() {
    console.log("🚀 STT 성능 벤치마크 시작\n=======================================");
    if (!fs.existsSync(AUDIO_FILE_PATH)) {
        console.error(`❌ 테스트용 오디오 파일을 찾을 수 없습니다: ${AUDIO_FILE_PATH}`);
        console.error(`프로젝트 최상단 루트에 테스트할 B02.mp3 파일이 있는지 확인해 주세요.`);
        process.exit(1);
    }
    
    await testWhisper();
    await testGpt4oMini();
    console.log("\n=======================================\n🚀 벤치마크 종료");
}

runBenchmark();
