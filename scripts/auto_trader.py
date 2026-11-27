#!/usr/bin/env python3
"""
InvestPulsas — Tikros ir Demo automatinės prekybos vykdymo modulis (Trading 212 API v0 & Alpaca API v2).

Galimybės:
1. Automatinė prekyba (Autopilotas) iki nustatyto mėnesio limito (numatytasis: max 100 €/mėn.):
   - Automatiškai superka aukščiausio balo ETF ir akcijas, kai signalas STIPRUS PIRKIMAS / PIRKTI.
   - Automatiškai parduoda (fiksuoja pelną arba apsaugo kapitalą), kai turimos pozicijos signalas virsta TRIM_SELL.
2. Rankinis vieno paspaudimo pirkimas / pardavimas iš telefono per GitHub Actions (`--manual`).
3. Saugiai saugo būseną `data/auto_trade_state.json` (be jokių API raktų!) kad telefono PWA rodytų tikrą brokerio balansą, pozicijas ir įvykdytus pavedimus.
"""

from __future__ import annotations

import argparse
import base64
import datetime as dt
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any

ROOT_DIR = Path(__file__).resolve().parent.parent
SIGNALS_FILE = ROOT_DIR / "data" / "market_signals.json"
STATE_FILE = ROOT_DIR / "data" / "auto_trade_state.json"

DEFAULT_T212_TICKERS: dict[str, str] = {
    "AAPL": "AAPL_US_EQ",
    "MSFT": "MSFT_US_EQ",
    "NVDA": "NVDA_US_EQ",
    "GOOGL": "GOOGL_US_EQ",
    "AMZN": "AMZN_US_EQ",
    "META": "META_US_EQ",
    "ASML.AS": "ASMLa_EQ",
    "SAP.DE": "SAPd_EQ",
    "VUAA.DE": "VUAAd_EQ",
    "VWCE.DE": "VWCEd_EQ",
    "QDVE.DE": "QDVEd_EQ",
    "SXRV.DE": "SXRVd_EQ",
    "EUNL.DE": "EUNLd_EQ",
    "IS3N.DE": "IS3Nd_EQ",
    "XDEM.DE": "XDEMd_EQ",
    "4GLD.DE": "4GLDd_EQ",
}


def load_json(path: Path, default: Any) -> Any:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:  # noqa: BLE001
        return default


def http_json(url: str, method: str = "GET", headers: dict[str, str] | None = None, body: Any = None) -> Any:
    req_headers = {"Accept": "application/json", "User-Agent": "InvestPulsas/2.0"}
    if headers:
        req_headers.update(headers)
    data_bytes = None
    if body is not None:
        data_bytes = json.dumps(body).encode("utf-8")
        req_headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data_bytes, headers=req_headers, method=method)
    with urllib.request.urlopen(req, timeout=20) as resp:
        raw = resp.read().decode("utf-8").strip()
        return json.loads(raw) if raw else {}


def send_telegram_alert(text: str) -> None:
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    if not token or not chat_id:
        return
    try:
        http_json(
            f"https://api.telegram.org/bot{token}/sendMessage",
            method="POST",
            body={"chat_id": chat_id, "text": text, "parse_mode": "HTML", "disable_web_page_preview": True},
        )
    except Exception as exc:  # noqa: BLE001
        print(f"Telegram klaida: {exc}", file=sys.stderr)


class Trading212Client:
    def __init__(self, api_key: str, api_secret: str, env_mode: str = "demo") -> None:
        self.env_mode = "live" if env_mode.lower() == "live" else "demo"
        self.base_url = f"https://{self.env_mode}.trading212.com/api/v0"
        if api_secret:
            cred = base64.b64encode(f"{api_key}:{api_secret}".encode("utf-8")).decode("utf-8")
            self.auth_header = f"Basic {cred}"
        else:
            self.auth_header = api_key
        self._instruments_cache: list[dict[str, Any]] | None = None

    def _headers(self) -> dict[str, str]:
        return {"Authorization": self.auth_header}

    def get_summary(self) -> dict[str, Any]:
        return http_json(f"{self.base_url}/equity/account/summary", headers=self._headers())

    def get_positions(self) -> list[dict[str, Any]]:
        res = http_json(f"{self.base_url}/equity/positions", headers=self._headers())
        return res if isinstance(res, list) else []

    def resolve_ticker(self, asset: dict[str, Any]) -> str:
        symbol = asset["symbol"]
        target_isin = asset.get("isin", "")
        if self._instruments_cache is None:
            try:
                res = http_json(f"{self.base_url}/equity/metadata/instruments", headers=self._headers())
                self._instruments_cache = res if isinstance(res, list) else []
            except Exception:  # noqa: BLE001
                self._instruments_cache = []

        if target_isin and self._instruments_cache:
            matches = [it for it in self._instruments_cache if it.get("isin") == target_isin]
            if matches:
                # Pirmenybė EUR biržai UCITS ETF fondams
                eur_match = next((m for m in matches if m.get("currencyCode") == "EUR"), None)
                chosen = eur_match or matches[0]
                if chosen.get("ticker"):
                    return str(chosen["ticker"])

        return DEFAULT_T212_TICKERS.get(symbol, f"{symbol.split('.')[0]}_US_EQ")

    def place_market_order(self, ticker: str, quantity: float) -> dict[str, Any]:
        payload = {
            "extendedHours": False,
            "quantity": round(quantity, 4),
            "ticker": ticker,
        }
        return http_json(
            f"{self.base_url}/equity/orders/market",
            method="POST",
            headers=self._headers(),
            body=payload,
        )


