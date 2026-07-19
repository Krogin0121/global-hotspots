# -*- coding: utf-8 -*-
"""
curate.py — LLM 智能筛选 + 深度解读

输入: data/raw.json（fetch.py 产出，数百条原始新闻）
输出: data/top20.json（精选20条 + 局势综述 + 每条带AI解读）

流程:
  1. 读取 raw.json
  2. 规则预筛：去重、去标题党、按 tier+时效打分，取 top 40 候选
  3. LLM 调用：从候选中选 top 20 + 生成局势综述 + 每条解读
  4. 写入 top20.json

LLM: 智谱 GLM-4-Flash（OpenAI 兼容接口，免费）
  环境变量:
    ZHIPU_API_KEY  - 智谱 API key
    LLM_BASE_URL   - 可选，默认 https://open.bigmodel.cn/api/paas/v4
    LLM_MODEL      - 可选，默认 glm-4-flash

为避免单次请求过长，分两步调用：
  Step 1: 筛选——输入候选清单，输出 top 20 的 rank 序号
  Step 2: 解读——对 top 20 批量生成解读（每批5条，避免超时）
  Step 3: 综述——基于 top 20 生成局势综述
"""
import json
import os
import re
import sys
import time
from datetime import datetime, timezone

import requests

# ============ 配置 ============
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW_PATH = os.path.join(BASE_DIR, "data", "raw.json")
OUT_PATH = os.path.join(BASE_DIR, "data", "top20.json")

LLM_BASE_URL = os.environ.get("LLM_BASE_URL") or "https://open.bigmodel.cn/api/paas/v4"
LLM_MODEL = os.environ.get("LLM_MODEL") or "glm-4-flash"
API_KEY = os.environ.get("ZHIPU_API_KEY") or os.environ.get("LLM_API_KEY")

# 候选池大小（送入 LLM 筛选的最大条数）
CANDIDATE_POOL = 40

# 最终精选数量
TOP_N = 20

# 每批解读条数（防止单次请求过长）
BATCH_SIZE = 5

# 标题党关键词（预筛阶段过滤）
SPAM_KEYWORDS = [
    "震惊", "速看", "快看", "删前速看", "点击查看", "限时抢购", "暴富", "月入百万",
    "秘籍", "真相曝光", "惊天内幕", "惊呆", "看哭", "看完跪了", "别再", "千万别",
    "稳赚不赔", "内部消息", "保本保息", "日赚", "零风险",
    "shocking", "you won't believe", "must see", "exposed", "click here",
]

REQUEST_TIMEOUT = 60

# 分类规范化映射（raw.json 的 cat → 前端使用的 category）
# raw 用 intl/cn，前端 CATS 用 international/domestic
CAT_NORMALIZE = {
    "intl": "international",
    "cn": "domestic",
    "international": "international",
    "domestic": "domestic",
    "tech": "tech",
    "economy": "economy",
    "society": "society",
}


def normalize_cat(c):
    """将原始 cat 或 LLM 返回的 category 规范化为前端 category"""
    if not c:
        return "international"
    c = str(c).lower().strip()
    return CAT_NORMALIZE.get(c, "international")


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def log(msg):
    print(msg, flush=True)


# ============ 规则预筛 ============
def is_spam(title):
    t = title.lower()
    for kw in SPAM_KEYWORDS:
        if kw.lower() in t:
            return True
    # 全大写或连环叹号
    if title.isupper() and len(title) > 10:
        return True
    if title.count("!") >= 3:
        return True
    return False


def is_duplicate(item, seen_titles):
    """简单去重：标题归一化后比对"""
    t = re.sub(r"[^\w\u4e00-\u9fa5]", "", item["title"].lower())
    if len(t) < 8:
        return False
    for s in seen_titles:
        # 高相似度（一方包含另一方）
        if t in s or s in t:
            return True
        # Jaccard 相似度
        if len(t) > 10 and len(s) > 10:
            set_a = set(t)
            set_b = set(s)
            inter = len(set_a & set_b)
            union = len(set_a | set_b)
            if union > 0 and inter / union > 0.8:
                return True
    return False


def tier_score(tier):
    return {"s": 100, "a": 90, "b": 75, "c": 60}.get(tier, 50)


def time_score(published_at):
    """越新分越高，3天内衰减"""
    if not published_at:
        return 40
    try:
        dt = datetime.fromisoformat(published_at.replace("Z", "+00:00"))
        age_hours = (datetime.now(timezone.utc) - dt).total_seconds() / 3600
        if age_hours < 6:
            return 100
        elif age_hours < 24:
            return 80
        elif age_hours < 48:
            return 60
        elif age_hours < 72:
            return 40
        else:
            return 20
    except Exception:
        return 40


