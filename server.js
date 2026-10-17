'use strict';

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const OpenAI = require('openai');
const { runAgent, DEFAULT_SYSTEM_PROMPT } = require('./agent.js');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const WORKSPACE_DIR = process.env.WORKSPACE_DIR || path.join(DATA_DIR, 'workspace');
const VIEWS_DIR = path.join(__dirname, 'views');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const PASSWORD = process.env.DASHBOARD_PASSWORD;

const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const REMEMBER_TTL = 30 * 24 * 60 * 60 * 1000;
const COOKIE_NAME = 'aivps_session';
const RATE_LIMIT_MAX = 5;
const RATE_LIMIT_WINDOW = 15 * 60 * 1000;

if (!PASSWORD) {
  console.error('[fatal] DASHBOARD_PASSWORD is required');
  process.exit(1);
}
if (PASSWORD.length < 12) {
  console.error('[warn] DASHBOARD_PASSWORD should be at least 12 characters');
}

const SECRET = crypto.createHash('sha256').update('ai-vps:' + PASSWORD).digest();

fs.mkdirSync(WORKSPACE_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'pylib'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'npm-global'), { recursive: true });
fs.mkdirSync(VIEWS_DIR, { recursive: true });

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_FILE)) return null;
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch { return null; }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

function maskKey(key) {
  if (typeof key !== 'string' || key.length < 8) return '';
  return key.slice(0, 3) + '•'.repeat(Math.min(20, key.length - 7)) + key.slice(-4);
}

function publicConfig(cfg) {
  if (!cfg) return { configured: false, baseUrl: '', model: '', apiKeyMask: '', systemPrompt: '' };
  return {
    configured: !!(cfg.apiKey && cfg.baseUrl && cfg.model),
    baseUrl: cfg.baseUrl || '',
    model: cfg.model || '',
    apiKeyMask: maskKey(cfg.apiKey || ''),
    systemPrompt: cfg.systemPrompt || '',
    defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT
  };
}

function audit(action, req, extra) {
  const ip = (req && (req.ip || (req.socket && req.socket.remoteAddress))) || '-';
  const payload = extra ? ' ' + JSON.stringify(extra) : '';
  console.log(`[audit] ${new Date().toISOString()} ${action} ip=${ip}${payload}`);
}

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  str = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Buffer.from(str, 'base64');
}
function signSession(expiresAt) {
  const payload = b64urlEncode(JSON.stringify({ exp: expiresAt }));
  const sig = b64urlEncode(crypto.createHmac('sha256', SECRET).update(payload).digest());
  return payload + '.' + sig;
}
function verifySession(token) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot < 1) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = b64urlEncode(crypto.createHmac('sha256', SECRET).update(payload).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(b64urlDecode(payload).toString('utf8'));
    if (typeof data.exp !== 'number' || data.exp < Date.now()) return null;
    return data;
  } catch { return null; }
}
function parseCookies(header) {
  const out = Object.create(null);
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    try { out[k] = decodeURIComponent(v); } catch { out[k] = v; }
  }
  return out;
}
function getSession(req) {
  return verifySession(parseCookies(req.headers.cookie)[COOKIE_NAME]);
}
function setSessionCookie(req, res, maxAge) {
  const token = signSession(Date.now() + maxAge);
  const secure = req.secure || req.headers['x-forwarded-proto'] === 'https';
  const parts = [
    COOKIE_NAME + '=' + encodeURIComponent(token),
    'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=' + Math.floor(maxAge / 1000)
  ];
  if (secure) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}
function requireAuthApi(req, res, next) {
  if (!getSession(req)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}
function requireAuthPage(req, res, next) {
  if (!getSession(req)) return res.redirect('/?login=1');
  next();
}

const attempts = new Map();
function checkRateLimit(ip) {
  const now = Date.now();
  const rec = attempts.get(ip);
  if (!rec || rec.resetAt < now) {
    attempts.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW });
    return { ok: true, remaining: RATE_LIMIT_MAX - 1 };
  }
  if (rec.count >= RATE_LIMIT_MAX) return { ok: false, retryAfter: Math.ceil((rec.resetAt - now) / 1000) };
  rec.count++;
  return { ok: true, remaining: RATE_LIMIT_MAX - rec.count };
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, rec] of attempts) if (rec.resetAt < now) attempts.delete(ip);
}, 60000).unref();

const app = express();
const server = http.createServer(app);

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
});

app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.headers.origin;
  if (!origin) return next();
  try {
    const o = new URL(origin);
    if (o.host !== req.headers.host) return res.status(403).json({ error: 'Origin blocked' });
  } catch { return res.status(403).json({ error: 'Invalid origin' }); }
  next();
});

app.use(express.json({ limit: '8mb' }));
app.use(express.static(VIEWS_DIR, { index: false }));

/* AUTH */
app.post('/api/auth/login', (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const rl = checkRateLimit(ip);
  if (!rl.ok) {
    res.set('Retry-After', String(rl.retryAfter));
    return res.status(429).json({ error: 'Too many attempts. Retry in ' + rl.retryAfter + 's.' });
  }
  const { password, remember } = req.body || {};
  if (typeof password !== 'string' || !password) return res.status(400).json({ error: 'Password required' });
  const given = crypto.createHash('sha256').update(password).digest();
  const actual = crypto.createHash('sha256').update(PASSWORD).digest();
  if (!crypto.timingSafeEqual(given, actual)) {
    audit('login.fail', req);
    return res.status(401).json({ error: 'Invalid password', remaining: rl.remaining });
  }
  attempts.delete(ip);
  setSessionCookie(req, res, remember ? REMEMBER_TTL : SESSION_TTL);
  audit('login.ok', req);
  res.json({ ok: true });
});

