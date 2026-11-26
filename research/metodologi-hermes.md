# Metodologi Ranking Token Launch Radar (token-radar-01)

**Bounty:** Build the best token launch radar — $1,325 hadiah, tenggat 14 Des 2026

## 1. Implied Launch Value (ILV)

$$ILV_i = TVL_i \times (MCap/TVL)_{peer,i} \times L_{liquidity,i} \times \frac{1}{1 + e^{-k \cdot (T_{end} - T_{now})}}$$

- **TVL_i**: Total Value Locked (USD, DefiLLA snapshot)
- **$(MCap/TVL)_{peer,i}$**: Rasio kapitalisasi/TVL dari peers sejenis yang sudah punya token — pengganti harga token karena target bounty protokol tanpa token. Rata-rata dari 5 protokol serupa di DefiLlama.
- **L_liquidity,i**: 1 jika pool USD/Eth langsung di Uniswap V3, 0.5 jika hanya pasangan stablecoin, 0.2 jika LP token tersembunyi
- **k = 0.05/hari**: Konstanta decay
- **T_end**: Tenggat 2026-12-14 10:00 UTC; **T_now**: waktu snapshot

**Contoh:** Protokol A: TVL=$50M, $(MCap/TVL)_{peer}=0.8$, likuiditas=1.0, hari sisa=20 → $ILV_A = 50M \times 0.8 \times 1.0 \times \frac{1}{1+e^{-1}} = \$29.2M$. Protokol B: TVL=$200M, $(MCap/TVL)_{peer}=0.3$, likuiditas=0.5, hari sisa=20 → $ILV_B = \$21.9M$.

## 2. Estimasi Token Odds (T.O.)

$$T.O._i = P_{market,i} \times P_{technical,i} \times P_{community,i}$$

- **P_market**: EMA 7 hari → naik 0.8, turun 0.3, consolidasi 0.5
- **P_technical**: audit+open source+dokumen >500 kata → max 0.8 (audit 0.3, open source 0.3, docs 0.2)
- **P_community**: Twitter × 0.00001 (max 0.5) + Discord/1000 (max 0.5)

**Contoh:** Protokol X: market 0.8, teknik 0.6, Twitter 50K (0.5), Discord 2K (0.5, dibatasi dari 2.0). P_community = 1.0. $T.O._X = 0.8 \times 0.6 \times 1.0 = 0.48$ → 48%.

## 3. Model Biaya Farm (Farm Cost Model)

$$C_{farm,i} = Gas_{avg,i} \times Gas_{price,i} \times Jumlah\_Txs\_per\_hour$$

- **Gas_avg**: rata-rata gas per transaksi (misal 45,000)
- **Gas_price**: harga gas USD rata-rata 7 hari (misal $0.0008/gas)
- **Jumlah_Txs_per_hour**: estimasi tx per jam (misal 60)

**Contoh Uniswap V3:** Gas_avg=45,000, Gas_price=$0.0008, Tx/jam=60 → Biaya gas per jam = 45000 × 0.0008 × 60 = **$2,160/jam**. Reward per jam (APY 15%, token $2.00): (0.15 ÷ 365 ÷ 24) × 2.00 ≈ $0.000034/jam. Net Profit = $0.000034 − $2,160 ≈ −$2,160 (rugi).

*Catatan:* Rumus menghitung biaya gas per jam langsung (satuan dollar/jam) melalui *gas × harga gas × tx per jam*. Hasil dibandingkan dengan reward per jam dalam dollar — perbedaan dimensi lama (pembagian dengan reward rate) telah dihilangkan.

## 4. Aturan Eksklusi Produk Wrapped/Staked

| Kriteria | Keterangan |
|---|---|
| Wrapped token | Hanya versi "wrapped" (wBTC, renBTC) tanpa exposure langsung |
| Staked derivative | Hanya staking token posisi terkunci (stETH, mETH) tanpa jalan keluar fluid |
| Lainnya dari 1 | Token utama staked-LP token atau receipt kontrak pihak ketiga |

**Terlewat:** Curve stETH/ETH pool, Lido staking router, AnyWrap/renProtocol, token yang dikunci di kontrak pihak ketiga.

**Diterima (bukan wrapped/staked):** Uniswap V3 pool ETH/USDC langsung, Aave lending pool aset native, synthetic protokol dengan collateral native.

