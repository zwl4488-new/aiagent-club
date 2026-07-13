// npm 源 — 下载量(阶段 1)。公开 API,无需 token。
//
// 下载量是 GitHub star 之外的关键交叉验证信号:star 能刷、能囤,真实使用量刷不出来。
// 用 downloads point API 取"最近一周"下载数。scoped 包(@scope/name)不能 bulk 查,
// 故逐包请求(fetchRetry 负责退避);包数不多,顺序请求即可,对公开 API 也更友好。

import { fetchRetry } from './client.mjs'

export const SOURCE = 'npm'
export const NPM_DOWNLOADS_API = 'https://api.npmjs.org/downloads/point'

/**
 * 取单包某窗口下载数;包不存在(404)返回 null。
 * @param {string} pkg     包名,可为 @scope/name
 * @param {string} [window] last-day | last-week | last-month
 * @returns {Promise<number|null>}
 */
export async function fetchNpmDownloads(pkg, window = 'last-week') {
  const res = await fetchRetry(`${NPM_DOWNLOADS_API}/${window}/${pkg}`, {
    notFoundOk: true,
    headers: { 'user-agent': 'aiagent-club' },
  })
  if (res.status === 404) return null
  const json = await res.json()
  // { downloads, start, end, package };不存在时也可能是 { error: "package ... not found" }
  if (json && typeof json.downloads === 'number') return json.downloads
  return null
}

/**
 * 抓全部包的周下载量,写进 writer。
 * @param {object} p
 * @param {string[]} p.packages
 * @param {string} p.capturedAt
 * @param {any} p.writer
 * @param {(m: string) => void} [p.log]
 * @returns {Promise<{ metricsWritten: number, entitiesSeen: number, missing: string[] }>}
 */
export async function collectNpm({ packages, capturedAt, writer, log = () => {} }) {
  let metricsWritten = 0
  let entitiesSeen = 0
  /** @type {string[]} */
  const missing = []

  for (const pkg of packages) {
    const downloads = await fetchNpmDownloads(pkg, 'last-week')
    if (downloads === null) {
      missing.push(pkg)
      continue
    }
    const entity_id = `${SOURCE}:${pkg}`
    writer.upsertEntity({
      entity_id,
      kind: 'npm',
      ecosystem: 'global',
      name: pkg,
      url: `https://www.npmjs.com/package/${pkg}`,
      last_seen: capturedAt,
      active: 1,
    })
    entitiesSeen++
    // 周下载数是滚动 7 日和(flow,非累计 stock);每天记一点,diff 看周环比。
    writer.upsertMetric({ entity_id, metric: 'downloads_week', value: downloads, captured_at: capturedAt, source: SOURCE })
    metricsWritten++
  }
  if (missing.length) log(`npm missing packages (名字错/未发布?): ${missing.join(', ')}`)
  return { metricsWritten, entitiesSeen, missing }
}
