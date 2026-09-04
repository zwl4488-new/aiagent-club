import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { unlink } from 'node:fs/promises'
import { runSqlite } from '../src/db.mjs'

const DB = '/tmp/aiagent-club-projects-v2-test.db'
process.env.DB_PATH = DB

let projectsModule

before(async () => {
  await unlink(DB).catch(() => {})
  await runSqlite(
    DB,
    `CREATE TABLE entities (
       entity_id TEXT PRIMARY KEY, kind TEXT, ecosystem TEXT, name TEXT, url TEXT, category TEXT,
       description TEXT, intro TEXT, project_key TEXT, lang TEXT, first_seen TEXT, last_seen TEXT, active INTEGER DEFAULT 1
     );
     CREATE TABLE metrics (
       entity_id TEXT, metric TEXT, value REAL, captured_at TEXT, source TEXT,
       UNIQUE(entity_id,metric,captured_at) ON CONFLICT REPLACE
     );
     CREATE TABLE fetch_runs (
       run_id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT, environment TEXT, status TEXT,
       rows_written INTEGER, error TEXT, started_at TEXT, finished_at TEXT
     );
     INSERT INTO fetch_runs (source,environment,status,rows_written,started_at,finished_at)
       VALUES ('github','test','ok',1,'2026-09-10T00:00:00Z','2026-09-10T00:01:00Z');
     INSERT INTO entities VALUES ('github:a/repo','github','global','a/repo',NULL,NULL,'A',NULL,'a/repo',NULL,'2026-09-01','2026-09-10',1);
     INSERT INTO entities VALUES ('npm:a','npm','global','a',NULL,NULL,'A package',NULL,'a/repo',NULL,'2026-09-01','2026-09-10',1);
     INSERT INTO entities VALUES ('github:b/repo','github','global','b/repo',NULL,NULL,'B',NULL,'b/repo',NULL,'2026-09-01','2026-09-10',1);
     INSERT INTO entities VALUES ('npm:c','npm','global','c',NULL,NULL,'C',NULL,'npm:c',NULL,'2026-09-01','2026-09-10',1);
     INSERT INTO entities VALUES ('github:d/repo','github','global','d/repo',NULL,NULL,'D',NULL,'d/repo',NULL,'2026-09-01','2026-09-07',1);
     INSERT INTO entities VALUES ('npm:d','npm','global','d',NULL,NULL,'D package',NULL,'d/repo',NULL,'2026-09-01','2026-09-10',1);
     INSERT INTO entities VALUES ('github:zero/repo','github','global','zero/repo',NULL,NULL,'Zero',NULL,'zero/repo',NULL,'2026-09-01','2026-09-10',1);
     INSERT INTO entities VALUES ('npm:zero','npm','global','zero',NULL,NULL,'Zero package',NULL,'zero/repo',NULL,'2026-09-01','2026-09-10',1);
     INSERT INTO entities VALUES ('github:archived/repo','github','global','archived/repo',NULL,NULL,'Archived',NULL,'archived/repo',NULL,'2026-09-01','2026-09-10',0);

     INSERT INTO metrics VALUES ('github:a/repo','stars',100,'2026-09-03','github');
     INSERT INTO metrics VALUES ('github:a/repo','stars',120,'2026-09-10','github');
     INSERT INTO metrics VALUES ('npm:a','downloads_week',1000,'2026-09-10','npm');

     INSERT INTO metrics VALUES ('github:b/repo','stars',50,'2026-09-03','github');
     INSERT INTO metrics VALUES ('github:b/repo','stars',50,'2026-09-10','github');
     INSERT INTO metrics VALUES ('npm:c','downloads_week',500,'2026-09-10','npm');

     INSERT INTO metrics VALUES ('github:d/repo','stars',10,'2026-08-31','github');
     INSERT INTO metrics VALUES ('github:d/repo','stars',15,'2026-09-07','github');
     INSERT INTO metrics VALUES ('npm:d','downloads_week',750,'2026-09-10','npm');

     INSERT INTO metrics VALUES ('github:zero/repo','stars',0,'2026-09-03','github');
     INSERT INTO metrics VALUES ('github:zero/repo','stars',0,'2026-09-10','github');
     INSERT INTO metrics VALUES ('npm:zero','downloads_week',0,'2026-09-10','npm');

     INSERT INTO metrics VALUES ('github:archived/repo','stars',999999,'2026-09-12','github');`
  )
  projectsModule = await import('../site/src/lib/projects.mjs?projects-v2-fixture')
})

