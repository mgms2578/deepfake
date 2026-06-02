const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const SQLITE_DB_PATH = process.env.VOICE_REGISTRY_DB || path.join(DATA_DIR, 'voice_clones.sqlite');
const DATABASE_URL = (process.env.DATABASE_URL || '').trim();

let mode = DATABASE_URL ? 'postgres' : 'sqlite';
let readyPromise = null;
let pool = null;
let sqliteDb = null;

function nowIso() {
    return new Date().toISOString();
}

function getPostgresSslConfig() {
    const sslMode = (process.env.PGSSLMODE || '').toLowerCase();
    if (sslMode === 'disable') return false;
    if (sslMode === 'require' || DATABASE_URL.includes('sslmode=require')) {
        return { rejectUnauthorized: false };
    }
    return false;
}

async function initPostgres() {
    const { Pool } = require('pg');
    pool = new Pool({
        connectionString: DATABASE_URL,
        ssl: getPostgresSslConfig()
    });

    await pool.query(`
        CREATE TABLE IF NOT EXISTS voice_clones (
            voice_id TEXT PRIMARY KEY,
            session_id TEXT NOT NULL,
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL,
            deleted_at TIMESTAMPTZ,
            status TEXT NOT NULL CHECK(status IN ('active', 'delete_pending', 'deleted', 'delete_failed')),
            delete_attempts INTEGER NOT NULL DEFAULT 0,
            last_delete_attempt_at TIMESTAMPTZ,
            last_error TEXT
        )
    `);
    await pool.query('CREATE INDEX IF NOT EXISTS idx_voice_clones_session_id ON voice_clones(session_id)');
    await pool.query('CREATE INDEX IF NOT EXISTS idx_voice_clones_status_created_at ON voice_clones(status, created_at)');
    console.log('[VoiceRegistry] Using PostgreSQL registry');
}

