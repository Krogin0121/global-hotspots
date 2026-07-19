# -*- coding: utf-8 -*-
"""
curate.py — LLM 智能筛选 + 深度解读（双轨：国际 / 国内）

输入: data/raw.json（fetch.py 产出，数百条原始新闻）
输出: data/top20.json（双 sections：international + domestic，各20条带解读）

流程（每轨独立执行）:
  1. 读取 raw.json
  2. 规则预筛：按 section 分流 + 去重 + 去标题党 + 按 tier+时效打分 → top 40 候选
  3. Step 1 LLM 筛选：从候选选 top 20，并标识 related（候选池中同事件其他源，跨语言印证）
  4. Step 2 LLM 解读：批量生成解读（每批5条）
  5. Step 3 LLM 综述：基于 top 20 生成局势综述（视角按 section 调整）
  6. 写入 top20.json 的 sections.{intl,domestic}

LLM: 智谱 GLM-4-Flash（OpenAI 兼容接口，免费）
  环境变量:
    ZHIPU_API_KEY  - 智谱 API key
    LLM_BASE_URL   - 可选，默认 https://open.bigmodel.cn/api/paas/v4
    LLM_MODEL      - 可选，默认 glm-4-flash

双轨说明:
  - international（国际热点）: 候选池 = cat∈{intl, economy, tech}
    国际源之间相互印证（BBC/NYT/Guardian 等报道同一事件）
  - domestic（国内热点）: 候选池 = cat=cn 全部 + 含涉华关键词的国际源
    国内源主导，国际源做跨语言印证（中国事件可能在 BBC/NYT 也有报道）
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

# 每轨最终精选数量
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

# 涉华关键词：国内轨候选池纳入英文涉华新闻，供 LLM 做跨语言印证
CHINA_KEYWORDS_RE = re.compile(
    r"(中国|北京|台湾|香港|上海|深圳|西安|广州|杭州|南京|武汉|成都|重庆|天津|"
    r"中美|中俄|中欧|中日|中韩|中印|两岸|半岛|朝鲜|"
    r"Xi\s?Jinping|China|Chinese|Beijing|Taiwan|Hong\s?Kong|Shanghai|Shenzhen|"
    r"US[-\s]?China|Sino[-\s]?|CCP|CPC|Xinhua|Peking|Guangdong|TikTok|Huawei)",
    re.IGNORECASE,
)


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


def prefilter_section(items, section_type):
    """规则预筛：按 section 分流 + 去标题党 + 去重 + 打分排序 → top 40 候选

    section_type:
      - "international": 候选池 = cat∈{intl, economy, tech}（国际权威源+科技）
      - "domestic":      候选池 = cat=cn 全部 + 标题含涉华关键词的 intl/economy 源
                         （国内源主导，国际源涉华新闻作补充供印证）
    """
    seen_titles = set()
    spam_count = 0
    dup_count = 0
    cleaned = []
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

        cat = it.get("cat", "intl")
        # 分流守门
        if section_type == "international":
            if cat not in ("intl", "economy", "tech"):
                continue
        else:  # domestic
            if cat == "cn":
                # gn-cn 是 Google 新闻·中文聚合，含大量中文版国际新闻
                # （如「基辅被炸」「美伊交火」等中译国际新闻）
                # 仅纳入涉华关键词的，避免国际新闻冒充国内热点
                if it.get("sourceId") == "gn-cn" and not CHINA_KEYWORDS_RE.search(
                    it.get("title", "") + " " + it.get("desc", "")
                ):
                    continue
                # 其余 cn 类源（微博/知乎/百度/B站/抖音/今日头条）直接收
            elif cat in ("intl", "economy") and CHINA_KEYWORDS_RE.search(
                (it.get("title", "") + " " + it.get("desc", ""))
            ):
                pass  # 国际源涉华新闻收入
            else:
                continue  # 国际源非涉华 / 科技类不进国内轨

        # 综合分：tier 60% + 时效 40%
        score = tier_score(it.get("tier", "c")) * 0.6 + time_score(it.get("publishedAt")) * 0.4
        # 国内轨对国内源加权，确保国内源在候选中占主导
        if section_type == "domestic" and cat == "cn":
            score += 8
        it["_score"] = score
        cleaned.append(it)

    cleaned.sort(key=lambda x: x["_score"], reverse=True)
    log(f"  [{section_type}] 预筛: 输入 {len(items)} → 去标题党 {spam_count} + 去重 {dup_count} → 分流通过 {len(cleaned)}")
    candidates = cleaned[:CANDIDATE_POOL]
    log(f"  [{section_type}] 候选池: {len(candidates)} 条")
    return candidates


# ============ LLM 调用 ============
def llm_chat(messages, temperature=0.7, max_tokens=4000, retries=2):
    """OpenAI 兼容接口调用，含 2 次自动重试（连接错误 / 429 限流 / 5xx 服务端错误）"""
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
    last_err = None
    for attempt in range(retries + 1):
        try:
            resp = requests.post(url, headers=headers, json=payload, timeout=REQUEST_TIMEOUT)
        except requests.exceptions.RequestException as e:
            last_err = RuntimeError(f"LLM 请求连接失败 (attempt {attempt+1}, url={url}): {e}")
            if attempt < retries:
                time.sleep(2 ** attempt)  # 指数退避: 1s, 2s
                continue
            raise last_err
        # 429 限流 / 5xx 服务端错误 → 重试
        if resp.status_code == 429 or resp.status_code >= 500:
            last_err = RuntimeError(
                f"LLM API HTTP {resp.status_code} (attempt {attempt+1}): {resp.text[:200]}"
            )
            if attempt < retries:
                time.sleep(2 ** attempt)
                continue
            raise last_err
        if resp.status_code != 200:
            raise RuntimeError(f"LLM API 返回 HTTP {resp.status_code}: {resp.text[:300]}")
        data = resp.json()
        return data["choices"][0]["message"]["content"]
    raise last_err or RuntimeError("LLM 调用未知失败")


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


# ============ Step 1: LLM 筛选 + 跨语言印证 ============
def step1_select(candidates, section_type):
    """Step 1: 让 LLM 从候选池中选 top 20，并标识同事件其他源 idx（跨语言印证）"""
    log(f"\n--- [{section_type}] Step 1: LLM 智能筛选 top {TOP_N} + 跨语言印证 ---")

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

    if section_type == "international":
        role_intro = "你是一位资深国际新闻编辑。请从以下候选新闻中筛选出全球最重要的国际热点"
        focus_hint = (
            "1. **重要性优先**：影响国际格局的事件 > 突发灾害 > 经济动向 > 科技进展\n"
            "2. **覆盖平衡**：世界主要地区/各类议题都要覆盖，避免全聚焦单一冲突\n"
            "3. **去重合并**：同一事件多个国际源（BBC/NYT/Guardian/NPR/DW/CNBC/HN）报道的合并为一条\n"
            "4. **权威源优先**：tier=s/a 权威源 > tier=b 聚合\n"
            "5. **排除娱乐八卦**"
        )
    else:  # domestic
        role_intro = "你是一位资深中国新闻编辑。请从以下候选新闻中筛选出最重要的国内热点"
        focus_hint = (
            "1. **重要性优先**：影响国内政治/经济/民生/社会治理的事件 > 突发事件 > 产业动向\n"
            "2. **覆盖平衡**：政策/经济/民生/社会/对外议题都要覆盖，避免娱乐化偏食\n"
            "3. **去重合并**：同一事件多个国内源（微博/知乎/百度/B站/抖音/今日头条/Google新闻中文）报道的合并为一条\n"
            "4. **国内源主导**：优先选择国内源；同一事件国际源也报道了的，把国际源 idx 加入 related 字段反映「国际关注」\n"
            "5. **排除娱乐八卦**：明星/综艺/直播打榜类不选"
        )

    prompt = f"""{role_intro} {TOP_N} 条，要求：