*Pengecualian:* Protokol dengan opsi "exit" ke underlying asli melalui mesh bridge (Wormhole, Axelar) dinilai case-by-case, skor reduksi 0.3 pada ILV jika bridge terpercaya.

## 5. Cara Menangani Range dan Ketidakpastian

1. **Missing TVL** → Proxie: volume 24h × 30 hari ÷ harga spot. Jika tidak ada → **?** board.json, di-exclude dari ILV ranking.
2. **Range harga** → Interval 90 hari: harga_center = (min+max)/2, uncertainty_bonus = 0.1 × (max−min)/harga_center.
3. **Outlier data** → TVL >$1B atau <$1M dicek error snapshot. Aneh → catat metastable, bobot ILV 0.7 rata-rata sektor.
4. **Ketidakpastian farm** → Gunakan APY_min dari 30 hari lalu, bukan APY_terbaru (bisa bergeser 20% seminggu).
5. **Tidak ada data peer** → Protokol baru (<7 hari): ILV=0, T.O.=0.5, watchlist pending.

## 6. Sealed Snapshot DefiLlama

**Sealed snapshot** = file data statis diambil sekali dari DefiLlama, disertikan bersama deliverable. "Terseal" karena tidak diakses ulang dari API live selama analisis — setiap jalankan program menggunakan data yang sama (deterministik, sesuai kit: program runs twice, both runs write same bytes).

**Cara praktis:**
1. `curl -s "https://api.llama.fi/protocols"` → simpan 9100 protokol sebagai `defillama-snapshot-20261124.json`
2. Semua kalkulasi ILV, T.O., C_farm menggunakan file JSON ini sebagai input tetap — tidak ada pemanggil API live selama ranking.

**Mengapa sesuai kit:** Tanpa network selama eksekusi; hasil identik setiap kali dijalankan karena snapshot fixed; single source of truth mencegah inconsistensi dari API realtime.

## 7. Struktur board.json

```json
{
  "rank": 1,
  "symbol": "",
  "name": "Direct ETH/USDC Liquidity Pool",
  "chain": "Ethereum",
  "tvl": 1250000000,
  "ilv": 145000000,
  "token_odds": 0.632,
  "farm_net_usd_per_hr": -2160,
  "status": "active",
  "reason_excluded": null,
  "farm_plan": "Provide liquidity ETH/USDC, APY 15%, estimasi net loss $2.160/jam tapi token odds 63.2% kompensasi"
}
```

Minimum 100 baris, protokol DefiLlama bukan wrapped/staked.

## 8. Alur Kerja Lengkap

1. Ambil sealed snapshot DefiLlama → `defillama-snapshot-20261124.json`
2. Filter excluded (wrapped/staked) → `board-excluded.txt`
3. Hitung ILV menggunakan Sek 1
4. Hitung T.O. menggunakan Sek 2
5. Hitung C_farm menggunakan Sek 3
6. Prioritaskan: ILV × T.O. tertapi + net farm profit > 0
7. Generate board.json minimal 100 baris
8. Generate dashboard (HTML statis, tanpa network)
9. Ambil 3 screenshot: board, detail, filtered
10. Submit ke make.fun sebelum 14 Des 2026 10:00 UTC

## 9. Validasi Held-Out

 Menguji kestabilan term value (ILV, T.O., C_farm) dengan mengisolir satu variabel.

**Walk-Forward Validation:**
1. Bagi waktu jadi window: training (30 hari) + testing (7 hari selanjutnya)
2. Hit ILV, T.O., C_farm pakai data training
3. Validasi di testing: apakah protokol "terbaik" training tetap terbaik testing
4. Geser window 7 hari ke depan, ulangi
5. Catat konsistensi peringkat

**Leave-One-Out Validation:**
1. Untuk setiap term value (MCap/TVL peer, likuiditas, APY), hapus satu protokol dari dataset
2. Re-hit skor sisa protokol tanpa yang di-"leave out"
3. Bandingkan ranking sebelum & setelah
4. Ulangi untuk setiap protokol
5. Identifikasi term value paling sensitif (mengubah ranking drastis saat di-left-out)

**Tujuan:** Menghapus overfitting, pastikan rumus tidak bergantung terlalu pada satu protokol/outlier.

**---**

*Total kata: sekitar 850 kata.*