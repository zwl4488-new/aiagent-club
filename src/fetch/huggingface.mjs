// HuggingFace 源 —— 开源模型的真实使用量(kind=huggingface, ecosystem=global)。
//
// 补齐"模型用量"的第三条腿:闭源托管调用走 OpenRouter(token/日),国产走 ModelScope(下载量),
// 全球开源模型的真实拉取量走这里。HF 公开 API 干净、无需 token:
//   GET https://huggingface.co/api/models/<org>/<name> → { id, downloads(近30天), likes, ... }
// downloads 是近 30 天滚动量(flow,像 npm 周下载);likes 是累计。字段做容错,缺则 gate 掉。

import { fetchRetry, sleep } from './client.mjs'

export const SOURCE = 'huggingface'
export const HF_API = 'https://huggingface.co/api/models'
const UA = 'aiagent-club'
const GAP_MS = 200

/**
 * 从 HF 模型详情摊平出指标。纯函数,便于单测。
 * @param {any} json  { id, downloads, likes, ... }
 * @returns {{ downloads: number|null, likes: number|null, name: string|null }}
 */
export function parseHuggingFace(json) {
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
  return {
    downloads: num(json?.downloads),
    likes: num(json?.likes),
    name: typeof json?.id === 'string' ? json.id : null,
  }
}

/**
 * 取单模型近30天下载量/likes;不存在(404)返回 null。
 * @param {string} id  org/name
 * @returns {Promise<{ downloads: number|null, likes: number|null, name: string|null } | null>}
 */
export async function fetchHuggingFace(id) {
  const res = await fetchRetry(`${HF_API}/${id}`, { notFoundOk: true, headers: { 'user-agent': UA } })
  if (res.status === 404) return null
  return parseHuggingFace(await res.json())
}

/**
 * 采集全部模型的下载量/likes。逐个请求 + 间隔,容错(单模型失败记 missing 跳过)。
 * @param {{ models: string[], capturedAt: string, writer: any, log?: (m:string)=>void }} p
 * @returns {Promise<{ metricsWritten: number, entitiesSeen: number, missing: string[] }>}
 */
export async function collectHuggingFace({ models, capturedAt, writer, log = () => {} }) {
  let metricsWritten = 0
  let entitiesSeen = 0
  /** @type {string[]} */
  const missing = []
  let first = true
  for (const id of models) {
    if (!first) await sleep(GAP_MS)
    first = false
    let m
    try {
      m = await fetchHuggingFace(id)
    } catch (e) {
      missing.push(id) // 限速/网络错:跳过,下次补,不掀翻整源
      continue
    }
    if (!m || (m.downloads == null && m.likes == null)) {
      missing.push(id)
      continue
    }
    const entity_id = `${SOURCE}:${id}`
    writer.upsertEntity({
      entity_id,
      kind: 'huggingface',
      ecosystem: 'global',
      name: m.name || id,
      url: `https://huggingface.co/${id}`,
      category: String(id).split('/')[0], // 组织:meta-llama / Qwen / mistralai ...
      last_seen: capturedAt,
      active: 1,
    })
    entitiesSeen++
    if (m.downloads != null) {
      writer.upsertMetric({ entity_id, metric: 'hf_downloads', value: m.downloads, captured_at: capturedAt, source: SOURCE })
      metricsWritten++
    }
    if (m.likes != null) {
      writer.upsertMetric({ entity_id, metric: 'hf_likes', value: m.likes, captured_at: capturedAt, source: SOURCE })
      metricsWritten++
    }
  }
  if (missing.length) log(`huggingface missing (改名/404/限速?): ${missing.join(', ')}`)
  return { metricsWritten, entitiesSeen, missing }
}
