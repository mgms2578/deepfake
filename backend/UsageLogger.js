/**
 * Phishing AI - 통합 흐름 추적 로거 (UsageLogger.js)
 * 
 * 기능:
 * 1. 비동기 로그 기록 (성능 최적화)
 * 2. 요청별 Trace ID를 통한 전체 흐름 추적
 * 3. 단계별 상태 및 소요 시간 기록
 */

const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, 'usage_traces.jsonl');

class UsageLogger {
    constructor() {
        this.logStream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
    }

    /**
     * 로그 엔트리 기록
     * @param {Object} entry - 로그 데이터
     */
    log(entry) {
        setImmediate(() => {
            const logData = {
                timestamp: new Date().toISOString(),
                ...entry
            };
            this.logStream.write(JSON.stringify(logData) + '\n');
        });
    }

    /**
     * 단계별 추적 시작 (Helper)
     */
    createTrace(sessionId, traceId = null) {
        const id = traceId || Math.random().toString(36).substring(2, 15);
        const startTime = Date.now();
        
        return {
            id,
            sessionId,
            startTime,
            recordStep: (step, status, details = {}) => {
                const now = Date.now();
                this.log({
                    traceId: id,
                    sessionId,
                    step,
                    status,
                    latency: now - startTime, // 누적 시간 또는 단계별 시간으로 활용 가능
                    ...details
                });
            }
        };
    }
}

module.exports = new UsageLogger();