app.post('/api/auth/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  const s = getSession(req);
  if (!s) return res.status(401).json({ error: 'Not authenticated' });
  res.json({ ok: true, exp: s.exp });
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

/* CONFIG */
app.get('/api/config', requireAuthApi, (req, res) => {
  res.json(publicConfig(loadConfig()));
});

app.post('/api/config', requireAuthApi, async (req, res) => {
  const body = req.body || {};
  const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl.trim().replace(/\/+$/, '') : '';
  const model = typeof body.model === 'string' ? body.model.trim() : '';
  const apiKeyInput = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
  const systemPrompt = typeof body.systemPrompt === 'string' ? body.systemPrompt : '';

  if (!baseUrl) return res.status(400).json({ error: 'Base URL is required' });
  if (!model) return res.status(400).json({ error: 'Model is required' });

  const existing = loadConfig() || {};
  let apiKey = existing.apiKey || '';
  if (apiKeyInput) {
    if (apiKeyInput.includes('•')) {
      apiKey = existing.apiKey || '';
    } else {
      apiKey = apiKeyInput;
    }
  }
  if (!apiKey) return res.status(400).json({ error: 'API Key is required' });

  try { new URL(baseUrl); } catch { return res.status(400).json({ error: 'Invalid Base URL' }); }

  const next = {
    baseUrl,
    apiKey,
    model,
    systemPrompt,
    updatedAt: new Date().toISOString()
  };
  saveConfig(next);
  audit('config.save', req, { model });
  res.json(publicConfig(next));
});

app.post('/api/config/test', requireAuthApi, async (req, res) => {
  const cfg = loadConfig();
  if (!cfg || !cfg.apiKey) return res.status(400).json({ error: 'Save config first' });
  try {
    const client = new OpenAI({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl, timeout: 20000, maxRetries: 0 });
    const started = Date.now();
    const result = await client.chat.completions.create({
      model: cfg.model,
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      max_tokens: 10
    });
    const text = result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content || '';
    res.json({
      ok: true,
      latency: Date.now() - started,
      reply: String(text).trim().slice(0, 100),
      model: cfg.model
    });
  } catch (err) {
    res.status(400).json({
      error: 'Connection failed: ' + (err.message || String(err)).slice(0, 300)
    });
  }
});

/* SYSTEM */
app.get('/api/system/info', requireAuthApi, (req, res) => {
  res.json({
    hostname: os.hostname(),
    platform: os.platform(),
    node: process.version,
    uptime: os.uptime(),
    workspace: WORKSPACE_DIR,
    config: publicConfig(loadConfig())
  });
});

/* CHAT — SSE */
app.post('/api/chat', requireAuthApi, async (req, res) => {
  const cfg = loadConfig();
  if (!cfg || !cfg.apiKey) return res.status(400).json({ error: 'AI not configured. Open Settings.' });

  const body = req.body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) return res.status(400).json({ error: 'No messages provided' });

  const sanitized = messages
    .filter(m => m && typeof m === 'object' && typeof m.role === 'string')
    .map(m => {
      if (m.role === 'user' || m.role === 'assistant') {
        const out = { role: m.role, content: typeof m.content === 'string' ? m.content : '' };
        if (m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
          out.tool_calls = m.tool_calls;
          if (!out.content) out.content = null;
        }
        return out;
      }
      if (m.role === 'tool' && typeof m.tool_call_id === 'string') {
        return { role: 'tool', tool_call_id: m.tool_call_id, content: typeof m.content === 'string' ? m.content : '' };
      }
      return null;
    })
    .filter(Boolean);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const controller = new AbortController();
  let closed = false;

  const send = (event) => {
    if (closed) return;
    try { res.write('data: ' + JSON.stringify(event) + '\n\n'); } catch {}
  };

  const heartbeat = setInterval(() => {
    if (closed) return;
    try { res.write(': ping\n\n'); } catch {}
  }, 15000);

  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    try { controller.abort(); } catch {}
    try { res.end(); } catch {}
  };

  req.on('close', cleanup);
  res.on('close', cleanup);

  audit('chat.start', req, { messages: messages.length });

  try {
    await runAgent({
      messages: sanitized,
      config: {
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
        systemPrompt: cfg.systemPrompt
      },
      workspace: WORKSPACE_DIR,
      emit: send,
      signal: controller.signal
    });
  } catch (err) {
    const msg = String(err && err.message || err);
    if (!closed) {
      send({ type: 'error', message: msg });
    }
    audit('chat.error', req, { message: msg.slice(0, 200) });
  } finally {
    if (!closed) {
      try { res.write('data: [DONE]\n\n'); } catch {}
    }
    cleanup();
  }
});

/* PAGES */
app.get('/', requireAuthPage, (req, res) => {
  res.sendFile(path.join(VIEWS_DIR, 'index.html'));
});

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) return res.status(404).json({ error: 'Not found' });
  if (getSession(req)) return res.redirect('/');
  res.sendFile(path.join(VIEWS_DIR, 'index.html'));
});

app.use((err, req, res, next) => {
  console.error('[error]', err && err.message);
  if (res.headersSent) return next(err);
  if (req.path.startsWith('/api/')) return res.status(500).json({ error: 'Internal server error' });
  res.status(500).type('text/plain').send('Internal server error');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log('[ready] ai-vps listening on :' + PORT);
  console.log('[ready] workspace=' + WORKSPACE_DIR);
  console.log('[ready] config=' + (fs.existsSync(CONFIG_FILE) ? 'present' : 'not configured'));
  console.log('[ready] auth=' + (PASSWORD ? 'password' : 'disabled'));
});
