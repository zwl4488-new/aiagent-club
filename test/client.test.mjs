import assert from 'node:assert/strict'
import { test } from 'node:test'
import { backoffMs, retryAfterSeconds, proxyBypassed, envProxyUrl } from '../src/fetch/client.mjs'

test('backoffMs is exponential with jitter floor', () => {
  // rand=0 → 下界 = exp/2;rand=1 → 上界 = exp
  assert.equal(backoffMs(0, 1000, null, 0), 500)
  assert.equal(backoffMs(0, 1000, null, 1), 1000)
  assert.equal(backoffMs(3, 1000, null, 1), 8000) // 1000 * 2^3
  assert.equal(backoffMs(3, 1000, null, 0), 4000)
})

test('backoffMs honors Retry-After over exponential', () => {
  assert.equal(backoffMs(5, 1000, 2, 0.5), 2000)
  assert.equal(backoffMs(0, 1000, 0, 0.5), 0)
})

test('retryAfterSeconds reads Retry-After header', () => {
  const h = new Headers({ 'retry-after': '7' })
  assert.equal(retryAfterSeconds(h, 1000), 7)
})

test('retryAfterSeconds computes wait from ratelimit-reset when exhausted', () => {
  const h = new Headers({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1050' })
  assert.equal(retryAfterSeconds(h, 1000), 50)
})

test('retryAfterSeconds returns null when limit not exhausted', () => {
  const h = new Headers({ 'x-ratelimit-remaining': '10', 'x-ratelimit-reset': '1050' })
  assert.equal(retryAfterSeconds(h, 1000), null)
})

test('proxyBypassed matches host and suffix rules', () => {
  assert.equal(proxyBypassed('localhost', 'localhost,127.0.0.1'), true)
  assert.equal(proxyBypassed('api.github.com', 'localhost'), false)
  assert.equal(proxyBypassed('foo.r2.cloudflarestorage.com', '.cloudflarestorage.com'), true)
  assert.equal(proxyBypassed('example.com', '*'), true)
})

test('envProxyUrl reads HTTPS_PROXY first', () => {
  const keys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']
  /** @type {Record<string, string|undefined>} */
  const prev = {}
  for (const k of keys) prev[k] = process.env[k]
  try {
    for (const k of keys) delete process.env[k]
    assert.equal(envProxyUrl(), null)
    process.env.HTTP_PROXY = 'http://127.0.0.1:7890'
    process.env.HTTPS_PROXY = 'http://127.0.0.1:7891'
    assert.equal(envProxyUrl(), 'http://127.0.0.1:7891')
  } finally {
    for (const k of keys) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
  }
})
