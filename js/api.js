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
    return Object.assign({ title:'', url:'', hot:null, hotLabel:'', time:null, desc:'', thumb:'', by:'', meta:'', titleZh:'', cred:0, credLevel:'low', credReason:'', translated:false, spam:false }, o);
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
        url: it.url || '',                  // 无 url 的帖子(Ask/Tell HN)留空, 后面补 HN 讨论链接
        _id: it.id,
        hot: it.score || 0,
        hotLabel: (it.score || 0) + ' 分',
        time: it.time ? it.time * 1000 : null,
        desc: it.text ? decode(stripHtml(it.text)).slice(0, 140) : '',   // Ask HN/Show HN 也是 story 类型但有 text, stripHtml 后 decode 实体
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

  /* ---------- GitHub 归档适配器 (国内 6 平台热搜, raw MD 文件) ----------
   *  来源: iiecho1/hot_searches_for_apps (GitHub Actions 每小时抓取归档)
   *  格式:
   *    ## 平台
   *    ### 2026-07-18
   *    + [标题](链接)
   *  解析: 正则匹配 "+ [标题](链接)", 顺序即排名
   *  增强: 微博 URL 含 band_rank 参数, 提取为热度
   */
  async function fetchGhArchive(source) {
    const platform = source.ghArchive;
    const url = C.ghArchive.base + '/' + platform + '/' + platform + '.md';
    const md = await fetchText(url, 22000);
    if (!md || !md.trim()) throw new Error('归档文件为空');

    // 提取归档日期 (### 2026-07-18) 作为 time (当天 0 点)
    let archiveTime = null;
    const dateM = md.match(/^###\s*(\d{4}-\d{2}-\d{2})\s*$/m);
    if (dateM) {
      const t = Date.parse(dateM[1] + 'T00:00:00+08:00');  // 国内平台用东八区
      if (!isNaN(t)) archiveTime = t;
    }

    // 解析条目: + [标题](链接)
    const items = [];
    const re = /\+\s*\[([^\]]+)\]\((https?:[^)]+)\)/g;
    let m;
    while ((m = re.exec(md)) !== null && items.length < C.itemsPerSource) {
      const title = decode(m[1]);
      let link = m[2];
      if (!title) continue;

      // 微博热度: 从 URL 提取 band_rank 参数
      let hot = null, hotLabel = '';
      const rankM = link.match(/band_rank=(\d+)/);
      if (rankM) {
        const rank = parseInt(rankM[1], 10);
        hot = Math.max(0, 100 - rank);  // 排名越高数值越大 (1->99, 2->98)
        hotLabel = '#' + rank;
      }

      items.push(norm({
        title: title,
        url: link,
        hot: hot,
        hotLabel: hotLabel,
        time: archiveTime,
        by: source.name,
        meta: source.region,
      }));
    }

    if (!items.length) throw new Error('归档解析为空 (无 + [标题](链接) 条目)');
    return { ok: true, items };
  }


  async function load(source) {
    // 1. 命中缓存直接返回 (带 ts 以便 UI 显示"缓存于")
    const cached = cacheGet(source.id);
    if (cached) return { ok: true, items: cached.items, ts: cached.ts, cached: true, latency: 0 };

    // 2. 在线拉取 (计时)
    const t0 = performance.now();
    let res;
    try {
      switch (source.kind) {
        case 'rss':       res = await fetchRSS(source);       break;
        case 'hn':        res = await fetchHN(source);        break;
        case 'vvhan':     res = await fetchVvhan(source);     break;
        case 'gharchive': res = await fetchGhArchive(source); break;
        default:          res = { ok: false, error: '未知 kind: ' + source.kind };
      }
    } catch (e) {
      res = { ok: false, error: e.message || String(e) };
    }
    const latency = Math.round(performance.now() - t0);
    if (res.ok) res.latency = latency;
    if (res.ok && res.items && res.items.length) {
      res.ts = Date.now();
      // 同步计算可信度评分 (不阻塞, 纯本地计算)
      const s = (window.SOURCES || []).find(x => x.id === source.id) || source;
      res.items.forEach(it => scoreCredibility(it, s));
      cacheSet(source.id, res.items);
    }
    return res;
  }

  function flushCache() {
    try {
      const keys = Object.keys(localStorage).filter(k => k.indexOf('gh_cache_') === 0);
      keys.forEach(k => localStorage.removeItem(k));
      // 同时清理翻译缓存, 让下次翻译重新拉取
      const tkeys = Object.keys(localStorage).filter(k => k.indexOf('gh_tr_') === 0);
      tkeys.forEach(k => localStorage.removeItem(k));
    } catch {}
  }

  /* ============================================================
   *  翻译层 (MyMemory API, 无需 key, CORS 开放)
   *  - localStorage 缓存原文hash -> 译文, 减少重复请求
   *  - 并发限流器 pLimit(N), 避免瞬时洪峰触发限流
   *  - 单飞去重: 同一原文同时只发一个请求
   *  - 翻译失败/超时 -> 返回空串, UI 保留原文 + "译" 标记
   * ============================================================ */

  // 简易字符串 hash (FNV-1a 32bit), 用作缓存 key
  function fnvHash(s) {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(36);
  }

  // 并发限流器: 最多 concurrency 个 promise 同时执行
  function pLimit(concurrency) {
    let active = 0;
    const queue = [];
    const next = () => {
      if (active >= concurrency || queue.length === 0) return;
      active++;
      const { fn, resolve, reject } = queue.shift();
      Promise.resolve().then(fn).then(v => { active--; resolve(v); next(); }, e => { active--; reject(e); next(); });
    };
    return fn => new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); next(); });
  }

  const _trLimit = pLimit(C.translate.concurrency);
  const _trInflight = new Map();   // 原文hash -> Promise, 单飞去重

  function trCacheGet(key) {
    try {
      const raw = localStorage.getItem('gh_tr_' + key);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (Date.now() - obj.ts > C.translate.cacheTTL) return null;
      return obj.z;
    } catch { return null; }
  }
  function trCacheSet(key, z) {
    try {
      localStorage.setItem('gh_tr_' + key, JSON.stringify({ ts: Date.now(), z }));
    } catch { /* quota 满 */ }
  }

  async function translateOne(text) {
    if (!text || !text.trim()) return '';
    // 中文/非拉丁字符占比 > 50% 视为已是中文, 跳过翻译
    const chars = text.replace(/\s/g, '');
    if (chars.length) {
      const cjk = (text.match(/[\u4e00-\u9fff\u3000-\u30ff]/g) || []).length;
      if (cjk / chars.length > 0.4) return '';  // 已是中文, 无需翻译
    }
    const key = fnvHash(text);
    // 1. 缓存
    const cached = trCacheGet(key);
    if (cached !== null) return cached;
    // 2. 单飞去重
    if (_trInflight.has(key)) return _trInflight.get(key);
    // 3. 限流 + 请求
    const p = _trLimit(() => doTranslateOnce(text, key));
    _trInflight.set(key, p);
    try {
      const z = await p;
      return z;
    } finally {
      _trInflight.delete(key);
    }
  }

  async function doTranslateOnce(text, key) {
    const T = C.translate;
    const q = text.length > T.maxChars ? text.slice(0, T.maxChars) : text;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), T.timeout);
    try {
      const url = `${T.endpoint}?q=${encodeURIComponent(q)}&langpair=${encodeURIComponent(T.langpair)}&de=${encodeURIComponent(T.de)}`;
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'Accept': 'application/json' } });
      if (!res.ok) return '';
      const j = await res.json();
      const z = (j && j.responseData && j.responseData.translatedText) || '';
      // MyMemory 偶尔返回 "PLEASE SELECT TWO DISTINCT LANGUAGES" / "INVALID" 等错误文本
      if (/PLEASE SELECT|INVALID|MY MEMORY WARNING|QUOTA/i.test(z)) return '';
      // MyMemory 对中文输入有时回传原文, 检测一下
      const cleaned = String(z).trim();
      if (cleaned && cleaned !== q) {
        trCacheSet(key, cleaned);
        return cleaned;
      }
      return '';
    } catch {
      return '';
    } finally {
      clearTimeout(timer);
    }
  }

  // 批量翻译某源标题, 不阻塞 load; 返回 items (原地更新 titleZh/translated)
  async function translateBatch(items) {
    if (!C.translate.enabled) return items;
    if (!items || !items.length) return items;
    const tasks = items.map(async it => {
      const z = await translateOne(it.title);
      if (z) { it.titleZh = z; it.translated = true; }
    });
    await Promise.all(tasks);
    return items;
  }

  /* ============================================================
   *  可信度评分 & 虚假信息过滤
   *  - 基础分: 按 CREDIBILITY_TIER 取源等级
   *  - 扣分: 全大写比例高 / 连续叹号 / SPAM_KEYWORDS / SPAM_DOMAINS
   *  - 等级: >=85 high(绿) / 60-84 mid(橙) / <60 low(红, 折叠)
   * ============================================================ */

  function scoreCredibility(item, source) {
    const tier = window.CREDIBILITY_TIER;
    const spamKW = window.SPAM_KEYWORDS;
    const spamDM = window.SPAM_DOMAINS;
    let score = tier[source.id] != null ? tier[source.id] : 50;
    const reasons = [];
    const title = (item.title || '').trim();
    const lower = title.toLowerCase();

    // 1. URL 域名黑名单 (最严重, 直接降为 30)
    let urlHit = false;
    if (item.url) {
      try {
        const host = new URL(item.url).hostname.toLowerCase();
        for (const d of spamDM) {
          if (host.indexOf(d) >= 0) { urlHit = true; break; }
        }
      } catch {}
    }
    if (urlHit) { score = 30; reasons.push('域名黑名单'); }

    // 2. 标题党 / 营销关键词命中 (每命中一个 -18, 累计)
    if (!urlHit) {
      let kwHit = 0;
      for (const kw of spamKW) {
        if (lower.indexOf(kw.toLowerCase()) >= 0) { kwHit++; reasons.push('热词:' + kw); }
      }
      if (kwHit > 0) score -= Math.min(40, kwHit * 18);
    }

    // 3. 全大写比例 (标题党特征): 占比 > 50% 扣 15
    if (!urlHit) {
      const letters = title.replace(/[^A-Za-z]/g, '');
      if (letters.length > 6) {
        const uppers = (title.match(/[A-Z]/g) || []).length;
        if (uppers / letters.length > 0.5) { score -= 15; reasons.push('全大写'); }
      }
    }

    // 4. 连续 >=3 个感叹号 扣 10
    if (!urlHit && /!{3,}/.test(title)) { score -= 10; reasons.push('连环叹号'); }

    // 5. 标题过短 (<4 字符) 且无明显语义 扣 5 (疑似占位)
    if (title.length > 0 && title.length < 4) { score -= 5; reasons.push('标题过短'); }

    // 6. 标题包含具体数字 (新闻体特征) 加 3 (封顶 100)
    if (/\b\d{2,4}\b/.test(title) || /\d+[%万亿美元人]/.test(title)) score += 3;

    score = Math.max(0, Math.min(100, Math.round(score)));
    let level;
    if (score >= 85) level = 'high';
    else if (score >= 60) level = 'mid';
    else level = 'low';
    item.cred = score;
    item.credLevel = level;
    item.credReason = reasons.join(' / ');
    item.spam = level === 'low';
    return item;
  }

  // 是否需要对此源标题翻译
  function needTranslate(source) {
    return (window.SOURCES_NEED_TRANSLATE || []).indexOf(source.id) >= 0;
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

  return { load, flushCache, fetchJSON, translateBatch, translateOne, scoreCredibility, needTranslate };
})();
