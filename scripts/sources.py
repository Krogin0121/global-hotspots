# -*- coding: utf-8 -*-
"""
信源配置 — 全球热点深度解读
按可靠度分级，覆盖国际/国内/科技/财经
"""
import os

# ============ 数据源定义 ============
# tier: 权威等级，影响 LLM 筛选时的权重
#   s = 国际顶级主流媒体（BBC/NYT/Reuters/AP 等）
#   a = 主流专业媒体（ Guardian/NPR/DW/CNBC/新华社 ）
#   b = 透明社区/聚合（HN/Google News）
#   c = 国内社交热搜（娱乐化倾向，需过滤）
SOURCES = [
    # ---------- 国际权威媒体 (tier s/a) ----------
    {
        "id": "bbc", "name": "BBC World", "tier": "s", "cat": "intl",
        "region": "英国", "lang": "en",
        "type": "rss",
        "url": "https://feeds.bbci.co.uk/news/world/rss.xml",
    },
    {
        "id": "nyt", "name": "NYT World", "tier": "s", "cat": "intl",
        "region": "美国", "lang": "en",
        "type": "rss",
        "url": "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",
    },
    {
        "id": "guardian", "name": "The Guardian", "tier": "a", "cat": "intl",
        "region": "英国", "lang": "en",
        "type": "rss",
        "url": "https://www.theguardian.com/world/rss",
    },
    {
        "id": "npr", "name": "NPR News", "tier": "a", "cat": "intl",
        "region": "美国", "lang": "en",
        "type": "rss",
        "url": "https://feeds.npr.org/1001/rss.xml",
    },
    {
        "id": "dw", "name": "Deutsche Welle", "tier": "a", "cat": "intl",
        "region": "德国", "lang": "en",
        "type": "rss",
        "url": "https://rss.dw.com/rdf/rss-en-all",
    },
    {
        "id": "cnbc", "name": "CNBC World", "tier": "a", "cat": "economy",
        "region": "美国", "lang": "en",
        "type": "rss",
        "url": "https://www.cnbc.com/id/100003114/device/rss/rss.html",
    },

    # ---------- 科技社区 ----------
    {
        "id": "hackernews", "name": "Hacker News", "tier": "b", "cat": "tech",
        "region": "全球", "lang": "en",
        "type": "hn",
        "url": "https://hacker-news.firebaseio.com/v0/topstories.json",
        "item_url": "https://hacker-news.firebaseio.com/v0/item/",
        "site": "https://news.ycombinator.com/",
    },

    # ---------- 国内：Google News 中文 + GitHub 归档 6 源 ----------
    {
        "id": "gn-cn", "name": "Google 新闻 · 中文", "tier": "b", "cat": "cn",
        "region": "中国", "lang": "zh",
        "type": "rss",
        "url": "https://news.google.com/rss?hl=zh-CN&gl=CN&ceid=CN:zh-Hans",
    },
    # GitHub 归档：iiecho1/hot_searches_for_apps，CORS 开放，每小时更新
    # 格式：Markdown，每条 "+ [标题](链接)"
    {
        "id": "weibo", "name": "微博热搜", "tier": "c", "cat": "cn",
        "region": "中国", "lang": "zh",
        "type": "gharchive",
        "gh_archive_name": "微博",
        "site": "https://s.weibo.com/top/summary",
    },
    {
        "id": "zhihu", "name": "知乎热榜", "tier": "c", "cat": "cn",
        "region": "中国", "lang": "zh",
        "type": "gharchive",
        "gh_archive_name": "知乎",
        "site": "https://www.zhihu.com/hot",
    },
    {
        "id": "baidu", "name": "百度热搜", "tier": "c", "cat": "cn",
        "region": "中国", "lang": "zh",
        "type": "gharchive",
        "gh_archive_name": "百度",
        "site": "https://top.baidu.com/board?tab=realtime",
    },
    {
        "id": "bili", "name": "哔哩哔哩热搜", "tier": "c", "cat": "cn",
        "region": "中国", "lang": "zh",
        "type": "gharchive",
        "gh_archive_name": "哔哩哔哩",
        "site": "https://www.bilibili.com/v/popular/rank/all",
    },
    {
        "id": "douyin", "name": "抖音热点", "tier": "c", "cat": "cn",
        "region": "中国", "lang": "zh",
        "type": "gharchive",
        "gh_archive_name": "抖音",
        "site": "https://www.douyin.com/hot",
    },
    {
        "id": "toutiao", "name": "今日头条", "tier": "c", "cat": "cn",
        "region": "中国", "lang": "zh",
        "type": "gharchive",
        "gh_archive_name": "今日头条",
        "site": "https://www.toutiao.com/hot-event/hot-board/?origin=toutiao_pc",
    },
]

# GitHub 归档源基础 URL
GH_ARCHIVE_BASE = "https://raw.githubusercontent.com/iiecho1/hot_searches_for_apps/main/archives"

# 每源最多抓取条目数（送入 LLM 前的预筛池）
ITEMS_PER_SOURCE = 20

# Hacker News 抓取条目数
HN_COUNT = 30

# 请求超时（秒）
REQUEST_TIMEOUT = 15

# User-Agent（部分 RSS 拒绝默认 UA）
USER_AGENT = "Mozilla/5.0 (compatible; GlobalHotspotsBot/1.0; +https://github.com/Krogin0121/global-hotspots)"
