'use strict';

require('dotenv').config();

const crypto = require('crypto');
const http = require('http');
const path = require('path');

const cookie = require('cookie');
const express = require('express');
const pty = require('node-pty');
const { WebSocketServer } = require('ws');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.PORT || '3000', 10);
const TTY_PASSWORD = process.env.TTY_PASSWORD;
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours
const MAX_CONCURRENT_SESSIONS = parseInt(process.env.MAX_CONCURRENT_SESSIONS || '5', 10);
const LOGIN_WINDOW_MS = 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;

if (!TTY_PASSWORD || TTY_PASSWORD.length < 8) {
  console.error(
    '[web-tty] Refusing to start: set TTY_PASSWORD in your .env to a value of at least 8 characters.\n' +
    '           See .env.example.'
  );
  process.exit(1);
}

const SHELL = process.env.TTY_SHELL || (process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL || '/bin/bash'));
const START_CWD = process.env.TTY_CWD || process.env.HOME || process.cwd();

// Don't hand the login password to every process the user runs in their
// browser shell (e.g. `env` or `printenv` would otherwise print it).
const SHELL_ENV = { ...process.env };
delete SHELL_ENV.TTY_PASSWORD;

// ---------------------------------------------------------------------------
// In-memory session + rate-limit state
// (Fine for a single-instance personal tool. Swap for Redis if you ever run
//  more than one server process behind a load balancer.)
// ---------------------------------------------------------------------------

/** @type {Map<string, number>} token -> expiry timestamp (ms) */
const validTokens = new Map();

/** @type {Map<string, number[]>} ip -> array of recent attempt timestamps */
const loginAttempts = new Map();

let activeSessions = 0;

function isRateLimited(ip) {
  const now = Date.now();
  const attempts = (loginAttempts.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW_MS);
  loginAttempts.set(ip, attempts);
  return attempts.length >= LOGIN_MAX_ATTEMPTS;
}

function recordAttempt(ip) {
  const attempts = loginAttempts.get(ip) || [];
  attempts.push(Date.now());
  loginAttempts.set(ip, attempts);
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) {
    // Still run a comparison of equal length so failed attempts on
    // mismatched-length input take roughly the same time as a real check.
    crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function issueToken() {
  const token = crypto.randomBytes(32).toString('hex');
  validTokens.set(token, Date.now() + TOKEN_TTL_MS);
  return token;
}

function isValidToken(token) {
  if (!token) return false;
  const expiry = validTokens.get(token);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    validTokens.delete(token);
    return false;
  }
  return true;
}

function getTokenFromRequest(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  const parsed = cookie.parse(header);
  return parsed.tty_token || null;
}

// Periodically sweep expired tokens so the map doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [token, expiry] of validTokens) {
    if (now > expiry) validTokens.delete(token);
  }
}, 10 * 60 * 1000).unref();

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

function requireAuth(req, res, next) {
  const token = getTokenFromRequest(req);
  if (isValidToken(token)) return next();
  return res.redirect('/login');
}

// Public: login page + its assets (style.css is shared with the app page,
// so it has to be reachable before authentication, not just after).
app.get('/login', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/style.css', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'style.css'));
});

app.post('/login', (req, res) => {
  const ip = req.ip;

  if (isRateLimited(ip)) {
    return res.status(429).send('Too many attempts. Wait a minute and try again.');
  }

  const submitted = typeof req.body.password === 'string' ? req.body.password : '';
  recordAttempt(ip);

  if (!timingSafeEqual(submitted, TTY_PASSWORD)) {
    return res.redirect('/login?error=1');
  }

  const token = issueToken();
  res.cookie('tty_token', token, {
    httpOnly: true,
    sameSite: 'strict',
    secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
    maxAge: TOKEN_TTL_MS,
  });
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  const token = getTokenFromRequest(req);
  if (token) validTokens.delete(token);
  res.clearCookie('tty_token');
  res.redirect('/login');
});

app.get('/health', (req, res) => res.json({ ok: true, activeSessions }));

// Everything else under /public is protected.
app.use('/', requireAuth, express.static(path.join(__dirname, 'public'), { index: 'index.html' }));

const server = http.createServer(app);

// ---------------------------------------------------------------------------
// WebSocket bridge: browser <-> real shell process
// ---------------------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  if (!req.url.startsWith('/pty')) {
    socket.destroy();
    return;
  }

  const token = getTokenFromRequest(req);
  if (!isValidToken(token)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  if (activeSessions >= MAX_CONCURRENT_SESSIONS) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

wss.on('connection', (ws) => {
  activeSessions += 1;

  const shell = pty.spawn(SHELL, [], {
    name: 'xterm-256color',
    cols: 80,
    rows: 24,
    cwd: START_CWD,
    env: SHELL_ENV,
  });

  shell.onData((data) => {
    if (ws.readyState === ws.OPEN) ws.send(data);
  });

  shell.onExit(({ exitCode }) => {
    if (ws.readyState === ws.OPEN) ws.close(1000, `shell exited (${exitCode})`);
  });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return; // ignore malformed frames
    }

    if (msg.type === 'input' && typeof msg.data === 'string') {
      shell.write(msg.data);
    } else if (msg.type === 'resize' && Number.isInteger(msg.cols) && Number.isInteger(msg.rows)) {
      try {
        shell.resize(Math.max(1, msg.cols), Math.max(1, msg.rows));
      } catch {
        // ignore resize races on a dying process
      }
    }
  });

  ws.on('close', () => {
    activeSessions -= 1;
    shell.kill();
  });

  ws.on('error', () => {
    shell.kill();
  });
});

server.listen(PORT, () => {
  console.log(`[web-tty] listening on http://localhost:${PORT}`);
  console.log(`[web-tty] spawning shell: ${SHELL}`);
});
