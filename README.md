---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '7d008094-225a-4c56-b4b1-0a01db1acad3'
  PropagateID: '7d008094-225a-4c56-b4b1-0a01db1acad3'
  ReservedCode1: '36a237c5-3d03-498f-a476-7bb8d9251c1a'
  ReservedCode2: '36a237c5-3d03-498f-a476-7bb8d9251c1a'
---

# 全球实时热点事件 · Global Realtime Hotspots Tracker

一个纯静态、零依赖、一键部署到 GitHub Pages 的全球热点聚合看板。在同一页面聚合 **国际新闻 / 科技社区 / 国内热搜** 三大类共 14 个公开数据源，单源失败不影响其它源，开箱即用。

## 功能特性

- **14 个数据源一站式追踪**
  - 国际：BBC World · NYT World · The Guardian · NPR · Deutsche Welle · CNBC
  - 科技：Hacker News（官方 Firebase API，实时分数/评论/讨论链接）
  - 国内：Google 新闻中文 · 微博 · 知乎 · 百度 · 哔哩哔哩 · 抖音 · 今日头条
- **实时刷新**：手动一键刷新 / 自动刷新（5/10/15/30 分钟可选），带 localStorage 缓存（8 分钟 TTL）避免重复请求
- **分类过滤 + 全局搜索**：按国际/科技/国内筛选，关键词高亮命中
- **深色 / 浅色主题**切换，主题与设置自动持久化
- **响应式布局**：桌面多列网格、移动端单列自适应
- **优雅降级**：任一数据源不可达时显示空状态卡片并保留直达链接，不阻塞其它源

## 目录结构

```
.
├── index.html        # 页面骨架
├── css/style.css     # 样式（深色为主，支持浅色切换）
├── js/
│   ├── config.js     # 数据源与全局设置
│   ├── api.js        # 数据获取层（RSS/HN/vvhan 适配器 + 缓存 + 代理降级）
│   └── app.js        # 应用层（渲染/搜索/分类/自动刷新/主题）
├── server.py         # 可选本地代理服务器（自部署时绕过 CORS/限流）
├── update.ps1        # 一键更新并推送至 GitHub 的脚本
└── .gitignore
```

## 本地运行

### 方式 A：纯静态（最简单）

直接用浏览器打开 `index.html` 即可（部分浏览器对 `file://` 下的 fetch 有限制，推荐用方式 B）。

### 方式 B：本地服务器（推荐）

```bash
python server.py            # 默认 http://127.0.0.1:8765
python server.py 9000       # 自定义端口
```

浏览器访问 `http://127.0.0.1:8765/`。

如需启用服务端代理（绕过浏览器 CORS / 限流），编辑 `js/config.js`：

```js
proxy: 'http://127.0.0.1:8765/proxy?url=',
```

`server.py` 零依赖，仅使用 Python 标准库。

## 部署到 GitHub Pages

1. 推送代码到 GitHub 仓库（可用本仓库自带的 `update.ps1` 一键完成）。
2. 仓库 **Settings → Pages → Build and deployment → Source: Deploy from a branch**。
3. 选择 `main` 分支 `/` (root) 目录，Save。
4. 稍等片刻，访问 `https://<你的用户名>.github.io/<仓库名>/`。

GitHub Pages 部署时前端直连公开 API，无需运行 `server.py`。

## `update.ps1` 一键推送脚本

在项目根目录用 PowerShell 运行：

```powershell
.\update.ps1                          # 自动提交并推送（提交信息为时间戳）
.\update.ps1 -Message "新增 XXX"      # 自定义提交信息
.\update.ps1 -Init                    # 首次初始化（git init + 关联远程 + 首次推送）
.\update.ps1 -NoProxy                 # 本次不走 Clash 代理（直连）
.\update.ps1 -Pull                    # 推送前先 rebase 拉取远程
```

脚本特性：
- 自动定位 Git，配置 UTF-8 提交编码与中文路径兼容
- 默认走 Clash 代理 `http://127.0.0.1:7890`（可用 `-NoProxy` 关闭）
- 默认远程：`https://github.com/Krogin0121/全球实时热点事件.git`
- 中文仓库名用码点构建，规避 PowerShell 5.1 脚本文件编码问题
- 推送失败时给出认证/网络/冲突三类常见原因与处理建议

> 首次推送若遇认证失败（403/401），需在 GitHub 生成带 `repo` 权限的 Personal Access Token，推送时用户名填 `Krogin0121`、密码处粘贴 Token（Git Credential Manager 会自动记住）。

## 数据源说明

| 类型 | 来源 | 接入方式 | 备注 |
|------|------|----------|------|
| 国际新闻 | BBC / NYT / Guardian / NPR / DW / CNBC | RSS → rss2json（主）+ allorigins（备） | 客户端 DOMParser 兜底解析 |
| 科技社区 | Hacker News | 官方 Firebase API | 直接 JSON，含分数/评论/讨论链接 |
| 国内热点 | Google 新闻中文 | RSS → rss2json | 稳定 |
| 国内热搜 | 微博/知乎/百度/B站/抖音/头条 | 韩小韩聚合 API | 尽力而为，服务端不稳定时自动降级 |

所有数据版权归原作者所有，本项目仅作信息聚合展示。

> AI生成