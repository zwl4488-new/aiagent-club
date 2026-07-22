// 通用 HTTP 客户端 — 超时、重试、指数退避 + jitter、限速识别(阶段 1)。
// 所有源适配器复用。抓取器是无人值守的,网络抖动/二级限速必须自己扛,不能让一次波动毁掉当天数据点。
//
// 代理:Node 原生 fetch 不读 HTTP(S)_PROXY。本机(如 Clash :7890)连 HF 等站时,设 HTTPS_PROXY 即可;
// fetchRetry / fetchProxyAware 会走 HTTP CONNECT 隧道。SOCKS URL 会改试同主机的 http 口。

import net from 'node:net'
import tls from 'node:tls'

/** @typedef {{ retries?: number, baseDelayMs?: number, timeoutMs?: number, headers?: Record<string,string>, notFoundOk?: boolean }} FetchOpts */

const DEFAULTS = { retries: 5, baseDelayMs: 1000, timeoutMs: 30000 }

/**
 * 从环境变量读代理 URL(优先 HTTPS)。无则 null。
 * @returns {string|null}
 */
export function envProxyUrl() {
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    const v = process.env[k]
    if (v && String(v).trim()) return String(v).trim()
  }
  return null
}

/**
 * 主机是否在 NO_PROXY 列表(逗号分隔;支持 .suffix 与裸域名)。
 * @param {string} hostname
 * @param {string} [noProxy]
 * @returns {boolean}
 */
export function proxyBypassed(hostname, noProxy = process.env.NO_PROXY || process.env.no_proxy || '') {
  if (!noProxy || !String(noProxy).trim()) return false
  const host = hostname.toLowerCase()
  for (const raw of String(noProxy).split(',')) {
    const rule = raw.trim().toLowerCase()
    if (!rule) continue
    if (rule === '*') return true
    if (rule.startsWith('.')) {
      if (host === rule.slice(1) || host.endsWith(rule)) return true
      continue
    }
    if (host === rule || host.endsWith(`.${rule}`)) return true
  }
  return false
}

/**
 * @param {string} proxy
 * @returns {URL}
 */
function normalizeProxyUrl(proxy) {
  const withScheme = proxy.includes('://') ? proxy : `http://${proxy}`
  const u = new URL(withScheme)
  // Clash 等常把 HTTP/SOCKS 开在同一端口;Node 这边只实现 HTTP CONNECT,socks→http。
  if (u.protocol === 'socks:' || u.protocol === 'socks5:' || u.protocol === 'socks4:') {
    u.protocol = 'http:'
  }
  return u
}

/**
 * 经 HTTP 代理发请求,返回标准 Response(便于与原生 fetch 互换)。
 * @param {string} url
 * @param {RequestInit} init
 * @param {URL} proxyUrl
 * @returns {Promise<Response>}
 */
