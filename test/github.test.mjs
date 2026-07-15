import assert from 'node:assert/strict'
import { test } from 'node:test'
import { chunk, buildBatchQuery, parseRepoNode } from '../src/fetch/github.mjs'

test('chunk splits by size', () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]])
  assert.deepEqual(chunk([], 100), [])
})

test('buildBatchQuery aliases repos and escapes owner/name', () => {
  const { query, aliasToRepo } = buildBatchQuery(['langchain-ai/langchain', 'run-llama/llama_index'])
  assert.equal(aliasToRepo.r0, 'langchain-ai/langchain')
  assert.equal(aliasToRepo.r1, 'run-llama/llama_index')
  assert.match(query, /r0: repository\(owner: "langchain-ai", name: "langchain"\)/)
  assert.match(query, /rateLimit \{ cost remaining resetAt \}/)
})

test('buildBatchQuery rejects malformed repo', () => {
  assert.throws(() => buildBatchQuery(['noslash']))
  assert.throws(() => buildBatchQuery(['owner/']))
  assert.throws(() => buildBatchQuery(['/name']))
})

test('parseRepoNode flattens metrics and meta', () => {
  const node = {
    nameWithOwner: 'a/b',
    url: 'https://github.com/a/b',
    isArchived: false,
    stargazerCount: 100,
    forkCount: 20,
    watchers: { totalCount: 30 },
    issues: { totalCount: 5 },
    pullRequests: { totalCount: 3 },
    releases: { totalCount: 7 },
    createdAt: '2020-01-02T03:04:05Z',
    description: '  A test repo.  ',
    primaryLanguage: { name: 'Python' },
    defaultBranchRef: { target: { history: { totalCount: 999 } } },
  }
  const { metrics, meta } = parseRepoNode(node)
  assert.deepEqual(metrics, { stars: 100, forks: 20, watchers: 30, open_issues: 5, open_prs: 3, releases: 7, commits: 999 })
  assert.equal(meta.name, 'a/b')
  assert.equal(meta.category, 'Python')
  assert.equal(meta.description, 'A test repo.') // trim,空白/缺失 → null
  assert.equal(meta.createdAt, '2020-01-02')
  assert.equal(meta.archived, false)
})

test('parseRepoNode tolerates empty default branch (no commits metric)', () => {
  const node = {
    nameWithOwner: 'a/empty',
    url: 'u',
    isArchived: true,
    stargazerCount: 0,
    forkCount: 0,
    watchers: { totalCount: 0 },
    issues: { totalCount: 0 },
    pullRequests: { totalCount: 0 },
    releases: { totalCount: 0 },
    createdAt: null,
    primaryLanguage: null,
    defaultBranchRef: null,
  }
  const { metrics, meta } = parseRepoNode(node)
  assert.equal('commits' in metrics, false)
  assert.equal(metrics.stars, 0)
  assert.equal(meta.category, null)
  assert.equal(meta.archived, true)
})
