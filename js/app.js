/* ============================================================
 *  app.js  —  全球实时热点事件 · 应用层 (渲染/交互/刷新/主题)
 * ============================================================ */

const App = (() => {

  const C = window.CONFIG;
  const SOURCES = window.SOURCES;
  const CATS = window.CATEGORIES;

  const state = {
    activeCat: 'all',
    query: '',
    theme: localStorage.getItem('gh_theme') || 'dark',
    autoRefresh: localStorage.getItem('gh_auto') === '1',
    intervalMs: parseInt(localStorage.getItem('gh_interval'), 10) || C.refreshInterval,
    data: new Map(),          // id -> { ok, items, ts, cached, error, loading }
    refreshing: false,
    autoTimer: null,
  };

  /* ---------------- 初始化 ---------------- */
  function init() {
    applyTheme();
    bindHeader();
    bindTabs();
    buildShell();
    applyFilter();
    refreshAll(true);            // 首次拉取
    startClock();
    syncAutoRefresh();
  }

  /* ---------------- 顶部控制区 ---------------- */
  function bindHeader() {
    const $ = id => document.getElementById(id);

    // 主题切换
    $('themeToggle').addEventListener('click', () => {
      state.theme = state.theme === 'dark' ? 'light' : 'dark';
      localStorage.setItem('gh_theme', state.theme);
      applyTheme();
    });

    // 手动刷新
    $('refreshBtn').addEventListener('click', () => {
      HotAPI.flushCache();
      refreshAll(false);
    });

    // 自动刷新开关
    $('autoToggle').addEventListener('change', e => {
      state.autoRefresh = e.target.checked;
      localStorage.setItem('gh_auto', state.autoRefresh ? '1' : '0');
      syncAutoRefresh();
    });

    // 刷新间隔
    $('intervalSel').addEventListener('change', e => {
      state.intervalMs = parseInt(e.target.value, 10);
      localStorage.setItem('gh_interval', state.intervalMs);
      syncAutoRefresh();
    });

    // 搜索
    let st;
    $('searchInput').addEventListener('input', e => {
      clearTimeout(st);
      st = setTimeout(() => { state.query = e.target.value.trim().toLowerCase(); applyFilter(); }, 180);
    });
    $('clearSearch').addEventListener('click', () => {
      $('searchInput').value = '';
      state.query = '';
      applyFilter();
    });
  }

  function applyTheme() {
    document.documentElement.setAttribute('data-theme', state.theme);
    const t = document.getElementById('themeToggle');
    if (t) t.textContent = state.theme === 'dark' ? '🌙' : '☀️';
  }

  /* ---------------- 分类标签 ---------------- */
  function bindTabs() {
    const wrap = document.getElementById('tabs');
    wrap.innerHTML = CATS.map(c =>
      `<button class="tab ${c.id==='all'?'on':''}" data-cat="${c.id}">${c.name}<span class="tab-cnt" data-cnt="${c.id}"></span></button>`
    ).join('');
    wrap.addEventListener('click', e => {
      const b = e.target.closest('.tab');
      if (!b) return;
      state.activeCat = b.dataset.cat;
      wrap.querySelectorAll('.tab').forEach(x => x.classList.toggle('on', x === b));
      applyFilter();
    });
  }

  /* ---------------- 构建卡片骨架 (一次) ---------------- */
  function buildShell() {
    const grid = document.getElementById('cards');
    grid.innerHTML = SOURCES.map(cardHTML).join('');
    // 绑定单卡刷新
    grid.querySelectorAll('.card-refresh').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const id = btn.closest('.card').dataset.id;
        flushOne(id);
      });
    });
  }

  function cardHTML(s) {
    const catName = (CATS.find(c => c.id === s.cat) || {}).name || '';
    return `
      <section class="card" data-id="${s.id}" data-cat="${s.cat}" style="--accent:${s.color}">
        <header class="card-head">
          <div class="card-ico" style="background:${s.color}">${s.icon}</div>
          <div class="card-tit">
            <div class="card-name">${s.name}${s.region ? `<span class="card-region">${s.region}</span>`:''}</div>
            <div class="card-sub">
              <span class="tag tag-${s.cat}">${catName}</span>
              <span class="card-ts" data-ts>—</span>
            </div>
          </div>
          <button class="card-refresh" title="刷新此源">↻</button>
        </header>
        <div class="card-body"><div class="loading">加载中…</div></div>
      </section>`;
  }

  /* ---------------- 过滤 (分类 + 搜索) ---------------- */
  function applyFilter() {
    const cards = document.querySelectorAll('#cards .card');
    let counts = {};
    cards.forEach(card => {
      const cat = card.dataset.cat;
      const showCat = state.activeCat === 'all' || state.activeCat === cat;
      // 搜索命中
      let visibleItems = 0;
      card.querySelectorAll('.item').forEach(it => {
        const txt = it.textContent.toLowerCase();
        const hit = !state.query || txt.indexOf(state.query) >= 0;
        it.style.display = hit ? '' : 'none';
        if (hit) visibleItems++;
      });
      const show = showCat && (visibleItems > 0 || !state.query);
      card.style.display = show ? '' : 'none';
      // 计数
      counts[cat] = (counts[cat] || 0) + (show ? 1 : 0);
    });
    // 标签角标显示该分类卡片数
    document.querySelectorAll('.tab-cnt').forEach(s => {
      const id = s.dataset.cnt;
      s.textContent = id === 'all' ? SOURCES.length : (counts[id] || 0);
    });
  }

  /* ---------------- 拉取与渲染 ---------------- */
  async function refreshAll(initial) {
    state.refreshing = true;
    setStatus('正在更新…', true);
    // 所有卡片切到 loading (仅首次或手动全量时显示骨架; 这里统一显示)
    if (initial) SOURCES.forEach(s => setLoading(s.id));

    const tasks = SOURCES.map(async s => {
      const r = await HotAPI.load(s);
      state.data.set(s.id, { ...r, loading: false });
      renderCard(s);
      return r.ok;
    });
    const results = await Promise.all(tasks);
    const ok = results.filter(Boolean).length;

    state.refreshing = false;
    setStatus(`已更新 · ${ok}/${SOURCES.length} 个源在线 · ${fmtNow()}`, false);
    applyFilter();
  }

  async function flushOne(id) {
    const s = SOURCES.find(x => x.id === id);
    if (!s) return;
    try { localStorage.removeItem('gh_cache_' + id); } catch {}
    state.data.set(id, { ok: true, items: [], loading: true });
    setLoading(id);
    const r = await HotAPI.load(s);
    state.data.set(id, { ...r, loading: false });
    renderCard(s);
    applyFilter();
  }

  function setLoading(id) {
    const card = document.querySelector(`#cards .card[data-id="${id}"]`);
    if (!card) return;
    card.querySelector('.card-body').innerHTML = '<div class="loading">加载中…</div>';
    card.querySelector('[data-ts]').textContent = '刷新中';
  }

  function renderCard(s) {
    const card = document.querySelector(`#cards .card[data-id="${s.id}"]`);
    if (!card) return;
    const body = card.querySelector('.card-body');
    const tsEl = card.querySelector('[data-ts]');
    const d = state.data.get(s.id);
    if (!d) return;

    if (d.loading) { body.innerHTML = '<div class="loading">加载中…</div>'; tsEl.textContent = '刷新中'; return; }
    if (!d.ok) {
      body.innerHTML = emptyState(s, d.error || '暂时无法获取');
      tsEl.textContent = '不可用';
      return;
    }
    if (!d.items || !d.items.length) {
      body.innerHTML = emptyState(s, '暂无内容');
      tsEl.textContent = '空';
      return;
    }
    body.innerHTML = '<ul class="items">' + d.items.map((it, i) => itemHTML(it, i, s)).join('') + '</ul>';
    tsEl.textContent = '更新于 ' + (d.cached ? '缓存 ' : '') + fmtRel(d.ts);
  }

  function itemHTML(it, i, s) {
    const rank = `<span class="rank${i<3?' r'+(i+1):''}">${i+1}</span>`;
    const thumb = it.thumb ? `<img class="thumb" src="${it.thumb}" alt="" loading="lazy" onerror="this.remove()">` : '';
    const hot = it.hotLabel ? `<span class="hot">${it.hotLabel}</span>` : '';
    const meta = [it.time ? fmtRel(it.time) : '', it.meta].filter(Boolean).join(' · ');
    const discuss = it.discuss ? ` <a class="discuss" href="${it.discuss}" target="_blank" rel="noopener" title="参与讨论">💬</a>` : '';
    const href = it.url || s.site || '#';
    return `<li class="item">
      ${rank}${thumb}
      <div class="it-main">
        <a class="it-title" href="${href}" target="_blank" rel="noopener">${esc(it.title)}</a>
        <div class="it-meta">${hot}${meta ? `<span class="meta">${meta}</span>`:''}${discuss}</div>
        ${it.desc ? `<div class="it-desc">${esc(it.desc)}</div>` : ''}
      </div>
    </li>`;
  }

  function emptyState(s, msg) {
    const site = s.site ? `<a class="goto" href="${s.site}" target="_blank" rel="noopener">直达 ${s.name} ↗</a>` : '';
    return `<div class="empty"><div class="empty-ico">⊘</div><div>${esc(msg)}</div>${site}</div>`;
  }

  /* ---------------- 状态栏 / 时钟 / 自动刷新 ---------------- */
  function setStatus(text, busy) {
    const el = document.getElementById('status');
    el.textContent = text;
    el.classList.toggle('busy', !!busy);
  }

  function startClock() {
    const el = document.getElementById('clock');
    const tick = () => { el.textContent = fmtNow(); };
    tick();
    setInterval(tick, 1000);
  }

  function syncAutoRefresh() {
    document.getElementById('autoToggle').checked = state.autoRefresh;
    document.getElementById('intervalSel').value = state.intervalMs;
    if (state.autoTimer) { clearInterval(state.autoTimer); state.autoTimer = null; }
    if (state.autoRefresh) {
      state.autoTimer = setInterval(() => refreshAll(false), state.intervalMs);
    }
  }

  /* ---------------- 格式化 ---------------- */
  function fmtNow() {
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }
  function fmtRel(ts) {
    if (!ts) return '';
    const diff = Date.now() - ts;
    if (diff < 0) return '刚刚';
    const m = Math.floor(diff / 60000);
    if (m < 1) return '刚刚';
    if (m < 60) return m + ' 分钟前';
    const h = Math.floor(m / 60);
    if (h < 24) return h + ' 小时前';
    const day = Math.floor(h / 24);
    if (day < 7) return day + ' 天前';
    const d = new Date(ts);
    const p = n => String(n).padStart(2, '0');
    return `${p(d.getMonth()+1)}-${p(d.getDate())}`;
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;');
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', App.init);
