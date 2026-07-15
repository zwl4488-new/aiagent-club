// PyPI 源 — 下载量(阶段 1)。公开 API,无需 token。
//
// PyPI 官方 JSON(/pypi/<pkg>/json)不含下载量,业界标准是 pypistats.org 的 recent 端点,
// 一次响应给 last_day / last_week / last_month 三个窗口——一个请求拿三个指标。
// pypistats 是志愿者服务,请温和使用:逐包顺序请求,不并发轰炸。

import { fetchRetry, sleep } from './client.mjs'

export const SOURCE = 'pypi'
export const PYPISTATS_API = 'https://pypistats.org/api/packages'
// 包间隔:pypistats 是志愿者服务,包多时连打会 429。逐包之间歇一下(规模化后加大)。
const GAP_MS = 600
// 限速 fail-fast:少重试短退避,持续 429 的包快速记 missing(下次补),不 30s 卡死一个包。
const RECENT_OPTS = { notFoundOk: true, retries: 3, baseDelayMs: 600, headers: { 'user-agent': 'aiagent-club' } }

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
