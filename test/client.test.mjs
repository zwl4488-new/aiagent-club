import assert from 'node:assert/strict'
import { test } from 'node:test'
import { backoffMs, retryAfterSeconds } from '../src/fetch/client.mjs'

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