function initSqlite() {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const Database = require('better-sqlite3');
    sqliteDb = new Database(SQLITE_DB_PATH);
    sqliteDb.pragma('journal_mode = WAL');

    sqliteDb.exec(`
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
    console.log(`[VoiceRegistry] Using SQLite registry: ${SQLITE_DB_PATH}`);
}

async function ready() {
    if (!readyPromise) {
        readyPromise = (async () => {
            if (mode === 'postgres') {
                await initPostgres();
            } else {
                initSqlite();
            }
        })();
    }
    return readyPromise;
}

function mapRow(row) {
    if (!row) return row;
    return {
        voiceId: row.voice_id,
        sessionId: row.session_id,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
        status: row.status,
        deleteAttempts: row.delete_attempts
    };
}

async function registerVoice(voiceId, sessionId) {
    await ready();
    const now = nowIso();

    if (mode === 'postgres') {
        await pool.query(`
            INSERT INTO voice_clones (
                voice_id, session_id, created_at, updated_at, status
            ) VALUES ($1, $2, $3, $4, 'active')
            ON CONFLICT (voice_id) DO UPDATE SET
                session_id = EXCLUDED.session_id,
                updated_at = EXCLUDED.updated_at,
                status = CASE
                    WHEN voice_clones.status = 'deleted' THEN 'deleted'
                    ELSE 'active'
                END
        `, [voiceId, sessionId, now, now]);
        return;
    }

    sqliteDb.prepare(`
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

async function getActiveVoicesBySession(sessionId) {
    await ready();

    if (mode === 'postgres') {
        const result = await pool.query(`
            SELECT voice_id, session_id, created_at, status, delete_attempts
            FROM voice_clones
            WHERE session_id = $1
              AND status IN ('active', 'delete_pending', 'delete_failed')
            ORDER BY created_at DESC
        `, [sessionId]);
        return result.rows.map(mapRow);
    }

    return sqliteDb.prepare(`
        SELECT voice_id, session_id, created_at, status, delete_attempts
        FROM voice_clones
        WHERE session_id = ?
          AND status IN ('active', 'delete_pending', 'delete_failed')
        ORDER BY created_at DESC
    `).all(sessionId).map(mapRow);
}

async function getCleanupCandidates(maxAgeMs, maxAttempts = 10) {
    await ready();
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();

    if (mode === 'postgres') {
        const result = await pool.query(`
            SELECT voice_id, session_id, created_at, status, delete_attempts
            FROM voice_clones
            WHERE status = 'delete_pending'
               OR (status = 'active' AND created_at < $1)
               OR (status = 'delete_failed' AND delete_attempts < $2)
            ORDER BY created_at ASC
        `, [cutoff, maxAttempts]);
        return result.rows.map(mapRow);
    }

    return sqliteDb.prepare(`
        SELECT voice_id, session_id, created_at, status, delete_attempts
        FROM voice_clones
        WHERE status = 'delete_pending'
           OR (status = 'active' AND created_at < ?)
           OR (status = 'delete_failed' AND delete_attempts < ?)
        ORDER BY created_at ASC
    `).all(cutoff, maxAttempts).map(mapRow);
}

async function markDeleteSuccess(voiceId) {
    await ready();
    const now = nowIso();

    if (mode === 'postgres') {
        await pool.query(`
            UPDATE voice_clones
            SET status = 'deleted',
                deleted_at = $1,
                updated_at = $2,
                last_error = NULL
            WHERE voice_id = $3
        `, [now, now, voiceId]);
        return;
    }

    sqliteDb.prepare(`
        UPDATE voice_clones
        SET status = 'deleted',
            deleted_at = ?,
            updated_at = ?,
            last_error = NULL
        WHERE voice_id = ?
    `).run(now, now, voiceId);
}

async function markDeleteFailure(voiceId, error, maxAttempts = 10) {
    await ready();
    const now = nowIso();

    if (mode === 'postgres') {
        const current = await pool.query('SELECT delete_attempts FROM voice_clones WHERE voice_id = $1', [voiceId]);
        const attempts = (current.rows[0]?.delete_attempts || 0) + 1;
        const status = attempts >= maxAttempts ? 'delete_failed' : 'delete_pending';
        await pool.query(`
            UPDATE voice_clones
            SET status = $1,
                delete_attempts = $2,
                last_delete_attempt_at = $3,
                updated_at = $4,
                last_error = $5
            WHERE voice_id = $6
        `, [status, attempts, now, now, String(error || 'Unknown delete error').slice(0, 1000), voiceId]);
        return;
    }

    const row = sqliteDb.prepare(`
        SELECT delete_attempts AS deleteAttempts
        FROM voice_clones
        WHERE voice_id = ?
    `).get(voiceId);

    const attempts = (row?.deleteAttempts || 0) + 1;
    const status = attempts >= maxAttempts ? 'delete_failed' : 'delete_pending';

    sqliteDb.prepare(`
        UPDATE voice_clones
        SET status = ?,
            delete_attempts = ?,
            last_delete_attempt_at = ?,
            updated_at = ?,
            last_error = ?
        WHERE voice_id = ?
    `).run(status, attempts, now, now, String(error || 'Unknown delete error').slice(0, 1000), voiceId);
}

async function getStats() {
    await ready();
    const rows = mode === 'postgres'
        ? (await pool.query('SELECT status, COUNT(*)::int AS count FROM voice_clones GROUP BY status')).rows
        : sqliteDb.prepare('SELECT status, COUNT(*) AS count FROM voice_clones GROUP BY status').all();

    return rows.reduce((acc, row) => {
        acc[row.status] = Number(row.count);
        return acc;
    }, {});
}

module.exports = {
    DB_PATH: DATABASE_URL ? 'postgres:DATABASE_URL' : SQLITE_DB_PATH,
    get mode() {
        return mode;
    },
    ready,
    registerVoice,
    getActiveVoicesBySession,
    getCleanupCandidates,
    markDeleteSuccess,
    markDeleteFailure,
    getStats
};
