const express = require('express');
const fs = require('fs');
const path = require('path');

const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json'), 'utf8'));
const DATA_FILE = path.join(__dirname, 'portfolio.json');
const TOLERANCE = 5;

const app = express();
app.use(express.json());

function load() {
  return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
}
function save(d) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
}
function compute(db) {
  const total = db.entries.reduce((s, e) => s + Number(e.amount || 0), 0);
  const computed = {};
  Object.keys(db.targets).forEach(cls => {
    const amount = db.entries.filter(e => e.class === cls)
      .reduce((s, e) => s + Number(e.amount || 0), 0);
    const pct = total > 0 ? (amount / total) * 100 : 0;
    const target = Number(db.targets[cls] || 0);
    const diff = pct - target;
    let status = 'ok';
    if (diff < -TOLERANCE) status = 'under';
    else if (diff > TOLERANCE) status = 'over';
    computed[cls] = {
      amount,
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
    entries: db.entries,
    targets: db.targets,
    prices: db.prices,
    total,
    computed,
    healthy,
    tolerance: TOLERANCE
  };
}

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.get('/api/portfolio', (req, res) => res.json(payload()));

app.post('/api/portfolio', (req, res) => {
  const { amount, class: cls } = req.body || {};
  const db = load();
  const amt = Number(amount);
  if (!amt || amt <= 0 || !cls || !(cls in db.targets)) {
    return res.status(400).json({ error: 'amount (>0) dan class valid wajib diisi' });
  }
  db.entries.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    amount: amt,
    class: cls,
    createdAt: new Date().toISOString()
  });
  save(db);
  res.json(payload());
});

app.delete('/api/portfolio/:id', (req, res) => {
  const db = load();
  const before = db.entries.length;
  db.entries = db.entries.filter(e => e.id !== req.params.id);
  if (db.entries.length === before) return res.status(404).json({ error: 'entry tidak ditemukan' });
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
      if (v.price !== undefined) db.prices[k].price = Number(v.price) || 0;
      if (v.currency) db.prices[k].currency = String(v.currency);
      if (v.note !== undefined) db.prices[k].note = String(v.note);
    }
  });
  save(db);
  res.json(payload());
});

app.listen(CONFIG.port, () => {
  console.log(`🌸 Portfolio Rebalancing Tracker jalan di http://localhost:${CONFIG.port}`);
});
