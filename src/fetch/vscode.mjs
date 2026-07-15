// VS Code Marketplace 源 —— 编码类 agent/助手的安装量(kind=vscode, ecosystem=global)。
//
// 编码 agent(Cline/Continue/Roo/Copilot…)的真实采用量,GitHub star 无法替代。
// extensionquery POST 端点,flags 914 带上 statistics(install/updateCount/rating)。
// 含国产(通义灵码/CodeGeeX),顺带覆盖国内编码助手。

import { fetchRetry, sleep } from './client.mjs'

export const SOURCE = 'vscode'
export const MS_QUERY = 'https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery'
const UA = 'aiagent-club'
const GAP_MS = 250

/**
 * 查单个扩展(publisher.name),返回 { name, installs, rating } 或 null(不存在)。
 * @param {string} id  publisher.extension
 * @returns {Promise<{ name: string, installs: number|null, rating: number|null } | null>}
 */
export async function fetchVscodeExtension(id) {
  const body = {
    filters: [{ criteria: [{ filterType: 7, value: id }], pageNumber: 1, pageSize: 1 }],
    flags: 914, // 包含 statistics
  }
  const res = await fetchRetry(MS_QUERY, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json;api-version=3.0-preview.1', 'user-agent': UA },
    body: JSON.stringify(body),
  })
  const json = await res.json()
  const ext = json?.results?.[0]?.extensions?.[0]
  if (!ext) return null
  const stats = Object.fromEntries((ext.statistics || []).map((s) => [s.statisticName, s.value]))
  const installs = typeof stats.install === 'number' ? stats.install : null
  const rating = typeof stats.averagerating === 'number' ? stats.averagerating : null
  return { name: ext.displayName || id, installs, rating }
}

/**
 * 采集全部扩展的安装量。
 * @param {{ extensions: string[], capturedAt: string, writer: any, log?: (m:string)=>void }} p
 * @returns {Promise<{ metricsWritten: number, entitiesSeen: number, missing: string[] }>}
 */
export async function collectVscode({ extensions, capturedAt, writer, log = () => {} }) {
  let metricsWritten = 0
  let entitiesSeen = 0
  /** @type {string[]} */
  const missing = []
  let first = true
  for (const id of extensions) {
    if (!first) await sleep(GAP_MS)
    first = false
    let ext
    try {
      ext = await fetchVscodeExtension(id)
    } catch {
      ext = null
    }
    if (!ext || ext.installs == null) {
      missing.push(id)
      continue
    }
    const entity_id = `${SOURCE}:${id}`
    writer.upsertEntity({
      entity_id,
      kind: 'vscode',
      ecosystem: 'global',
      name: ext.name,
      url: `https://marketplace.visualstudio.com/items?itemName=${id}`,
      category: String(id).split('.')[0], // 发布者:saoudrizwan / Continue / RooVeterinaryInc ...
      last_seen: capturedAt,
      active: 1,
    })
    entitiesSeen++
    writer.upsertMetric({ entity_id, metric: 'vscode_installs', value: ext.installs, captured_at: capturedAt, source: SOURCE })
    metricsWritten++
    if (ext.rating != null) {
      writer.upsertMetric({ entity_id, metric: 'vscode_rating', value: ext.rating, captured_at: capturedAt, source: SOURCE })
      metricsWritten++
    }
  }
  if (missing.length) log(`vscode missing (改名/404?): ${missing.join(', ')}`)
  return { metricsWritten, entitiesSeen, missing }
}
