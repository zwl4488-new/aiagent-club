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