{focus_hint}

**⚠ 跨语言事件聚合（最关键，related 字段必填，不可省略）：**
候选清单中可能同时含中文源和英文源。同一事件常常被多个语言多个源报道。**对每条选中的新闻，必须在 `related` 字段列出候选清单里所有报道同一事件的其他源 idx（不限语言）**。
- 同一事件**只选一次**（如同一事件被 BBC、NYT、微博都报道，只选主源 1 个为 idx，其他全部放入 related，**不要重复选入 selected**）。
- 例：候选 5 = 中文「俄军导弹袭击基辅」(微博)，候选 18 = 英文「Russia missile attack on Kyiv」(BBC) → 同一事件，只选其一为主，related 写另一个 idx。
- 如果某条新闻在候选清单中确实没有同事件其他源，related 写空数组 []。

候选清单（JSON）：
{json.dumps(cand_list, ensure_ascii=False)}

输出格式（严格 JSON，不要其他文字）：
{{
  "selected": [
    {{"idx": 0, "reason": "50字内说明", "related": [12, 18]}},
    ...
  ]
}}

related 字段不可缺省，必填。只输出 JSON，不要任何解释。"""

    messages = [
        {"role": "system", "content": "你是资深新闻编辑，擅长识别全球最重要的新闻并做跨语言事件聚合。严格按 JSON 格式输出。related 字段必填，不可省略。"},
        {"role": "user", "content": prompt},
    ]

    resp = llm_chat(messages, temperature=0.3, max_tokens=2500)
    # 详细日志便于线上诊断 LLM 是否遵守 related 字段
    log(f"  [{section_type}] LLM 原始响应前 400 字: {resp[:400]}")
    data = extract_json(resp)
    # 去重 LLM 可能返回的重复 idx，并过滤越界 idx
    seen = set()
    selected = []
    for s in data.get("selected", []):
        idx = s.get("idx")
        if isinstance(idx, int) and 0 <= idx < len(candidates) and idx not in seen:
            seen.add(idx)
            s.setdefault("related", [])
            # 清洗 related：仅保留合法 idx（兼容字符串数字 "12"，且 ≠ 自身）
            raw_related = s.get("related") or []
            if not isinstance(raw_related, list):
                raw_related = []
            def _to_idx(r):
                if isinstance(r, bool):
                    return None
                if isinstance(r, int):
                    return r
                if isinstance(r, str) and r.strip().lstrip("-").isdigit():
                    return int(r.strip())
                return None
            s["related"] = [
                ri for r in raw_related
                for ri in [_to_idx(r)]
                if ri is not None and 0 <= ri < len(candidates) and ri != idx
            ][:5]
            selected.append(s)
    log(f"  [{section_type}] LLM 选中 {len(selected)} 条（去重后）:")
    for s in selected[:5]:
        log(f"    idx={s['idx']} related={s.get('related', [])} | {candidates[s['idx']]['title'][:40]}")
    if len(selected) > 5:
        log(f"    ... 其余 {len(selected)-5} 条")
    rel_cnt = sum(1 for s in selected if s.get('related'))
    log(f"  [{section_type}] 含 related 的条数: {rel_cnt}/{len(selected)}")

    # 兜底：基于 related 互指规则强制合并同一事件
    # 如果 LLM 选了多条本应是一件事的（互为 related），合并为主+配角的关系
    selected = merge_duplicate_events(selected, candidates)
    log(f"  [{section_type}] 合并去重后 {len(selected)} 条")
    # 强制截断到 TOP_N（LLM 可能超选）
    if len(selected) > TOP_N:
        log(f"  [{section_type}] LLM 超选 {len(selected)} 条，截断至 {TOP_N}")
        selected = selected[:TOP_N]
    return selected


def merge_duplicate_events(selected, candidates):
    """基于 related 字段合并重复事件：
    若 A.related 含 B.idx（或反向），视为同一事件，保留 A 为主，B 的 idx 转入 A.related。
    """
    if len(selected) <= 1:
        return selected
    sel_map = {s["idx"]: s for s in selected}
    used = set()
    merged = []
    for s in selected:
        if s["idx"] in used:
            continue
        # 收集与 s 同事件的成员（s 单向指向 + 其他 selected 单向指向 s）
        group = {s["idx"]}
        for r in s.get("related", []):
            if r in sel_map and r not in used:
                group.add(r)
        for s2 in selected:
            if s2["idx"] in used or s2["idx"] == s["idx"]:
                continue
            if s["idx"] in (s2.get("related") or []):
                group.add(s2["idx"])
        # 把配角 source 累积为主源的 related
        all_related = set()
        for g in group:
            if g == s["idx"]:
                continue
            all_related.add(g)
            for r in (sel_map[g].get("related") or []):
                if r not in group and r not in sel_map:
                    all_related.add(r)  # 候选池中而非 selected 中的也加入
        s = dict(s)  # 浅复制，避免修改原 dict
        s["related"] = sorted(all_related)[:5]
        merged.append(s)
        for g in group:
            used.add(g)
    return merged


# ============ Step 2: LLM 解读 ============
def step2_analyze_batch(batch, section_type):
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

    if section_type == "international":
        role = "你是国际局势分析师，擅长深度解读新闻背后的政治经济逻辑。"
        cat_hint = "international（国际局势）/ domestic（国内要闻）/ tech（科技）/ economy（经济）/ society（社会）"
        analy_hint = (
            "3. **analysis**: 200-300字深度解读，包含：\n"
            "   - 事件背景（为什么发生）\n"
            "   - 关键影响（对相关国家/国际格局意味着什么）\n"
            "   - 后续走向（可能的发展趋势）"
        )
    else:
        role = "你是资深中国时事分析师，擅长深挖国内新闻背后的政策意图与社会影响。"
        cat_hint = "domestic（国内要闻）/ economy（经济）/ society（社会）/ tech（科技）/ international（涉及中国的国际事件）"
        analy_hint = (
            "3. **analysis**: 200-300字深度解读，包含：\n"
            "   - 事件背景（政策意图 / 社会成因）\n"
            "   - 关键影响（对国内民生 / 经济 / 治理意味着什么）\n"
            "   - 后续走向（政策或事件可能的发展）"
        )

    prompt = f"""{role}请为以下每条新闻生成深度解读。

