// Live price fetcher — free APIs, no key. Graceful: never throws.
const UA = { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) portfolio-tracker/1.1.0' };
const TIMEOUT = 12000;

// Classes without a reliable free API -> stay static (live:false)
const NO_API = ['Obligasi', 'Reksadana', 'Deposito', 'Properti', 'Cash', 'P2P Lending', 'SBN'];

async function getJSON(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT);
  try {
    const r = await fetch(url, { headers: UA, signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

async function yahooPrice(symbol) {
  const j = await getJSON('https://query1.finance.yahoo.com/v8/finance/chart/' + symbol);
  const meta = j && j.chart && j.chart.result && j.chart.result[0] && j.chart.result[0].meta;
  const p = meta && Number(meta.regularMarketPrice);
  if (!p || !isFinite(p)) throw new Error('no regularMarketPrice for ' + symbol);
  return p;
}

async function usdIdr() {
  try {
    const p = await yahooPrice('IDR%3DX');
    if (p > 1000) return { rate: p, live: true };
  } catch (_) {}
  try {
    const j = await getJSON('https://api.exchangerate.host/latest?base=USD&symbols=IDR');
    const r = j && j.rates && Number(j.rates.IDR);
    if (r && r > 1000) return { rate: r, live: true };
  } catch (_) {}
  return { rate: 16000, live: false }; // fallback
}

/**
 * Mutates db.prices in place. Returns list of updated class names.
 */
async function refreshPrices(db) {
  if (!db || !db.prices) return [];
  const now = new Date().toISOString();
  const updated = [];
  const set = (cls, price, currency, note) => {
    if (!db.prices[cls]) db.prices[cls] = {};
    db.prices[cls].price = Math.round(price * 100) / 100;
    db.prices[cls].currency = currency;
    db.prices[cls].note = note;
    db.prices[cls].live = true;
    db.prices[cls].updatedAt = now;
    updated.push(cls);
  };

  const fx = await usdIdr().catch(() => ({ rate: 16000, live: false }));
  const rate = fx.rate;

  const jobs = [
    // Crypto: BTC via CoinGecko
    (async () => {
      const j = await getJSON('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd,idr');
      const usd = j && j.bitcoin && Number(j.bitcoin.usd);
      if (!usd) throw new Error('no btc price');
      set('Crypto', usd, 'USD', 'BTC (CoinGecko live)');
    })(),
    (async () => set('Saham US (S&P500)', await yahooPrice('%5EGSPC'), 'USD', 'S&P500 (Yahoo live)'))(),
    (async () => set('Saham IDX', await yahooPrice('%5EJKSE'), 'IDR', 'IHSG (Yahoo live)'))(),
    (async () => {
      const oz = await yahooPrice('GC%3DF');
      if (!fx.live) console.warn('[prices] Emas pakai kurs fallback 16000');
      set('Emas', (oz / 31.1035) * rate, 'IDR', 'Emas per gram (Yahoo GC=F live)');
    })(),
    (async () => {
      if (!fx.live) throw new Error('fx fallback, bukan live');
      set('Valuta Asing', rate, 'IDR', 'USD/IDR (live)');
    })()
  ];

  const res = await Promise.allSettled(jobs);
  res.forEach(r => { if (r.status === 'rejected') console.warn('[prices] fetch gagal:', r.reason && r.reason.message); });

  // classes with no free API -> keep static value, mark not live
  NO_API.forEach(cls => {
    if (db.prices[cls]) {
      db.prices[cls].live = false;
      if (db.prices[cls].price === undefined) db.prices[cls].price = null;
    }
  });
  // anything else never fetched -> ensure live flag exists
  Object.keys(db.prices).forEach(cls => {
    if (db.prices[cls].live === undefined) db.prices[cls].live = false;
  });

  return updated;
}

module.exports = { refreshPrices, NO_API };