def prefilter(items):
    """规则预筛：去标题党 + 去重 + 打分排序"""
    seen_titles = set()
    cleaned = []
    spam_count = 0
    dup_count = 0
    for it in items:
        title = it.get("title", "").strip()
        if not title or len(title) < 6:
            continue
        if is_spam(title):
            spam_count += 1
            continue
        if is_duplicate(it, seen_titles):
            dup_count += 1
            continue
        seen_titles.add(re.sub(r"[^\w\u4e00-\u9fa5]", "", title.lower()))
        # 综合分：tier 60% + 时效 40%
        score = tier_score(it.get("tier", "c")) * 0.6 + time_score(it.get("publishedAt")) * 0.4
        it["_score"] = score
        cleaned.append(it)

    cleaned.sort(key=lambda x: x["_score"], reverse=True)
    log(f"  预筛: {len(items)} 条原始 → 去标题党 {spam_count} + 去重 {dup_count} → 保留 {len(cleaned)} 条")

    # 按分类配额取候选池，确保覆盖面
    # intl 最多 15、cn 最多 12、tech 最多 8、economy 最多 5
    quota = {"intl": 15, "cn": 12, "tech": 8, "economy": 5}
    by_cat = {"intl": [], "cn": [], "tech": [], "economy": []}
    for it in cleaned:
        cat = it.get("cat", "intl")
        if cat in by_cat and len(by_cat[cat]) < quota.get(cat, 10):
            by_cat[cat].append(it)

    candidates = []
    for cat_list in by_cat.values():
        candidates.extend(cat_list)
    # 限制候选池大小
    candidates = candidates[:CANDIDATE_POOL]
    log(f"  候选池: {len(candidates)} 条（按分类配额）")
    return candidates


# ============ LLM 调用 ============
def llm_chat(messages, temperature=0.7, max_tokens=4000):
    """OpenAI 兼容接口调用"""
    if not API_KEY:
        raise RuntimeError("未配置 ZHIPU_API_KEY 环境变量")

    url = f"{LLM_BASE_URL.rstrip('/')}/chat/completions"
    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
    }
    payload = {
        "model": LLM_MODEL,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
    }
    try:
        resp = requests.post(url, headers=headers, json=payload, timeout=REQUEST_TIMEOUT)
    except requests.exceptions.RequestException as e:
        raise RuntimeError(f"LLM 请求连接失败 (url={url}): {e}")
    if resp.status_code != 200:
        body = resp.text[:300]
        raise RuntimeError(f"LLM API 返回 HTTP {resp.status_code}: {body}")
    data = resp.json()
    return data["choices"][0]["message"]["content"]


def extract_json(text):
    """从 LLM 响应中提取 JSON（可能被 ```json 包裹）"""
    # 去 markdown 代码块
    m = re.search(r"```(?:json)?\s*(.+?)\s*```", text, re.DOTALL)
    if m:
        text = m.group(1)
    # 找第一个 JSON 数组或对象
    m = re.search(r"(\[.*\]|\{.*\})", text, re.DOTALL)
    if m:
        text = m.group(1)
    return json.loads(text)


def step1_select(candidates):
    """Step 1: 让 LLM 从候选池中选 top 20"""
    log("\n--- Step 1: LLM 智能筛选 top 20 ---")
    # 构造候选清单（精简字段以节省 token）
    cand_list = []
    for i, it in enumerate(candidates):
        cand_list.append({
            "idx": i,
            "title": it["title"],
            "source": it["source"],
            "cat": it.get("cat", ""),
            "region": it.get("region", ""),
            "tier": it.get("tier", ""),
            "hotLabel": it.get("hotLabel", ""),
        })

    prompt = f"""你是一位资深国际新闻编辑。请从以下候选新闻中筛选出全球最重要的 {TOP_N} 条，要求：

1. **重要性优先**：影响国家命运/国际格局的事件 > 突发灾害 > 经济动向 > 科技进展 > 社会话题
2. **覆盖平衡**：国际局势与中国国内要闻都要覆盖，避免全部来自单一分类
3. **去重合并**：同一事件多个源报道的，合并为一条，保留所有源信息
4. **权威源优先**：tier=s/a 的权威源 > tier=c 的社交热搜（社交热搜易娱乐化）
5. **排除娱乐八卦**：明显娱乐/明星八卦/猎奇内容不选

候选清单（JSON）：
{json.dumps(cand_list, ensure_ascii=False)}

输出格式（严格 JSON，不要其他文字）：
{{
  "selected": [
    {{"idx": 0, "reason": "50字内说明为何选这条"}},
    ...
  ]
}}

只输出 JSON，不要任何解释。"""

    messages = [
        {"role": "system", "content": "你是资深国际新闻编辑，擅长识别全球最重要的事件。严格按 JSON 格式输出。"},
        {"role": "user", "content": prompt},
    ]

    resp = llm_chat(messages, temperature=0.3, max_tokens=2000)
    data = extract_json(resp)
    # 去重 LLM 可能返回的重复 idx，并过滤越界 idx
    seen = set()
    selected_idxs = []
    for s in data.get("selected", []):
        idx = s.get("idx")
        if isinstance(idx, int) and 0 <= idx < len(candidates) and idx not in seen:
            seen.add(idx)
            selected_idxs.append(idx)
    log(f"  LLM 选中 {len(selected_idxs)} 条（去重后）: {selected_idxs[:10]}...")
    return selected_idxs, data.get("selected", [])