新闻列表：
{json.dumps(batch_list, ensure_ascii=False)}

对每条新闻输出：
1. **titleCN**: 中文标题。若原标题是英文等外语，翻译为简洁准确的中文标题；若已是中文则原样返回
2. **summary**: 一句话摘要（30字内，点明核心事件）
{analy_hint}
4. **keywords**: 3-5个关键词
5. **category**: 重新分类为 {cat_hint}
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
        {"role": "system", "content": role + " 严格按 JSON 格式输出。"},
        {"role": "user", "content": prompt},
    ]

    resp = llm_chat(messages, temperature=0.5, max_tokens=3000)
    return extract_json(resp)


def step2_analyze_all(selected_items, section_type):
    """分批调用 LLM 生成解读"""
    log(f"  [{section_type}] Step 2: 批量解读 {len(selected_items)} 条")
    all_analyses = []
    for i in range(0, len(selected_items), BATCH_SIZE):
        batch = selected_items[i:i + BATCH_SIZE]
        log(f"  [{section_type}] 批次 {i // BATCH_SIZE + 1}: 第 {i+1}-{i+len(batch)} 条...")
        try:
            analyses = step2_analyze_batch(batch, section_type)
            all_analyses.extend(analyses)
        except Exception as e:
            log(f"  [{section_type}] [WARN] 批次 {i//BATCH_SIZE+1} 失败: {e}")
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


