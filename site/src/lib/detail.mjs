// 逐项目详情页数据层 —— 把每个实体组装成一页 SEO 落地页所需的数据。
//
// 目的:几百个实体 × 中英 = 上千张静态页,每页围绕一个真实项目的指标 + 时序,内容各异、可被搜索引擎收录,
// 承接长尾搜索("<某框架> stars/下载量/趋势")。构建期一次批量取数,避免逐页 N+1。

import { allEntities, latestMetricsAll, seriesByKind } from './data.mjs'

/** 各 kind 的主指标(详情页头图 sparkline + 排名依据)。 */
export const PRIMARY = {
  github: 'stars',
  npm: 'downloads_week',
  pypi: 'downloads_month',
  openrouter: 'or_tokens_day',
  modelscope: 'ms_downloads',
  huggingface: 'hf_downloads',
  vscode: 'vscode_installs',
}

/** 详情页指标表要展示的指标(有序);缺的指标自动跳过。 */
export const SHOW_METRICS = {
  github: ['stars', 'forks', 'commits', 'releases', 'watchers', 'open_issues', 'open_prs'],
  npm: ['downloads_week'],
  pypi: ['downloads_month', 'downloads_week', 'downloads_day'],
  openrouter: ['or_tokens_day', 'price_prompt_mtok', 'price_completion_mtok', 'context_length'],
  modelscope: ['ms_downloads', 'ms_stars'],
  huggingface: ['hf_downloads', 'hf_likes'],
  vscode: ['vscode_installs', 'vscode_rating'],
}

/** entity_id 的 identifier 部分(第一个 ':' 之后)。 */
function idPart(entityId) {
  const i = entityId.indexOf(':')
  return i < 0 ? entityId : entityId.slice(i + 1)
}

/**
 * 构建全部详情页数据。返回每个实体一条:
 *   { entity_id, kind, name, url, category, first_seen, id, slug, primaryMetric, spark, metrics, rank, kindTotal }
 * slug = `<kind>/<identifier>`,直接作为 /p/[...slug] 的路径。
 */
export async function buildEntityPages() {
  const [ents, latest] = await Promise.all([allEntities(), latestMetricsAll()])

  // 每个出现过的 kind,批量取其主指标时序(seriesByKind 内部一次查询)。
  const kinds = [...new Set(ents.map((e) => e.kind))]
  /** @type {Record<string, Map<string, any[]>>} */
  const seriesMaps = {}
  await Promise.all(
    kinds.map(async (k) => {
      if (PRIMARY[k]) seriesMaps[k] = await seriesByKind(k, PRIMARY[k])
    })
  )

  const pages = ents.map((e) => {
    const pm = PRIMARY[e.kind] ?? null
    const metrics = latest.get(e.entity_id) ?? {}
    const spark = (pm && seriesMaps[e.kind]?.get(e.entity_id)) || []
    return {
      entity_id: e.entity_id,
      kind: e.kind,
      name: e.name,
      url: e.url,
      category: e.category ?? null,
      description: e.description ?? null,
      intro: e.intro ?? null,
      first_seen: e.first_seen ?? null,
      id: idPart(e.entity_id),
      slug: `${e.kind}/${idPart(e.entity_id)}`,
      primaryMetric: pm,
      primaryValue: pm ? metrics[pm]?.value ?? null : null,
      spark,
      metrics,
    }
  })

  // 同 kind 内按主指标降序排名(用于"# N / M")。
  const byKind = new Map()
  for (const p of pages) {
    if (!byKind.has(p.kind)) byKind.set(p.kind, [])
    byKind.get(p.kind).push(p)
  }
  for (const [, list] of byKind) {
    list.sort((a, b) => (b.primaryValue ?? -1) - (a.primaryValue ?? -1))
    list.forEach((p, i) => {
      p.rank = p.primaryValue == null ? null : i + 1
      p.kindTotal = list.length
    })
  }

  return pages
}
