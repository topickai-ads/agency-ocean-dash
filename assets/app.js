/* ============================================================
   投放效果看板 — 逐日优先 / 焦点日
   01 核心问题（当天/昨天）→ 02 预算·消耗·消耗比例（左表右图）→ 03 回收  → 下钻四层
   代理视图 = Ocean only；内部全量（hebin）含自投 zt。
   ============================================================ */

(function () {
  'use strict';

  const D = window.DASHBOARD_DATA;
  const main = document.getElementById('main');
  if (!D || !D.rows) {
    main.innerHTML = '<div class="card" style="margin:40px auto;max-width:520px"><div class="empty">数据文件未加载 —— 请确认 data/*.js 已生成。</div></div>';
    return;
  }

  const M = D.meta;
  const ALL = D.rows;
  const PRODUCTS = M.products || [];
  const LEVELS = ['account', 'campaign', 'adset', 'ad'];
  const LV_NAME = { account: '账号', campaign: 'Campaign', adset: 'Adset', ad: 'Ad' };
  const TREE = { account: 'campaign', campaign: 'adset', adset: 'ad', ad: null };
  const BENCH = (M.benchmark && M.benchmark.d0_net_rate) || 0.5;
  const LIGHT = M.light_rule || { ok: 0.5, warn: 0.35 };
  const IS_AG = (M.view || 'internal') === 'agency';
  const AG = M.agency_name || 'Ocean';
  const NOFF = M.rev_offsets || 8;
  const WINDOW_DAYS = 7;      // 固定 7 天：归因窗口就 7 天，更长的区间对微操没意义
  const LEDGER = M.budget_ledger || {};
  const ACCOUNTS = M.accounts || [];

  const DATES = Array.from(new Set(ALL.map(r => r.d))).sort();
  const TODAY = DATES[DATES.length - 1];
  const COMPLETE = DATES.filter(d => d !== TODAY);
  const REV_UNTIL = M.revenue_until || '9999-12-31';
  const LAST_REV_DAYS = Math.min(NOFF - 1, Math.max(0, dayDiff(COMPLETE[COMPLETE.length - 1], REV_UNTIL)));

  const state = {
    product: 'all',
    view: 'y1',                 // today | y1 | y2 | d:YYYY-MM-DD
    q: '',
    level: 'account',
    open: new Set(),
    focus: null,
    detail: false,
    tab: 'overview',      // overview | drill
    drillDay: null,
    okAll: false
  };

  const $ = s => document.querySelector(s);
  const $$ = s => Array.from(document.querySelectorAll(s));

  /* ---------------- 格式化 ---------------- */

  const fmt = {
    money(v, d = 0) {
      if (v == null || !isFinite(v)) return '—';
      if (v !== 0 && Math.abs(v) < 1) d = Math.max(d, 2);   // 小额显示两位小数，别圆成 $0
      return '$' + v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    },
    num(v, d = 0) {
      if (v == null || !isFinite(v)) return '—';
      return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
    },
    pct(v, d = 1) {
      if (v == null || !isFinite(v)) return '—';
      return (v * 100).toFixed(d) + '%';
    },
    signed(v, d = 1) {
      if (v == null || !isFinite(v)) return '';
      return (v >= 0 ? '+' : '') + (v * 100).toFixed(d) + 'pt';
    },
    delta(v, d = 0) {
      if (v == null || !isFinite(v)) return '';
      return (v >= 0 ? '+' : '') + (v * 100).toFixed(d) + '%';
    },
    compact(v) {
      if (v == null || !isFinite(v)) return '—';
      if (Math.abs(v) >= 10000) return '$' + (v / 1000).toFixed(0) + 'k';
      if (Math.abs(v) >= 1000) return '$' + (v / 1000).toFixed(1) + 'k';
      if (v !== 0 && Math.abs(v) < 1) return '$' + v.toFixed(2);
      return '$' + Math.round(v);
    },
    md(iso) { return iso.slice(5).replace('-', '/'); },
    wk(iso) { return '周' + '日一二三四五六'[new Date(iso + 'T00:00:00').getDay()]; }
  };

  // 花费 < $1 的行比率无意义（几毛钱花费会算出鬼影比率），统一显示「—」
  const okSp = v => v != null && v >= 1;

  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---------------- 时间口径 ---------------- */

  function dayDiff(a, b) {
    const p = s => { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); };
    return Math.round((p(b) - p(a)) / 86400000);
  }

  function addDays(iso, n) {
    const [y, m, d] = iso.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + n);
    return dt.toISOString().slice(0, 10);
  }

  /* 焦点日：今天 / 昨天 / 前天 / 日历里挑的某一天 */
  function focusDate() {
    if (state.view === 'today') return TODAY;
    if (state.view === 'y1') return COMPLETE[COMPLETE.length - 1] || TODAY;
    if (state.view === 'y2') return COMPLETE[COMPLETE.length - 2] || COMPLETE[0] || TODAY;
    if (state.view.indexOf('d:') === 0) {
      const d = state.view.slice(2);
      if (DATES.indexOf(d) >= 0) return d;
      if (d > TODAY) return TODAY;
      return DATES.find(x => x >= d) || DATES[0];   // 那天没数据就顺延到最近有数据的一天
    }
    return COMPLETE[COMPLETE.length - 1] || TODAY;
  }

  function isCustomDate() {
    return state.view.indexOf('d:') === 0;
  }

  function scopeStart() {
    let min = null;
    for (const r of ALL) {
      if (!match(r, {})) continue;
      if (!min || r.d < min) min = r.d;
    }
    return min || COMPLETE[0];
  }

  /* 窗口 = 焦点日往前共 7 个点（今天那根是盘中的第 7 个点） */
  function windowDates() {
    const f = focusDate();
    let ds;
    if (f === TODAY) ds = COMPLETE.slice(-(WINDOW_DAYS - 1)).concat(TODAY);
    else {
      const i = COMPLETE.indexOf(f);
      ds = i < 0 ? [f] : COMPLETE.slice(Math.max(0, i - WINDOW_DAYS + 1), i + 1);
    }
    const start = scopeStart();
    return ds.filter(d => d >= start);
  }

  /* ---------------- 数据切片 ---------------- */

  function match(r, opt) {
    opt = opt || {};
    const product = opt.product || state.product;
    /* 代理视图：只算 Ocean。内部全量视图（hebin）：含自投 zt，花费/回收同口径合计。 */
    if (IS_AG && r.src !== 'agency') return false;
    if (product !== 'all' && r.p !== product) return false;
    if (opt.withQ && state.q) {
      const q = state.q.toLowerCase();
      if (!(r.acc || '').toLowerCase().includes(q) &&
          !(r.camp || '').toLowerCase().includes(q) &&
          !(r.ads || '').toLowerCase().includes(q) &&
          !(r.ad || '').toLowerCase().includes(q)) return false;
    }
    return true;
  }

  const ZERO = () => ({ spendA: 0, spendS: 0, p0: 0, n: new Array(NOFF).fill(0) });

  function dailyMap(lv, dates, opt) {
    const m = new Map();
    for (const r of ALL) {
      if (r.lv !== lv || !dates.includes(r.d) || !match(r, opt)) continue;
      const a = m.get(r.d) || ZERO();
      if (IS_AG) {
        if (r.src === 'agency') a.spendA += r.spend; else a.spendS += r.spend;
      } else {
        /* 全量：KPI 用合计花费，spendS 仍记自投份额便于展示 */
        a.spendA += r.spend;
        if (r.src !== 'agency') a.spendS += r.spend;
      }
      a.p0 += r.p0;
      for (let i = 0; i < NOFF; i++) a.n[i] += r.n[i] || 0;
      m.set(r.d, a);
    }
    return m;
  }

  // 逐日序列：花费 / 付费 / D0 / cohort 累计
  function buildDaily(ds, opt) {
    const map = dailyMap('campaign', ds, opt);
    return ds.map(d => {
      const a = map.get(d) || ZERO();
      const spendA = a.spendA, p0 = a.p0, net0 = a.n[0] || 0;
      const cum = a.n.reduce((x, y) => x + y, 0);
      const obs = Math.max(0, Math.min(NOFF - 1, dayDiff(d, REV_UNTIL)));
      const live = d === TODAY;
      return {
        d, spendA, spendS: a.spendS,
        p0, net0, cum, obs, live,
        rate: !okSp(spendA) ? null : ((live && !net0) ? null : net0 / spendA),
        cpa: p0 ? spendA / p0 : null,
        cumRate: !okSp(spendA) ? null : ((live && !net0) ? null : cum / spendA)
      };
    });
  }

  // 当日各账户花费
  function accSpend(dates) {
    const m = new Map();
    for (const r of ALL) {
      if (r.lv !== 'campaign' || !dates.includes(r.d) || !match(r, {})) continue;
      const a = m.get(r.d) || {};
      a[r.acc] = (a[r.acc] || 0) + r.spend;
      m.set(r.d, a);
    }
    return m;
  }

  /* ---------------- 预算台账 ---------------- */

  function budgetAt(date, productId) {
    const pids = productId ? [productId] : (state.product === 'all' ? PRODUCTS.map(p => p.id) : [state.product]);
    const acc = {};
    let known = true;
    for (const pid of pids) {
      const L = LEDGER[pid] || {};
      for (const name in L) {
        const pts = L[name];
        let v = null;
        for (const [from, b] of pts) if (from <= date) v = b;
        if (v == null) known = false;      // 这天没记账就是不知道，不拿别的日期顶
        acc[name] = v;
      }
    }
    const total = known && Object.keys(acc).length
      ? Object.values(acc).reduce((a, b) => a + (b || 0), 0) : null;
    return { total, acc, known: total != null };
  }

  function budgetSeries(dates) {
    return dates.map(d => budgetAt(d).total);
  }

  function acctMeta(name) {
    return ACCOUNTS.find(a => a.name === name) || null;
  }

  function acctLabel(name) {
    const a = acctMeta(name);
    if (!a) return esc(name);
    const p = (PRODUCTS.find(x => x.id === a.product) || {}).short || a.product;
    return `${esc(name)} <em>${esc(p)} · 主投 ${esc(a.country)}</em>`;
  }

  /* ---------------- 分组 / 聚合 ---------------- */

  function keyOf(lv, r) {
    if (lv === 'account') return r.acc;
    if (lv === 'campaign') return r.acc + '|' + r.camp;
    if (lv === 'adset') return r.acc + '|' + r.camp + '|' + r.ads;
    return r.acc + '|' + r.camp + '|' + r.ads + '|' + r.ad;
  }

  /* 子层去找父层用：campaign→账号、adset→campaign、ad→adset */
  function parentKey(lv, r) {
    if (lv === 'campaign') return r.acc;
    if (lv === 'adset') return r.acc + '|' + r.camp;
    if (lv === 'ad') return r.acc + '|' + r.camp + '|' + r.ads;
    return null;
  }

  function groupRows(lv, dates, opt) {
    /* 账号层在数据里没有独立行，是 campaign 行按账户聚合出来的 */
    const srcLv = lv === 'account' ? 'campaign' : lv;
    const m = new Map();
    for (const r of ALL) {
      if (r.lv !== srcLv || !dates.includes(r.d) || !match(r, opt)) continue;
      const k = keyOf(lv, r);
      const a = m.get(k) || {
        key: k, camp: r.camp, ads: r.ads, ad: r.ad, acc: r.acc, ctry: r.ctry,
        spend: 0, p0: 0, n: new Array(NOFF).fill(0), byDay: new Map()
      };
      a.spend += r.spend; a.p0 += r.p0;
      for (let i = 0; i < NOFF; i++) a.n[i] += r.n[i] || 0;
      const dd = a.byDay.get(r.d) || { spend: 0, p0: 0, n0: 0 };
      dd.spend += r.spend; dd.p0 += r.p0; dd.n0 += r.n[0] || 0;
      a.byDay.set(r.d, dd);
      m.set(k, a);
    }
    return Array.from(m.values()).map(a => {
      a.cum = a.n.reduce((x, y) => x + y, 0);
      a.d0 = okSp(a.spend) ? a.n[0] / a.spend : null;
      a.cpa = a.p0 ? a.spend / a.p0 : null;
      a.cumRate = okSp(a.spend) ? a.cum / a.spend : null;
      return a;
    }).sort((x, y) => y.spend - x.spend);
  }

  function countryAgg(dates, opt) {
    const m = new Map();
    for (const r of ALL) {
      if (r.lv !== 'campaign' || !dates.includes(r.d) || !match(r, opt)) continue;
      const a = m.get(r.ctry) || { k: r.ctry, spend: 0, n0: 0, p0: 0 };
      a.spend += r.spend; a.n0 += r.n[0] || 0; a.p0 += r.p0;
      m.set(r.ctry, a);
    }
    return Array.from(m.values()).map(a => ({ ...a, rate: okSp(a.spend) ? a.n0 / a.spend : null })).sort((x, y) => y.spend - x.spend);
  }

  function median(arr) {
    const s = arr.filter(v => v != null && isFinite(v)).sort((a, b) => a - b);
    if (!s.length) return null;
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /* ---------------- 灯 / 色 ---------------- */

  const TONE_C = { ok: '#067647', warn: '#dc6803', bad: '#d92d20', mute: '#98a2b3' };
  const LAMP_TXT = { ok: '达标', warn: '接近达标', bad: '不达标', mute: '样本不足' };

  function tone(rate) {
    if (rate == null) return 'mute';
    if (rate >= LIGHT.ok) return 'ok';
    if (rate >= LIGHT.warn) return 'warn';
    return 'bad';
  }
  function lamp(rate, size) {
    const t = tone(rate);
    return `<i class="lamp ${t}${size === 'lg' ? ' lg' : ''}" title="${LAMP_TXT[t]}${rate != null ? ' · ' + fmt.pct(rate) : ''}"></i>`;
  }
  function ratePill(rate, digits = 1) {
    if (rate == null) return '<span class="pill mute">—</span>';
    return `<span class="pill ${tone(rate)}">${fmt.pct(rate, digits)}</span>`;
  }

  /* ---------------- 图表原语 ---------------- */

  function niceMax(v, step) {
    if (!isFinite(v) || v <= 0) return 1;
    if (step) return Math.ceil((v - 1e-9) / step) * step;
    const p = Math.pow(10, Math.floor(Math.log10(v)));
    const n = v / p;
    const s = n <= 1 ? 1 : n <= 1.2 ? 1.2 : n <= 1.4 ? 1.4 : n <= 1.6 ? 1.6 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 3 ? 3 : n <= 4 ? 4 : n <= 5 ? 5 : n <= 6 ? 6 : n <= 8 ? 8 : 10;
    return s * p;
  }

  function niceStep(x) {
    if (!(x > 0)) return 1;
    const p = Math.pow(10, Math.floor(Math.log10(x)));
    const n = x / p;
    const s = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
    return s * p;
  }

  function pickIdx(n, k) {
    if (n <= k) return Array.from({ length: n }, (_, i) => i);
    const out = [];
    for (let i = 0; i < k; i++) out.push(Math.round(i * (n - 1) / (k - 1)));
    return Array.from(new Set(out));
  }

  function chartSvg(c) {
    const W = c.W || 350, H = c.H || 150;
    const P = { l: c.l || 38, r: c.r || 10, t: 13, b: 21 };
    const iw = W - P.l - P.r, ih = H - P.t - P.b;
    const n = c.dates.length;
    if (!n) return '<div class="empty">无数据</div>';

    let peak = 0;
    if (c.stack) for (let i = 0; i < n; i++) peak = Math.max(peak, c.stack.reduce((a, s) => a + (s.vals[i] || 0), 0));
    if (c.vals) c.vals.forEach(o => { if (o.v != null && isFinite(o.v)) peak = Math.max(peak, o.v); });
    if (c.steps) c.steps.forEach(v => { if (v != null) peak = Math.max(peak, v); });
    if (c.ref != null) peak = Math.max(peak, c.ref);
    if (c.refSeries) c.refSeries.forEach(v => { if (v != null) peak = Math.max(peak, v); });
    if (!(peak > 0)) return '<div class="empty">无数据</div>';

    let maxV = niceMax(peak * 1.12, c.stepI);

    /* 折线图不强制从 0 起：否则日消耗在 1.2k–1.5k 之间波动时曲线是条直线，看不出趋势。
       柱状图和带参考线的比率图仍然从 0 起。 */
    let baseV = 0;
    if (!c.stack && c.ref == null && !c.forceZero) {   // 有参考线的图仍从 0 起，免得把基准线挤出去
      const fin = (c.vals || []).filter(o => o.v != null && isFinite(o.v)).map(o => o.v);
      if (fin.length > 1) {
        const mn = Math.min(...fin);
        if (mn > maxV * 0.45) {
          maxV = niceMax(peak * 1.03, c.stepI);
          const pad = (maxV - mn) * 0.35;
          const step0 = c.gstep || niceStep(maxV / 4.5);
          baseV = Math.max(0, Math.floor((mn - pad) / step0) * step0);
        }
      }
    }

    const x = i => P.l + (n === 1 ? iw / 2 : iw * i / (n - 1));
    const span = maxV - baseV || 1;
    const y = v => P.t + ih - ((Math.max(baseV, Math.min(v, maxV)) - baseV) / span) * ih;

    /* 焦点日底色带：第一眼先看到"我在看哪一天" */
    let band = '';
    if (c.focusIdx != null && c.focusIdx >= 0) {
      const bw0 = Math.max(10, iw / Math.max(n, 1) * 0.72);
      const cx = x(c.focusIdx);
      band = `<rect x="${(Math.max(P.l, cx - bw0 / 2)).toFixed(1)}" y="${P.t}" width="${(Math.min(bw0, W - P.r - Math.max(P.l, cx - bw0 / 2))).toFixed(1)}" height="${ih}" fill="#f5f8fd" rx="3"/>`;
    }

    let grid = '';
    const gstep = c.gstep || niceStep((maxV - baseV) / 4.5);
    let gi = 0;
    for (let v = baseV; v <= maxV + 1e-9; v += gstep, gi++) {
      const yy = y(v);
      const onRef = c.ref != null && Math.abs(v - c.ref) < (maxV - baseV) * 0.012;
      if (!onRef) {
        grid += `<line x1="${P.l}" x2="${W - P.r}" y1="${yy.toFixed(1)}" y2="${yy.toFixed(1)}" stroke="${gi === 0 ? '#e3e8ef' : '#f3f5f9'}"/>`;
        if (gi > 0) grid += `<text x="${P.l - 6}" y="${(yy + 3).toFixed(1)}" text-anchor="end" fill="#b3bcc9" font-size="8.5">${c.fmtAxis ? c.fmtAxis(v) : fmt.compact(v)}</text>`;
      }
    }

    /* 参考线 */
    let ref = '';
    if (c.ref != null) {
      const ry = y(c.ref);
      ref += `<line x1="${P.l}" x2="${W - P.r}" y1="${ry.toFixed(1)}" y2="${ry.toFixed(1)}" stroke="#9aa5b4" stroke-width="1" stroke-dasharray="3 3"/>`;
      if (c.refLabel) ref += `<text x="${W - P.r}" y="${(ry - 4).toFixed(1)}" text-anchor="end" fill="#8b95a7" font-size="8.5">${c.refLabel}</text>`;
    }
    if (c.refSeries) {
      const pts = c.refSeries.map((v, i) => v == null ? null : [x(i), y(v)]).filter(Boolean);
      if (pts.length > 1) ref += `<path d="${pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ')}" fill="none" stroke="#9aa5b4" stroke-width="1" stroke-dasharray="3 3"/>`;
    }

    /* 差值竖线：消耗 vs 当日预算 */
    let gaps = '';
    if (c.gapTo) {
      gaps = c.dates.map((d, i) => {
        const sp = c.stack ? c.stack[0].vals[i] || 0 : 0;
        const bd = c.gapTo[i];
        if (!bd || !sp) return '';
        const over = sp > bd;
        return `<line x1="${x(i).toFixed(1)}" x2="${x(i).toFixed(1)}" y1="${y(sp).toFixed(1)}" y2="${y(bd).toFixed(1)}" stroke="${over ? '#e8877f' : '#b9c4d4'}" stroke-width="1.6"/>`;
      }).join('');
    }

    /* 预算阶梯线 */
    let steps = '';
    if (c.steps) {
      let dd = '', prev = null;
      for (let i = 0; i < n; i++) {
        const v = c.steps[i];
        if (v == null) { prev = null; continue; }
        const cx = x(i), cy = y(v);
        if (prev == null) dd += `M${(cx).toFixed(1)} ${cy.toFixed(1)}`;
        else {
          const mx = (prev[0] + cx) / 2;
          dd += `L${mx.toFixed(1)} ${prev[1].toFixed(1)}L${mx.toFixed(1)} ${cy.toFixed(1)}L${cx.toFixed(1)} ${cy.toFixed(1)}`;
        }
        prev = [cx, cy];
      }
      if (prev) dd += `L${(x(n - 1)).toFixed(1)} ${prev[1].toFixed(1)}`;
      steps = `<path d="${dd}" fill="none" stroke="#b5820b" stroke-width="1.7" stroke-linejoin="round"/>`;
    }

    /* 数据 */
    let body = '';
    if (c.stack) {
      const bw = Math.max(3, Math.min(26, iw / n * 0.5));
      body = c.dates.map((d, i) => c.stack.map((s, si) => {
        const v = s.vals[i] || 0;
        if (v <= 0) return '';
        const y0 = y(baseV), y1 = y(v);
        const op = i === c.liveIdx ? 'opacity=".42"' : '';
        return `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${y1.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.6, y0 - y1).toFixed(1)}" rx="${si === c.stack.length - 1 ? 2 : 0}" fill="${s.color}" ${op}><title>${c.tip ? c.tip(i) : d}</title></rect>`;
      }).join('')).join('');
    } else {
      let segs = [], cur = [];
      c.vals.forEach((o, i) => {
        if (o.v == null || !isFinite(o.v)) { if (cur.length) segs.push(cur); cur = []; return; }
        cur.push([x(i), y(o.v)]);
      });
      if (cur.length) segs.push(cur);
      body = segs.map(pts => {
        /* 最后一个点是今天的盘中数：最后一段画虚线，读图时不会当成掉量 */
        const liveTail = c.liveIdx != null && c.liveIdx === n - 1 && pts[pts.length - 1][0] === x(n - 1);
        if (liveTail && pts.length > 1) {
          const head = pts.slice(0, -1), a = pts[pts.length - 2], b = pts[pts.length - 1];
          return `<path d="${head.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ')}" fill="none" stroke="${c.color || '#2563eb'}" stroke-width="${c.width || 1.9}" stroke-linejoin="round" stroke-linecap="round"/>`
            + `<path d="M${a[0].toFixed(1)} ${a[1].toFixed(1)}L${b[0].toFixed(1)} ${b[1].toFixed(1)}" fill="none" stroke="${c.color || '#2563eb'}" stroke-width="${(c.width || 1.9) * 0.9}" stroke-dasharray="3 3" opacity=".65"/>`;
        }
        return `<path d="${pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ')}" fill="none" stroke="${c.color || '#2563eb'}" stroke-width="${c.width || 1.9}" stroke-linejoin="round" stroke-linecap="round"/>`;
      }).join('');
      if (n <= 32) {
        body += c.vals.map((o, i) => {
          if (o.v == null || !isFinite(o.v)) return '';
          const live = i === c.liveIdx;
          return `<g><title>${c.dates[i]} · ${c.fmtTip ? c.fmtTip(o.v) : o.v}</title><circle cx="${x(i).toFixed(1)}" cy="${y(o.v).toFixed(1)}" r="${live ? 3.2 : 2.2}" fill="${live ? '#fff' : (c.color || '#2563eb')}" stroke="${c.color || '#2563eb'}" stroke-width="${live ? 2 : 0}"/></g>`;
        }).join('');
      }
    }

    const lab = pickIdx(n, c.labels || 4).map(i => {
      const first = i === 0, last = i === n - 1;
      const lx = first ? P.l : last ? W - P.r : x(i);
      const anchor = first ? 'start' : last ? 'end' : 'middle';
      const hot = i === c.focusIdx || i === c.liveIdx;
      return `<text x="${lx.toFixed(1)}" y="${H - 5}" text-anchor="${anchor}" fill="${hot ? '#5d6b82' : '#b3bcc9'}" font-size="8.5" font-weight="${hot ? 600 : 400}">${fmt.md(c.dates[i])}</text>`;
    }).join('');

    return `<svg viewBox="0 0 ${W} ${H}" role="img">${band}${grid}${ref}${gaps}${steps}${body}${lab}</svg>`;
  }

  /* 图表先占位，插进 DOM 后按真实宽度排版 */
  let SEQ = 0;
  const PENDING = [];

  function chartHTML(cfg) {
    const id = 'c' + (SEQ++);
    PENDING.push({ id, cfg });
    /* 先把高度占住：整块重绘时图表不会先塌成 0 再撑开，页面就不会抖 */
    return `<div class="chart-wrap" data-cid="${id}" style="min-height:${(cfg.H || 150) + 8}px"></div>`;
  }

  function mountCharts() {
    document.querySelectorAll('[data-cid]').forEach(el => {
      if (!el.__cfg) {
        const rec = PENDING.find(p => p.id === el.dataset.cid);
        if (rec) el.__cfg = rec.cfg;
      }
      if (!el.__cfg) return;
      const w = Math.max(240, Math.round((el.clientWidth || 340) - 18));
      el.innerHTML = chartSvg(Object.assign({}, el.__cfg, { W: w }));
    });
    PENDING.length = 0;
  }

  function sparkSvg(vals, o) {
    o = o || {};
    const w = o.w || 64, h = o.h || 18, pad = 1.5;
    const n = vals.length;
    const fin = vals.filter(v => v != null && isFinite(v));
    if (!fin.length) return '<span class="dim" style="font-size:10px">—</span>';
    const maxV = Math.max(...fin, o.ref || 0, 1e-6);
    const x = i => pad + (w - pad * 2) * (n <= 1 ? 0.5 : i / (n - 1));
    const y = v => h - pad - (v / maxV) * (h - pad * 2);
    let out = '';
    if (o.kind === 'bar') {
      const bw = Math.max(1.2, (w - pad * 2) / n * 0.62);
      out = vals.map((v, i) => v == null ? '' :
        `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${y(v).toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0.8, h - pad - y(v)).toFixed(1)}" fill="${o.color || '#c7d9fe'}"/>`).join('');
    } else {
      let cur = [], segs = [];
      vals.forEach((v, i) => {
        if (v == null || !isFinite(v)) { if (cur.length) segs.push(cur); cur = []; return; }
        cur.push([x(i), y(v)]);
      });
      if (cur.length) segs.push(cur);
      out = segs.map(s => `<path d="${s.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ')}" fill="none" stroke="${o.color || '#2563eb'}" stroke-width="1.25" stroke-linejoin="round" stroke-linecap="round"/>`).join('');
      const li = vals.reduce((acc, v, i) => (v != null && isFinite(v)) ? i : acc, -1);
      if (li >= 0) out += `<circle cx="${x(li).toFixed(1)}" cy="${y(vals[li]).toFixed(1)}" r="1.6" fill="${o.color || '#2563eb'}"/>`;
    }
    const ref = o.ref != null
      ? `<line x1="${pad}" x2="${w - pad}" y1="${y(o.ref).toFixed(1)}" y2="${y(o.ref).toFixed(1)}" stroke="#b3bcc9" stroke-width="0.9" stroke-dasharray="2 2"/>`
      : '';
    return `<svg class="spark" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}">${ref}${out}</svg>`;
  }

  function sec(no, title, desc, right) {
    return `<div class="sec"><span class="no">${no}</span><h2>${title}</h2>${desc ? `<span class="desc">${desc}</span>` : ''}${right ? `<span class="right">${right}</span>` : ''}</div>`;
  }

  /* ---------------- 02 预算 · 消耗 · 消耗比例（一张表，逐层下钻） ---------------- */

  /* 消耗率配色：>100% 超支、85–100% 正常、60–85% 偏慢、<60% 明显没花到 */
  function paceCls(r) {
    if (r == null) return '';
    if (r > 1) return 'over';
    if (r >= 0.85) return 'ok';
    if (r >= 0.6) return 'warn';
    return 'low';
  }

  function paceCell(sp, b) {
    if (!b) return '<span class="dim">—</span>';
    const r = sp / b;
    const c = paceCls(r);
    const tone = r > 1 || c === 'low' ? 'tone-bad' : c === 'warn' ? 'tone-warn' : '';
    return `<div class="pace">
      <span class="pace-bar"><i class="${c}" style="width:${Math.min(r * 100, 100).toFixed(0)}%"></i></span>
      <b class="${tone}">${fmt.pct(r, 0)}</b>
    </div>`;
  }

  function gapCell(sp, b) {
    if (!b) return '<span class="dim">—</span>';
    const g = b - sp;
    if (Math.abs(g) < 1) return '<span class="dim">刚好</span>';
    return g > 0
      ? `<span class="tone-warn">差 ${fmt.money(g)}</span>`
      : `<span class="tone-bad">超 ${fmt.money(-g)}</span>`;
  }

  /* 表体（名称/预算/消耗/消耗比例）—— 展开时只换这一块，整页不重绘 */
  function bsTableInner(focus) {
    const live = focus === TODAY;
    const B = budgetAt(focus);

    /* 当日花费 + D0 净回收（只算当前视图匹配的量） */
    const spProd = {}, spAcc = {}, spCamp = {};
    const n0Prod = {}, n0Acc = {}, n0Camp = {};
    for (const r of ALL) {
      if (r.lv !== 'campaign' || r.d !== focus || !match(r, {})) continue;
      const n0 = r.n[0] || 0;
      spProd[r.p] = (spProd[r.p] || 0) + r.spend;
      spAcc[r.acc] = (spAcc[r.acc] || 0) + r.spend;
      spCamp[r.acc + '|' + r.camp] = (spCamp[r.acc + '|' + r.camp] || 0) + r.spend;
      n0Prod[r.p] = (n0Prod[r.p] || 0) + n0;
      n0Acc[r.acc] = (n0Acc[r.acc] || 0) + n0;
      n0Camp[r.acc + '|' + r.camp] = (n0Camp[r.acc + '|' + r.camp] || 0) + n0;
    }

    const accProd = n => (acctMeta(n) || {}).product;
    const prodBud = {}, prodAccN = {};
    for (const n in B.acc) {
      const p = accProd(n);
      if (!p) continue;
      prodBud[p] = (prodBud[p] || 0) + (B.acc[n] || 0);
      prodAccN[p] = (prodAccN[p] || 0) + 1;
    }

    /* campaign 级预算只有今天的（Meta 只给当前配置），历史日留空 */
    const campBud = acc => {
      if (!live) return null;
      const det = (M.budget_detail || {})[acc] || [];
      if (!det.length) return null;
      const m = {};
      for (const d of det) m[d.camp] = (m[d.camp] || 0) + d.budget;
      return m;
    };

    const pids = (state.product === 'all' ? PRODUCTS.map(p => p.id) : [state.product])
      .filter(pid => (spProd[pid] || 0) > 0 || (prodBud[pid] || 0) > 0)
      .sort((a, b) => (spProd[b] || 0) - (spProd[a] || 0));

    const caret = (k, has) => has
      ? `<button class="caret ${state.open.has(k) ? 'open' : ''}" data-bk="${k}" aria-label="展开"><svg viewBox="0 0 24 24" fill="none"><path d="m9 5 7 7-7 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`
      : '<button class="caret blank" tabindex="-1"></button>';

    const d0RateCell = (sp, n0) => {
      if (!okSp(sp)) return '<span class="dim">—</span>';
      if (!n0) return '<span class="dim">—</span>';
      return ratePill(n0 / sp, 0);
    };

    const row = (cls, k, has, nameHTML, sp, b, n0) => `
      <div class="bs-row ${cls}${has ? ' can-open' : ''}"${has ? ` data-bk="${k}"` : ''}>
        <div class="nm">${caret(k, has)}${nameHTML}</div>
        <div class="num">${b ? fmt.money(b) : '<span class="dim">—</span>'}</div>
        <div class="num"><b>${fmt.money(sp)}</b></div>
        <div class="num">${paceCell(sp, b)}</div>
        <div class="num">${d0RateCell(sp, n0)}</div>
      </div>`;

    let body = '';
    let tSp = 0, tB = 0, tN0 = 0, anyB = false;

    for (const pid of pids) {
      const pk = 'b|p:' + pid;
      const prod = PRODUCTS.find(x => x.id === pid) || { short: pid };
      const sp = spProd[pid] || 0;
      const b = B.known ? (prodBud[pid] || 0) : null;
      if (b) { tB += b; anyB = true; }
      tSp += sp;

      const pn0 = n0Prod[pid] || 0;
      tN0 += pn0;
      body += row('lv-prod', pk, true,
        `<b>${esc(prod.short)}</b><em>${prodAccN[pid] || 0} 个账户</em>`, sp, b, pn0);

      if (!state.open.has(pk)) continue;

      const accs = Object.keys(spAcc)
        .filter(n => accProd(n) === pid)
        .sort((a, b2) => (spAcc[b2] || 0) - (spAcc[a] || 0));

      for (const acc of accs) {
        const ak = 'b|a:' + acc;
        const asp = spAcc[acc] || 0;
        const ab = B.known ? (B.acc[acc] || 0) : null;
        body += row('lv-acc', ak, true, `${esc(acc)}<em>${esc((acctMeta(acc) || {}).country || '')}</em>`, asp, ab, n0Acc[acc] || 0);

        if (!state.open.has(ak)) continue;

        const cm = campBud(acc);
        const camps = Object.keys(spCamp)
          .filter(k => k.indexOf(acc + '|') === 0)
          .sort((x, y) => spCamp[y] - spCamp[x]);
        for (const k of camps) {
          const name = k.slice(acc.length + 1);
          const csp = spCamp[k];
          const cb = cm ? (cm[name] || 0) : null;
          body += row('lv-camp', 'b|c:' + k, false, esc(name), csp, cb, n0Camp[k] || 0);
        }
        if (!camps.length) body += `<div class="bs-row lv-camp"><div class="nm dim">这一天没有花费</div></div>`;
      }
    }

    const ledgerFrom = Object.values(M.budget_ledger || {})
      .flatMap(a => Object.values(a).flatMap(pts => pts.map(x => x[0])))
      .sort()[0];

    const html = `<div class="bs-row bs-head">
          <div class="nm">名称</div>
          <div class="num">预算</div>
          <div class="num">消耗</div>
          <div class="num">消耗比例</div>
          <div class="num">D0 回收率</div>
        </div>
        ${body || '<div class="bs-row"><div class="nm dim">这一天没有花费</div></div>'}
        <div class="bs-row bs-total">
          <div class="nm">合计</div>
          <div class="num">${anyB ? fmt.money(tB) : '<span class="dim">—</span>'}</div>
          <div class="num"><b>${fmt.money(tSp)}</b></div>
          <div class="num">${paceCell(tSp, anyB ? tB : null)}</div>
          <div class="num">${d0RateCell(tSp, tN0)}</div>
        </div>`;

    return { html, anyB, tB, tSp, ledgerFrom };
  }

  /* 展开 / 收起只重画表体，图表不动 —— 页面不抖 */
  function refreshBs() {
    const el = document.getElementById('bsTable');
    if (!el) return;
    const T = bsTableInner(focusDate());
    el.innerHTML = T.html;
    const note = document.getElementById('bsNote');
    if (note) note.innerHTML = bsNoteHTML(focusDate(), T);
  }

  function bsNoteHTML(focus, T) {
    const live = focus === TODAY;
    return T.anyB
      ? `预算 = 当天真在跑的 campaign 预算之和${live
          ? '；今天还没跑完，消耗比例收盘前会一直偏低'
          : '（按变更日志回溯）；campaign 级预算 Meta 只给当前值，历史日留空'}。D0 回收率 = 当天安装用户净回收 ÷ 当日花费。`
      : `当日预算没记账${T.ledgerFrom ? `（台账从 ${fmt.md(T.ledgerFrom)} 起）` : ''}，只显示消耗与 D0 回收率。`;
  }

  function budgetSpendCard(dates, focus, cur, focusIdx) {
    const live = focus === TODAY;
    const T = bsTableInner(focus);

    return `<article class="card bs">
      <div class="card-head">
        <h2>预算完成度</h2>
        <span class="sub">${fmt.md(focus)}${live ? ' 盘中' : ''} · 点任意一行逐层展开：产品 → 账户 → campaign</span>
        <span class="dtype">当日</span>
      </div>

      <div class="bs-table" id="bsTable">${T.html}</div>

      <div class="bs-note" id="bsNote">${bsNoteHTML(focus, T)}</div>
    </article>`;
  }

  /* ---------------- 01-B 消耗走势（和预算表左右并排） ---------------- */

  function spendTrendCard(dates, focusIdx, cur) {
    const daily = buildDaily(dates);
    const vals = daily.map(o => o.spendA);
    const i = focusIdx >= 0 ? focusIdx : dates.length - 1;
    const d = dates[i] || TODAY;
    const live = d === TODAY;

    const chart = chartHTML({
      H: 246, dates,
      vals: vals.map(v => ({ v })),
      liveIdx: dates.indexOf(TODAY),
      focusIdx,
      labels: dates.length <= 8 ? dates.length : 5,
      color: '#2563eb',
      width: 2.1,
      fmtAxis: v => fmt.compact(v),
      fmtTip: v => fmt.money(v)
    });

    const winSum = dates.filter(x => x !== TODAY)
      .reduce((a, x) => a + (daily.find(o => o.d === x) || { spendA: 0 }).spendA, 0);

    return `<article class="card mini">
      <div class="card-head"><h2>消耗走势</h2><span class="sub">${AG} 每日花费</span><span class="dtype">逐日</span></div>
      ${chart}
      <div class="chart-legend">
        <span><i style="background:#2563eb"></i>每日花费</span>
        <span style="margin-left:auto">${fmt.md(d)} 收在 <b>${fmt.money(vals[i])}</b>${live ? '（盘中）' : ''}</span>
      </div>
      <div class="mini-foot"><span class="dim">${dates.length} 天合计 ${fmt.money(winSum)}</span></div>
    </article>`;
  }

  /* ---------------- 02-A 当日快照（焦点那一天） ---------------- */

  function snapStrip(daily, i) {
    const cur = daily[i];
    if (!cur) return '';
    const live = cur.d === TODAY;
    if (live && !cur.net0) {
      /* 盘中还没有回收数字，摆一排破折号没意义，直接说清楚 */
      return `<div class="snap snap-live">
        <div class="snap-h"><b>${fmt.md(cur.d)} 盘中</b><span>还没有回收数据</span></div>
        <div class="snap-b live-note">这一天还没有回收数据，下面三条是历史各天的逐日走势；今天的花费在左上角预算卡。</div>
      </div>`;
    }
    const cells = [
      { k: 'D0 回收率', v: fmt.pct(cur.rate), c: 'tone-' + tone(cur.rate) },
      { k: 'D0 净回收', v: fmt.money(cur.net0) },
      { k: 'D0 付费人', v: fmt.num(cur.p0) + ' 人' },
      { k: '单付费成本', v: fmt.money(cur.cpa) },
      { k: 'Cohort 累计', v: fmt.pct(cur.cumRate) }
    ];
    return `<div class="snap">
      <div class="snap-h"><b>${fmt.md(cur.d)} 当日</b><span>${live ? '盘中 · 实时' : '安装日口径 · 净回收'}</span></div>
      <div class="snap-b">${cells.map(o => `<div><span>${o.k}</span><b class="${o.c || ''}">${o.v}</b></div>`).join('')}</div>
    </div>`;
  }

  /* ---------------- 02-B 逐日走势（三张纯曲线） ---------------- */

  function trendCard(o) {
    return `<article class="card mini">
      <div class="card-head"><h2>${o.title}</h2><span class="sub">${o.note || ''}</span><span class="dtype">逐日</span></div>
      ${o.chart}
      <div class="chart-legend">${o.legend}<span style="margin-left:auto">${o.end}</span></div>
    </article>`;
  }

  function recoveryCards(dates, focusIdx) {
    const daily = buildDaily(dates);
    const i = focusIdx >= 0 ? focusIdx : daily.length - 1;
    const cur = daily[i];
    const live = cur.d === TODAY;

    const rateChart = chartHTML({
      H: 168, dates, vals: daily.map(o => ({ v: o.rate })),
      labels: dates.length <= 8 ? dates.length : 4,
      ref: BENCH, refLabel: '50%', gstep: 0.25,
      liveIdx: dates.indexOf(TODAY), focusIdx: i,
      color: TONE_C[tone(cur.rate)],
      fmtAxis: v => (v * 100).toFixed(0) + '%',
      fmtTip: v => fmt.pct(v)
    });

    const cumChart = chartHTML({
      H: 168, dates, vals: daily.map(o => ({ v: o.cumRate })),
      labels: dates.length <= 8 ? dates.length : 4,
      ref: BENCH, refLabel: 'D0 基准', gstep: 0.25,
      liveIdx: dates.indexOf(TODAY), focusIdx: i,
      color: '#0e9384',
      fmtAxis: v => (v * 100).toFixed(0) + '%',
      fmtTip: v => fmt.pct(v)
    });

    const cpaChart = chartHTML({
      H: 168, dates, vals: daily.map(o => ({ v: o.cpa })),
      labels: dates.length <= 8 ? dates.length : 4,
      liveIdx: dates.indexOf(TODAY), focusIdx: i,
      color: '#4e5ba6',
      fmtAxis: v => '$' + Math.round(v),
      fmtTip: v => fmt.money(v)
    });

    const prev = daily[i - 1];
    const dRate = (prev && prev.rate != null && cur.rate != null) ? cur.rate - prev.rate : null;
    const dCpa = (prev && prev.cpa && cur.cpa) ? cur.cpa / prev.cpa - 1 : null;

    return [
      trendCard({
        title: 'D0 回收率', note: '净回收 ÷ 当日花费',
        chart: rateChart,
        legend: '<span><i style="background:' + TONE_C[tone(cur.rate)] + '"></i>当日回收率</span><span><i class="dash"></i>50% 基准</span>',
        end: (live && !cur.net0) ? `${fmt.md(cur.d)} 待结算`
          : `${fmt.md(cur.d)} <b>${fmt.pct(cur.rate)}</b>`
            + (dRate == null ? '' : `<i class="${dRate >= 0 ? 'tone-ok' : 'tone-bad'}"> ${fmt.signed(dRate)}</i>`)
      }),
      trendCard({
        title: 'Cohort 累计回收', note: '每天新增 → 报表日',
        chart: cumChart,
        legend: '<span><i style="background:#0e9384"></i>各批累计率</span><span><i class="dash"></i>D0 基准</span>',
        end: (live && !cur.net0) ? `${fmt.md(cur.d)} 待结算` : `${fmt.md(cur.d)} <b>${fmt.pct(cur.cumRate)}</b>`
      }),
      trendCard({
        title: '单新增付费成本', note: '花费 ÷ D0 付费人',
        chart: cpaChart,
        legend: '<span><i style="background:#4e5ba6"></i>每日成本</span><span>不设基线</span>',
        end: `${fmt.md(cur.d)} <b>${fmt.money(cur.cpa)}</b>`
          + (dCpa == null ? '' : `<i class="${dCpa > 0 ? 'tone-bad' : 'tone-ok'}"> ${fmt.delta(dCpa, 0)}</i>`)
      })
    ].join('');
  }

  /* ---------------- 02 逐日明细 D0/D1/D3/D7 ---------------- */

  const OFFS_SHOW = [0, 1, 3, 7];

  function detailCard(dates) {
    const rows = dailyMap('campaign', dates);
    const list = dates.filter(d => d !== TODAY).slice().reverse();
    const tot = { spend: 0, p0: 0, n: new Array(NOFF).fill(0) };
    list.forEach(d => {
      const a = rows.get(d) || ZERO();
      tot.spend += a.spendA; tot.p0 += a.p0;
      for (let i = 0; i < NOFF; i++) tot.n[i] += a.n[i] || 0;
    });

    const cumTo = (a, k) => a.n.slice(0, k + 1).reduce((x, y) => x + y, 0);

    /* D0 / D1 / D3 / D7 全部给回收率（这批人到那天为止回了多少 ÷ 当天花费），不给金额 */
    const rateAt = (a, k, d) => {
      if (!a.spendA) return '<span class="dim">—</span>';
      if (k > 0 && addDays(d, k) > REV_UNTIL) {
        const need = dayDiff(REV_UNTIL, addDays(d, k));
        return `<span class="dim" title="这批人还没到第 ${k} 天">还 ${need} 天</span>`;
      }
      if (!okSp(a.spendA)) return '<span class="dim">—</span>';
      return `<span class="${cumTo(a, k) / a.spendA >= BENCH ? '' : 'tone-bad'}">${fmt.pct(cumTo(a, k) / a.spendA, 0)}</span>`;
    };

    const body = list.map(d => {
      const a = rows.get(d) || ZERO();
      const cumAll = a.n.reduce((x, y) => x + y, 0);
      return `<tr>
        <td class="day">${fmt.md(d)}<small>${fmt.wk(d)}</small></td>
        <td>${fmt.money(a.spendA)}</td>
        <td class="dim">${fmt.num(a.p0)}</td>
        <td>${a.p0 ? fmt.money(a.spendA / a.p0) : '—'}</td>
        <td>${ratePill(okSp(a.spendA) ? a.n[0] / a.spendA : null)}</td>
        ${OFFS_SHOW.slice(1).map(k => `<td>${rateAt(a, k, d)}</td>`).join('')}
        <td><b>${okSp(a.spendA) ? fmt.pct(cumAll / a.spendA, 0) : '—'}</b></td>
      </tr>`;
    }).join('');

    /* 合计只算「已经到那一天」的安装日，不然永远是「—」 */
    const reached = k => list.filter(d => addDays(d, k) <= REV_UNTIL);
    const footRate = k => {
      const ds = k === 0 ? list : reached(k);
      if (!ds.length) {
        const need = Math.min(...list.map(d => dayDiff(REV_UNTIL, addDays(d, k))));
        return `<span class="dim">还 ${need} 天</span>`;
      }
      let sp = 0, nn = 0;
      ds.forEach(d => {
        const a = rows.get(d) || ZERO();
        sp += a.spendA;
        nn += a.n.slice(0, k + 1).reduce((x, y) => x + y, 0);
      });
      if (!okSp(sp)) return '<span class="dim">—</span>';
      const partial = ds.length < list.length ? `<small class="dim"> ${ds.length}/${list.length} 天</small>` : '';
      return `${fmt.pct(nn / sp, 0)}${partial}`;
    };
    const totCum = tot.n.reduce((a, b) => a + b, 0);

    const notes = ['D1 / D3 / D7 是这批人到那天为止的累计回收率（÷ 当天花费），不是当天增量。'];
    const short = [1, 3, 7].filter(k => reached(k).length < list.length);
    if (short.length) {
      notes.push(short.map(k => {
        const ds = reached(k);
        if (!ds.length) {
          const need = Math.min(...list.map(d => dayDiff(REV_UNTIL, addDays(d, k))));
          return `D${k} 一批都没到（最早还要 ${need} 天）`;
        }
        return `D${k} 有 ${list.length - ds.length} 天还没到（最新算到 ${fmt.md(ds[ds.length - 1])} 那批）`;
      }).join('，') + '；合计只算已经到那天的天数。');
    }
    const gapNote = `<div class="table-note">${notes.join('　')}</div>`;

    return `<article class="card">
      <div class="card-head detail-head" id="detailToggle">
        <h2>逐日明细</h2><span class="sub">D0 / D1 / D3 / D7 回收比例 · ${list.length} 个完整日</span>
        <span class="toggle ${state.detail ? 'open' : ''}">${state.detail ? '收起' : '展开'}
          <svg viewBox="0 0 24 24" fill="none"><path d="m6 9 6 6 6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </span>
      </div>
      ${state.detail ? `<div class="queue-wrap"><table class="q">
        <thead>
          <tr class="grp">
            <th></th><th></th><th></th><th></th>
            <th>当天</th>
            <th colspan="3">同一批人往后（累计）</th>
            <th>到现在</th>
          </tr>
          <tr>
            <th>安装日</th><th>花费</th><th>付费人</th><th>成本/人</th>
            <th>D0</th><th>D1</th><th>D3</th><th>D7</th>
            <th>累计</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
        <tfoot><tr>
          <td>窗口合计</td>
          <td>${fmt.money(tot.spend)}</td>
          <td>${fmt.num(tot.p0)}</td>
          <td>${tot.p0 ? fmt.money(tot.spend / tot.p0) : '—'}</td>
          <td>${ratePill(okSp(tot.spend) ? tot.n[0] / tot.spend : null)}</td>
          <td>${footRate(1)}</td>
          <td>${footRate(3)}</td>
          <td>${footRate(7)}</td>
          <td>${okSp(tot.spend) ? fmt.pct(totCum / tot.spend, 0) : '—'}</td>
        </tr></tfoot>
      </table></div>${gapNote}` : ''}
    </article>`;
  }

  /* ---------------- 03 核心问题 ---------------- */

  const LV_TXT = { bad: '需处理', warn: '关注', ok: '正常', info: '数据' };
  const RANK = { bad: 3, warn: 2, ok: 1, info: 0 };

  /* 核心问题：只看两天 —— 焦点那一天（当天）和它前一天（昨天）。
     连续 N 天、近 3 天国家、窗口集中度这类多日聚合不进来：那是复盘用的，不是当天要动的。 */
  function buildIssues(dates, focusIdx) {
    const pids = state.product === 'all' ? PRODUCTS.map(p => p.id) : [state.product];
    const pool = [];

    for (const pid of pids) {
      const short = (PRODUCTS.find(p => p.id === pid) || {}).short || pid;
      const daily = buildDaily(dates, { product: pid });
      const i = Math.min(focusIdx < 0 ? daily.length - 1 : focusIdx, daily.length - 1);
      const head = daily[i];
      if (!head) continue;

      const pre = pids.length > 1 ? short + ' · ' : '';
      const days = [{ o: head, when: '当天' }];
      if (daily[i - 1]) days.push({ o: daily[i - 1], when: '昨天' });

      const basis = (M.targets && M.targets[pid] && M.targets[pid].roi_basis) || 'd0';
      const thin = basis === 'thin';

      for (const { o: cur, when } of days) {
        const live = cur.d === TODAY;
        const bud = budgetAt(cur.d, pid).total;

        /* 盘中：还没有回收，先说清楚花到哪儿了 */
        if (live) {
          const r = bud ? cur.spendA / bud : null;
          pool.push({
            rule: 'live:' + pid, when: '盘中',
            lv: (r != null && r >= 0.9) ? 'warn' : 'ok', w: 0.15, mat: cur.spendA,
            title: `${pre}${fmt.md(cur.d)} 盘中已花 ${fmt.money(cur.spendA)}${r != null ? `，占当日预算 ${fmt.pct(r, 0)}` : ''}`,
            body: `回收是实时口径（直接读后端交易），还剩 ${Math.max(0, 24 - new Date().getHours())} 小时会继续涨；数字明显不对劲再往下钻。`,
            metric: r != null ? fmt.pct(r, 0) : '—', metricSub: '盘中消耗'
          });
        }

        /* 当天 / 昨天的 D0；样本太薄的产品（Starriva）不判这条 */
        if (!thin && !live && cur.spendA > 0 && cur.rate != null) {
          const gap = cur.rate - BENCH;
          const prev = daily[i - 1];
          pool.push({
            rule: 'rate:' + pid, when,
            lv: gap <= -0.1 ? 'bad' : gap < 0 ? 'warn' : 'ok',
            w: Math.abs(gap), mat: cur.spendA,
            title: `${pre}${fmt.md(cur.d)} D0 净回收率 ${fmt.pct(cur.rate)}${gap < 0 ? `，低于 ${fmt.pct(BENCH, 0)} 基准 ${(-gap * 100).toFixed(1)}pt` : `，在 ${fmt.pct(BENCH, 0)} 基准以上`}`,
            body: `当天花 ${fmt.money(cur.spendA)}、净回收 ${fmt.money(cur.net0)}、付费 ${fmt.num(cur.p0)} 人`
              + (when === '当天' && prev && prev.rate != null
                ? `；较 ${fmt.md(prev.d)} 的 ${fmt.pct(prev.rate)} ${cur.rate >= prev.rate ? '回升' : '回落'} ${fmt.pct(Math.abs(cur.rate - prev.rate))}`
                : '') + '。',
            metric: fmt.pct(cur.rate), metricSub: `基准 ${fmt.pct(BENCH, 0)}`
          });
        }

        /* 单付费用户成本：跟自己窗口的中位数比 */
        const cpaBase = median(daily.filter(o => o.d !== cur.d).map(o => o.cpa));
        if (!thin && cur.cpa && cpaBase) {
          const dlt = cur.cpa / cpaBase - 1;
          pool.push({
            rule: 'cpa:' + pid, when,
            lv: dlt > 0.3 ? 'bad' : dlt > 0.12 ? 'warn' : 'ok',
            w: Math.abs(dlt) * 0.7, mat: cur.spendA * 0.9,
            title: `${pre}${fmt.md(cur.d)} 单付费用户成本 ${fmt.money(cur.cpa)}，比窗口中位 ${fmt.money(cpaBase)} ${dlt >= 0 ? '高' : '低'} ${fmt.pct(Math.abs(dlt), 0)}`,
            body: `当天付费 ${fmt.num(cur.p0)} 人、花 ${fmt.money(cur.spendA)}。只跟自己的中位数比，不设外部基线。`,
            metric: fmt.money(cur.cpa), metricSub: `中位 ${fmt.money(cpaBase)}`
          });
        }

        /* 账户级：某个账户单独跑飞 */
        if (cur.spendA > 0) {
          const bd = budgetAt(cur.d, pid);
          const dayAcc = accSpend([cur.d]).get(cur.d) || {};
          for (const acc of Object.keys(bd.acc)) {
            const b = bd.acc[acc] || 0, sp = dayAcc[acc] || 0;
            if (b <= 0 || sp <= 0) continue;
            const r = sp / b;
            if (r > (live ? 1.0 : 1.1)) {
              pool.push({
                rule: 'accpace:' + pid + acc, when, lv: r > 1.3 ? 'bad' : 'warn', w: r - 1, mat: sp,
                title: `${pre}${acc} ${fmt.md(cur.d)} 花到日预算的 ${fmt.pct(r, 0)}（${fmt.money(sp)} / ${fmt.money(b)}）`,
                body: `这个账户单独超了 ${fmt.money(sp - b)}。产品合计看着正常，但超支集中在一个账户上。`,
                metric: fmt.pct(r, 0), metricSub: acc
              });
            }
          }
        }

        /* 产品整体 vs 当日预算 */
        if (bud > 0 && cur.spendA && !live) {
          const r = cur.spendA / bud;
          if (r < 0.85) {
            pool.push({
              rule: 'pace:' + pid, when, lv: r < 0.6 ? 'bad' : 'warn', w: 0.85 - r, mat: cur.spendA,
              title: `${pre}${fmt.md(cur.d)} 只花了 ${fmt.pct(r, 0)} 当日预算（${fmt.money(cur.spendA)} / ${fmt.money(bud)}）`,
              body: `差 ${fmt.money(bud - cur.spendA)}。先看是被限流、出价过低，还是主动关了几条。`,
              metric: fmt.pct(r, 0), metricSub: `缺 ${fmt.money(bud - cur.spendA)}`
            });
          } else if (r > 1.05) {
            pool.push({
              rule: 'pace:' + pid, when, lv: 'bad', w: r - 1, mat: cur.spendA,
              title: `${pre}${fmt.md(cur.d)} 超当日预算 ${fmt.money(cur.spendA - bud)}（${fmt.pct(r, 0)}）`,
              body: `当日预算 ${fmt.money(bud)}，实际花 ${fmt.money(cur.spendA)}。`,
              metric: fmt.pct(r, 0), metricSub: '超预算'
            });
          }
        }
      }
    }

    const PRIO = { accpace: 6, rate: 5, pace: 4, cpa: 2, live: 3 };
    const prioOf = o => PRIO[o.rule.split(':')[0]] || 0;
    pool.sort((a, b) => (RANK[b.lv] - RANK[a.lv]) || ((b.mat || 0) - (a.mat || 0)) || (prioOf(b) - prioOf(a)) || (b.w - a.w));

    /* 当天最多 3 条、昨天最多 2 条 —— 两天都得看得见，不能被当天挤掉 */
    const pick = (arr, n) => {
      const seen = new Set(), out = [];
      for (const o of arr) {
        const sig = o.rule.split(':')[0];      // 同一天同一类规则只留最重的那条
        if (seen.has(sig)) continue;
        seen.add(sig);
        out.push(o);
        if (out.length >= n) break;
      }
      return out;
    };
    const now = pool.filter(o => o.when !== '昨天');
    const prev = pool.filter(o => o.when === '昨天');
    return pick(now, 3).concat(pick(prev, 2));
  }

  function issuesCard(dates, focusIdx) {
    const list = buildIssues(dates, focusIdx);
    const rows = list.map(it => `<div class="issue ${it.lv}">
      <span class="badge">${LV_TXT[it.lv]}</span>
      <div class="tx"><span class="when">${it.when || ''}</span><b>${it.title}</b><p>${it.body}</p></div>
      <div class="mt">${it.metric || ''}${it.metricSub ? `<small>${it.metricSub}</small>` : ''}</div>
    </div>`).join('');
    return `<article class="card">${rows ? `<div class="issue-list">${rows}</div>` : '<div class="empty">当前窗口没有需要处理的问题</div>'}</article>`;
  }

  /* ---------------- 下钻：账号 → campaign → adset → ad ---------------- */

  /* 每层「红灯行占了多少钱」：越往细越容易看出烂在哪一层。
     不按 D0 合计算，因为各层合计必然一样（同一批钱同一批回收）。 */
  function levelTone(day) {
    const m = new Map();
    for (const lv of LEVELS) {
      const rs = groupRows(lv, [day], {});
      const sp = rs.reduce((a, o) => a + o.spend, 0);
      const red = rs.filter(o => o.d0 != null && o.d0 < LIGHT.warn).reduce((a, o) => a + o.spend, 0);
      m.set(lv, sp ? red / sp : null);
    }
    return m;
  }
  function shareTone(v) {
    if (v == null) return 'mute';
    return v < 0.15 ? 'ok' : v < 0.4 ? 'warn' : 'bad';
  }
  function shareLamp(v) {
    const t = shareTone(v);
    return `<i class="lamp ${t}" title="红灯行占花费 ${v == null ? '—' : fmt.pct(v, 0)}"></i>`;
  }

  function drillCard(day, win, tones) {
    return `<article class="card">
      <div class="drill-head">
        <h2>四层明细</h2>
        <span class="sub">${fmt.md(day)} · 只列当天在投的 · 灯按当天 D0 回收率 · 点名称看这条的近 ${win.length} 天</span>
        <div class="head-right">
          <div class="search">
            <svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.8"/><path d="m16.5 16.5 4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
            <input id="drillQ" type="search" placeholder="搜账号 / campaign / adset / ad" value="${esc(state.q)}">
          </div>
          <div class="seg lamps" id="levelSeg">
            ${LEVELS.map(l => `<button data-level="${l}" class="${state.level === l ? 'is-active' : ''}">${lamp(tones.get(l))}${LV_NAME[l]}<em>${fmt.pct(tones.get(l), 0)}</em></button>`).join('')}
          </div>
        </div>
      </div>
      <div id="drillBody"></div>
    </article>`;
  }


  /* 当天跑到 D0 基准以上的 AD，单独列一块 —— 这些是能复制的 */
  const OK_MIN_PAYERS = 2;      // 付费人数要 > 2
  const OK_MIN_SPEND = 50;      // 花费要 > $50，量太小看不出东西

  function okAdsPanel(day) {
    const allAds = groupRows('ad', [day], { withQ: true });
    const ok = allAds.filter(o => o.d0 != null && o.d0 >= BENCH
        && o.p0 > OK_MIN_PAYERS && o.spend > OK_MIN_SPEND)
      .sort((a, b) => b.spend - a.spend);
    if (!ok.length) {
      return `<div class="okads empty-ok">当天没有同时满足「D0 ≥ ${fmt.pct(BENCH, 0)}、付费 > ${OK_MIN_PAYERS} 人、花费 > ${fmt.money(OK_MIN_SPEND)}」的广告。</div>`;
    }
    const totalSpend = allAds.reduce((a, o) => a + o.spend, 0);
    const okSpend = ok.reduce((a, o) => a + o.spend, 0);
    const LIMIT = 6;
    const show = state.okAll ? ok : ok.slice(0, LIMIT);

    const rows = show.map(o => `<tr>
      <td>
        <div class="name-cell"><span class="txt" title="${esc(o.ad || '')}">${esc(o.ad || '(未命名)')}</span></div>
        <div class="ok-sub">${esc(o.ads || '—')} · ${esc(o.camp || '—')}</div>
      </td>
      <td>${fmt.money(o.spend)}</td>
      <td><b>${fmt.money(o.n[0])}</b></td>
      <td>${ratePill(o.d0)}</td>
      <td class="dim">${fmt.num(o.p0)}</td>
      <td>${o.cpa ? fmt.money(o.cpa) : '<span class="dim">—</span>'}</td>
    </tr>`).join('');

    return `<div class="okads">
      <div class="okads-head">
        <span class="oktag">D0 达标 AD</span>
        <b>${ok.length} 条</b>
        <span class="dim">花 ${fmt.money(okSpend)}，占当天 ${fmt.pct(totalSpend ? okSpend / totalSpend : 0, 0)}</span>
        <span class="dim" style="margin-left:auto">D0 ≥ ${fmt.pct(BENCH, 0)} · 付费 > ${OK_MIN_PAYERS} 人 · 花费 > ${fmt.money(OK_MIN_SPEND)}${ok.some(o => o.est) ? ' · 带「估」的按花费分摊' : ''}</span>
      </div>
      <div class="table-wrap"><table class="d okads-t">
        <thead><tr><th>广告</th><th>花费</th><th>D0 净</th><th>D0 率</th><th>付费人</th><th>成本/人</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      ${ok.length > LIMIT ? `<button class="okmore" id="okMore">${state.okAll ? '收起' : `还有 ${ok.length - LIMIT} 条，展开`}</button>` : ''}
    </div>`;
  }

  /* 算一遍当前层级的行；drillBody（首次）和 refreshDrill（展开/选中）共用 */
  function drillCalc(day, win) {
    const lv = state.level;
    const top = groupRows(lv, [day], { withQ: true });
    if (!top.length) return null;

    const cache = {};
    const kidsOf = l => {
      if (!cache[l]) cache[l] = groupRows(l, [day], { withQ: true });
      return cache[l];
    };
    const kidsOfRow = (o, l) => {
      const childLv = TREE[l];
      if (!childLv) return [];
      return kidsOf(childLv).filter(r => parentKey(childLv, r) === o.key);
    };

    const nameOf = (o, l) => l === 'account' ? (o.acc || '—')
      : l === 'campaign' ? (o.camp || '—')
        : l === 'adset' ? (o.ads || '(未命名)') : (o.ad || '(未命名)');

    const extraOf = (o, l) => {
      if (l === 'account') {
        const a = acctMeta(o.acc) || {};
        const p = (PRODUCTS.find(x => x.id === a.product) || {}).short || a.product || '';
        return [p, a.country ? '主投 ' + a.country : ''].filter(Boolean).join(' · ');
      }
      if (l === 'campaign') return o.acc || '';
      if (l === 'adset') return o.camp || '';
      return o.ads || '';
    };

    const rowHTML = (o, rowLv, label, extra, hasChild, key, depth) => {
      const net7 = win.map(d => (o.byDay.get(d) || {}).n0 || 0);
      const caret = hasChild
        ? `<button class="caret ${state.open.has(key) ? 'open' : ''}" data-k="${encodeURIComponent(key)}" aria-label="展开"><svg viewBox="0 0 24 24" fill="none"><path d="m9 5 7 7-7 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg></button>`
        : '<button class="caret blank" tabindex="-1"></button>';
      const isFocus = state.focus && state.focus.lv === rowLv && state.focus.key === o.key;
      const strong = rowLv === 'account' || rowLv === 'campaign';
      return `<tr class="lv-${rowLv} d${depth} ${isFocus ? 'is-focus' : ''}" data-lv="${rowLv}" data-key="${encodeURIComponent(key)}" data-node="${encodeURIComponent(o.key)}" data-name="${esc(label)}" data-extra="${esc(extra || '')}">
        <td class="tree-cell" style="padding-left:${10 + Math.min(depth, 3) * 12}px">
          ${lamp(o.d0)}${caret}
          <span class="txt" title="${esc(label)}">${strong ? `<b>${esc(label)}</b>` : esc(label)}${extra ? `<span class="dim" style="font-size:11px"> · ${esc(extra)}</span>` : ''}</span>
        </td>
        <td>${fmt.money(o.spend)}</td>
        <td><b>${fmt.money(o.n[0])}</b></td>
        <td>${ratePill(o.d0)}${o.est ? '<i class="est" title="这天没有这一条的回收归属，按花费分摊">估</i>' : ''}</td>
        <td class="dim">${fmt.num(o.p0)}</td>
        <td>${o.cpa ? fmt.money(o.cpa) : '<span class="dim">—</span>'}</td>
        <td class="spark-cell">${sparkSvg(net7, { kind: 'bar', w: 62, h: 18, color: o.n[0] >= o.spend * BENCH ? '#a7e3c3' : '#f5c4bd' })}</td>
      </tr>`;
    };

    const renderRows = (l, list, depth) => {
      let out = '';
      for (const o of list) {
        const kids = kidsOfRow(o, l);
        const key = l + '|' + o.key;
        out += rowHTML(o, l, nameOf(o, l), extraOf(o, l), kids.length > 0, key, depth);
        if (kids.length && state.open.has(key)) out += renderRows(TREE[l], kids, depth + 1);
      }
      return out;
    };

    const total = top.reduce((a, o) => {
      a.spend += o.spend; a.p0 += o.p0; a.n0 += o.n[0];
      return a;
    }, { spend: 0, p0: 0, n0: 0 });

    return {
      lv, top,
      body: renderRows(lv, top, 0),
      total,
      rate: okSp(total.spend) ? total.n0 / total.spend : null
    };
  }

  function drillFootHTML(c) {
    return `<tr>
        <td class="tree-cell">${lamp(c.rate)}<span class="txt">${c.top.length} 条在投${LV_NAME[c.lv]}</span></td>
        <td>${fmt.money(c.total.spend)}</td>
        <td>${fmt.money(c.total.n0)}</td>
        <td>${ratePill(c.rate)}</td>
        <td>${fmt.num(c.total.p0)}</td>
        <td>${c.total.p0 ? fmt.money(c.total.spend / c.total.p0) : '—'}</td>
        <td></td>
      </tr>`;
  }

  function drillBody(day, win) {
    const c = drillCalc(day, win);
    if (!c) return `<div class="empty">${fmt.md(day)} 这一天没有在投的${LV_NAME[state.level]}</div>`;

    return `${okAdsPanel(day)}<div class="table-wrap"><table class="d drill-t">
      <colgroup>
        <col class="c-name"><col class="c-spend"><col class="c-d0"><col class="c-rate">
        <col class="c-payers"><col class="c-cpa"><col class="c-spark">
      </colgroup>
      <thead>
        <tr class="grp">
          <th>名称</th>
          <th colspan="5">${fmt.md(day)} 当日</th>
          <th>近 ${win.length} 天 D0 净</th>
        </tr>
        <tr>
          <th>账号 / Campaign / Adset / Ad</th><th>花费</th><th>D0 净</th><th>D0 率</th><th>付费人</th><th>成本/人</th>
          <th class="spark-cell">逐日</th>
        </tr>
      </thead>
      <tbody id="drillRows">${c.body}</tbody>
      <tfoot id="drillFoot">${drillFootHTML(c)}</tfoot>
    </table></div><div id="focusSlot">${focusHTML(win)}</div>`;
  }

  function focusHTML(fd) {
    const f = state.focus;
    if (!f) return '';
    const node = groupRows(f.lv, fd, {}).find(o => o.key === f.key);
    if (!node) return '';
    const dates = fd;
    const sp = dates.map(d => (node.byDay.get(d) || {}).spend || 0);
    const rt = dates.map(d => { const x = node.byDay.get(d); return x && okSp(x.spend) ? x.n0 / x.spend : null; });

    const spendChart = chartHTML({
      H: 150, dates,
      stack: [{ vals: sp, color: '#2563eb' }],
      labels: dates.length <= 8 ? dates.length : 4,
      fmtAxis: v => fmt.compact(v),
      tip: i => `${dates[i]} · ${fmt.money(sp[i])}`
    });
    const rateChart = chartHTML({
      H: 150, dates,
      vals: rt.map(v => ({ v })),
      ref: BENCH, refLabel: '50%', gstep: 0.25,
      labels: dates.length <= 8 ? dates.length : 4,
      color: TONE_C[tone(node.d0)],
      fmtAxis: v => (v * 100).toFixed(0) + '%',
      fmtTip: v => fmt.pct(v)
    });

    return `<div class="focus">
      <div class="focus-head">
        <span class="tag">${LV_NAME[f.lv]}</span>
        ${lamp(node.d0, 'lg')}
        <b>${esc(f.name)}</b>
        <button class="btn-ghost" id="focusClose">收起</button>
      </div>
      <div class="focus-body">
        <div class="focus-stats">
          <div><span>花费</span><b>${fmt.money(node.spend)}</b></div>
          <div><span>付费人</span><b>${fmt.num(node.p0)}</b></div>
          <div><span>成本/人</span><b>${node.cpa ? fmt.money(node.cpa) : '—'}</b></div>
          <div><span>D0 净</span><b>${fmt.money(node.n[0])}</b></div>
          <div><span>D0 率</span><b>${fmt.pct(node.d0)}</b></div>
          <div><span>累计率</span><b>${fmt.pct(node.cumRate, 0)}</b></div>
        </div>
        <div class="focus-chart">${spendChart}<div class="cap">每日花费</div></div>
        <div class="focus-chart">${rateChart}<div class="cap">D0 回收率（虚线 50%）</div></div>
      </div>
    </div>`;
  }

  /* ---------------- 渲染 ---------------- */

  let CUR_FD = [];
  let CUR_DAY = null;
  let CUR_WIN = [];

  /* 展开 / 选中只换行和底部面板，表格和图表都不重建 —— 页面不抖、滚动位置不动 */
  function refreshDrill() {
    const tb = document.getElementById('drillRows');
    const c = drillCalc(CUR_DAY, CUR_WIN);
    if (!tb || !c) {
      const body = document.getElementById('drillBody');
      if (body) { body.innerHTML = drillBody(CUR_DAY, CUR_WIN); mountCharts(); }
      return;
    }
    /* 先把新行拼好再一次替换，避免空档 */
    tb.innerHTML = c.body;
    const tf = document.getElementById('drillFoot');
    if (tf) tf.innerHTML = drillFootHTML(c);
    const slot = document.getElementById('focusSlot');
    if (slot) slot.innerHTML = focusHTML(CUR_WIN);
    mountCharts();
  }

  function render() {
    syncTabs();
    if (state.tab === 'drill') { renderDrill(); return; }
    const wd = windowDates();
    const FD = wd.filter(d => d !== TODAY);
    CUR_FD = FD;

    const focus = focusDate();
    const focusIdx = wd.indexOf(focus);
    const daily = buildDaily(wd);
    const cur = daily[focusIdx] || daily[daily.length - 1];

    /* 三层趋势：按焦点日看，只列当天在投的；右边 sparkline 用近 7 天做背景 */
    const day = focus;                 // 选「今天」就看今天（有实时 D0）
    const WIN = wd.slice(-7);
    CUR_FD = FD;
    CUR_DAY = day;
    CUR_WIN = WIN;
    const tones = levelTone(day);

    const budFocus = budgetAt(focus).total;
    const usedNow = budFocus ? cur.spendA / budFocus : null;

    main.innerHTML = `
      <section class="sect">
        ${sec('01', '核心问题', `只看当天和昨天 · 逐条事实，不拿区间平均下判断`, '')}
        ${issuesCard(wd, focusIdx)}
      </section>

      <section class="sect">
        ${sec('02', '预算 · 消耗 · D0 回收率',
          `左表：产品 → 账户 → campaign 逐层展开${IS_AG ? '' : ' · 含自投 zt'} · 右图：每日花费走势`,
          budFocus
            ? `<b>${fmt.money(cur.spendA)}</b> / ${fmt.money(budFocus)} · 消耗比例 ${fmt.pct(usedNow, 0)}`
            : `<b>${fmt.money(cur.spendA)}</b> 已花 · 当日预算未记账`)}
        <div class="row-bs">
          ${budgetSpendCard(wd, focus, cur, focusIdx)}
          ${spendTrendCard(wd, focusIdx, cur)}
        </div>
      </section>

      <section class="sect">
        ${sec('03', '回收情况', `当日快照 + 逐日走势 · 只算 ${AG} 自己的量 · D0 基准 ${fmt.pct(BENCH, 0)}`, '')}
        ${snapStrip(daily, focusIdx)}
        <div class="row-mini">${recoveryCards(wd, focusIdx)}</div>
        ${detailCard(wd)}
      </section>

    `;


    syncHash();
    requestAnimationFrame(() => {
      mountCharts();
      $$('.card').forEach((c, i) => { c.style.animationDelay = Math.min(i * 18, 140) + 'ms'; });
    });
  }

  /* ---------------- 下钻 tab ---------------- */

  function renderDrill() {
    /* 下钻按自然日，含今天（今天有实时 D0） */
    const days = DATES.slice(-Math.min(DATES.length, IS_AG ? 7 : 7));
    if (!state.drillDay || !days.includes(state.drillDay)) state.drillDay = days[days.length - 1];
    const day = state.drillDay;
    const tones = levelTone(day);
    CUR_DAY = day;
    CUR_WIN = days;

    main.innerHTML = `
      <section class="sect">
        ${sec('04', '四层明细',
          `账号 → Campaign → Adset → Ad，只列当天在投的 · 行首灯 = 当天 D0（≥${fmt.pct(LIGHT.ok, 0)} 绿 · ${fmt.pct(LIGHT.warn, 0)}–${fmt.pct(LIGHT.ok, 0)} 黄 · &lt;${fmt.pct(LIGHT.warn, 0)} 红）· 层级按钮上的数字 = 红灯行占该层花费`,
          `${fmt.md(day)}${day === TODAY ? ' 盘中' : ''} · 花费 ${fmt.money((() => { let v = 0; for (const r of ALL) if (r.lv === 'campaign' && r.d === day && match(r, {})) v += r.spend; return v; })())}`)}
        <article class="card">
          <div class="drill-head">
            <div class="seg" id="daySeg">
              ${days.map(d => `<button data-day="${d}" class="${d === day ? 'is-active' : ''}">${fmt.md(d)}${d === TODAY ? '·盘中' : ''}</button>`).join('')}
            </div>
            <div class="head-right">
              <div class="search">
                <svg viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.8"/><path d="m16.5 16.5 4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
                <input id="drillQ" type="search" placeholder="搜账号 / campaign / adset / ad" value="${esc(state.q)}">
              </div>
              <div class="seg lamps" id="levelSeg">
                ${LEVELS.map(l => `<button data-level="${l}" class="${state.level === l ? 'is-active' : ''}" title="红灯行占该层花费">${shareLamp(tones.get(l))}${LV_NAME[l]}<em>${fmt.pct(tones.get(l), 0)}</em></button>`).join('')}
              </div>
            </div>
          </div>
          <div id="drillBody"></div>
        </article>
      </section>`;

    const body = document.getElementById('drillBody');
    if (body) body.innerHTML = drillBody(day, days);
    syncHash();
    requestAnimationFrame(() => {
      mountCharts();
      $$('.card').forEach((c, i) => { c.style.animationDelay = Math.min(i * 18, 140) + 'ms'; });
    });
  }

  function syncTabs() {
    $$('#tabs button').forEach(b => b.classList.toggle('is-active', b.dataset.tab === state.tab));
    /* 下钻页固定 7 天，概览页跟时间口径走 */
    const seg = document.getElementById('rangeSeg');
    if (seg) seg.style.display = state.tab === 'drill' ? 'none' : '';
  }

  function syncHash() {
    const q = new URLSearchParams();
    if (state.tab !== 'overview') q.set('tab', state.tab);
    if (state.product !== 'all') q.set('product', state.product);
    q.set('v', state.view);
    if (state.level !== 'account') q.set('level', state.level);
    if (state.tab === 'drill' && state.drillDay) q.set('day', state.drillDay);
    const h = q.toString();
    history.replaceState(null, '', h ? '#' + h : location.pathname + location.search);
  }

  function readHash() {
    const q = new URLSearchParams(location.hash.slice(1));
    const p = q.get('product');
    if (p && (p === 'all' || PRODUCTS.some(x => x.id === p))) state.product = p;
    const v = q.get('v') || '';
    if (v === 'today' || v === 'y1' || v === 'y2') state.view = v;
    else if (/^d:\d{4}-\d{2}-\d{2}$/.test(v)) state.view = v;
    else if (/^\d+$/.test(v)) state.view = 'today';   // 旧链接里的 7 / 14 / 30
    const l = q.get('level');
    if (LEVELS.includes(l)) state.level = l;
    if (q.get('tab') === 'drill') state.tab = 'drill';
    const dd = q.get('day');
    if (dd && /^\d{4}-\d{2}-\d{2}$/.test(dd)) state.drillDay = dd;
  }

  function syncControls() {
    $$('#productSeg button').forEach(x => x.classList.toggle('is-active', x.dataset.product === state.product));

    const custom = isCustomDate();
    $$('#rangeSeg button').forEach(x => x.classList.toggle('is-active', !custom && x.dataset.view === state.view));

    const btn = $('#datePickBtn'), inp = $('#datePick');
    if (!btn) return;
    const f = focusDate();
    btn.classList.toggle('is-active', custom);
    btn.title = custom ? `焦点日 ${f} · 窗口 ${WINDOW_DAYS} 天` : '按日历挑一天';
    const lb = $('#datePickLabel');
    if (lb) lb.textContent = custom ? fmt.md(f) : '选日期';
    if (inp) inp.value = custom ? f : '';
  }

  /* ---------------- 顶部 ---------------- */

  function initChrome() {
    $('#productSeg').innerHTML =
      `<button data-product="all">全部</button>` +
      PRODUCTS.map(p => `<button data-product="${p.id}">${p.short}</button>`).join('');

    $$('#productSeg button').forEach(b => b.addEventListener('click', () => {
      state.product = b.dataset.product;
      state.open.clear();
      state.focus = null;
      syncControls();
      render();
    }));

    $$('#rangeSeg button').forEach(b => b.addEventListener('click', () => {
      state.view = b.dataset.view;
      state.open.clear();
      state.focus = null;
      syncControls();
      render();
    }));

    /* 日历：挑任意一天当焦点日，窗口固定往它前面看 7 天 */
    const dpBtn = $('#datePickBtn'), dpIn = $('#datePick');
    if (dpBtn && dpIn) {
      dpIn.min = DATES[0];
      dpIn.max = TODAY;
      dpBtn.addEventListener('click', () => {
        try {
          if (dpIn.showPicker) { dpIn.showPicker(); return; }
        } catch (err) { /* 老浏览器走下面的兜底 */ }
        dpIn.style.pointerEvents = 'auto';
        dpIn.click();
        setTimeout(() => { dpIn.style.pointerEvents = 'none'; }, 0);
      });
      dpIn.addEventListener('change', () => {
        if (!dpIn.value) return;
        state.view = 'd:' + dpIn.value;
        state.open.clear();
        state.focus = null;
        syncControls();
        render();
      });
    }

    const src = $('#sourceSeg');
    if (src) src.remove();

    const tabs = document.getElementById('tabs');
    if (tabs) {
      tabs.addEventListener('click', e => {
        const b = e.target.closest('button[data-tab]');
        if (!b) return;
        state.tab = b.dataset.tab;
        state.focus = null;
        state.open.clear();
        render();
      });
    }

    $('#notesBtn').addEventListener('click', openDrawer);
    $('#drawerClose').addEventListener('click', closeDrawer);
    $('#scrim').addEventListener('click', closeDrawer);
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });

    if (IS_AG) document.querySelector('.brand h1').textContent = M.title || '投放效果看板';

    /* 顶栏身份：Ocean 密钥=代理·Ocean；hebin=内部·全部（含自投） */
    if (IS_AG) {
      $('#who').innerHTML = `<span class="who-lb">代理</span><b>${esc(AG)}</b>`;
      document.title = (M.title || '投放效果看板') + ' · Ocean';
    } else {
      $('#who').innerHTML = `<span class="who-lb">内部</span><b>全部</b><span class="who-tag">含自投</span>`;
      document.title = (M.title || '投放效果看板') + ' · 内部';
    }
    $('#who').classList.toggle('is-ag', IS_AG);

    $('#brandSub').textContent = IS_AG
      ? `安装日口径 · 净回收 D0–D7 · 窗口固定 ${WINDOW_DAYS} 天`
      : `${PRODUCTS.map(p => p.short).join(' + ')} · 含自投 zt · 安装日口径 · 净回收 D0–D7 · 窗口固定 ${WINDOW_DAYS} 天`;
    $('#benchHint').textContent = `D0 净回收率 ${fmt.pct(BENCH, 0)} = 基准`;

    let rz;
    window.addEventListener('resize', () => {
      clearTimeout(rz);
      rz = setTimeout(mountCharts, 160);
    });

    tickFreshness();
    setInterval(tickFreshness, 30000);
    setInterval(() => { if (!document.hidden) location.reload(); }, 10 * 60 * 1000);

    main.addEventListener('click', e => {
      if (e.target.closest('#okMore')) {
        state.okAll = !state.okAll;
        refreshDrill();
        return;
      }
      const bk = e.target.closest('[data-bk]');
      if (bk) {
        const k = bk.dataset.bk;
        if (state.open.has(k)) state.open.delete(k); else state.open.add(k);
        refreshBs();        // 只换表体，图表和滚动位置都不动
        return;
      }
      const caret = e.target.closest('.caret[data-k]');
      if (caret) {
        const k = decodeURIComponent(caret.dataset.k);
        if (state.open.has(k)) state.open.delete(k); else state.open.add(k);
        refreshDrill();
        return;
      }
      const dayBtn = e.target.closest('#daySeg button');
      if (dayBtn) {
        state.drillDay = dayBtn.dataset.day;
        state.okAll = false;
        state.open.clear();
        state.focus = null;
        render();
        return;
      }
      const lvBtn = e.target.closest('#levelSeg button');
      if (lvBtn) {
        state.level = lvBtn.dataset.level;
        state.open.clear();
        state.focus = null;
        render();
        return;
      }
      if (e.target.closest('#focusClose')) {
        state.focus = null;
        refreshDrill();
        return;
      }
      if (e.target.closest('#detailToggle')) {
        state.detail = !state.detail;
        render();
        return;
      }
      const tr = e.target.closest('tr[data-key]');
      if (tr) {
        const lv = tr.dataset.lv;
        const key = decodeURIComponent(tr.dataset.node);
        const name = tr.dataset.name + (tr.dataset.extra ? ' · ' + tr.dataset.extra : '');
        if (state.focus && state.focus.lv === lv && state.focus.key === key) state.focus = null;
        else state.focus = { lv, key, name };
        refreshDrill();
      }
    });

    document.addEventListener('input', e => {
      if (e.target && e.target.id === 'drillQ') {
        state.q = e.target.value.trim();
        refreshDrill();
      }
    });
  }

  function tickFreshness() {
    const put = (id, html) => { const n = document.getElementById(id); if (n) n.innerHTML = html; };
    const gen = new Date((M.generated_at || '').replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
    const ok = !isNaN(gen.getTime());

    if (!ok) put('asOf', esc(M.as_of || '数据时间未知'));
    else {
      const mins = Math.max(0, Math.round((Date.now() - gen.getTime()) / 60000));
      const rel = mins < 1 ? '刚刚' : mins < 60 ? `${mins} 分钟前` : `${(mins / 60).toFixed(1)} 小时前`;
      put('asOf', `数据更新于 <b>${rel}</b>`);
    }

    /* 花费和回收是两条独立管线，各自的时间要分开写清楚 */
    const hms = t => ((t || '').slice(11, 16) || '—');
    put('feedAt',
      `花费 <b>${hms(M.spend_pulled_at || M.generated_at)}</b>` +
      ` · 回收实时 <b>${hms(M.live_revenue_at || M.generated_at)}</b>`);

    const sched = (M.refresh_hours_bj && M.refresh_hours_bj.length ? M.refresh_hours_bj : [0, 6, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22]).slice().sort((a, b) => a - b);
    const bjNow = new Date(Date.now() + 8 * 3600e3);
    const curH = bjNow.getUTCHours() + bjNow.getUTCMinutes() / 60;
    const nh = sched.find(h => h > curH);
    const p2 = n => String(n).padStart(2, '0');
    const nextTxt = nh === undefined ? `明天 ${p2(sched[0])}:00` : `${p2(nh)}:00`;
    put('nextRefresh', `刷新 0/6 点 + 白天 8–22 每小时 · 下次 <b>${nextTxt}</b>`);

    const fc = document.getElementById('footCount');
    if (fc) fc.textContent = `${DATES[0]} ~ ${TODAY} · ${ALL.length} 行 · 回收明细到 ${REV_UNTIL}`;
  }

  /* ---------------- 口径抽屉 ---------------- */

  function openDrawer() {
    const b = $('#drawerBody');
    const BD = M.budget_detail || {};
    const rows = ACCOUNTS.filter(a => a.budget > 0)
      .map(a => {
        const p = (PRODUCTS.find(x => x.id === a.product) || {}).short || a.product;
        const det = BD[a.name] || [];
        const lines = det.map(d => `${esc(d.camp)} <em>${esc(d.kind)}</em> ${fmt.money(d.budget)}`).join('<br>');
        return `<dt>${esc(a.name)}</dt><dd>${p} · 主投 ${esc(a.country)}（占 ${fmt.pct(a.country_share, 0)}）· 日预算 <b>${fmt.money(a.budget)}</b>`
          + (lines ? `<div class="bd">${lines}</div>` : '') + `</dd>`;
      }).join('');

    b.innerHTML = `
      <h3>核心口径</h3>
      <ul>
        <li><b>D0 净回收率</b> = 安装当天净回收 / 当天花费。<b>50% 为正常参考值</b>，任何国家同一标准。</li>
        <li><b>D1 / D3 / D7</b> = 同一批新增在往后第 1/3/7 天的净回收额。</li>
        <li><b>Cohort 累计回收</b> = 那一天的新增，从 D0 到报表日的累计净回收 ÷ 那天的花费。各批观察期不同，越新越低是正常的。</li>
        <li><b>净回收</b> = Google Play ×0.70 + Stripe ×0.97（已扣渠道分成），剔除内部/测试账号。</li>
        <li><b>单个新增付费用户成本</b> = 花费 / D0 付费人数。只看趋势，不设基线。</li>
        <li><b>灯</b>：D0 ≥ ${fmt.pct(LIGHT.ok, 0)} 绿、${fmt.pct(LIGHT.warn, 0)}–${fmt.pct(LIGHT.ok, 0)} 黄、&lt; ${fmt.pct(LIGHT.warn, 0)} 红；样本太小的产品不打灯。</li>
        <li><b>消耗只看趋势</b>：每日花费是 Meta 实时拉的账单数，不再拿它跟固定预算比；预算只在预算卡里按账户看完成度。</li>
      </ul>

      <h3>预算台账</h3>
      <dl class="kv">${rows}</dl>
      <div class="note">${M.budget_note || ''}</div>
      ${IS_AG ? '' : `<div class="note" style="background:#f2f4f8;border-color:var(--line);color:var(--ink-2)">内部全量视图：含 Ocean 与自投（campaign 名带 zt1 / zt2，页显 ZT1/ZT2）。自投通常无单独日预算台账；花费与回收按合计口径。</div>`}

      <h3>页面口径</h3>
      <ul>
        <li>时间按「实时（今天）/ 昨天 / 前天」优先，长区间放后面 —— 微操看的是最近一两天。</li>
        <li>一切以「每天」为单位：曲线每个点就是那一天的实数，参考线只作参照，不做事先平均。</li>
        <li>今天盘中只记花费，不结算回收，所以回收曲线到昨天为止。</li>
        ${IS_AG ? `<li>回收只算 ${esc(AG)} 自己的量，不含自投。</li>` : `<li>内部全量：花费与回收含 Ocean + 自投 zt。</li>`}
      </ul>

      <h3>数据更新</h3>
      <ul>
        <li>北京时间 0、6 点，白天 8–22 点每小时自动刷新（0/6/8–22）；夜里不加频。</li>
        <li>0 点是日切后第一刷，此时更新「今天」。</li>
        <li>数据非实时秒级，以顶栏「数据更新于」时间为准。</li>
        <li>顶栏「拉取最新」：默认立刻重载已发布的最新包（去缓存）。若本机已配置后台 webhook，会先触发 box 真拉 Meta/回收再自动等待更新。</li>
      </ul>

      <h3>其它</h3>
      <ul>
        <li>归因以 AppsFlyer 为准，Meta 自报装机仅作参考。</li>
        ${IS_AG ? '' : '<li>大R = 同一 cohort 内累计毛利 &gt; $100 的付费人。</li>'}
      </ul>`;
    $('#drawer').hidden = false;
    $('#scrim').hidden = false;
  }

  function closeDrawer() {
    $('#drawer').hidden = true;
    $('#scrim').hidden = true;
  }

  /* ---------------- boot ---------------- */

  readHash();
  initChrome();
  syncControls();
  render();
  window.addEventListener('hashchange', () => { readHash(); syncControls(); render(); });
})();
