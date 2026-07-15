// 魔搭 ModelScope 源 —— 国内模型真实下载量(kind=modelscope, ecosystem=cn)。
//
// 国内"真实使用量"的救命源:平台侧调用量公开拿不到,但 ModelScope 的模型分发下载量是公开的。
// 单模型详情端点 GET /api/v1/models/<org>/<name> 返回 Downloads(累计)+ Stars。
// 非官方前端接口:字段做容错,缺字段 gate 掉而非整批失败。温和请求(加间隔)。

import { fetchRetry, sleep } from './client.mjs'

export const SOURCE = 'modelscope'
export const MS_API = 'https://modelscope.cn/api/v1/models'
const UA = 'aiagent-club'
const GAP_MS = 300

/**
 * 从详情响应摊平出指标。魔搭字段首字母大写(Downloads/Stars),做大小写容错。
 * @param {any} json
 * @returns {{ downloads: number|null, stars: number|null, name: string|null }}
 */
export function parseModelScope(json) {
  const d = json?.Data ?? json?.data ?? json ?? {}
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return {
    downloads: num(d.Downloads ?? d.downloads),
    stars: num(d.Stars ?? d.stars),
    name: d.Name ?? d.name ?? null,
  }
}

/**
 * 取单模型下载量/star;不存在(404)返回 null。
 * @param {string} id  org/name
 * @returns {Promise<{ downloads: number|null, stars: number|null, name: string|null } | null>}
 */
export async function fetchModelScope(id) {
  const res = await fetchRetry(`${MS_API}/${id}`, { notFoundOk: true, headers: { 'user-agent': UA } })
  if (res.status === 404) return null
  return parseModelScope(await res.json())
}

/**
 * 采集全部模型的下载量/star。
 * @param {{ models: string[], capturedAt: string, writer: any, log?: (m:string)=>void }} p
 * @returns {Promise<{ metricsWritten: number, entitiesSeen: number, missing: string[] }>}
 */
export async function collectModelScope({ models, capturedAt, writer, log = () => {} }) {
  let metricsWritten = 0
  let entitiesSeen = 0
  /** @type {string[]} */
  const missing = []
  let first = true
  for (const id of models) {
    if (!first) await sleep(GAP_MS)
    first = false
    const m = await fetchModelScope(id)
    if (!m || (m.downloads == null && m.stars == null)) {
      missing.push(id)
      continue
    }
    const entity_id = `${SOURCE}:${id}`
    writer.upsertEntity({
      entity_id,
      kind: 'modelscope',
      ecosystem: 'cn',
      name: m.name || id,
      url: `https://modelscope.cn/models/${id}`,
      category: String(id).split('/')[0], // 组织:Qwen / deepseek-ai / ZhipuAI ...
      last_seen: capturedAt,
      active: 1,
    })
    entitiesSeen++
    if (m.downloads != null) {
      writer.upsertMetric({ entity_id, metric: 'ms_downloads', value: m.downloads, captured_at: capturedAt, source: SOURCE })
      metricsWritten++
    }
    if (m.stars != null) {
      writer.upsertMetric({ entity_id, metric: 'ms_stars', value: m.stars, captured_at: capturedAt, source: SOURCE })
      metricsWritten++
    }
  }
  if (missing.length) log(`modelscope missing (改名/404?): ${missing.join(', ')}`)
  return { metricsWritten, entitiesSeen, missing }
}
