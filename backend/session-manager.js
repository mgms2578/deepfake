/**
 * Phishing AI - 세션 관리자 (session-manager.js)
 * 
 * 기능:
 * 1. 대화 히스토리 및 피싱 관련 카운트 관리
 * 2. 세션 생성 시간 추적 (자동 정리를 위함)
 */

class SessionManager {
    constructor() {
        this._sessions = new Map();
        this._closedSessions = new Set();
    }

    createSession(sessionId) {
        this._closedSessions.delete(sessionId);
        const session = {
            id: sessionId,
            createdAt: Date.now(), // 🚀 생성 시간 기록
            lastActivity: Date.now(), // 🚀 마지막 활동 시간
            latestTurnId: 0,
            conversation: [],
            control_counts: {
                related_count: 0,
                lower_amount_offer_count: 0,
                scammer_giveup_count: 0,
                defense_success_count: 0,
                stalling_or_mocking_count: 0,
                off_topic_count: 0,
                noise_count: 0,
                turns_since_payment_request: 0
            },
            pressure: {
                level: 0,
                lastPaymentRequestTurn: 0,
                lastPressureVector: null
            },
            target_variables: {
                honorific: "Mom",
                name: "Unknown"
            }
        };
        this._sessions.set(sessionId, session);
        return session;
    }

    getSession(sessionId) {
        const session = this._sessions.get(sessionId);
        if (session) {
            session.lastActivity = Date.now(); // 🚀 활동 시 업데이트
        }
        return session;
    }

    deleteSession(sessionId) {
        this._closedSessions.add(sessionId);
        return this._sessions.delete(sessionId);
    }

    isClosed(sessionId) {
        return this._closedSessions.has(sessionId);
    }

    setLatestTurn(sessionId, turnId) {
        const session = this.getSession(sessionId);
        if (!session) return false;
        const numericTurnId = Number(turnId || 0);
        if (numericTurnId > 0) {
            session.latestTurnId = numericTurnId;
        }
        return true;
    }

    isLatestTurn(sessionId, turnId) {
        const session = this._sessions.get(sessionId);
        if (!session) return false;
        const numericTurnId = Number(turnId || 0);
        return !numericTurnId || session.latestTurnId === numericTurnId;
    }

    /**
     * 만료된 세션 정리 (30분 이상 경과)
     */
    cleanup(maxAgeMs = 30 * 60 * 1000) {
        const now = Date.now();
        let deletedCount = 0;
        
        for (const [id, session] of this._sessions.entries()) {
            if (now - session.lastActivity > maxAgeMs) {
                this._sessions.delete(id);
                deletedCount++;
            }
        }
        return deletedCount;
    }

    getAllSessions() {
        return Array.from(this._sessions.values());
    }
}

module.exports = new SessionManager();
