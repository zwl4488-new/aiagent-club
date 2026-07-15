// PyPI 源 — 下载量(阶段 1)。公开 API,无需 token。
//
// PyPI 官方 JSON(/pypi/<pkg>/json)不含下载量,业界标准是 pypistats.org 的 recent 端点,
// 一次响应给 last_day / last_week / last_month 三个窗口——一个请求拿三个指标。
// pypistats 是志愿者服务,请温和使用:逐包顺序请求,不并发轰炸。

import { fetchRetry, sleep } from './client.mjs'

export const SOURCE = 'pypi'
export const PYPISTATS_API = 'https://pypistats.org/api/packages'
export const PYPI_JSON_API = 'https://pypi.org/pypi'
// 包间隔:pypistats 是志愿者服务,包多时连打会 429。逐包之间歇一下(规模化后加大)。
const GAP_MS = 600
const DESC_CONCURRENCY = 6 // pypi.org JSON 与 pypistats 不同源,可小并发取简介
// 限速 fail-fast:少重试短退避,持续 429 的包快速记 missing(下次补),不 30s 卡死一个包。
const RECENT_OPTS = { notFoundOk: true, retries: 3, baseDelayMs: 600, headers: { 'user-agent': 'aiagent-club' } }
const DESC_OPTS = { notFoundOk: true, retries: 2, baseDelayMs: 400, headers: { 'user-agent': 'aiagent-club' } }

/**
 * 有界并发跑 worker(简单池);任一失败不影响其它。
 * @template T
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T) => Promise<void>} worker
 */
async function pool(items, concurrency, worker) {
  let i = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const item = items[i++]
      try {
        await worker(item)
      } catch {
        /* 单项失败:忽略 */
      }
    }
  })
  await Promise.all(runners)
}

/**
 * 取单包简介(PyPI 官方 JSON 的 info.summary);取不到返回 null。
 * @param {string} pkg
 * @returns {Promise<string|null>}
 */
export async function fetchPypiSummary(pkg) {
  const res = await fetchRetry(`${PYPI_JSON_API}/${encodeURIComponent(pkg)}/json`, DESC_OPTS)
  if (res.status === 404) return null
  const json = await res.json()
  const s = typeof json?.info?.summary === 'string' ? json.info.summary.trim() : ''
  return s || null
}

/**
 * 从 pypistats recent 响应摊平出三个窗口的下载指标。纯函数,便于测试。
 * @param {any} json  { data: { last_day, last_week, last_month }, package, type }
 * @returns {Record<string, number>}
 */
export function parsePypiRecent(json) {
  const d = json?.data ?? {}
  /** @type {Record<string, number>} */
  const metrics = {}
  if (typeof d.last_day === 'number') metrics.downloads_day = d.last_day
  if (typeof d.last_week === 'number') metrics.downloads_week = d.last_week
  if (typeof d.last_month === 'number') metrics.downloads_month = d.last_month
  return metrics
}

/**
 * 取单包最近下载量;包不存在(404)返回 null。
 * @param {string} pkg
 * @returns {Promise<Record<string, number> | null>}
 */
export async function fetchPypiRecent(pkg) {
  const res = await fetchRetry(`${PYPISTATS_API}/${encodeURIComponent(pkg)}/recent`, RECENT_OPTS)
  if (res.status === 404) return null
  return parsePypiRecent(await res.json())
}

/**
 * 抓全部包的下载量,写进 writer。
 * @param {object} p
 * @param {string[]} p.packages
 * @param {string} p.capturedAt
 * @param {any} p.writer
 * @param {(m: string) => void} [p.log]
 * @returns {Promise<{ metricsWritten: number, entitiesSeen: number, missing: string[] }>}
 */
export async function collectPypi({ packages, capturedAt, writer, log = () => {} }) {
  let metricsWritten = 0
  let entitiesSeen = 0
  /** @type {string[]} */
  const missing = []

  // 先取全部包简介(有界并发,容错):pypi.org JSON 与 pypistats 不同源,并发不冲突。
  // 取不到的包 desc 为 undefined,upsertEntity 走 COALESCE 保留已有简介。
  /** @type {Map<string, string>} */
  const descs = new Map()
  await pool(packages, DESC_CONCURRENCY, async (pkg) => {
    const d = await fetchPypiSummary(pkg)
    if (d) descs.set(pkg, d)
  })

  let first = true
  for (const pkg of packages) {
    if (!first) await sleep(GAP_MS) // 温和使用 pypistats,避免 429
    first = false
    let metrics
    try {
      metrics = await fetchPypiRecent(pkg)
    } catch (e) {
      missing.push(pkg) // 持续 429/网络错:跳过,下次补,不掀翻整个源
      continue
    }
    if (!metrics || Object.keys(metrics).length === 0) {
      missing.push(pkg)
      continue
    }
    const entity_id = `${SOURCE}:${pkg}`
    writer.upsertEntity({
      entity_id,
      kind: 'pypi',
      ecosystem: 'global',
      name: pkg,
      url: `https://pypi.org/project/${pkg}/`,
      description: descs.get(pkg),
      last_seen: capturedAt,
      active: 1,
    })
    entitiesSeen++
    for (const [metric, value] of Object.entries(metrics)) {
      writer.upsertMetric({ entity_id, metric, value, captured_at: capturedAt, source: SOURCE })
      metricsWritten++
    }
  }
  if (missing.length) log(`pypi 未采到 ${missing.length} 包(不存在/限速跳过,下次补):${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ' …' : ''}`)
  return { metricsWritten, entitiesSeen, missing }
}
