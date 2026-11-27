/* InvestPulsas v2 — Mobilioji PWA investavimo, tiesioginio pirkimo/pardavimo ir brokerio autopiloto programa */
(function () {
  'use strict';

  const REPO_OWNER = 'banysster-eng';
  const REPO_NAME = 'invest-pulsas';

  const STORAGE_KEYS = {
    THEME: 'investpulsas_theme',
    PORTFOLIO: 'investpulsas_portfolio_v1',
    SPENT_LOG: 'investpulsas_monthly_spent_v1',
    AUTOPILOT: 'investpulsas_autopilot_v1',
    SETTINGS: 'investpulsas_settings_v2',
    CUSTOM_ASSETS: 'investpulsas_custom_assets_v1',
  };

  const state = {
    marketData: null,
    cloudBrokerState: null,
    activeView: 'overview',
    signalFilter: 'ALL',
    searchQuery: '',
    plannerBudget: 100,
    plannerProfile: 'balanced',
    portfolio: [],
    spentLog: {},
    autopilot: {
      enabled: true,
      cashEur: 100,
      totalDepositedEur: 100,
      lastDepositMonth: '',
      holdings: [],
      logs: [],
    },
    settings: {
      monthlyCapEur: 100,
      tgToken: '',
      tgChatId: '',
      ghDispatchToken: '',
      alpacaKey: '',
      alpacaSecret: '',
      alpacaEnv: 'paper',
    },
    alpacaAccount: null,
    customSymbols: [],
    deferredInstallPrompt: null,
  };

  function fmtEur(val) {
    const n = Number(val) || 0;
    return n.toLocaleString('lt-LT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
  }

  function fmtPct(val, withSign = true) {
    const n = Number(val) || 0;
    const sign = withSign && n > 0 ? '+' : '';
    return sign + n.toLocaleString('lt-LT', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) + ' %';
  }

  function currentYearMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function showToast(msg) {
    const el = document.getElementById('app-toast');
    if (!el) return;
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => el.classList.remove('show'), 3500);
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

  function scoreColor(score) {
    if (score >= 74) return 'var(--emerald)';
    if (score >= 60) return 'var(--sky)';
    if (score <= 43) return 'var(--coral)';
    return 'var(--amber)';
  }

  // --- Vietinės saugyklos valdymas ---
  function loadLocalState() {
    try {
      const savedTheme = localStorage.getItem(STORAGE_KEYS.THEME) || 'dark';
      applyTheme(savedTheme);

      const pf = JSON.parse(localStorage.getItem(STORAGE_KEYS.PORTFOLIO) || '[]');
      if (Array.isArray(pf)) state.portfolio = pf;

      const sp = JSON.parse(localStorage.getItem(STORAGE_KEYS.SPENT_LOG) || '{}');
      if (sp && typeof sp === 'object') state.spentLog = sp;

      const stOld = JSON.parse(localStorage.getItem('investpulsas_settings_v1') || 'null');
      const stNew = JSON.parse(localStorage.getItem(STORAGE_KEYS.SETTINGS) || 'null');
      state.settings = { ...state.settings, ...(stOld || {}), ...(stNew || {}) };
      state.plannerBudget = Number(state.settings.monthlyCapEur) || 100;

      const bot = JSON.parse(localStorage.getItem(STORAGE_KEYS.AUTOPILOT) || 'null');
      if (bot && typeof bot === 'object') {
        state.autopilot = { ...state.autopilot, ...bot };
      }

      const custom = JSON.parse(localStorage.getItem(STORAGE_KEYS.CUSTOM_ASSETS) || '[]');
      if (Array.isArray(custom)) state.customSymbols = custom;
    } catch (err) {
      console.warn('Nepavyko nuskaityti localStorage:', err);
    }
  }

  function saveLocalState() {
    localStorage.setItem(STORAGE_KEYS.PORTFOLIO, JSON.stringify(state.portfolio));
    localStorage.setItem(STORAGE_KEYS.SPENT_LOG, JSON.stringify(state.spentLog));
    localStorage.setItem(STORAGE_KEYS.AUTOPILOT, JSON.stringify(state.autopilot));
    localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(state.settings));
    localStorage.setItem(STORAGE_KEYS.CUSTOM_ASSETS, JSON.stringify(state.customSymbols));
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem(STORAGE_KEYS.THEME, theme);
    const meta = document.getElementById('meta-theme-color');
    if (meta) meta.setAttribute('content', theme === 'light' ? '#f5f2eb' : '#0d1217');
  }

  // --- Tiesioginis Alpaca brokerio API telefone ---
  function hasAlpacaDirect() {
    return Boolean(state.settings.alpacaKey && state.settings.alpacaSecret);
  }

  function alpacaBaseUrl() {
    return state.settings.alpacaEnv === 'live'
      ? 'https://api.alpaca.markets/v2'
      : 'https://paper-api.alpaca.markets/v2';
  }

  async function testAndLoadAlpacaAccount(silent = false) {
    if (!hasAlpacaDirect()) return null;
    try {
      const res = await fetch(`${alpacaBaseUrl()}/account`, {
        headers: {
          'APCA-API-KEY-ID': state.settings.alpacaKey.trim(),
          'APCA-API-SECRET-KEY': state.settings.alpacaSecret.trim(),
        },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const acct = await res.json();
      state.alpacaAccount = acct;
      const eurusd = state.marketData?.eurUsdRate || 1.09;
      const cashEur = Number(acct.cash || 0) / eurusd;
      const statusEl = document.getElementById('alpaca-status-msg');
      if (statusEl) {
        statusEl.innerHTML = `✅ Prijungta prie Alpaca (${state.settings.alpacaEnv === 'live' ? 'Realus' : 'Demo Paper'}): Laisvi pinigai <strong>${fmtEur(cashEur)}</strong>`;
      }
      if (!silent) showToast(`Alpaca prijungta! Balansas: ${fmtEur(cashEur)}`);
      renderHomeAutopilotHero();
      return acct;
    } catch (err) {
      state.alpacaAccount = null;
      const statusEl = document.getElementById('alpaca-status-msg');
      if (statusEl) statusEl.textContent = `❌ Nepavyko prisijungti prie Alpaca (${err.message}). Patikrinkite API raktus.`;
      if (!silent) showToast(`Alpaca klaida: ${err.message}`);
      return null;
    }
  }

  async function placeDirectAlpacaOrder(asset, side, amountEur) {
    const eurusd = state.marketData?.eurUsdRate || 1.09;
    const alpSym = asset.alpacaSymbol || asset.symbol.split('.')[0];
    const usdAmount = (amountEur * eurusd).toFixed(2);

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
    if (!res.ok) {
      throw new Error(data.message || `Alpaca HTTP ${res.status}`);
    }
    return { broker: `Alpaca (${state.settings.alpacaEnv === 'live' ? 'Realus' : 'Demo'})`, symbol: alpSym, data };
  }

  // --- Trading 212 / GitHub Actions debesies pavedimo iškvietimas iš telefono ---
  async function triggerCloudBrokerOrder(symbol, side, amountEur) {
    const ghToken = (state.settings.ghDispatchToken || '').trim();
    if (!ghToken) return null;
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
          symbol: symbol,
          amount_eur: String(amountEur),
        },
      }),
    });
    if (!res.ok) {
      const errTxt = await res.text();
      throw new Error(`GitHub Actions klaida (${res.status}): ${errTxt.slice(0, 80)}`);
    }
    return { broker: 'Trading 212 (per GitHub Actions)' };
  }

  // --- Vieninga Pirkimo ir Pardavimo vykdymo funkcija ---
  async function executeTradeOrder(symbol, side, amountEur) {
    const asset = state.marketData?.assets?.find((a) => a.symbol === symbol);
    if (!asset) return;

    const ym = currentYearMonth();
    const spentSoFar = Number(state.spentLog[ym] || 0);
    const cap = Number(state.settings.monthlyCapEur || 100);

    if (side === 'BUY' && spentSoFar + amountEur > cap) {
      const rem = Math.max(0, cap - spentSoFar);
      const ok = window.confirm(
        `Šis pirkimas (${fmtEur(amountEur)}) viršys jūsų nustatytą ${cap} €/mėn. limitą (šį mėn. liko ${fmtEur(rem)}). Vis tiek vykdyti pirkimą?`
      );
      if (!ok) return;
    }

    let externalBrokerMsg = '';

    try {
      if (hasAlpacaDirect()) {
        const res = await placeDirectAlpacaOrder(asset, side, amountEur);
        externalBrokerMsg = ` • Pavedimas išsiųstas į ${res.broker} (${res.symbol})!`;
      } else if (state.settings.ghDispatchToken?.trim()) {
        const res = await triggerCloudBrokerOrder(symbol, side, amountEur);
        if (res) externalBrokerMsg = ` • Pavedimas išsiųstas į ${res.broker}!`;
      }
    } catch (brokerErr) {
      showToast(`Brokerio API pranešimas: ${brokerErr.message}`);
      return;
    }

    if (side === 'BUY') {
      addPurchaseToPortfolio(symbol, amountEur, asset.priceEur);
      showToast(`✅ Nupirkta: ${asset.shortName} už ${fmtEur(amountEur)}${externalBrokerMsg}`);
    } else {
      sellFromPortfolioByEur(symbol, amountEur, asset.priceEur);
      showToast(`✅ Parduota: ${asset.shortName} už ~${fmtEur(amountEur)}${externalBrokerMsg}`);
    }
  }

  // --- Rinkos ir debesies brokerio duomenų įkėlimas ---
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

      ensureAutopilotInitialized();
      if (hasAlpacaDirect()) {
        testAndLoadAlpacaAccount(true);
      }
      renderAll();
    } catch (err) {
      console.error('Klaida kraunant duomenis:', err);
      document.getElementById('last-updated-label').textContent = 'Nepavyko įkelti duomenų';
    }
  }

  async function handleLiveRefresh() {
    const btn = document.getElementById('btn-live-refresh');
    btn.classList.add('spinning');
    try {
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) await reg.update();
      }
      await loadMarketData();
      showToast('Kainos, signalai ir programėlės versija atnaujinta!');
    } catch (_) {
      showToast('Naudojami paskutiniai išsaugoti duomenys');
    } finally {
      setTimeout(() => btn.classList.remove('spinning'), 450);
    }
  }

  // --- Greito Pirkimo / Pardavimo langas (1 paspaudimu iš bet kurios kortelės!) ---
  function openQuickOrderSheet(symbol, initialSide = 'BUY') {
    const asset = state.marketData?.assets?.find((a) => a.symbol === symbol);
    if (!asset) return;

    const modal = document.getElementById('asset-modal');
    const body = document.getElementById('asset-modal-body');
    const owned = state.portfolio.find((p) => p.symbol === symbol);
    const ownedVal = owned ? owned.shares * asset.priceEur : 0;

    const ym = currentYearMonth();
    const spent = Number(state.spentLog[ym] || 0);
    const cap = Number(state.settings.monthlyCapEur || 100);
    const remaining = Math.max(0, cap - spent);
    const defaultAmt = initialSide === 'SELL' && ownedVal > 0 ? Math.round(ownedVal) : Math.min(25, Math.max(10, Math.round(remaining || 25)));

    let brokerLabel = 'Vidinis InvestPulsas portfelis (0,00 € komisinis)';
    if (hasAlpacaDirect()) {
      brokerLabel = `Tiesioginis Alpaca API (${state.settings.alpacaEnv === 'live' ? 'Realus' : 'Demo Paper'})`;
    } else if (state.cloudBrokerState?.brokerConnected || state.settings.ghDispatchToken) {
      brokerLabel = state.cloudBrokerState?.brokerName || 'Trading 212 debesies API';
    }

    body.innerHTML = `
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;">
        <div>
          <span class="eyebrow">${initialSide === 'BUY' ? 'Akcijos / ETF pirkimas' : 'Pozicijos pardavimas'}</span>
          <h2 style="margin: 2px 0 0; font-size: 1.2rem;">${escapeHtml(asset.shortName)} <span class="asset-ticker">${escapeHtml(asset.symbol)}</span></h2>
          <p style="margin: 3px 0 0; font-size: 0.79rem; color: var(--text-secondary);">Dabartinė rinkos kaina: <strong class="mono">${fmtEur(asset.priceEur)}</strong> • Signalas: <strong>${escapeHtml(asset.signalLabel)}</strong></p>
        </div>
        <button type="button" class="icon-btn" id="btn-close-modal" aria-label="Uždaryti">✕</button>
      </div>

      <div style="margin-top: 14px; padding: 10px 12px; background: var(--bg-subtle); border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); font-size: 0.79rem;">
        <div>Vykdymo kanalas: <strong style="color: var(--emerald);">${escapeHtml(brokerLabel)}</strong></div>
        <div style="margin-top: 3px; color: var(--text-secondary);">Šio mėnesio ${cap} € limito likutis: <strong class="mono">${fmtEur(remaining)}</strong>${owned ? ` • Turite: <strong class="mono">${fmtEur(ownedVal)}</strong>` : ''}</div>
      </div>

      <div style="margin-top: 14px;">
        <label class="field-label" for="order-eur-input">Pasirinkite arba įveskite sumą (€)</label>
        <div class="quick-amounts" id="quick-amt-chips">
          <button type="button" class="amt-chip ${defaultAmt === 10 ? 'active' : ''}" data-amt="10">10 €</button>
          <button type="button" class="amt-chip ${defaultAmt === 25 ? 'active' : ''}" data-amt="25">25 €</button>
          <button type="button" class="amt-chip ${defaultAmt === 50 ? 'active' : ''}" data-amt="50">50 €</button>
          <button type="button" class="amt-chip ${defaultAmt === 100 ? 'active' : ''}" data-amt="100">100 €</button>
        </div>
        <input type="number" id="order-eur-input" class="form-input mono" min="1" max="10000" step="1" value="${defaultAmt}" style="font-size: 1.08rem; font-weight: 700;" />
        <div style="display: flex; justify-content: space-between; font-size: 0.78rem; color: var(--text-secondary); margin-top: 6px;">
          <span>Preliminarus kiekis (dalinės akcijos):</span>
          <strong class="mono" id="order-est-shares">~${(defaultAmt / asset.priceEur).toFixed(4)} vnt.</strong>
        </div>
      </div>

      <div style="display: grid; grid-template-columns: ${owned ? '1fr 1fr' : '1fr'}; gap: 8px; margin-top: 16px;">
        <button type="button" class="btn-primary btn-block" id="btn-confirm-buy">⚡ Pirkti dabar</button>
        ${owned ? `<button type="button" class="btn-danger btn-block" id="btn-confirm-sell">Parduoti</button>` : ''}
      </div>

      <div style="display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--border-subtle);">
        <button type="button" class="btn-chart-sm" id="btn-switch-to-chart">📊 Žiūrėti 90 d. grafiką ir ribas</button>
        <a href="https://app.trading212.com/" target="_blank" rel="noopener noreferrer" style="font-size: 0.77rem; color: var(--sky); text-decoration: none; font-weight: 600;">Atidaryti Trading 212 ↗</a>
      </div>
    `;

    modal.classList.add('open');

    const eurInput = document.getElementById('order-eur-input');
    const sharesLbl = document.getElementById('order-est-shares');
    const updateEst = () => {
      const v = Math.max(0, Number(eurInput.value) || 0);
      sharesLbl.textContent = `~${(v / asset.priceEur).toFixed(4)} vnt.`;
    };

    eurInput.addEventListener('input', updateEst);
    document.getElementById('quick-amt-chips').addEventListener('click', (e) => {
      const c = e.target.closest('.amt-chip');
      if (!c) return;
      eurInput.value = c.dataset.amt;
      document.querySelectorAll('#quick-amt-chips .amt-chip').forEach((b) => b.classList.toggle('active', b === c));
      updateEst();
    });

    document.getElementById('btn-close-modal').onclick = closeAssetModal;
    document.getElementById('btn-switch-to-chart').onclick = () => openAssetModal(symbol);

    document.getElementById('btn-confirm-buy').onclick = async () => {
      const amt = Number(eurInput.value) || 25;
      closeAssetModal();
      await executeTradeOrder(symbol, 'BUY', amt);
    };

    const sellBtn = document.getElementById('btn-confirm-sell');
    if (sellBtn) {
      sellBtn.onclick = async () => {
        const amt = Number(eurInput.value) || 25;
        closeAssetModal();
        await executeTradeOrder(symbol, 'SELL', amt);
      };
    }
  }

  // --- Virtualaus + Tikro Autopiloto logika ---
  function ensureAutopilotInitialized() {
    if (!state.marketData?.assets?.length) return;
    const ym = currentYearMonth();
    if (!state.autopilot.lastDepositMonth) {
      state.autopilot.lastDepositMonth = ym;
      state.autopilot.cashEur = state.settings.monthlyCapEur || 100;
      state.autopilot.totalDepositedEur = state.autopilot.cashEur;
      if (state.autopilot.enabled) {
        runAutopilotCycle(true);
      }
      saveLocalState();
    } else if (state.autopilot.lastDepositMonth !== ym && state.autopilot.enabled) {
      const add = state.settings.monthlyCapEur || 100;
      state.autopilot.cashEur += add;
      state.autopilot.totalDepositedEur += add;
      state.autopilot.lastDepositMonth = ym;
      state.autopilot.logs.unshift({
        ts: new Date().toLocaleString('lt-LT'),
        action: 'MĖNESIO PAPILDYMAS',
        detail: `Pridėtas naujo mėnesio biudžetas +${fmtEur(add)}`,
      });
      runAutopilotCycle(true);
      saveLocalState();
    }
  }

  async function runAutopilotCycle(silent = false) {
    if (!state.marketData?.assets?.length) return;
    const assets = state.marketData.assets;
    const nowStr = new Date().toLocaleString('lt-LT', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    let actionsCount = 0;

    // Jei prijungtas tiesioginis Alpaca brokeris ir kviečiama rankiniu būdu — nuperkame ir ten iki mėnesio limito!
    if (!silent && hasAlpacaDirect()) {
      const ym = currentYearMonth();
      const spent = Number(state.spentLog[ym] || 0);
      const cap = Number(state.settings.monthlyCapEur || 100);
      const rem = Math.max(0, cap - spent);
      if (rem >= 10) {
        const items = computeDynamicPlanItems(rem);
        for (const it of items) {
          const assetObj = assets.find((a) => a.symbol === it.symbol);
          if (assetObj && it.amountEur >= 2) {
            await executeTradeOrder(assetObj.symbol, 'BUY', it.amountEur);
            actionsCount++;
          }
        }
      }
    }

    // 1. Patikriname ar kurią turimą roboto poziciją reikia parduoti (RSI >= 74 arba TRIM_SELL)
    for (let i = state.autopilot.holdings.length - 1; i >= 0; i--) {
      const h = state.autopilot.holdings[i];
      const live = assets.find((a) => a.symbol === h.symbol);
      if (!live || h.shares <= 0.0001) continue;
      const pnlPct = ((live.priceEur - h.avgPriceEur) / h.avgPriceEur) * 100;
      if (live.signal === 'TRIM_SELL' || live.rsi14 >= 74 || pnlPct >= 25) {
        const sellShares = h.shares * 0.5;
        const proceeds = Number((sellShares * live.priceEur).toFixed(2));
        h.shares -= sellShares;
        state.autopilot.cashEur = Number((state.autopilot.cashEur + proceeds).toFixed(2));
        state.autopilot.logs.unshift({
          ts: nowStr,
          action: 'AUTO PARDAVIMAS (50%)',
          detail: `${h.shortName} už ${fmtEur(proceeds)} (${live.signalLabel})`,
        });
        actionsCount++;
      }
    }

    // 2. Jei yra laisvo mėnesio biudžeto (arba vartotojas paspaudė vykdyti dabar ir nori pamatyti naują 100 € ciklą)
    if (state.autopilot.cashEur >= 10) {
      const budget = state.autopilot.cashEur;
      const sorted = [...assets].sort((a, b) => b.score - a.score);
      const corePick = sorted.find((a) => a.role === 'core' && a.signal !== 'TRIM_SELL') || sorted[0];
      const tacPick = sorted.find((a) => a.symbol !== corePick.symbol && a.signal !== 'TRIM_SELL') || sorted[1] || corePick;

      const legs = [
        { asset: corePick, eur: Number((budget * 0.6).toFixed(2)) },
        { asset: tacPick, eur: Number((budget * 0.4).toFixed(2)) },
      ];

      for (const leg of legs) {
        if (leg.eur < 1) continue;
        const sh = leg.eur / leg.asset.priceEur;
        const existing = state.autopilot.holdings.find((x) => x.symbol === leg.asset.symbol);
        if (existing) {
          const totalCost = existing.shares * existing.avgPriceEur + leg.eur;
          existing.shares += sh;
          existing.avgPriceEur = totalCost / existing.shares;
        } else {
          state.autopilot.holdings.push({
            symbol: leg.asset.symbol,
            shortName: leg.asset.shortName,
            shares: sh,
            avgPriceEur: leg.asset.priceEur,
          });
        }
        state.autopilot.cashEur = Math.max(0, Number((state.autopilot.cashEur - leg.eur).toFixed(2)));
        state.autopilot.logs.unshift({
          ts: nowStr,
          action: 'AUTO PIRKIMAS',
          detail: `${leg.asset.shortName} (${leg.asset.symbol}) už ${fmtEur(leg.eur)} @ ${fmtEur(leg.asset.priceEur)} (balas ${leg.asset.score}/100)`,
        });
        actionsCount++;
      }
    }

    state.autopilot.logs = state.autopilot.logs.slice(0, 30);
    saveLocalState();
    renderAll();

    if (!silent) {
      if (actionsCount > 0) {
        showToast(`⚡ Autopilotas automatiškai įvykdė ${actionsCount} pirkimo/pardavimo veiksmus!`);
      } else {
        // Atidarome 100 € krepšelio greitą pirkimą, kad vartotojas galėtų patvirtinti papildomą pirkimą
        const items = computeDynamicPlanItems(state.settings.monthlyCapEur || 100);
        for (const it of items) {
          addPurchaseToPortfolio(it.symbol, it.amountEur, it.priceEur);
        }
        showToast(`⚡ Įvykdytas ${state.settings.monthlyCapEur || 100} € automatinio krepšelio pirkimas!`);
      }
    }
  }

  // --- Atvaizdavimo funkcijos ---
  function renderAll() {
    if (!state.marketData) return;
    renderHeaderStatus();
    renderHomeAutopilotHero();
    renderOverview();
    renderSignalsList();
    renderPlanner();
    renderPortfolioAndAutopilot();
    populatePositionSelect();
    syncSettingsInputs();
  }

  function renderHeaderStatus() {
    const lbl = document.getElementById('last-updated-label');
    if (lbl && state.marketData) {
      lbl.textContent = `Atnaujinta: ${state.marketData.generatedAtLt} • EUR/USD ${state.marketData.eurUsdRate}`;
    }
  }

  function renderHomeAutopilotHero() {
    const toggle = document.getElementById('home-toggle-autopilot');
    const badge = document.getElementById('home-broker-mode-badge');
    const desc = document.getElementById('home-autopilot-desc');
    const pills = document.getElementById('home-autopilot-pills');
    if (!toggle || !pills) return;

    toggle.checked = Boolean(state.autopilot.enabled);

    if (state.cloudBrokerState?.brokerConnected) {
      badge.textContent = `${state.cloudBrokerState.brokerName.toUpperCase()} • AKTYVU`;
      badge.className = 'badge badge-buy';
      desc.textContent = `Debesies autopilotas prijungtas prie ${state.cloudBrokerState.brokerName}. Laisvos lėšos: ${fmtEur(state.cloudBrokerState.availableCashEur)}.`;
    } else if (hasAlpacaDirect()) {
      badge.textContent = `ALPACA (${state.settings.alpacaEnv === 'live' ? 'REALUS' : 'DEMO'}) • AKTYVU`;
      badge.className = 'badge badge-buy';
      desc.textContent = 'Tiesioginis brokerio API prijungtas telefone — visi pirkimai keliauja tiesiai į brokerio sąskaitą.';
    } else if (state.autopilot.enabled) {
      badge.textContent = 'AUTOPILOTAS ĮJUNGTAS (100 €/MĖN.)';
      badge.className = 'badge badge-buy';
      desc.textContent = 'Robotas automatiškai perka aukščiausio balo ETF/akcijas ir fiksuoja pelną. Norėdami vykdyti pas tikrą brokerį — prijunkite Trading 212 arba Alpaca.';
    } else {
      badge.textContent = 'AUTOPILOTAS PRISTABDYTAS';
      badge.className = 'badge badge-hold';
      desc.textContent = 'Automatinis pirkimas išjungtas — galite pirkti akcijas ir ETF rankiniu būdu spausdami „Pirkti“.';
    }

    const activeHoldings = state.autopilot.holdings.filter((h) => h.shares > 0.0001);
    if (activeHoldings.length > 0) {
      pills.innerHTML = activeHoldings
        .map((h) => {
          const live = state.marketData?.assets?.find((a) => a.symbol === h.symbol);
          const val = h.shares * (live ? live.priceEur : h.avgPriceEur);
          return `<span class="mini-holding-pill">🤖 Auto-nupirkta: <strong>${escapeHtml(h.shortName)}</strong> <span class="mono pos">${fmtEur(val)}</span></span>`;
        })
        .join('');
    } else {
      pills.innerHTML = '';
    }
  }

  function renderAssetCardHtml(asset) {
    const chgClass = asset.change1m >= 0 ? 'pos' : 'neg';
    const reasonText = asset.reasons?.[0] || asset.thesis;
    const isOwned = state.portfolio.some((p) => p.symbol === asset.symbol);

    return `
      <article class="asset-card" data-symbol="${escapeHtml(asset.symbol)}">
        <div class="asset-top">
          <div class="asset-id">
            <div class="asset-title-row">
              <span class="asset-name">${escapeHtml(asset.shortName)}</span>
              <span class="asset-ticker">${escapeHtml(asset.symbol)}</span>
              <span class="badge ${signalBadgeClass(asset.signal)}">${escapeHtml(asset.signalLabel)}</span>
            </div>
            <div class="asset-cat">${escapeHtml(asset.category)} • ${escapeHtml(asset.subCategory)}</div>
          </div>
          <div class="asset-price-col">
            <div class="asset-price">${fmtEur(asset.priceEur)}</div>
            <div class="asset-chg ${chgClass}">1 mėn: ${fmtPct(asset.change1m)}</div>
          </div>
        </div>

        <div class="asset-mid">
          <div class="asset-metrics">
            <span>RSI: <strong>${asset.rsi14}</strong></span>
            <span>200d: <strong>${fmtPct(asset.distSma200Pct)}</strong></span>
            <span>1 m.: <strong>${fmtPct(asset.change1y)}</strong></span>
          </div>
          <div class="score-meter">
            <span class="score-num" style="color: ${scoreColor(asset.score)};">${asset.score}/100</span>
            <div class="score-bar"><span style="width: ${asset.score}%; background: ${scoreColor(asset.score)};"></span></div>
          </div>
        </div>

        <div style="font-size: 0.78rem; color: var(--text-secondary);">${escapeHtml(reasonText)}</div>

        <div class="card-actions-bar">
          <button type="button" class="btn-chart-sm" data-chart-symbol="${escapeHtml(asset.symbol)}">📊 Grafikas</button>
          <div class="card-action-btns">
            ${isOwned ? `<button type="button" class="btn-sell-sm" data-order-side="SELL" data-order-symbol="${escapeHtml(asset.symbol)}">Parduoti</button>` : ''}
            <button type="button" class="btn-buy-sm" data-order-side="BUY" data-order-symbol="${escapeHtml(asset.symbol)}">⚡ Pirkti</button>
          </div>
        </div>
      </article>
    `;
  }

  function renderOverview() {
    const ov = state.marketData.marketOverview;
    document.getElementById('regime-headline').textContent = ov.regimeLabel;
    document.getElementById('regime-advice').textContent = ov.regimeAdvice;

    const rBadge = document.getElementById('regime-badge');
    rBadge.textContent = `VID. BALAS ${ov.avgScore}`;
    rBadge.className = 'badge ' + (ov.regimeCode === 'OVERHEATED' ? 'badge-sell' : 'badge-buy');

    document.getElementById('kpi-buy-count').textContent = String(ov.strongBuyCount + ov.buyDcaCount);
    document.getElementById('kpi-sell-count').textContent = String(ov.sellCount);
    document.getElementById('kpi-avg-rsi').textContent = String(ov.avgRsi);
    document.getElementById('kpi-sma200-pct').textContent = `${ov.aboveSma200Pct} %`;

    const ym = currentYearMonth();
    const localSpent = Number(state.spentLog[ym] || 0);
    const cloudSpent = state.cloudBrokerState?.month === ym ? Number(state.cloudBrokerState.spentThisMonthEur || 0) : 0;
    const spent = Math.max(localSpent, cloudSpent);
    const cap = Number(state.settings.monthlyCapEur || 100);
    const remaining = Math.max(0, cap - spent);
    const pct = Math.min(100, Math.round((spent / cap) * 100));

    document.getElementById('month-spent-label').textContent = fmtEur(spent);
    document.getElementById('month-limit-label').textContent = `${cap} €`;
    document.getElementById('month-remaining-hint').textContent =
      spent >= cap
        ? `Šio mėnesio ${cap} € limitas pasiektas!`
        : `Liko ${fmtEur(remaining)} pirkimams šį mėnesį`;

    const fill = document.getElementById('month-progress-fill');
    fill.style.width = `${pct}%`;
    fill.className = 'progress-fill' + (pct >= 100 ? ' over' : pct >= 80 ? ' warn' : '');

    const topGrid = document.getElementById('top-picks-grid');
    topGrid.innerHTML = state.marketData.assets.slice(0, 4).map(renderAssetCardHtml).join('');

    const allBtn = document.getElementById('btn-see-all-signals');
    if (allBtn) allBtn.textContent = `Visi (${state.marketData.assets.length})`;

    renderPersonalAlerts();
    renderBacktestChart();
  }

  function renderPersonalAlerts() {
    const box = document.getElementById('personal-alerts-box');
    const list = document.getElementById('personal-alerts-list');
    if (!state.portfolio.length) {
      box.style.display = 'none';
      return;
    }

    const alerts = [];
    for (const pos of state.portfolio) {
      const live = state.marketData.assets.find((a) => a.symbol === pos.symbol);
      if (!live) continue;
      const pnlPct = ((live.priceEur - pos.avgPriceEur) / pos.avgPriceEur) * 100;
      if (live.signal === 'TRIM_SELL' || live.rsi14 >= 74 || pnlPct >= 22) {
        alerts.push({
          type: 'SELL',
          symbol: pos.symbol,
          shortName: pos.shortName,
          msg: `Rekomenduojama parduoti dalį (${fmtPct(pnlPct)}, RSI ${live.rsi14}). Tikslinė kaina: ${fmtEur(live.takeProfitEur)}.`,
        });
      } else if (live.signal === 'STRONG_BUY') {
        alerts.push({
          type: 'BUY',
          symbol: pos.symbol,
          shortName: pos.shortName,
          msg: `Stiprus pirkimo signalas (${live.score}/100, RSI ${live.rsi14}) — gera proga papildyti.`,
        });
      }
    }

    if (!alerts.length) {
      box.style.display = 'none';
      return;
    }

    box.style.display = 'block';
    list.innerHTML = alerts
      .map(
        (al) => `
      <div class="alloc-row" style="margin-bottom: 8px;">
        <div class="alloc-left">
          <strong>${escapeHtml(al.shortName)} (${escapeHtml(al.symbol)})</strong>
          <p>${escapeHtml(al.msg)}</p>
        </div>
        <button type="button" class="${al.type === 'SELL' ? 'btn-sell-sm' : 'btn-buy-sm'}" data-order-side="${al.type}" data-order-symbol="${escapeHtml(al.symbol)}">
          ${al.type === 'SELL' ? 'Parduoti' : '⚡ Pirkti dar'}
        </button>
      </div>
    `
      )
      .join('');
  }

  function renderBacktestChart() {
    const bt = state.marketData.backtest12m;
    const container = document.getElementById('backtest-chart-container');
    if (!bt || !bt.smartCurve?.length || !container) return;

    document.getElementById('bt-smart-val').textContent = fmtEur(bt.finalSmartEur);
    document.getElementById('bt-sp-val').textContent = fmtEur(bt.finalSp500Eur);
    document.getElementById('bt-cash-val').textContent = fmtEur(bt.totalInvestedEur);

    const badge = document.getElementById('backtest-return-badge');
    badge.textContent = fmtPct(bt.smartProfitPct);
    badge.className = 'badge ' + (bt.smartProfitPct >= 0 ? 'badge-buy' : 'badge-sell');

    const w = 680;
    const h = 210;
    const pad = { top: 14, right: 16, bottom: 26, left: 48 };
    const allVals = [...bt.smartCurve, ...bt.sp500Curve, ...bt.cashCurve];
    const minV = Math.min(...allVals) * 0.94;
    const maxV = Math.max(...allVals) * 1.04;
    const count = bt.smartCurve.length;

    const xAt = (i) => pad.left + (i / Math.max(1, count - 1)) * (w - pad.left - pad.right);
    const yAt = (v) => pad.top + (1 - (v - minV) / Math.max(1, maxV - minV)) * (h - pad.top - pad.bottom);

    const toPath = (arr) => arr.map((v, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(' ');
    const smartPath = toPath(bt.smartCurve);
    const spPath = toPath(bt.sp500Curve);
    const cashPath = toPath(bt.cashCurve);
    const areaPath = `${smartPath} L${xAt(count - 1).toFixed(1)},${(h - pad.bottom).toFixed(1)} L${xAt(0).toFixed(1)},${(h - pad.bottom).toFixed(1)} Z`;

    const yTicks = [minV, (minV + maxV) / 2, maxV];

    container.innerHTML = `
      <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="12 mėnesių investavimo grąžos grafikas">
        <defs>
          <linearGradient id="btAreaGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--emerald)" stop-opacity="0.24" />
            <stop offset="100%" stop-color="var(--emerald)" stop-opacity="0.0" />
          </linearGradient>
        </defs>
        ${yTicks
          .map(
            (tv) => `
          <line x1="${pad.left}" y1="${yAt(tv).toFixed(1)}" x2="${w - pad.right}" y2="${yAt(tv).toFixed(1)}" stroke="var(--border-subtle)" stroke-dasharray="3 3" />
          <text x="${pad.left - 6}" y="${(yAt(tv) + 4).toFixed(1)}" text-anchor="end" fill="var(--text-muted)" font-size="10" font-family="var(--font-mono)">${Math.round(tv)}€</text>
        `
          )
          .join('')}
        <path d="${areaPath}" fill="url(#btAreaGrad)" />
        <path d="${cashPath}" fill="none" stroke="var(--text-muted)" stroke-width="1.5" stroke-dasharray="4 4" />
        <path d="${spPath}" fill="none" stroke="var(--sky)" stroke-width="2" />
        <path d="${smartPath}" fill="none" stroke="var(--emerald)" stroke-width="2.6" />
        ${bt.labels
          .filter((_, idx) => idx % 3 === 0 || idx === count - 1)
          .map((lbl) => {
            const origIdx = bt.labels.indexOf(lbl);
            return `<text x="${xAt(origIdx).toFixed(1)}" y="${h - 6}" text-anchor="middle" fill="var(--text-muted)" font-size="10" font-family="var(--font-mono)">${lbl}</text>`;
          })
          .join('')}
      </svg>
    `;
  }

  function renderSignalsList() {
    const grid = document.getElementById('all-signals-grid');
    if (!grid || !state.marketData) return;
    const q = state.searchQuery.toLowerCase();

    const filtered = state.marketData.assets.filter((a) => {
      if (state.signalFilter === 'BUY' && a.signal !== 'STRONG_BUY' && a.signal !== 'BUY_DCA') return false;
      if (state.signalFilter === 'ETF' && a.category !== 'ETF') return false;
      if (state.signalFilter === 'STOCK' && a.category !== 'Akcija') return false;
      if (state.signalFilter === 'SELL' && a.signal !== 'TRIM_SELL' && a.rsi14 < 68) return false;
      if (q) {
        const hay = `${a.symbol} ${a.name} ${a.shortName} ${a.subCategory}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    if (!filtered.length) {
      grid.innerHTML = `<p style="color: var(--text-secondary); font-size: 0.88rem;">Pagal pasirinktą filtrą aktyvų nerasta.</p>`;
      return;
    }

    grid.innerHTML = filtered.map(renderAssetCardHtml).join('');
  }

  function computeDynamicPlanItems(overrideBudget) {
    const basePlan = state.marketData?.allocationPlans?.[state.plannerProfile];
    if (!basePlan) return [];
    const budget = overrideBudget ?? state.plannerBudget;
    return basePlan.items.map((it) => {
      const liveAsset = state.marketData.assets.find((a) => a.symbol === it.symbol);
      const px = liveAsset ? liveAsset.priceEur : it.priceEur;
      const eurAmt = Number(((budget * it.pct) / 100).toFixed(2));
      const estShares = px > 0 ? Number((eurAmt / px).toFixed(4)) : 0;
      return {
        ...it,
        priceEur: px,
        amountEur: eurAmt,
        estShares,
      };
    });
  }

  function renderPlanner() {
    const valLbl = document.getElementById('planner-budget-val');
    const slider = document.getElementById('planner-budget-range');
    const list = document.getElementById('planner-alloc-list');
    if (!list || !state.marketData) return;

    valLbl.textContent = `${state.plannerBudget} €`;
    slider.value = String(state.plannerBudget);

    const items = computeDynamicPlanItems();
    list.innerHTML = items
      .map(
        (item) => `
      <div class="alloc-row">
        <div class="alloc-left">
          <strong>${escapeHtml(item.shortName)} <span class="asset-ticker">${escapeHtml(item.symbol)}</span> (${item.pct}%)</strong>
          <p>${escapeHtml(item.rationale)}</p>
        </div>
        <div class="alloc-right" style="display: flex; align-items: center; gap: 10px;">
          <div>
            <span class="alloc-eur">${fmtEur(item.amountEur)}</span>
            <span class="alloc-shares">~${item.estShares} vnt.</span>
          </div>
          <button type="button" class="btn-buy-sm" data-order-side="BUY" data-order-symbol="${escapeHtml(item.symbol)}">Pirkti</button>
        </div>
      </div>
    `
      )
      .join('');
  }

  function addPurchaseToPortfolio(symbol, eurAmount, buyPriceEur) {
    const asset = state.marketData?.assets?.find((a) => a.symbol === symbol);
    const shortName = asset ? asset.shortName : symbol;
    const shares = eurAmount / buyPriceEur;

    const existing = state.portfolio.find((p) => p.symbol === symbol);
    if (existing) {
      const newInvested = existing.investedEur + eurAmount;
      const newShares = existing.shares + shares;
      existing.investedEur = Number(newInvested.toFixed(2));
      existing.shares = newShares;
      existing.avgPriceEur = Number((newInvested / newShares).toFixed(2));
      existing.updatedAt = new Date().toISOString().slice(0, 10);
    } else {
      state.portfolio.push({
        id: `${symbol}-${Date.now()}`,
        symbol,
        shortName,
        shares,
        avgPriceEur: Number(buyPriceEur.toFixed(2)),
        investedEur: Number(eurAmount.toFixed(2)),
        updatedAt: new Date().toISOString().slice(0, 10),
      });
    }

    const ym = currentYearMonth();
    state.spentLog[ym] = Number(((state.spentLog[ym] || 0) + eurAmount).toFixed(2));
    saveLocalState();
    renderAll();
  }

  function sellFromPortfolioByEur(symbol, eurAmount, curPriceEur) {
    const pos = state.portfolio.find((p) => p.symbol === symbol);
    if (!pos) return;
    const curVal = pos.shares * curPriceEur;
    if (eurAmount >= curVal * 0.96) {
      state.portfolio = state.portfolio.filter((p) => p.symbol !== symbol);
    } else {
      const ratio = Math.max(0, (curVal - eurAmount) / curVal);
      pos.shares *= ratio;
      pos.investedEur = Number((pos.investedEur * ratio).toFixed(2));
    }
    saveLocalState();
    renderAll();
  }

  function renderPortfolioAndAutopilot() {
    // Jei prijungtas Trading 212 / Alpaca debesies modulis — parodome gyvą suvestinę
    const cloudCard = document.getElementById('cloud-broker-sync-card');
    if (cloudCard) {
      if (state.cloudBrokerState?.brokerConnected) {
        cloudCard.style.display = 'block';
        cloudCard.innerHTML = `
          <div style="display: flex; justify-content: space-between; align-items: center; gap: 10px;">
            <div>
              <span class="eyebrow">Prijungta brokerio sąskaita</span>
              <strong style="font-size: 1rem;">${escapeHtml(state.cloudBrokerState.brokerName)}</strong>
            </div>
            <span class="badge badge-buy">SINCHRONIZUOTA (${escapeHtml(state.cloudBrokerState.updatedAtLt)})</span>
          </div>
          <div class="kpi-strip" style="margin-top: 10px;">
            <div class="kpi-cell"><span class="kpi-label">Bendra vertė</span><span class="kpi-val">${fmtEur(state.cloudBrokerState.accountTotalEur)}</span></div>
            <div class="kpi-cell"><span class="kpi-label">Laisvi pinigai</span><span class="kpi-val">${fmtEur(state.cloudBrokerState.availableCashEur)}</span></div>
            <div class="kpi-cell"><span class="kpi-label">Šį mėn. pirkta</span><span class="kpi-val">${fmtEur(state.cloudBrokerState.spentThisMonthEur)}</span></div>
            <div class="kpi-cell"><span class="kpi-label">Pozicijos</span><span class="kpi-val">${(state.cloudBrokerState.positions || []).length}</span></div>
          </div>
        `;
      } else {
        cloudCard.style.display = 'none';
      }
    }

    const pfList = document.getElementById('pf-holdings-list');
    let totalInvested = 0;
    let totalCurrent = 0;

    if (!state.portfolio.length) {
      pfList.innerHTML = `<p style="color: var(--text-secondary); font-size: 0.85rem; margin: 4px 0;">Jūsų portfelyje dar nėra rankiniu būdu nupirktų pozicijų. Spauskite <strong>„⚡ Pirkti“</strong> ant bet kurios akcijos ar ETF!</p>`;
    } else {
      pfList.innerHTML = state.portfolio
        .map((pos) => {
          const live = state.marketData?.assets?.find((a) => a.symbol === pos.symbol);
          const curPx = live ? live.priceEur : pos.avgPriceEur;
          const curVal = pos.shares * curPx;
          const pnlEur = curVal - pos.investedEur;
          const pnlPct = pos.investedEur > 0 ? (pnlEur / pos.investedEur) * 100 : 0;

          totalInvested += pos.investedEur;
          totalCurrent += curVal;

          let actionHint = `<span class="badge badge-hold">LAIKYTI</span>`;
          if (live && (live.signal === 'TRIM_SELL' || live.rsi14 >= 74 || pnlPct >= 22)) {
            actionHint = `<span class="badge badge-sell">PARDUOTI DALĮ</span>`;
          } else if (live && live.signal === 'STRONG_BUY') {
            actionHint = `<span class="badge badge-buy">PAPILDYTI</span>`;
          }

          return `
            <div class="holding-row">
              <div style="min-width: 0;">
                <div style="display: flex; align-items: center; gap: 7px; flex-wrap: wrap;">
                  <strong style="cursor: pointer;" data-chart-symbol="${escapeHtml(pos.symbol)}">${escapeHtml(pos.shortName)}</strong>
                  <span class="asset-ticker">${escapeHtml(pos.symbol)}</span>
                  ${actionHint}
                </div>
                <div class="mono" style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 3px;">
                  ${pos.shares.toFixed(4)} vnt. • Vid. kaina: ${fmtEur(pos.avgPriceEur)} • Dabar: ${fmtEur(curPx)}
                </div>
              </div>
              <div style="text-align: right; flex-shrink: 0;">
                <div class="mono" style="font-weight: 700;">${fmtEur(curVal)}</div>
                <div class="mono ${pnlEur >= 0 ? 'pos' : 'neg'}" style="font-size: 0.76rem;">
                  ${pnlEur >= 0 ? '+' : ''}${fmtEur(pnlEur)} (${fmtPct(pnlPct)})
                </div>
                <div style="display: flex; gap: 5px; justify-content: flex-end; margin-top: 5px;">
                  <button type="button" class="btn-buy-sm" style="padding: 4px 8px; font-size: 0.72rem;" data-order-side="BUY" data-order-symbol="${escapeHtml(pos.symbol)}">+ Pirkti</button>
                  <button type="button" class="btn-sell-sm" style="padding: 4px 8px; font-size: 0.72rem;" data-order-side="SELL" data-order-symbol="${escapeHtml(pos.symbol)}">Parduoti</button>
                </div>
              </div>
            </div>
          `;
        })
        .join('');
    }

    const totalPnl = totalCurrent - totalInvested;
    const totalPnlPct = totalInvested > 0 ? (totalPnl / totalInvested) * 100 : 0;
    document.getElementById('pf-current-val').textContent = fmtEur(totalCurrent);
    document.getElementById('pf-invested-val').textContent = fmtEur(totalInvested);
    const pnlEl = document.getElementById('pf-pnl-eur');
    pnlEl.textContent = (totalPnl >= 0 ? '+' : '') + fmtEur(totalPnl);
    pnlEl.className = 'kpi-val ' + (totalPnl >= 0 ? 'pos' : 'neg');
    const pctEl = document.getElementById('pf-pnl-pct');
    pctEl.textContent = fmtPct(totalPnlPct);
    pctEl.className = 'kpi-val ' + (totalPnlPct >= 0 ? 'pos' : 'neg');

    // Autopilotas
    document.getElementById('toggle-autopilot').checked = Boolean(state.autopilot.enabled);
    let botHoldingsVal = 0;
    const botHoldEl = document.getElementById('bot-holdings-list');
    const activeBotHoldings = state.autopilot.holdings.filter((h) => h.shares > 0.0001);

    if (!activeBotHoldings.length) {
      botHoldEl.innerHTML = `<p style="font-size: 0.82rem; color: var(--text-secondary);">Robotas dar neatidarė pozicijų.</p>`;
    } else {
      botHoldEl.innerHTML = activeBotHoldings
        .map((h) => {
          const live = state.marketData?.assets?.find((a) => a.symbol === h.symbol);
          const px = live ? live.priceEur : h.avgPriceEur;
          const val = h.shares * px;
          const diff = val - h.shares * h.avgPriceEur;
          botHoldingsVal += val;
          return `
            <div class="holding-row">
              <div>
                <strong>${escapeHtml(h.shortName)}</strong> <span class="asset-ticker">${escapeHtml(h.symbol)}</span>
                <div class="mono" style="font-size: 0.74rem; color: var(--text-secondary);">${h.shares.toFixed(4)} vnt. @ ${fmtEur(h.avgPriceEur)}</div>
              </div>
              <div style="text-align: right;" class="mono">
                <strong>${fmtEur(val)}</strong>
                <div class="${diff >= 0 ? 'pos' : 'neg'}" style="font-size: 0.74rem;">${diff >= 0 ? '+' : ''}${fmtEur(diff)}</div>
              </div>
            </div>
          `;
        })
        .join('');
    }

    const botTotal = botHoldingsVal + state.autopilot.cashEur;
    const botProfit = botTotal - state.autopilot.totalDepositedEur;
    document.getElementById('bot-total-val').textContent = fmtEur(botTotal);
    document.getElementById('bot-cash-val').textContent = fmtEur(state.autopilot.cashEur);
    const botPnlEl = document.getElementById('bot-pnl-val');
    botPnlEl.textContent = (botProfit >= 0 ? '+' : '') + fmtEur(botProfit);
    botPnlEl.className = 'kpi-val ' + (botProfit >= 0 ? 'pos' : 'neg');
    document.getElementById('bot-trades-count').textContent = String(state.autopilot.logs.length);

    const logEl = document.getElementById('bot-log-list');
    logEl.innerHTML = state.autopilot.logs
      .slice(0, 10)
      .map(
        (l) => `
        <div style="padding: 7px 0; border-bottom: 1px solid var(--border-subtle); font-size: 0.79rem; display: flex; justify-content: space-between; gap: 10px;">
          <span><strong>${escapeHtml(l.action)}:</strong> ${escapeHtml(l.detail)}</span>
          <span class="mono" style="color: var(--text-muted); white-space: nowrap;">${escapeHtml(l.ts)}</span>
        </div>
      `
      )
      .join('');
  }

  function populatePositionSelect() {
    const sel = document.getElementById('add-pos-symbol');
    const priceInput = document.getElementById('add-pos-price');
    if (!sel || !state.marketData) return;

    const curVal = sel.value;
    sel.innerHTML = state.marketData.assets
      .map(
        (a) =>
          `<option value="${escapeHtml(a.symbol)}">${escapeHtml(a.shortName)} (${escapeHtml(a.symbol)}) — ${fmtEur(a.priceEur)}</option>`
      )
      .join('');

    if (curVal && state.marketData.assets.some((a) => a.symbol === curVal)) {
      sel.value = curVal;
    }
    const chosen = state.marketData.assets.find((a) => a.symbol === sel.value) || state.marketData.assets[0];
    if (chosen && priceInput && !priceInput.dataset.touched) {
      priceInput.value = chosen.priceEur.toFixed(2);
    }
  }

  function syncSettingsInputs() {
    document.getElementById('settings-monthly-cap').value = String(state.settings.monthlyCapEur || 100);
    document.getElementById('tg-bot-token').value = state.settings.tgToken || '';
    document.getElementById('tg-chat-id').value = state.settings.tgChatId || '';
    document.getElementById('gh-dispatch-token').value = state.settings.ghDispatchToken || '';
    document.getElementById('alpaca-key').value = state.settings.alpacaKey || '';
    document.getElementById('alpaca-secret').value = state.settings.alpacaSecret || '';
    document.getElementById('alpaca-env').value = state.settings.alpacaEnv || 'paper';
  }

  // --- Aktyvo 90 d. grafiko langas ---
  function openAssetModal(symbol) {
    const asset = state.marketData?.assets?.find((a) => a.symbol === symbol);
    if (!asset) return;

    const modal = document.getElementById('asset-modal');
    const body = document.getElementById('asset-modal-body');

    const chart = asset.chart || { pricesEur: [], sma50Eur: [], sma200Eur: [], dates: [], markers: [] };
    const prices = chart.pricesEur;
    const s50 = chart.sma50Eur;
    const s200 = chart.sma200Eur;
    const w = 600;
    const h = 195;
    const pad = { top: 12, right: 12, bottom: 24, left: 46 };
    const allY = [...prices, ...s50, ...s200].filter((v) => v > 0);
    const minY = Math.min(...allY) * 0.97;
    const maxY = Math.max(...allY) * 1.03;
    const cnt = prices.length;

    const xAt = (i) => pad.left + (i / Math.max(1, cnt - 1)) * (w - pad.left - pad.right);
    const yAt = (v) => pad.top + (1 - (v - minY) / Math.max(0.01, maxY - minY)) * (h - pad.top - pad.bottom);
    const pathOf = (arr) => arr.map((v, i) => `${i === 0 ? 'M' : 'L'}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(' ');

    const markersSvg = (chart.markers || [])
      .map((m) => {
        const cx = xAt(m.idx).toFixed(1);
        const cy = yAt(m.priceEur).toFixed(1);
        const col = m.type === 'BUY' ? 'var(--emerald)' : 'var(--coral)';
        return `<circle cx="${cx}" cy="${cy}" r="4.5" fill="${col}" stroke="var(--bg-surface)" stroke-width="1.5" />`;
      })
      .join('');

    body.innerHTML = `
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;">
        <div>
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
            <h2 style="margin: 0; font-size: 1.15rem;">${escapeHtml(asset.name)}</h2>
            <span class="asset-ticker">${escapeHtml(asset.symbol)}</span>
          </div>
          <p style="margin: 4px 0 0; font-size: 0.8rem; color: var(--text-secondary);">${escapeHtml(asset.thesis)}</p>
        </div>
        <button type="button" class="icon-btn" id="btn-close-modal" aria-label="Uždaryti">✕</button>
      </div>

      <div style="display: flex; align-items: baseline; justify-content: space-between; margin-top: 14px;">
        <div>
          <span class="mono" style="font-size: 1.5rem; font-weight: 700;">${fmtEur(asset.priceEur)}</span>
          <span class="mono ${asset.change1d >= 0 ? 'pos' : 'neg'}" style="font-size: 0.84rem; margin-left: 8px;">1d: ${fmtPct(asset.change1d)}</span>
        </div>
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
          <path d="${pathOf(prices)}" fill="none" stroke="var(--text-primary)" stroke-width="2.3" />
          ${markersSvg}
          <text x="${pad.left}" y="${h - 5}" fill="var(--text-muted)" font-size="10" font-family="var(--font-mono)">${chart.dates[0] || ''}</text>
          <text x="${w - pad.right}" y="${h - 5}" text-anchor="end" fill="var(--text-muted)" font-size="10" font-family="var(--font-mono)">${chart.dates[cnt - 1] || ''}</text>
        </svg>
      </div>

      <div class="levels-grid">
        <div class="level-box"><span>Pirkimo zona</span><strong class="pos">${fmtEur(asset.entryZoneEur[0])} – ${fmtEur(asset.entryZoneEur[1])}</strong></div>
        <div class="level-box"><span>Pelno tikslas</span><strong style="color: var(--sky);">${fmtEur(asset.takeProfitEur)}</strong></div>
        <div class="level-box"><span>Stop-Loss</span><strong class="neg">${fmtEur(asset.stopLossEur)}</strong></div>
      </div>

      <ul class="reasons-list">
        ${(asset.reasons || []).map((r) => `<li>${escapeHtml(r)}</li>`).join('')}
      </ul>

      <button type="button" class="btn-primary btn-block" id="btn-go-buy-from-chart">⚡ Pereiti į pirkimą (${escapeHtml(asset.shortName)})</button>
    `;

    modal.classList.add('open');
    document.getElementById('btn-close-modal').onclick = closeAssetModal;
    document.getElementById('btn-go-buy-from-chart').onclick = () => openQuickOrderSheet(symbol, 'BUY');
  }

  function closeAssetModal() {
    document.getElementById('asset-modal').classList.remove('open');
  }

  // --- Naujo simbolio pridėjimas ---
  async function handleAddCustomTicker() {
    const symInput = window.prompt('Įveskite akcijos arba ETF simbolį (pvz.: TSLA, AMD, PLTR, NOVO-B.CO):');
    if (!symInput) return;
    const sym = symInput.trim().toUpperCase();
    if (!sym) return;

    if (state.marketData?.assets?.some((a) => a.symbol.toUpperCase() === sym)) {
      openQuickOrderSheet(sym, 'BUY');
      return;
    }

    showToast(`Analizuojamas ${sym}…`);
    try {
      const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1y&interval=1d`;
      const res = await fetch(`https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`);
      const j = await res.json();
      const raw = j?.chart?.result?.[0];
      if (!raw) throw new Error('Nerasta');
      const meta = raw.meta || {};
      const tsList = raw.timestamp || [];
      const qCloses = raw.indicators?.quote?.[0]?.close || [];
      const dates = [];
      const closes = [];
      for (let i = 0; i < tsList.length; i++) {
        if (qCloses[i] != null && qCloses[i] > 0) {
          dates.push(new Date(tsList[i] * 1000).toISOString().slice(0, 10));
          closes.push(Number(qCloses[i]));
        }
      }
      const eurusd = state.marketData?.eurUsdRate || 1.09;
      const toEur = (meta.currency || 'USD') === 'EUR' ? 1 : 1 / eurusd;
      const pxEur = Number((closes[closes.length - 1] * toEur).toFixed(2));
      const built = {
        symbol: sym,
        alpacaSymbol: sym.split('.')[0],
        name: meta.longName || meta.shortName || sym,
        shortName: (meta.shortName || sym).split(' ').slice(0, 2).join(' '),
        category: (meta.instrumentType || '').includes('ETF') ? 'ETF' : 'Akcija',
        subCategory: 'Pridėtas simbolis',
        role: 'stock',
        priceEur: pxEur,
        change1d: Number((((closes[closes.length - 1] - closes[closes.length - 2]) / closes[closes.length - 2]) * 100).toFixed(2)),
        change1m: closes.length > 22 ? Number((((closes[closes.length - 1] - closes[closes.length - 22]) / closes[closes.length - 22]) * 100).toFixed(2)) : 0,
        change1y: Number((((closes[closes.length - 1] - closes[0]) / closes[0]) * 100).toFixed(2)),
        rsi14: 50.0,
        distSma200Pct: 4.5,
        drawdown52w: -5.0,
        score: 70,
        signal: 'BUY_DCA',
        signalLabel: 'PIRKTI / KAUPTI (DCA)',
        entryZoneEur: [Number((pxEur * 0.97).toFixed(2)), Number((pxEur * 1.01).toFixed(2))],
        takeProfitEur: Number((pxEur * 1.14).toFixed(2)),
        stopLossEur: Number((pxEur * 0.91).toFixed(2)),
        thesis: 'Vartotojo pridėtas aktyvas tiesioginiam pirkimui ir stebėjimui.',
        reasons: ['Aktyvas pridėtas į jūsų stebėjimo ir greito pirkimo sąrašą.'],
        chart: {
          dates: dates.slice(-90),
          pricesEur: closes.slice(-90).map((c) => Number((c * toEur).toFixed(2))),
          sma50Eur: closes.slice(-90).map((c) => Number((c * toEur).toFixed(2))),
          sma200Eur: closes.slice(-90).map((c) => Number((c * toEur * 0.96).toFixed(2))),
          markers: [],
        },
      };
      state.customSymbols.push(built);
      state.marketData.assets.push(built);
      saveLocalState();
      renderAll();
      openQuickOrderSheet(sym, 'BUY');
    } catch (_) {
      showToast(`Nepavyko nuskaityti simbolio „${sym}“.`);
    }
  }

  // --- Telegram ---
  async function sendTelegramMessage(htmlText) {
    const token = state.settings.tgToken.trim();
    const chatId = state.settings.tgChatId.trim();
    if (!token || !chatId) {
      switchView('settings');
      showToast('Įveskite Telegram Bot Token ir Chat ID!');
      return false;
    }

    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: htmlText,
          parse_mode: 'HTML',
          disable_web_page_preview: true,
        }),
      });
      const data = await res.json();
      if (!data.ok) throw new Error(data.description || 'Telegram klaida');
      showToast('Žinutė sėkmingai išsiųsta į jūsų Telegram!');
      return true;
    } catch (err) {
      showToast(`Telegram klaida: ${err.message}`);
      return false;
    }
  }

  function buildTelegramReportHtml() {
    const ov = state.marketData.marketOverview;
    const top3 = state.marketData.assets.slice(0, 3);
    const items = computeDynamicPlanItems();
    return [
      `📊 <b>InvestPulsas • Asmeninė ataskaita</b>`,
      `Rinkos režimas: <b>${ov.regimeLabel}</b>`,
      ``,
      `🟢 <b>Geriausi aktyvai pirkimui:</b>`,
      ...top3.map((a) => `• <b>${a.shortName}</b> (${a.symbol}) — ${fmtEur(a.priceEur)} | Balas ${a.score}/100`),
      ``,
      `💶 <b>Jūsų ${state.plannerBudget} € krepšelis:</b>`,
      ...items.map((i) => `• <b>${fmtEur(i.amountEur)}</b> → ${i.shortName} (${i.pct}%)`),
    ].join('\n');
  }

  // --- Navigacija ir įvykių susiejimas ---
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

  function syncAutopilotToggle(checked) {
    state.autopilot.enabled = checked;
    saveLocalState();
    renderAll();
    showToast(checked ? '🤖 Automatinis pirkimas (Autopilotas) įjungtas!' : 'Automatinis pirkimas pristabdytas');
  }

  function bindEvents() {
    document.querySelectorAll('[data-view]').forEach((btn) => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });

    document.getElementById('btn-goto-planner').addEventListener('click', () => switchView('planner'));
    document.getElementById('btn-see-all-signals').addEventListener('click', () => switchView('signals'));
    document.getElementById('btn-home-connect-broker').addEventListener('click', () => switchView('settings'));
    document.getElementById('btn-home-auto-buy-now').addEventListener('click', () => runAutopilotCycle(false));

    document.getElementById('home-toggle-autopilot').addEventListener('change', (e) => {
      syncAutopilotToggle(e.target.checked);
    });
    document.getElementById('toggle-autopilot').addEventListener('change', (e) => {
      syncAutopilotToggle(e.target.checked);
    });

    document.getElementById('btn-theme-toggle').addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme') || 'dark';
      applyTheme(cur === 'dark' ? 'light' : 'dark');
    });

    document.getElementById('btn-live-refresh').addEventListener('click', handleLiveRefresh);

    document.getElementById('signal-filter-chips').addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (!chip) return;
      state.signalFilter = chip.dataset.filter;
      document.querySelectorAll('#signal-filter-chips .chip').forEach((c) => c.classList.toggle('active', c === chip));
      renderSignalsList();
    });

    document.getElementById('signal-search-input').addEventListener('input', (e) => {
      state.searchQuery = e.target.value || '';
      renderSignalsList();
    });

    document.getElementById('btn-add-custom-ticker').addEventListener('click', handleAddCustomTicker);

    // Visi Pirkti / Parduoti / Grafikas paspaudimai
    document.body.addEventListener('click', (e) => {
      const orderBtn = e.target.closest('[data-order-symbol]');
      if (orderBtn) {
        e.stopPropagation();
        openQuickOrderSheet(orderBtn.dataset.orderSymbol, orderBtn.dataset.orderSide || 'BUY');
        return;
      }

      const chartBtn = e.target.closest('[data-chart-symbol]');
      if (chartBtn) {
        e.stopPropagation();
        openAssetModal(chartBtn.dataset.chartSymbol);
        return;
      }

      const card = e.target.closest('.asset-card[data-symbol]');
      if (card) {
        openQuickOrderSheet(card.dataset.symbol, 'BUY');
      }
    });

    document.getElementById('asset-modal').addEventListener('click', (e) => {
      if (e.target.id === 'asset-modal') closeAssetModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeAssetModal();
    });

    // 100 € krepšelis
    document.getElementById('planner-budget-range').addEventListener('input', (e) => {
      state.plannerBudget = Number(e.target.value) || 100;
      renderPlanner();
    });

    document.getElementById('planner-profile-selector').addEventListener('click', (e) => {
      const btn = e.target.closest('.profile-btn');
      if (!btn) return;
      state.plannerProfile = btn.dataset.profile;
      document.querySelectorAll('#planner-profile-selector .profile-btn').forEach((b) => b.classList.toggle('active', b === btn));
      renderPlanner();
    });

    document.getElementById('btn-apply-plan-portfolio').addEventListener('click', async () => {
      const items = computeDynamicPlanItems();
      for (const it of items) {
        await executeTradeOrder(it.symbol, 'BUY', it.amountEur);
      }
      switchView('portfolio');
    });

    document.getElementById('btn-send-plan-telegram').addEventListener('click', () => {
      sendTelegramMessage(buildTelegramReportHtml());
    });

    // Portfelio kortelės
    const tabReal = document.getElementById('tab-real-portfolio');
    const tabBot = document.getElementById('tab-autopilot');
    const panelReal = document.getElementById('panel-real-portfolio');
    const panelBot = document.getElementById('panel-autopilot');

    tabReal.addEventListener('click', () => {
      tabReal.classList.add('active');
      tabBot.classList.remove('active');
      panelReal.style.display = 'block';
      panelBot.style.display = 'none';
    });

    tabBot.addEventListener('click', () => {
      tabBot.classList.add('active');
      tabReal.classList.remove('active');
      panelBot.style.display = 'block';
      panelReal.style.display = 'none';
    });

    document.getElementById('add-pos-symbol').addEventListener('change', (e) => {
      const chosen = state.marketData?.assets?.find((a) => a.symbol === e.target.value);
      if (chosen) document.getElementById('add-pos-price').value = chosen.priceEur.toFixed(2);
    });

    document.getElementById('form-add-position').addEventListener('submit', async (e) => {
      e.preventDefault();
      const sym = document.getElementById('add-pos-symbol').value;
      const eur = Number(document.getElementById('add-pos-eur').value);
      if (!sym || eur <= 0) return;
      await executeTradeOrder(sym, 'BUY', eur);
    });

    document.getElementById('btn-bot-run-cycle').addEventListener('click', () => runAutopilotCycle(false));

    document.getElementById('btn-bot-reset').addEventListener('click', () => {
      const cap = state.settings.monthlyCapEur || 100;
      state.autopilot = {
        enabled: true,
        cashEur: cap,
        totalDepositedEur: cap,
        lastDepositMonth: currentYearMonth(),
        holdings: [],
        logs: [],
      };
      runAutopilotCycle(true);
      saveLocalState();
      renderAll();
      showToast('Autopiloto simuliacija perkrauta su 100 € biudžetu!');
    });

    // Brokerio ir Telegram nustatymai
    document.getElementById('btn-save-gh-token').addEventListener('click', () => {
      state.settings.ghDispatchToken = document.getElementById('gh-dispatch-token').value.trim();
      saveLocalState();
      showToast('GitHub Actions raktas išsaugotas tiesioginiams Trading 212 pavedimams!');
    });

    document.getElementById('btn-save-test-alpaca').addEventListener('click', async () => {
      state.settings.alpacaKey = document.getElementById('alpaca-key').value.trim();
      state.settings.alpacaSecret = document.getElementById('alpaca-secret').value.trim();
      state.settings.alpacaEnv = document.getElementById('alpaca-env').value;
      saveLocalState();
      await testAndLoadAlpacaAccount(false);
    });

    document.getElementById('btn-save-test-telegram').addEventListener('click', () => {
      state.settings.tgToken = document.getElementById('tg-bot-token').value.trim();
      state.settings.tgChatId = document.getElementById('tg-chat-id').value.trim();
      saveLocalState();
      if (state.marketData) sendTelegramMessage(buildTelegramReportHtml());
    });

    document.getElementById('btn-save-cap').addEventListener('click', () => {
      const v = Math.max(10, Number(document.getElementById('settings-monthly-cap').value) || 100);
      state.settings.monthlyCapEur = v;
      state.plannerBudget = Math.min(300, v);
      saveLocalState();
      renderAll();
      showToast(`Mėnesio limitas išsaugotas: ${v} €`);
    });

    document.getElementById('btn-export-data').addEventListener('click', () => {
      const payload = {
        exportedAt: new Date().toISOString(),
        portfolio: state.portfolio,
        spentLog: state.spentLog,
        autopilot: state.autopilot,
        settings: { monthlyCapEur: state.settings.monthlyCapEur },
        customSymbols: state.customSymbols,
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
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
          if (parsed.spentLog) state.spentLog = parsed.spentLog;
          if (parsed.autopilot) state.autopilot = { ...state.autopilot, ...parsed.autopilot };
          saveLocalState();
          renderAll();
          showToast('Portfelio duomenys atkurti!');
        } catch (_) {
          showToast('Netinkamas JSON failas');
        }
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

  // Automatinis atsinaujinimas telefone be rankinio talpyklos valymo!
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
