import assert from 'node:assert/strict'
import { test } from 'node:test'
import { price } from '../site/src/lib/format.mjs'

test('price removes floating-point noise without losing small values', () => {
  assert.equal(price(0.024999999999999998), '0.025')
  assert.equal(price(0.06050000000000001), '0.0605')
  assert.equal(price(0.000000125), '0.000000125')
})

test('price handles zero, grouping, missing values, and sentinels', () => {
  assert.equal(price(0), '0')
  assert.equal(price(1234.56789), '1,234.57')
  assert.equal(price(-1000000), '—')
  assert.equal(price(null), '—')
  assert.equal(price(Number.NaN), '—')
})
