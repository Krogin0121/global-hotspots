/* ============================================================
 *  config.js  —  全球实时热点事件 · 数据源与全局设置
 *  ----------------------------------------------------------
 *  数据源分类:
 *    intl  国际新闻 (RSS -> rss2json, 备用 allorigins)
 *    tech  科技社区 (Hacker News 官方 Firebase API)
 *    cn    国内热点 (Google News 中文 + 韩小韩聚合, 尽力而为)
 *
 *  所有源在前端独立请求, 单源失败不影响其它源 (优雅降级)。
 * ============================================================ */

const CONFIG = {
  // CORS 友好的 RSS->JSON 转换服务 (无需 key, 客户端直连)
  rss2json: 'https://api.rss2json.com/v1/api.json?rss_url=',

  // rss2json 失败时的备用 CORS 代理 (返回原始 XML, 客户端 DOMParser 解析)
  allorigins: 'https://api.allorigins.win/raw?url=',

  // Hacker News 官方 API (CORS 开放, 无需 key)
  hnTopStories: 'https://hacker-news.firebaseio.com/v0/topstories.json',
  hnItem: 'https://hacker-news.firebaseio.com/v0/item/',

  // 韩小韩聚合 API (国内社交平台热搜, 服务端偶尔不稳定, 仅做尽力而为)
  vvhan: 'https://api.vvhan.com/api/hotlist/',

  // 可选: 本地代理 server.py (自部署时绕过 CORS/限流)
  // 留 null 则纯静态运行(GitHub Pages 友好); 设为 'http://127.0.0.1:8765/proxy?url=' 则启用
  proxy: null,

  // 缓存有效期 (毫秒), 默认 8 分钟
  cacheTTL: 8 * 60 * 1000,

  // 默认自动刷新间隔 (毫秒), 默认 10 分钟
  refreshInterval: 10 * 60 * 1000,

  // 每个源最多展示条目数
  itemsPerSource: 15,

  // Hacker News 抓取条目数
  hnCount: 30,
};

/* 数据源列表 ----------------------------------------------------
 * kind:   'rss' | 'hn' | 'vvhan'
 * cat:    'intl' | 'tech' | 'cn'
 * color:  主题色 (用于卡片头部色条/图标背景)
 * icon:   emoji 或单字标识
 */
const SOURCES = [
  /* ---------- 国际新闻 ---------- */
  { id: 'bbc',        name: 'BBC World',         cat: 'intl', color: '#bb1919', icon: 'BBC', kind: 'rss',  url: 'https://feeds.bbci.co.uk/news/world/rss.xml',          region: '英国' },
  { id: 'nyt',        name: 'NYT World',         cat: 'intl', color: '#000000', icon: 'NYT', kind: 'rss',  url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml', region: '美国' },
  { id: 'guardian',   name: 'The Guardian',      cat: 'intl', color: '#052962', icon: 'TG',  kind: 'rss',  url: 'https://www.theguardian.com/world/rss',                 region: '英国' },
  { id: 'npr',        name: 'NPR News',          cat: 'intl', color: '#0066cc', icon: 'NPR', kind: 'rss',  url: 'https://feeds.npr.org/1001/rss.xml',                    region: '美国' },
  { id: 'dw',         name: 'Deutsche Welle',    cat: 'intl', color: '#002d5b', icon: 'DW',  kind: 'rss',  url: 'https://rss.dw.com/rdf/rss-en-all',                     region: '德国' },
  { id: 'cnbc',       name: 'CNBC World',        cat: 'intl', color: '#005594', icon: 'CNBC',kind: 'rss',  url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html', region: '美国' },

  /* ---------- 科技社区 ---------- */
  { id: 'hackernews', name: 'Hacker News',       cat: 'tech', color: '#ff6600', icon: 'Y',   kind: 'hn',   region: '全球', site: 'https://news.ycombinator.com/' },

  /* ---------- 国内热点 ---------- */
  { id: 'gn-cn',      name: 'Google 新闻 · 中文', cat: 'cn',   color: '#4285f4', icon: 'G',   kind: 'rss',  url: 'https://news.google.com/rss?hl=zh-CN&gl=CN&ceid=CN:zh-Hans', region: '中国' },
  { id: 'weibo',      name: '微博热搜',          cat: 'cn',   color: '#e6162d', icon: '微',  kind: 'vvhan', vvhan: 'weibo',    site: 'https://s.weibo.com/top/summary',      region: '中国' },
  { id: 'zhihu',      name: '知乎热榜',          cat: 'cn',   color: '#0084ff', icon: '知',  kind: 'vvhan', vvhan: 'zhihu',    site: 'https://www.zhihu.com/hot',             region: '中国' },
  { id: 'baidu',      name: '百度热搜',          cat: 'cn',   color: '#2932e1', icon: '百',  kind: 'vvhan', vvhan: 'baidu',    site: 'https://top.baidu.com/board?tab=realtime',region: '中国' },
  { id: 'bili',       name: '哔哩哔哩热搜',      cat: 'cn',   color: '#fb7299', icon: 'B',   kind: 'vvhan', vvhan: 'bilibili', site: 'https://www.bilibili.com/v/popular/rank/all', region: '中国' },
  { id: 'douyin',     name: '抖音热点',          cat: 'cn',   color: '#000000', icon: '抖',  kind: 'vvhan', vvhan: 'douyin',   site: 'https://www.douyin.com/hot',            region: '中国' },
  { id: 'toutiao',    name: '今日头条',          cat: 'cn',   color: '#ed1c24', icon: '头',  kind: 'vvhan', vvhan: 'toutiao',  site: 'https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc', region: '中国' },
];

// 分类标签
const CATEGORIES = [
  { id: 'all',   name: '全部'   },
  { id: 'intl',  name: '国际'   },
  { id: 'tech',  name: '科技'   },
  { id: 'cn',    name: '国内'   },
];

// 暴露到全局
window.CONFIG = CONFIG;
window.SOURCES = SOURCES;
window.CATEGORIES = CATEGORIES;
