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
    translateEnabled: localStorage.getItem('gh_tr') !== '0',     // 默认开
    credFilter: localStorage.getItem('gh_credfilter') === '1',   // 默认关
    fontScale: localStorage.getItem('gh_font') || 'md',          // sm/md/lg
    collapsed: new Set(JSON.parse(localStorage.getItem('gh_collapsed') || '[]')),  // 折叠的卡片 id
    hideRead: localStorage.getItem('gh_hideread') === '1',       // 隐藏已读
    readUrls: new Set(JSON.parse(localStorage.getItem('gh_read') || '[]')),        // 已读 url 集合
    data: new Map(),          // id -> { ok, items, ts, cached, error, loading }
    refreshing: false,
    autoTimer: null,
  };

  /* ---------------- 初始化 ---------------- */
  function init() {
    applyTheme();
    applyFontScale();
    bindHeader();
    bindTabs();
    buildShell();
    bindCardCollapse();
    bindReadMark();
    restoreCollapsed();
    applyFilter();
    refreshAll(true);            // 首次拉取
    startClock();
    syncAutoRefresh();
    bindBackTop();
    bindKeyboard();
    bindHelp();
    bindNoResults();
  }

  function bindNoResults() {
    document.getElementById('nrClear')?.addEventListener('click', clearAllFilters);
  }

  /* ---------------- 字体大小 ---------------- */
  function applyFontScale() {
    document.documentElement.setAttribute('data-font', state.fontScale);
  }
  function cycleFont(dir) {
    const order = ['sm', 'md', 'lg'];
    let i = order.indexOf(state.fontScale);
    i = Math.max(0, Math.min(order.length - 1, i + dir));
    state.fontScale = order[i];
    localStorage.setItem('gh_font', state.fontScale);
    applyFontScale();
  }

  /* ---------------- 快捷键 ---------------- */
  function bindKeyboard() {
    document.addEventListener('keydown', e => {
      // 输入框聚焦时仅处理 Esc
      const tag = (e.target.tagName || '').toLowerCase();
      const inField = tag === 'input' || tag === 'textarea' || tag === 'select';
      if (e.key === 'Escape') {
        if (inField) { e.target.blur(); }
        closeHelp();
        const si = document.getElementById('searchInput');
        if (si && si.value) { si.value = ''; state.query = ''; applyFilter(); }
        return;
      }
      if (inField) return;
      // 忽略带 Ctrl/Meta/Alt 的组合
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      switch (k) {
        case '/':
          e.preventDefault();
          document.getElementById('searchInput')?.focus();
          break;
        case '1': switchCat('all'); break;
        case '2': switchCat('intl'); break;
        case '3': switchCat('tech'); break;
        case '4': switchCat('cn'); break;
        case 'r':
          HotAPI.flushCache(); refreshAll(false); break;
        case 't':
          state.theme = state.theme === 'dark' ? 'light' : 'dark';
          localStorage.setItem('gh_theme', state.theme); applyTheme(); break;
        case 'f':
          toggleCollapseAll(); break;
        case 'g':
          window.scrollTo({ top: 0, behavior: 'smooth' }); break;
        case '?':
          openHelp(); break;
      }
    });
  }
  function switchCat(cat) {
    state.activeCat = cat;
    document.querySelectorAll('#tabs .tab').forEach(x => {
      x.classList.toggle('on', x.dataset.cat === cat);
    });
    applyFilter();
  }

  /* ---------------- 帮助浮层 ---------------- */
  function bindHelp() {
    const overlay = document.getElementById('helpOverlay');
    document.getElementById('helpBtn')?.addEventListener('click', openHelp);
    document.getElementById('helpClose')?.addEventListener('click', closeHelp);
    overlay?.addEventListener('click', e => { if (e.target === overlay) closeHelp(); });
  }
  function openHelp() {
    const ov = document.getElementById('helpOverlay');
    if (ov) { ov.classList.add('show'); ov.setAttribute('aria-hidden', 'false'); }
  }
  function closeHelp() {
    const ov = document.getElementById('helpOverlay');
    if (ov) { ov.classList.remove('show'); ov.setAttribute('aria-hidden', 'true'); }
  }

  /* ---------------- 卡片折叠 ---------------- */
  function bindCardCollapse() {
    const grid = document.getElementById('cards');
    grid.addEventListener('click', e => {
      // 排除刷新按钮点击
      if (e.target.closest('.card-refresh')) return;
      const head = e.target.closest('.card-head');
      if (!head) return;
      const card = head.closest('.card');
      if (!card) return;
      toggleCollapse(card.dataset.id);
    });
  }
  function toggleCollapse(id) {
    const card = document.querySelector(`#cards .card[data-id="${id}"]`);
    if (!card) return;
    const isCol = card.classList.toggle('collapsed');
    if (isCol) state.collapsed.add(id); else state.collapsed.delete(id);
    persistCollapsed();
  }
  function toggleCollapseAll() {
    const cards = document.querySelectorAll('#cards .card');
    const allCol = Array.from(cards).every(c => c.classList.contains('collapsed'));
    cards.forEach(c => {
      const id = c.dataset.id;
      if (allCol) { c.classList.remove('collapsed'); state.collapsed.delete(id); }
      else { c.classList.add('collapsed'); state.collapsed.add(id); }
    });
    persistCollapsed();
  }
  function persistCollapsed() {
    try { localStorage.setItem('gh_collapsed', JSON.stringify(Array.from(state.collapsed))); } catch {}
  }
  function restoreCollapsed() {
    document.querySelectorAll('#cards .card').forEach(c => {
      c.classList.toggle('collapsed', state.collapsed.has(c.dataset.id));
    });
  }

  /* ---------------- 阅读标记 ---------------- */
  function markRead(url) {
    if (!url) return;
    state.readUrls.add(url);
    // 限制集合大小 (保留最近 500 条)
    if (state.readUrls.size > 500) {
      const arr = Array.from(state.readUrls).slice(-500);
      state.readUrls = new Set(arr);
    }
    try { localStorage.setItem('gh_read', JSON.stringify(Array.from(state.readUrls))); } catch {}
  }
  function isRead(url) { return url ? state.readUrls.has(url) : false; }
  function bindReadMark() {
    const grid = document.getElementById('cards');
    grid.addEventListener('click', e => {
      const a = e.target.closest('.it-title');
      if (!a) return;
      const url = a.dataset.url || a.getAttribute('href');
      if (url) {
        markRead(url);
        const li = a.closest('.item');
        if (li) li.classList.add('is-read');
      }
    });
  }

  /* ---------------- 回到顶部 ---------------- */
  function bindBackTop() {
    const btn = document.getElementById('backTop');
    if (!btn) return;
    const onScroll = () => {
      btn.classList.toggle('show', window.scrollY > 480);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    btn.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
    onScroll();
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

    // 翻译开关
    const trToggle = $('translateToggle');
    if (trToggle) {
      trToggle.checked = state.translateEnabled;
      trToggle.addEventListener('change', e => {
        state.translateEnabled = e.target.checked;
        localStorage.setItem('gh_tr', state.translateEnabled ? '1' : '0');
        C.translate.enabled = state.translateEnabled;
        // 开启时: 对已有数据触发翻译; 关闭时: 仅重渲染
        if (state.translateEnabled) {
          state.data.forEach((d, id) => {
            if (d.ok && d.items && d.items.length) {
              const s = SOURCES.find(x => x.id === id);
              if (s && HotAPI.needTranslate(s)) {
                HotAPI.translateBatch(d.items).then(() => renderCard(s));
              }
            }
          });
        } else {
          SOURCES.forEach(s => renderCard(s));
        }
        applyFilter();
      });
    }

    // 仅高可信过滤开关
    const cfToggle = $('credFilterToggle');
    if (cfToggle) {
      cfToggle.checked = state.credFilter;
      cfToggle.addEventListener('change', e => {
        state.credFilter = e.target.checked;
        localStorage.setItem('gh_credfilter', state.credFilter ? '1' : '0');
        applyFilter();
        updateStats();
      });
    }

    // 字体大小
    $('fontDown')?.addEventListener('click', () => cycleFont(-1));
    $('fontUp')?.addEventListener('click', () => cycleFont(1));
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
    // 数据源类型标记: 实时RSS / 社区API / 每小时归档
    const typeMap = { rss: '实时', hn: '社区', gharchive: '时报', vvhan: '聚合' };
    const typeLabel = typeMap[s.kind] || '';
    const typeTitle = s.kind === 'gharchive' ? '数据由 GitHub Actions 每小时抓取归档' : (s.kind === 'hn' ? '官方 API 实时' : 'RSS 实时订阅');
    return `
      <section class="card" data-id="${s.id}" data-cat="${s.cat}" style="--accent:${s.color}">
        <header class="card-head" title="点击折叠/展开">
          <div class="card-ico" style="background:${s.color}">${s.icon}</div>
          <div class="card-tit">
            <div class="card-name">${s.name}${s.region ? `<span class="card-region">${s.region}</span>`:''}</div>
            <div class="card-sub">
              <span class="tag tag-${s.cat}">${catName}</span>
              <span class="src-type src-type-${s.kind}" title="${typeTitle}">${typeLabel}</span>
              <span class="card-ts" data-ts>—</span>
            </div>
          </div>
          <button class="card-refresh" title="刷新此源">↻</button>
          <span class="chevron" aria-hidden="true">▾</span>
        </header>
        <div class="card-body"><div class="loading">加载中…</div></div>
      </section>`;
  }

  /* ---------------- 过滤 (分类 + 搜索) ---------------- */
  function applyFilter() {
    const cards = document.querySelectorAll('#cards .card');
    let counts = {};
    let visibleCardsTotal = 0;
    cards.forEach(card => {
      const cat = card.dataset.cat;
      const showCat = state.activeCat === 'all' || state.activeCat === cat;
      // 搜索命中
      let visibleItems = 0;
      card.querySelectorAll('.item').forEach(it => {
        const txt = it.textContent.toLowerCase();
        const hitQuery = !state.query || txt.indexOf(state.query) >= 0;
        // 可信度过滤: 开启严格模式时仅 high 可见; 关闭时所有可见但 low dim
        const level = it.dataset.cred || 'mid';
        const hitCred = state.credFilter ? (level === 'high') : true;
        const hit = hitQuery && hitCred;
        it.style.display = hit ? '' : 'none';
        if (hit) visibleItems++;
      });
      const show = showCat && (visibleItems > 0 || !state.query);
      card.style.display = show ? '' : 'none';
      // 计数
      counts[cat] = (counts[cat] || 0) + (show ? 1 : 0);
      if (show) visibleCardsTotal++;
    });
    // 标签角标显示该分类卡片数
    document.querySelectorAll('.tab-cnt').forEach(s => {
      const id = s.dataset.cnt;
      s.textContent = id === 'all' ? SOURCES.length : (counts[id] || 0);
    });
    // 搜索关键词高亮
    highlightSearch();
    // 无结果提示: 所有卡片隐藏时显示
    updateNoResults(visibleCardsTotal);
  }

  function updateNoResults(visibleCards) {
    const el = document.getElementById('noResults');
    if (!el) return;
    const hasFilter = state.query || state.credFilter || state.activeCat !== 'all';
    if (hasFilter && visibleCards === 0) {
      el.style.display = 'flex';
      const sub = document.getElementById('nrSub');
      if (sub) {
        const parts = [];
        if (state.query) parts.push('关键词「' + state.query + '」');
        if (state.activeCat !== 'all') {
          const c = CATS.find(x => x.id === state.activeCat);
          if (c) parts.push('分类「' + c.name + '」');
        }
        if (state.credFilter) parts.push('仅高可信');
        sub.textContent = parts.length ? '当前筛选：' + parts.join(' · ') : '';
      }
    } else {
      el.style.display = 'none';
    }
  }

  function clearAllFilters() {
    const si = document.getElementById('searchInput');
    if (si) si.value = '';
    state.query = '';
    state.activeCat = 'all';
    state.credFilter = false;
    localStorage.setItem('gh_credfilter', '0');
    const cf = document.getElementById('credFilterToggle');
    if (cf) cf.checked = false;
    document.querySelectorAll('#tabs .tab').forEach(x => x.classList.toggle('on', x.dataset.cat === 'all'));
    applyFilter();
    updateStats();
  }

  /* ---------------- 搜索高亮 (文本节点级) ---------------- */
  function highlightSearch() {
    const q = state.query;
    document.querySelectorAll('#cards .item').forEach(item => {
      if (item.style.display === 'none') return;
      const title = item.querySelector('.it-title');
      if (!title) return;
      // 清除旧高亮
      title.querySelectorAll('mark').forEach(m => {
        const t = document.createTextNode(m.textContent);
        m.parentNode.replaceChild(t, m);
      });
      title.normalize();
      if (!q) return;
      // 高亮命中文本节点
      const walker = document.createTreeWalker(title, NodeFilter.SHOW_TEXT, null);
      const targets = [];
      let n; while (n = walker.nextNode()) targets.push(n);
      targets.forEach(node => {
        const lv = node.nodeValue.toLowerCase();
        let idx = lv.indexOf(q);
        while (idx >= 0) {
          const range = document.createRange();
          range.setStart(node, idx);
          range.setEnd(node, idx + q.length);
          const mark = document.createElement('mark');
          range.surroundContents(mark);
          // surroundContents 会把匹配部分移出 node, 剩余部分成为新文本节点
          // 重新从 node 继续找
          idx = node.nodeValue ? node.nodeValue.toLowerCase().indexOf(q) : -1;
        }
      });
    });
  }

  /* ---------------- 统计面板 ---------------- */
  function updateStats() {
    let total = 0, high = 0, mid = 0, low = 0, tr = 0, src = 0;
    state.data.forEach(d => {
      if (!d || !d.ok || !d.items) return;
      src++;
      d.items.forEach(it => {
        total++;
        if (it.credLevel === 'high') high++; else if (it.credLevel === 'mid') mid++; else low++;
        if (it.translated) tr++;
      });
    });
    const set = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
    set('statTotal', total);
    set('statHigh', high);
    set('statMid', mid);
    set('statLow', low);
    set('statTr', tr);
    set('statSrc', src);
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
      // 异步翻译英文源 (不阻塞, 译完重渲染)
      if (r.ok && r.items && r.items.length && state.translateEnabled && HotAPI.needTranslate(s)) {
        HotAPI.translateBatch(r.items).then(() => renderCard(s)).catch(() => {});
      }
      return r.ok;
    });
    const results = await Promise.all(tasks);
    const ok = results.filter(Boolean).length;

    state.refreshing = false;
    setStatus(`已更新 · ${ok}/${SOURCES.length} 个源在线 · ${fmtNow()}`, false);
    applyFilter();
    updateStats();
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
    if (r.ok && r.items && r.items.length && state.translateEnabled && HotAPI.needTranslate(s)) {
      HotAPI.translateBatch(r.items).then(() => renderCard(s)).catch(() => {});
    }
    applyFilter();
    updateStats();
  }

  function setLoading(id) {
    const card = document.querySelector(`#cards .card[data-id="${id}"]`);
    if (!card) return;
    card.querySelector('.card-body').innerHTML = skeletonHTML();
    card.querySelector('[data-ts]').textContent = '刷新中';
  }

  function skeletonHTML() {
    const rows = Array.from({ length: 5 }, () =>
      `<div class="skel-item"><div class="skel-rank"></div><div class="skel-line"></div></div>`
    ).join('');
    return `<div class="skeleton-list">${rows}</div>`;
  }

  function renderCard(s) {
    const card = document.querySelector(`#cards .card[data-id="${s.id}"]`);
    if (!card) return;
    const body = card.querySelector('.card-body');
    const tsEl = card.querySelector('[data-ts]');
    const d = state.data.get(s.id);
    if (!d) return;

    if (d.loading) { body.innerHTML = skeletonHTML(); tsEl.textContent = '刷新中'; return; }
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
    const meta = [it.time ? fmtRel(it.time) : '', it.meta].filter(Boolean).join(' · ');
    const discuss = it.discuss ? ` <a class="discuss" href="${it.discuss}" target="_blank" rel="noopener" title="参与讨论">💬</a>` : '';
    const href = it.url || s.site || '#';

    // 可信度徽章
    const credIcon = it.credLevel === 'high' ? '✔' : (it.credLevel === 'mid' ? '～' : '⚠');
    const cred = `<span class="cred cred-${it.credLevel}" title="可信度 ${it.cred}/100${it.credReason ? ' · '+it.credReason : ''}">${credIcon}</span>`;

    // 热度标签: 微博 #1 样式更醒目
    const hotCls = it.hotLabel && /^#[1-3]$/.test(it.hotLabel) ? 'hot hot-top' : 'hot';
    const hot = it.hotLabel ? `<span class="${hotCls}">${it.hotLabel}</span>` : '';

    // 双语标题: 翻译开启且已译 -> 主中文 + 副原文
    const needTr = state.translateEnabled && HotAPI.needTranslate(s);
    let titleHTML, subHTML = '';
    if (needTr && it.titleZh) {
      titleHTML = esc(it.titleZh);
      subHTML = `<div class="it-orig" lang="en">${esc(it.title)}</div>`;
    } else if (needTr && !it.translated) {
      // 翻译中, 标记
      titleHTML = esc(it.title) + ` <span class="tr-pending" title="翻译中">译…</span>`;
    } else {
      titleHTML = esc(it.title);
    }

    // 低可信标记行 (仅在非过滤模式且该条被识别为 spam 时显示原因提示)
    const spamNote = (it.credLevel === 'low' && it.credReason && !state.credFilter)
      ? `<span class="spam-note" title="${esc(it.credReason)}">疑似标题党</span>` : '';

    // 已读标记
    const readCls = isRead(href) ? ' is-read' : '';

    return `<li class="item cred-${it.credLevel}${readCls}" data-cred="${it.credLevel}">
      ${rank}${cred}${thumb}
      <div class="it-main">
        <a class="it-title" href="${href}" target="_blank" rel="noopener" data-url="${esc(href)}">${titleHTML}</a>
        ${subHTML}
        <div class="it-meta">${hot}${spamNote}${meta ? `<span class="meta">${meta}</span>`:''}${discuss}</div>
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
