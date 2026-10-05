const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const { refreshPrices } = require('./prices');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const DATA_FILE = path.join(__dirname, 'portfolio.json');
const COMPOSE_FILE = '/home/nokturnal/postgres/docker-compose.yml';
const SECRET_FILE = path.join(__dirname, '.session-secret');
const TOLERANCE = 5;
const POLL_MS = 5 * 60 * 1000;
const MAX_HISTORY = 500;
const COOKIE_NAME = 'pf_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 hari

// ---------------------------------------------------------------------------
// Postgres pool. Password is read at runtime from the compose file (or
// PGPASSWORD env) — never hardcoded, never logged, never written to disk.
// ---------------------------------------------------------------------------
function pgPassword() {
  if (process.env.PGPASSWORD) return process.env.PGPASSWORD;
  const yml = fs.readFileSync(COMPOSE_FILE, 'utf8');
  const m = yml.match(/^\s*POSTGRES_PASSWORD:\s*(.+?)\s*$/m);
  if (!m) throw new Error('POSTGRES_PASSWORD not found in ' + COMPOSE_FILE);
  return m[1].replace(/^["']|["']$/g, '');
}
const pool = new Pool({
  host: '127.0.0.1', port: 5432, database: 'hermesdb', user: 'hermes',
  password: pgPassword()
});

// ---------------------------------------------------------------------------
// Sessions: in-memory Map (token -> {userId, username, expires}).
// The cookie value is `<token>.<hmac-sha256(token, SECRET)>` — signed so it
// cannot be forged; the Map confirms it was actually issued. Trade-off:
// sessions are lost on server restart (users simply re-login).
// ---------------------------------------------------------------------------
function loadOrCreateSecret() {
  try {
    const s = fs.readFileSync(SECRET_FILE, 'utf8').trim();
    if (s) return s;
  } catch (_) {}
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, s + '\n', { mode: 0o600 });
  return s;
}
const SECRET = loadOrCreateSecret();
const sessions = new Map();

function signToken(token) {
  return crypto.createHmac('sha256', SECRET).update(token).digest('hex');
}
function issueSessionCookieValue(userId, username) {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { userId, username, expires: Date.now() + SESSION_TTL_MS });
  return token + '.' + signToken(token);
}
function resolveSession(req) {
  const header = req.headers.cookie || '';
  const raw = header.split(/;\s*/).map(c => c.split('='))
    .find(([k]) => k === COOKIE_NAME);
  if (!raw || !raw[1]) return null;
  const dot = raw[1].lastIndexOf('.');
  if (dot < 1) return null;
  const token = raw[1].slice(0, dot), sig = raw[1].slice(dot + 1);
  const a = Buffer.from(sig), b = Buffer.from(signToken(token));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (Date.now() > s.expires) { sessions.delete(token); return null; }
  return s;
}
function requireAuth(req, res, next) {
  const s = resolveSession(req);
  if (!s) return res.status(401).json({ error: 'unauthorized' });
  req.user = s;
  next();
}

