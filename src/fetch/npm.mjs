// npm 源 — 下载量(阶段 1)。公开 API,无需 token。
//
// 下载量是 GitHub star 之外的关键交叉验证信号:star 能刷、能囤,真实使用量刷不出来。
// 用 downloads point API 取"最近一周"下载数。
//
// 规模化后(自动发现→数百包)两条纪律:
//  1) 非 scoped 包走 bulk API(一次最多 100 个),把上百次请求压成个位数,大幅降低被限速的概率。
//     scoped 包(@scope/name)bulk 不支持,只能逐个,故并入之后单独顺序请求。
//  2) 容错:单包/单批失败(含持续 429)记为 missing 跳过,绝不掀翻整个源。一次没采到的下次补,
//     源状态是 partial(而非 error),工作流不会因此标红。

import { fetchRetry, sleep } from './client.mjs'

export const SOURCE = 'npm'
export const NPM_DOWNLOADS_API = 'https://api.npmjs.org/downloads/point'
export const NPM_REGISTRY = 'https://registry.npmjs.org'
const BULK_MAX = 100 // downloads point bulk 一次上限
const SCOPED_GAP_MS = 250 // scoped 逐包间隔,温和使用公开 API
const DESC_CONCURRENCY = 6 // registry 是 CDN,可小并发取简介
// 采集里限速要 fail-fast:少重试短退避,持续 429 的包快速记 missing(下次补),不要 30s 卡死一个包。
const DL_OPTS = { notFoundOk: true, retries: 3, baseDelayMs: 600, headers: { 'user-agent': 'aiagent-club' } }
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
        /* 单项失败:忽略,不掀翻整池 */
      }
    }
  })
  await Promise.all(runners)
}

/**
 * 取单包简介(latest 版本 manifest 的 description);取不到返回 null。
 * /latest 只返回最新版清单(含 description),负载小,scoped 也支持。
 * @param {string} pkg
 * @returns {Promise<string|null>}
 */
export async function fetchNpmDescription(pkg) {
  const res = await fetchRetry(`${NPM_REGISTRY}/${pkg}/latest`, DESC_OPTS)
  if (res.status === 404) return null
  const json = await res.json()
  const d = typeof json?.description === 'string' ? json.description.trim() : ''
  return d || null
}

/** 把数组切成定长块。 */
function chunk(arr, n) {
  const out = []
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n))
  return out
}

/**
 * 取单包某窗口下载数;包不存在(404)返回 null。scoped 包用这个。
 * @param {string} pkg     包名,可为 @scope/name
 * @param {string} [window] last-day | last-week | last-month
 * @returns {Promise<number|null>}
 */
export async function fetchNpmDownloads(pkg, window = 'last-week') {
  const res = await fetchRetry(`${NPM_DOWNLOADS_API}/${window}/${pkg}`, DL_OPTS)
  if (res.status === 404) return null
  const json = await res.json()
  // { downloads, start, end, package };不存在时也可能是 { error: "package ... not found" }
  if (json && typeof json.downloads === 'number') return json.downloads
  return null
}

/**
 * bulk 取一批(≤100)非 scoped 包的下载数,返回 name→downloads。缺失/未知的包在结果里省略。
 * @param {string[]} names   非 scoped 包名
 * @param {string} [window]
 * @returns {Promise<Map<string, number>>}
 */
export async function fetchNpmDownloadsBulk(names, window = 'last-week') {
  const res = await fetchRetry(`${NPM_DOWNLOADS_API}/${window}/${names.join(',')}`, DL_OPTS)
  const out = new Map()
  if (res.status === 404) return out
  const json = await res.json()
  // 单包返回 { downloads, ... };多包返回 { name: { downloads, ... } | null }。
  if (names.length === 1) {
    if (json && typeof json.downloads === 'number') out.set(names[0], json.downloads)
  } else {
    for (const [k, v] of Object.entries(json)) if (v && typeof v.downloads === 'number') out.set(k, v.downloads)
  }
  return out
}

/**
 * 抓全部包的周下载量,写进 writer。非 scoped 走 bulk,scoped 逐个;全程容错。
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

  // 先取全部包简介(有界并发,容错):registry 与下载量 API 不同源,并发也不冲突。
  // 取不到的包 desc 为 undefined,upsertEntity 走 COALESCE 保留已有简介,不抹旧值。
  /** @type {Map<string, string>} */
  const descs = new Map()
  await pool(packages, DESC_CONCURRENCY, async (pkg) => {
    const d = await fetchNpmDescription(pkg)
    if (d) descs.set(pkg, d)
  })

  const write = (pkg, downloads) => {
    const entity_id = `${SOURCE}:${pkg}`
    writer.upsertEntity({
      entity_id,
      kind: 'npm',
      ecosystem: 'global',
      name: pkg,
      url: `https://www.npmjs.com/package/${pkg}`,
      description: descs.get(pkg),
      last_seen: capturedAt,
      active: 1,
    })
    entitiesSeen++
    // 周下载数是滚动 7 日和(flow,非累计 stock);每天记一点,diff 看周环比。
    writer.upsertMetric({ entity_id, metric: 'downloads_week', value: downloads, captured_at: capturedAt, source: SOURCE })
    metricsWritten++
  }

  const scoped = packages.filter((p) => p.startsWith('@'))
  const plain = packages.filter((p) => !p.startsWith('@'))

  // 非 scoped:bulk。单批失败(含 429)→ 整批记 missing,下次补,不中断。
  for (const grp of chunk(plain, BULK_MAX)) {
    let map
    try {
      map = await fetchNpmDownloadsBulk(grp, 'last-week')
    } catch (e) {
      log(`npm bulk 批失败(${grp.length} 包,${e instanceof Error ? e.message : e}),整批跳过`)
      missing.push(...grp)
      continue
    }
    for (const pkg of grp) {
      const d = map.get(pkg)
      if (d == null) missing.push(pkg)
      else write(pkg, d)
    }
  }

  // scoped:逐个,容错 + 间隔。
  for (const pkg of scoped) {
    try {
      const d = await fetchNpmDownloads(pkg, 'last-week')
      if (d == null) missing.push(pkg)
      else write(pkg, d)
    } catch (e) {
      missing.push(pkg) // 持续 429/网络错:跳过,下次补
    }
    await sleep(SCOPED_GAP_MS)
  }

  if (missing.length) log(`npm 未采到 ${missing.length} 包(不存在/限速跳过,下次补):${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ' …' : ''}`)
  return { metricsWritten, entitiesSeen, missing }
}
