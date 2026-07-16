import assert from 'node:assert/strict'
import { test } from 'node:test'
import { unlink } from 'node:fs/promises'
import { runSqlite } from '../src/db.mjs'

// events.mjs 读 site/src/lib/data.mjs,后者在 import 时读 process.env.DB_PATH → 先设好再动态 import。
const DB = '/tmp/aiagent-club-events-test.db'
process.env.DB_PATH = DB

async function seed() {
  await unlink(DB).catch(() => {})
  await runSqlite(
    DB,
    `CREATE TABLE entities (entity_id TEXT PRIMARY KEY, kind TEXT, ecosystem TEXT, name TEXT, url TEXT, category TEXT, description TEXT, lang TEXT, first_seen TEXT, last_seen TEXT, active INTEGER DEFAULT 1);
     CREATE TABLE metrics (entity_id TEXT, metric TEXT, value REAL, captured_at TEXT, source TEXT, UNIQUE(entity_id,metric,captured_at) ON CONFLICT REPLACE);
     INSERT INTO entities (entity_id,kind,ecosystem,name) VALUES ('github:a/big','github','global','a/big');
     INSERT INTO entities (entity_id,kind,ecosystem,name) VALUES ('npm:pkg','npm','global','pkg');
     -- stars 越过 10000(9500→10200,窗口内) → milestone
     INSERT INTO metrics VALUES ('github:a/big','stars',9500,'2026-07-10','github');
     INSERT INTO metrics VALUES ('github:a/big','stars',10200,'2026-07-14','github');
     INSERT INTO metrics VALUES ('github:a/big','stars',10200,'2026-07-16','github');
     -- releases 相邻两日 +2(07-15→07-16),仓库 star≥1000 → release
     INSERT INTO metrics VALUES ('github:a/big','releases',40,'2026-07-15','github');
     INSERT INTO metrics VALUES ('github:a/big','releases',42,'2026-07-16','github');
     -- 周下载 100k→160k(+60%,≥50k 地板,7 天前有基准) → surge;并定义 latestSnapshot=07-16
     INSERT INTO metrics VALUES ('npm:pkg','downloads_week',100000,'2026-07-09','npm');
     INSERT INTO metrics VALUES ('npm:pkg','downloads_week',160000,'2026-07-16','npm');`
  )
}

test('buildEvents 检出 milestone / release / surge,日期与数值正确', async () => {
  await seed()
  const { buildEvents } = await import('../site/src/lib/events.mjs')
  const ev = await buildEvents({ windowDays: 21 })

  const ms = ev.find((e) => e.type === 'milestone' && e.entity_id === 'github:a/big')
  assert.ok(ms, 'milestone 事件存在')
  assert.equal(ms.value, 10000)
  assert.equal(ms.at, '2026-07-14')

  const rel = ev.find((e) => e.type === 'release' && e.entity_id === 'github:a/big')
  assert.ok(rel, 'release 事件存在')
  assert.equal(rel.count, 2)
  assert.equal(rel.at, '2026-07-16')

  const surge = ev.find((e) => e.type === 'surge' && e.entity_id === 'npm:pkg')
  assert.ok(surge, 'surge 事件存在')
  assert.equal(Math.round(surge.pct * 100), 60)
  assert.equal(surge.to, 160000)

  await unlink(DB).catch(() => {})
})

test('buildEvents:低于 star 门槛的仓库不产生 release 事件', async () => {
  await unlink(DB).catch(() => {})
  await runSqlite(
    DB,
    `CREATE TABLE entities (entity_id TEXT PRIMARY KEY, kind TEXT, ecosystem TEXT, name TEXT, url TEXT, category TEXT, description TEXT, lang TEXT, first_seen TEXT, last_seen TEXT, active INTEGER DEFAULT 1);
     CREATE TABLE metrics (entity_id TEXT, metric TEXT, value REAL, captured_at TEXT, source TEXT, UNIQUE(entity_id,metric,captured_at) ON CONFLICT REPLACE);
     INSERT INTO entities (entity_id,kind,ecosystem,name) VALUES ('github:tiny/repo','github','global','tiny/repo');
     INSERT INTO metrics VALUES ('github:tiny/repo','stars',200,'2026-07-15','github');
     INSERT INTO metrics VALUES ('github:tiny/repo','stars',200,'2026-07-16','github');
     INSERT INTO metrics VALUES ('github:tiny/repo','releases',3,'2026-07-15','github');
     INSERT INTO metrics VALUES ('github:tiny/repo','releases',5,'2026-07-16','github');
     INSERT INTO metrics VALUES ('npm:x','downloads_week',10,'2026-07-16','npm');`
  )
  const mod = await import('../site/src/lib/events.mjs?tiny')
  const ev = await mod.buildEvents({ windowDays: 21 })
  assert.equal(ev.filter((e) => e.entity_id === 'github:tiny/repo').length, 0)
  await unlink(DB).catch(() => {})
})
