# -*- coding: utf-8 -*-
"""
fetch.py — 抓取所有信源，输出 raw.json

数据流：
  各源 RSS / API / GitHub 归档 → 统一格式 → data/raw.json

输出格式（raw.json）：
{
  "fetchedAt": "2026-07-18T12:00:00Z",
  "items": [
    {
      "title": "...",
      "titleOrig": "...",  # 原文标题（国际源才有）
      "url": "...",
      "source": "BBC",     # 源名称
      "sourceId": "bbc",   # 源 ID
      "tier": "s",         # 权威等级
      "cat": "intl",       # 分类
      "region": "英国",
      "lang": "en",
      "publishedAt": "2026-07-18T10:00:00Z",
      "desc": "...",       # 摘要（可选）
      "hotLabel": "#1",    # 热度标签（国内热搜源才有）
    },
    ...
  ]
}
"""
import json
import os
import sys
import time
import re
import html
from datetime import datetime, timezone

import feedparser
import requests

from sources import (
    SOURCES, GH_ARCHIVE_BASE, ITEMS_PER_SOURCE, HN_COUNT,
    REQUEST_TIMEOUT, USER_AGENT,
)

OUT_PATH = os.path.join(os.path.dirname(__file__), "..", "data", "raw.json")


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def fetch_url(url, timeout=REQUEST_TIMEOUT):
    """带 UA 的 GET 请求"""
    headers = {"User-Agent": USER_AGENT}
    resp = requests.get(url, headers=headers, timeout=timeout)
    resp.raise_for_status()
    return resp


def clean_text(s):
    """去除 HTML 标签 + 实体解码 + 压缩空白"""
    if not s:
        return ""
    # 去 HTML 标签
    s = re.sub(r"<[^>]+>", "", s)
    # 实体解码（两次，处理 &amp;#x2F; 这种嵌套）
    s = html.unescape(html.unescape(s))
    # 压缩空白
    s = re.sub(r"\s+", " ", s).strip()
    return s


def parse_date(entry):
    """从 feedparser entry 解析发布时间，返回 ISO 字符串"""
    for field in ("published_parsed", "updated_parsed"):
        t = getattr(entry, field, None)
        if t:
            try:
                dt = datetime(*t[:6], tzinfo=timezone.utc)
                return dt.isoformat()
            except Exception:
                pass
    return None


# ============ RSS 抓取 ============
def fetch_rss(source):
    items = []
    try:
        resp = fetch_url(source["url"])
        # feedparser 可解析字节流
        feed = feedparser.parse(resp.content)
        for i, entry in enumerate(feed.entries[:ITEMS_PER_SOURCE]):
            title = clean_text(entry.get("title", ""))
            if not title:
                continue
            link = entry.get("link", "")
            desc = clean_text(entry.get("summary", "") or entry.get("description", ""))
            items.append({
                "title": title,
                "titleOrig": title if source["lang"] == "en" else "",
                "url": link,
                "source": source["name"],
                "sourceId": source["id"],
                "tier": source["tier"],
                "cat": source["cat"],
                "region": source["region"],
                "lang": source["lang"],
                "publishedAt": parse_date(entry),
                "desc": desc[:300] if desc else "",
                "hotLabel": "",
            })
    except Exception as e:
        print(f"  [WARN] {source['id']} RSS 失败: {e}", file=sys.stderr)
    print(f"  [OK]  {source['id']:12s} {len(items):3d} 条")
    return items


# ============ Hacker News 抓取 ============
def fetch_hn(source):
    items = []
    try:
        resp = fetch_url(source["url"])
        ids = resp.json()[:HN_COUNT]
        item_url_tmpl = source["item_url"]
        for i, item_id in enumerate(ids):
            try:
                r = fetch_url(f"{item_url_tmpl}{item_id}.json")
                it = r.json()
                if not it or it.get("type") != "story":
                    continue
                title = clean_text(it.get("title", ""))
                if not title:
                    continue
                # HN story 可能没有 url（Ask/Tell HN），用讨论页作 url
                url = it.get("url") or f"https://news.ycombinator.com/item?id={item_id}"
                score = it.get("score", 0)
                desc = ""
                if it.get("text"):
                    desc = clean_text(it["text"])[:300]
                items.append({
                    "title": title,
                    "titleOrig": title,
                    "url": url,
                    "source": source["name"],
                    "sourceId": source["id"],
                    "tier": source["tier"],
                    "cat": source["cat"],
                    "region": source["region"],
                    "lang": "en",
                    "publishedAt": None,
                    "desc": desc,
                    "hotLabel": f"♥{score}" if score else "",
                    "discussUrl": f"https://news.ycombinator.com/item?id={item_id}",
                })
            except Exception:
                continue
    except Exception as e:
        print(f"  [WARN] HN 失败: {e}", file=sys.stderr)
    print(f"  [OK]  {source['id']:12s} {len(items):3d} 条")
    return items


# ============ GitHub 归档抓取 ============
def fetch_gharchive(source):
    items = []
    try:
        name = source["gh_archive_name"]
        url = f"{GH_ARCHIVE_BASE}/{name}/{name}.md"
        resp = fetch_url(url)
        text = resp.text
        # 解析 "+ [标题](链接)" 格式
        # 部分归档用 "1. [标题](链接)" 或 "* [标题](链接)"
        pattern = re.compile(r"^\s*(?:\+|\*|-|\d+\.)\s*\[([^\]]+)\]\(([^)]+)\)", re.MULTILINE)
        for i, m in enumerate(pattern.finditer(text)):
            if i >= ITEMS_PER_SOURCE:
                break
            title = clean_text(m.group(1))
            link = m.group(2).strip()
            if not title or not link:
                continue
            items.append({
                "title": title,
                "titleOrig": "",
                "url": link,
                "source": source["name"],
                "sourceId": source["id"],
                "tier": source["tier"],
                "cat": source["cat"],
                "region": source["region"],
                "lang": "zh",
                "publishedAt": None,
                "desc": "",
                "hotLabel": f"#{i+1}" if i < 3 else "",
            })
    except Exception as e:
        print(f"  [WARN] {source['id']} 归档失败: {e}", file=sys.stderr)
    print(f"  [OK]  {source['id']:12s} {len(items):3d} 条")
    return items


# ============ 主流程 ============
def main():
    print(f"=== 抓取开始 {now_iso()} ===")
    all_items = []
    for src in SOURCES:
        t = src["type"]
        if t == "rss":
            items = fetch_rss(src)
        elif t == "hn":
            items = fetch_hn(src)
        elif t == "gharchive":
            items = fetch_gharchive(src)
        else:
            print(f"  [SKIP] 未知类型: {t}", file=sys.stderr)
            continue
        all_items.extend(items)

    # 输出
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    out = {
        "fetchedAt": now_iso(),
        "totalItems": len(all_items),
        "items": all_items,
    }
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)

    print(f"\n=== 抓取完成: 共 {len(all_items)} 条 → {OUT_PATH} ===")


if __name__ == "__main__":
    main()
