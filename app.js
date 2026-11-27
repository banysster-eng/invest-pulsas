/* InvestPulsas v3.10 — Supaprastinta, vieninga ir patikrinta investavimo PWA programa */
(function () {
  'use strict';

  const REPO_OWNER = 'banysster-eng';
  const REPO_NAME = 'invest-pulsas';

  const STORAGE_KEYS = {
    THEME: 'investpulsas_theme',
    STATE_V3: 'investpulsas_unified_v3',
  };

  const state = {
    marketData: null,
    cloudBrokerState: null,
    activeView: 'signals',
    signalFilter: 'TOP',
    searchQuery: '',
    autopilotEnabled: true,
    lastAutoMonth: '',
    portfolio: [], // Vieningas portfelis: [{ symbol, shortName, shares, avgPriceEur, investedEur, source }]
    spentLog: {}, // { 'YYYY-MM': eurNumber }
    activityLog: [], // [{ ts, type, text }]
    settings: {
      monthlyCapEur: 100,
      tgToken: '',
      tgChatId: '',
      ghDispatchToken: '',
      alpacaKey: '',
      alpacaSecret: '',
      alpacaEnv: 'paper',
    },
    customSymbols: [],
    deferredInstallPrompt: null,
  };

  // --- Saugios formatavimo funkcijos ---
  function safeNum(val, fallback = 0) {
    const n = Number(val);
    return Number.isFinite(n) ? n : fallback;
  }

  function fmtEur(val) {
    const n = safeNum(val, 0);
    return n.toLocaleString('lt-LT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  }

  function fmtPct(val, withSign = true) {
    const n = safeNum(val, 0);
    const sign = withSign && n > 0 ? '+' : '';
    return sign + n.toLocaleString('lt-LT', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' %';
  }

  function currentYearMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function nowShortLt() {
    return new Date().toLocaleString('lt-LT', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  }

  function showToast(msg) {
    const el = document.getElementById('app-toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => el.classList.remove('show'), 3400);
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function signalBadgeClass(sig) {
    if (sig === 'STRONG_BUY') return 'badge-buy';
    if (sig === 'BUY_DCA') return 'badge-dca';
    if (sig === 'TRIM_SELL') return 'badge-sell';
    return 'badge-hold';
  }

  // --- Saugyklos įkėlimas ir migracija iš v1/v2 ---
  function loadLocalState() {
    try {
      const savedTheme = localStorage.getItem(STORAGE_KEYS.THEME) || 'dark';
      applyTheme(savedTheme === 'light' ? 'light' : 'dark');

      const v3Raw = localStorage.getItem(STORAGE_KEYS.STATE_V3);
      if (v3Raw) {
        const parsed = JSON.parse(v3Raw);
        if (Array.isArray(parsed.portfolio)) state.portfolio = parsed.portfolio.filter((p) => safeNum(p.shares) > 0.00001);
        if (parsed.spentLog && typeof parsed.spentLog === 'object') state.spentLog = parsed.spentLog;
        if (Array.isArray(parsed.activityLog)) state.activityLog = parsed.activityLog;
        if (typeof parsed.autopilotEnabled === 'boolean') state.autopilotEnabled = parsed.autopilotEnabled;
        if (typeof parsed.lastAutoMonth === 'string') state.lastAutoMonth = parsed.lastAutoMonth;
        if (parsed.settings && typeof parsed.settings === 'object') {
          state.settings = { ...state.settings, ...parsed.settings };
        }
        if (Array.isArray(parsed.customSymbols)) state.customSymbols = parsed.customSymbols;
        return;
      }

      // Sklandi migracija iš ankstesnės versijos, jei vartotojas jau buvo atsidaręs programėlę
      const oldPf = JSON.parse(localStorage.getItem('investpulsas_portfolio_v1') || '[]');
      const oldSet = JSON.parse(localStorage.getItem('investpulsas_settings_v2') || localStorage.getItem('investpulsas_settings_v1') || 'null');
      const oldSpent = JSON.parse(localStorage.getItem('investpulsas_monthly_spent_v1') || '{}');
      const oldCustom = JSON.parse(localStorage.getItem('investpulsas_custom_assets_v1') || '[]');

      if (Array.isArray(oldPf) && oldPf.length > 0) {
        state.portfolio = oldPf.filter((p) => safeNum(p.shares) > 0.00001);
      }
      if (oldSet && typeof oldSet === 'object') {
        state.settings = { ...state.settings, ...oldSet };
      }
      if (oldSpent && typeof oldSpent === 'object') {
        state.spentLog = oldSpent;
      }
      if (Array.isArray(oldCustom)) {
        state.customSymbols = oldCustom;
      }
      saveLocalState();
    } catch (err) {
      console.warn('Saugyklos nuskaitymo klaida:', err);
    }
  }

  function saveLocalState() {
    try {
      const payload = {
        autopilotEnabled: state.autopilotEnabled,
        lastAutoMonth: state.lastAutoMonth,
        portfolio: state.portfolio,
        spentLog: state.spentLog,
        activityLog: state.activityLog.slice(0, 30),
        settings: state.settings,
        customSymbols: state.customSymbols,
      };
      localStorage.setItem(STORAGE_KEYS.STATE_V3, JSON.stringify(payload));
    } catch (err) {
      console.warn('Saugyklos įrašymo klaida:', err);
    }
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(STORAGE_KEYS.THEME, theme);
    const meta = document.getElementById('meta-theme-color');
    if (meta) meta.setAttribute('content', theme === 'light' ? '#f5f2eb' : '#0d1217');
  }

  function getMonthlyCap() {
    return Math.max(10, safeNum(state.settings.monthlyCapEur, 100));
  }

  function getSpentThisMonth() {
    const ym = currentYearMonth();
    const localSpent = safeNum(state.spentLog[ym], 0);
    const cloudSpent = state.cloudBrokerState?.month === ym ? safeNum(state.cloudBrokerState.spentThisMonthEur, 0) : 0;
    return Math.max(localSpent, cloudSpent);
  }

  function getRemainingBudget() {
    return Math.max(0, Number((getMonthlyCap() - getSpentThisMonth()).toFixed(2)));
  }

  // --- Brokerių API pagalbinės funkcijos ---
  function hasAlpacaDirect() {
    return Boolean(state.settings.alpacaKey?.trim() && state.settings.alpacaSecret?.trim());
  }

  function alpacaBaseUrl() {
    return state.settings.alpacaEnv === 'live'
      ? 'https://api.alpaca.markets/v2'
      : 'https://paper-api.alpaca.markets/v2';
  }

  async function testAndLoadAlpacaAccount(silent = false) {
    if (!hasAlpacaDirect()) return null;
    const statusEl = document.getElementById('alpaca-status-msg');
    try {
      const res = await fetch(`${alpacaBaseUrl()}/account`, {
        headers: {
          'APCA-API-KEY-ID': state.settings.alpacaKey.trim(),
          'APCA-API-SECRET-KEY': state.settings.alpacaSecret.trim(),
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const acct = await res.json();
      const eurusd = safeNum(state.marketData?.eurUsdRate, 1.09);
      const cashEur = safeNum(acct.cash, 0) / eurusd;
      if (statusEl) {
        statusEl.innerHTML = `✅ Prijungta (${state.settings.alpacaEnv === 'live' ? 'Tikri pinigai' : 'Demo'}): laisva <strong>${fmtEur(cashEur)}</strong>`;
      }
      if (!silent) showToast(`Alpaca prijungta! Laisva: ${fmtEur(cashEur)}`);
      renderControlCard();
      return acct;
    } catch (err) {
      if (statusEl) statusEl.textContent = `❌ Nepavyko prisijungti (${err.message}). Patikrinkite raktus.`;
      if (!silent) showToast(`Alpaca klaida: ${err.message}`);
      return null;
    }
  }

  async function sendExternalBrokerOrderIfConfigured(asset, side, amountEur) {
    if (hasAlpacaDirect()) {
      const eurusd = safeNum(state.marketData?.eurUsdRate, 1.09);
      const alpSym = asset.alpacaSymbol || asset.symbol.split('.')[0];
      const usdAmount = Math.max(1, amountEur * eurusd).toFixed(2);
      const res = await fetch(`${alpacaBaseUrl()}/orders`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'APCA-API-KEY-ID': state.settings.alpacaKey.trim(),
          'APCA-API-SECRET-KEY': state.settings.alpacaSecret.trim(),
        },
        body: JSON.stringify({
          symbol: alpSym,
          notional: usdAmount,
          side: side.toLowerCase(),
          type: 'market',
          time_in_force: 'day',
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.message || `Alpaca HTTP ${res.status}`);
      return `Alpaca (${alpSym})`;
    }

    const ghToken = (state.settings.ghDispatchToken || '').trim();
    if (ghToken) {
      const url = `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/actions/workflows/execute-order.yml/dispatches`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${ghToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ref: 'main',
          inputs: {
            action: side.toUpperCase(),
            symbol: asset.symbol,
            amount_eur: String(Number(amountEur.toFixed(2))),
          },
        }),
      });
      if (!res.ok) throw new Error(`GitHub Actions HTTP ${res.status}`);
      return 'Trading 212';
    }

    return '';
  }

  // --- Vieningas Pirkimo ir Pardavimo vykdymas ---
  function recordBuyInternal(asset, amountEur, sourceLabel = 'Pirkimas') {
    const cleanEur = Number(Math.max(0.01, safeNum(amountEur)).toFixed(2));
    const px = Math.max(0.01, safeNum(asset.priceEur, 1));
    const shares = cleanEur / px;

    const existing = state.portfolio.find((p) => p.symbol === asset.symbol);
    if (existing) {
      const newInv = safeNum(existing.investedEur) + cleanEur;
      const newSh = safeNum(existing.shares) + shares;
      existing.investedEur = Number(newInv.toFixed(2));
      existing.shares = newSh;
      existing.avgPriceEur = Number((newInv / newSh).toFixed(2));
    } else {
      state.portfolio.push({
        symbol: asset.symbol,
        shortName: asset.shortName,
        shares,
        avgPriceEur: Number(px.toFixed(2)),
        investedEur: cleanEur,
      });
    }

    const ym = currentYearMonth();
    state.spentLog[ym] = Number((safeNum(state.spentLog[ym], 0) + cleanEur).toFixed(2));
    state.activityLog.unshift({
      ts: nowShortLt(),
      type: 'BUY',
      text: `${sourceLabel}: ${asset.shortName} už ${fmtEur(cleanEur)} (@ ${fmtEur(px)})`,
    });
  }

  function recordSellInternal(asset, sellPct, sourceLabel = 'Pardavimas') {
    const pos = state.portfolio.find((p) => p.symbol === asset.symbol);
    if (!pos) return 0;
    const pct = Math.min(100, Math.max(1, safeNum(sellPct, 100)));
    const curPx = Math.max(0.01, safeNum(asset.priceEur, pos.avgPriceEur));
    const sellShares = pos.shares * (pct / 100);
    const proceedsEur = Number((sellShares * curPx).toFixed(2));
    const costBasisEur = pos.investedEur * (pct / 100);
    const profitEur = Number((proceedsEur - costBasisEur).toFixed(2));

    if (pct >= 99.5 || pos.shares - sellShares <= 0.00005) {
      state.portfolio = state.portfolio.filter((p) => p.symbol !== asset.symbol);
    } else {
      pos.shares -= sellShares;
      pos.investedEur = Number(Math.max(0.01, pos.investedEur - costBasisEur).toFixed(2));
    }

    const pnlSign = profitEur >= 0 ? '+' : '';
    state.activityLog.unshift({
      ts: nowShortLt(),
      type: 'SELL',
      text: `${sourceLabel} (${pct}%): ${asset.shortName} už ${fmtEur(proceedsEur)} (${pnlSign}${fmtEur(profitEur)})`,
    });
    return proceedsEur;
  }

  async function executeBuy(symbol, amountEur, sourceLabel = 'Pirkimas') {
    const asset = state.marketData?.assets?.find((a) => a.symbol === symbol);
    if (!asset) return false;
    const cleanEur = Number(safeNum(amountEur, 0).toFixed(2));
    if (cleanEur < 1) {
      showToast('Minimali pirkimo suma yra 1,00 €');
      return false;
    }

    let brokerNote = '';
    try {
      const via = await sendExternalBrokerOrderIfConfigured(asset, 'BUY', cleanEur);
      if (via) brokerNote = ` (${via})`;
    } catch (err) {
      showToast(`Brokerio klaida: ${err.message}`);
      return false;
    }

    recordBuyInternal(asset, cleanEur, sourceLabel + brokerNote);
    saveLocalState();
    renderAll();
    showToast(`✅ Nupirkta: ${asset.shortName} už ${fmtEur(cleanEur)}${brokerNote}`);
    return true;
  }

  async function executeSellPct(symbol, sellPct, sourceLabel = 'Pardavimas') {
    const asset = state.marketData?.assets?.find((a) => a.symbol === symbol);
    const pos = state.portfolio.find((p) => p.symbol === symbol);
    if (!pos) return false;
    const fallbackAsset = asset || { symbol: pos.symbol, shortName: pos.shortName, priceEur: pos.avgPriceEur };
    const estEur = Number((pos.shares * fallbackAsset.priceEur * (sellPct / 100)).toFixed(2));

    let brokerNote = '';
    try {
      const via = await sendExternalBrokerOrderIfConfigured(fallbackAsset, 'SELL', Math.max(1, estEur));
      if (via) brokerNote = ` (${via})`;
    } catch (err) {
      showToast(`Brokerio klaida: ${err.message}`);
      return false;
    }

    const proceeds = recordSellInternal(fallbackAsset, sellPct, sourceLabel + brokerNote);
    saveLocalState();
    renderAll();
    showToast(`✅ Parduota ${sellPct}% ${fallbackAsset.shortName} (${fmtEur(proceeds)})${brokerNote}`);
    return true;
  }

  // --- Automatinis pirkimas ir pardavimas (Autopilotas) ---
  async function runAutopilotSmartCycle(isAutomaticOnLoad = false) {
    if (!state.marketData?.assets?.length) return;
    const ym = currentYearMonth();
    const assets = state.marketData.assets;
    let didSomething = false;

    // 1. Automatinis pelno fiksavimas / apsauga turimoms pozicijoms, jei signalas TRIM_SELL arba RSI >= 74
    for (const pos of [...state.portfolio]) {
      const live = assets.find((a) => a.symbol === pos.symbol);
      if (!live) continue;
      const pnlPct = pos.avgPriceEur > 0 ? ((live.priceEur - pos.avgPriceEur) / pos.avgPriceEur) * 100 : 0;
      if (live.signal === 'TRIM_SELL' || live.rsi14 >= 74 || pnlPct >= 25) {
        await executeSellPct(pos.symbol, 50, 'Auto-pardavimas');
        didSomething = true;
      }
    }

    // 2. Automatinis mėnesio likučio įdarbinimas (griežtai neviršijant mėnesio 100 € limito!)
    const rem = getRemainingBudget();
    if (rem >= 5) {
      const plan = state.marketData.allocationPlans?.balanced?.items || [];
      if (plan.length > 0) {
        let allocatedSoFar = 0;
        for (let i = 0; i < plan.length; i++) {
          const item = plan[i];
          const legEur =
            i === plan.length - 1
              ? Number((rem - allocatedSoFar).toFixed(2))
              : Number(((rem * item.pct) / 100).toFixed(2));
          if (legEur >= 1) {
            const assetObj = assets.find((a) => a.symbol === item.symbol);
            if (assetObj) {
              await executeBuy(assetObj.symbol, legEur, 'Autopilotas');
              allocatedSoFar += legEur;
              didSomething = true;
            }
          }
        }
      }
      state.lastAutoMonth = ym;
      saveLocalState();
      renderAll();
      if (!isAutomaticOnLoad && didSomething) {
        showToast(`⚡ Autopilotas automatiškai paskirstė ${fmtEur(rem)} į geriausius aktyvus!`);
      }
      return;
    }

    if (!isAutomaticOnLoad && !didSomething) {
      showToast(`Šio mėnesio ${getMonthlyCap()} € limitas jau pilnai investuotas! Sekami pardavimo signalai.`);
    }
  }

  // --- Duomenų įkėlimas ---
  async function loadMarketData() {
    try {
      const [sigRes, cloudRes] = await Promise.all([
        fetch(`./data/market_signals.json?t=${Date.now()}`, { cache: 'no-store' }),
        fetch(`./data/auto_trade_state.json?t=${Date.now()}`, { cache: 'no-store' }).catch(() => null),
      ]);

      if (!sigRes.ok) throw new Error(`HTTP ${sigRes.status}`);
      state.marketData = await sigRes.json();

      if (cloudRes && cloudRes.ok) {
        state.cloudBrokerState = await cloudRes.json();
      }

      if (state.customSymbols.length > 0) {
        for (const cAsset of state.customSymbols) {
          if (!state.marketData.assets.some((a) => a.symbol === cAsset.symbol)) {
            state.marketData.assets.push(cAsset);
          }
        }
        state.marketData.assets.sort((a, b) => b.score - a.score);
      }

      // Jei Autopilotas įjungtas ir šį mėnesį dar nebuvo investuota nė euro — automatiškai įdarbiname mėnesio biudžetą!
      const ym = currentYearMonth();
      if (state.autopilotEnabled && state.lastAutoMonth !== ym && getSpentThisMonth() === 0) {
        await runAutopilotSmartCycle(true);
      }

      if (hasAlpacaDirect()) {
        testAndLoadAlpacaAccount(true);
      }

      renderAll();
    } catch (err) {
      console.error('Duomenų įkėlimo klaida:', err);
      const lbl = document.getElementById('last-updated-label');
      if (lbl) lbl.textContent = 'Nepavyko įkelti duomenų';
    }
  }

  // --- Atvaizdavimas (Render) ---
  function renderAll() {
    if (!state.marketData) return;
    document.getElementById('last-updated-label').textContent = `Atnaujinta ${state.marketData.generatedAtLt}`;
    renderControlCard();
    renderSellAlertsBanner();
    renderSignals();
    renderPortfolio();
    syncSettingsInputs();
  }

  function renderControlCard() {
    const toggle = document.getElementById('toggle-autopilot');
    const badge = document.getElementById('autopilot-status-badge');
    const desc = document.getElementById('autopilot-status-desc');
    const spent = getSpentThisMonth();
    const cap = getMonthlyCap();
    const rem = getRemainingBudget();
    const pct = Math.min(100, Math.round((spent / cap) * 100));

    toggle.checked = state.autopilotEnabled;

    if (state.cloudBrokerState?.brokerConnected) {
      badge.textContent = state.cloudBrokerState.brokerName.toUpperCase();
      badge.className = 'badge badge-buy';
    } else if (hasAlpacaDirect()) {
      badge.textContent = `ALPACA (${state.settings.alpacaEnv === 'live' ? 'REALUS' : 'DEMO'})`;
      badge.className = 'badge badge-buy';
    } else if (state.autopilotEnabled) {
      badge.textContent = 'ĮJUNGTA';
      badge.className = 'badge badge-buy';
    } else {
      badge.textContent = 'IŠJUNGTA';
      badge.className = 'badge badge-hold';
    }

    desc.textContent = state.autopilotEnabled
      ? `Autopilotas aktyvus (iki ${cap} €/mėn.) — superka aukščiausio įvertinimo aktyvus ir stebi, kada parduoti.`
      : 'Autopilotas išjungtas — spauskite „Pirkti“ ant bet kurios kortelės rankiniam pirkimui.';

    document.getElementById('month-spent-label').textContent = fmtEur(spent);
    document.getElementById('month-cap-label').textContent = `${cap} €`;
    document.getElementById('month-rem-label').textContent = rem > 0 ? `Liko ${fmtEur(rem)}` : 'Limitas pasiektas';

    const fill = document.getElementById('month-progress-fill');
    fill.style.width = `${pct}%`;
    fill.className = 'progress-fill' + (pct >= 100 ? ' over' : pct >= 80 ? ' warn' : '');

    const autoBtn = document.getElementById('btn-auto-invest-remaining');
    autoBtn.textContent = rem >= 5 ? `⚡ Paskirstyti likusius ${fmtEur(rem)}` : `✓ Šio mėn. ${cap} € jau įdarbinti`;

    document.getElementById('shortcut-pf-count').textContent = String(state.portfolio.length);
  }

  function renderSellAlertsBanner() {
    const banner = document.getElementById('sell-alert-banner');
    const container = document.getElementById('sell-alert-items');
    if (!state.portfolio.length) {
      banner.style.display = 'none';
      return;
    }

    const toSell = [];
    for (const pos of state.portfolio) {
      const live = state.marketData.assets.find((a) => a.symbol === pos.symbol);
      if (!live) continue;
      const pnlPct = pos.avgPriceEur > 0 ? ((live.priceEur - pos.avgPriceEur) / pos.avgPriceEur) * 100 : 0;
      if (live.signal === 'TRIM_SELL' || live.rsi14 >= 74 || pnlPct >= 22) {
        toSell.push({ pos, live, pnlPct });
      }
    }

    if (!toSell.length) {
      banner.style.display = 'none';
      return;
    }

    banner.style.display = 'block';
    container.innerHTML = toSell
      .map(
        ({ pos, live, pnlPct }) => `
        <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 6px 0;">
          <span style="font-size: 0.83rem;"><strong>${escapeHtml(pos.shortName)}</strong> (${fmtPct(pnlPct)}) — ${escapeHtml(live.simpleVerdict || live.signalLabel)}</span>
          <button type="button" class="btn-sell-sm" data-order-side="SELL" data-order-symbol="${escapeHtml(pos.symbol)}">Parduoti</button>
        </div>
      `
      )
      .join('');
  }

  function renderSignals() {
    const listEl = document.getElementById('signals-list');
    if (!listEl || !state.marketData) return;

    const allBtn = document.querySelector('#filter-chips [data-filter="ALL"]');
    if (allBtn) allBtn.textContent = `Visi (${state.marketData.assets.length})`;

    const q = state.searchQuery.trim().toLowerCase();
    const filtered = state.marketData.assets.filter((a) => {
      if (state.signalFilter === 'TOP' && a.signal !== 'STRONG_BUY' && a.signal !== 'BUY_DCA') return false;
      if (state.signalFilter === 'ETF' && a.category !== 'ETF') return false;
      if (state.signalFilter === 'SELL' && a.signal !== 'TRIM_SELL') return false;
      if (q) {
        const hay = `${a.symbol} ${a.name} ${a.shortName} ${a.subCategory}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    if (!filtered.length) {
      listEl.innerHTML = `<div class="surface" style="text-align: center; color: var(--text-secondary); font-size: 0.88rem;">Pagal pasirinktą filtrą pasiūlymų nerasta.</div>`;
      return;
    }

    listEl.innerHTML = filtered
      .map((asset) => {
        const owned = state.portfolio.find((p) => p.symbol === asset.symbol);
        const ownedVal = owned ? owned.shares * asset.priceEur : 0;
        const chgClass = asset.change1m >= 0 ? 'pos' : 'neg';
        const verdict = asset.simpleVerdict || asset.reasons?.[0] || asset.thesis;

        return `
          <article class="asset-card">
            <div class="asset-top">
              <div class="asset-id">
                <div class="asset-title-row">
                  <span class="asset-name">${escapeHtml(asset.shortName)}</span>
                  <span class="asset-ticker">${escapeHtml(asset.symbol)}</span>
                  <span class="badge ${signalBadgeClass(asset.signal)}">${escapeHtml(asset.signalLabel)}</span>
                </div>
                <div style="font-size: 0.75rem; color: var(--text-muted); margin-top: 2px;">
                  ${escapeHtml(asset.category)} • Įvertinimas: <strong class="mono" style="color: var(--text-primary);">${asset.score}/100</strong>
                  ${owned ? ` • <strong style="color: var(--emerald);">Turite ${fmtEur(ownedVal)}</strong>` : ''}
                </div>
              </div>
              <div class="asset-price-col">
                <div class="asset-price">${fmtEur(asset.priceEur)}</div>
                <div class="asset-chg ${chgClass}">1 mėn. ${fmtPct(asset.change1m)}</div>
              </div>
            </div>

            <p class="asset-verdict">${escapeHtml(verdict)}</p>

            <div class="card-actions-bar">
              <button type="button" class="btn-chart-sm" data-chart-symbol="${escapeHtml(asset.symbol)}">Detaliau / Grafikas</button>
              <div class="card-action-btns">
                ${owned ? `<button type="button" class="btn-sell-sm" data-order-side="SELL" data-order-symbol="${escapeHtml(asset.symbol)}">Parduoti</button>` : ''}
                <button type="button" class="btn-buy-sm" data-order-side="BUY" data-order-symbol="${escapeHtml(asset.symbol)}">⚡ Pirkti</button>
              </div>
            </div>
          </article>
        `;
      })
      .join('');
  }

  function renderPortfolio() {
    const cloudBanner = document.getElementById('cloud-broker-banner');
    if (cloudBanner) {
      if (state.cloudBrokerState?.brokerConnected) {
        cloudBanner.style.display = 'block';
        cloudBanner.innerHTML = `
          <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px;">
            <strong>🏦 ${escapeHtml(state.cloudBrokerState.brokerName)}</strong>
            <span class="badge badge-buy">Laisva: ${fmtEur(state.cloudBrokerState.availableCashEur)}</span>
          </div>
        `;
      } else {
        cloudBanner.style.display = 'none';
      }
    }

    let totalInvested = 0;
    let totalCurrent = 0;
    const holdEl = document.getElementById('pf-holdings-container');

    if (!state.portfolio.length) {
      holdEl.innerHTML = `<p style="color: var(--text-secondary); font-size: 0.86rem; margin: 6px 0;">Portfelis tuščias. Eikite į „Pasiūlymai“ ir paspauskite <strong>„⚡ Pirkti“</strong> arba įjunkite Autopilotą.</p>`;
    } else {
      holdEl.innerHTML = state.portfolio
        .map((pos) => {
          const live = state.marketData?.assets?.find((a) => a.symbol === pos.symbol);
          const curPx = live ? live.priceEur : pos.avgPriceEur;
          const curVal = pos.shares * curPx;
          const pnlEur = curVal - pos.investedEur;
          const pnlPct = pos.investedEur > 0 ? (pnlEur / pos.investedEur) * 100 : 0;

          totalInvested += pos.investedEur;
          totalCurrent += curVal;

          const shouldSell = live && (live.signal === 'TRIM_SELL' || live.rsi14 >= 74 || pnlPct >= 22);
          const badgeHtml = shouldSell
            ? `<span class="badge badge-sell">PARDUOTI</span>`
            : `<span class="badge badge-hold">LAIKYTI</span>`;

          return `
            <div class="holding-row">
              <div style="min-width: 0;">
                <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                  <strong style="cursor: pointer;" data-chart-symbol="${escapeHtml(pos.symbol)}">${escapeHtml(pos.shortName)}</strong>
                  <span class="asset-ticker">${escapeHtml(pos.symbol)}</span>
                  ${badgeHtml}
                </div>
                <div class="mono" style="font-size: 0.74rem; color: var(--text-secondary); margin-top: 3px;">
                  Investuota ${fmtEur(pos.investedEur)} • Dabar ${fmtEur(curPx)}/vnt.
                </div>
              </div>
              <div style="text-align: right; flex-shrink: 0;">
                <div class="mono" style="font-weight: 700;">${fmtEur(curVal)}</div>
                <div class="mono ${pnlEur >= 0 ? 'pos' : 'neg'}" style="font-size: 0.75rem;">
                  ${pnlEur >= 0 ? '+' : ''}${fmtEur(pnlEur)} (${fmtPct(pnlPct)})
                </div>
                <div style="display: flex; gap: 6px; justify-content: flex-end; margin-top: 6px;">
                  <button type="button" class="btn-buy-sm" style="min-height: 34px; padding: 0 10px; font-size: 0.75rem;" data-order-side="BUY" data-order-symbol="${escapeHtml(pos.symbol)}">+ Pirkti</button>
                  <button type="button" class="btn-sell-sm" style="min-height: 34px; padding: 0 10px; font-size: 0.75rem;" data-order-side="SELL" data-order-symbol="${escapeHtml(pos.symbol)}">Parduoti</button>
                </div>
              </div>
            </div>
          `;
        })
        .join('');
    }

    const pnlTotal = totalCurrent - totalInvested;
    const pnlPctTotal = totalInvested > 0 ? (pnlTotal / totalInvested) * 100 : 0;
    document.getElementById('pf-total-val').textContent = fmtEur(totalCurrent);
    document.getElementById('pf-invested-val').textContent = fmtEur(totalInvested);
    const pnlEl = document.getElementById('pf-pnl-val');
    pnlEl.textContent = `${pnlTotal >= 0 ? '+' : ''}${fmtEur(pnlTotal)} (${fmtPct(pnlPctTotal)})`;
    pnlEl.className = 'kpi-val ' + (pnlTotal >= 0 ? 'pos' : 'neg');

    const logEl = document.getElementById('activity-log-container');
    if (!state.activityLog.length) {
      logEl.innerHTML = `<p style="color: var(--text-muted); font-size: 0.8rem; margin: 0;">Veiksmų dar nėra.</p>`;
    } else {
      logEl.innerHTML = state.activityLog
        .slice(0, 10)
        .map(
          (item) => `
          <div style="padding: 7px 0; border-bottom: 1px solid var(--border-subtle); font-size: 0.8rem; display: flex; justify-content: space-between; gap: 8px;">
            <span>${escapeHtml(item.text)}</span>
            <span class="mono" style="color: var(--text-muted); font-size: 0.72rem; white-space: nowrap;">${escapeHtml(item.ts)}</span>
          </div>
        `
        )
        .join('');
    }
  }

  function syncSettingsInputs() {
    document.getElementById('input-monthly-cap').value = String(getMonthlyCap());
    document.getElementById('tg-bot-token').value = state.settings.tgToken || '';
    document.getElementById('tg-chat-id').value = state.settings.tgChatId || '';
    document.getElementById('gh-dispatch-token').value = state.settings.ghDispatchToken || '';
    document.getElementById('alpaca-key').value = state.settings.alpacaKey || '';
    document.getElementById('alpaca-secret').value = state.settings.alpacaSecret || '';
    document.getElementById('alpaca-env').value = state.settings.alpacaEnv || 'paper';
  }

  // --- Greito Pirkimo / Pardavimo langas (be naršyklės confirm/prompt!) ---
  function openOrderSheet(symbol, side = 'BUY') {
    const asset = state.marketData?.assets?.find((a) => a.symbol === symbol);
    if (!asset) return;

    const modal = document.getElementById('asset-modal');
    const body = document.getElementById('asset-modal-body');
    const owned = state.portfolio.find((p) => p.symbol === symbol);
    const ownedVal = owned ? owned.shares * asset.priceEur : 0;
    const rem = getRemainingBudget();
    const cap = getMonthlyCap();

    if (side === 'SELL' && owned) {
      const pnlEur = ownedVal - owned.investedEur;
      body.innerHTML = `
        <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 10px;">
          <div>
            <span style="font-size: 0.75rem; color: var(--coral); font-weight: 700; text-transform: uppercase;">Pozicijos pardavimas</span>
            <h2 style="margin: 2px 0 0; font-size: 1.2rem;">${escapeHtml(asset.shortName)} (${escapeHtml(asset.symbol)})</h2>
          </div>
          <button type="button" class="icon-btn" id="btn-close-modal" aria-label="Uždaryti">✕</button>
        </div>

        <div style="margin: 14px 0; padding: 12px; background: var(--bg-subtle); border-radius: var(--radius-sm); border: 1px solid var(--border-subtle);">
          <div style="display: flex; justify-content: space-between; font-size: 0.86rem;">
            <span>Jūsų pozicijos vertė dabar:</span>
            <strong class="mono">${fmtEur(ownedVal)}</strong>
          </div>
          <div style="display: flex; justify-content: space-between; font-size: 0.82rem; margin-top: 4px; color: var(--text-secondary);">
            <span>Sukauptas rezultatas:</span>
            <strong class="mono ${pnlEur >= 0 ? 'pos' : 'neg'}">${pnlEur >= 0 ? '+' : ''}${fmtEur(pnlEur)}</strong>
          </div>
        </div>

        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
          <button type="button" class="btn-secondary" id="btn-sell-half">Parduoti pusę (50%)</button>
          <button type="button" class="btn-danger" id="btn-sell-all">Parduoti viską (100%)</button>
        </div>
      `;

      modal.classList.add('open');
      document.getElementById('btn-close-modal').onclick = closeModal;
      document.getElementById('btn-sell-half').onclick = async () => {
        closeModal();
        await executeSellPct(symbol, 50);
      };
      document.getElementById('btn-sell-all').onclick = async () => {
        closeModal();
        await executeSellPct(symbol, 100);
      };
      return;
    }

    // Pirkimo langas
    const defaultAmt = rem >= 10 ? Math.min(25, Math.round(rem)) : 25;

    body.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 10px;">
        <div>
          <span style="font-size: 0.75rem; color: var(--emerald); font-weight: 700; text-transform: uppercase;">Greitas pirkimas</span>
          <h2 style="margin: 2px 0 0; font-size: 1.2rem;">${escapeHtml(asset.shortName)} (${escapeHtml(asset.symbol)})</h2>
          <span style="font-size: 0.8rem; color: var(--text-secondary);">Kaina: <strong class="mono">${fmtEur(asset.priceEur)}</strong> • ${escapeHtml(asset.signalLabel)}</span>
        </div>
        <button type="button" class="icon-btn" id="btn-close-modal" aria-label="Uždaryti">✕</button>
      </div>

      <div style="margin-top: 12px;">
        <label class="field-label" for="buy-eur-input">Suma eurais (šį mėn. iš ${cap} € liko <strong class="mono">${fmtEur(rem)}</strong>)</label>
        <div class="quick-amounts" id="buy-amt-chips">
          <button type="button" class="amt-chip ${defaultAmt === 10 ? 'active' : ''}" data-amt="10">10 €</button>
          <button type="button" class="amt-chip ${defaultAmt === 25 ? 'active' : ''}" data-amt="25">25 €</button>
          <button type="button" class="amt-chip ${defaultAmt === 50 ? 'active' : ''}" data-amt="50">50 €</button>
          <button type="button" class="amt-chip ${defaultAmt === 100 ? 'active' : ''}" data-amt="100">100 €</button>
        </div>
        <input type="number" id="buy-eur-input" inputmode="decimal" class="form-input mono" min="1" max="10000" step="1" value="${defaultAmt}" style="font-size: 1.1rem; font-weight: 700;" />
        <div style="display: flex; justify-content: space-between; font-size: 0.79rem; color: var(--text-secondary); margin-top: 6px;">
          <span>Kiekis (dalinės akcijos):</span>
          <strong class="mono" id="buy-est-shares">~${(defaultAmt / asset.priceEur).toFixed(4)} vnt.</strong>
        </div>
        <div id="over-budget-warning" style="display: none; margin-top: 8px; padding: 8px 10px; border-radius: 8px; background: var(--amber-soft); color: var(--amber); font-size: 0.78rem; font-weight: 600;">
          Pastaba: ši suma viršys jūsų nustatytą ${cap} €/mėn. planą. Spauskite dar kartą „Patvirtinti pirkimą“, jei norite tęsti.
        </div>
      </div>

      <button type="button" class="btn-primary btn-block" id="btn-confirm-buy-now" style="margin-top: 14px;">⚡ Pirkti už ${defaultAmt} €</button>
    `;

    modal.classList.add('open');

    const eurInput = document.getElementById('buy-eur-input');
    const sharesEl = document.getElementById('buy-est-shares');
    const warnEl = document.getElementById('over-budget-warning');
    const confirmBtn = document.getElementById('btn-confirm-buy-now');
    let warnedOnce = false;

    const refreshCalc = () => {
      const val = Math.max(0, safeNum(eurInput.value, 0));
      sharesEl.textContent = `~${(val / Math.max(0.01, asset.priceEur)).toFixed(4)} vnt.`;
      confirmBtn.textContent = `⚡ Pirkti už ${val} €`;
      warnedOnce = false;
      warnEl.style.display = 'none';
    };

    eurInput.addEventListener('input', refreshCalc);
    document.getElementById('buy-amt-chips').addEventListener('click', (e) => {
      const c = e.target.closest('.amt-chip');
      if (!c) return;
      eurInput.value = c.dataset.amt;
      document.querySelectorAll('#buy-amt-chips .amt-chip').forEach((b) => b.classList.toggle('active', b === c));
      refreshCalc();
    });

    document.getElementById('btn-close-modal').onclick = closeModal;

    confirmBtn.onclick = async () => {
      const val = Math.round(safeNum(eurInput.value, 0) * 100) / 100;
      if (!(val >= 1)) {
        showToast('Įveskite sumą nuo 1 €');
        return;
      }
      if (val > rem + 0.01 && !warnedOnce) {
        warnedOnce = true;
        warnEl.style.display = 'block';
        confirmBtn.textContent = `Patvirtinti pirkimą (${val} €)`;
        return;
      }
      closeModal();
      await executeBuy(symbol, val);
    };
  }

  // --- Detalus 90 d. grafikas ir paaiškinimai ---
  function openChartModal(symbol) {
    const asset = state.marketData?.assets?.find((a) => a.symbol === symbol);
    if (!asset) return;

    const modal = document.getElementById('asset-modal');
    const body = document.getElementById('asset-modal-body');

    const chart = asset.chart || { pricesEur: [], sma50Eur: [], sma200Eur: [], dates: [] };
    const prices = chart.pricesEur.length ? chart.pricesEur : [asset.priceEur, asset.priceEur];
    const s50 = chart.sma50Eur.length ? chart.sma50Eur : prices;
    const s200 = chart.sma200Eur.length ? chart.sma200Eur : prices;

    const w = 560;
    const h = 185;
    const pad = { top: 12, right: 12, bottom: 22, left: 46 };
    const allY = [...prices, ...s50, ...s200].filter((v) => v > 0);
    const minY = Math.min(...allY) * 0.97;
    const maxY = Math.max(...allY) * 1.03;
    const cnt = prices.length;

    const xAt = (i) => pad.left + (i / Math.max(1, cnt - 1)) * (w - pad.left - pad.right);
    const yAt = (v) => pad.top + (1 - (v - minY) / Math.max(0.01, maxY - minY)) * (h - pad.top - pad.bottom);
    const pathOf = (arr) => arr.map((v, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(' ');

    body.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: flex-start; gap: 10px;">
        <div>
          <h2 style="margin: 0; font-size: 1.12rem;">${escapeHtml(asset.name)}</h2>
          <span style="font-size: 0.78rem; color: var(--text-secondary);">${escapeHtml(asset.thesis)}</span>
        </div>
        <button type="button" class="icon-btn" id="btn-close-modal" aria-label="Uždaryti">✕</button>
      </div>

      <div style="display: flex; justify-content: space-between; align-items: baseline; margin-top: 12px;">
        <span class="mono" style="font-size: 1.4rem; font-weight: 700;">${fmtEur(asset.priceEur)}</span>
        <span class="badge ${signalBadgeClass(asset.signal)}">${escapeHtml(asset.signalLabel)} (${asset.score}/100)</span>
      </div>

      <div class="chart-wrap">
        <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
          <line x1="${pad.left}" y1="${yAt(minY).toFixed(1)}" x2="${w - pad.right}" y2="${yAt(minY).toFixed(1)}" stroke="var(--border-subtle)" />
          <line x1="${pad.left}" y1="${yAt(maxY).toFixed(1)}" x2="${w - pad.right}" y2="${yAt(maxY).toFixed(1)}" stroke="var(--border-subtle)" />
          <text x="${pad.left - 5}" y="${(yAt(maxY) + 4).toFixed(1)}" text-anchor="end" fill="var(--text-muted)" font-size="10" font-family="var(--font-mono)">${maxY.toFixed(0)}€</text>
          <text x="${pad.left - 5}" y="${(yAt(minY) + 4).toFixed(1)}" text-anchor="end" fill="var(--text-muted)" font-size="10" font-family="var(--font-mono)">${minY.toFixed(0)}€</text>
          <path d="${pathOf(s200)}" fill="none" stroke="var(--amber)" stroke-width="1.5" stroke-dasharray="4 3" />
          <path d="${pathOf(s50)}" fill="none" stroke="var(--sky)" stroke-width="1.6" />
          <path d="${pathOf(prices)}" fill="none" stroke="var(--emerald)" stroke-width="2.3" />
          <text x="${pad.left}" y="${h - 4}" fill="var(--text-muted)" font-size="10" font-family="var(--font-mono)">${chart.dates[0] || ''}</text>
          <text x="${w - pad.right}" y="${h - 4}" text-anchor="end" fill="var(--text-muted)" font-size="10" font-family="var(--font-mono)">${chart.dates[cnt - 1] || ''}</text>
        </svg>
      </div>

      <div class="levels-grid">
        <div class="level-box"><span>Gera pirkti iki</span><strong class="pos">${fmtEur(asset.entryZoneEur[1])}</strong></div>
        <div class="level-box"><span>Pelno tikslas</span><strong style="color: var(--sky);">${fmtEur(asset.takeProfitEur)}</strong></div>
        <div class="level-box"><span>Apsaugos riba</span><strong class="neg">${fmtEur(asset.stopLossEur)}</strong></div>
      </div>

      <ul style="margin: 8px 0 14px; padding-left: 18px; font-size: 0.82rem; color: var(--text-secondary); line-height: 1.55;">
        ${(asset.reasons || []).map((r) => `<li>${escapeHtml(r)}</li>`).join('')}
      </ul>

      <button type="button" class="btn-primary btn-block" id="btn-buy-from-chart">⚡ Pirkti ${escapeHtml(asset.shortName)}</button>
    `;

    modal.classList.add('open');
    document.getElementById('btn-close-modal').onclick = closeModal;
    document.getElementById('btn-buy-from-chart').onclick = () => openOrderSheet(symbol, 'BUY');
  }

  function closeModal() {
    document.getElementById('asset-modal').classList.remove('open');
  }

  // --- Tikras naujo simbolio skaičiavimas naršyklėje ---
  function buildAnalyzedCustomAsset(sym, meta, dates, closes, eurusd) {
    const currency = meta.currency || 'USD';
    const toEur = currency === 'EUR' ? 1.0 : 1.0 / Math.max(0.5, eurusd);
    const n = closes.length;
    const pxNat = closes[n - 1];
    const pxEur = Number((pxNat * toEur).toFixed(2));

    const avg = (arr) => arr.reduce((s, v) => s + v, 0) / Math.max(1, arr.length);
    const sma50 = avg(closes.slice(-Math.min(50, n)));
    const sma200 = avg(closes.slice(-Math.min(200, n)));

    // Tikras Wilder RSI(14)
    let gains = 0;
    let losses = 0;
    const p = Math.min(14, n - 1);
    for (let i = n - p; i < n; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff >= 0) gains += diff;
      else losses -= diff;
    }
    const rsi14 = losses === 0 ? 70 : 100 - 100 / (1 + (gains / p) / (losses / p));

    let score = 52;
    if (pxNat >= sma200) score += 16;
    else score -= 12;
    if (sma50 >= sma200) score += 8;
    if (rsi14 <= 40) score += pxNat >= sma200 ? 16 : 4;
    else if (rsi14 <= 55) score += 10;
    else if (rsi14 >= 74) score -= 20;
    score = Math.max(15, Math.min(94, Math.round(score)));

    let signal = 'HOLD';
    let signalLabel = 'LAIKYTI';
    let simpleVerdict = 'Neutrali būsena — verta stebėti kainą.';
    if (rsi14 >= 74 || score <= 42) {
      signal = 'TRIM_SELL';
      signalLabel = rsi14 >= 74 ? 'PARDUOTI (PELNAS)' : 'PARDUOTI / VENGTI';
      simpleVerdict = rsi14 >= 74 ? 'Kaina stipriai pakilusi — atsargiai.' : 'Silpna kryptis žemiau vidurkių.';
    } else if (score >= 74) {
      signal = 'STRONG_BUY';
      signalLabel = 'STIPRUS PIRKIMAS';
      simpleVerdict = 'Tvarus augimas ir gera kaina pirkimui.';
    } else if (score >= 60) {
      signal = 'BUY_DCA';
      signalLabel = 'PIRKTI';
      simpleVerdict = 'Tinkamas laikas ramiam pirkimui.';
    }

    const tail = Math.min(90, n);
    return {
      symbol: sym,
      alpacaSymbol: sym.split('.')[0],
      name: meta.longName || meta.shortName || sym,
      shortName: (meta.shortName || sym).split(' ').slice(0, 2).join(' '),
      category: String(meta.instrumentType || '').toUpperCase().includes('ETF') ? 'ETF' : 'Akcija',
      subCategory: 'Pridėtas simbolis',
      role: 'stock',
      priceEur: pxEur,
      change1d: n > 1 ? Number((((pxNat - closes[n - 2]) / closes[n - 2]) * 100).toFixed(2)) : 0,
      change1m: n > 21 ? Number((((pxNat - closes[n - 22]) / closes[n - 22]) * 100).toFixed(2)) : 0,
      change1y: Number((((pxNat - closes[0]) / closes[0]) * 100).toFixed(2)),
      rsi14: Number(rsi14.toFixed(1)),
      distSma200Pct: Number((((pxNat - sma200) / sma200) * 100).toFixed(2)),
      score,
      signal,
      signalLabel,
      simpleVerdict,
      entryZoneEur: [Number((pxEur * 0.96).toFixed(2)), Number((pxEur * 1.01).toFixed(2))],
      takeProfitEur: Number((pxEur * 1.15).toFixed(2)),
      stopLossEur: Number((pxEur * 0.91).toFixed(2)),
      thesis: 'Vartotojo pridėtas aktyvas su apskaičiuotais RSI ir 200 d. trendo rodikliais.',
      reasons: [
        pxNat >= sma200 ? 'Kaina virš 200 d. vidurkio (augimo tendencija).' : 'Kaina žemiau 200 d. vidurkio.',
        `RSI(14) rodiklis: ${rsi14.toFixed(1)}.`,
      ],
      chart: {
        dates: dates.slice(-tail),
        pricesEur: closes.slice(-tail).map((c) => Number((c * toEur).toFixed(2))),
        sma50Eur: closes.slice(-tail).map((_, idx) => {
          const abs = n - tail + idx;
          return Number((avg(closes.slice(Math.max(0, abs - 49), abs + 1)) * toEur).toFixed(2));
        }),
        sma200Eur: closes.slice(-tail).map((_, idx) => {
          const abs = n - tail + idx;
          return Number((avg(closes.slice(Math.max(0, abs - 199), abs + 1)) * toEur).toFixed(2));
        }),
      },
    };
  }

  async function handleCustomTickerSubmit(e) {
    e.preventDefault();
    const input = document.getElementById('custom-ticker-input');
    const sym = (input.value || '').trim().toUpperCase();
    if (!sym) return;

    const existing = state.marketData?.assets?.find((a) => a.symbol.toUpperCase() === sym);
    if (existing) {
      document.getElementById('custom-ticker-form').style.display = 'none';
      input.value = '';
      openOrderSheet(existing.symbol, 'BUY');
      return;
    }

    showToast(`Ieškoma ${sym}…`);
    const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1y&interval=1d`;
    const proxies = [
      `https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`,
      `https://corsproxy.io/?${encodeURIComponent(target)}`,
    ];

    for (const pUrl of proxies) {
      try {
        const res = await fetch(pUrl);
        if (!res.ok) continue;
        const j = await res.json();
        const raw = j?.chart?.result?.[0];
        if (!raw) continue;
        const ts = raw.timestamp || [];
        const qCloses = raw.indicators?.quote?.[0]?.close || [];
        const dates = [];
        const closes = [];
        for (let i = 0; i < ts.length; i++) {
          if (qCloses[i] != null && qCloses[i] > 0) {
            dates.push(new Date(ts[i] * 1000).toISOString().slice(0, 10));
            closes.push(Number(qCloses[i]));
          }
        }
        if (closes.length < 15) continue;

        const built = buildAnalyzedCustomAsset(sym, raw.meta || {}, dates, closes, safeNum(state.marketData?.eurUsdRate, 1.09));
        state.customSymbols.push(built);
        state.marketData.assets.push(built);
        state.marketData.assets.sort((a, b) => b.score - a.score);
        saveLocalState();
        document.getElementById('custom-ticker-form').style.display = 'none';
        input.value = '';
        state.signalFilter = 'ALL';
        document.querySelectorAll('#filter-chips .chip').forEach((c) => c.classList.toggle('active', c.dataset.filter === 'ALL'));
        renderAll();
        openOrderSheet(built.symbol, 'BUY');
        return;
      } catch (_) {
        // Bandomas kitas šaltinis
      }
    }
    showToast(`Simbolis „${sym}“ nerastas. Patikrinkite tikslų kodą.`);
  }

  // --- Telegram bandomoji ataskaita ---
  async function sendTelegramTest() {
    const token = state.settings.tgToken.trim();
    const chatId = state.settings.tgChatId.trim();
    if (!token || !chatId) {
      showToast('Įveskite abu laukus: Bot Token ir Chat ID');
      return;
    }

    const top3 = (state.marketData?.assets || []).slice(0, 3);
    const text = [
      `📊 <b>InvestPulsas • Dienos pasiūlymai</b>`,
      ...top3.map((a) => `• <b>${a.shortName}</b> (${a.symbol}) — ${fmtEur(a.priceEur)} | ${a.signalLabel}`),
      ``,
      `Šį mėnesį investuota: <b>${fmtEur(getSpentThisMonth())} iš ${getMonthlyCap()} €</b>`,
    ].join('\n');

    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.description || 'Telegram klaida');
      showToast('✅ Žinutė išsiųsta į jūsų Telegram!');
    } catch (err) {
      showToast(`Telegram klaida: ${err.message}`);
    }
  }

  // --- Navigacija ir mygtukų įvykiai ---
  function switchView(viewName) {
    state.activeView = viewName;
    document.querySelectorAll('.view-section').forEach((sec) => {
      sec.classList.toggle('active', sec.id === `view-${viewName}`);
    });
    document.querySelectorAll('[data-view]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.view === viewName);
    });
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function bindEvents() {
    document.querySelectorAll('[data-view]').forEach((btn) => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });

    document.getElementById('btn-open-portfolio-shortcut').addEventListener('click', () => switchView('portfolio'));

    document.getElementById('btn-theme-toggle').addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme') || 'dark';
      applyTheme(cur === 'dark' ? 'light' : 'dark');
    });

    document.getElementById('btn-live-refresh').addEventListener('click', async () => {
      const btn = document.getElementById('btn-live-refresh');
      btn.classList.add('spinning');
      try {
        if ('serviceWorker' in navigator) {
          const reg = await navigator.serviceWorker.getRegistration();
          if (reg) await reg.update();
        }
        await loadMarketData();
        showToast('Kainos ir signalai atnaujinti!');
      } finally {
        setTimeout(() => btn.classList.remove('spinning'), 400);
      }
    });

    document.getElementById('toggle-autopilot').addEventListener('change', (e) => {
      state.autopilotEnabled = e.target.checked;
      saveLocalState();
      renderControlCard();
      showToast(state.autopilotEnabled ? '🤖 Autopilotas įjungtas' : 'Autopilotas išjungtas');
    });

    document.getElementById('btn-auto-invest-remaining').addEventListener('click', () => {
      runAutopilotSmartCycle(false);
    });

    document.getElementById('filter-chips').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      state.signalFilter = chip.dataset.filter;
      document.querySelectorAll('#filter-chips .chip').forEach((c) => c.classList.toggle('active', c === chip));
      renderSignals();
    });

    document.getElementById('search-input').addEventListener('input', (e) => {
      state.searchQuery = e.target.value || '';
      renderSignals();
    });

    document.getElementById('btn-toggle-custom-box').addEventListener('click', () => {
      const box = document.getElementById('custom-ticker-form');
      const open = box.style.display === 'none';
      box.style.display = open ? 'block' : 'none';
      if (open) document.getElementById('custom-ticker-input').focus();
    });

    document.getElementById('custom-ticker-form').addEventListener('submit', handleCustomTickerSubmit);

    // Pirkti / Parduoti / Grafikas paspaudimai
    document.body.addEventListener('click', (e) => {
      const orderBtn = e.target.closest('[data-order-symbol]');
      if (orderBtn) {
        e.stopPropagation();
        openOrderSheet(orderBtn.dataset.orderSymbol, orderBtn.dataset.orderSide || 'BUY');
        return;
      }

      const chartBtn = e.target.closest('[data-chart-symbol]');
      if (chartBtn) {
        e.stopPropagation();
        openChartModal(chartBtn.dataset.chartSymbol);
      }
    });

    document.getElementById('asset-modal').addEventListener('click', (e) => {
      if (e.target.id === 'asset-modal') closeModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeModal();
    });

    // Portfelio išvalymas be naršyklės confirm()
    document.getElementById('btn-reset-demo-pf').addEventListener('click', () => {
      document.getElementById('pf-ResetConfirmBox').style.display = 'block';
    });
    document.getElementById('btn-confirm-reset-no').addEventListener('click', () => {
      document.getElementById('pf-ResetConfirmBox').style.display = 'none';
    });
    document.getElementById('btn-confirm-reset-yes').addEventListener('click', () => {
      state.portfolio = [];
      state.spentLog = {};
      state.activityLog = [];
      state.lastAutoMonth = '';
      saveLocalState();
      document.getElementById('pf-ResetConfirmBox').style.display = 'none';
      renderAll();
      showToast('Portfelis ir šio mėnesio limitas išvalyti');
    });

    // Nustatymai
    document.getElementById('btn-save-cap').addEventListener('click', () => {
      const val = Math.max(10, Math.min(10000, safeNum(document.getElementById('input-monthly-cap').value, 100)));
      state.settings.monthlyCapEur = val;
      saveLocalState();
      renderAll();
      showToast(`Mėnesio limitas išsaugotas: ${val} €`);
    });

    document.getElementById('btn-save-test-telegram').addEventListener('click', () => {
      state.settings.tgToken = document.getElementById('tg-bot-token').value.trim();
      state.settings.tgChatId = document.getElementById('tg-chat-id').value.trim();
      saveLocalState();
      sendTelegramTest();
    });

    document.getElementById('btn-save-test-alpaca').addEventListener('click', async () => {
      state.settings.alpacaKey = document.getElementById('alpaca-key').value.trim();
      state.settings.alpacaSecret = document.getElementById('alpaca-secret').value.trim();
      state.settings.alpacaEnv = document.getElementById('alpaca-env').value;
      saveLocalState();
      await testAndLoadAlpacaAccount(false);
    });

    document.getElementById('btn-save-gh-token').addEventListener('click', () => {
      state.settings.ghDispatchToken = document.getElementById('gh-dispatch-token').value.trim();
      saveLocalState();
      showToast('GitHub raktas išsaugotas');
    });

    document.getElementById('btn-export-data').addEventListener('click', () => {
      const blob = new Blob([localStorage.getItem(STORAGE_KEYS.STATE_V3) || '{}'], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `investpulsas-kopija-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
    });

    document.getElementById('input-import-data').addEventListener('change', (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(String(reader.result));
          if (Array.isArray(parsed.portfolio)) state.portfolio = parsed.portfolio;
          if (parsed.spentLog && typeof parsed.spentLog === 'object' && !Array.isArray(parsed.spentLog)) state.spentLog = parsed.spentLog;
          if (Array.isArray(parsed.activityLog)) state.activityLog = parsed.activityLog;
          saveLocalState();
          renderAll();
          showToast('Portfelio kopija sėkmingai įkelta!');
        } catch (_) {
          showToast('Netinkamas kopijos failas');
        }
        e.target.value = '';
      };
      reader.readAsText(file);
    });

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      state.deferredInstallPrompt = e;
      document.getElementById('pwa-install-banner').classList.remove('hidden');
    });

    document.getElementById('btn-install-pwa').addEventListener('click', async () => {
      if (!state.deferredInstallPrompt) return;
      state.deferredInstallPrompt.prompt();
      await state.deferredInstallPrompt.userChoice;
      state.deferredInstallPrompt = null;
      document.getElementById('pwa-install-banner').classList.add('hidden');
    });
  }

  function registerServiceWorkerAndAutoSync() {
    if ('serviceWorker' in navigator) {
      let refreshing = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (refreshing) return;
        refreshing = true;
        window.location.reload();
      });

      window.addEventListener('load', () => {
        navigator.serviceWorker
          .register('./sw.js')
          .then((reg) => {
            reg.update();
            document.addEventListener('visibilitychange', () => {
              if (document.visibilityState === 'visible') {
                reg.update();
                loadMarketData();
              }
            });
          })
          .catch((err) => console.warn('SW klaida:', err));
      });
    }
  }

  loadLocalState();
  bindEvents();
  registerServiceWorkerAndAutoSync();
  loadMarketData();
})();
