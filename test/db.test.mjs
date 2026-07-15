import assert from 'node:assert/strict'
import { test } from 'node:test'
import { unlink } from 'node:fs/promises'
import { sqlText, sqlNum, createWriter, query, runSqlite } from '../src/db.mjs'

test('sqlText escapes quotes and handles null', () => {
  assert.equal(sqlText(null), 'NULL')
  assert.equal(sqlText(undefined), 'NULL')
  assert.equal(sqlText('abc'), "'abc'")
  assert.equal(sqlText("O'Brien"), "'O''Brien'")
  assert.equal(sqlText("a'; DROP TABLE metrics;--"), "'a''; DROP TABLE metrics;--'")
})

test('sqlText rejects NUL byte', () => {
  assert.throws(() => sqlText('a\0b'))
})

test('sqlNum rejects non-finite', () => {
  assert.equal(sqlNum(42), '42')
  assert.equal(sqlNum(3.5), '3.5')
  assert.throws(() => sqlNum(NaN))
  assert.throws(() => sqlNum(Infinity))
  assert.throws(() => sqlNum('nope'))
})

test('writer round-trips entity + metric to a real db (idempotent)', async () => {
  const dbPath = '/tmp/aiagent-club-db-test.db'
  await unlink(dbPath).catch(() => {})
  // 建最小 schema
  await runSqlite(
    dbPath,
    `CREATE TABLE entities (entity_id TEXT PRIMARY KEY, kind TEXT, ecosystem TEXT, name TEXT, url TEXT, category TEXT, description TEXT, lang TEXT, first_seen TEXT, last_seen TEXT, active INTEGER DEFAULT 1);
     CREATE TABLE metrics (entity_id TEXT, metric TEXT, value REAL, captured_at TEXT, source TEXT, UNIQUE(entity_id,metric,captured_at) ON CONFLICT REPLACE);`
  )
  const w = createWriter(dbPath)
  w.upsertEntity({ entity_id: 'github:a/b', kind: 'github', ecosystem: 'global', name: "a/b O'x", url: 'http://x', first_seen: '2020-01-01', last_seen: '2026-07-12' })
  w.upsertMetric({ entity_id: 'github:a/b', metric: 'stars', value: 100, captured_at: '2026-07-12', source: 'github' })
  assert.equal(w.pending, 2)
  assert.equal(await w.flush(), 2)

  // 重跑同一天:REPLACE,不产生重复行,值被覆盖。
  const w2 = createWriter(dbPath)
  w2.upsertMetric({ entity_id: 'github:a/b', metric: 'stars', value: 105, captured_at: '2026-07-12', source: 'github' })
  await w2.flush()

  const rows = await query(dbPath, `SELECT value FROM metrics WHERE entity_id='github:a/b' AND metric='stars'`)
  assert.equal(rows.length, 1) // 幂等:仍只有一行
  assert.equal(rows[0].value, 105) // 被覆盖为新值

  const ents = await query(dbPath, `SELECT name FROM entities WHERE entity_id='github:a/b'`)
  assert.equal(ents[0].name, "a/b O'x") // 引号正确落库
  await unlink(dbPath).catch(() => {})
})

test('description: 采到即写,采不到(undefined)走 COALESCE 保留旧值', async () => {
  const dbPath = '/tmp/aiagent-club-desc-test.db'
  await unlink(dbPath).catch(() => {})
  await runSqlite(
    dbPath,
    `CREATE TABLE entities (entity_id TEXT PRIMARY KEY, kind TEXT, ecosystem TEXT, name TEXT, url TEXT, category TEXT, description TEXT, lang TEXT, first_seen TEXT, last_seen TEXT, active INTEGER DEFAULT 1);`
  )
  const base = { entity_id: 'npm:x', kind: 'npm', ecosystem: 'global', name: 'x', last_seen: '2026-07-16' }

  // 首采:带简介 → 落库。
  const w1 = createWriter(dbPath)
  w1.upsertEntity({ ...base, description: 'a cool package' })
  await w1.flush()
  let r = await query(dbPath, `SELECT description FROM entities WHERE entity_id='npm:x'`)
  assert.equal(r[0].description, 'a cool package')

  // 次采:这次没取到简介(undefined) → COALESCE 保留旧简介,不被抹成 NULL。
  const w2 = createWriter(dbPath)
  w2.upsertEntity({ ...base, description: undefined })
  await w2.flush()
  r = await query(dbPath, `SELECT description FROM entities WHERE entity_id='npm:x'`)
  assert.equal(r[0].description, 'a cool package')

  // 再采:取到新简介 → 刷新。
  const w3 = createWriter(dbPath)
  w3.upsertEntity({ ...base, description: 'updated summary' })
  await w3.flush()
  r = await query(dbPath, `SELECT description FROM entities WHERE entity_id='npm:x'`)
  assert.equal(r[0].description, 'updated summary')
  await unlink(dbPath).catch(() => {})
})
