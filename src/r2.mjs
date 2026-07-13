// R2 同步 — S3 兼容 REST + 自签 SigV4(阶段 1)。零依赖,不引 aws-sdk。
//
// data.db 的持久化家在私有 R2 bucket:CI 每次跑法是 pull → 采集 → push。
// 本地 data.db 是 ephemeral 工作副本,唯一真相在 R2。
//
// bucket 必须保持私有(不绑域名、不开 public access)—— 历史资产的护城河靠这个开关守。
//
// CLI:
//   node --env-file=.env src/r2.mjs pull <key> <localPath>   # 下载(404 时不报错,留空库让采集器建表)
//   node --env-file=.env src/r2.mjs push <key> <localPath>   # 上传
//   node --env-file=.env src/r2.mjs head <key>               # 存在性/大小

import { createHash, createHmac } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { loadR2Config } from './config.mjs'

const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex')
const hmac = (key, data) => createHmac('sha256', key).update(data).digest()

/**
 * SigV4 签名一个 S3 请求,返回要发送的 headers。纯函数(时间戳注入),便于测试。
 * @param {object} p
 * @param {'GET'|'PUT'|'HEAD'|'DELETE'} p.method
 * @param {string} p.host          <account>.r2.cloudflarestorage.com
 * @param {string} p.canonicalUri  以 / 开头,已编码,如 /bucket/key
 * @param {string} p.query         规范化查询串(可空)
 * @param {Buffer} p.payload       请求体(空则 Buffer.alloc(0))
 * @param {string} p.accessKeyId
 * @param {string} p.secretAccessKey
 * @param {Date} p.now
 * @returns {Record<string,string>}
 */
export function signV4({ method, host, canonicalUri, query = '', payload, accessKeyId, secretAccessKey, now }) {
  const service = 's3'
  const region = 'auto'
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 15) + 'Z'
  const dateStamp = amzDate.slice(0, 8)
  const payloadHash = sha256hex(payload)
  const canonicalHeaders = `host:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date'
  const canonicalRequest = [method, canonicalUri, query, canonicalHeaders, signedHeaders, payloadHash].join('\n')
  const scope = `${dateStamp}/${region}/${service}/aws4_request`
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(Buffer.from(canonicalRequest))].join('\n')
  const kDate = hmac('AWS4' + secretAccessKey, dateStamp)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  const kSigning = hmac(kService, 'aws4_request')
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex')
  return {
    host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  }
}

/**
 * 从 endpoint 取 host。
 * @param {string} endpoint
 * @returns {string}
 */
function hostOf(endpoint) {
  return new URL(endpoint).host
}

/**
 * 发一个签名请求。
 * @param {'GET'|'PUT'|'HEAD'|'DELETE'} method
 * @param {string} key       bucket 内对象键(不以 / 开头)
 * @param {Buffer} [payload]
 * @param {ReturnType<typeof loadR2Config>} [cfg]
 * @returns {Promise<Response>}
 */
async function request(method, key, payload = Buffer.alloc(0), cfg = loadR2Config()) {
  const host = hostOf(cfg.endpoint)
  // 键里每段单独 encode(保留 /)。
  const encodedKey = key.split('/').map(encodeURIComponent).join('/')
  const canonicalUri = `/${cfg.bucket}/${encodedKey}`
  const headers = signV4({
    method,
    host,
    canonicalUri,
    payload,
    accessKeyId: cfg.accessKeyId,
    secretAccessKey: cfg.secretAccessKey,
    now: new Date(),
  })
  const url = `${cfg.endpoint.replace(/\/$/, '')}${canonicalUri}`
  return fetch(url, { method, headers, body: method === 'PUT' ? payload : undefined })
}

/**
 * 下载对象到本地文件。对象不存在(404)时返回 false 而不抛——冷启动 R2 为空是正常的。
 * @param {string} key
 * @param {string} localPath
 * @param {ReturnType<typeof loadR2Config>} [cfg]
 * @returns {Promise<boolean>}  是否下载到了对象
 */
export async function pull(key, localPath, cfg = loadR2Config()) {
  const res = await request('GET', key, undefined, cfg)
  if (res.status === 404) return false
  if (!res.ok) throw new Error(`R2 pull ${key}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
  const buf = Buffer.from(await res.arrayBuffer())
  await writeFile(localPath, buf)
  return true
}

/**
 * 上传本地文件到对象。
 * @param {string} key
 * @param {string} localPath
 * @param {ReturnType<typeof loadR2Config>} [cfg]
 * @returns {Promise<number>}  上传字节数
 */
export async function push(key, localPath, cfg = loadR2Config()) {
  const body = await readFile(localPath)
  const res = await request('PUT', key, body, cfg)
  if (!res.ok) throw new Error(`R2 push ${key}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
  return body.length
}

/**
 * HEAD:返回 { exists, size }。
 * @param {string} key
 * @param {ReturnType<typeof loadR2Config>} [cfg]
 * @returns {Promise<{ exists: boolean, size: number|null }>}
 */
export async function head(key, cfg = loadR2Config()) {
  const res = await request('HEAD', key, undefined, cfg)
  if (res.status === 404) return { exists: false, size: null }
  if (!res.ok) throw new Error(`R2 head ${key}: HTTP ${res.status}`)
  const len = res.headers.get('content-length')
  return { exists: true, size: len ? Number(len) : null }
}

// ── CLI ──
const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const [cmd, key, localPath] = process.argv.slice(2)
  const run = async () => {
    if (cmd === 'pull') {
      if (!key || !localPath) throw new Error('用法: r2.mjs pull <key> <localPath>')
      const got = await pull(key, localPath)
      console.log(got ? `pulled ${key} → ${localPath}` : `${key} 不存在(冷启动),跳过`)
    } else if (cmd === 'push') {
      if (!key || !localPath) throw new Error('用法: r2.mjs push <key> <localPath>')
      const n = await push(key, localPath)
      console.log(`pushed ${localPath} → ${key} (${n} bytes)`)
    } else if (cmd === 'head') {
      if (!key) throw new Error('用法: r2.mjs head <key>')
      const h = await head(key)
      console.log(h.exists ? `${key} 存在,${h.size} bytes` : `${key} 不存在`)
    } else {
      throw new Error(`未知命令: ${cmd}(pull|push|head)`)
    }
  }
  run().catch((e) => {
    console.error('R2 error:', e.message)
    process.exit(1)
  })
}
