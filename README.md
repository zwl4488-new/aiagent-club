# aiagent.club

**Time-series tracking for the AI agent ecosystem** — how agent frameworks, MCP servers, and models grow, stall, and change in price over time, across both the global and Chinese ecosystems.

Most directories tell you what exists *today*. aiagent.club records the **time dimension**: which projects are accelerating, which are quietly dying, and how platform pricing evolves — the things you can only see by measuring the same things every day.

**Live:** [aiagent.club](https://aiagent.club) · [中文](https://aiagent.club/zh/)

## What it tracks

- **Agent frameworks & tools** — signals from GitHub, npm, PyPI, Hugging Face, ModelScope, VS Code Marketplace
- **MCP server ecosystem** — health, activity, maintenance status
- **Model & agent usage trends**
- **Platform pricing history** — changes over time, not just current prices
- Both the **global** and **中国 (cn)** ecosystems

## How it works

- Collectors run twice daily (GitHub Actions), pull **public** metrics into an append-only SQLite time series on private R2.
- Rankings **cross-validate multiple signals** (star growth + commit cadence + downloads / installs / token usage) so no single gameable metric can dominate.
- Published as a **static site** — dual deploy to Cloudflare Pages (global) + 阿里云 CDN (China, ICP-filed). No visitor tracking.
- A source marked `partial` in the heartbeat means some listed packages were missing or rate-limited that run; rows that did write are kept and retried next time (not a hard failure).

## Methodology

Rankings are only as trustworthy as their method, so the method is public: see [/methodology](https://aiagent.club/methodology) (and [/zh/methodology](https://aiagent.club/zh/methodology)). Collectors that produce the data are open source in this repository.

## Tech

Astro (SSG) · SQLite · GitHub Actions · dual deploy — Cloudflare Pages + 阿里云 OSS/CDN.

## Local ops

```bash
cp .env.example .env   # fill R2 / GitHub / optional OpenRouter + HF_TOKEN
npm test
node --env-file=.env src/r2.mjs pull data.db data.db
node --env-file=.env src/run.mjs              # collect
HTTPS_PROXY=http://127.0.0.1:7890 node --env-file=.env src/enrich.mjs huggingface  # if HF is blocked locally
```

`fetchRetry` honors `HTTPS_PROXY` / `HTTP_PROXY` (HTTP CONNECT). R2 pull/push stays direct — large DB uploads through a local proxy are unreliable. Gated Hugging Face model cards need `HF_TOKEN` plus per-model “Agree and access” (Meta Llama approvals can stay pending for days).

## License

TBD.

---

## 中文简介

**aiagent.club —— AI agent 生态的时序数据站。**

站点已上线:[aiagent.club](https://aiagent.club) · [中文站](https://aiagent.club/zh/)

大多数目录只告诉你"现在有什么"。aiagent.club 记录的是**时间维度**:哪些 agent 框架 / MCP server / 模型在加速、哪些在悄悄衰亡、各家平台的定价怎么变——这些只有每天持续测量同一批对象才看得出来,同时覆盖**海外**与**国内**两个生态。

榜单的可信度取决于方法,所以方法公开(见[方法论](https://aiagent.club/zh/methodology)):多指标交叉验证,抓取器在本仓库开源。心跳里某源标 `partial` 表示该轮有个别包缺失或限速,已写入的数据会保留、下次再补——不是整源失败。
