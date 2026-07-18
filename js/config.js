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

  // 国内 6 平台热搜来源: GitHub 仓库 iiecho1/hot_searches_for_apps (GitHub Actions 每小时抓取归档)
  //   raw 文件走 GitHub CDN 全球可达 + CORS 开放 (Access-Control-Allow-Origin: *), 前端零代理直连
  //   格式: Markdown, 每条 "+ [标题](链接)"
  //   路径: {base}/{平台}/{平台}.md  (平台名中文)
  ghArchive: {
    base: 'https://raw.githubusercontent.com/iiecho1/hot_searches_for_apps/main/archives',
  },

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

  /* ============ 新增: 翻译 & 可信度过滤 ============ */

  // 翻译服务 MyMemory (无需 key, CORS 开放, 匿名约 5000 词/天; 带 de 可升 50000)
  //   GET ?q=TEXT&langpair=en|zh-CN&de=邮箱
  translate: {
    endpoint: 'https://api.mymemory.translated.net/get',
    langpair: 'en|zh-CN',
    de: 'globalhotspots@example.com',
    enabled: true,            // 默认开启翻译 (用户可关)
    // 标题长度超过此值截断后再译 (防止超长请求被拒)
    maxChars: 280,
    // 并发限流: 同一时刻最多 N 个翻译请求在飞
    concurrency: 3,
    // 单条请求超时 (毫秒)
    timeout: 8000,
    // 翻译结果缓存有效期 (默认与新闻缓存一致, 8 分钟)
    cacheTTL: 8 * 60 * 1000,
  },

  // 可信度过滤
  credibility: {
    enabled: true,            // 默认开启过滤 (用户可关)
    // 阈值: < hideThreshold 的条目默认折叠隐藏
    hideThreshold: 60,
    // "仅看高可信" 模式阈值
    highThreshold: 85,
    highOnly: false,          // 默认不开启严格过滤
  },
};

/* ============ 可信度配置 ============ */

// 来源可信度基础分 (按源等级)
//   tier-s: 国际权威主流媒体 (BBC/NYT/Guardian/NPR/DW/CNBC) -> 90
//   tier-a: 主流专业聚合 (Reuters/AP 若加入)               -> 88
//   tier-b: 透明社区 (Hacker News)                          -> 80
//   tier-c: 聚合来源 (Google News / vvhan 国内平台)         -> 75
//   tier-d: 未分类/未知                                      -> 50
const CREDIBILITY_TIER = {
  'bbc':90, 'nyt':90, 'guardian':90, 'npr':90, 'dw':90, 'cnbc':90,
  'hackernews': 80,
  'gn-cn':75, 'weibo':75, 'zhihu':75, 'baidu':75, 'bili':75, 'douyin':75, 'toutiao':75,
};

// 标题党 / 虚假信息特征关键词 (出现即扣分; 中文+英文混合)
const SPAM_KEYWORDS = [
  // 英文 clickbait
  'shocking','you won\'t believe','breaking news:','must see','exposed:','truth revealed',
  'this simple trick','doctors hate','click here','read more','surprising truth',
  'what happens next','will shock you',
  // 中文营销 / 标题党 / 钓鱼
  '震惊','速看','快看','删前速看','点击查看','限时抢购','暴富','月入百万',
  '秘籍','真相曝光','惊天内幕','惊呆','看哭','看完跪了','别再','千万别',
  // 金融诈骗特征
  '稳赚不赔','内部消息','保本保息','日赚','零风险',
];

// 已知不可信域名 (URL 命中即直接降为低可信)
const SPAM_DOMAINS = [
  'clickbait.example','fake-news.example','ads.example',
];

// 翻译语言识别辅助: 这些源标题默认是英文, 需要翻译
const SOURCES_NEED_TRANSLATE = ['bbc','nyt','guardian','npr','dw','cnbc','hackernews'];

/* 数据源列表 ----------------------------------------------------
 * kind:   'rss' | 'hn' | 'gharchive'
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
  { id: 'weibo',      name: '微博热搜',          cat: 'cn',   color: '#e6162d', icon: '微',  kind: 'gharchive', ghArchive: '微博',    site: 'https://s.weibo.com/top/summary',      region: '中国' },
  { id: 'zhihu',      name: '知乎热榜',          cat: 'cn',   color: '#0084ff', icon: '知',  kind: 'gharchive', ghArchive: '知乎',    site: 'https://www.zhihu.com/hot',             region: '中国' },
  { id: 'baidu',      name: '百度热搜',          cat: 'cn',   color: '#2932e1', icon: '百',  kind: 'gharchive', ghArchive: '百度',    site: 'https://top.baidu.com/board?tab=realtime',region: '中国' },
  { id: 'bili',       name: '哔哩哔哩热搜',      cat: 'cn',   color: '#fb7299', icon: 'B',   kind: 'gharchive', ghArchive: '哔哩哔哩',site: 'https://www.bilibili.com/v/popular/rank/all', region: '中国' },
  { id: 'douyin',     name: '抖音热点',          cat: 'cn',   color: '#000000', icon: '抖',  kind: 'gharchive', ghArchive: '抖音',    site: 'https://www.douyin.com/hot',            region: '中国' },
  { id: 'toutiao',    name: '今日头条',          cat: 'cn',   color: '#ed1c24', icon: '头',  kind: 'gharchive', ghArchive: '今日头条',site: 'https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc', region: '中国' },
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
window.CREDIBILITY_TIER = CREDIBILITY_TIER;
window.SPAM_KEYWORDS = SPAM_KEYWORDS;
window.SPAM_DOMAINS = SPAM_DOMAINS;
window.SOURCES_NEED_TRANSLATE = SOURCES_NEED_TRANSLATE;
