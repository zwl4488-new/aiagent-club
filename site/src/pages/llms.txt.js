// /llms.txt —— 面向 AI 爬虫/助手的站点说明(llms.txt 约定:markdown,H1 + 摘要 + 分节链接)。
// 构建期生成,附当前各源 top 项目,让模型直接拿到"当下什么在被用"。
import { ranking } from '../lib/data.mjs'

const SITE = 'https://www.aiagent.club'
const slug = (entityId) => entityId.replace(':', '/')

export async function GET() {
  const [gh, npm, pypi, models] = await Promise.all([
    ranking('github', 'stars', ['stars']),
    ranking('npm', 'downloads_week', ['downloads_week']),
    ranking('pypi', 'downloads_month', ['downloads_month']),
    ranking('openrouter', 'or_tokens_day', ['or_tokens_day']),
  ])

  const list = (rows, metric, unit, n) =>
    rows
      .slice(0, n)
      .map((r) => `- [${r.name}](${SITE}/p/${slug(r.entity_id)}) — ${Math.round(r.values[metric] ?? 0).toLocaleString('en-US')} ${unit}`)
      .join('\n')

  const body = `# aiagent.club

> A daily time-series instrument for the AI agent ecosystem. It tracks how agent frameworks, MCP servers, packages, and models grow over time — holding attention signals (GitHub stars) next to harder-to-fake real-usage signals (package downloads, model tokens, installs), across both global and Chinese sources.

## About
- Purpose: separate hype from real usage, and surface momentum (what is gaining now), rather than a single static leaderboard.
- Method: public metrics snapshotted twice daily, append-only history, cross-validated across independent signals, with star-farm detection and canonical de-duplication. See the methodology page.
- Data shown in source language; rankings and trends public, full daily history private; collectors open source.

## Key pages
- [Rankings](${SITE}/) — hype-vs-usage, weekly movers, and per-source leaderboards
- [Changelog](${SITE}/changes) — structured events: milestones crossed, releases shipped, usage surges
- [Methodology](${SITE}/methodology) — what is measured, how, and how gaming is resisted
- [Browse all projects](${SITE}/browse) — full directory, each with a detail page and trend

## Top agent frameworks & tools (GitHub, by stars)
${list(gh, 'stars', 'stars', 20)}

## Most-used npm packages (weekly downloads)
${list(npm, 'downloads_week', 'downloads/week', 12)}

## Most-used PyPI packages (monthly downloads)
${list(pypi, 'downloads_month', 'downloads/month', 12)}

## Models by real usage (OpenRouter tokens/day)
${list(models, 'or_tokens_day', 'tokens/day', 12)}
`

  return new Response(body, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } })
}
