import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseHuggingFace } from '../src/fetch/huggingface.mjs'
import { HF_MODELS } from '../src/entities.mjs'

test('parseHuggingFace 摊平 downloads/likes/name', () => {
  const j = { id: 'meta-llama/Llama-3.1-8B-Instruct', downloads: 1234567, likes: 890, pipeline_tag: 'text-generation' }
  assert.deepEqual(parseHuggingFace(j), { downloads: 1234567, likes: 890, name: 'meta-llama/Llama-3.1-8B-Instruct' })
})

test('parseHuggingFace 缺字段 / 非数值 → null(不写坏值)', () => {
  assert.deepEqual(parseHuggingFace({ id: 'a/b' }), { downloads: null, likes: null, name: 'a/b' })
  assert.deepEqual(parseHuggingFace({ downloads: 'x', likes: NaN }), { downloads: null, likes: null, name: null })
  assert.deepEqual(parseHuggingFace(null), { downloads: null, likes: null, name: null })
})

test('HF_MODELS 是非空的 org/name 列表', () => {
  assert.ok(HF_MODELS.length > 0)
  for (const id of HF_MODELS) assert.match(id, /^[^/]+\/[^/]+$/, `bad id: ${id}`)
})
