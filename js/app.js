/* ============================================================
 *  app.js — 全球热点实时追踪 · 前端
 *  三大版块：
 *    1. 深度解读（digest）   — AI 精选国际/国内各 20 条 + 局势综述
 *    2. 实时热搜（hot）      — 直连 GitHub 热搜归档（微博/知乎/百度/头条/抖音/B站）
 *    3. 全部新闻（feed）     — raw.json 全量原始新闻时间流
 *  读取：data/top20.json（AI 深度解读）+ data/raw.json（全量）
 *        热搜直连 https://raw.githubusercontent.com/iiecho1/hot_searches_for_apps
 * ============================================================ */

(() => {
  'use strict';

  const state = {
    top: null,            // top20.json 数据
    raw: null,            // raw.json 全量数据
    activeSection: 'digest',  // digest | hot | feed
    activeDigest: 'international', // digest 子版块
    activeCat: 'all',
    query: '',
    theme: localStorage.getItem('gh_theme') || 'dark',
    focusIdx: -1,
    _searchTimer: null,
  };

  // 数据文件路径
  const TOP_URL = 'data/top20.json';
  const RAW_URL = 'data/raw.json';
  // 热搜归档源（GitHub 公开仓库，CORS 开放）
  const HOT_BASE = 'https://raw.githubusercontent.com/iiecho1/hot_searches_for_apps/main/archives';
  const HOT_PLATFORMS = [
    { id: '微博',   name: '微博热搜',   ico: '🔴', color: '#e6162d', url: `${HOT_BASE}/微博/微博.md`,     site: 'https://s.weibo.com/top/summary' },
    { id: '知乎',   name: '知乎热榜',   ico: '🔵', color: '#1772f6', url: `${HOT_BASE}/知乎/知乎.md`,     site: 'https://www.zhihu.com/hot' },
    { id: '百度',   name: '百度热搜',   ico: '🟣', color: '#2932e1', url: `${HOT_BASE}/百度/百度.md`,     site: 'https://top.baidu.com/board?tab=realtime' },
    { id: '头条',   name: '今日头条',   ico: '🟠', color: '#fe2c55', url: `${HOT_BASE}/今日头条/今日头条.md`, site: 'https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc' },
    { id: '抖音',   name: '抖音热点',   ico: '⚫', color: '#161823', url: `${HOT_BASE}/抖音/抖音.md`,     site: 'https://www.douyin.com/hot' },
    { id: '哔哩哔哩', name: 'B站热搜',   ico: '🟢', color: '#fb7299', url: `${HOT_BASE}/哔哩哔哩/哔哩哔哩.md`, site: 'https://www.bilibili.com/v/popular/rank/all' },
  ];

  // 静态版本号（每次部署手动递增，用于缓存清理）
  const APP_VERSION = '5';

  // ============ 工具 ============
  const $ = id => document.getElementById(id);
  const esc = s => String(s || '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const SAFE_REL = 'noopener noreferrer';

  function fmtRel(iso) {
    if (!iso) return '';
    try {
      const dt = new Date(iso);
      let diff = (Date.now() - dt.getTime()) / 1000;
      if (diff < 0) diff = 0;
      if (diff < 60) return '刚刚';
      if (diff < 3600) return Math.floor(diff / 60) + ' 分钟前';
      if (diff < 86400) return Math.floor(diff / 3600) + ' 小时前';
      return Math.floor(diff / 86400) + ' 天前';
    } catch { return ''; }
  }

  function fmtClock(d) {
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  // 分类配置
  const CATS = {
    international: { name: '国际局势', color: '#dc2626', icon: '🌐' },
    domestic:      { name: '国内要闻', color: '#059669', icon: '🇨🇳' },
    economy:       { name: '经济',     color: '#d97706', icon: '💰' },
    tech:          { name: '科技',     color: '#7c3aed', icon: '⚡' },
    society:       { name: '社会',     color: '#0891b2', icon: '👥' },
  };

  // ============ 初始化 ============
  function init() {
    applyTheme();
    bindEvents();
    startClock();
    startCountdown();
    loadData();
    loadHot();
  }

  function bindEvents() {
    // 三大版块切换
    $('sectionTabs').addEventListener('click', e => {
      const b = e.target.closest('.sec-tab');
      if (!b) return;
      switchSection(b.dataset.sec);
    });

    // 深度解读子 tab（国际/国内）
    $('digestTabs').addEventListener('click', e => {
      const b = e.target.closest('.sec-sub');
      if (!b) return;
      switchDigest(b.dataset.sec);
    });

    // 搜索
    const si = $('searchInput');
    si.addEventListener('input', e => {
      clearTimeout(state._searchTimer);
      state._searchTimer = setTimeout(() => {
        state.query = e.target.value.trim().toLowerCase();
        applyFilter();
      }, 300);
    });
    $('clearSearch').addEventListener('click', () => {
      si.value = ''; state.query = ''; applyFilter();
    });

    // 分类标签
    $('tabs').addEventListener('click', e => {
      const b = e.target.closest('.tab');
      if (!b) return;
      switchCat(b.dataset.cat);
    });

    // 无结果清除
    $('nrClear').addEventListener('click', clearAllFilters);

    // 按钮
    $('refreshBtn').addEventListener('click', () => { loadData(true); loadHot(); });
    $('hotRefreshBtn').addEventListener('click', () => loadHot(true));
    $('themeToggle').addEventListener('click', toggleTheme);
    $('helpBtn').addEventListener('click', openHelp);
    $('helpClose').addEventListener('click', closeHelp);
    $('helpOverlay').addEventListener('click', e => {
      if (e.target === $('helpOverlay')) closeHelp();
    });

    // 回顶 + 阅读进度条
    const backTop = $('backTop');
    const readProg = $('readProgress');
    const onScroll = () => {
      const sy = window.scrollY;
      backTop.classList.toggle('show', sy > 400);
      if (readProg) {
        const sh = document.documentElement.scrollHeight - window.innerHeight;
        const pct = sh > 0 ? Math.min(100, (sy / sh) * 100) : 0;
        readProg.style.width = pct + '%';
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    backTop.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));

    // 键盘
    document.addEventListener('keydown', onKeydown);
  }

  function onKeydown(e) {
    const tag = (e.target.tagName || '').toLowerCase();
    const inField = tag === 'input' || tag === 'textarea' || tag === 'select';
    if (e.key === 'Escape') {
      if (inField) e.target.blur();
      closeHelp();
      const si = $('searchInput');
      if (si && si.value) { si.value = ''; state.query = ''; applyFilter(); }
      return;
    }
    const helpOpen = $('helpOverlay') && $('helpOverlay').classList.contains('show');
    if (helpOpen) return;
    if (inField) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

const k = e.key.toLowerCase();
    switch (k) {
      case '1': switchSection('digest'); break;
      case '2': switchSection('hot'); break;
      case '3': switchSection('feed'); break;
      case 'i': if (state.activeSection === 'digest') switchDigest('int'); break;
      case 'd': if (state.activeSection === 'digest') switchDigest('dom'); break;
      case '/':
        e.preventDefault();
        $('searchInput')?.focus();
        break;
      case 'r': loadData(true); loadHot(); break;
      case 't': toggleTheme(); break;
      case 'j': e.preventDefault(); focusItem(1); break;
      case 'k': e.preventDefault(); focusItem(-1); break;
      case '?': openHelp(); break;
    }
  }

  // ============ 版块切换 ============
  function switchSection(sec) {
    if (!['digest', 'hot', 'feed'].includes(sec)) return;
    if (sec === state.activeSection) {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    state.activeSection = sec;
    state.activeCat = 'all';
    state.query = '';
    const si = $('searchInput');
    if (si) si.value = '';
    document.querySelectorAll('#sectionTabs .sec-tab').forEach(t =>
      t.classList.toggle('on', t.dataset.sec === sec));
    document.querySelectorAll('#tabs .tab').forEach(t =>
      t.classList.toggle('on', t.dataset.cat === 'all'));
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  function switchDigest(d) {
    if (!['int', 'dom'].includes(d)) return;
    state.activeDigest = d;
    document.querySelectorAll('#digestTabs .sec-sub').forEach(t =>
      t.classList.toggle('on', t.dataset.sec === d));
    renderDigest();
  }

  function switchCat(cat) {
    state.activeCat = cat;
    document.querySelectorAll('#tabs .tab').forEach(t =>
      t.classList.toggle('on', t.dataset.cat === cat));
    applyFilter();
  }

  function toggleTheme() {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('gh_theme', state.theme);
    applyTheme();
  }

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.theme);
    const t = $('themeToggle');
    if (t) t.textContent = state.theme === 'dark' ? '🌙' : '☀️';
  }

  // ============ 数据加载：深度解读 ============
  let _loadToken = 0;
  async function loadData(force = false) {
    const token = ++_loadToken;
    const status = $('status');
    status.textContent = '正在加载最新数据…';
    status.classList.add('busy');
    try {
      const url = force ? `${TOP_URL}?v=${Date.now()}` : `${TOP_URL}?v=${APP_VERSION}`;
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      state.top = await resp.json();
      if (token !== _loadToken) return;
      if (!state.top.sections) {
        state.top.sections = {
          international: { title: '国际热点', digest: state.top.digest || '', totalSelected: state.top.totalSelected || 0, items: state.top.items || [] },
          domestic: { title: '国内热点', digest: '', totalSelected: 0, items: [] },
        };
      }
      status.classList.remove('busy');
      render();
    } catch (e) {
      if (token !== _loadToken) return;
      console.error('加载失败', e);
      status.classList.remove('busy');
      status.textContent = '加载失败：' + e.message + '（数据每6小时更新一次，初次部署后请耐心等待）';
      $('cards').innerHTML = `<div class="error-placeholder">
        <div class="empty-ico">⚠</div>
        <div>暂无数据</div>
        <div class="err-detail">可能原因：1) 首次部署尚未运行 GitHub Actions；2) API key 未配置；3) 网络问题</div>
      </div>`;
    }
  }

  // ============ 数据加载：全量新闻流 ============
  async function loadRaw(force = false) {
    try {
      const url = force ? `${RAW_URL}?v=${Date.now()}` : `${RAW_URL}?v=${APP_VERSION}`;
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      state.raw = await resp.json();
      renderFeed();
    } catch (e) {
      console.warn('全量新闻加载失败', e);
      const fl = $('feedList');
      if (fl) fl.innerHTML = `<div class="feed-empty">全量新闻加载失败（${esc(e.message)}）</div>`;
    }
  }

  // ============ 渲染 ============
  function render() {
    // 顶部大 tab 计数
    const intlCnt = state.top?.sections?.international?.totalSelected ?? 0;
    const cnCnt = state.top?.sections?.domestic?.totalSelected ?? 0;
    const iEl = $('secCntIntl'); if (iEl) iEl.textContent = intlCnt;
    const cEl = $('secCntCn'); if (cEl) cEl.textContent = cnCnt;
    const dEl = $('secCntDigest'); if (dEl) dEl.textContent = intlCnt + cnCnt;
    const hEl = $('secCntHot'); if (hEl) hEl.textContent = state.hotLoaded ? '6' : '0';
    const fEl = $('secCntFeed'); if (fEl) fEl.textContent = state.raw?.items?.length ?? 0;

    // 版块显隐（注意：HTML 中 section 带 hidden 属性，需同步 hidden 与 style.display）
    const isDigest = state.activeSection === 'digest';
    const isHot = state.activeSection === 'hot';
    const isFeed = state.activeSection === 'feed';
    $('digestTabs').style.display = isDigest ? '' : 'none';
    $('digestTabs').hidden = !isDigest;
    $('digestSection').style.display = isDigest ? '' : 'none';
    $('digestSection').hidden = !isDigest;
    $('tabs').style.display = isDigest ? '' : 'none';
    $('tabs').hidden = !isDigest;
    $('cards').style.display = isDigest ? '' : 'none';
    $('cards').hidden = !isDigest;
    $('hotSection').style.display = isHot ? '' : 'none';
    $('hotSection').hidden = !isHot;
    $('feedSection').style.display = isFeed ? '' : 'none';
    $('feedSection').hidden = !isFeed;
    const nr = $('noResults');
    if (nr) nr.style.display = 'none';

    if (isDigest) renderDigest();
    if (isFeed && !state.feedRendered) { loadRaw(); state.feedRendered = true; }
  }

  function renderDigest() {
    if (!state.top) return;
    const sec = state.activeDigest === 'dom' ? state.top.sections.domestic : state.top.sections.international;

    // 局势综述
    const digestTitle = $('digestTitle');
    if (sec && sec.digest) {
      $('digestSection').hidden = false;
      $('digestBody').textContent = sec.digest;
      $('digestTime').textContent = '生成于 ' + fmtRel(state.top.generatedAt);
      if (digestTitle) {
        digestTitle.textContent = state.activeDigest === 'dom' ? '今日国内形势综述' : '今日国际局势综述';
      }
    } else {
      $('digestSection').hidden = true;
    }

    // 卡片
    const grid = $('cards');
    const items = sec?.items || [];
    if (items.length === 0) {
      grid.innerHTML = `<div class="error-placeholder">
        <div class="empty-ico">⏳</div>
        <div>该版块暂无解读数据</div>
        <div class="err-detail">
          网站首次部署后，GitHub Actions 会在数小时内生成 AI 深度解读数据。<br>
          请确认：<br>
          1) 仓库已配置 <code>ZHIPU_API_KEY</code> Secret<br>
          2) GitHub Actions 已启用<br>
          3) 手动触发过一次 workflow（Actions 页 → Run workflow）<br>
          配置完成后，数据每 6 小时自动更新。
        </div>
      </div>`;
    } else {
      grid.innerHTML = items.map((it, idx) => itemHTML(it, idx)).join('');
    }

    updateTabCounts(items);
    renderSourceStats(state.top.sourceStats);
    applyFilter();

    const status = $('status');
    const gen = fmtRel(state.top.generatedAt);
    const secName = state.activeDigest === 'dom' ? '国内' : '国际';
    status.textContent = `${secName}版块 · ${sec?.totalSelected || 0} 条 · 生成于 ${gen} · 模型 ${state.top.model || 'GLM-4-Flash'}`;
  }

  function itemHTML(it, idx) {
    const cat = CATS[it.category] || CATS.international;
    const sources = Array.isArray(it.sources) ? it.sources : [{ name: it.source || '', url: it.url || '' }];
    const sourceBadges = sources.map(s =>
      `<a class="src-badge" href="${esc(s.url)}" target="_blank" rel="${SAFE_REL}" title="查看原文">${esc(s.name)}</a>`
    ).join('');
    const rank = it.rank || 0;
    const rankCls = rank <= 3 ? `rank rank-top rank-${rank}` : 'rank';
    const keywords = (it.keywords || []).map(k => `<span class="kw">${esc(k)}</span>`).join('');
    const imp = it.importance || 0;
    const impCls = imp >= 85 ? 'imp-high' : (imp >= 70 ? 'imp-mid' : 'imp-low');
    const origTitle = it.titleOrig && it.titleOrig !== it.title
      ? `<div class="it-orig" lang="en">${esc(it.titleOrig)}</div>` : '';
    const time = it.publishedAt ? fmtRel(it.publishedAt) : '';

    return `
      <article class="news-card cat-${it.category || 'international'}" data-cat="${it.category || 'international'}" style="--cat-color:${cat.color};--i:${idx || 0}">
        <div class="card-rank ${rankCls}">${rank}</div>
        <div class="card-main">
          <div class="card-head">
            <span class="cat-tag" style="--cat-color:${cat.color}">${cat.icon} ${cat.name}</span>
            ${time ? `<span class="card-time">${time}</span>` : ''}
            ${it.region ? `<span class="card-region">📍 ${esc(it.region)}</span>` : ''}
            <span class="imp ${impCls}" title="重要度评分 ${imp}/100">
              <span class="imp-bar"><i style="width:${imp}%"></i></span>${imp}
            </span>
          </div>
          <h3 class="card-title">
            <a href="${esc(sources[0].url || it.url || '#')}" target="_blank" rel="${SAFE_REL}">${esc(it.title)}</a>
          </h3>
          ${origTitle}
          ${it.summary ? `<div class="card-summary">${esc(it.summary)}</div>` : ''}
          ${it.analysis ? `<div class="card-analysis">${esc(it.analysis)}</div>` : ''}
          ${keywords ? `<div class="card-kws">${keywords}</div>` : ''}
          <div class="card-foot">
            <span class="src-label">${sources.length>1 ? `信源 · ${sources.length}源印证` : '信源'}</span>
            ${sourceBadges}
          </div>
        </div>
      </article>`;
  }

  function updateTabCounts(items) {
    const counts = { all: items.length, international: 0, domestic: 0, economy: 0, tech: 0, society: 0 };
    items.forEach(it => {
      const c = it.category || 'international';
      if (counts[c] !== undefined) counts[c]++;
    });
    document.querySelectorAll('.tab-cnt').forEach(s => {
      const id = s.dataset.cnt;
      s.textContent = counts[id] || 0;
    });
  }

  // ============ 数据源健康度 ============
  function renderSourceStats(stats) {
    const box = $('sourceStats');
    if (!box) return;
    if (!Array.isArray(stats) || !stats.length) {
      box.innerHTML = '<span class="source-stats-title">信源</span><span class="ss-cnt">（未提供统计）</span>';
      return;
    }
    const okCnt = stats.filter(s => s.ok).length;
    const chips = stats.map(s => {
      const dotCls = s.ok ? '' : 'fail';
      return `<span class="ss-chip" title="${esc(s.name)}: ${s.ok ? s.count + ' 条' : '信源失败'}">
        <span class="ss-dot ${dotCls}"></span>${esc(s.name)}<span class="ss-cnt">${s.count}</span>
      </span>`;
    }).join('');
    box.innerHTML = `<span class="source-stats-title">信源 ${okCnt}/${stats.length} 在线</span>${chips}`;
  }

  // ============ 下次更新倒计时 ============
  function nextUpdateUTC() {
    const now = new Date();
    const next = new Date(now);
    const h = now.getUTCHours();
    const nextHour = Math.ceil((h + 0.001) / 6) * 6;
    if (nextHour >= 24) {
      next.setUTCDate(next.getUTCDate() + 1);
      next.setUTCHours(0, 0, 0, 0);
    } else {
      next.setUTCHours(nextHour, 0, 0, 0);
    }
    return next.getTime();
  }

  function startCountdown() {
    const num = $('nextUpdateNum');
    if (!num) return;
    const nextTs = nextUpdateUTC();
    const tick = () => {
      const diff = nextTs - Date.now();
      if (diff <= 0) { num.textContent = '即将'; return; }
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      num.textContent = `${h}h ${m}m`;
    };
    tick();
    setInterval(tick, 30000);
  }

  // ============ 过滤 ============
  function applyFilter() {
    requestAnimationFrame(() => {
      // 深度解读卡片过滤
      const cards = document.querySelectorAll('.news-card');
      let visibleTotal = 0;
      cards.forEach(card => {
        const cat = card.dataset.cat;
        const showCat = state.activeCat === 'all' || state.activeCat === cat;
        const txt = card.textContent.toLowerCase();
        const hitQuery = !state.query || txt.indexOf(state.query) >= 0;
        const show = showCat && hitQuery;
        card.style.display = show ? '' : 'none';
        if (show) visibleTotal++;
      });

      // 全部新闻流过滤
      const feedItems = document.querySelectorAll('.feed-item');
      feedItems.forEach(item => {
        const txt = item.textContent.toLowerCase();
        const hit = !state.query || txt.indexOf(state.query) >= 0;
        item.style.display = hit ? '' : 'none';
      });

      const nr = $('noResults');
      const hasFilter = state.query || state.activeCat !== 'all';
      if (hasFilter && visibleTotal === 0 && state.activeSection === 'digest') {
        nr.style.display = 'flex';
        const sub = $('nrSub');
        const parts = [];
        if (state.query) parts.push('关键词「' + state.query + '」');
        if (state.activeCat !== 'all') {
          const c = CATS[state.activeCat];
          if (c) parts.push('分类「' + c.name + '」');
        }
        sub.textContent = parts.length ? '当前筛选：' + parts.join(' · ') : '';
      } else {
        nr.style.display = 'none';
      }

      document.querySelectorAll('.news-card.focused').forEach(c => c.classList.remove('focused'));
      state.focusIdx = -1;
    });
  }

  function clearAllFilters() {
    const si = $('searchInput');
    if (si) si.value = '';
    state.query = '';
    state.activeCat = 'all';
    document.querySelectorAll('#tabs .tab').forEach(t =>
      t.classList.toggle('on', t.dataset.cat === 'all'));
    applyFilter();
  }

  // ============ j/k 焦点 ============
  function focusItem(dir) {
    let cards;
    if (state.activeSection === 'feed') {
      cards = [...document.querySelectorAll('.feed-item')].filter(c => c.offsetParent !== null);
    } else if (state.activeSection === 'hot') {
      cards = [...document.querySelectorAll('.hot-item')].filter(c => c.offsetParent !== null);
    } else {
      cards = [...document.querySelectorAll('.news-card')].filter(c => c.offsetParent !== null);
    }
    if (!cards.length) return;
    cards.forEach(c => c.classList.remove('focused'));
    state.focusIdx += dir;
    if (state.focusIdx < 0) state.focusIdx = cards.length - 1;
    if (state.focusIdx >= cards.length) state.focusIdx = 0;
    const card = cards[state.focusIdx];
    card.classList.add('focused');
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // ============ 实时热搜 ============
  async function loadHot(force = false) {
    const box = $('hotPlatforms');
    const status = $('hotStatus');
    if (!box) return;
    if (!force && state.hotLoaded) return;
    if (!box.children.length) {
      status.textContent = '正在连接热搜归档…';
      box.innerHTML = `<div class="sk-hot">${'<div class="sk-plat"></div>'.repeat(6)}</div>`;
    }
    const results = await Promise.allSettled(HOT_PLATFORMS.map(async p => {
      const resp = await fetch(`${p.url}?v=${Date.now()}`, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const md = await resp.text();
      const items = parseHotMd(md);
      return { plat: p, items };
    }));
    box.innerHTML = '';
    let anyOk = false;
    results.forEach(r => {
      if (r.status === 'fulfilled' && r.value.items.length) {
        anyOk = true;
        renderHotPlatform(r.value.plat, r.value.items);
      }
    });
    state.hotLoaded = true;
    if (!anyOk) {
      status.textContent = '热搜归档暂时无法连接（raw.githubusercontent.com 可能被拦截），请稍后重试或切换版块。';
    } else {
      status.textContent = '热搜数据来自 GitHub 公开归档（每小时更新）· 点击条目直达原平台';
    }
    render();
  }

  function parseHotMd(md) {
    const items = [];
    const lines = md.split(/\r?\n/);
    const re = /^\s*(?:\+|\*|-|\d+\.)\s*\[([^\]]+)\]\(([^)]+)\)/;
    for (const line of lines) {
      const m = line.match(re);
      if (m) {
        const title = m[1].trim();
        const url = m[2].trim();
        if (title && url) items.push({ title, url });
      }
      if (items.length >= 20) break;
    }
    return items;
  }

  function renderHotPlatform(plat, items) {
    const box = $('hotPlatforms');
    const list = items.map((it, i) => `
      <a class="hot-item" href="${esc(it.url)}" target="_blank" rel="${SAFE_REL}">
        <span class="rk">${i+1}</span>
        <span class="t">${esc(it.title)}</span>
        <span class="tag">${esc(plat.id)}</span>
      </a>`).join('');
    const card = document.createElement('div');
    card.className = 'hot-plat';
    card.style.setProperty('--plat-color', plat.color || 'var(--accent)');
    card.innerHTML = `
      <div class="hot-plat-head">
        <span class="hot-plat-ico">${plat.ico}</span>
        <span class="hot-plat-name">${esc(plat.name)}</span>
        <span class="hot-plat-cnt">TOP ${items.length}</span>
      </div>
      <div class="hot-plat-list">${list}</div>`;
    box.appendChild(card);
  }

  // ============ 全部新闻时间流 ============
  function renderFeed() {
    const fl = $('feedList');
    const cnt = $('feedCount');
    if (!fl || !state.raw) return;
    const items = (state.raw.items || []).slice().sort((a, b) =>
      new Date(b.publishedAt || 0) - new Date(a.publishedAt || 0));
    if (cnt) cnt.textContent = items.length + ' 条';
    if (!items.length) {
      fl.innerHTML = `<div class="feed-empty">全量新闻为空</div>`;
      return;
    }
    fl.innerHTML = items.map((it, idx) => {
      const cat = it.cat || 'intl';
      const catName = CATS[cat] ? CATS[cat].name : (cat === 'cn' ? '国内要闻' : '国际局势');
      return `<a class="feed-item" href="${esc(it.url)}" target="_blank" rel="${SAFE_REL}" style="--i:${Math.min(idx, 30)}">
        <span class="f-src">${esc(it.source)}</span>
        <span class="f-title" title="${esc(it.title)}">${esc(it.title)}</span>
        <span class="f-cat">${esc(catName)}</span>
        <span class="f-age">${fmtRel(it.publishedAt)}</span>
      </a>`;
    }).join('');
  }

  // ============ 帮助面板 ============
  function openHelp() {
    const ov = $('helpOverlay');
    ov.classList.add('show');
    ov.setAttribute('aria-hidden', 'false');
  }
  function closeHelp() {
    const ov = $('helpOverlay');
    ov.classList.remove('show');
    ov.setAttribute('aria-hidden', 'true');
  }

  // ============ 时钟 ============
  function startClock() {
    const tick = () => {
      const el = $('clock');
      if (el) el.textContent = fmtClock(new Date());
    };
    tick();
    setInterval(tick, 1000);
  }

  // 启动
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();