function fetchViaHttpProxy(url, init, proxyUrl) {
  const target = new URL(url)
  const method = (init.method || 'GET').toUpperCase()
  const headers = new Headers(init.headers || {})
  if (!headers.has('host')) headers.set('host', target.host)
  // 代理隧道上不复用连接,让对端读完即可关(避免等 end 挂死)。
  headers.set('connection', 'close')
  const body = init.body == null ? null : Buffer.isBuffer(init.body) ? init.body : Buffer.from(/** @type {string} */ (init.body))
  if (body && !headers.has('content-length')) headers.set('content-length', String(body.length))

  const signal = init.signal
  const connectHost = proxyUrl.hostname
  const connectPort = Number(proxyUrl.port) || (proxyUrl.protocol === 'https:' ? 443 : 80)

  return new Promise((resolve, reject) => {
    /** @type {import('node:net').Socket | null} */
    let sock = null
    let settled = false
    const fail = (err) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      try {
        sock?.destroy()
      } catch {
        /* ignore */
      }
      reject(err instanceof Error ? err : new Error(String(err)))
    }
    const ok = (res) => {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      resolve(res)
    }
    const onAbort = () => fail(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
    if (signal?.aborted) {
      fail(signal.reason instanceof Error ? signal.reason : new Error('aborted'))
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    sock = net.connect(connectPort, connectHost, () => {
      const authority = `${target.hostname}:${target.port || (target.protocol === 'https:' ? 443 : 80)}`
      sock.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`)
    })
    sock.once('error', fail)

    let head = Buffer.alloc(0)
    const onConnectData = (chunk) => {
      head = Buffer.concat([head, chunk])
      const idx = head.indexOf('\r\n\r\n')
      if (idx < 0) return
      sock.off('data', onConnectData)
      const statusLine = head.subarray(0, head.indexOf('\r\n')).toString('utf8')
      const m = /^HTTP\/\d\.\d\s+(\d+)/.exec(statusLine)
      if (!m || Number(m[1]) !== 200) {
        fail(new Error(`proxy CONNECT failed: ${statusLine || 'no status'}`))
        return
      }
      const rest = head.subarray(idx + 4)
      const proceed = (/** @type {import('node:net').Socket} */ stream) => {
        if (rest.length) stream.unshift(rest)
        const path = `${target.pathname}${target.search}`
        const hdrLines = []
        for (const [k, v] of headers.entries()) hdrLines.push(`${k}: ${v}`)
        stream.write(`${method} ${path} HTTP/1.1\r\n${hdrLines.join('\r\n')}\r\n\r\n`)
        if (body) stream.write(body)

        /** @type {Buffer} */
        let buf = Buffer.alloc(0)
        let headersDone = false
        /** @type {number} */
        let status = 0
        /** @type {Headers} */
        let respHeaders = new Headers()
        /** @type {number} */ let contentLength = -1
        let chunked = false

        const finishWith = (bodyBuf) => {
          try {
            stream.destroy()
          } catch {
            /* ignore */
          }
          ok(new Response(bodyBuf, { status, headers: respHeaders }))
        }

        /**
         * @param {Buffer} raw
         * @returns {Buffer|null} 完整 body;未收齐则 null
         */
        const tryDecodeChunked = (raw) => {
          /** @type {Buffer[]} */
          const out = []
          let i = 0
          while (i < raw.length) {
            const lineEnd = raw.indexOf('\r\n', i)
            if (lineEnd < 0) return null
            const size = parseInt(raw.subarray(i, lineEnd).toString('utf8'), 16)
            if (!Number.isFinite(size)) throw new Error('bad chunk size')
            i = lineEnd + 2
            if (size === 0) return Buffer.concat(out)
            if (i + size + 2 > raw.length) return null
            out.push(raw.subarray(i, i + size))
            i += size + 2 // data + CRLF
          }
          return null
        }

        stream.on('data', (c) => {
          buf = Buffer.concat([buf, c])
          if (!headersDone) {
            const end = buf.indexOf('\r\n\r\n')
            if (end < 0) return
            headersDone = true
            const rawHead = buf.subarray(0, end).toString('utf8')
            buf = buf.subarray(end + 4)
            const lines = rawHead.split('\r\n')
            const sm = /^HTTP\/\d\.\d\s+(\d+)/.exec(lines[0] || '')
            status = sm ? Number(sm[1]) : 0
            respHeaders = new Headers()
            for (let i = 1; i < lines.length; i++) {
              const colon = lines[i].indexOf(':')
              if (colon > 0) respHeaders.append(lines[i].slice(0, colon).trim(), lines[i].slice(colon + 1).trim())
            }
            const te = (respHeaders.get('transfer-encoding') || '').toLowerCase()
            chunked = te.split(',').map((s) => s.trim()).includes('chunked')
            const cl = respHeaders.get('content-length')
            contentLength = cl != null && !chunked ? Number(cl) : -1
            if (method === 'HEAD' || status === 204 || status === 304) {
              finishWith(Buffer.alloc(0))
              return
            }
          }
          if (!headersDone) return
          if (chunked) {
            try {
              const decoded = tryDecodeChunked(buf)
              if (decoded) finishWith(decoded)
            } catch (e) {
              fail(e)
            }
            return
          }
          if (contentLength >= 0) {
            if (buf.length >= contentLength) finishWith(buf.subarray(0, contentLength))
            return
          }
          // 无长度:靠 connection:close,在 end 时收齐
        })
        stream.on('end', () => {
          if (settled) return
          if (!headersDone) {
            fail(new Error('proxy upstream closed before headers'))
            return
          }
          if (chunked) {
            try {
              const decoded = tryDecodeChunked(buf)
              finishWith(decoded || buf)
            } catch (e) {
              fail(e)
            }
            return
          }
          finishWith(buf)
        })
        stream.on('error', fail)
      }

      if (target.protocol === 'https:') {
        const tlsSock = tls.connect({ socket: sock, servername: target.hostname }, () => proceed(tlsSock))
        tlsSock.once('error', fail)
        sock = tlsSock
      } else {
        proceed(sock)
      }
    }
    sock.on('data', onConnectData)
  })
}

/**
 * 与原生 fetch 同签名;若设了 HTTP(S)_PROXY 且主机未 bypass,则走 CONNECT。
 * @param {string} url
 * @param {RequestInit} [init]
 * @returns {Promise<Response>}
 */
export function fetchProxyAware(url, init = {}) {
  const proxy = envProxyUrl()
  if (!proxy) return fetch(url, init)
  let hostname
  try {
    hostname = new URL(url).hostname
  } catch {
    return fetch(url, init)
  }
  if (proxyBypassed(hostname)) return fetch(url, init)
  return fetchViaHttpProxy(url, init, normalizeProxyUrl(proxy))
}

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
    if (typeof timer.unref === 'function') timer.unref() // 不因待触发的超时定时器阻塞进程退出
    try {
      const res = await fetchProxyAware(url, { ...init, headers, signal: ctrl.signal })
      // 关键:成功/404 返回时**不**清 timer —— 让这个超时继续覆盖调用方的 body 读取(res.json/text)。
      // 否则响应头到了但 body 中途 stall 时,调用方 await res.json() 会永久挂起(曾致 star 回填卡死 5h)。
      // timer 到点会 abort、令 body 读取抛错而非死等;若 body 已读完,abort 为空操作;unref 保证不挡退出。
      if (res.ok) return res
      if (res.status === 404 && notFoundOk) return res

      const isRateLimited = res.status === 429 || res.status === 403
      const isServerErr = res.status >= 500
      if (!isRateLimited && !isServerErr) {
        // 4xx(非限速):重试无意义,带响应体抛错便于诊断。
        const body = await res.text().catch(() => '')
        clearTimeout(timer)
        throw new Error(`HTTP ${res.status} ${url} :: ${body.slice(0, 300)}`)
      }
      clearTimeout(timer) // 要重试:清掉本次定时器,下次循环新建
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