# ============ Step 3: 局势综述 ============
def step3_digest(top_items, section_type):
    """Step 3: 基于前20条生成局势综述（视角随 section 调整）"""
    log(f"  [{section_type}] Step 3: 生成局势综述 ---")
    titles = [f"{i+1}. {it['title']} ({it.get('category','')})" for i, it in enumerate(top_items)]

    if section_type == "international":
        sys_role = "你是资深国际评论员，擅长从碎片新闻中提炼宏观国际局势脉络。"
        ask = "基于以下今日{N}条国际热点新闻，写一段 200-300 字的「今日国际局势综述」。"
        angle = "- 提炼当前国际形势的主要脉络\n- 指出最值得关注的事件走向\n- 语气客观专业，不煽情"
    else:
        sys_role = "你是资深国内时事评论员，擅长从碎片新闻中提炼当前中国社会的内在脉络。"
        ask = "基于以下今日{N}条国内热点新闻，写一段 200-300 字的「今日国内形势综述」。"
        angle = "- 提炼当前国内政策与社会动向的主要脉络\n- 指出最值得关注的走向\n- 语气客观专业，不煽情"

    prompt = f"""{ask.replace("{N}", str(len(top_items)))}

要求：
{angle}
- 不要逐条罗列，而要提炼主线

今日新闻：
{chr(10).join(titles)}

直接输出综述正文，不要标题和解释。"""

    messages = [
        {"role": "system", "content": sys_role},
        {"role": "user", "content": prompt},
    ]
    try:
        return llm_chat(messages, temperature=0.6, max_tokens=600).strip()
    except Exception as e:
        log(f"  [{section_type}] [WARN] 综述生成失败: {e}")
        return "（局势综述生成失败，请稍后刷新）"