// ---------------------------------------------------------------------------
// Schema init + one-time migration of portfolio.json -> user "sena".
// ---------------------------------------------------------------------------
async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pf_users (
      id serial PRIMARY KEY,
      username text UNIQUE NOT NULL,
      password_hash text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pf_portfolios (
      user_id int PRIMARY KEY REFERENCES pf_users(id) ON DELETE CASCADE,
      data jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
}
async function migrateLegacyFile() {
  const rc = await pool.query('SELECT count(*)::int AS n FROM pf_users');
  if (rc.rows[0].n > 0) return console.log('[migrate] pf_users not empty — skip');
  if (!fs.existsSync(DATA_FILE)) return console.log('[migrate] portfolio.json absent — skip');
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  const hash = await bcrypt.hash('123qweasd', 10); // runtime hash, never stored in source
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const u = await client.query(
      'INSERT INTO pf_users(username, password_hash) VALUES($1,$2) RETURNING id',
      ['sena', hash]);
    await client.query(
      'INSERT INTO pf_portfolios(user_id, data) VALUES($1,$2)',
      [u.rows[0].id, JSON.stringify(data)]);
    await client.query('COMMIT');
    fs.renameSync(DATA_FILE, DATA_FILE + '.migrated');
    console.log('[migrate] user "sena" created; portfolio.json imported -> portfolio.json.migrated');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Per-user portfolio load/save (whole doc as jsonb in pf_portfolios).
// ---------------------------------------------------------------------------
function normalize(db) {
  db.targets = db.targets || {};
  db.prices = db.prices || {};
  db.history = Array.isArray(db.history) ? db.history : [];
  db.values = db.values || {};
  Object.keys(db.targets).forEach(c => {
    if (typeof db.values[c] !== 'number') db.values[c] = 0;
  });
  return db;
}
async function load(userId) {
  const r = await pool.query('SELECT data FROM pf_portfolios WHERE user_id=$1', [userId]);
  if (!r.rows.length) throw new Error('portfolio row missing for user ' + userId);
  return normalize(r.rows[0].data);
}
async function save(userId, d) {
  await pool.query(`
    INSERT INTO pf_portfolios(user_id, data, updated_at) VALUES($1,$2,now())
    ON CONFLICT (user_id) DO UPDATE SET data=$2, updated_at=now()`,
    [userId, JSON.stringify(d)]);
}
function sumValues(values) {
  return Object.values(values).reduce((s, v) => s + Number(v || 0), 0);
}
function pushHistory(db) {
  const total = sumValues(db.values);
  db.history.push({ ts: new Date().toISOString(), values: { ...db.values }, total });
  while (db.history.length > MAX_HISTORY) db.history.shift();
}
function compute(db) {
  const total = sumValues(db.values);
  const computed = {};
  Object.keys(db.targets).forEach(cls => {
    const value = Number(db.values[cls] || 0);
    const pct = total > 0 ? (value / total) * 100 : 0;
    const target = Number(db.targets[cls] || 0);
    const diff = pct - target;
    let status = 'ok';
    if (diff < -TOLERANCE) status = 'under';
    else if (diff > TOLERANCE) status = 'over';
    computed[cls] = {
      class: cls,
      value,
      amount: value, // alias, kompatibilitas
      pct: Math.round(pct * 100) / 100,
      target,
      diff: Math.round(diff * 100) / 100,
      status
    };
  });
  const healthy = Object.values(computed).every(c => c.status === 'ok');
  return { total, computed, healthy };
}
async function payload(userId) {
  const db = await load(userId);
  const { total, computed, healthy } = compute(db);
  return {
    values: db.values,
    targets: db.targets,
    prices: db.prices,
    total,
    computed,
    healthy,
    tolerance: TOLERANCE,
    historySummary: {
      count: db.history.length,
      first: db.history[0] ? db.history[0].ts : null,
      last: db.history[db.history.length - 1] ? db.history[db.history.length - 1].ts : null
    }
  };
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json());

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// --- auth endpoints ---
function cookieAttrs(req) {
  const secure = req.secure ||
    String(req.headers['x-forwarded-proto'] || '').toLowerCase() === 'https';
  return `HttpOnly; Path=/; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}` +
    (secure ? '; Secure' : '');
}
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) {
      return res.status(400).json({ error: 'username dan password wajib diisi' });
    }
    const r = await pool.query(
      'SELECT id, username, password_hash FROM pf_users WHERE username=$1',
      [String(username)]);
    const u = r.rows[0];
    const ok = u && await bcrypt.compare(String(password), u.password_hash);
    if (!ok) return res.status(401).json({ error: 'username atau password salah' });
    const val = issueSessionCookieValue(u.id, u.username);
    res.setHeader('Set-Cookie', `${COOKIE_NAME}=${val}; ${cookieAttrs(req)}`);
    res.json({ ok: true, username: u.username });
  } catch (e) {
    console.error('[auth] login error:', e.message);
    res.status(500).json({ error: 'login gagal' });
  }
});
app.post('/api/auth/logout', (req, res) => {
  const header = req.headers.cookie || '';
  const raw = header.split(/;\s*/).map(c => c.split('=')).find(([k]) => k === COOKIE_NAME);
  if (raw && raw[1]) {
    const dot = raw[1].lastIndexOf('.');
    if (dot > 0) sessions.delete(raw[1].slice(0, dot));
  }
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
  res.json({ ok: true });
});
app.get('/api/auth/me', (req, res) => {
  const s = resolveSession(req);
  if (!s) return res.status(401).json({ error: 'unauthorized' });
  res.json({ username: s.username });
});

// --- all data endpoints require a valid session ---
app.use('/api/portfolio', requireAuth);
app.use('/api/history', requireAuth);
app.use('/api/targets', requireAuth);
app.use('/api/prices', requireAuth);

