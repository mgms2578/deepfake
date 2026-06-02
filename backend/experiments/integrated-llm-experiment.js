const http = require('http');
const https = require('https');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const logic = require('../phishing-logic');
const llmSettings = require('../llm-settings');

const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const GEMINI_API_KEY = (process.env.GEMINI_API_KEY || '').trim();
const LOCAL_BASE_URL = process.env.EXPERIMENT_LOCAL_BASE_URL || 'http://localhost:3001';

const TEST_CASES = [
    '그래?',
    '왜 100만 원이 필요한데?',
    '100만 원은 너무 많고 50만 원만 가능해',
    '계좌 줘',
    '영상통화 해봐',
    'ㅋㅋㅋ 계속 해봐',
    '오늘 날씨 어때?',
    '어'
];

function isGeminiModel(model) {
    return String(model || '').startsWith('gemini-');
}

function request(options, body = null) {
    const transport = options.protocol === 'http:' ? http : https;
    return new Promise((resolve, reject) => {
        const req = transport.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 400) {
                    reject(new Error(`HTTP ${res.statusCode}: ${data}`));
                    return;
                }
                resolve(data);
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

function streamRequest(options, body, onText) {
    const transport = options.protocol === 'http:' ? http : https;
    return new Promise((resolve, reject) => {
        const startedAt = performance.now();
        let firstTokenMs = null;
        let firstSentenceMs = null;
        let fullText = '';
        let raw = '';

        const req = transport.request(options, (res) => {
            if (res.statusCode >= 400) {
                let errorBody = '';
                res.on('data', chunk => errorBody += chunk);
                res.on('end', () => reject(new Error(`HTTP ${res.statusCode}: ${errorBody}`)));
                return;
            }
            res.on('data', chunk => {
                const text = chunk.toString('utf8');
                raw += text;
                const extracted = onText(text, raw);
                if (extracted) {
                    if (firstTokenMs === null) firstTokenMs = Math.round(performance.now() - startedAt);
                    fullText += extracted;
                    if (firstSentenceMs === null && hasFirstTtsSentence(fullText)) {
                        firstSentenceMs = Math.round(performance.now() - startedAt);
                    }
                }
            });
            res.on('end', () => resolve({
                firstTokenMs,
                firstSentenceMs,
                doneMs: Math.round(performance.now() - startedAt),
                text: fullText,
                raw
            }));
        });
        req.on('error', reject);
        req.write(body);
        req.end();
    });
}

function hasFirstTtsSentence(text) {
    const visible = String(text || '')
        .split(logic.CONFIG.METADATA_SEPARATOR)[0]
        .replace(/<\/?SAY>/g, '')
        .trim();
    if (visible.length < 10) return false;
    const sentenceEnd = /[.!?\n]/g;
    let match;
    while ((match = sentenceEnd.exec(visible)) !== null) {
        if (match.index + match[0].length >= 10) return true;
    }
    return false;
}

function parseCurrentSseChunk(chunk) {
    return chunk
        .split('\n')
        .filter(line => line.startsWith('data: '))
        .map(line => line.slice(6).trim())
        .filter(data => data && data !== '[DONE]')
        .map(data => {
            try { return JSON.parse(data).choices?.[0]?.delta?.content || ''; }
            catch (_) { return ''; }
        })
        .join('');
}

function parseGeminiSseChunk(chunk) {
    return chunk
        .split('\n')
        .filter(line => line.startsWith('data: '))
        .map(line => line.slice(6).trim())
        .filter(Boolean)
        .map(data => {
            try {
                const parsed = JSON.parse(data);
                return (parsed.candidates?.[0]?.content?.parts || [])
                    .map(part => part.text || '')
                    .join('');
            } catch (_) {
                return '';
            }
        })
        .join('');
}

function parseOpenAiSseChunk(chunk) {
    return chunk
        .split('\n')
        .filter(line => line.startsWith('data: '))
        .map(line => line.slice(6).trim())
        .filter(data => data && data !== '[DONE]')
        .map(data => {
            try { return JSON.parse(data).choices?.[0]?.delta?.content || ''; }
            catch (_) { return ''; }
        })
        .join('');
}

function buildIntegratedPrompt() {
    return `${logic.SYSTEM_PROMPT_OPTIMIZED}

[통합 처리 실험]
사용자 발화에 대해 사기범 역할 응답을 먼저 출력하고, 맨 끝에만 ${logic.CONFIG.METADATA_SEPARATOR} JSON을 붙인다.
JSON은 사용자가 보는 말이 아니므로 ${logic.CONFIG.METADATA_SEPARATOR} 뒤에만 둔다.
출력은 반드시 아래 2개 블록만 사용한다.

<SAY>
사용자에게 보여줄 사기범 역할 응답
</SAY>
${logic.CONFIG.METADATA_SEPARATOR}{"user_class":"RELATED","selected_strategy":"strategy","should_end":false,"classification":{"primary_intent":"SCENARIO_RELATED","subtype":"REPEAT_OR_CLARIFY","payment":{"is_payment_acceptance":false,"is_account_request":false,"offered_amount_krw":null,"is_conditional":false},"is_meaningful":true,"confidence":0.8}}

${logic.CONFIG.METADATA_SEPARATOR} JSON은 절대 생략하지 않는다.

[분류 JSON 필드]
{
  "user_class": "RELATED | REFUSAL_OR_DEFENSE | FULL_ACCEPTANCE | NEAR_AMOUNT_OFFER | LOWER_AMOUNT_OFFER | UNRELATED",
  "selected_strategy": "brief_strategy_name",
  "should_end": false,
  "classification": {
    "primary_intent": "PAYMENT_OFFER | PAYMENT_REFUSAL | VERIFICATION_OR_DEFENSE | VISIT_OR_LOCATION_ACTION | SCENARIO_RELATED | STALLING_OR_MOCKING | OFF_TOPIC | CONFUSED_OR_NOISE | ROLE_EXIT_OR_PROMPT_ATTACK",
    "subtype": "short subtype",
    "payment": {
      "is_payment_acceptance": false,
      "is_account_request": false,
      "offered_amount_krw": null,
      "is_conditional": false
    },
    "is_meaningful": true,
    "confidence": 0.8
  }
}

[중요]
- "그래?", "응?", "뭐?", "왜?", "진짜?"는 CONFUSED_OR_NOISE가 아니라 SCENARIO_RELATED/REPEAT_OR_CLARIFY로 본다.
- "계좌 줘", "보낼게", "입금할게"는 PAYMENT_OFFER이며 should_end=true로 둘 수 있다.
- "어", "음", "...", 의미 없는 1글자 입력만 CONFUSED_OR_NOISE로 본다.
- visible 응답은 1~3문장, 자연스러운 사기범 말투로 한다.
- 메타데이터는 반드시 마지막에 한 번만 붙인다.`;
}

async function runCurrentPipeline(input, index) {
    const url = new URL('/v1/chat/completions', LOCAL_BASE_URL);
    const body = JSON.stringify({
        sessionId: `experiment_current_${Date.now()}_${index}`,
        turnId: index + 1,
        stream: true,
        messages: [{ role: 'user', content: input }]
    });
    return streamRequest({
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(body)
        }
    }, body, parseCurrentSseChunk);
}

async function runIntegratedPipeline(input, model) {
    const isGemini = isGeminiModel(model);
    let url;
    let body;
    const system = buildIntegratedPrompt();

    if (isGemini) {
        url = new URL(`https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse`);
        body = JSON.stringify({
            systemInstruction: { parts: [{ text: system }] },
            contents: [{ role: 'user', parts: [{ text: input }] }]
        });
    } else {
        url = new URL('https://api.openai.com/v1/chat/completions');
        body = JSON.stringify({
            model,
            stream: true,
            messages: [
                { role: 'system', content: system },
                { role: 'user', content: input }
            ]
        });
    }

    const headers = {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body)
    };
    if (isGemini) headers['x-goog-api-key'] = GEMINI_API_KEY;
    else headers.Authorization = `Bearer ${OPENAI_API_KEY}`;

    return streamRequest({
        protocol: url.protocol,
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        headers
    }, body, isGemini ? parseGeminiSseChunk : parseOpenAiSseChunk);
}

