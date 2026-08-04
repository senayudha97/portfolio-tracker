const express = require('express');
const fs = require('fs');
const path = require('path');
const { refreshPrices } = require('./prices');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const DATA_FILE = path.join(__dirname, 'portfolio.json');
const TOLERANCE = 5;
const POLL_MS = 5 * 60 * 1000;
const MAX_HISTORY = 500;

const app = express();
app.use(express.json());

function load() {
  const db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  db.targets = db.targets || {};
  db.prices = db.prices || {};
  db.history = Array.isArray(db.history) ? db.history : [];
  db.values = db.values || {};
  // ensure all classes present
  Object.keys(db.targets).forEach(c => {
    if (typeof db.values[c] !== 'number') db.values[c] = 0;
  });
  // backward compat: migrate legacy entries -> values
  if (Array.isArray(db.entries) && db.entries.length) {
    db.entries.forEach(e => {
      const c = e && e.class;
      if (c && c in db.values) db.values[c] += Number(e.amount || 0);
    });
    db.entries = [];
    save(db);
  }
  delete db.entries;
  return db;
}
function save(d) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
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
function payload() {
  const db = load();
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

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/api/portfolio', (req, res) => res.json(payload()));

app.get('/api/history', (req, res) => {
  const db = load();
  res.json({ history: db.history });
});

app.post('/api/portfolio/value', (req, res) => {
  const { class: cls, value } = req.body || {};
  const db = load();
  const val = Number(value);
  if (!cls || !(cls in db.targets) || !isFinite(val) || val < 0) {
    return res.status(400).json({ error: 'class valid dan value (>=0) wajib diisi' });
  }
  db.values[cls] = val;
  pushHistory(db);
  save(db);
  res.json(payload());
});

app.delete('/api/portfolio/value/:class', (req, res) => {
  const cls = req.params.class;
  const db = load();
  if (!(cls in db.targets)) return res.status(404).json({ error: 'class tidak ditemukan' });
  db.values[cls] = 0;
  pushHistory(db);
  save(db);
  res.json(payload());
});

app.post('/api/targets', (req, res) => {
  const db = load();
  const body = req.body || {};
  Object.keys(body).forEach(k => {
    if (k in db.targets) db.targets[k] = Number(body[k]) || 0;
  });
  save(db);
  res.json(payload());
});

app.post('/api/prices', (req, res) => {
  const db = load();
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
  save(db);
  res.json(payload());
});

async function pollPrices() {
  try {
    const db = load();
    const updated = await refreshPrices(db);
    save(db);
    console.log(`[prices] ${new Date().toISOString()} live update: ${updated.length ? updated.join(', ') : '(none)'}`);
  } catch (e) {
    console.warn('[prices] poll error (diabaikan):', e && e.message);
  }
}

app.listen(CONFIG.port, () => {
  console.log(`🌸 Portfolio Rebalancing Tracker jalan di http://localhost:${CONFIG.port}`);
  pollPrices();
  setInterval(pollPrices, POLL_MS);
});