class AlpacaClient:
    def __init__(self, api_key: str, api_secret: str, env_mode: str = "demo") -> None:
        self.env_mode = "live" if env_mode.lower() == "live" else "paper"
        host = "api.alpaca.markets" if self.env_mode == "live" else "paper-api.alpaca.markets"
        self.base_url = f"https://{host}/v2"
        self.headers = {
            "APCA-API-KEY-ID": api_key,
            "APCA-API-SECRET-KEY": api_secret,
        }

    def get_account(self) -> dict[str, Any]:
        return http_json(f"{self.base_url}/account", headers=self.headers)

    def get_positions(self) -> list[dict[str, Any]]:
        res = http_json(f"{self.base_url}/positions", headers=self.headers)
        return res if isinstance(res, list) else []

    def place_notional_order(self, symbol: str, side: str, amount_usd: float) -> dict[str, Any]:
        payload = {
            "symbol": symbol,
            "notional": str(round(amount_usd, 2)),
            "side": side.lower(),
            "type": "market",
            "time_in_force": "day",
        }
        return http_json(f"{self.base_url}/orders", method="POST", headers=self.headers, body=payload)

    def close_position_pct(self, symbol: str, pct: int = 50) -> dict[str, Any]:
        return http_json(
            f"{self.base_url}/positions/{symbol}?percentage={pct}",
            method="DELETE",
            headers=self.headers,
        )


