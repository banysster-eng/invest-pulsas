#!/usr/bin/env python3
"""
InvestPulsas — Rinkos analizės, signalų generavimo, 100 €/mėn. krepšelio optimizavimo
ir Telegram pranešimų variklis.

Veikia be išorinių bibliotekų (tik standartinė Python 3.12 biblioteka), todėl
GitHub Actions aplinkoje įvykdomas per kelias sekundes.
"""

from __future__ import annotations

import concurrent.futures
import datetime as dt
import json
import math
import os
import statistics
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any

ROOT_DIR = Path(__file__).resolve().parent.parent
DATA_FILE = ROOT_DIR / "data" / "market_signals.json"

USER_AGENT = "Mozilla/5.0"

# Kruopščiai atrinkta investicinė visata Lietuvos / ES investuotojui (iki 100 €/mėn., dalinės akcijos, UCITS ETF)
ASSET_UNIVERSE: list[dict[str, Any]] = [
    {
        "symbol": "VUAA.DE",
        "isin": "IE00BFMXXD54",
        "alpacaSymbol": "VOO",
        "name": "Vanguard S&P 500 UCITS ETF (Acc)",
        "shortName": "S&P 500 ETF",
        "category": "ETF",
        "subCategory": "JAV rinka",
        "role": "core",
        "ter": 0.07,
        "riskLevel": "Vidutinė",
        "brokerHint": "Trading 212 / Revolut / IBKR (EUR, Xetra)",
        "thesis": "500 stipriausių JAV įmonių su reinvestuojamais dividendais ir minimaliu 0,07 % mokesčiu.",
    },
    {
        "symbol": "VWCE.DE",
        "isin": "IE00BK5BQT80",
        "alpacaSymbol": "VT",
        "name": "Vanguard FTSE All-World UCITS ETF (Acc)",
        "shortName": "All-World ETF",
        "category": "ETF",
        "subCategory": "Pasaulio rinka",
        "role": "core",
        "ter": 0.22,
        "riskLevel": "Žema–Vidutinė",
        "brokerHint": "Trading 212 / Revolut / IBKR (EUR, Xetra)",
        "thesis": "Virš 3 600 išsivysčiusių ir besivystančių šalių bendrovių viename fonde – maksimali diversifikacija.",
    },
    {
        "symbol": "QDVE.DE",
        "isin": "IE00B3WJKG14",
        "alpacaSymbol": "XLK",
        "name": "iShares S&P 500 Info Tech Sector UCITS ETF",
        "shortName": "S&P 500 Tech ETF",
        "category": "ETF",
        "subCategory": "Technologijų ETF",
        "role": "growth_etf",
        "ter": 0.15,
        "riskLevel": "Vidutinė–Aukšta",
        "brokerHint": "Trading 212 / Revolut / IBKR (EUR, Xetra)",
        "thesis": "Koncentruotas JAV informacinių technologijų ir DI lyderių krepšelis eurais.",
    },
    {
        "symbol": "SXRV.DE",
        "isin": "IE00B53SZB19",
        "alpacaSymbol": "QQQ",
        "name": "iShares Nasdaq 100 UCITS ETF (Acc)",
        "shortName": "Nasdaq 100 ETF",
        "category": "ETF",
        "subCategory": "Augimo ETF",
        "role": "growth_etf",
        "ter": 0.33,
        "riskLevel": "Vidutinė–Aukšta",
        "brokerHint": "Trading 212 / IBKR (EUR, Xetra)",
        "thesis": "100 didžiausių ne finansų sektoriaus Nasdaq inovacijų bendrovių.",
    },
    {
        "symbol": "EUNL.DE",
        "isin": "IE00B4L5Y983",
        "alpacaSymbol": "URTH",
        "name": "iShares Core MSCI World UCITS ETF (Acc)",
        "shortName": "MSCI World ETF",
        "category": "ETF",
        "subCategory": "Išsivysčiusios rinkos",
        "role": "core",
        "ter": 0.20,
        "riskLevel": "Žema–Vidutinė",
        "brokerHint": "Trading 212 / Swedbank / Revolut (EUR)",
        "thesis": "23 išsivysčiusių valstybių didžiųjų įmonių indeksas ilgalaikiam kapitalo auginimui.",
    },
    {
        "symbol": "IS3N.DE",
        "isin": "IE00BKM4GZ66",
        "alpacaSymbol": "IEMG",
        "name": "iShares Core MSCI EM IMI UCITS ETF (Acc)",
        "shortName": "Emerging Markets ETF",
        "category": "ETF",
        "subCategory": "Besivystančios rinkos",
        "role": "satellite_etf",
        "ter": 0.18,
        "riskLevel": "Vidutinė",
        "brokerHint": "Trading 212 / Revolut / IBKR (EUR)",
        "thesis": "Azijos (Taivano, Indijos, Korėjos) ir Lotynų Amerikos augančių ekonomikų priedas.",
    },
    {
        "symbol": "XDEM.DE",
        "isin": "IE00BL25JP72",
        "alpacaSymbol": "MTUM",
        "name": "Xtrackers MSCI World Momentum UCITS ETF",
        "shortName": "World Momentum ETF",
        "category": "ETF",
        "subCategory": "Faktorinis ETF",
        "role": "growth_etf",
        "ter": 0.25,
        "riskLevel": "Vidutinė",
        "brokerHint": "Trading 212 / IBKR (EUR, Xetra)",
        "thesis": "Automatiškai atrenka stipriausią kainos ir pelno pagreitį turinčias pasaulio akcijas.",
    },
    {
        "symbol": "4GLD.DE",
        "isin": "DE000A0S9GB0",
        "alpacaSymbol": "GLD",
        "name": "Xetra-Gold ETC (Fizinis auksas EUR)",
        "shortName": "Xetra-Gold",
        "category": "ETF",
        "subCategory": "Apsauginis turtas",
        "role": "defensive",
        "ter": 0.00,
        "riskLevel": "Žema",
        "brokerHint": "Trading 212 / IBKR / Bankai (EUR)",
        "thesis": "Apsauga nuo infliacijos ir akcijų rinkos sukrėtimų – mažina portfelio svyravimus.",
    },
    {
        "symbol": "MSFT",
        "isin": "US5949181045",
        "alpacaSymbol": "MSFT",
        "name": "Microsoft Corporation",
        "shortName": "Microsoft",
        "category": "Akcija",
        "subCategory": "Debesija ir DI",
        "role": "stock",
        "ter": 0.0,
        "riskLevel": "Vidutinė",
        "brokerHint": "Dalinės akcijos nuo 1 € (T212 / Revolut)",
        "thesis": "Azure debesų kompiuterijos, verslo programinės įrangos ir įmonių DI lyderė.",
    },
    {
        "symbol": "NVDA",
        "isin": "US67066G1040",
        "alpacaSymbol": "NVDA",
        "name": "NVIDIA Corporation",
        "shortName": "NVIDIA",
        "category": "Akcija",
        "subCategory": "Puslaidininkiai ir DI",
        "role": "stock",
        "ter": 0.0,
        "riskLevel": "Aukšta",
        "brokerHint": "Dalinės akcijos nuo 1 € (T212 / Revolut)",
        "thesis": "Pagrindinė dirbtinio intelekto duomenų centrų ir spartintuvų infrastruktūros tiekėja.",
    },
    {
        "symbol": "GOOGL",
        "isin": "US02079K3059",
        "alpacaSymbol": "GOOGL",
        "name": "Alphabet Inc. (Class A)",
        "shortName": "Alphabet (Google)",
        "category": "Akcija",
        "subCategory": "Skaitmeninės platformos",
        "role": "stock",
        "ter": 0.0,
        "riskLevel": "Vidutinė",
        "brokerHint": "Dalinės akcijos nuo 1 € (T212 / Revolut)",
        "thesis": "Paieškos, YouTube, Google Cloud ir savavaldžių technologijų milžinė su stipriu pinigų srautu.",
    },
    {
        "symbol": "AMZN",
        "isin": "US0231351067",
        "alpacaSymbol": "AMZN",
        "name": "Amazon.com, Inc.",
        "shortName": "Amazon",
        "category": "Akcija",
        "subCategory": "El. prekyba ir AWS",
        "role": "stock",
        "ter": 0.0,
        "riskLevel": "Vidutinė–Aukšta",
        "brokerHint": "Dalinės akcijos nuo 1 € (T212 / Revolut)",
        "thesis": "AWS debesijos lyderė ir sparčiai augančio pelningumo el. komercijos bei reklamos ekosistema.",
    },
    {
        "symbol": "AAPL",
        "isin": "US0378331005",
        "alpacaSymbol": "AAPL",
        "name": "Apple Inc.",
        "shortName": "Apple",
        "category": "Akcija",
        "subCategory": "Vartotojų technologijos",
        "role": "stock",
        "ter": 0.0,
        "riskLevel": "Vidutinė",
        "brokerHint": "Dalinės akcijos nuo 1 € (T212 / Revolut)",
        "thesis": "Aukštos maržos paslaugų pajamos, lojali įrenginių ekosistema ir nuolatinis savų akcijų supirkimas.",
    },
    {
        "symbol": "META",
        "isin": "US30303M1027",
        "alpacaSymbol": "META",
        "name": "Meta Platforms, Inc.",
        "shortName": "Meta",
        "category": "Akcija",
        "subCategory": "DI ir Skaitmeninė reklama",
        "role": "stock",
        "ter": 0.0,
        "riskLevel": "Vidutinė–Aukšta",
        "brokerHint": "Dalinės akcijos nuo 1 € (T212 / Revolut)",
        "thesis": "Virš 3 mlrd. kasdienių vartotojų bazė ir DI optimizuota pasaulinė reklamos platforma.",
    },
    {
        "symbol": "ASML.AS",
        "isin": "NL0010273215",
        "alpacaSymbol": "ASML",
        "name": "ASML Holding N.V.",
        "shortName": "ASML",
        "category": "Akcija",
        "subCategory": "Europos puslaidininkiai",
        "role": "stock",
        "ter": 0.0,
        "riskLevel": "Vidutinė–Aukšta",
        "brokerHint": "Euronext Amsterdam (EUR, dalinės akcijos)",
        "thesis": "Vienintelė pasaulyje EUV litografijos įrangos gamintoja, be kurios neįmanomi pažangiausi lustai.",
    },
    {
        "symbol": "SAP.DE",
        "isin": "DE0007164600",
        "alpacaSymbol": "SAP",
        "name": "SAP SE",
        "shortName": "SAP",
        "category": "Akcija",
        "subCategory": "Europos debesija",
        "role": "stock",
        "ter": 0.0,
        "riskLevel": "Vidutinė",
        "brokerHint": "Xetra (EUR, dalinės akcijos)",
        "thesis": "Stambiausia Europos verslo valdymo ir debesijos sistemų bendrovė su nuolatiniu prenumeratų srautu.",
    },
]


