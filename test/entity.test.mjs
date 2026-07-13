import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  buildEntityId,
  ecosystemForKind,
  isValidEntityId,
  parseEntityId,
} from '../src/entity.mjs'

test('build + parse round-trips', () => {
  const id = buildEntityId('github', 'langchain-ai/langchain')
  assert.equal(id, 'github:langchain-ai/langchain')
  assert.deepEqual(parseEntityId(id), { kind: 'github', id: 'langchain-ai/langchain' })
})

test('scoped npm packages keep @ and /', () => {
  const id = buildEntityId('npm', '@langchain/core')
  assert.equal(id, 'npm:@langchain/core')
  assert.deepEqual(parseEntityId(id), { kind: 'npm', id: '@langchain/core' })
})

test('ecosystem split is fixed by kind', () => {
  assert.equal(ecosystemForKind('github'), 'global')
  assert.equal(ecosystemForKind('coze'), 'cn')
  assert.equal(ecosystemForKind('pricing'), null) // 必须显式指定
})

test('rejects garbage', () => {
  assert.equal(isValidEntityId('nocolon'), false)
  assert.equal(isValidEntityId('unknownkind:x'), false)
  assert.equal(isValidEntityId('github:'), false)
  assert.equal(isValidEntityId('github: has space'), false)
  assert.throws(() => buildEntityId('github', '/leading-slash'))
})
