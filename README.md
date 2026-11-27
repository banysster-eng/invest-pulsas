# InvestPulsas — Automatinis 100 €/mėn. Akcijų ir ETF Investavimas (PWA + Trading 212 / Alpaca + Telegram)

Mobiliajam telefonui ir kompiuteriui pritaikyta žiniatinklio programėlė (**PWA**), kuri:
1. **Nuolat analizuoja** akcijų ir Europos UCITS ETF rinkas (`SMA50`, `SMA200`, `RSI 14`, `MACD`, `Bollinger`).
2. Leidžia **vienu paspaudimu pirkti arba parduoti** bet kurią akciją / ETF tiesiai iš kortelės (`⚡ Pirkti`).
3. **Automatiškai vykdo pirkimus ir pardavimus (Autopilotas)** griežtai neviršydama **100 €/mėn.** limito — tiek vidiniame autopilote, tiek sujungus su tikra arba Demo brokerio sąskaita (**Trading 212 API** arba **Alpaca API**).
4. **Automatiškai atsinaujina telefone** po kiekvieno programos ar duomenų atnaujinimo.

## Tikro brokerio prijungimas automatiniam pirkimui (Trading 212 — 0 € komisiniai)

1. Atidarykite **Trading 212** programėlę (*Practice / Demo* testavimui arba *Invest* tikriems pinigams) → `Settings → API (Beta) → Generate API key` (įjunkite *Account data, Portfolio, Orders*).
2. Šioje GitHub repozitorijoje atidarykite `Settings → Secrets and variables → Actions` ir įrašykite:
   - `T212_API_KEY` — jūsų API raktas.
   - `T212_API_SECRET` — jūsų slaptasis raktas.
   - `T212_ENV` — `demo` (praktinei sąskaitai) arba `live` (tikriems pinigams).
   - `MONTHLY_BUDGET_EUR` — `100` (mėnesio saugiklis eurais).
3. `GitHub Actions` kasdien automatiškai paleis `scripts/analyze_market.py` ir `scripts/auto_trader.py`, nupirks geriausio balo aktyvus ir atsiųs patvirtinimą į jūsų **Telegram** (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`).