def step2_analyze_batch(batch):
    """Step 2: 对一批（5条）生成深度解读"""
    batch_list = []
    for i, it in enumerate(batch):
        batch_list.append({
            "i": i,
            "title": it["title"],
            "source": it["source"],
            "region": it.get("region", ""),
            "cat": it.get("cat", ""),
            "desc": it.get("desc", ""),
        })

    prompt = f"""你是国际局势分析师。请为以下每条新闻生成深度解读。

新闻列表：
{json.dumps(batch_list, ensure_ascii=False)}

对每条新闻输出：
1. **titleCN**: 中文标题。若原标题是英文等外语，翻译为简洁准确的中文标题；若已是中文则原样返回
2. **summary**: 一句话摘要（30字内，点明核心事件）
3. **analysis**: 200-300字深度解读，包含：
   - 事件背景（为什么发生）
   - 关键影响（对相关国家/领域意味着什么）
   - 后续走向（可能的发展趋势）
4. **keywords**: 3-5个关键词
5. **category**: 重新分类为 international（国际局势）/ domestic（国内要闻）/ tech（科技）/ economy（经济）/ society（社会）
6. **importance**: 重要性评分 1-100（影响越深远分越高）

输出格式（严格 JSON 数组，不要其他文字）：
[
  {{
    "i": 0,
    "titleCN": "...",
    "summary": "...",
    "analysis": "...",
    "keywords": ["...", "..."],
    "category": "international",
    "importance": 85
  }}
]

只输出 JSON，不要解释。"""

    messages = [
        {"role": "system", "content": "你是国际局势分析师，擅长深度解读新闻背后的政治经济逻辑。严格按 JSON 格式输出。"},
        {"role": "user", "content": prompt},
    ]

    resp = llm_chat(messages, temperature=0.5, max_tokens=3000)
    return extract_json(resp)


def step2_analyze_all(selected_items):
    """分批调用 LLM 生成解读"""
    log(f"\n--- Step 2: LLM 批量解读 {len(selected_items)} 条 ---")
    all_analyses = []
    for i in range(0, len(selected_items), BATCH_SIZE):
        batch = selected_items[i:i + BATCH_SIZE]
        log(f"  批次 {i // BATCH_SIZE + 1}: 解读第 {i+1}-{i+len(batch)} 条...")
        try:
            analyses = step2_analyze_batch(batch)
            all_analyses.extend(analyses)
        except Exception as e:
            log(f"  [WARN] 批次 {i//BATCH_SIZE+1} 失败: {e}")
            # 失败则填充空解读
            for j in range(len(batch)):
                all_analyses.append({
                    "i": j,
                    "titleCN": batch[j].get("title", ""),
                    "summary": "",
                    "analysis": "（解读生成失败）",
                    "keywords": [],
                    "category": normalize_cat(batch[j].get("cat", "intl")),
                    "importance": 60,
                })
        time.sleep(1)  # 防 throttle
    return all_analyses


def step3_digest(top_items):
    """Step 3: 基于前20条生成局势综述"""
    log("\n--- Step 3: LLM 生成局势综述 ---")
    titles = [f"{i+1}. {it['title']} ({it.get('category','')})" for i, it in enumerate(top_items)]
    prompt = f"""基于以下今日全球最重要的 {len(top_items)} 条新闻，写一段 200-300 字的「今日局势综述」。

要求：
- 提炼当前国际/国内形势的主要脉络
- 指出最值得关注的事件走向
- 语气客观专业，不煽情
- 不要逐条罗列，而要提炼主线

今日新闻：
{chr(10).join(titles)}

直接输出综述正文，不要标题和解释。"""

    messages = [
        {"role": "system", "content": "你是资深国际评论员，擅长从碎片新闻中提炼宏观局势脉络。"},
        {"role": "user", "content": prompt},
    ]
    try:
        return llm_chat(messages, temperature=0.6, max_tokens=600).strip()
    except Exception as e:
        log(f"  [WARN] 综述生成失败: {e}")
        return "（局势综述生成失败，请稍后刷新）"


