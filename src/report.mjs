// 数据健康报告 — 从 data.db 生成公开安全的 status.json(阶段 1)。
//
// 双重用途:
//  1. 心跳:每次 CI 跑完 commit 这个文件,给仓库制造活动,防 GitHub 60 天无活动自动禁用 scheduled workflow。
//  2. 公开"数据健康"页的数据源。**只出聚合结论,绝不出日粒度历史**(公开结论、私有过程)。
//
// 用法:node src/report.mjs [dbPath] [outPath]   默认 data.db → status.json

import { writeFile } from 'node:fs/promises'
import { query } from './db.mjs'

/**
 * 生成公开安全的状态摘要。只含:各源最近一次抓取、实体/指标总量、最新快照日期。
 * @param {string} dbPath
 * @returns {Promise<object>}
 */
export async function buildStatus(dbPath) {
  const [entityCount] = await query(dbPath, `SELECT count(*) n FROM entities`)
  const [metricCount] = await query(dbPath, `SELECT count(*) n FROM metrics`)
  const [latest] = await query(dbPath, `SELECT max(captured_at) d FROM metrics`)
  const perKind = await query(
    dbPath,
    `SELECT kind, count(*) n FROM entities GROUP BY kind ORDER BY n DESC`
  )
  // 各源最近一次 run(取每个 source 最新 started_at 的那行)。
  const runs = await query(
    dbPath,
    `SELECT r.source, r.environment, r.status, r.rows_written, r.started_at, r.finished_at
     FROM fetch_runs r
     JOIN (SELECT source, max(started_at) mx FROM fetch_runs GROUP BY source) t
       ON r.source = t.source AND r.started_at = t.mx
     ORDER BY r.source`
  )
  return {
    generated_at: new Date().toISOString(),
    latest_snapshot: latest?.d ?? null,
    entities: entityCount?.n ?? 0,
    metrics_rows: metricCount?.n ?? 0,
    entities_by_kind: Object.fromEntries(perKind.map((r) => [r.kind, r.n])),
    last_runs: runs.map((r) => ({
      source: r.source,
      environment: r.environment,
      status: r.status,
      rows_written: r.rows_written,
      started_at: r.started_at,
      finished_at: r.finished_at,
    })),
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`
if (isMain) {
  const dbPath = process.argv[2] || 'data.db'
  const outPath = process.argv[3] || 'status.json'
  const status = await buildStatus(dbPath)
  await writeFile(outPath, JSON.stringify(status, null, 2) + '\n')
  console.log(`wrote ${outPath}: ${status.entities} entities, ${status.metrics_rows} metric rows, latest ${status.latest_snapshot}`)
}
