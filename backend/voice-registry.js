const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = process.env.VOICE_REGISTRY_DB || path.join(DATA_DIR, 'voice_clones.sqlite');

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS voice_clones (
    voice_id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    deleted_at TEXT,
    status TEXT NOT NULL CHECK(status IN ('active', 'delete_pending', 'deleted', 'delete_failed')),
    delete_attempts INTEGER NOT NULL DEFAULT 0,
    last_delete_attempt_at TEXT,
    last_error TEXT
);

CREATE INDEX IF NOT EXISTS idx_voice_clones_session_id ON voice_clones(session_id);
CREATE INDEX IF NOT EXISTS idx_voice_clones_status_created_at ON voice_clones(status, created_at);
`);

function nowIso() {
    return new Date().toISOString();
}

function registerVoice(voiceId, sessionId) {
    const now = nowIso();
    db.prepare(`
        INSERT INTO voice_clones (
            voice_id, session_id, created_at, updated_at, status
        ) VALUES (?, ?, ?, ?, 'active')
        ON CONFLICT(voice_id) DO UPDATE SET
            session_id = excluded.session_id,
            updated_at = excluded.updated_at,
            status = CASE
                WHEN voice_clones.status = 'deleted' THEN 'deleted'
                ELSE 'active'
            END
    `).run(voiceId, sessionId, now, now);
}

function getActiveVoicesBySession(sessionId) {
    return db.prepare(`
        SELECT voice_id AS voiceId, session_id AS sessionId, created_at AS createdAt, status
        FROM voice_clones
        WHERE session_id = ?
          AND status IN ('active', 'delete_pending', 'delete_failed')
        ORDER BY created_at DESC
    `).all(sessionId);
}

function getCleanupCandidates(maxAgeMs, maxAttempts = 10) {
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    return db.prepare(`
        SELECT
            voice_id AS voiceId,
            session_id AS sessionId,
            created_at AS createdAt,
            status,
            delete_attempts AS deleteAttempts
        FROM voice_clones
        WHERE status = 'delete_pending'
           OR (status = 'active' AND created_at < ?)
           OR (status = 'delete_failed' AND delete_attempts < ?)
        ORDER BY created_at ASC
    `).all(cutoff, maxAttempts);
}

function markDeleteSuccess(voiceId) {
    const now = nowIso();
    db.prepare(`
        UPDATE voice_clones
        SET status = 'deleted',
            deleted_at = ?,
            updated_at = ?,
            last_error = NULL
        WHERE voice_id = ?
    `).run(now, now, voiceId);
}

function markDeleteFailure(voiceId, error, maxAttempts = 10) {
    const now = nowIso();
    const row = db.prepare(`
        SELECT delete_attempts AS deleteAttempts
        FROM voice_clones
        WHERE voice_id = ?
    `).get(voiceId);

    const attempts = (row?.deleteAttempts || 0) + 1;
    const status = attempts >= maxAttempts ? 'delete_failed' : 'delete_pending';

    db.prepare(`
        UPDATE voice_clones
        SET status = ?,
            delete_attempts = ?,
            last_delete_attempt_at = ?,
            updated_at = ?,
            last_error = ?
        WHERE voice_id = ?
    `).run(status, attempts, now, now, String(error || 'Unknown delete error').slice(0, 1000), voiceId);
}

function getStats() {
    const rows = db.prepare(`
        SELECT status, COUNT(*) AS count
        FROM voice_clones
        GROUP BY status
    `).all();

    return rows.reduce((acc, row) => {
        acc[row.status] = row.count;
        return acc;
    }, {});
}

module.exports = {
    DB_PATH,
    registerVoice,
    getActiveVoicesBySession,
    getCleanupCandidates,
    markDeleteSuccess,
    markDeleteFailure,
    getStats
};