def fetch_yahoo_chart(symbol: str, range_str: str = "1y", interval: str = "1d") -> dict[str, Any]:
    """Nuskaito Yahoo Finance v8 chart duomenis naudojant curl (HTTP/2 TLS) su atsarginiu kartojimu."""
    encoded = urllib.parse.quote(symbol)
    hosts = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]
    last_err: str = "nežinoma klaida"
    for attempt in range(3):
        host = hosts[attempt % len(hosts)]
        url = f"https://{host}/v8/finance/chart/{encoded}?range={range_str}&interval={interval}&includePrePost=false"
        try:
            proc = subprocess.run(
                ["curl", "-sS", "--max-time", "12", "-H", f"User-Agent: {USER_AGENT}", url],
                capture_output=True,
                text=True,
                check=False,
            )
            if proc.returncode == 0 and proc.stdout.strip().startswith("{"):
                payload = json.loads(proc.stdout)
                result = payload.get("chart", {}).get("result")
                if result and len(result) > 0:
                    return result[0]
            last_err = proc.stdout[:120] or proc.stderr[:120] or f"exit {proc.returncode}"
        except Exception as exc:  # noqa: BLE001
            last_err = str(exc)
        time.sleep(0.5 * (attempt + 1))
    raise RuntimeError(f"Nepavyko gauti {symbol} duomenų: {last_err}")


def compute_ema_series(values: list[float], period: int) -> list[float]:
    if not values:
        return []
    k = 2.0 / (period + 1)
    ema = [values[0]]
    for val in values[1:]:
        ema.append(val * k + ema[-1] * (1.0 - k))
    return ema


def compute_sma_series(values: list[float], period: int) -> list[float | None]:
    out: list[float | None] = []
    running_sum = 0.0
    for i, val in enumerate(values):
        running_sum += val
        if i >= period:
            running_sum -= values[i - period]
        if i >= period - 1:
            out.append(running_sum / period)
        else:
            out.append(None)
    return out


