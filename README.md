---
AIGC:
  ContentProducer: '001191110102MAD55U9H0F10002'
  ContentPropagator: '001191110102MAD55U9H0F10002'
  Label: '1'
  ProduceID: '95f31b7b-5d01-42b8-9a89-2590e2283d3a'
  PropagateID: '95f31b7b-5d01-42b8-9a89-2590e2283d3a'
  ReservedCode1: '7e038507-3d26-4065-ad2e-2985e152e9e8'
  ReservedCode2: '7e038507-3d26-4065-ad2e-2985e152e9e8'
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

## `update.ps1` 本项目一键推送脚本

在**本项目根目录**用 PowerShell 运行（专为 `global-hotspots` 仓库定制）：

```powershell
.\update.ps1                          # 自动提交并推送（提交信息为时间戳）
.\update.ps1 -Message "新增 XXX"      # 自定义提交信息
.\update.ps1 -Init                    # 首次初始化（git init + 关联远程 + 首次推送）
.\update.ps1 -NoProxy                 # 本次不走 Clash 代理（直连）
.\update.ps1 -Pull                    # 推送前先 rebase 拉取远程
```

特性：
- 默认远程：`https://github.com/Krogin0121/global-hotspots.git`
- 默认走 Clash 代理 `http://127.0.0.1:7890`（可用 `-NoProxy` 关闭）
- 自动配置 UTF-8 提交编码与中文路径兼容
- 推送失败时给出认证/网络/冲突三类常见原因与处理建议

> 首次推送若遇认证失败（403/401），需在 GitHub 生成带 `repo` 权限的 Personal Access Token，推送时用户名填 `Krogin0121`、密码处粘贴 Token，Git 会自动记住。

---

## `gh-push` 通用一键推送工具（适用于日后所有项目）

除本项目专属的 `update.ps1` 外，还提供了一个**全局通用工具** `gh-push`，**任意项目目录**下都能一键完成 init / 自动创建仓库 / commit / push 全流程。

### 安装位置
- 脚本：`D:\Git\cmd\gh-push.ps1`（`D:\Git\cmd` 已在系统 PATH，任意目录可调用）

### 用法
在任意项目目录下：
```powershell
gh-push                                # 仓库名=当前目录名(ASCII化), 自动建仓+推送
gh-push -Repo my-app -Message "v1.2"   # 指定仓库名和提交信息
gh-push -Private                       # 新仓库设为私有
gh-push -NoProxy                       # 直连不走代理
gh-push -Pull                          # 推送前先 rebase 拉取
gh-push -NoCreate                      # 仓库不存在时不自动创建, 直接报错
```

### 核心特性
- **自动建仓**：远程同名仓库不存在时，自动读取已存凭据通过 GitHub API 创建
- **仓库名推断优先级**：`-Repo 参数` > `已有 origin 解析` > `当前目录名`（非 ASCII 字符自动替换为 `-`，规避 PowerShell5.1 + GitHub API 中文编码 bug）
- **沿用 origin**：已绑定 origin 的项目不会误建新仓库
- **凭据来源**：优先读 `~/.git-credentials`（helper=store），回退 `git credential fill`（GCM）
- **默认配置**：用户 `Krogin0121`、代理 `http://127.0.0.1:7890`、分支 `main`，均可用参数覆盖
- **UTF-8 安全**：HttpClient 显式 UTF-8 body；脚本带 BOM 避免 PS5.1 按 GBK 误读
- **cmd /c 包裹 git 命令**：规避 PS5.1 把 git stderr 进度包成 RemoteException 显示假错误

### 首次使用前提
- 已安装 Git（`D:\Git`）
- 已在某次 `git push` 时让 Git 记住 GitHub 凭据（PAT 需带 `repo` scope）
- Clash 在 7890 端口（或用 `-NoProxy`）

## 数据源说明

| 类型 | 来源 | 接入方式 | 备注 |
|------|------|----------|------|
| 国际新闻 | BBC / NYT / Guardian / NPR / DW / CNBC | RSS → rss2json（主）+ allorigins（备） | 客户端 DOMParser 兜底解析 |
| 科技社区 | Hacker News | 官方 Firebase API | 直接 JSON，含分数/评论/讨论链接 |
| 国内热点 | Google 新闻中文 | RSS → rss2json | 稳定 |
| 国内热搜 | 微博/知乎/百度/B站/抖音/头条 | 韩小韩聚合 API | 尽力而为，服务端不稳定时自动降级 |

所有数据版权归原作者所有，本项目仅作信息聚合展示。

> AI生成