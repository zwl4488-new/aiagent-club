import assert from 'node:assert/strict'
import { test } from 'node:test'
import { signV4 } from '../src/r2.mjs'

const base = {
  method: /** @type {const} */ ('GET'),
  host: 'acct.r2.cloudflarestorage.com',
  canonicalUri: '/bucket/data.db',
  query: '',
  payload: Buffer.alloc(0),
  accessKeyId: 'AKID',
  secretAccessKey: 'SECRET',
  now: new Date('2026-07-13T03:00:00.000Z'),
}

test('signV4 produces required headers', () => {
  const h = signV4(base)
  assert.equal(h.host, base.host)
  assert.equal(h['x-amz-date'], '20260713T030000Z')
  assert.match(h.authorization, /^AWS4-HMAC-SHA256 Credential=AKID\/20260713\/auto\/s3\/aws4_request/)
  assert.match(h.authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date/)
  assert.match(h.authorization, /Signature=[0-9a-f]{64}$/)
  // 空 payload 的 sha256 是已知常量
  assert.equal(h['x-amz-content-sha256'], 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
})

test('signV4 is deterministic for identical inputs', () => {
  assert.equal(signV4(base).authorization, signV4(base).authorization)
})

test('signV4 signature changes with secret / payload / time', () => {
  const sig = (o) => signV4({ ...base, ...o }).authorization.match(/Signature=([0-9a-f]+)/)[1]
  const s0 = sig({})
  assert.notEqual(s0, sig({ secretAccessKey: 'OTHER' }))
  assert.notEqual(s0, sig({ payload: Buffer.from('x') }))
  assert.notEqual(s0, sig({ now: new Date('2026-07-14T03:00:00.000Z') }))
})
