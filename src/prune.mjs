// 数据清洗 — 去重 + 排除(阶段 7 收尾)。
//
// 每次采集后跑一遍(见 run.mjs),声明式、幂等:
//  1) GitHub 重定向去重:repo 换 org/改名后,旧 owner/name 与新 nameWithOwner 会各存一条实体
//     (采集器现按 nameWithOwner 收敛,不再新增别名,但存量别名要清)。把别名的历史指标并入规范实体
//     (二者是同一个仓库,同日值相同,INSERT OR IGNORE 保留规范行、补上别名独有的更早历史),再删别名。
//  2) EXCLUDE 排除:删掉排除名单里的实体及其全部指标(跑题噪声 / 跨生态无法自动识别的重复身份)。
//
// 纪律:只删"确证的别名/噪声"。别名判定极严格——必须存在对应的规范实体才合并删除,
// 单向重定向(旧名解析到新名、但新名还没作为独立实体存在)不动,避免误删。

import { runSqlite, query, sqlText } from './db.mjs'
import { EXCLUDE } from './entities.mjs'

/**
 * 找出 GitHub 重定向别名:entity_id 的 owner/name 与解析出的 name(nameWithOwner)不一致,
 * 且存在规范实体 github:<name>。返回 [{ alias, canonical }]。
 * @param {string} dbPath
 * @returns {Promise<Array<{ alias: string, canonical: string }>>}
 */
export async function findRedirectAliases(dbPath) {
  const rows = await query(
    dbPath,
    `SELECT a.entity_id alias, 'github:' || a.name canonical
       FROM entities a
       JOIN entities c ON c.entity_id = 'github:' || a.name
      WHERE a.kind = 'github'
        AND a.name IS NOT NULL
        AND a.entity_id <> 'github:' || a.name`
  )
  return rows.map((r) => ({ alias: r.alias, canonical: r.canonical }))
}

/**
 * 数据清洗:去重 + 排除。返回统计。
 * @param {string} dbPath
 * @param {(m: string) => void} [log]
 * @returns {Promise<{ merged: number, excluded: number }>}
 */
export async function pruneAndDedup(dbPath, log = () => {}) {
  const stmts = []

  // ── 1) GitHub 重定向别名:并历史 → 删别名 ──
  const aliases = await findRedirectAliases(dbPath)
  for (const { alias, canonical } of aliases) {
    // 别名独有的更早历史并入规范实体(冲突日保留规范行:同一仓库同日值本就相同)。
    stmts.push(
      `INSERT OR IGNORE INTO metrics (entity_id, metric, value, captured_at, source) ` +
        `SELECT ${sqlText(canonical)}, metric, value, captured_at, source FROM metrics WHERE entity_id = ${sqlText(alias)};`
    )
    stmts.push(`DELETE FROM metrics WHERE entity_id = ${sqlText(alias)};`)
    stmts.push(`DELETE FROM entities WHERE entity_id = ${sqlText(alias)};`)
  }
  if (aliases.length) log(`prune: 合并 ${aliases.length} 个 GitHub 重定向别名 → 规范实体(${aliases.map((a) => a.alias.replace('github:', '')).join(', ')})`)

  // ── 2) EXCLUDE 排除:删实体 + 指标 ──
  const excludeIds = [...EXCLUDE]
  let excluded = 0
  if (excludeIds.length) {
    const present = await query(
      dbPath,
      `SELECT entity_id FROM entities WHERE entity_id IN (${excludeIds.map(sqlText).join(',')})`
    )
    excluded = present.length
    for (const id of excludeIds) {
      stmts.push(`DELETE FROM metrics WHERE entity_id = ${sqlText(id)};`)
      stmts.push(`DELETE FROM entities WHERE entity_id = ${sqlText(id)};`)
    }
    if (excluded) log(`prune: 排除 ${excluded} 个实体(${present.map((r) => r.entity_id).join(', ')})`)
  }

  if (stmts.length) await runSqlite(dbPath, 'BEGIN;\n' + stmts.join('\n') + '\nCOMMIT;\n')
  return { merged: aliases.length, excluded }
}