# ============ 多源印证构造 ============
# 中英实体对照（用于跨语言事件匹配：国内轨找国际源涉华报道作印证）
# 对"中X"类双边关系词补充双向英文变体（US-China / China-US 均可命中）
CN_ENTITIES = [
    ("中国", "China"), ("中国", "Chinese"),
    ("台湾", "Taiwan"), ("香港", "Hong Kong"),
    ("北京", "Beijing"), ("上海", "Shanghai"), ("深圳", "Shenzhen"),
    ("广州", "Guangzhou"), ("武汉", "Wuhan"), ("成都", "Chengdu"),
    ("习近平", "Xi Jinping"),
    ("中美", "US-China"), ("中美", "China-US"), ("中美", "US China"),
    ("中美", "China and US"), ("中美", "U.S.-China"),
    ("中俄", "Sino-Russia"), ("中俄", "Russia-China"),
    ("中俄", "China-Russia"), ("中俄", "China and Russia"),
    ("中欧", "China-EU"), ("中欧", "EU-China"), ("中欧", "China and EU"),
    ("中日", "China-Japan"), ("中日", "Japan-China"), ("中日", "China and Japan"),
    ("华为", "Huawei"), ("抖音", "TikTok"),
    ("朝鲜", "North Korea"), ("半岛", "Korea"),
    ("两岸", "Taiwan Strait"), ("南海", "South China Sea"),
    ("一带一路", "Belt and Road"),
]


def cross_lang_match(title, raw_items, seen_urls, limit=3):
    """跨语言实体匹配：从国际源（intl/economy）里查找含相同中国实体的报道

    用于国内轨：中文标题若含中国实体词，在英文国际源标题里找对应的英文实体，
    形成「国内事件 + 国际源印证」的跨语言多源结构。
    """
    extra = []
    if not title:
        return extra
    # 找出标题命中的中文实体
    hits = [(cn, en) for cn, en in CN_ENTITIES if cn in title]
    if not hits:
        return extra
    for cand in raw_items:
        if cand.get("cat") not in ("intl", "economy"):
            continue
        c_title = (cand.get("title", "") + " " + cand.get("desc", "")).lower()
        for cn, en in hits:
            if en.lower() in c_title:
                src = {"name": cand.get("source", ""), "url": cand.get("url", "")}
                if src["url"] and src["url"] not in seen_urls:
                    seen_urls.add(src["url"])
                    extra.append(src)
                    if len(extra) >= limit:
                        return extra
                break  # 该候选已命中一个实体，跳出内层循环
    return extra


def build_sources(it, candidates, related_idxs, raw_items, section_type="international"):
    """构造 sources 列表：主源 + LLM related 源 + 字符串匹配 fallback + 跨语言实体匹配

    LLM 的 related 字段是主路径；
    若 LLM 没给或太少，再用字符串匹配（同语言）和跨语言实体匹配（国内轨）补充。
    """
    main_src = [{"name": it.get("source", ""), "url": it.get("url", "")}]
    seen_urls = {it.get("url", "")}
    related = []

    # 1) LLM 指出的 related idx（候选池内）
    for idx in (related_idxs or []):
        if isinstance(idx, int) and 0 <= idx < len(candidates):
            c = candidates[idx]
            u = c.get("url", "")
            n = c.get("source", "")
            if u and u not in seen_urls and n:
                seen_urls.add(u)
                related.append({"name": n, "url": u})

    # 2) 字符串匹配 fallback：在全 raw 池查找标题高度相似的项
    if len(related) < 2:
        norm = re.sub(r"[^\w\u4e00-\u9fa5]", "",
                      (it.get("titleOrig") or it.get("title", "")).lower())
        if len(norm) >= 12:
            for cand in raw_items:
                if cand is it:
                    continue
                c_norm = re.sub(r"[^\w\u4e00-\u9fa5]", "", cand.get("title", "").lower())
                if len(c_norm) < 12:
                    continue
                if norm in c_norm or c_norm in norm:
                    src = {"name": cand.get("source", ""), "url": cand.get("url", "")}
                    if src["url"] and src["url"] not in seen_urls and src not in related:
                        seen_urls.add(src["url"])
                        related.append(src)
                        if len(related) >= 4:
                            break

    # 3) 跨语言实体匹配（国内轨专用）：找国际源涉华报道作印证
    if section_type == "domestic" and len(related) < 2:
        related.extend(cross_lang_match(it.get("title", ""), raw_items, seen_urls, limit=3))

    return main_src + related[:4]  # 最多 5 源


