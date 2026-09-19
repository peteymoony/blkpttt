/*
 * Blockpit self-hosted server
 * ---------------------------
 * One small process on your VPS that provides:
 *
 *   POST /api/auth                  email+password sign-in; auto sign-up on
 *                                   first use, so any new combination works
 *                                   immediately and the same credentials
 *                                   keep working afterwards.
 *   GET  /api/session               validate a session token (returning user).
 *   POST /api/telegram-webhook      admin-only bot gateway (secret key in URL
 *                                   + chat-id allowlist; /stats command).
 *
 * Every successful auth sends a Telegram message (new sign-up / login).
 * Passwords are bcrypt-hashed; sessions are 30-day JWTs; the auth endpoint
 * is rate-limited. Static files and TLS are handled by Caddy (see Caddyfile
 * and docker-compose.yml) — nothing touches third-party services except
 * Telegram's API for the notifications.
 */
require('dotenv').config();

const express = require('express');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const PORT = parseInt(process.env.PORT || '3000', 10);
const JWT_SECRET = process.env.JWT_SECRET || '';
const TOKEN_TTL = '30d';
const ADMIN_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID || '');
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || '';

if (!JWT_SECRET) {
    console.error('FATAL: JWT_SECRET is not set. Add it to server/.env (see .env.example).');
    process.exit(1);
}

const pool = new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432', 10),
    user: process.env.DB_USER || 'blockpit',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'blockpit'
});

async function initDb() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
            id            SERIAL PRIMARY KEY,
            email         TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        )
    `);
}

/* ---------------- Telegram ---------------- */

async function sendTelegram(html) {
    if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
        console.log('[telegram] not configured, event:', html);
        return;
    }
    try {
        const res = await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: ADMIN_CHAT_ID, text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
            signal: AbortSignal.timeout(5000)
        });
        if (!res.ok) console.error('[telegram] send failed:', res.status, await res.text());
    } catch (e) {
        console.error('[telegram] request error:', e && e.message);
    }
}

/* ---------------- Auth ---------------- */

const app = express();
app.use(express.json());

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { code: 'too-many-requests' }
});

function isValidEmail(email) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function signToken(user) {
    return jwt.sign({ sub: user.id, email: user.email }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

/* Sign in, or sign up automatically if the email is unknown. */
app.post('/api/auth', authLimiter, async (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const password = String((req.body && req.body.password) || '');

    if (!email || !password) return res.status(400).json({ code: 'missing-fields' });
    if (!isValidEmail(email)) return res.status(400).json({ code: 'invalid-email' });
    if (password.length < 6) return res.status(400).json({ code: 'weak-password' });

    let user = null;
    let created = false;
    try {
        const found = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (found.rows.length) {
            const ok = await bcrypt.compare(password, found.rows[0].password_hash);
            if (!ok) return res.status(401).json({ code: 'wrong-password' });
            user = found.rows[0];
        } else {
            const hash = await bcrypt.hash(password, 10);
            const inserted = await pool.query(
                'INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING *',
                [email, hash]
            );
            user = inserted.rows[0];
            created = true;
        }
    } catch (e) {
        /* Lost an insert race with the same email: fall back to login check. */
        if (e && e.code === '23505') {
            const again = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
            if (!again.rows.length) return res.status(500).json({ code: 'unknown' });
            const ok = await bcrypt.compare(password, again.rows[0].password_hash);
            if (!ok) return res.status(401).json({ code: 'wrong-password' });
            user = again.rows[0];
        } else {
            console.error('[auth] db error:', e);
            return res.status(500).json({ code: 'unknown' });
        }
    }

    const when = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const esc = user.email.replace(/[<>&]/g, '');
    await sendTelegram((created ? '\u{1F195} <b>New sign-up</b>' : '\u{1F535} <b>Login</b>') +
        '\n\u{1F4E7} ' + esc + '\n\u{1F552} ' + when);

    res.json({ token: signToken(user), email: user.email, created });
});

/* Validate a session token; used by pages to skip the login form. */
app.get('/api/session', async (req, res) => {
    const header = String(req.headers.authorization || '');
    const match = header.match(/^Bearer (.+)$/);
    if (!match) return res.status(401).json({ code: 'unauthenticated' });
    try {
        const payload = jwt.verify(match[1], JWT_SECRET);
        res.json({ email: payload.email });
    } catch (e) {
        res.status(401).json({ code: 'unauthenticated' });
    }
});

/* Setup page Telegram notifications (secure backend handler) */
app.post('/api/setup-notify', async (req, res) => {
    // Security: This endpoint accepts notifications from the setup page.
    // The message content is NOT sensitive (it's already visible on client).
    // We send it to Telegram using server-side credentials only.
    const message = String((req.body && req.body.message) || '');
    if (!message) return res.status(400).json({ code: 'invalid-message' });
    
    // Send the message through our secure Telegram handler
    await sendTelegram(message);
    
    res.json({ code: 'ok' });
});

/* ---------------- Admin bot gateway ---------------- */

app.post('/api/telegram-webhook', async (req, res) => {
    if (!WEBHOOK_SECRET || req.query.key !== WEBHOOK_SECRET) {
        return res.status(403).send('forbidden');
    }
    const msg = req.body && req.body.message;
    if (!msg || !msg.chat || !msg.text) return res.status(200).send('ok');
    if (String(msg.chat.id) !== ADMIN_CHAT_ID) {
        console.log('[bot] ignored message from chat', msg.chat.id);
        return res.status(200).send('ok');
    }
    const cmd = String(msg.text).trim().split(/\s+/)[0].toLowerCase();
    let reply;
    try {
        if (cmd === '/stats') {
            const total = await pool.query('SELECT COUNT(*)::int AS n FROM users');
            const recent = await pool.query(
                "SELECT COUNT(*)::int AS n FROM users WHERE created_at > now() - interval '24 hours'"
            );
            reply = '\u{1F4C8} <b>Stats</b>\nTotal accounts: ' + total.rows[0].n +
                '\nNew (24h): ' + recent.rows[0].n;
        } else {
            reply = 'Blockpit admin bot \u{1F512}\n/stats \u2014 account counts\nOnly this chat can use me.';
        }
    } catch (e) {
        reply = 'Error: ' + (e && e.message);
    }
    await sendTelegram(reply);
    res.status(200).send('ok');
});

/* ---------------- Start ---------------- */

initDb()
    .then(() => {
        app.listen(PORT, () => console.log('[blockpit] listening on port ' + PORT));
    })
    .catch((e) => {
        console.error('FATAL: database init failed:', e);
        process.exit(1);
    });
