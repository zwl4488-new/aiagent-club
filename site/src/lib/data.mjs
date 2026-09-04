// 站点数据访问层(构建期)。读 data.db → 出榜单与时序。
//
// 与采集器同一纪律:shell 到 sqlite3 CLI(node 20 无 node:sqlite),只读查询。
// 构建只发生在一个计算环境(CI Actions):先从 R2 pull data.db,再 astro build 读它。
// 本层只 SELECT,绝不写 —— 站点是纯读端。

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// 默认取仓库根的 data.db;CI/本地可用 DB_PATH 覆盖。
const DEFAULT_DB = fileURLToPath(new URL('../../../data.db', import.meta.url))
const DB_PATH = process.env.DB_PATH || DEFAULT_DB

/**
 * 只读查询,返回行对象数组。
 * @param {string} sql
 * @returns {Promise<any[]>}
 */
function query(sql) {
  return new Promise((resolve, reject) => {
    const p = spawn('sqlite3', ['-json', '-readonly', DB_PATH], { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('error', reject)
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`sqlite3 exit ${code}: ${err.trim()}`))
      const t = out.trim()
      resolve(t ? JSON.parse(t) : [])
    })
    p.stdin.end(sql)
  })
}

/**
 * 最新"完整快照"日期。用 downloads_week 当信号:它只由每日采集器写、回填从不写,
 * 故 max(captured_at where metric='downloads_week') = 最近一次完整日常采集,
 * 不会被回填按事件日期写的零星行(如今天某 repo 有新 star)带偏。
 */
export async function latestSnapshot() {
  const [r] = await query(`SELECT max(captured_at) d FROM metrics WHERE metric = 'downloads_week'`)
  if (r?.d) return r.d
  const [f] = await query(`SELECT max(captured_at) d FROM metrics`)
  return f?.d ?? null
}

/**
 * 指数评分参考日：取三个评分维度的最新观测日。
 * 不只依赖 npm 快照；任一评分源继续更新时，其他源的旧值会按 SLA 自然过期。
 */
export async function latestIndexSnapshot() {
  const [metricRow] = await query(`
    SELECT max(captured_at) d FROM metrics
    WHERE metric IN ('stars','downloads_week','downloads_month')
  `)
  if (!metricRow?.d || !(await hasTable('fetch_runs'))) return metricRow?.d ?? null

  // 回填也会写 stars，不能让一条新回填把整站的评分快照推进、进而误判其他来源全部过期。
  // 日常采集才写 fetch_runs；取“评分指标最新日”和“成功/部分成功的评分采集最新日”中较早者。
  const [runRow] = await query(`
    SELECT max(substr(coalesce(finished_at, started_at), 1, 10)) d
    FROM fetch_runs
    WHERE source IN ('github','npm','pypi') AND status IN ('ok','partial')
  `)
  return runRow?.d ? [metricRow.d, runRow.d].sort()[0] : metricRow.d
}

/** 数据整体概况(用于首页头部)。 */
export async function overview() {
  const [ent] = await query(`SELECT count(*) n FROM entities`)
  const [met] = await query(`SELECT count(*) n FROM metrics`)
  const [days] = await query(`SELECT count(DISTINCT captured_at) n FROM metrics`)
  return { entities: ent?.n ?? 0, metrics: met?.n ?? 0, days: days?.n ?? 0, latest: await latestSnapshot() }
}

/**
 * 某 kind 下所有实体在最新快照的指标,按 primaryMetric 降序。
 * @param {string} kind             github | npm | pypi
 * @param {string} primaryMetric    排序依据,如 stars / downloads_week / downloads_month
 * @param {string[]} metrics        要一并取出的指标列
 * @returns {Promise<Array<{ entity_id: string, name: string, url: string, values: Record<string, number> }>>}
 */
export async function ranking(kind, primaryMetric, metrics) {
  const wantCols = [primaryMetric, ...metrics.filter((m) => m !== primaryMetric)]
  const inList = wantCols.map((c) => `'${c}'`).join(',')
  // 取每个项目每个指标"各自的最新值",而非依赖全局同一个快照日期。
  // 回填按事件日期写行(某天有 star/fork 就多一行),全局 max(captured_at) 会落在只有零星
  // 回填行的日期上,导致榜单看起来"缺项目/整源为空"。按 entity+metric 各取其 max 才稳。
  const rows = await query(`
    SELECT m.entity_id, e.name, e.url, m.metric, m.value
    FROM metrics m
    JOIN entities e ON e.entity_id = m.entity_id
    WHERE e.kind = '${kind}' AND m.metric IN (${inList})
      AND m.captured_at = (
        SELECT max(m2.captured_at) FROM metrics m2
        WHERE m2.entity_id = m.entity_id AND m2.metric = m.metric
      )
  `)
  /** @type {Map<string, any>} */
  const byEntity = new Map()
  for (const r of rows) {
    if (!byEntity.has(r.entity_id)) {
      byEntity.set(r.entity_id, { entity_id: r.entity_id, name: r.name, url: r.url, values: {} })
    }
    byEntity.get(r.entity_id).values[r.metric] = r.value
  }
  return [...byEntity.values()].sort((a, b) => (b.values[primaryMetric] ?? 0) - (a.values[primaryMetric] ?? 0))
}

