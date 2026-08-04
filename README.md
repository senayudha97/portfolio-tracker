# 🌸 Portfolio Rebalancing Tracker

App kecil & manis buat pantau porsi portofolio investasi kamu: input nominal Rupiah + pilih asset class, lalu lihat donut chart porsi, progress bar aktual vs target, tabel harga acuan, dan health badge apakah portofolio sudah seimbang.

## Fitur
- ➕ Input nominal (Rp) + combo 12 asset class
- 🍩 Donut chart porsi aktual (Chart.js, warna pastel)
- 📊 Progress bar per class vs target (hijau = pas, kuning = kurang, merah = lebih, toleransi ±5%)
- ✏️ Target per class bisa diedit langsung
- 💰 Tabel harga acuan (origin price) per class, bisa diedit
- ✅ Health badge: "Portofolio Sehat" / "Perlu Rebalancing"
- 🧾 Daftar entry dengan tombol hapus

## Tech
Node.js + Express · Preact + htm via CDN · Chart.js via CDN · storage JSON file · no build step · no Docker.

## Jalankan
```bash
npm install
npm start
```
Buka http://localhost:8900

Port bisa diubah di `config.json`.

## API
| Method | Endpoint | Body |
|---|---|---|
| GET | `/api/portfolio` | – |
| POST | `/api/portfolio` | `{amount, class}` |
| DELETE | `/api/portfolio/:id` | – |
| POST | `/api/targets` | `{"Emas": 15}` |
| POST | `/api/prices` | `{"Emas": {"price": 1400000}}` |

## Asset Class
Saham IDX · Saham US (S&P500) · Obligasi · Reksadana · Emas · Crypto · Deposito · Properti · Cash · P2P Lending · SBN · Valuta Asing
