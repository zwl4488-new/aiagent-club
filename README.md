# aiagent.club

**Time-series tracking for the AI agent ecosystem** — how agent frameworks, MCP servers, and models grow, stall, and change in price over time, across both the global and Chinese ecosystems.

Most directories tell you what exists *today*. aiagent.club records the **time dimension**: which projects are accelerating, which are quietly dying, and how platform pricing evolves — the things you can only see by measuring the same things every day.

> ⚠️ Early development. Data accumulation is in progress; the public site is not live yet.

## What it tracks

- **Agent frameworks & tools** — signals from GitHub, npm, PyPI, Hugging Face
- **MCP server ecosystem** — health, activity, maintenance status
- **Model & agent usage trends**
- **Platform pricing history** — changes over time, not just current prices
- Both the **global** and **中国 (cn)** ecosystems

## How it works

- Daily collectors pull **public** metrics into an append-only time-series store.
- Rankings **cross-validate multiple signals** (star growth + commit cadence + contributor diversity + downloads) so no single gameable metric can dominate.
- Everything is published as a **static site** — fast, and no visitor tracking.

## Methodology

Rankings are only as trustworthy as their method, so the method is public. A dedicated methodology page (planned) will document exactly how each ranking is computed, and the collectors that produce the data are open source in this repository.

## Tech

Astro (SSG) · SQLite · GitHub Actions · dual deploy — Cloudflare Pages (global) + 阿里云 CDN (China, ICP-filed).

## License

TBD.

---

## 中文简介

**aiagent.club —— AI agent 生态的时序数据站。**

大多数目录只告诉你"现在有什么"。aiagent.club 记录的是**时间维度**:哪些 agent 框架 / MCP server / 模型在加速、哪些在悄悄衰亡、各家平台的定价怎么变——这些只有每天持续测量同一批对象才看得出来,同时覆盖**海外**与**国内**两个生态。

榜单的可信度取决于方法,所以方法公开:多指标交叉验证(star 增速 + 提交频率 + 贡献者多样性 + 下载量),抓取器在本仓库开源。当前处于早期开发阶段,数据正在积累中。
