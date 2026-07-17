/* ============================================================
 *  api.js  —  数据获取层
 *  ----------------------------------------------------------
 *  对外暴露:  HotAPI.load(source) -> Promise<{ok, items, error, ts}>
 *             HotAPI.flushCache()
 *  统一返回归一化条目结构:
 *    { title, url, hot, hotLabel, time(number|null), desc, thumb, by, meta }
 * ============================================================ */

const HotAPI = (() => {

  const C = window.CONFIG;

  /* ---------- 通用: 带超时的 fetch ---------- */
  async function fetchJSON(url, timeout = 20000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      // 若启用本地代理, 则把目标 url 走代理
      const target = wrapProxy(url);
      const res = await fetch(target, { signal: ctrl.signal, headers: { 'Accept': 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  async function fetchText(url, timeout = 20000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const target = wrapProxy(url);
      const res = await fetch(target, { signal: ctrl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.text();
    } finally {
      clearTimeout(t);
    }
  }

  function wrapProxy(url) {
    if (C.proxy && url.indexOf(C.proxy) !== 0 && !/^http:\/\/127\.0\.0\.1/.test(url)) {
      return C.proxy + encodeURIComponent(url);
    }
    return url;
  }

  /* ---------- 本地缓存 (localStorage) ---------- */
  function cacheGet(id) {
    try {
      const raw = localStorage.getItem('gh_cache_' + id);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (Date.now() - obj.ts > C.cacheTTL) return null;
      return obj;
    } catch { return null; }
  }
  function cacheSet(id, items) {
    try {
      localStorage.setItem('gh_cache_' + id, JSON.stringify({ ts: Date.now(), items }));
    } catch { /* quota 满则忽略 */ }
  }

  /* ---------- 归一化条目 ---------- */
  function norm(o) {
    return Object.assign({ title:'', url:'', hot:null, hotLabel:'', time:null, desc:'', thumb:'', by:'', meta:'' }, o);
  }

  /* ---------- RSS 适配器 (rss2json 主, allorigins 备) ---------- */
  async function fetchRSS(source) {
    const feedUrl = source.url;
    // 主: rss2json (返回结构化 JSON)
    try {
      const j = await fetchJSON(C.rss2json + encodeURIComponent(feedUrl));
      if (j && j.status === 'ok' && Array.isArray(j.items)) {
        const items = j.items.slice(0, C.itemsPerSource).map(it => norm({
          title: decode(it.title),
          url: it.link,
          time: parseDate(it.pubDate),
          desc: stripHtml(it.description || '').slice(0, 140),
          thumb: it.thumbnail || '',
          by: (j.feed && j.feed.title) || source.name,
          meta: it.author || source.region || '',
        }));
        return { ok: true, items };
      }
      throw new Error('rss2json status=' + (j && j.status));
    } catch (e1) {
      // 备: allorigins 取原始 XML, 客户端解析
      try {
        const xml = await fetchText(C.allorigins + encodeURIComponent(feedUrl));
        const doc = new DOMParser().parseFromString(xml, 'text/xml');
        const nodes = Array.from(doc.querySelectorAll('item, entry')).slice(0, C.itemsPerSource);
        if (!nodes.length) throw new Error('空 feed');
        const items = nodes.map(n => norm({
          title: decode(text(n, 'title')),
          url: text(n, 'link') || attr(n.querySelector('link'), 'href') || '',
          time: parseDate(text(n, 'pubDate') || text(n, 'published') || text(n, 'updated')),
          desc: stripHtml(text(n, 'description') || text(n, 'summary') || '').slice(0, 140),
          thumb: '',
          by: source.name,
          meta: source.region || '',
        }));
        return { ok: true, items };
      } catch (e2) {
        return { ok: false, error: 'RSS 不可达: ' + (e1.message) };
      }
    }
  }

  /* ---------- Hacker News 适配器 (Firebase, 已确认 CORS 开放) ---------- */
  async function fetchHN(source) {
    const ids = await fetchJSON(C.hnTopStories);
    if (!Array.isArray(ids)) throw new Error('HN topstories 非数组');
    const top = ids.slice(0, C.hnCount);
    const items = await Promise.all(top.map(id =>
      fetchJSON(C.hnItem + id + '.json', 15000).catch(() => null)
    ));
    const result = items
      .filter(Boolean)
      .sort((a, b) => (b.score || 0) - (a.score || 0))
      .slice(0, C.itemsPerSource)
      .map(it => norm({
        title: decode(it.title || '(无标题)'),
        url: it.url || (C.hnItem.replace('/item/', '') + ''), // 占位, 后面替换
        _id: it.id,
        hot: it.score || 0,
        hotLabel: (it.score || 0) + ' 分',
        time: it.time ? it.time * 1000 : null,
        desc: it.type === 'story' ? '' : stripHtml(it.text || ''),
        by: it.by || '',
        meta: (it.descendants || 0) + ' 评论',
      }))
      // HN 内部讨论链接修正
      .map(it => {
        it.url = it.url || ('https://news.ycombinator.com/item?id=' + it._id);
        it.discuss = 'https://news.ycombinator.com/item?id=' + it._id;
        return it;
      });
    return { ok: true, items: result };
  }

  /* ---------- 韩小韩聚合适配器 (尽力而为) ---------- */
  async function fetchVvhan(source) {
    const j = await fetchJSON(C.vvhan + source.vvhan, 15000);
    // 兼容多种返回结构
    const arr = (j && Array.isArray(j.data)) ? j.data
              : (j && Array.isArray(j)) ? j
              : (j && j.data && Array.isArray(j.data.list)) ? j.data.list
              : null;
    if (!arr) throw new Error('vvhan 返回为空或结构变化');
    const items = arr.slice(0, C.itemsPerSource).map((it, i) => norm({
      title: decode(it.title || it.name || it.word || ''),
      url: it.url || it.mobil_url || it.link || '',
      hot: numOrNull(it.hot || it.hotValue || ''),
      hotLabel: hotText(it.hot || it.hotValue || ''),
      time: parseDate(it.time || it.createTime) || null,
      by: source.name,
      meta: source.region || '',
    })).filter(it => it.title);
    return { ok: true, items };
  }

  /* ---------- 统一入口 ---------- */
  async function load(source) {
    // 1. 命中缓存直接返回 (带 ts 以便 UI 显示"缓存于")
    const cached = cacheGet(source.id);
    if (cached) return { ok: true, items: cached.items, ts: cached.ts, cached: true };

    // 2. 在线拉取
    let res;
    try {
      switch (source.kind) {
        case 'rss':   res = await fetchRSS(source); break;
        case 'hn':    res = await fetchHN(source);  break;
        case 'vvhan': res = await fetchVvhan(source); break;
        default:      res = { ok: false, error: '未知 kind: ' + source.kind };
      }
    } catch (e) {
      res = { ok: false, error: e.message || String(e) };
    }
    if (res.ok && res.items && res.items.length) {
      res.ts = Date.now();
      cacheSet(source.id, res.items);
    }
    return res;
  }

  function flushCache() {
    try {
      const keys = Object.keys(localStorage).filter(k => k.indexOf('gh_cache_') === 0);
      keys.forEach(k => localStorage.removeItem(k));
    } catch {}
  }

  /* ---------- 小工具 ---------- */
  function text(node, sel) {
    const el = node.querySelector(sel);
    return el ? el.textContent.trim() : '';
  }
  function attr(el, name) { return el ? el.getAttribute(name) || '' : ''; }
  function decode(s) {
    if (!s) return '';
    const t = document.createElement('textarea');
    t.innerHTML = s;
    return t.value;
  }
  function stripHtml(s) {
    if (!s) return '';
    return s.replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim();
  }
  function parseDate(s) {
    if (!s) return null;
    const t = Date.parse(s);
    return isNaN(t) ? null : t;
  }
  function numOrNull(s) {
    if (s == null || s === '') return null;
    const n = parseFloat(String(s).replace(/[^\d.]/g, ''));
    return isNaN(n) ? null : n;
  }
  function hotText(s) {
    if (s == null || s === '') return '';
    return String(s).replace(/\s+/g, '');
  }

  return { load, flushCache, fetchJSON };
})();