# ============ 单轨完整流程 ============
SECTION_TITLE = {
    "international": "国际热点 20",
    "domestic": "国内热点 20",
}


def curate_section(raw_items, section_type):
    """执行单轨完整 LLM 流程，返回 {title, digest, items}"""
    log(f"\n========== [{section_type.upper()}] 轨开始 ==========")

    candidates = prefilter_section(raw_items, section_type)
    if not candidates:
        log(f"  [{section_type}] 候选池为空，返回空 section")
        return {
            "title": SECTION_TITLE[section_type],
            "digest": "（暂无候选数据）",
            "totalSelected": 0,
            "items": [],
        }

    # Step 1: LLM 筛选
    try:
        selected = step1_select(candidates, section_type)
    except Exception as e:
        print(f"[{section_type}] Step 1 LLM 筛选失败: {e}", file=sys.stderr)
        # 降级：取预筛 top N
        selected = [{"idx": i, "reason": "", "related": []} for i in range(min(TOP_N, len(candidates)))]
        log(f"  [{section_type}] 降级为规则选择前 {len(selected)} 条")

    selected_idxs = [s["idx"] for s in selected]
    selected_items = [candidates[i] for i in selected_idxs if i < len(candidates)]

    # 不够 TOP_N 则用候选池中剩余高分的补齐
    if len(selected_items) < TOP_N:
        for i in range(len(candidates)):
            if i not in selected_idxs and len(selected_items) < TOP_N:
                selected.append({"idx": i, "reason": "", "related": []})
                selected_items.append(candidates[i])

    # Step 2: 批量解读
    analyses = step2_analyze_all(selected_items, section_type)

    # 合并解读 + sources 到 items
    for i, it in enumerate(selected_items):
        a = analyses[i] if i < len(analyses) else {}
        # 标题翻译：保留原外文为 titleOrig，title 替换为中文
        title_cn = (a.get("titleCN") or "").strip()
        if title_cn and title_cn != it.get("title"):
            if not it.get("titleOrig"):
                it["titleOrig"] = it["title"]
            it["title"] = title_cn
        it["summary"] = a.get("summary", "")
        it["analysis"] = a.get("analysis", "")
        it["keywords"] = a.get("keywords", [])
        it["category"] = normalize_cat(a.get("category") or it.get("cat", "intl"))
        it["importance"] = a.get("importance", 60)
        # 多源印证：优先 LLM related，fallback 字符串匹配 + 跨语言实体匹配
        related_idxs = selected[i].get("related", []) if i < len(selected) else []
        it["sources"] = build_sources(it, candidates, related_idxs, raw_items, section_type)
        # 清理内部字段
        it.pop("_score", None)

    # 按 importance 排序 + rank 编号
    selected_items.sort(key=lambda x: x.get("importance", 0), reverse=True)
    for i, it in enumerate(selected_items):
        it["rank"] = i + 1

    # Step 3: 局势综述
    digest = step3_digest(selected_items, section_type)

    log(f"  [{section_type}] 完成: {len(selected_items)} 条带解读")
    return {
        "title": SECTION_TITLE[section_type],
        "digest": digest,
        "totalSelected": len(selected_items),
        "items": selected_items,
    }


# ============ 主流程 ============
def main():
    if not API_KEY:
        print("错误：未配置 ZHIPU_API_KEY 环境变量", file=sys.stderr)
        sys.exit(1)

    log(f"=== LLM 双轨策划开始 {now_iso()} ===")
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

    # 2. 双轨并行执行（国际 + 国内）
    intl_section = curate_section(raw_items, "international")
    cn_section = curate_section(raw_items, "domestic")

    # 3. 输出
    out = {
        "generatedAt": now_iso(),
        "model": LLM_MODEL,
        "sourceStats": raw.get("sourceStats", []),
        "sections": {
            "international": intl_section,
            "domestic": cn_section,
        },
    }
    os.makedirs(os.path.dirname(OUT_PATH), exist_ok=True)
    with open(OUT_PATH, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    log(f"\n=== 双轨策划完成 → {OUT_PATH} ===")
    log(f"  国际 {intl_section['totalSelected']} 条 + 国内 {cn_section['totalSelected']} 条")


if __name__ == "__main__":
    main()
