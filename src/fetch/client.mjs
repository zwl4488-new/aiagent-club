// 通用 HTTP 客户端 — 超时、重试、指数退避 + jitter、限速识别(阶段 1)。
// 所有源适配器复用。抓取器是无人值守的,网络抖动/二级限速必须自己扛,不能让一次波动毁掉当天数据点。

/** @typedef {{ retries?: number, baseDelayMs?: number, timeoutMs?: number, headers?: Record<string,string>, notFoundOk?: boolean }} FetchOpts */

const DEFAULTS = { retries: 5, baseDelayMs: 1000, timeoutMs: 30000 }

/**
 * sleep;毫秒。测试可注入,避免真实等待。
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 计算第 attempt 次重试的退避毫秒。指数 + 满 jitter;若服务端给了 Retry-After 秒数则优先。
 * @param {number} attempt   从 0 起
 * @param {number} baseDelayMs
 * @param {number|null} retryAfterSec
 * @param {number} rand      0..1(注入以便测试确定性)
 * @returns {number}
 */
export function backoffMs(attempt, baseDelayMs, retryAfterSec, rand) {
  if (retryAfterSec != null && Number.isFinite(retryAfterSec)) {
    return Math.max(0, retryAfterSec * 1000)
  }
  const exp = baseDelayMs * 2 ** attempt
  return Math.floor(exp * (0.5 + 0.5 * rand)) // 满 jitter,下界为 exp 的一半
}

/**
 * 从响应头解析建议等待秒数:Retry-After(秒),或 GitHub 的 x-ratelimit-reset(epoch 秒)。
 * @param {Headers} headers
 * @param {number} nowSec
 * @returns {number|null}
 */
export function retryAfterSeconds(headers, nowSec) {
  const ra = headers.get('retry-after')
  if (ra) {
    const n = Number(ra)
    if (Number.isFinite(n)) return n
  }
  const remaining = headers.get('x-ratelimit-remaining')
  const reset = headers.get('x-ratelimit-reset')
  if (remaining === '0' && reset) {
    const r = Number(reset)
    if (Number.isFinite(r)) return Math.max(0, r - nowSec)
  }
  return null
}

/**
 * 带重试的 fetch。返回 Response(2xx)或在耗尽重试后抛错。
 * 429/403(限速)与 5xx 会退避重试;4xx(非限速)直接抛不重试。
 * @param {string} url
 * @param {RequestInit & FetchOpts} [opts]
 * @returns {Promise<Response>}
 */
export async function fetchRetry(url, opts = {}) {
  const { retries, baseDelayMs, timeoutMs, headers, notFoundOk, ...init } = { ...DEFAULTS, ...opts }
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(url, { ...init, headers, signal: ctrl.signal })
      clearTimeout(timer)
      if (res.ok) return res
      // 404 且调用方声明可接受(如"包不存在"):原样返回,让调用方处理为 missing。
      if (res.status === 404 && notFoundOk) return res

      const isRateLimited = res.status === 429 || res.status === 403
      const isServerErr = res.status >= 500
      if (!isRateLimited && !isServerErr) {
        // 4xx(非限速):重试无意义,带响应体抛错便于诊断。
        const body = await res.text().catch(() => '')
        throw new Error(`HTTP ${res.status} ${url} :: ${body.slice(0, 300)}`)
      }
      lastErr = new Error(`HTTP ${res.status} ${url}`)
      if (attempt === retries) break
      const nowSec = Math.floor(Date.now() / 1000)
      const wait = backoffMs(attempt, baseDelayMs, retryAfterSeconds(res.headers, nowSec), Math.random())
      await sleep(wait)
    } catch (e) {
      clearTimeout(timer)
      // AbortError(超时)/网络错误:重试。
      lastErr = e
      if (attempt === retries) break
      await sleep(backoffMs(attempt, baseDelayMs, null, Math.random()))
    }
  }
  throw lastErr ?? new Error(`fetchRetry failed: ${url}`)
}

/**
 * 便捷:GET 并解析 JSON。
 * @param {string} url
 * @param {RequestInit & FetchOpts} [opts]
 * @returns {Promise<any>}
 */
export async function getJson(url, opts = {}) {
  const res = await fetchRetry(url, opts)
  return res.json()
}
