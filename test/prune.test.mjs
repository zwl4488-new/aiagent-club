import assert from 'node:assert/strict'
import { test } from 'node:test'
import { unlink } from 'node:fs/promises'
import { runSqlite, query } from '../src/db.mjs'
import { findRedirectAliases, pruneAndDedup } from '../src/prune.mjs'
import { EXCLUDE } from '../src/entities.mjs'

const DB = '/tmp/aiagent-club-prune-test.db'

async function fresh() {
  await unlink(DB).catch(() => {})
  await runSqlite(
    DB,
    `CREATE TABLE entities (entity_id TEXT PRIMARY KEY, kind TEXT, ecosystem TEXT, name TEXT, url TEXT, category TEXT, description TEXT, lang TEXT, first_seen TEXT, last_seen TEXT, active INTEGER DEFAULT 1);
     CREATE TABLE metrics (entity_id TEXT, metric TEXT, value REAL, captured_at TEXT, source TEXT, UNIQUE(entity_id,metric,captured_at) ON CONFLICT REPLACE);`
  )
}

test('findRedirectAliases: 只认"别名解析名≠id 且规范实体存在"的情形', async () => {
  await fresh()
  await runSqlite(
    DB,
    // 别名(旧名,解析到新名)+ 规范实体(新名)都在 → 是重定向重复
    `INSERT INTO entities (entity_id,kind,ecosystem,name) VALUES ('github:old/repo','github','global','new/repo');
     INSERT INTO entities (entity_id,kind,ecosystem,name) VALUES ('github:new/repo','github','global','new/repo');
     -- 单向重定向:解析名≠id,但规范实体不存在 → 不动(不能误删)
     INSERT INTO entities (entity_id,kind,ecosystem,name) VALUES ('github:solo/old','github','global','solo/new');
     -- 正常实体:id==name → 不动
     INSERT INTO entities (entity_id,kind,ecosystem,name) VALUES ('github:fine/repo','github','global','fine/repo');`
  )
  const aliases = await findRedirectAliases(DB)
  assert.deepEqual(aliases, [{ alias: 'github:old/repo', canonical: 'github:new/repo' }])
  await unlink(DB).catch(() => {})
})

test('pruneAndDedup: 并历史→删别名,幂等', async () => {
  await fresh()
  await runSqlite(
    DB,
    `INSERT INTO entities (entity_id,kind,ecosystem,name) VALUES ('github:old/repo','github','global','new/repo');
     INSERT INTO entities (entity_id,kind,ecosystem,name) VALUES ('github:new/repo','github','global','new/repo');
     -- 别名有更早的历史(day1),规范实体只有 day2;合并后规范应两天都有
     INSERT INTO metrics VALUES ('github:old/repo','stars',100,'2020-01-01','github');
     INSERT INTO metrics VALUES ('github:old/repo','stars',200,'2020-01-02','github');
     INSERT INTO metrics VALUES ('github:new/repo','stars',200,'2020-01-02','github');`
  )
  const r = await pruneAndDedup(DB)
  assert.equal(r.merged, 1)

  // 别名实体 + 指标清空
  assert.equal((await query(DB, `SELECT count(*) n FROM entities WHERE entity_id='github:old/repo'`))[0].n, 0)
  assert.equal((await query(DB, `SELECT count(*) n FROM metrics WHERE entity_id='github:old/repo'`))[0].n, 0)
  // 规范实体拿到两天历史(冲突日 day2 保留规范行)
  const rows = await query(DB, `SELECT captured_at, value FROM metrics WHERE entity_id='github:new/repo' ORDER BY captured_at`)
  assert.deepEqual(rows, [
    { captured_at: '2020-01-01', value: 100 },
    { captured_at: '2020-01-02', value: 200 },
  ])

  // 幂等:再跑一次无变化
  const r2 = await pruneAndDedup(DB)
  assert.equal(r2.merged, 0)
  await unlink(DB).catch(() => {})
})

test('pruneAndDedup: 排除名单实体被删(实体+指标)', async () => {
  await fresh()
  const [firstExcluded] = [...EXCLUDE]
  assert.ok(firstExcluded, 'EXCLUDE 非空')
  const [kind, id] = [firstExcluded.slice(0, firstExcluded.indexOf(':')), firstExcluded]
  await runSqlite(
    DB,
    `INSERT INTO entities (entity_id,kind,ecosystem,name) VALUES ('${id}','${kind}','global','x');
     INSERT INTO metrics VALUES ('${id}','stars',5,'2026-01-01','x');`
  )
  const r = await pruneAndDedup(DB)
  assert.ok(r.excluded >= 1)
  assert.equal((await query(DB, `SELECT count(*) n FROM entities WHERE entity_id='${id}'`))[0].n, 0)
  assert.equal((await query(DB, `SELECT count(*) n FROM metrics WHERE entity_id='${id}'`))[0].n, 0)
  await unlink(DB).catch(() => {})
})
