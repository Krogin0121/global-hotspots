---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '95aabf70-e00a-4415-8b25-864a27e56a39'
  PropagateID: '95aabf70-e00a-4415-8b25-864a27e56a39'
  ReservedCode1: '5ffbef56-4f12-46f3-8798-0a76b03af534'
  ReservedCode2: '5ffbef56-4f12-46f3-8798-0a76b03af534'
---

# 全球热点深度解读 · Global Hotspots Digest

> AI 策划的多源新闻深度解读网站 · 每日 20 条最重要新闻 + 局势综述

线上访问：https://krogin0121.github.io/global-hotspots/

## 特点

- **AI 智能筛选**：从 15 个信源数百条新闻中，由 LLM 筛选前 20 条最重要事件
- **深度解读**：每条新闻带 200-300 字 AI 分析（背景 + 影响 + 后续走向）
- **局势综述**：每日生成 200 字宏观局势脉络
- **多源印证**：同一事件多个源报道自动合并，显示所有来源
- **分类覆盖**：国际局势 / 国内要闻 / 经济 / 科技 / 社会
- **每 6 小时更新**：GitHub Actions 定时抓取 + AI 处理，零服务器成本

## 架构

```
GitHub Actions (每6小时)
    ↓
scripts/fetch.py          # 抓取 15 个信源 → data/raw.json
    ↓
scripts/curate.py         # LLM 筛选+解读   → data/top20.json
    ↓
GitHub Pages              # 静态前端读取展示
```

### 数据源（15 个）

| 类型 | 源 | tier |
|------|-----|------|
| 国际权威 | BBC · NYT · The Guardian · NPR · Deutsche Welle · CNBC | s/a |
| 科技社区 | Hacker News | b |
| 国内聚合 | Google News 中文 + 微博/知乎/百度/B站/抖音/今日头条（GitHub 归档） | b/c |

国内 6 平台热搜通过 `iiecho1/hot_searches_for_apps` GitHub 仓库归档获取，规避 CORS 限制。

## 部署配置

### 1. 配置 API key（必需）

在 GitHub 仓库 Settings → Secrets and variables → Actions 添加：
- `ZHIPU_API_KEY` — 智谱 API key（在 https://bigmodel.cn 注册获取，GLM-4-Flash 模型免费）

可选（覆盖默认值）：
- `LLM_BASE_URL` — 默认 `https://open.bigmodel.cn/api/paas/v4`
- `LLM_MODEL` — 默认 `glm-4-flash`

### 2. 启用 GitHub Pages

仓库 Settings → Pages → Source: `gh-pages` 分支 `/` 目录

### 3. 启用 Actions

仓库 Settings → Actions → General → 允许 workflows

### 4. 首次触发

Actions 页 → 「每日热点深度解读」workflow → Run workflow 手动触发一次

## 本地测试

```powershell
cd D:\工作流\全球热点
pip install -r scripts/requirements.txt

# 抓取数据
python scripts/fetch.py

# 生成解读（需配置 ZHIPU_API_KEY 环境变量）
$env:ZHIPU_API_KEY = "你的key"
python scripts/curate.py

# 本地预览（任选一种）
python -m http.server 8000
# 浏览器访问 http://localhost:8000
```

## 快捷键

| 键 | 功能 |
|----|------|
| `/` | 聚焦搜索框 |
| `1`-`5` | 切换分类 |
| `J` / `K` | 下/上一条逐条浏览 |
| `R` | 重新加载 |
| `T` | 切换深色/浅色 |
| `?` | 帮助面板 |

## 技术栈

- 前端：原生 HTML/CSS/JS，零依赖
- 后端：Python + feedparser + requests
- LLM：智谱 GLM-4-Flash（OpenAI 兼容接口，免费）
- 部署：GitHub Actions + GitHub Pages

> AI生成