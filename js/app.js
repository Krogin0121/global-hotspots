/* ============================================================
 *  app.js — 全球热点深度解读 · 前端（双轨：国际 / 国内）
 *  读取 data/top20.json 的 sections.{international,domestic}
 *  顶部大 tab 切换版块；分类标签与搜索按当前版块作用
 * ============================================================ */

(() => {
  'use strict';

  const state = {
    data: null,
    activeSection: 'international',  // 'international' | 'domestic'
    activeCat: 'all',
    query: '',
    theme: localStorage.getItem('gh_theme') || 'dark',
    focusIdx: -1,
  };

  // 数据文件路径（GitHub Pages 部署后是相对路径）
  // 加 ?v= 时间戳避免 CDN 缓存（手动刷新时）
  const DATA_URL = 'data/top20.json';

  // ============ 工具 ============
  const $ = id => document.getElementById(id);
  const esc = s => String(s || '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function fmtRel(iso) {
    if (!iso) return '';
    try {
      const dt = new Date(iso);
      let diff = (Date.now() - dt.getTime()) / 1000;
      if (diff < 0) diff = 0;  // 服务器时钟偏差/未来时间统一为「刚刚」
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
    domestic:      { name: '国内要闻', color: '#dc2626', icon: '🇨🇳' },
    economy:       { name: '经济',     color: '#059669', icon: '💰' },
    tech:          { name: '科技',     color: '#7c3aed', icon: '⚡' },
    society:       { name: '社会',     color: '#0891b2', icon: '👥' },
  };

  // 当前激活版块的 section 数据
  function currentSection() {
    return (state.data?.sections?.[state.activeSection]) || null;
  }

  // ============ 初始化 ============
  function init() {
    applyTheme();
    bindEvents();
    startClock();
    startCountdown();
    loadData();
  }

  function bindEvents() {
    // Section 大 tab 切换（国际 / 国内）
    $('sectionTabs').addEventListener('click', e => {
      const b = e.target.closest('.sec-tab');
      if (!b) return;
      switchSection(b.dataset.sec);
    });

    // 搜索
    const si = $('searchInput');
    si.addEventListener('input', e => {
      state.query = e.target.value.trim().toLowerCase();
      applyFilter();
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
    $('refreshBtn').addEventListener('click', () => loadData(true));
    $('themeToggle').addEventListener('click', toggleTheme);
    $('helpBtn').addEventListener('click', openHelp);
    $('helpClose').addEventListener('click', closeHelp);
    $('helpOverlay').addEventListener('click', e => {
      if (e.target === $('helpOverlay')) closeHelp();
    });

    // 回顶 + 阅读进度条（共用一个 scroll 监听，passive 提升性能）
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
    backTop.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });

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
    // 帮助浮层打开时，除 Esc 外屏蔽所有快捷键
    const helpOpen = $('helpOverlay') && $('helpOverlay').classList.contains('show');
    if (helpOpen) return;
    if (inField) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    // Section 切换（Tab / I / D）
    if (e.key === 'Tab') {
      e.preventDefault();
      switchSection(state.activeSection === 'international' ? 'domestic' : 'international');
      return;
    }

    const k = e.key.toLowerCase();
    switch (k) {
      case 'i': switchSection('international'); break;
      case 'd': switchSection('domestic'); break;
      case '/':
        e.preventDefault();
        $('searchInput')?.focus();
        break;
      case '1': switchCat('all'); break;
      case '2': switchCat('international'); break;
      case '3': switchCat('domestic'); break;
      case '4': switchCat('economy'); break;
      case '5': switchCat('tech'); break;
      case 'r': loadData(true); break;
      case 't': toggleTheme(); break;
      case 'j': e.preventDefault(); focusItem(1); break;
      case 'k': e.preventDefault(); focusItem(-1); break;
      case '?': openHelp(); break;
    }
  }

  function switchSection(sec) {
    if (sec !== 'international' && sec !== 'domestic') return;
    if (sec === state.activeSection && state.data) {
      // 已激活，仅滚动到顶
      window.scrollTo({ top: 0, behavior: 'smooth' });
      return;
    }
    state.activeSection = sec;
    // 切 section 时重置子分类与搜索
    state.activeCat = 'all';
    state.query = '';
    const si = $('searchInput');
    if (si) si.value = '';
    // 高亮对应 section tab
    document.querySelectorAll('#sectionTabs .sec-tab').forEach(t =>
      t.classList.toggle('on', t.dataset.sec === sec));
    // 高亮"全部"小分类
    document.querySelectorAll('#tabs .tab').forEach(t =>
      t.classList.toggle('on', t.dataset.cat === 'all'));
    render();
    // 滚动到顶
    window.scrollTo({ top: 0, behavior: 'smooth' });
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

  // ============ 数据加载 ============
  async function loadData(force = false) {
    const status = $('status');
    status.textContent = '正在加载最新数据…';
    status.classList.add('busy');

    try {
      const url = force ? `${DATA_URL}?v=${Date.now()}` : DATA_URL;
      const resp = await fetch(url, { cache: 'no-store' });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      state.data = await resp.json();
      // 数据兼容性保护：若旧格式（无 sections），包装
      if (!state.data.sections) {
        state.data.sections = {
          international: {
            title: '国际热点', digest: state.data.digest || '',
            totalSelected: state.data.totalSelected || 0,
            items: state.data.items || [],
          },
          domestic: { title: '国内热点', digest: '', totalSelected: 0, items: [] },
        };
      }
      status.classList.remove('busy');
      render();
    } catch (e) {
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

  // ============ 渲染 ============
  function render() {
    if (!state.data) return;
    const sec = currentSection();

    // 顶部 section 数量徽章
    const intlCnt = state.data.sections?.international?.totalSelected ?? 0;
    const cnCnt = state.data.sections?.domestic?.totalSelected ?? 0;
    const iEl = $('secCntIntl'); if (iEl) iEl.textContent = intlCnt;
    const cEl = $('secCntCn'); if (cEl) cEl.textContent = cnCnt;

    // 局势综述（随 section 切换）
    const digestTitle = $('digestTitle');
    if (sec && sec.digest) {
      $('digestSection').hidden = false;
      $('digestBody').textContent = sec.digest;
      $('digestTime').textContent = '生成于 ' + fmtRel(state.data.generatedAt);
      if (digestTitle) {
        digestTitle.textContent = state.activeSection === 'international'
          ? '今日国际局势综述'
          : '今日国内形势综述';
      }
    } else {
      $('digestSection').hidden = true;
    }

    // 卡片
    const grid = $('cards');
    const items = sec?.items || [];
    if (items.length === 0) {
      // 数据尚未生成（等待首次 Actions 运行）
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

    // 分类角标计数
    updateTabCounts(items);
    // 数据源健康度（全站共用）
    renderSourceStats(state.data.sourceStats);
    applyFilter();

    // 状态条文案
    const status = $('status');
    const gen = fmtRel(state.data.generatedAt);
    const secName = state.activeSection === 'international' ? '国际' : '国内';
    status.textContent = `${secName}版块 · ${sec?.totalSelected || 0} 条 · 生成于 ${gen} · 模型 ${state.data.model || 'GLM-4-Flash'}`;
  }

  function itemHTML(it, idx) {
    const cat = CATS[it.category] || CATS.international;
    const sources = Array.isArray(it.sources) ? it.sources : [
      { name: it.source || '', url: it.url || '' }
    ];
    const sourceBadges = sources.map(s =>
      `<a class="src-badge" href="${esc(s.url)}" target="_blank" rel="noopener" title="查看原文">${esc(s.name)}</a>`
    ).join('');

    const rank = it.rank || 0;
    const rankCls = rank <= 3 ? `rank rank-top rank-${rank}` : 'rank';

    const keywords = (it.keywords || []).map(k =>
      `<span class="kw">${esc(k)}</span>`).join('');

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
            <a href="${esc(sources[0].url || it.url || '#')}" target="_blank" rel="noopener">${esc(it.title)}</a>
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
    // GitHub Actions cron: 0 0,6,12,18 * * *（UTC）
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
      if (diff <= 0) {
        num.textContent = '即将';
        return;
      }
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      num.textContent = `${h}h ${m}m`;
    };
    tick();
    setInterval(tick, 30000);  // 每 30 秒刷新足够
  }

  // ============ 过滤 ============
  function applyFilter() {
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

    // 无结果提示
    const nr = $('noResults');
    const hasFilter = state.query || state.activeCat !== 'all';
    if (hasFilter && visibleTotal === 0) {
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

    // 重置 j/k 焦点
    document.querySelectorAll('.news-card.focused').forEach(c => c.classList.remove('focused'));
    state.focusIdx = -1;
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
    const cards = [...document.querySelectorAll('.news-card')].filter(c => c.offsetParent !== null);
    if (!cards.length) return;
    cards.forEach(c => c.classList.remove('focused'));
    state.focusIdx += dir;
    if (state.focusIdx < 0) state.focusIdx = 0;
    if (state.focusIdx >= cards.length) state.focusIdx = cards.length - 1;
    const card = cards[state.focusIdx];
    card.classList.add('focused');
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
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
