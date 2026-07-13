import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parsePypiRecent } from '../src/fetch/pypi.mjs'

test('parsePypiRecent flattens three windows', () => {
  const json = { data: { last_day: 100, last_week: 700, last_month: 3000 }, package: 'x', type: 'recent_downloads' }
  assert.deepEqual(parsePypiRecent(json), { downloads_day: 100, downloads_week: 700, downloads_month: 3000 })
})

test('parsePypiRecent tolerates missing fields', () => {
  assert.deepEqual(parsePypiRecent({ data: { last_week: 5 } }), { downloads_week: 5 })
  assert.deepEqual(parsePypiRecent({}), {})
  assert.deepEqual(parsePypiRecent(null), {})
})