after(async () => {
  await unlink(DB).catch(() => {})
})

test('Index v2 ranks only fresh cross-source projects', async () => {
  const projects = await projectsModule.buildProjects()
  const byKey = new Map(projects.map((project) => [project.key, project]))

  assert.equal(byKey.get('a/repo').eligible, true)
  assert.equal(byKey.get('a/repo').coverage, 3)
  assert.equal(byKey.get('a/repo').sourceCoverage, 2)
  assert.equal(byKey.get('a/repo').rank, 1)
  assert.equal(byKey.get('a/repo').snapshot, '2026-09-10', 'a sparse backfill must not advance the daily scoring snapshot')

  assert.equal(byKey.get('b/repo').coverage, 2, 'zero 7-day growth is still an observed momentum signal')
  assert.equal(byKey.get('b/repo').eligible, false, 'GitHub-only evidence is kept in the observation pool')
  assert.equal(byKey.get('b/repo').rank, undefined)

  assert.equal(byKey.get('d/repo').signals.attention.status, 'stale')
  assert.equal(byKey.get('d/repo').coverage, 1)
  assert.equal(byKey.get('d/repo').eligible, false)
  assert.equal(byKey.has('archived/repo'), false)
})

test('fresh zero values count as coverage without manufacturing a score', async () => {
  const projects = await projectsModule.buildProjects()
  const zero = projects.find((project) => project.key === 'zero/repo')
  assert.equal(zero.coverage, 3)
  assert.equal(zero.sourceCoverage, 2)
  assert.equal(zero.eligible, true)
  assert.equal(zero.score, 0)
})

test('observation projects still get detail pages but no formal rank', async () => {
  const pages = await projectsModule.buildProjectPages()
  const observed = pages.find((project) => project.key === 'b/repo')
  assert.ok(observed)
  assert.equal(observed.eligible, false)
  assert.equal(observed.rank, null)
  assert.equal(observed.methodologyVersion, '2.0')
  assert.equal(observed.total, pages.filter((project) => project.eligible).length)
})

test('freshness helpers enforce the two-day boundary deterministically', () => {
  assert.equal(projectsModule.metricAgeDays('2026-09-10', '2026-09-08'), 2)
  assert.equal(projectsModule.isFreshMetric({ captured_at: '2026-09-08' }, '2026-09-10'), true)
  assert.equal(projectsModule.isFreshMetric({ captured_at: '2026-09-07' }, '2026-09-10'), false)
  assert.equal(projectsModule.isFreshMetric(null, '2026-09-10'), false)
})

test('entity to project mapping is unique and keeps observation-pool projects', () => {
  const observation = { key: 'b/repo', slug: 'github/b/repo', members: [{ entity_id: 'github:b/repo' }] }
  const map = projectsModule.buildEntityProjectMap([observation])
  assert.equal(map.get('github:b/repo'), observation)
  assert.equal(projectsModule.entityPreferredHref('github:b/repo', map, '/zh'), '/zh/project/github/b/repo')
  assert.equal(projectsModule.entityPreferredHref('openrouter:x/y', map, ''), '/p/openrouter/x/y')
  assert.throws(() => projectsModule.buildEntityProjectMap([
    observation,
    { key: 'other/repo', slug: 'github/other/repo', members: [{ entity_id: 'github:b/repo' }] },
  ]), /multiple projects/)
})