# ============ 主流程 ============
def main():
    if not API_KEY:
        print("错误：未配置 ZHIPU_API_KEY 环境变量", file=sys.stderr)
        sys.exit(1)

    log(f"=== LLM 策划开始 {now_iso()} ===")
    log(f"模型: {LLM_MODEL!r} @ {LLM_BASE_URL!r}")
    log(f"API key: {'***' + API_KEY[-4:] if API_KEY else '(空)'} (长度 {len(API_KEY)})")

    # 1. 读取 raw.json
    if not os.path.exists(RAW_PATH):
        print(f"错误：{RAW_PATH} 不存在，请先运行 fetch.py", file=sys.stderr)
        sys.exit(1)
    with open(RAW_PATH, "r", encoding="utf-8") as f:
        raw = json.load(f)
    raw_items = raw.get("items", [])
    log(f"读取 {len(raw_items)} 条原始新闻")

    # 2. 规则预筛
    candidates = prefilter(raw_items)
    if not candidates:
        print("错误：预筛后无候选", file=sys.stderr)
        sys.exit(1)

    # 3. LLM 选 top 20
    try:
        selected_idxs, selection_meta = step1_select(candidates)
    except Exception as e:
        print(f"Step 1 LLM 筛选失败: {e}", file=sys.stderr)
        # 降级：直接取预筛 top N
        selected_idxs = list(range(min(TOP_N, len(candidates))))
        selection_meta = [{"idx": i, "reason": ""} for i in selected_idxs]
        log(f"  降级为规则选择前 {len(selected_idxs)} 条")

    selected_items = [candidates[i] for i in selected_idxs if i < len(candidates)]
    # 不够 TOP_N 则补齐
    if len(selected_items) < TOP_N:
        for i in range(len(candidates)):
            if i not in selected_idxs and len(selected_items) < TOP_N:
                selected_items.append(candidates[i])

    # 4. LLM 批量解读
    analyses = step2_analyze_all(selected_items)

    # 5. 多源印证：从全部 raw_items 中查找与每条 selected 标题高度相似的项，
    #    合并为 sources 列表（实现「X源印证」功能）
    def find_related_sources(item, pool):
        main_src = [{"name": item.get("source", ""), "url": item.get("url", "")}]
        # 用 titleOrig 进行匹配（英文源保留原文），效果更稳定
        norm = re.sub(r"[^\w\u4e00-\u9fa5]", "",
                      (item.get("titleOrig") or item.get("title", "")).lower())
        if len(norm) < 12:
            return main_src
        related = []
        for cand in pool:
            if cand is item:
                continue
            c_norm = re.sub(r"[^\w\u4e00-\u9fa5]", "", cand.get("title", "").lower())
            if len(c_norm) < 12:
                continue
            # 一方标题包含另一方视为同一事件
            if norm in c_norm or c_norm in norm:
                src = {"name": cand.get("source", ""), "url": cand.get("url", "")}
                if src not in main_src and src not in related:
                    related.append(src)
        return main_src + related[:4]  # 最多 5 源

    # 6. 合并解读到 items
    for i, it in enumerate(selected_items):
        a = analyses[i] if i < len(analyses) else {}
        # 标题翻译：保留原外文标题为 titleOrig，title 替换为中文
        title_cn = (a.get("titleCN") or "").strip()
        if title_cn and title_cn != it.get("title"):
            if not it.get("titleOrig"):
                it["titleOrig"] = it["title"]
            it["title"] = title_cn
        it["summary"] = a.get("summary", "")
        it["analysis"] = a.get("analysis", "")
        it["keywords"] = a.get("keywords", [])
        # category 规范化：LLM 返回值或降级原 cat 都要规整为前端格式
        it["category"] = normalize_cat(a.get("category") or it.get("cat", "intl"))
        it["importance"] = a.get("importance", 60)
        # 多源印证 sources
        it["sources"] = find_related_sources(it, raw_items)
        # 清理内部字段
        it.pop("_score", None)

    # 按重要性排序
    selected_items.sort(key=lambda x: x.get("importance", 0), reverse=True)
    # 重新编号 rank
    for i, it in enumerate(selected_items):
        it["rank"] = i + 1

    # 7. 局势综述
    digest = step3_digest(selected_items)

    # 8. 输出
    out = {
        "generatedAt": now_iso(),
        "model": LLM_MODEL,
        "digest": digest,
        "totalSelected": len(selected_items),
        "sourceStats": raw.get("sourceStats", []),
        "items": selected_items,
    }
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    log(f"\n=== 策划完成: {len(selected_items)} 条带解读 → {OUT_PATH} ===")


if __name__ == "__main__":
    main()