def compute_rsi_series(closes: list[float], period: int = 14) -> list[float | None]:
    if len(closes) < period + 1:
        return [50.0] * len(closes)
    rsi_out: list[float | None] = [None] * period
    gains: list[float] = []
    losses: list[float] = []
    for i in range(1, period + 1):
        diff = closes[i] - closes[i - 1]
        gains.append(max(diff, 0.0))
        losses.append(max(-diff, 0.0))
    avg_gain = sum(gains) / period
    avg_loss = sum(losses) / period

    def calc_rsi(ag: float, al: float) -> float:
        if al == 0:
            return 100.0
        rs = ag / al
        return 100.0 - (100.0 / (1.0 + rs))

    rsi_out.append(calc_rsi(avg_gain, avg_loss))
    for i in range(period + 1, len(closes)):
        diff = closes[i] - closes[i - 1]
        gain = max(diff, 0.0)
        loss = max(-diff, 0.0)
        avg_gain = (avg_gain * (period - 1) + gain) / period
        avg_loss = (avg_loss * (period - 1) + loss) / period
        rsi_out.append(calc_rsi(avg_gain, avg_loss))
    return rsi_out


def compute_atr(highs: list[float], lows: list[float], closes: list[float], period: int = 14) -> float:
    if len(closes) < 2:
        return closes[-1] * 0.02 if closes else 1.0
    trs: list[float] = []
    for i in range(1, len(closes)):
        tr = max(
            highs[i] - lows[i],
            abs(highs[i] - closes[i - 1]),
            abs(lows[i] - closes[i - 1]),
        )
        trs.append(tr)
    window = trs[-period:] if len(trs) >= period else trs
    return sum(window) / len(window)


def score_at_index(
    idx: int,
    closes: list[float],
    sma50: list[float | None],
    sma200: list[float | None],
    rsi14: list[float | None],
    macd_hist: list[float],
    is_etf: bool,
) -> tuple[int, dict[str, int]]:
    """Apskaičiuoja 0–100 investicinio patrauklumo balą konkrečiame taške (naudojama ir backtestui!)."""
    price = closes[idx]
    s50 = sma50[idx] or price
    s200 = sma200[idx] if sma200[idx] is not None else s50
    rsi = rsi14[idx] if rsi14[idx] is not None else 50.0
    hist_now = macd_hist[idx]
    hist_prev = macd_hist[idx - 1] if idx > 0 else hist_now

    in_uptrend = price >= s200 * 0.985

    # 1. Ilgalaikės tendencijos balas (0..32)
    trend = 14
    if price > s200:
        trend += 10
    elif price < s200 * 0.94:
        trend -= 10
    else:
        trend -= 4

    if s50 >= s200:
        trend += 8
    else:
        trend -= 4
    trend = max(0, min(32, trend))

    # 2. Kainos nuolaidos / RSI įėjimo taško balas ("Pirk atsitraukimą tik tvariame trende", 0..33)
    if in_uptrend or is_etf:
        if rsi <= 34:
            dip = 32
        elif rsi <= 46:
            dip = 29
        elif rsi <= 56:
            dip = 24
        elif rsi <= 66:
            dip = 17
        elif rsi <= 74:
            dip = 9
        else:
            dip = 3
    else:
        # Pavienė akcija žemiau 200 d. vidurkio ("krintantis peilis") — mažiname balą kol neatsispyrė
        if rsi <= 32 and hist_now > hist_prev:
            dip = 20
        elif rsi <= 45:
            dip = 12
        else:
            dip = 8

    dist_s50_pct = ((price - s50) / s50) * 100.0 if s50 else 0.0
    if -7.0 <= dist_s50_pct <= -0.5 and in_uptrend:
        dip = min(33, dip + 4)
    elif dist_s50_pct < -12.0 and not is_etf:
        dip = max(2, dip - 6)
    elif dist_s50_pct > 14.0:
        dip = max(0, dip - 6)

    # 3. Impulso posūkio balas (MACD histograma, 0..20)
    momentum = 9
    if hist_now > hist_prev:
        momentum += 7
    else:
        momentum -= 4
    if hist_now > 0:
        momentum += 4
    momentum = max(0, min(20, momentum))

    # 4. Kokybės, stabilumo ir ETF priedo balas (0..15)
    lookback_start = max(0, idx - 120)
    sub_closes = closes[lookback_start : idx + 1]
    daily_rets = [
        (sub_closes[i] - sub_closes[i - 1]) / sub_closes[i - 1]
        for i in range(1, len(sub_closes))
        if sub_closes[i - 1] > 0
    ]
    vol_ann = (statistics.stdev(daily_rets) * math.sqrt(252) * 100.0) if len(daily_rets) > 5 else 20.0
    quality = 10 if is_etf else 6
    if vol_ann < 18.0:
        quality += 5
    elif vol_ann < 28.0:
        quality += 3
    elif vol_ann > 40.0:
        quality -= 4
    quality = max(1, min(15, quality))

    total = max(8, min(97, trend + dip + momentum + quality))
    return total, {
        "trend": trend,
        "dipValue": dip,
        "momentum": momentum,
        "quality": quality,
    }


def classify_signal(
    score: int,
    rsi: float,
    price: float,
    sma50_val: float,
    sma200_val: float,
    macd_rising: bool,
) -> tuple[str, str]:
    dist_sma50 = ((price - sma50_val) / sma50_val * 100.0) if sma50_val else 0.0
    dist_sma200 = ((price - sma200_val) / sma200_val * 100.0) if sma200_val else 0.0
    # 1) Perpirkta viršūnė -> Fiksuoti pelną
    if rsi >= 74.0 and dist_sma50 > 7.0 and not macd_rising:
        return "TRIM_SELL", "PARDUOTI (PELNAS)"
    if dist_sma200 < -5.5 and dist_sma50 < -6.0 and not macd_rising:
        return "TRIM_SELL", "PARDUOTI / VENGTI"
    if score >= 74:
        return "STRONG_BUY", "STIPRUS PIRKIMAS"
    if score >= 60:
        return "BUY_DCA", "PIRKTI"
    if score <= 43:
        return "TRIM_SELL", "PARDUOTI / VENGTI"
    return "HOLD", "LAIKYTI"


def pct_change(closes: list[float], days: int) -> float:
    if len(closes) < 2:
        return 0.0
    ref_idx = max(0, len(closes) - 1 - days)
    base = closes[ref_idx]
    return ((closes[-1] - base) / base * 100.0) if base else 0.0