/**
 * 某实体某指标的完整时序(升序),给 sparkline 用。
 * @param {string} entityId
 * @param {string} metric
 * @returns {Promise<Array<{ captured_at: string, value: number }>>}
 */
export async function series(entityId, metric) {
  // entityId 来自库内已有值,拼串安全;仍用引号包裹。
  const safe = entityId.replace(/'/g, "''")
  return query(`
    SELECT captured_at, value FROM metrics
    WHERE entity_id = '${safe}' AND metric = '${metric}'
    ORDER BY captured_at ASC
  `)
}

/**
 * 一次查出某 kind 下所有实体某指标的时序,返回 entity_id → 时序数组。
 * 避免 N+1(每实体一次 sqlite 子进程),把整页 sparkline 查询压成一次。
 * @param {string} kind
 * @param {string} metric
 * @returns {Promise<Map<string, Array<{ captured_at: string, value: number }>>>}
 */
export async function seriesByKind(kind, metric) {
  const rows = await query(`
    SELECT m.entity_id, m.captured_at, m.value
    FROM metrics m JOIN entities e ON e.entity_id = m.entity_id
    WHERE e.kind = '${kind}' AND m.metric = '${metric}'
    ORDER BY m.entity_id, m.captured_at ASC
  `)
  /** @type {Map<string, Array<{ captured_at: string, value: number }>>} */
  const map = new Map()
  for (const r of rows) {
    if (!map.has(r.entity_id)) map.set(r.entity_id, [])
    map.get(r.entity_id).push({ captured_at: r.captured_at, value: r.value })
  }
  return map
}

/**
 * 某指标下每个实体的"最新值",返回 entity_id → value。一次查询(相关子查询取各自 max 日期)。
 * @param {string} metric
 * @returns {Promise<Map<string, number>>}
 */
export async function latestMap(metric) {
  const rows = await query(`
    SELECT m.entity_id, m.value
    FROM metrics m
    WHERE m.metric = '${metric}'
      AND m.captured_at = (SELECT max(captured_at) FROM metrics m2 WHERE m2.entity_id = m.entity_id AND m2.metric = '${metric}')
  `)
  return new Map(rows.map((r) => [r.entity_id, r.value]))
}

/** 某表是否有某列(构建期防御:旧 data.db 可能还没迁移出 description 列)。 */
async function hasColumn(table, column) {
  const cols = await query(`PRAGMA table_info(${table})`)
  return cols.some((c) => c.name === column)
}

/** 某表是否存在（兼容本地旧数据库）。 */
async function hasTable(table) {
  const safe = table.replace(/'/g, "''")
  const [row] = await query(`SELECT count(*) n FROM sqlite_master WHERE type = 'table' AND name = '${safe}'`)
  return (row?.n ?? 0) > 0
}

/** 全部实体(用于逐项目 SEO 详情页 getStaticPaths)。 */
export async function allEntities() {
  const desc = (await hasColumn('entities', 'description')) ? 'description' : `NULL AS description`
  const intro = (await hasColumn('entities', 'intro')) ? 'intro' : `NULL AS intro`
  const pkey = (await hasColumn('entities', 'project_key')) ? 'project_key' : `NULL AS project_key`
  const active = (await hasColumn('entities', 'active')) ? 'WHERE coalesce(active, 1) != 0' : ''
  return query(`SELECT entity_id, kind, name, url, category, ${desc}, ${intro}, ${pkey}, first_seen FROM entities ${active} ORDER BY kind, name`)
}

/**
 * 每个实体每个指标的"最新值 + 日期",一次查询。返回 entity_id → { metric: {value, captured_at} }。
 * 详情页要展示某实体全部指标,故不限 metric。
 * @returns {Promise<Map<string, Record<string, {value:number, captured_at:string}>>>}
 */
export async function latestMetricsAll() {
  const rows = await query(`
    SELECT m.entity_id, m.metric, m.value, m.captured_at
    FROM metrics m
    WHERE m.captured_at = (
      SELECT max(captured_at) FROM metrics m2 WHERE m2.entity_id = m.entity_id AND m2.metric = m.metric
    )
  `)
  /** @type {Map<string, Record<string, {value:number, captured_at:string}>>} */
  const map = new Map()
  for (const r of rows) {
    if (!map.has(r.entity_id)) map.set(r.entity_id, {})
    map.get(r.entity_id)[r.metric] = { value: r.value, captured_at: r.captured_at }
  }
  return map
}

/**
 * 公开数据健康页所需的可验证汇总：每类实体/观测量/最新日期，以及每个采集器最近一次运行。
 * 仅返回聚合信息，不暴露私有逐日历史。
 */
export async function dataHealth() {
  const sources = await query(`
    SELECT e.kind,
           count(DISTINCT e.entity_id) AS entities,
           count(m.metric) AS observations,
           max(m.captured_at) AS latest
    FROM entities e
    LEFT JOIN metrics m ON m.entity_id = e.entity_id
    GROUP BY e.kind
    ORDER BY e.kind
  `)
  let runs = []
  if (await hasTable('fetch_runs')) {
    runs = await query(`
      SELECT source, environment, status, rows_written, error, started_at, finished_at
      FROM (
        SELECT *, row_number() OVER (PARTITION BY source ORDER BY coalesce(finished_at, started_at) DESC) AS rn
        FROM fetch_runs
      )
      WHERE rn = 1
      ORDER BY source
    `)
  }
  return { sources, runs }
}

/**
 * 模型定价景观(OpenRouter):每个模型最新的输入/输出单价、上下文、日 token 用量。
 * 取价格有效(price_prompt_mtok>0)的模型 —— 过滤掉价格哨兵值(<0)与免费档(=0);
 * 日用量(or_tokens_day)作为附带信号一并带出(有则显示)。按输入单价升序(最便宜在前)。
 * 只保留 top-usage 覆盖不到但仍付费的主流模型景观,返回可直接喂给 RankTable 的行。
 * @returns {Promise<Array<{ entity_id, name, url, values: Record<string, number> }>>}
 */
export async function modelPricing() {
  const rows = await query(`
    SELECT m.entity_id, m.metric, m.value
    FROM metrics m JOIN entities e ON e.entity_id = m.entity_id
    WHERE e.kind = 'openrouter'
      AND m.metric IN ('price_prompt_mtok','price_completion_mtok','context_length','or_tokens_day')
      AND m.captured_at = (SELECT max(captured_at) FROM metrics m2 WHERE m2.entity_id = m.entity_id AND m2.metric = m.metric)
  `)
  const by = new Map()
  for (const r of rows) {
    if (!by.has(r.entity_id)) by.set(r.entity_id, {})
    by.get(r.entity_id)[r.metric] = r.value
  }
  const ents = await query(`SELECT entity_id, name, url FROM entities WHERE kind = 'openrouter'`)
  const meta = new Map(ents.map((e) => [e.entity_id, e]))
  const out = []
  for (const [id, v] of by) {
    if (!(v.price_prompt_mtok > 0)) continue // 价格有效即可;用量作为附带信号(可缺)
    const m = meta.get(id) || {}
    out.push({ entity_id: id, name: m.name || id, url: m.url, values: v })
  }
  return out.sort((a, b) => a.values.price_prompt_mtok - b.values.price_prompt_mtok)
}

/** ISO 日期减 n 天。 */
function minusDays(isoDay, n) {
  const d = new Date(isoDay + 'T00:00:00Z')
  return new Date(d.getTime() - n * 86400000).toISOString().slice(0, 10)
}

/**
 * 动量 / 异动:某 kind 某(累计型)指标在 trailing 窗口内的增量。
 * 对每个实体取"最新值"与"窗口前那天的值"(≤ cutoff 的最后一个点),算 delta 与 %。
 * 只用于累计型指标(stars/forks/commits/releases/downloads_month 等单调或近似单调的量)。
 * @param {string} kind
 * @param {string} metric
 * @param {number} windowDays
 * @returns {Promise<Array<{ entity_id, name, url, latest, prev, delta, pct, spark }>>}
 */
export async function movers(kind, metric, windowDays) {
  const seriesMap = await seriesByKind(kind, metric)
  const ents = await query(`SELECT entity_id, name, url FROM entities WHERE kind = '${kind}'`)
  const meta = new Map(ents.map((e) => [e.entity_id, e]))
  const out = []
  for (const [id, s] of seriesMap) {
    if (s.length < 2) continue
    const last = s[s.length - 1]
    const cutoff = minusDays(last.captured_at, windowDays)
    // 窗口前的基准:captured_at ≤ cutoff 的最后一个点(没有则跳过,历史不足)。
    let prev = null
    for (let i = s.length - 1; i >= 0; i--) {
      if (s[i].captured_at <= cutoff) { prev = s[i]; break }
    }
    if (!prev || prev.captured_at === last.captured_at) continue
    // “7 日动量”只接受 7–10 日的基准间隔；不把中间断采数月的增量冒充短窗口增长。
    const baselineDays = Math.round((new Date(`${last.captured_at}T00:00:00Z`) - new Date(`${prev.captured_at}T00:00:00Z`)) / 86_400_000)
    if (baselineDays > windowDays + 3) continue
    const delta = last.value - prev.value
    const pct = prev.value ? delta / prev.value : null
    const m = meta.get(id) || {}
    out.push({
      entity_id: id,
      name: m.name || id,
      url: m.url,
      latest: last.value,
      prev: prev.value,
      delta,
      pct,
      observed_at: last.captured_at,
      baseline_at: prev.captured_at,
      spark: s,
    })
  }
  return out
}
