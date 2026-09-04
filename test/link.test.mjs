import assert from 'node:assert/strict'
import { test } from 'node:test'
import { unlink } from 'node:fs/promises'
import { runSqlite } from '../src/db.mjs'
import { ghOwnerName, npmRepoKey, packageTargets, pypiRepoKey } from '../src/link.mjs'

test('GitHub repository URLs normalize to owner/name', () => {
  assert.equal(ghOwnerName('https://github.com/OpenAI/openai-agents-python'), 'openai/openai-agents-python')
  assert.equal(ghOwnerName('git+https://github.com/OpenAI/openai-agents-python.git'), 'openai/openai-agents-python')
  assert.equal(ghOwnerName('git+ssh://git@github.com/OpenAI/openai-agents-python.git'), 'openai/openai-agents-python')
  assert.equal(npmRepoKey({ url: 'https://github.com/acme/agent.git' }), 'acme/agent')
  assert.equal(ghOwnerName('https://example.com/acme/agent'), null)
})

test('PyPI metadata prefers the canonical repository over unrelated GitHub links', () => {
  const info = {
    project_urls: {
      Documentation: 'https://github.com/acme/docs',
      'Bug Tracker': 'https://github.com/acme/issues',
      Repository: 'https://github.com/acme/main',
    },
    home_page: 'https://github.com/acme/home',
  }
  assert.equal(pypiRepoKey(info), 'acme/main')
  assert.equal(pypiRepoKey({
    project_urls: { Documentation: 'https://github.com/acme/docs' },
    home_page: 'https://github.com/acme/product',
  }), 'acme/product')
})

test('link targets come from active database records and leave resolved rows alone', async (t) => {
  const db = '/tmp/aiagent-club-link-targets-test.db'
  await unlink(db).catch(() => {})
  t.after(() => unlink(db).catch(() => {}))
  await runSqlite(db, `
    CREATE TABLE entities (entity_id TEXT PRIMARY KEY, kind TEXT, project_key TEXT, active INTEGER DEFAULT 1);
    INSERT INTO entities VALUES ('npm:pending','npm',NULL,1);
    INSERT INTO entities VALUES ('npm:self','npm','npm:self',1);
    INSERT INTO entities VALUES ('npm:resolved','npm','acme/resolved',1);
    INSERT INTO entities VALUES ('npm:inactive','npm',NULL,0);
    INSERT INTO entities VALUES ('pypi:pending-py','pypi',NULL,1);
  `)

  assert.deepEqual(await packageTargets(db, 'npm', false), [
    { entity_id: 'npm:pending', name: 'pending' },
    { entity_id: 'npm:self', name: 'self' },
  ])
  assert.deepEqual(await packageTargets(db, 'npm', true), [
    { entity_id: 'npm:pending', name: 'pending' },
    { entity_id: 'npm:resolved', name: 'resolved' },
    { entity_id: 'npm:self', name: 'self' },
  ])
  assert.deepEqual(await packageTargets(db, 'pypi', false), [{ entity_id: 'pypi:pending-py', name: 'pending-py' }])
})
