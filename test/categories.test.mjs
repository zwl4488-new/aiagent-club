import test from 'node:test'
import assert from 'node:assert/strict'
import { CATEGORY_DEFS, categorizeProject, buildCategoryRankings } from '../site/src/lib/categories.mjs'

function project(name, description = '') {
  return { name, description, key: name.toLowerCase(), members: [], score: 50 }
}

test('semantic category definitions have stable unique slugs', () => {
  assert.equal(CATEGORY_DEFS.length, 8)
  assert.equal(new Set(CATEGORY_DEFS.map((row) => row.slug)).size, CATEGORY_DEFS.length)
})

test('representative agent projects receive explainable categories', () => {
  assert.ok(categorizeProject(project('Cline', 'Autonomous coding agent and IDE assistant')).includes('coding-agents'))
  assert.ok(categorizeProject(project('FastMCP', 'Build Model Context Protocol servers and clients')).includes('mcp-tools'))
  assert.ok(categorizeProject(project('browser-use', 'Browser automation for AI agents')).includes('browser-web'))
  assert.ok(categorizeProject(project('Langfuse', 'LLM observability, tracing and evals')).includes('observability-evals'))
  assert.ok(categorizeProject(project('mem0', 'Persistent memory layer for AI agents')).includes('rag-memory'))
})

test('category rankings preserve input score order', () => {
  const rows = [project('second', 'MCP server'), project('first', 'MCP server')]
  rows[0].score = 20
  rows[1].score = 80
  const mcp = buildCategoryRankings(rows).find((row) => row.slug === 'mcp-tools')
  assert.deepEqual(mcp.projects.map((row) => row.name), ['second', 'first'])
})