def main() -> int:
    parser = argparse.ArgumentParser(description="InvestPulsas automatinės prekybos vykdiklis")
    parser.add_argument("--mode", choices=["auto", "manual"], default="auto")
    parser.add_argument("--action", choices=["BUY", "SELL"], default="BUY")
    parser.add_argument("--symbol", default="")
    parser.add_argument("--amount-eur", type=float, default=25.0)
    args = parser.parse_args()

    signals_data = load_json(SIGNALS_FILE, {})
    assets: list[dict[str, Any]] = signals_data.get("assets", [])
    eurusd = float(signals_data.get("eurUsdRate") or 1.08)

    now_utc = dt.datetime.now(tz=dt.timezone.utc)
    cur_month = now_utc.strftime("%Y-%m")
    now_lt_str = now_utc.astimezone(dt.timezone(dt.timedelta(hours=2))).strftime("%Y-%m-%d %H:%M")

    max_monthly_eur = float(os.environ.get("MONTHLY_BUDGET_EUR", "100") or 100.0)
    auto_trade_enabled = os.environ.get("AUTO_TRADE_ENABLED", "true").lower() in ("1", "true", "yes", "on")

    t212_key = os.environ.get("T212_API_KEY", "").strip()
    t212_secret = os.environ.get("T212_API_SECRET", "").strip()
    t212_env = os.environ.get("T212_ENV", "demo").strip().lower()

    alpaca_key = os.environ.get("ALPACA_API_KEY", "").strip()
    alpaca_secret = os.environ.get("ALPACA_API_SECRET", "").strip()
    alpaca_env = os.environ.get("ALPACA_ENV", "paper").strip().lower()

    state = load_json(
        STATE_FILE,
        {
            "brokerConnected": False,
            "brokerName": "Neprijungta (naudojamas vidinis programėlės autopilotas)",
            "environment": "virtual",
            "month": cur_month,
            "monthlyCapEur": max_monthly_eur,
            "spentThisMonthEur": 0.0,
            "availableCashEur": 0.0,
            "accountTotalEur": 0.0,
            "positions": [],
            "orderHistory": [],
            "updatedAtLt": now_lt_str,
        },
    )

    if state.get("month") != cur_month:
        state["month"] = cur_month
        state["spentThisMonthEur"] = 0.0

    state["monthlyCapEur"] = max_monthly_eur
    state["updatedAtLt"] = now_lt_str

    if not t212_key and not alpaca_key:
        print("Brokerio API raktai (T212_API_KEY arba ALPACA_API_KEY) dar nenurodyti GitHub Secrets — praleidžiama.")
        STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
        STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
        return 0

    executed_messages: list[str] = []

    try:
        if t212_key:
            client = Trading212Client(t212_key, t212_secret, t212_env)
            summary = client.get_summary()
            cash_info = summary.get("cash", {}) if isinstance(summary.get("cash"), dict) else {}
            free_cash = float(cash_info.get("availableToTrade", summary.get("free", 0.0)) or 0.0)
            total_val = float(summary.get("totalValue", summary.get("total", free_cash)) or free_cash)

            state["brokerConnected"] = True
            state["brokerName"] = f"Trading 212 ({'Realus' if client.env_mode == 'live' else 'Demo Practice'})"
            state["environment"] = client.env_mode
            state["availableCashEur"] = round(free_cash, 2)
            state["accountTotalEur"] = round(total_val, 2)

            if args.mode == "manual" and args.symbol:
                asset = next((a for a in assets if a["symbol"].upper() == args.symbol.upper()), {"symbol": args.symbol})
                t212_ticker = client.resolve_ticker(asset)
                px_eur = float(asset.get("priceEur") or 100.0)
                qty = round(args.amount_eur / px_eur, 4)
                if args.action == "SELL":
                    qty = -abs(qty)
                if abs(qty) > 0:
                    client.place_market_order(t212_ticker, qty)
                    if args.action == "BUY":
                        state["spentThisMonthEur"] = round(state["spentThisMonthEur"] + args.amount_eur, 2)
                    msg = f"{args.action}: {args.symbol} ({t212_ticker}) ~{args.amount_eur:.2f} € ({qty} vnt.)"
                    executed_messages.append(msg)
                    state["orderHistory"].insert(0, {"ts": now_lt_str, "broker": state["brokerName"], "detail": msg})

            elif args.mode == "auto" and auto_trade_enabled:
                # 1. Patikriname turimas pozicijas dėl pardavimo signalo
                raw_positions = client.get_positions()
                for p in raw_positions:
                    p_ticker = str(p.get("ticker", ""))
                    p_qty = float(p.get("quantity") or 0.0)
                    if p_qty <= 0:
                        continue
                    matched_asset = next(
                        (a for a in assets if DEFAULT_T212_TICKERS.get(a["symbol"]) == p_ticker),
                        None,
                    )
                    if matched_asset and matched_asset.get("signal") == "TRIM_SELL":
                        sell_qty = -round(p_qty * 0.5, 4)
                        if abs(sell_qty) >= 0.001:
                            client.place_market_order(p_ticker, sell_qty)
                            msg = f"AUTO PARDAVIMAS (50%): {matched_asset['shortName']} ({sell_qty} vnt.) dėl {matched_asset['signalLabel']}"
                            executed_messages.append(msg)
                            state["orderHistory"].insert(0, {"ts": now_lt_str, "broker": state["brokerName"], "detail": msg})
                            time.sleep(1.3)

                # 2. Automatinis mėnesio pirkimas iki 100 € limito
                remaining_cap = max(0.0, max_monthly_eur - float(state.get("spentThisMonthEur", 0.0)))
                deployable_eur = min(remaining_cap, free_cash)
                if deployable_eur >= 10.0:
                    plan_items = signals_data.get("allocationPlans", {}).get("balanced", {}).get("items", [])
                    for item in plan_items:
                        leg_eur = round(deployable_eur * (float(item["pct"]) / 100.0), 2)
                        if leg_eur < 2.0:
                            continue
                        asset_obj = next((a for a in assets if a["symbol"] == item["symbol"]), item)
                        t212_ticker = client.resolve_ticker(asset_obj)
                        qty = round(leg_eur / float(asset_obj["priceEur"]), 4)
                        if qty <= 0:
                            continue
                        client.place_market_order(t212_ticker, qty)
                        state["spentThisMonthEur"] = round(state["spentThisMonthEur"] + leg_eur, 2)
                        msg = f"AUTO PIRKIMAS: {item['shortName']} ({t212_ticker}) už ~{leg_eur:.2f} € ({qty} vnt.)"
                        executed_messages.append(msg)
                        state["orderHistory"].insert(0, {"ts": now_lt_str, "broker": state["brokerName"], "detail": msg})
                        time.sleep(1.3)

            # Atnaujiname pozicijų sąrašą po pavedimų
            refreshed_pos = client.get_positions()
            state["positions"] = [
                {
                    "ticker": p.get("ticker"),
                    "quantity": p.get("quantity"),
                    "averagePrice": p.get("averagePrice"),
                    "currentPrice": p.get("currentPrice"),
                    "ppl": p.get("ppl"),
                }
                for p in refreshed_pos[:30]
            ]

        elif alpaca_key:
            alp = AlpacaClient(alpaca_key, alpaca_secret, alpaca_env)
            acct = alp.get_account()
            cash_usd = float(acct.get("cash") or 0.0)
            eq_usd = float(acct.get("equity") or cash_usd)
            free_eur = cash_usd / eurusd

            state["brokerConnected"] = True
            state["brokerName"] = f"Alpaca ({'Realus' if alp.env_mode == 'live' else 'Paper Demo'})"
            state["environment"] = alp.env_mode
            state["availableCashEur"] = round(free_eur, 2)
            state["accountTotalEur"] = round(eq_usd / eurusd, 2)

            if args.mode == "manual" and args.symbol:
                asset = next((a for a in assets if a["symbol"].upper() == args.symbol.upper()), {"symbol": args.symbol})
                alp_sym = str(asset.get("alpacaSymbol") or args.symbol.split(".")[0])
                amt_usd = round(args.amount_eur * eurusd, 2)
                alp.place_notional_order(alp_sym, args.action, amt_usd)
                if args.action == "BUY":
                    state["spentThisMonthEur"] = round(state["spentThisMonthEur"] + args.amount_eur, 2)
                msg = f"{args.action}: {alp_sym} už {args.amount_eur:.2f} € (${amt_usd:.2f})"
                executed_messages.append(msg)
                state["orderHistory"].insert(0, {"ts": now_lt_str, "broker": state["brokerName"], "detail": msg})

            elif args.mode == "auto" and auto_trade_enabled:
                remaining_cap = max(0.0, max_monthly_eur - float(state.get("spentThisMonthEur", 0.0)))
                deployable_eur = min(remaining_cap, free_eur)
                if deployable_eur >= 10.0:
                    plan_items = signals_data.get("allocationPlans", {}).get("balanced", {}).get("items", [])
                    for item in plan_items:
                        leg_eur = round(deployable_eur * (float(item["pct"]) / 100.0), 2)
                        if leg_eur < 2.0:
                            continue
                        asset_obj = next((a for a in assets if a["symbol"] == item["symbol"]), item)
                        alp_sym = str(asset_obj.get("alpacaSymbol") or item["symbol"].split(".")[0])
                        amt_usd = round(leg_eur * eurusd, 2)
                        alp.place_notional_order(alp_sym, "BUY", amt_usd)
                        state["spentThisMonthEur"] = round(state["spentThisMonthEur"] + leg_eur, 2)
                        msg = f"AUTO PIRKIMAS: {alp_sym} už {leg_eur:.2f} € (${amt_usd:.2f})"
                        executed_messages.append(msg)
                        state["orderHistory"].insert(0, {"ts": now_lt_str, "broker": state["brokerName"], "detail": msg})

            refreshed_pos = alp.get_positions()
            state["positions"] = [
                {
                    "ticker": p.get("symbol"),
                    "quantity": float(p.get("qty") or 0),
                    "averagePrice": round(float(p.get("avg_entry_price") or 0) / eurusd, 2),
                    "currentPrice": round(float(p.get("current_price") or 0) / eurusd, 2),
                    "ppl": round(float(p.get("unrealized_pl") or 0) / eurusd, 2),
                }
                for p in refreshed_pos[:30]
            ]

    except urllib.error.HTTPError as http_err:
        err_body = http_err.read().decode("utf-8", errors="replace")[:250]
        print(f"Brokerio HTTP klaida ({http_err.code}): {err_body}", file=sys.stderr)
        state["lastError"] = f"HTTP {http_err.code}: {err_body}"
    except Exception as exc:  # noqa: BLE001
        print(f"Brokerio vykdymo klaida: {exc}", file=sys.stderr)
        state["lastError"] = str(exc)

    state["orderHistory"] = state.get("orderHistory", [])[:30]
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")

    if executed_messages:
        tg_lines = [
            f"🤖 <b>InvestPulsas • Automatinė prekyba ({state['brokerName']})</b>",
            *[f"• {m}" for m in executed_messages],
            f"",
            f"Šį mėnesį panaudota: <b>{state['spentThisMonthEur']:.2f} € / {max_monthly_eur:.0f} €</b>",
        ]
        send_telegram_alert("\n".join(tg_lines))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