app.get('/api/portfolio', async (req, res) => {
  try { res.json(await payload(req.user.userId)); }
  catch (e) { console.error('[api] portfolio:', e.message); res.status(500).json({ error: 'gagal memuat data' }); }
});

app.get('/api/history', async (req, res) => {
  try {
    const db = await load(req.user.userId);
    res.json({ history: db.history });
  } catch (e) { console.error('[api] history:', e.message); res.status(500).json({ error: 'gagal memuat history' }); }
});

app.post('/api/portfolio/value', async (req, res) => {
  try {
    const { class: cls, value } = req.body || {};
    const db = await load(req.user.userId);
    const val = Number(value);
    if (!cls || !(cls in db.targets) || !isFinite(val) || val < 0) {
      return res.status(400).json({ error: 'class valid dan value (>=0) wajib diisi' });
    }
    db.values[cls] = val;
    pushHistory(db);
    await save(req.user.userId, db);
    res.json(await payload(req.user.userId));
  } catch (e) { console.error('[api] value:', e.message); res.status(500).json({ error: 'gagal menyimpan' }); }
});

app.delete('/api/portfolio/value/:class', async (req, res) => {
  try {
    const cls = req.params.class;
    const db = await load(req.user.userId);
    if (!(cls in db.targets)) return res.status(404).json({ error: 'class tidak ditemukan' });
    db.values[cls] = 0;
    pushHistory(db);
    await save(req.user.userId, db);
    res.json(await payload(req.user.userId));
  } catch (e) { console.error('[api] value del:', e.message); res.status(500).json({ error: 'gagal menyimpan' }); }
});

app.post('/api/targets', async (req, res) => {
  try {
    const db = await load(req.user.userId);
    const body = req.body || {};
    Object.keys(body).forEach(k => {
      if (k in db.targets) db.targets[k] = Number(body[k]) || 0;
    });
    await save(req.user.userId, db);
    res.json(await payload(req.user.userId));
  } catch (e) { console.error('[api] targets:', e.message); res.status(500).json({ error: 'gagal menyimpan' }); }
});

app.post('/api/prices', async (req, res) => {
  try {
    const db = await load(req.user.userId);
    const body = req.body || {};
    Object.keys(body).forEach(k => {
      if (k in db.prices) {
        const v = body[k] || {};
        if (v.price !== undefined) {
          db.prices[k].price = Number(v.price) || 0;
          db.prices[k].live = false; // manual override
          db.prices[k].updatedAt = new Date().toISOString();
        }
        if (v.currency) db.prices[k].currency = String(v.currency);
        if (v.note !== undefined) db.prices[k].note = String(v.note);
      }
    });
    await save(req.user.userId, db);
    res.json(await payload(req.user.userId));
  } catch (e) { console.error('[api] prices:', e.message); res.status(500).json({ error: 'gagal menyimpan' }); }
});

// ---------------------------------------------------------------------------
// Price polling — iterates ALL users' portfolios (simplest correct option:
// every user gets live prices). Only writes each user's own row.
// ---------------------------------------------------------------------------
async function pollPrices() {
  try {
    const users = await pool.query('SELECT user_id FROM pf_portfolios');
    for (const row of users.rows) {
      try {
        const db = await load(row.user_id);
        const updated = await refreshPrices(db);
        await save(row.user_id, db);
        console.log(`[prices] ${new Date().toISOString()} user ${row.user_id} live update: ${updated.length ? updated.join(', ') : '(none)'}`);
      } catch (e) {
        console.warn('[prices] user', row.user_id, 'poll error (diabaikan):', e && e.message);
      }
    }
  } catch (e) {
    console.warn('[prices] poll error (diabaikan):', e && e.message);
  }
}

// ---------------------------------------------------------------------------
// Boot: init schema + migrate, then listen. Exit(1) on failure so systemd
// (Restart=always) retries until Postgres is reachable.
// ---------------------------------------------------------------------------
initSchema()
  .then(migrateLegacyFile)
  .then(() => {
    app.listen(CONFIG.port, () => {
      console.log(`🌸 Portfolio Rebalancing Tracker jalan di http://localhost:${CONFIG.port}`);
      pollPrices();
      setInterval(pollPrices, POLL_MS);
    });
  })
  .catch(e => {
    console.error('[boot] init gagal:', e.message);
    process.exit(1);
  });