def analyze_single_asset(meta_cfg: dict[str, Any], eurusd_rate: float) -> dict[str, Any]:
    symbol = meta_cfg["symbol"]
    raw = fetch_yahoo_chart(symbol, range_str="2y", interval="1d")
    meta = raw.get("meta", {})
    currency = meta.get("currency", "USD")
    timestamps = raw.get("timestamp", [])
    quote = raw.get("indicators", {}).get("quote", [{}])[0]

    raw_closes = quote.get("close", [])
    raw_highs = quote.get("high", [])
    raw_lows = quote.get("low", [])

    dates: list[str] = []
    closes: list[float] = []
    highs: list[float] = []
    lows: list[float] = []

    for ts, c, h, l in zip(timestamps, raw_closes, raw_highs, raw_lows):
        if c is None or c <= 0:
            continue
        dates.append(dt.datetime.fromtimestamp(ts, tz=dt.timezone.utc).strftime("%Y-%m-%d"))
        closes.append(float(c))
        highs.append(float(h) if h is not None else float(c))
        lows.append(float(l) if l is not None else float(c))

    if len(closes) < 30:
        raise RuntimeError(f"Nepakanka istorinių duomenų simboliui {symbol}")

    # Konvertavimo į EUR daugiklis
    if currency == "EUR":
        to_eur = 1.0
    elif currency == "USD":
        to_eur = 1.0 / eurusd_rate
    elif currency in ("GBp", "GBX"):
        to_eur = (0.01 * 1.18)
    else:
        to_eur = 1.0 / eurusd_rate

    sma20_series = compute_sma_series(closes, 20)
    sma50_series = compute_sma_series(closes, 50)
    sma200_series = compute_sma_series(closes, 200)
    rsi14_series = compute_rsi_series(closes, 14)

    ema12 = compute_ema_series(closes, 12)
    ema26 = compute_ema_series(closes, 26)
    macd_line = [a - b for a, b in zip(ema12, ema26)]
    macd_signal = compute_ema_series(macd_line, 9)
    macd_hist = [m - s for m, s in zip(macd_line, macd_signal)]

    last_idx = len(closes) - 1
    price_native = closes[-1]
    price_eur = price_native * to_eur

    sma20 = sma20_series[-1] or price_native
    sma50 = sma50_series[-1] or price_native
    sma200 = sma200_series[-1] or sma50
    rsi14 = rsi14_series[-1] if rsi14_series[-1] is not None else 50.0
    atr14 = compute_atr(highs, lows, closes, 14)

    # Bollinger juostos (20 d., 2 std)
    win20 = closes[-20:]
    std20 = statistics.stdev(win20) if len(win20) > 1 else price_native * 0.02
    bb_upper = sma20 + 2.0 * std20
    bb_lower = sma20 - 2.0 * std20
    bb_pct_b = ((price_native - bb_lower) / (bb_upper - bb_lower)) if (bb_upper - bb_lower) > 0 else 0.5
    z_score20 = ((price_native - sma20) / std20) if std20 > 0 else 0.0

    highs_52w = highs[-252:]
    lows_52w = lows[-252:]
    closes_1y = closes[-252:]
    high_52w = max(highs_52w)
    low_52w = min(lows_52w)
    drawdown_52w = ((price_native - high_52w) / high_52w) * 100.0

    daily_rets = [
        (closes_1y[i] - closes_1y[i - 1]) / closes_1y[i - 1]
        for i in range(1, len(closes_1y))
        if closes_1y[i - 1] > 0
    ]
    vol_annual = (statistics.stdev(daily_rets) * math.sqrt(252) * 100.0) if len(daily_rets) > 5 else 18.0
    ret_1y = pct_change(closes, min(252, len(closes) - 1))
    sharpe_1y = ((ret_1y - 3.0) / vol_annual) if vol_annual > 0 else 0.0

    is_etf = meta_cfg["category"] == "ETF"
    score, breakdown = score_at_index(
        last_idx, closes, sma50_series, sma200_series, rsi14_series, macd_hist, is_etf
    )
    macd_rising = macd_hist[-1] > (macd_hist[-2] if len(macd_hist) > 1 else macd_hist[-1])
    signal_code, signal_label = classify_signal(score, rsi14, price_native, sma50, sma200, macd_rising)

    # Trumpi ir aiškūs paaiškinimai paprastai kalbai (be sudėtingo žargono kortelėse)
    if signal_code == "STRONG_BUY":
        simple_verdict = "Tvarus augimas ir labai gera kaina pirkimui dabar."
    elif signal_code == "BUY_DCA":
        simple_verdict = "Tinkamas laikas ramiam mėnesiniam pirkimui."
    elif signal_code == "TRIM_SELL":
        if rsi14 >= 72:
            simple_verdict = "Kaina stipriai pakilusi — verta fiksuoti dalį pelno."
        else:
            simple_verdict = "Silpna kryptis (kaina krenta) — geriau palaukti arba mažinti."
    else:
        simple_verdict = "Neutrali būsena — turimą poziciją verta ramiai laikyti."

    # Išsamesni techniniai argumentai detaliajam langui
    reasons: list[str] = []
    if price_native > sma200:
        dist200 = (price_native - sma200) / sma200 * 100.0
        reasons.append(f"Ilgalaikė kryptis teigiama (+{dist200:.1f}% virš 200 d. vidurkio).")
    else:
        dist200 = (price_native - sma200) / sma200 * 100.0
        reasons.append(f"Kaina žemiau 200 d. vidurkio ({dist200:.1f}%) – rekomenduojamas atsargumas.")

    if rsi14 <= 36:
        reasons.append(f"RSI rodiklis žemas ({rsi14:.1f}) – aktyvas atpigęs, palanki nuolaida.")
    elif rsi14 <= 50:
        reasons.append(f"RSI rodiklis ({rsi14:.1f}) vėsioje zonoje be perkaitimo.")
    elif rsi14 >= 72:
        reasons.append(f"RSI rodiklis aukštas ({rsi14:.1f}) – padidėjusi korekcijos tikimybė.")
    else:
        reasons.append(f"RSI rodiklis subalansuotas ({rsi14:.1f}).")

    if macd_rising:
        reasons.append("Trumpalaikis pirkėjų impulsas šiuo metu stiprėja.")
    else:
        reasons.append("Trumpalaikis kainos pagreitis šiuo metu lėtėja.")

    if drawdown_52w <= -8.0:
        reasons.append(f"Kaina {abs(drawdown_52w):.1f}% žemiau metų viršūnės.")

    # Tiksliniai lygiai (EUR)
    entry_low_eur = max(0.01, (price_native - 0.8 * atr14) * to_eur)
    entry_high_eur = max(entry_low_eur, (price_native + 0.25 * atr14) * to_eur)
    take_profit_eur = max(price_native * 1.10, price_native + 3.0 * atr14) * to_eur
    stop_loss_eur = max(0.01, min(price_native * 0.92, price_native - 2.4 * atr14) * to_eur)

    # Istoriniai paskutinių 90 prekybos dienų duomenys grafikui (EUR valiuta!) + istoriniai signalų taškai
    chart_len = min(90, len(closes))
    start_c = len(closes) - chart_len
    chart_dates = dates[start_c:]
    chart_prices_eur = [round(c * to_eur, 2) for c in closes[start_c:]]
    chart_sma50_eur = [
        round((sma50_series[i] or closes[i]) * to_eur, 2) for i in range(start_c, len(closes))
    ]
    chart_sma200_eur = [
        round((sma200_series[i] or sma50_series[i] or closes[i]) * to_eur, 2)
        for i in range(start_c, len(closes))
    ]

    # Surandame kelis ryškiausius istorinius pirkimo/pardavimo taškus grafiko vizualizacijai
    chart_markers: list[dict[str, Any]] = []
    last_marker_i = -10
    for rel_i, abs_i in enumerate(range(start_c, len(closes))):
        if rel_i - last_marker_i < 8:
            continue
        r_val = rsi14_series[abs_i] or 50.0
        sc_val, _ = score_at_index(
            abs_i, closes, sma50_series, sma200_series, rsi14_series, macd_hist, is_etf
        )
        m_rise = macd_hist[abs_i] > (macd_hist[abs_i - 1] if abs_i > 0 else macd_hist[abs_i])
        if sc_val >= 76 and m_rise:
            chart_markers.append(
                {
                    "idx": rel_i,
                    "date": dates[abs_i],
                    "priceEur": round(closes[abs_i] * to_eur, 2),
                    "type": "BUY",
                }
            )
            last_marker_i = rel_i
        elif r_val >= 76 and not m_rise:
            chart_markers.append(
                {
                    "idx": rel_i,
                    "date": dates[abs_i],
                    "priceEur": round(closes[abs_i] * to_eur, 2),
                    "type": "SELL",
                }
            )
            last_marker_i = rel_i

    return {
        **meta_cfg,
        "currency": currency,
        "priceNative": round(price_native, 2),
        "priceEur": round(price_eur, 2),
        "toEurRate": round(to_eur, 6),
        "change1d": round(pct_change(closes, 1), 2),
        "change1w": round(pct_change(closes, 5), 2),
        "change1m": round(pct_change(closes, 21), 2),
        "change3m": round(pct_change(closes, 63), 2),
        "change1y": round(ret_1y, 2),
        "rsi14": round(rsi14, 1),
        "sma20Eur": round(sma20 * to_eur, 2),
        "sma50Eur": round(sma50 * to_eur, 2),
        "sma200Eur": round(sma200 * to_eur, 2),
        "distSma50Pct": round(((price_native - sma50) / sma50 * 100.0) if sma50 else 0.0, 2),
        "distSma200Pct": round(((price_native - sma200) / sma200 * 100.0) if sma200 else 0.0, 2),
        "macdHist": round(macd_hist[-1], 4),
        "macdRising": macd_rising,
        "bbPercentB": round(bb_pct_b, 2),
        "zScore20": round(z_score20, 2),
        "volatilityAnnual": round(vol_annual, 1),
        "drawdown52w": round(drawdown_52w, 2),
        "high52wEur": round(high_52w * to_eur, 2),
        "low52wEur": round(low_52w * to_eur, 2),
        "sharpe1y": round(sharpe_1y, 2),
        "score": score,
        "scoreBreakdown": breakdown,
        "signal": signal_code,
        "signalLabel": signal_label,
        "simpleVerdict": simple_verdict,
        "entryZoneEur": [round(entry_low_eur, 2), round(entry_high_eur, 2)],
        "takeProfitEur": round(take_profit_eur, 2),
        "stopLossEur": round(stop_loss_eur, 2),
        "reasons": reasons,
        "chart": {
            "dates": chart_dates,
            "pricesEur": chart_prices_eur,
            "sma50Eur": chart_sma50_eur,
            "sma200Eur": chart_sma200_eur,
            "markers": chart_markers,
        },
        "_fullDates": dates,
        "_fullClosesEur": [c * to_eur for c in closes],
        "_fullSma50": sma50_series,
        "_fullSma200": sma200_series,
        "_fullRsi14": rsi14_series,
        "_fullMacdHist": macd_hist,
        "_fullClosesNative": closes,
    }


