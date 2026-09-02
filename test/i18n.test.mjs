import assert from 'node:assert/strict'
import { test } from 'node:test'
import { STRINGS } from '../site/src/lib/i18n.mjs'

function shape(value) {
  if (typeof value === 'function') return 'function'
  if (!value || typeof value !== 'object' || Array.isArray(value)) return typeof value
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, shape(value[key])]))
}

test('English and Chinese UI dictionaries stay structurally synchronized', () => {
  assert.deepEqual(shape(STRINGS.zh), shape(STRINGS.en))
})