function extractMetadata(text) {
    const index = String(text || '').indexOf(logic.CONFIG.METADATA_SEPARATOR);
    if (index === -1) return { visible: text, metadata: null, metadataOk: false };
    const visible = text.slice(0, index).trim();
    const raw = text.slice(index + logic.CONFIG.METADATA_SEPARATOR.length).trim();
    try {
        return { visible: visible.replace(/<\/?SAY>/g, '').trim(), metadata: JSON.parse(raw), metadataOk: true };
    } catch (_) {
        return { visible: visible.replace(/<\/?SAY>/g, '').trim(), metadata: null, metadataOk: false };
    }
}

async function main() {
    const settings = llmSettings.readSettings();
    const model = settings.model;
    const rows = [];

    for (let i = 0; i < TEST_CASES.length; i++) {
        const input = TEST_CASES[i];
        const current = await runCurrentPipeline(input, i);
        const integrated = await runIntegratedPipeline(input, model);
        const currentMeta = extractMetadata(current.text);
        const integratedMeta = extractMetadata(integrated.text);

        rows.push({
            input,
            currentFirstTokenMs: current.firstTokenMs,
            currentFirstSentenceMs: current.firstSentenceMs,
            currentDoneMs: current.doneMs,
            currentClass: currentMeta.metadata?.classification?.primary_intent || null,
            currentUserClass: currentMeta.metadata?.user_class || null,
            integratedFirstTokenMs: integrated.firstTokenMs,
            integratedFirstSentenceMs: integrated.firstSentenceMs,
            integratedDoneMs: integrated.doneMs,
            integratedClass: integratedMeta.metadata?.classification?.primary_intent || null,
            integratedUserClass: integratedMeta.metadata?.user_class || null,
            integratedMetadataOk: integratedMeta.metadataOk,
            currentVisible: currentMeta.visible.slice(0, 100),
            integratedVisible: integratedMeta.visible.slice(0, 100)
        });
    }

    const avg = (values) => Math.round(values.filter(Number.isFinite).reduce((a, b) => a + b, 0) / values.filter(Number.isFinite).length);
    const summary = {
        model,
        count: rows.length,
        currentAvgFirstTokenMs: avg(rows.map(r => r.currentFirstTokenMs)),
        integratedAvgFirstTokenMs: avg(rows.map(r => r.integratedFirstTokenMs)),
        currentAvgFirstSentenceMs: avg(rows.map(r => r.currentFirstSentenceMs)),
        integratedAvgFirstSentenceMs: avg(rows.map(r => r.integratedFirstSentenceMs)),
        currentAvgDoneMs: avg(rows.map(r => r.currentDoneMs)),
        integratedAvgDoneMs: avg(rows.map(r => r.integratedDoneMs)),
        integratedMetadataOkCount: rows.filter(r => r.integratedMetadataOk).length
    };

    console.log(JSON.stringify({ summary, rows }, null, 2));
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
