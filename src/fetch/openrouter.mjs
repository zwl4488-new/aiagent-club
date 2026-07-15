// OpenRouter 源 —— 模型定价(公开 API,无需 key)+ 每日 token 用量(需免费 key)。
//
// /models 一个端点吐全部模型(实测 344 个,含 DeepSeek/Qwen/GLM/Kimi 等国产 + GPT/Claude/Gemini),
// 自带逐 token 定价 → 一次覆盖海内外"模型"这一类,且天然是"发现 + 采集"合一,无需维护清单。
// 定价时序是护城河之一:今天不采,历史就永久缺一天。
//
// 每日 token 用量排行(rankings-daily)是全球唯一公开的"模型真实使用量"信号,但需要免费 key
// (OPENROUTER_API_KEY);无 key 时该部分自动跳过,拿到 key 即生效。

import { getJson, fetchRetry } from './client.mjs'

export const SOURCE = 'openrouter'
const MODELS_API = 'https://openrouter.ai/api/v1/models'
const RANKINGS_API = 'https://openrouter.ai/api/v1/datasets/rankings-daily'
const UA = 'aiagent-club'

/**
 * 采集全部模型的定价 + 元信息。价格转成 $/1M token 便于阅读。
 * @param {{ capturedAt: string, writer: any, log?: (m:string)=>void }} p
 * @returns {Promise<{ metricsWritten: number, entitiesSeen: number, missing: string[] }>}
 */
export async function collectOpenRouterModels({ capturedAt, writer, log = () => {} }) {
  const json = await getJson(MODELS_API, { headers: { 'user-agent': UA } })
  const models = Array.isArray(json?.data) ? json.data : []
  let metricsWritten = 0
  let entitiesSeen = 0
  for (const m of models) {
    if (!m?.id) continue
    const entity_id = `${SOURCE}:${m.id}`
    const provider = String(m.id).split('/')[0]
    writer.upsertEntity({
      entity_id,
      kind: 'openrouter',
      ecosystem: 'global',
      name: m.name || m.id,
      url: `https://openrouter.ai/${m.id}`,
      category: provider, // 厂商:openai / anthropic / deepseek / qwen / google ...
      last_seen: capturedAt,
      active: 1,
    })
    entitiesSeen++
    const prompt = Number(m.pricing?.prompt)
    const completion = Number(m.pricing?.completion)
    const ctx = Number(m.context_length)
    // 价格为 0(纯免费变体)也是有效信息,但 0 常是占位;只写有限值。
    if (Number.isFinite(prompt)) {
      writer.upsertMetric({ entity_id, metric: 'price_prompt_mtok', value: prompt * 1e6, captured_at: capturedAt, source: SOURCE })
      metricsWritten++
    }
    if (Number.isFinite(completion)) {
      writer.upsertMetric({ entity_id, metric: 'price_completion_mtok', value: completion * 1e6, captured_at: capturedAt, source: SOURCE })
      metricsWritten++
    }
    if (Number.isFinite(ctx) && ctx > 0) {
      writer.upsertMetric({ entity_id, metric: 'context_length', value: ctx, captured_at: capturedAt, source: SOURCE })
      metricsWritten++
    }
  }
  log(`openrouter models: ${entitiesSeen} 个模型,${metricsWritten} 指标行`)
  return { metricsWritten, entitiesSeen, missing: [] }
}

/**
 * 采集模型每日 token 用量排行(需 OPENROUTER_API_KEY)。
 * 实测:`?date=X` 返回 { data: [{ date, model_permaslug, total_tokens }] },约 1530 行跨近 30 天
 * —— 每行带自己的日期,故一次请求即回填近一个月历史。total_tokens 是字符串。
 * 用量实体用 permaslug(带版本),与 /models 的定价实体分开;后续项目/模型聚合层再打通。
 * @param {{ capturedAt: string, writer: any, apiKey: string, log?: (m:string)=>void }} p
 */
export async function collectOpenRouterUsage({ capturedAt, writer, apiKey, log = () => {} }) {
  const res = await fetchRetry(`${RANKINGS_API}?date=${capturedAt}`, {
    headers: { authorization: `Bearer ${apiKey}`, 'user-agent': UA },
  })
  const json = await res.json()
  const rows = Array.isArray(json?.data) ? json.data : []
  let metricsWritten = 0
  const seen = new Set()
  const dates = new Set()
  for (const r of rows) {
    const id = r.model_permaslug || r.model
    const tokens = Number(r.total_tokens ?? r.tokens)
    const day = r.date || capturedAt
    if (!id || id === 'other' || !Number.isFinite(tokens)) continue // 'other' 是长尾聚合行,非真实模型
    const entity_id = `${SOURCE}:${id}`
    if (!seen.has(id)) {
      seen.add(id)
      writer.upsertEntity({
        entity_id,
        kind: 'openrouter',
        ecosystem: 'global',
        name: id,
        url: `https://openrouter.ai/${id}`,
        category: String(id).split('/')[0],
        last_seen: capturedAt,
        active: 1,
      })
    }
    writer.upsertMetric({ entity_id, metric: 'or_tokens_day', value: tokens, captured_at: day, source: SOURCE })
    metricsWritten++
    dates.add(day)
  }
  log(`openrouter usage: ${seen.size} 模型,${metricsWritten} 日用量行(跨 ${dates.size} 天)`)
  return { metricsWritten, entitiesSeen: seen.size, missing: [] }
}