def build_monthly_allocation_plans(assets: list[dict[str, Any]], budget_eur: float = 100.0) -> dict[str, Any]:
    """Sudaro konkrečius 100 €/mėn. paskirstymo krepšelius pagal 3 rizikos profilius."""
    by_score = sorted(assets, key=lambda a: a["score"], reverse=True)
    core_etfs = [a for a in by_score if a["role"] == "core" and a["signal"] != "TRIM_SELL"]
    growth_etfs = [a for a in by_score if a["role"] in ("growth_etf", "satellite_etf") and a["signal"] != "TRIM_SELL"]
    defensive = [a for a in by_score if a["role"] == "defensive"]
    top_stocks = [a for a in by_score if a["category"] == "Akcija" and a["signal"] != "TRIM_SELL"]

    if not core_etfs:
        core_etfs = [a for a in by_score if a["category"] == "ETF"]

    def make_item(asset: dict[str, Any], pct: int, rationale: str) -> dict[str, Any]:
        eur_amt = round(budget_eur * pct / 100.0, 2)
        est_units = round(eur_amt / asset["priceEur"], 4) if asset["priceEur"] > 0 else 0.0
        return {
            "symbol": asset["symbol"],
            "shortName": asset["shortName"],
            "name": asset["name"],
            "category": asset["category"],
            "pct": pct,
            "amountEur": eur_amt,
            "estShares": est_units,
            "priceEur": asset["priceEur"],
            "score": asset["score"],
            "signalLabel": asset["signalLabel"],
            "rationale": rationale,
        }

    # 1. Saugus / Konservatyvus (80% baziniai ETF + 20% apsauginis auksas arba pasaulio ETF)
    c1 = core_etfs[0]
    c2 = core_etfs[1] if len(core_etfs) > 1 else (growth_etfs[0] if growth_etfs else c1)
    d1 = defensive[0] if defensive else c2
    conservative_items = [
        make_item(c1, 55, "Pagrindinis pasaulio/JAV indekso ramstis su mažiausiu TER mokesčiu."),
        make_item(c2, 25, "Papildoma geografinė diversifikacija stabilumui."),
        make_item(d1, 20, "Apsauginis buferis rinkos korekcijų ir infliacijos metu."),
    ]

    # 2. Subalansuotas (Rekomenduojamas 100 €/mėn.: 50% Core ETF + 25% Augimo ETF + 25% geriausiai įvertinta akcija)
    g1 = growth_etfs[0] if growth_etfs else c2
    s1 = top_stocks[0] if top_stocks else g1
    balanced_items = [
        make_item(c1, 50, f"Tvirtas portfelio pamatas (balas {c1['score']}/100)."),
        make_item(g1, 25, f"Aukštesnio augimo potencialo sektorius (RSI {g1['rsi14']})."),
        make_item(s1, 25, f"Stipriausias šios dienos taktinis įėjimo signalas ({s1['score']}/100)."),
    ]

    # 3. Augimo / Aktyvus (35% ETF pamatas + 65% stipriausius pirkimo balus turinčios akcijos/ETF)
    s2 = top_stocks[1] if len(top_stocks) > 1 else g1
    growth_items = [
        make_item(g1, 35, "Technologijų ir impulso ETF branduolys."),
        make_item(s1, 35, f"Nr. 1 rinkos galimybė pagal algoritmą ({s1['score']}/100)."),
        make_item(s2, 30, f"Nr. 2 atrinkta augimo pozicija ({s2['score']}/100)."),
    ]

    return {
        "conservative": {
            "title": "Saugus kaupimas",
            "subtitle": "Minimalūs svyravimai, ETF ir aukso skydas",
            "expectedReturnRange": "7–9 % / m.",
            "items": conservative_items,
        },
        "balanced": {
            "title": "Išmanusis balansas (Rekomenduojama)",
            "subtitle": "ETF branduolys + geriausios rinkos nuolaidos",
            "expectedReturnRange": "9–13 % / m.",
            "items": balanced_items,
        },
        "growth": {
            "title": "Maksimalus augimas",
            "subtitle": "Technologijų lyderiai ir aktyvūs signalai",
            "expectedReturnRange": "11–16 % / m.",
            "items": growth_items,
        },
    }


