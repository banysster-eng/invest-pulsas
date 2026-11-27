/* InvestPulsas — Mobilioji PWA investavimo ir rinkos analizės programa */
(function () {
  'use strict';

  const STORAGE_KEYS = {
    THEME: 'investpulsas_theme',
    PORTFOLIO: 'investpulsas_portfolio_v1',
    SPENT_LOG: 'investpulsas_monthly_spent_v1',
    AUTOPILOT: 'investpulsas_autopilot_v1',
    SETTINGS: 'investpulsas_settings_v1',
    CUSTOM_ASSETS: 'investpulsas_custom_assets_v1',
  };

  const state = {
    marketData: null,
    activeView: 'overview',
    signalFilter: 'ALL',
    searchQuery: '',
    plannerBudget: 100,
    plannerProfile: 'balanced',
    portfolio: [], // [{ id, symbol, shortName, shares, avgPriceEur, investedEur, updatedAt }]
    spentLog: {}, // { 'YYYY-MM': number }
    autopilot: {
      enabled: true,
      cashEur: 100,
      totalDepositedEur: 100,
      lastDepositMonth: '',
      holdings: [], // [{ symbol, shortName, shares, avgPriceEur }]
      logs: [], // [{ ts, action, detail }]
    },
    settings: {
      monthlyCapEur: 100,
      tgToken: '',
      tgChatId: '',
    },
    customSymbols: [],
    deferredInstallPrompt: null,
  };

  // --- Pagalbinės formatavimo funkcijos ---
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
    showToast._timer = setTimeout(() => el.classList.remove('show'), 3200);
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
    if (score <= 42) return 'var(--coral)';
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

      const st = JSON.parse(localStorage.getItem(STORAGE_KEYS.SETTINGS) || 'null');
      if (st && typeof st === 'object') {
        state.settings = { ...state.settings, ...st };
        state.plannerBudget = Number(state.settings.monthlyCapEur) || 100;
      }

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

  // --- Duomenų įkėlimas ir gyvas atnaujinimas naršyklėje ---
  async function loadMarketData() {
    try {
      const res = await fetch(`./data/market_signals.json?t=${Date.now()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      state.marketData = data;

      // Jei vartotojas buvo pridėjęs savo simbolių, prijungiame juos
      if (state.customSymbols.length > 0) {
        for (const cAsset of state.customSymbols) {
          if (!state.marketData.assets.some((a) => a.symbol === cAsset.symbol)) {
            state.marketData.assets.push(cAsset);
          }
        }
        state.marketData.assets.sort((a, b) => b.score - a.score);
      }

      ensureAutopilotInitialized();
      renderAll();
    } catch (err) {
      console.error('Klaida kraunant market_signals.json:', err);
      document.getElementById('last-updated-label').textContent = 'Nepavyko įkelti duomenų';
    }
  }

  // Techninių rodiklių perskaičiavimas naršyklėje (naujiems simboliams ir gyvam atnaujinimui)
  function analyzeClosesInBrowser(symbol, name, category, currency, dates, closes, eurusd) {
    const toEur = currency === 'EUR' ? 1.0 : 1.0 / (eurusd || 1.08);
    const n = closes.length;
    const priceNative = closes[n - 1];
    const priceEur = priceNative * toEur;

    const sma = (arr, p) => {
      if (arr.length < p) return arr[arr.length - 1];
      const slice = arr.slice(arr.length - p);
      return slice.reduce((s, v) => s + v, 0) / p;
    };

    const sma20 = sma(closes, 20);
    const sma50 = sma(closes, 50);
    const sma200 = sma(closes, Math.min(200, n));

    // RSI 14
    let gains = 0;
    let losses = 0;
    const period = Math.min(14, n - 1);
    for (let i = n - period; i < n; i++) {
      const d = closes[i] - closes[i - 1];
      if (d >= 0) gains += d;
      else losses -= d;
    }
    const rsi14 = losses === 0 ? 70 : 100 - 100 / (1 + (gains / period) / (losses / period));

    // Paprastas trendo + nuolaidos balas
    let score = 50;
    if (priceNative > sma200) score += 14;
    else score -= 8;
    if (sma50 >= sma200) score += 8;
    if (rsi14 <= 38) score += 18;
    else if (rsi14 <= 50) score += 12;
    else if (rsi14 >= 74) score -= 18;

    const chg1d = n > 1 ? ((closes[n - 1] - closes[n - 2]) / closes[n - 2]) * 100 : 0;
    const chg1m = n > 21 ? ((closes[n - 1] - closes[n - 22]) / closes[n - 22]) * 100 : 0;
    const chg1y = ((closes[n - 1] - closes[0]) / closes[0]) * 100;
    if (chg1m > 0 && rsi14 < 68) score += 6;
    score = Math.max(12, Math.min(95, Math.round(score)));

    let signal = 'HOLD';
    let signalLabel = 'LAIKYTI / STEBĖTI';
    if (rsi14 >= 75) {
      signal = 'TRIM_SELL';
      signalLabel = 'FIKSUOTI PELNĄ / PARDUOTI DALĮ';
    } else if (score >= 74) {
      signal = 'STRONG_BUY';
      signalLabel = 'STIPRUS PIRKIMAS';
    } else if (score >= 60) {
      signal = 'BUY_DCA';
      signalLabel = 'PIRKTI / KAUPTI (DCA)';
    } else if (score <= 42) {
      signal = 'TRIM_SELL';
      signalLabel = 'ATSARGIAI / MAŽINTI';
    }

    const tail = Math.min(90, n);
    const chartDates = dates.slice(n - tail);
    const chartPrices = closes.slice(n - tail).map((c) => Number((c * toEur).toFixed(2)));
    const chartSma50 = chartPrices.map((_, idx) => {
      const absIdx = n - tail + idx;
      const sub = closes.slice(Math.max(0, absIdx - 49), absIdx + 1);
      return Number(((sub.reduce((s, v) => s + v, 0) / sub.length) * toEur).toFixed(2));
    });
    const chartSma200 = chartPrices.map((_, idx) => {
      const absIdx = n - tail + idx;
      const sub = closes.slice(Math.max(0, absIdx - 199), absIdx + 1);
      return Number(((sub.reduce((s, v) => s + v, 0) / sub.length) * toEur).toFixed(2));
    });

    return {
      symbol: symbol.toUpperCase(),
      name: name || symbol.toUpperCase(),
      shortName: name ? name.split(' ').slice(0, 2).join(' ') : symbol.toUpperCase(),
      category,
      subCategory: 'Vartotojo pridėtas',
      role: category === 'ETF' ? 'growth_etf' : 'stock',
      ter: 0,
      riskLevel: 'Vidutinė–Aukšta',
      brokerHint: 'Dalinės akcijos nuo 1 €',
      thesis: 'Vartotojo įtrauktas aktyvas su tiesiogine technine analize iš rinkos duomenų.',
      currency,
      priceNative: Number(priceNative.toFixed(2)),
      priceEur: Number(priceEur.toFixed(2)),
      change1d: Number(chg1d.toFixed(2)),
      change1m: Number(chg1m.toFixed(2)),
      change1y: Number(chg1y.toFixed(2)),
      rsi14: Number(rsi14.toFixed(1)),
      sma50Eur: Number((sma50 * toEur).toFixed(2)),
      sma200Eur: Number((sma200 * toEur).toFixed(2)),
      distSma50Pct: Number((((priceNative - sma50) / sma50) * 100).toFixed(2)),
      distSma200Pct: Number((((priceNative - sma200) / sma200) * 100).toFixed(2)),
      macdRising: chg1d >= 0,
      volatilityAnnual: 24.0,
      drawdown52w: Number((((priceNative - Math.max(...closes)) / Math.max(...closes)) * 100).toFixed(2)),
      score,
      signal,
      signalLabel,
      entryZoneEur: [Number((priceEur * 0.97).toFixed(2)), Number((priceEur * 1.01).toFixed(2))],
      takeProfitEur: Number((priceEur * 1.14).toFixed(2)),
      stopLossEur: Number((priceEur * 0.91).toFixed(2)),
      reasons: [
        priceNative >= sma200
          ? 'Aktyvas prekiaujamas aukščiau 200 d. slankiojo vidurkio (augimo tendencija).'
          : 'Kaina žemiau 200 d. slankiojo vidurkio – rekomenduojamas atsargumas.',
        `Dabartinis RSI(14) rodiklis yra ${rsi14.toFixed(1)}.`,
      ],
      chart: {
        dates: chartDates,
        pricesEur: chartPrices,
        sma50Eur: chartSma50,
        sma200Eur: chartSma200,
        markers: [],
      },
    };
  }

  async function fetchYahooViaProxy(symbol) {
    const target = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1y&interval=1d`;
    const urls = [
      `https://api.allorigins.win/raw?url=${encodeURIComponent(target)}`,
      `https://corsproxy.io/?${encodeURIComponent(target)}`,
    ];
    for (const u of urls) {
      try {
        const r = await fetch(u);
        if (!r.ok) continue;
        const j = await r.json();
        const res = j?.chart?.result?.[0];
        if (res) return res;
      } catch (_) {
        // Bandomas kitas tarpinis mazgas
      }
    }
    throw new Error('Nepavyko pasiekti Yahoo Finance tiesiogiai iš naršyklės');
  }

  async function handleLiveRefresh() {
    const btn = document.getElementById('btn-live-refresh');
    btn.classList.add('spinning');
    try {
      const res = await fetch(`./data/market_signals.json?t=${Date.now()}`, { cache: 'no-store' });
      if (res.ok) {
        const fresh = await res.json();
        state.marketData = fresh;
        for (const cAsset of state.customSymbols) {
          if (!state.marketData.assets.some((a) => a.symbol === cAsset.symbol)) {
            state.marketData.assets.push(cAsset);
          }
        }
        state.marketData.assets.sort((a, b) => b.score - a.score);
      }
      renderAll();
      showToast('Rinkos signalai ir kainos atnaujintos!');
    } catch (_) {
      showToast('Naudojami paskutiniai išsaugoti rinkos duomenys');
    } finally {
      setTimeout(() => btn.classList.remove('spinning'), 450);
    }
  }

  async function handleAddCustomTicker() {
    const symInput = window.prompt(
      'Įveskite akcijos arba ETF simbolį iš Yahoo Finance (pvz.: TSLA, AMD, PLTR, NOVO-B.CO):'
    );
    if (!symInput) return;
    const sym = symInput.trim().toUpperCase();
    if (!sym) return;

    if (state.marketData?.assets?.some((a) => a.symbol.toUpperCase() === sym)) {
      showToast(`${sym} jau yra analizuojamų aktyvų sąraše!`);
      openAssetModal(sym);
      return;
    }

    showToast(`Analizuojamas ${sym}…`);
    try {
      const raw = await fetchYahooViaProxy(sym);
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
      if (closes.length < 20) throw new Error('Per mažai istorinių duomenų');
      const isEtf = (meta.instrumentType || '').toUpperCase().includes('ETF');
      const built = analyzeClosesInBrowser(
        sym,
        meta.shortName || meta.longName || sym,
        isEtf ? 'ETF' : 'Akcija',
        meta.currency || 'USD',
        dates,
        closes,
        state.marketData?.eurUsdRate || 1.08
      );
      state.customSymbols.push(built);
      state.marketData.assets.push(built);
      state.marketData.assets.sort((a, b) => b.score - a.score);
      saveLocalState();
      renderAll();
      openAssetModal(built.symbol);
      showToast(`${built.shortName} (${built.symbol}) sėkmingai pridėtas!`);
    } catch (err) {
      console.warn(err);
      showToast(`Nepavyko rasti arba nuskaityti simbolio „${sym}“. Patikrinkite tikslų kodą.`);
    }
  }

  // --- Virtualaus Autopiloto (Roboto) logika ---
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
      // Naujas mėnuo — pridedamas naujas 100 € mėnesinis limitas
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

  function runAutopilotCycle(silent = false) {
    if (!state.marketData?.assets?.length) return;
    const assets = state.marketData.assets;
    const nowStr = new Date().toLocaleString('lt-LT', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    let actionsCount = 0;

    // 1. Patikriname ar kurią turimą roboto poziciją reikia parduoti (RSI >= 75 arba TRIM_SELL)
    for (let i = state.autopilot.holdings.length - 1; i >= 0; i--) {
      const h = state.autopilot.holdings[i];
      const live = assets.find((a) => a.symbol === h.symbol);
      if (!live) continue;
      const pnlPct = ((live.priceEur - h.avgPriceEur) / h.avgPriceEur) * 100;
      if (live.signal === 'TRIM_SELL' || live.rsi14 >= 75 || pnlPct >= 25) {
        const sellShares = h.shares * 0.5;
        const proceeds = Number((sellShares * live.priceEur).toFixed(2));
        h.shares -= sellShares;
        state.autopilot.cashEur = Number((state.autopilot.cashEur + proceeds).toFixed(2));
        state.autopilot.logs.unshift({
          ts: nowStr,
          action: 'AUTO PARDAVIMAS (50%)',
          detail: `${h.shortName} už ${fmtEur(proceeds)} (RSI ${live.rsi14}, pelno fiksavimas)`,
        });
        actionsCount++;
      }
    }

    // 2. Jei yra bent 15 € laisvų lėšų, automatiškai investuojame į geriausią ETF + geriausią akciją/ETF
    if (state.autopilot.cashEur >= 15) {
      const budget = state.autopilot.cashEur;
      const sorted = [...assets].sort((a, b) => b.score - a.score);
      const corePick = sorted.find((a) => a.category === 'ETF' && a.signal !== 'TRIM_SELL') || sorted[0];
      const tacPick = sorted.find((a) => a.symbol !== corePick.symbol && a.signal !== 'TRIM_SELL') || sorted[1] || corePick;

      const legs = [
        { asset: corePick, eur: Number((budget * 0.55).toFixed(2)) },
        { asset: tacPick, eur: Number((budget * 0.45).toFixed(2)) },
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

    state.autopilot.logs = state.autopilot.logs.slice(0, 25);
    saveLocalState();
    renderPortfolioAndAutopilot();

    if (!silent) {
      if (actionsCount > 0) {
        showToast(`Autopilotas įvykdė ${actionsCount} sandorius!`);
      } else {
        showToast('Šio mėnesio 100 € biudžetas jau optimaliai įdarbintas — pardavimo signalų nėra.');
      }
    }
  }

  // --- Atvaizdavimo (Render) funkcijos ---
  function renderAll() {
    if (!state.marketData) return;
    renderHeaderStatus();
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

  function renderAssetCardHtml(asset) {
    const chgClass = asset.change1m >= 0 ? 'pos' : 'neg';
    const reasonText = asset.reasons?.[0] || asset.thesis;
    return `
      <article class="asset-card" data-symbol="${escapeHtml(asset.symbol)}" tabindex="0" role="button" aria-label="Atidaryti ${escapeHtml(asset.shortName)} analizę">
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
          <div class="score-meter" title="Investicinis patrauklumo balas ${asset.score} iš 100">
            <span class="score-num" style="color: ${scoreColor(asset.score)};">${asset.score}/100</span>
            <div class="score-bar"><span style="width: ${asset.score}%; background: ${scoreColor(asset.score)};"></span></div>
          </div>
        </div>

        <div class="asset-reason-preview">
          <span>${escapeHtml(reasonText)}</span>
          <span class="mono" style="color: var(--emerald); font-size: 0.75rem; flex-shrink: 0;">Grafikas →</span>
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

    // Mėnesio biudžeto termometras
    const ym = currentYearMonth();
    const spent = Number(state.spentLog[ym] || 0);
    const cap = Number(state.settings.monthlyCapEur || 100);
    const remaining = Math.max(0, cap - spent);
    const pct = Math.min(100, Math.round((spent / cap) * 100));

    document.getElementById('month-spent-label').textContent = fmtEur(spent);
    document.getElementById('month-limit-label').textContent = `${cap} €`;
    document.getElementById('month-remaining-hint').textContent =
      spent >= cap
        ? `Šio mėnesio ${cap} € limitas pasiektas! Kitas pirkimų biudžetas kitą mėnesį.`
        : `Liko ${fmtEur(remaining)} investavimui šį mėnesį`;

    const fill = document.getElementById('month-progress-fill');
    fill.style.width = `${pct}%`;
    fill.className = 'progress-fill' + (pct >= 100 ? ' over' : pct >= 80 ? ' warn' : '');

    // Top 4 pasiūlymai
    const topGrid = document.getElementById('top-picks-grid');
    const top4 = state.marketData.assets.slice(0, 4);
    topGrid.innerHTML = top4.map(renderAssetCardHtml).join('');

    const allBtn = document.getElementById('btn-see-all-signals');
    if (allBtn) allBtn.textContent = `Visi (${state.marketData.assets.length})`;

    // Asmeniniai įspėjimai turimoms pozicijoms
    renderPersonalAlerts();

    // 12 mėn. backtesto grafikas
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
          msg: `Rekomenduojama fiksuoti dalį pelno (${fmtPct(pnlPct)}, RSI ${live.rsi14}). Tikslinė riba: ${fmtEur(live.takeProfitEur)}.`,
        });
      } else if (live.signal === 'STRONG_BUY') {
        alerts.push({
          type: 'BUY',
          symbol: pos.symbol,
          shortName: pos.shortName,
          msg: `Stiprus papildymo signalas (balas ${live.score}/100, RSI ${live.rsi14}) — gera kaina vidurkinimui.`,
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
      <div class="alloc-row" style="margin-bottom: 8px; cursor: pointer;" data-symbol="${escapeHtml(al.symbol)}">
        <div class="alloc-left">
          <strong>${escapeHtml(al.shortName)} (${escapeHtml(al.symbol)})</strong>
          <p>${escapeHtml(al.msg)}</p>
        </div>
        <span class="badge ${al.type === 'SELL' ? 'badge-sell' : 'badge-buy'}">${al.type === 'SELL' ? 'FIKSUOTI PELNĄ' : 'PAPILDYTI'}</span>
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

  function computeDynamicPlanItems() {
    const basePlan = state.marketData?.allocationPlans?.[state.plannerProfile];
    if (!basePlan) return [];
    const budget = state.plannerBudget;
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
      <div class="alloc-row" data-symbol="${escapeHtml(item.symbol)}" style="cursor: pointer;">
        <div class="alloc-left">
          <strong>${escapeHtml(item.shortName)} <span class="asset-ticker">${escapeHtml(item.symbol)}</span> (${item.pct}%)</strong>
          <p>${escapeHtml(item.rationale)}</p>
        </div>
        <div class="alloc-right">
          <span class="alloc-eur">${fmtEur(item.amountEur)}</span>
          <span class="alloc-shares">~${item.estShares} vnt. @ ${fmtEur(item.priceEur)}</span>
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

  function renderPortfolioAndAutopilot() {
    // 1. Realus portfelis
    const pfList = document.getElementById('pf-holdings-list');
    let totalInvested = 0;
    let totalCurrent = 0;

    if (!state.portfolio.length) {
      pfList.innerHTML = `<p style="color: var(--text-secondary); font-size: 0.85rem; margin: 4px 0;">Jūsų portfelis kol kas tuščias. Pridėkite pirkimą žemiau arba vienu paspaudimu iš skilties „100 € Planas“.</p>`;
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
            actionHint = `<span class="badge badge-sell">FIKSUOTI PELNĄ</span>`;
          } else if (live && live.signal === 'STRONG_BUY') {
            actionHint = `<span class="badge badge-buy">PALANKU PAPILDYTI</span>`;
          }

          return `
            <div class="holding-row">
              <div style="min-width: 0;">
                <div style="display: flex; align-items: center; gap: 7px; flex-wrap: wrap;">
                  <strong style="cursor: pointer;" data-symbol="${escapeHtml(pos.symbol)}">${escapeHtml(pos.shortName)}</strong>
                  <span class="asset-ticker">${escapeHtml(pos.symbol)}</span>
                  ${actionHint}
                </div>
                <div class="mono" style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 3px;">
                  ${pos.shares.toFixed(4)} vnt. • Vid. pirkta: ${fmtEur(pos.avgPriceEur)} • Dabar: ${fmtEur(curPx)}
                </div>
              </div>
              <div style="text-align: right; flex-shrink: 0;">
                <div class="mono" style="font-weight: 700;">${fmtEur(curVal)}</div>
                <div class="mono ${pnlEur >= 0 ? 'pos' : 'neg'}" style="font-size: 0.76rem;">
                  ${pnlEur >= 0 ? '+' : ''}${fmtEur(pnlEur)} (${fmtPct(pnlPct)})
                </div>
                <button type="button" class="btn-danger" data-sell-symbol="${escapeHtml(pos.symbol)}" style="padding: 3px 8px; font-size: 0.7rem; margin-top: 4px;">Parduoti / Šalinti</button>
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

    // 2. Virtualus Autopilotas
    document.getElementById('toggle-autopilot').checked = Boolean(state.autopilot.enabled);
    let botHoldingsVal = 0;
    const botHoldEl = document.getElementById('bot-holdings-list');
    if (!state.autopilot.holdings.length) {
      botHoldEl.innerHTML = `<p style="font-size: 0.82rem; color: var(--text-secondary);">Robotas dar neatidarė pozicijų.</p>`;
    } else {
      botHoldEl.innerHTML = state.autopilot.holdings
        .filter((h) => h.shares > 0.0001)
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
      .slice(0, 8)
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
  }

  // --- Aktyvo detalus modalinis langas su 90 d. grafiku ---
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
        return `<circle cx="${cx}" cy="${cy}" r="4.5" fill="${col}" stroke="var(--bg-surface)" stroke-width="1.5"><title>${m.date}: ${m.type === 'BUY' ? 'Pirkimo' : 'Pardavimo'} signalas @ ${m.priceEur} €</title></circle>`;
      })
      .join('');

    body.innerHTML = `
      <div style="display: flex; align-items: flex-start; justify-content: space-between; gap: 12px;">
        <div>
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
            <h2 id="modal-asset-title" style="margin: 0; font-size: 1.18rem;">${escapeHtml(asset.name)}</h2>
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
      <div class="chart-legend" style="margin-bottom: 10px;">
        <span class="legend-item"><i class="legend-swatch" style="background: var(--text-primary);"></i> Kaina (EUR)</span>
        <span class="legend-item"><i class="legend-swatch" style="background: var(--sky);"></i> 50 d. vidurkis</span>
        <span class="legend-item"><i class="legend-swatch" style="background: var(--amber);"></i> 200 d. vidurkis</span>
      </div>

      <div class="levels-grid">
        <div class="level-box">
          <span>Optimali pirkimo zona</span>
          <strong class="pos">${fmtEur(asset.entryZoneEur[0])} – ${fmtEur(asset.entryZoneEur[1])}</strong>
        </div>
        <div class="level-box">
          <span>Pelno fiksavimo tikslas</span>
          <strong style="color: var(--sky);">${fmtEur(asset.takeProfitEur)}</strong>
        </div>
        <div class="level-box">
          <span>Apsauginis Stop-Loss</span>
          <strong class="neg">${fmtEur(asset.stopLossEur)}</strong>
        </div>
      </div>

      <div class="levels-grid">
        <div class="level-box">
          <span>RSI (14 d.)</span>
          <strong>${asset.rsi14}</strong>
        </div>
        <div class="level-box">
          <span>Nuo 52 sav. viršūnės</span>
          <strong>${fmtPct(asset.drawdown52w)}</strong>
        </div>
        <div class="level-box">
          <span>Kur pirkti be komisinių</span>
          <strong style="font-family: var(--font-sans); font-size: 0.74rem;">${escapeHtml(asset.brokerHint)}</strong>
        </div>
      </div>

      <strong style="font-size: 0.84rem;">Kodėl algoritmas sugeneravo šį įvertinimą:</strong>
      <ul class="reasons-list">
        ${(asset.reasons || []).map((r) => `<li>${escapeHtml(r)}</li>`).join('')}
      </ul>

      <div style="display: flex; gap: 8px; align-items: center;">
        <input type="number" id="modal-quick-eur" class="form-input mono" value="25" min="1" max="1000" step="5" style="max-width: 110px;" aria-label="Investuojama suma eurais" />
        <button type="button" class="btn-primary btn-block" id="btn-modal-quick-buy" data-symbol="${escapeHtml(asset.symbol)}">Įrašyti pirkimą į mano portfelį (€)</button>
      </div>
    `;

    modal.classList.add('open');

    document.getElementById('btn-close-modal').onclick = closeAssetModal;
    document.getElementById('btn-modal-quick-buy').onclick = () => {
      const amt = Number(document.getElementById('modal-quick-eur').value) || 25;
      addPurchaseToPortfolio(asset.symbol, amt, asset.priceEur);
      closeAssetModal();
      showToast(`Pridėta ${fmtEur(amt)} → ${asset.shortName}!`);
    };
  }

  function closeAssetModal() {
    document.getElementById('asset-modal').classList.remove('open');
  }

  // --- Telegram siuntimas tiesiai iš naršyklės ---
  async function sendTelegramMessage(htmlText) {
    const token = state.settings.tgToken.trim();
    const chatId = state.settings.tgChatId.trim();
    if (!token || !chatId) {
      switchView('settings');
      showToast('Pirmiausia įveskite Telegram Bot Token ir Chat ID!');
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
      if (!data.ok) throw new Error(data.description || 'Telegram API klaida');
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
    const lines = [
      `📊 <b>InvestPulsas • Asmeninė ataskaita</b>`,
      `Rinkos režimas: <b>${ov.regimeLabel}</b> (vid. RSI ${ov.avgRsi})`,
      ``,
      `🟢 <b>Geriausi aktyvai dabar:</b>`,
      ...top3.map((a) => `• <b>${a.shortName}</b> (${a.symbol}) — ${fmtEur(a.priceEur)} | Balas ${a.score}/100 | RSI ${a.rsi14}`),
      ``,
      `💶 <b>Jūsų ${state.plannerBudget} € krepšelio paskirstymas:</b>`,
      ...items.map((i) => `• <b>${fmtEur(i.amountEur)}</b> → ${i.shortName} (${i.pct}%)`),
    ];
    return lines.join('\n');
  }

  // --- Navigacija ir įvykių priskyrimas ---
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
    // Navigacijos mygtukai
    document.querySelectorAll('[data-view]').forEach((btn) => {
      btn.addEventListener('click', () => switchView(btn.dataset.view));
    });

    document.getElementById('btn-goto-planner').addEventListener('click', () => switchView('planner'));
    document.getElementById('btn-see-all-signals').addEventListener('click', () => switchView('signals'));

    // Temos perjungimas
    document.getElementById('btn-theme-toggle').addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme') || 'dark';
      applyTheme(cur === 'dark' ? 'light' : 'dark');
    });

    // Gyvas atnaujinimas
    document.getElementById('btn-live-refresh').addEventListener('click', handleLiveRefresh);

    // Filtrai ir paieška
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

    // Paspaudimas ant bet kurios aktyvo kortelės (Event Delegation)
    document.body.addEventListener('click', (e) => {
      const sellBtn = e.target.closest('[data-sell-symbol]');
      if (sellBtn) {
        e.stopPropagation();
        const sym = sellBtn.dataset.sellSymbol;
        const pos = state.portfolio.find((p) => p.symbol === sym);
        if (!pos) return;
        const choice = window.prompt(
          `Kiek % pozicijos „${pos.shortName}“ norite parduoti / pašalinti? Įveskite 50 (pusei pelno fiksuoti) arba 100 (pilnam pardavimui):`,
          '100'
        );
        if (!choice) return;
        const pct = Math.min(100, Math.max(1, Number(choice) || 100));
        if (pct >= 100) {
          state.portfolio = state.portfolio.filter((p) => p.symbol !== sym);
        } else {
          pos.shares *= (100 - pct) / 100;
          pos.investedEur = Number((pos.investedEur * ((100 - pct) / 100)).toFixed(2));
        }
        saveLocalState();
        renderAll();
        showToast(`Pozicija ${sym} atnaujinta (-${pct}%)`);
        return;
      }

      const symCarrier = e.target.closest('[data-symbol]');
      if (symCarrier && !symCarrier.id?.startsWith('btn-modal')) {
        openAssetModal(symCarrier.dataset.symbol);
      }
    });

    // Modalinio lango uždarymas paspaudus foną arba Escape
    document.getElementById('asset-modal').addEventListener('click', (e) => {
      if (e.target.id === 'asset-modal') closeAssetModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeAssetModal();
    });

    // 100 € planuotojo valdikliai
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

    document.getElementById('btn-apply-plan-portfolio').addEventListener('click', () => {
      const items = computeDynamicPlanItems();
      for (const it of items) {
        addPurchaseToPortfolio(it.symbol, it.amountEur, it.priceEur);
      }
      showToast(`${state.plannerBudget} € krepšelis įrašytas į jūsų portfelį!`);
      switchView('portfolio');
    });

    document.getElementById('btn-send-plan-telegram').addEventListener('click', () => {
      sendTelegramMessage(buildTelegramReportHtml());
    });

    // Portfelio / Autopiloto perjungimas
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

    // Naujos pozicijos pridėjimo forma
    document.getElementById('add-pos-symbol').addEventListener('change', (e) => {
      const chosen = state.marketData?.assets?.find((a) => a.symbol === e.target.value);
      if (chosen) {
        document.getElementById('add-pos-price').value = chosen.priceEur.toFixed(2);
      }
    });

    document.getElementById('form-add-position').addEventListener('submit', (e) => {
      e.preventDefault();
      const sym = document.getElementById('add-pos-symbol').value;
      const eur = Number(document.getElementById('add-pos-eur').value);
      const px = Number(document.getElementById('add-pos-price').value);
      if (!sym || eur <= 0 || px <= 0) return;
      addPurchaseToPortfolio(sym, eur, px);
      showToast(`Pirkimas (${fmtEur(eur)} → ${sym}) išsaugotas!`);
    });

    // Autopiloto mygtukai
    document.getElementById('toggle-autopilot').addEventListener('change', (e) => {
      state.autopilot.enabled = e.target.checked;
      saveLocalState();
      showToast(state.autopilot.enabled ? 'Virtualus Autopilotas įjungtas!' : 'Virtualus Autopilotas pristabdytas');
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
      showToast('Autopiloto simuliacija perkrauta su nauju 100 € biudžetu!');
    });

    // Nustatymai ir Telegram
    document.getElementById('btn-save-test-telegram').addEventListener('click', () => {
      state.settings.tgToken = document.getElementById('tg-bot-token').value.trim();
      state.settings.tgChatId = document.getElementById('tg-chat-id').value.trim();
      saveLocalState();
      if (state.marketData) {
        sendTelegramMessage(buildTelegramReportHtml());
      }
    });

    document.getElementById('btn-save-cap').addEventListener('click', () => {
      const v = Math.max(10, Number(document.getElementById('settings-monthly-cap').value) || 100);
      state.settings.monthlyCapEur = v;
      state.plannerBudget = Math.min(300, v);
      saveLocalState();
      renderAll();
      showToast(`Mėnesio limitas nustatytas: ${v} €`);
    });

    // Eksportas / Importas
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
          if (parsed.settings?.monthlyCapEur) state.settings.monthlyCapEur = parsed.settings.monthlyCapEur;
          saveLocalState();
          renderAll();
          showToast('Portfelio duomenys sėkmingai atkurti!');
        } catch (_) {
          showToast('Netinkamas JSON kopijos failas');
        }
      };
      reader.readAsText(file);
    });

    // PWA įdiegimo įvykis
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

  // Service Worker registracija
  function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', () => {
        navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('SW klaida:', err));
      });
    }
  }

  // Paleidimas
  loadLocalState();
  bindEvents();
  registerServiceWorker();
  loadMarketData();
})();
