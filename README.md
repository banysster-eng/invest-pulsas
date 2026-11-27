# InvestPulsas — Išmani 100 €/mėn. Akcijų ir ETF Investavimo Programa (PWA + Telegram)

Mobiliajam telefonui ir kompiuteriui pritaikyta žiniatinklio programėlė (**PWA**), kuri automatiškai analizuoja akcijų ir Europos UCITS ETF rinkas, skaičiuoja **pirkimo ir pardavimo signalus**, sudaro optimalų **iki 100 €/mėn.** investicinį krepšelį, turi **virtualų prekybos autopilotą** bei siunčia skubias ataskaitas tiesiai į **Telegram**.

## Pagrindinės galimybės

- **Nuolatinė kiekybinė analizė (0–100 balų sistema):** vertina 50 d. ir 200 d. slankiuosius vidurkius (SMA50 / SMA200), RSI(14) nuolaidų ir perkaitimo zonas, MACD impulso posūkius, Bollinger juostas ir metinį kintamumą.
- **Aiškūs signalai lietuvių kalba:**
  - `STIPRUS PIRKIMAS` — stiprus ilgalaikis trendas + palanki įėjimo kaina.
  - `PIRKTI / KAUPTI (DCA)` — tinkama periodiniam mėnesiniam investavimui.
  - `LAIKYTI / STEBĖTI` — neutralus režimas.
  - `FIKSUOTI PELNĄ / LŪŽĘS TRENDAS` — įspėjimas apie perkaitimą (aukštą RSI) arba lūžusią tendenciją žemiau vidurkių.
- **Iki 100 €/mėn. krepšelio planuotojas:** parenka optimalias proporcijas eurais ir dalinėmis akcijomis pagal *Saugaus*, *Subalansuoto* arba *Augimo* strategijos profilius (orientuota į 0 € komisinių brokerius, tokius kaip *Trading 212*, *Revolut* ar *IBKR*).
- **Dvigubas portfelio režimas:**
  1. **Mano realus portfelis** — registruokite pirkimus, sekite mėnesinį 100 € limitą ir gaukite asmeninius pardavimo / pelno fiksavimo įspėjimus savo turimoms pozicijoms.
  2. **Virtualus Autopilotas (Robotas)** — automatiškai vykdo simuliacinius pirkimus ir apsauginius pardavimus už 100 €/mėn. biudžetą.
- **Automatiniai foniniai atnaujinimai (GitHub Actions):** kiekvieną darbo dieną (Europos sesijos, JAV atidarymo ir JAV uždarymo metu) nemokamai atnaujina rinkos signalus ir gali išsiųsti pranešimą į jūsų **Telegram**.

## Kaip įjungti 24/7 automatinius Telegram pranešimus

1. Telegram programėlėje atidarykite `@BotFather`, sukurkite botą su `/newbot` ir nukopijuokite `TELEGRAM_BOT_TOKEN` (paspauskite savo botui **Start**).
2. Parašykite `@userinfobot` ir sužinokite savo skaitmeninį `TELEGRAM_CHAT_ID`.
3. Šios GitHub repozitorijos nustatymuose (`Settings → Secrets and variables → Actions → New repository secret`) pridėkite:
   - `TELEGRAM_BOT_TOKEN`
   - `TELEGRAM_CHAT_ID`
4. Taip pat galite išbandyti siuntimą akimirksniu pačios programėlės skiltyje **Telegram**.

## Lokalus paleidimas

```bash
# Atnaujinti rinkos duomenis iš Yahoo Finance:
python3 scripts/analyze_market.py

# Paleisti vietinį serverį peržiūrai:
python3 -m http.server 8080
```