def run_real_12m_backtest(assets: list[dict[str, Any]], monthly_eur: float = 100.0) -> dict[str, Any]:
    """
    Tikras istorinis 12 mėnesių backtestas su faktinėmis Yahoo Finance kainomis:
    Palygina:
      1) InvestPulsas algoritmą (100 €/mėn. į bazinį ETF + stipriausią trendo/nuolaidos lyderį, su pelno fiksavimu kai RSI > 76)
      2) Paprastą S&P 500 DCA (100 €/mėn. į VUAA.DE)
      3) Grynųjų laikymą sąskaitoje (100 €/mėn., 0 % grąža)
    """
    import bisect

    sp_asset = next((a for a in assets if a["symbol"] == "VUAA.DE"), assets[0])
    all_sp_dates = sp_asset["_fullDates"]
    if len(all_sp_dates) < 80:
        return {}

    # Imame paskutinius ~12 mėnesių (252 prekybos dienas), kai SMA200 jau pilnai susiformavęs
    start_bt = max(0, len(all_sp_dates) - 252)
    bt_dates = all_sp_dates[start_bt:]
    bt_len = len(bt_dates)

    def lookup_on_or_before(asset_obj: dict[str, Any], target_date: str) -> tuple[int | None, float | None]:
        d_list = asset_obj["_fullDates"]
        pos = bisect.bisect_right(d_list, target_date) - 1
        if pos < 0:
            return None, None
        return pos, asset_obj["_fullClosesEur"][pos]

    step = max(1, (bt_len - 1) // 12)
    check_offsets = [min(bt_len - 1, i * step) for i in range(12)]
    if check_offsets[-1] != bt_len - 1:
        check_offsets.append(bt_len - 1)

    smart_holdings: dict[str, float] = {}
    sp_shares = 0.0
    invested_total = 0.0

    labels: list[str] = []
    smart_curve: list[float] = []
    sp_curve: list[float] = []
    cash_curve: list[float] = []
    trade_log: list[dict[str, Any]] = []

    deposit_offsets = set(check_offsets[:12])

    for off in check_offsets:
        cur_date = bt_dates[off]
        labels.append(cur_date[:7])

        if off in deposit_offsets and invested_total < monthly_eur * 12:
            invested_total += monthly_eur
            _, sp_px = lookup_on_or_before(sp_asset, cur_date)
            if sp_px and sp_px > 0:
                sp_shares += monthly_eur / sp_px

            reinvest_pool = monthly_eur
            for sym, sh in list(smart_holdings.items()):
                if sh <= 0:
                    continue
                asset_obj = next(a for a in assets if a["symbol"] == sym)
                if asset_obj["role"] == "core":
                    continue
                a_i, px = lookup_on_or_before(asset_obj, cur_date)
                if a_i is not None and px:
                    r_val = asset_obj["_fullRsi14"][a_i] or 50.0
                    s50_v = asset_obj["_fullSma50"][a_i] or asset_obj["_fullClosesNative"][a_i]
                    c_nat = asset_obj["_fullClosesNative"][a_i]
                    if r_val >= 74.0:
                        sell_sh = sh * 0.5
                        proceeds = sell_sh * px
                        smart_holdings[sym] -= sell_sh
                        reinvest_pool += proceeds
                        trade_log.append(
                            {
                                "date": cur_date,
                                "action": "PARDUOTA 50%",
                                "symbol": asset_obj["shortName"],
                                "amountEur": round(proceeds, 2),
                                "reason": f"RSI pasiekė {r_val:.0f} (užfiksuotas pelnas)",
                            }
                        )
                    elif c_nat < s50_v * 0.97:
                        proceeds = sh * px
                        smart_holdings[sym] = 0.0
                        reinvest_pool += proceeds
                        trade_log.append(
                            {
                                "date": cur_date,
                                "action": "APS. PARDAVIMAS",
                                "symbol": asset_obj["shortName"],
                                "amountEur": round(proceeds, 2),
                                "reason": "Kaina kirto 50 d. vidurkį žemyn (apsaugotas kapitalas)",
                            }
                        )

            scored_today: list[tuple[float, int, dict[str, Any], float]] = []
            for a in assets:
                a_i, px = lookup_on_or_before(a, cur_date)
                if a_i is None or not px or px <= 0:
                    continue
                sc, _ = score_at_index(
                    a_i,
                    a["_fullClosesNative"],
                    a["_fullSma50"],
                    a["_fullSma200"],
                    a["_fullRsi14"],
                    a["_fullMacdHist"],
                    a["category"] == "ETF",
                )
                c_nat = a["_fullClosesNative"][a_i]
                s50_v = a["_fullSma50"][a_i] or c_nat
                s200_v = a["_fullSma200"][a_i] or c_nat
                mom_3m = (
                    (c_nat - a["_fullClosesNative"][max(0, a_i - 63)])
                    / a["_fullClosesNative"][max(0, a_i - 63)]
                    * 100.0
                )
                trend_bonus = 14.0 if (c_nat >= s50_v and s50_v >= s200_v) else (-14.0 if c_nat < s200_v else 0.0)
                rank_metric = sc + trend_bonus + min(18.0, max(-15.0, mom_3m * 0.55))
                scored_today.append((rank_metric, sc, a, px))

            scored_today.sort(key=lambda x: x[0], reverse=True)
            best_core = next((x for x in scored_today if x[2]["role"] == "core"), scored_today[0])
            best_tactical = next(
                (x for x in scored_today if x[2]["symbol"] != best_core[2]["symbol"]),
                best_core,
            )

            alloc_core = reinvest_pool * 0.60
            alloc_tac = reinvest_pool * 0.40

            smart_holdings[best_core[2]["symbol"]] = (
                smart_holdings.get(best_core[2]["symbol"], 0.0) + alloc_core / best_core[3]
            )
            smart_holdings[best_tactical[2]["symbol"]] = (
                smart_holdings.get(best_tactical[2]["symbol"], 0.0) + alloc_tac / best_tactical[3]
            )
            trade_log.append(
                {
                    "date": cur_date,
                    "action": "PIRKTA",
                    "symbol": f"{best_core[2]['shortName']} + {best_tactical[2]['shortName']}",
                    "amountEur": round(reinvest_pool, 2),
                    "reason": f"Balai: {best_core[1]} ir {best_tactical[1]}/100",
                }
            )

        smart_val = 0.0
        for sym, sh in smart_holdings.items():
            asset_obj = next(a for a in assets if a["symbol"] == sym)
            _, px = lookup_on_or_before(asset_obj, cur_date)
            if px:
                smart_val += sh * px

        _, sp_px_now = lookup_on_or_before(sp_asset, cur_date)
        sp_val = sp_shares * (sp_px_now or sp_asset["priceEur"])

        smart_curve.append(round(smart_val, 2))
        sp_curve.append(round(sp_val, 2))
        cash_curve.append(round(invested_total, 2))

    final_smart = smart_curve[-1]
    final_sp = sp_curve[-1]
    smart_profit_eur = round(final_smart - invested_total, 2)
    smart_profit_pct = round((smart_profit_eur / invested_total * 100.0) if invested_total else 0.0, 2)
    sp_profit_pct = round(((final_sp - invested_total) / invested_total * 100.0) if invested_total else 0.0, 2)

    return {
        "monthlyBudgetEur": monthly_eur,
        "totalInvestedEur": round(invested_total, 2),
        "finalSmartEur": final_smart,
        "finalSp500Eur": final_sp,
        "smartProfitEur": smart_profit_eur,
        "smartProfitPct": smart_profit_pct,
        "sp500ProfitPct": sp_profit_pct,
        "alphaVsSp500Eur": round(final_smart - final_sp, 2),
        "labels": labels,
        "smartCurve": smart_curve,
        "sp500Curve": sp_curve,
        "cashCurve": cash_curve,
        "recentSimTrades": trade_log[-6:],
    }


def send_telegram_digest(summary: dict[str, Any]) -> bool:
    """Išsiunčia suformatuotą investavimo ataskaitą į Telegram, jei nustatyti aplinkos kintamieji."""
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    app_url = os.environ.get("APP_PUBLIC_URL", "https://banysster-eng.github.io/invest-pulsas/").strip()

    if not token or not chat_id:
        print("Telegram pranešimas praleistas (nenurodyti TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID).")
        return False

    assets = summary["assets"]
    strong_buys = [a for a in assets if a["signal"] == "STRONG_BUY"][:3]
    buys = [a for a in assets if a["signal"] == "BUY_DCA"][:3]
    sells = [a for a in assets if a["signal"] == "TRIM_SELL"][:3]
    plan = summary["allocationPlans"]["balanced"]["items"]

    lines = [
        f"📊 <b>InvestPulsas • Rinkos analizė ({summary['generatedAtLt']})</b>",
        f"Rinkos režimas: <b>{summary['marketOverview']['regimeLabel']}</b> (vid. RSI: {summary['marketOverview']['avgRsi']})",
        "",
    ]

    if strong_buys:
        lines.append("🟢 <b>STIPRUS PIRKIMAS:</b>")
        for a in strong_buys:
            lines.append(
                f"• <b>{a['shortName']}</b> ({a['symbol']}) — <b>{a['priceEur']:.2f} €</b> | Balas: <b>{a['score']}/100</b> | RSI: {a['rsi14']}"
            )
        lines.append("")
    elif buys:
        lines.append("🟢 <b>GERIAUSI KAUPIMO (DCA) VARIANTAI:</b>")
        for a in buys:
            lines.append(
                f"• <b>{a['shortName']}</b> ({a['symbol']}) — <b>{a['priceEur']:.2f} €</b> | Balas: <b>{a['score']}/100</b> | RSI: {a['rsi14']}"
            )
        lines.append("")

    if sells:
        lines.append("🔴 <b>FIKSUOTI PELNĄ / ATSARGIAI:</b>")
        for a in sells:
            lines.append(
                f"• <b>{a['shortName']}</b> ({a['symbol']}) — {a['priceEur']:.2f} € | RSI: {a['rsi14']} ({a['signalLabel']})"
            )
        lines.append("")

    lines.append("💶 <b>Optimalus 100 € krepšelis šiandien:</b>")
    for item in plan:
        lines.append(f"• <b>{item['amountEur']:.0f} €</b> → {item['shortName']} ({item['pct']}%)")

    lines.append("")
    lines.append(f"📱 <a href=\"{app_url}\">Atidaryti InvestPulsas programėlę telefone</a>")

    payload = json.dumps(
        {
            "chat_id": chat_id,
            "text": "\n".join(lines),
            "parse_mode": "HTML",
            "disable_web_page_preview": True,
        }
    ).encode("utf-8")

    url = f"https://api.telegram.org/bot{token}/sendMessage"
    req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"}, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=12) as resp:
            res = json.loads(resp.read().decode("utf-8"))
            if res.get("ok"):
                print("Telegram ataskaita sėkmingai išsiųsta!")
                return True
    except Exception as exc:  # noqa: BLE001
        print(f"Klaida siunčiant Telegram žinutę: {exc}", file=sys.stderr)
    return False


def main() -> int:
    print("Pradedama InvestPulsas rinkos analizė...")
    # 1. Nuskaitome gyvą EUR/USD kursą
    try:
        fx_raw = fetch_yahoo_chart("EURUSD=X", range_str="5d", interval="1d")
        eurusd = float(fx_raw.get("meta", {}).get("regularMarketPrice") or 1.08)
    except Exception as exc:  # noqa: BLE001
        print(f"Įspėjimas: nepavyko gauti EURUSD=X ({exc}), naudojamas 1.08", file=sys.stderr)
        eurusd = 1.08

    print(f"EUR/USD kursas: {eurusd:.4f}")

    # 2. Tolygiai išanalizuojame visus ETF ir akcijas (be agresyvaus srauto piko)
    analyzed_assets: list[dict[str, Any]] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
        future_map = {}
        for cfg in ASSET_UNIVERSE:
            future_map[pool.submit(analyze_single_asset, cfg, eurusd)] = cfg["symbol"]
            time.sleep(0.12)
        for fut in concurrent.futures.as_completed(future_map):
            sym = future_map[fut]
            try:
                res = fut.result()
                analyzed_assets.append(res)
                print(
                    f"  ✓ {sym:10s} | {res['priceEur']:8.2f} € | Balas: {res['score']:2d}/100 | RSI: {res['rsi14']:4.1f} | {res['signalLabel']}"
                )
            except Exception as exc:  # noqa: BLE001
                print(f"  ✗ Klaida analizuojant {sym}: {exc}", file=sys.stderr)

    if not analyzed_assets:
        print("Kritinė klaida: nepavyko išanalizuoti nė vieno aktyvo.", file=sys.stderr)
        return 1

    analyzed_assets.sort(key=lambda x: x["score"], reverse=True)

    # 3. Skaičiuojame 12 mėn. backtestą ir 100 €/mėn. planus
    backtest = run_real_12m_backtest(analyzed_assets, monthly_eur=100.0)
    allocation_plans = build_monthly_allocation_plans(analyzed_assets, budget_eur=100.0)

    # Išvalome vidinius pagalbinius laukus prieš įrašant į JSON
    for a in analyzed_assets:
        for k in list(a.keys()):
            if k.startswith("_full"):
                del a[k]

    avg_rsi = round(statistics.mean(a["rsi14"] for a in analyzed_assets), 1)
    avg_score = round(statistics.mean(a["score"] for a in analyzed_assets), 1)
    above_sma200_pct = round(
        sum(1 for a in analyzed_assets if a["distSma200Pct"] > 0) / len(analyzed_assets) * 100.0
    )

    if above_sma200_pct >= 70 and avg_rsi < 68:
        regime_code = "BULLISH"
        regime_label = "Tvarus augimas (palanku kaupti)"
        regime_advice = (
            "Didžioji dalis rinkos išlieka virš 200 d. vidurkio be ekstremalaus perkaitimo. "
            "Optimalu investuoti mėnesinį 100 € biudžetą derinant ETF branduolį ir lokalias nuolaidas."
        )
    elif avg_rsi >= 68:
        regime_code = "OVERHEATED"
        regime_label = "Padidėjęs perkaitimas (selektyvus pirkimas)"
        regime_advice = (
            "Dalis aktyvų pasiekė aukštą RSI zoną. Venkite vaikytis staigių šuolių – rinkitės vėsesnius ETF "
            "arba fiksuokite dalį pelno perpirktose pozicijose."
        )
    elif above_sma200_pct >= 45:
        regime_code = "NEUTRAL"
        regime_label = "Mišri / konsolidacijos rinka"
        regime_advice = (
            "Rinka juda selektyviai: dalis sektorių koreguojasi ir sukuria gerus įėjimo taškus iki 100 €/mėn. pirkimams."
        )
    else:
        regime_code = "DEFENSIVE"
        regime_label = "Korekcija / išpardavimas (nuolaidų metas)"
        regime_advice = (
            "Rinka patiria platesnį atsitraukimą. Ilgalaikiam investuotojui tai geriausias metas disciplinuotai "
            "supirkinėti kokybiškus ETF pigiau."
        )

    from zoneinfo import ZoneInfo

    now_utc = dt.datetime.now(tz=dt.timezone.utc)
    now_lt = now_utc.astimezone(ZoneInfo("Europe/Vilnius"))

    output = {
        "generatedAtUtc": now_utc.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "generatedAtLt": now_lt.strftime("%Y-%m-%d %H:%M"),
        "eurUsdRate": round(eurusd, 4),
        "defaultMonthlyBudgetEur": 100,
        "marketOverview": {
            "regimeCode": regime_code,
            "regimeLabel": regime_label,
            "regimeAdvice": regime_advice,
            "avgRsi": avg_rsi,
            "avgScore": avg_score,
            "aboveSma200Pct": above_sma200_pct,
            "strongBuyCount": sum(1 for a in analyzed_assets if a["signal"] == "STRONG_BUY"),
            "buyDcaCount": sum(1 for a in analyzed_assets if a["signal"] == "BUY_DCA"),
            "holdCount": sum(1 for a in analyzed_assets if a["signal"] == "HOLD"),
            "sellCount": sum(1 for a in analyzed_assets if a["signal"] == "TRIM_SELL"),
        },
        "allocationPlans": allocation_plans,
        "backtest12m": backtest,
        "assets": analyzed_assets,
    }

    DATA_FILE.parent.mkdir(parents=True, exist_ok=True)
    DATA_FILE.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"\nDuomenys išsaugoti: {DATA_FILE} ({DATA_FILE.stat().st_size / 1024:.1f} KB)")

    if "--notify" in sys.argv:
        send_telegram_digest(output)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
