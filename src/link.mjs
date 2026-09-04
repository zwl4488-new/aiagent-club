// 身份归并(把多源实体绑成一个"项目")—— 给每个实体算 project_key。
//
// 现库里 langchain 是三条割裂实体(github: / npm: / pypi:)。要做"项目=多源属性 + 综合榜",
// 得先知道谁和谁是同一个项目。权威做法:包元数据里声明的 GitHub 仓就是天然纽带 ——
//   npm packument .repository.url、pypi .info.project_urls(Repository/Source/…)都指向 github 仓。
// 解析出 owner/name(小写)作 project_key;github 实体的 key 就是它自己的 owner/name;
// 取不到链接的实体 key = 自身 entity_id(自成一个项目)。构建期据此分组。
//
// 逐项容错、幂等(默认跳过已有 project_key,--refresh 强制)、写本地库,收尾 merge R2。

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { runSqlite, createWriter, query } from './db.mjs'
import { fetchRetry, sleep } from './fetch/client.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UA = 'aiagent-club'
const NPM_GAP_MS = 120
const PYPI_GAP_MS = 250

/**
 * 从任意 URL 抽出 github 的 owner/name(小写);抽不到返回 null。
 * 兼容 git+ssh://git@github.com/o/n.git、git+https://…、https://github.com/o/n、带路径/后缀。
 * @param {string} url
 * @returns {string|null}
 */
export function ghOwnerName(url) {
  if (!url || typeof url !== 'string') return null
  const m = url.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?].*)?$/i)
  if (!m) return null
  const owner = m[1]
  const name = m[2]
  if (!owner || !name || owner.toLowerCase() === 'sponsors') return null
  return `${owner}/${name}`.toLowerCase()
}

/** npm:repository 可能是字符串或 {url}。抽 github owner/name。 */
export function npmRepoKey(repository) {
  if (!repository) return null
  const url = typeof repository === 'string' ? repository : repository.url
  return ghOwnerName(url)
}

/** pypi:info 里翻 project_urls + home_page 找第一个 github 链接(优先 Repository/Source/Code)。 */
export function pypiRepoKey(info) {
  if (!info) return null
  const urls = info.project_urls || {}
  const prefer = ['repository', 'source', 'source code', 'code', 'github', 'homepage']
  const priority = (label) => {
    const index = prefer.indexOf(label.toLowerCase())
    return index === -1 ? prefer.length : index
  }
  const entries = Object.entries(urls)
  const preferred = entries.filter(([label]) => priority(label) < prefer.length).sort((a, b) => priority(a[0]) - priority(b[0]))
  for (const [, v] of preferred) {
    const k = ghOwnerName(v)
    if (k) return k
  }
  const home = ghOwnerName(info.home_page)
  if (home) return home
  for (const [label, v] of entries) {
    if (priority(label) < prefer.length) continue
    const k = ghOwnerName(v)
    if (k) return k
  }
  return null
}

async function ensureSchema(dbPath) {
  const schema = await readFile(join(__dirname, '..', 'db', 'schema.sql'), 'utf8')
  await runSqlite(dbPath, schema)
  const cols = /** @type {any[]} */ (await runSqlite(dbPath, `PRAGMA table_info(entities);`, { json: true }))
  if (!cols.some((c) => c.name === 'project_key')) await runSqlite(dbPath, `ALTER TABLE entities ADD COLUMN project_key TEXT;`)
  if (!cols.some((c) => c.name === 'active')) await runSqlite(dbPath, `ALTER TABLE entities ADD COLUMN active INTEGER DEFAULT 1;`)
}

/**
 * 只处理已经成为来源记录的包；以数据库为准，自动覆盖新发现条目，也避免为尚未采集成功的清单项发请求。
 */
export async function packageTargets(dbPath, kind, refresh) {
  if (kind !== 'npm' && kind !== 'pypi') throw new Error(`unsupported package kind: ${kind}`)
  const rows = await query(
    dbPath,
    `SELECT entity_id, project_key FROM entities
     WHERE kind='${kind}' AND coalesce(active, 1) != 0
     ${refresh ? '' : 'AND (project_key IS NULL OR project_key = entity_id)'}
     ORDER BY entity_id`
  )
  const prefix = `${kind}:`
  return rows
    .filter((row) => row.entity_id?.startsWith(prefix) && row.entity_id.length > prefix.length)
    .map((row) => ({ entity_id: row.entity_id, name: row.entity_id.slice(prefix.length) }))
}

async function main() {
  const dbPath = process.env.DB_PATH || 'data.db'
  const args = process.argv.slice(2)
  const refresh = args.includes('--refresh')
  const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`)
  log(`link start: db=${dbPath} refresh=${refresh}`)
  await ensureSchema(dbPath)
  const writer = createWriter(dbPath)

  // ── github:实体 project_key = 自身 owner/name(小写),无需请求 ──
  await runSqlite(
    dbPath,
    `UPDATE entities SET project_key = lower(substr(entity_id, 8)) WHERE kind='github' AND (project_key IS NULL OR ${refresh ? '1=1' : '1=0'});`
  )
  log('github: project_key = 自身 owner/name(批量)')

  const setKey = (entity_id, key) => writer.setProjectKey(entity_id, key)

  // ── npm:取 packument.repository → github owner/name;取不到用自身 entity_id ──
  let nHit = 0
  let nFailed = 0
  let first = true
  const npmTargets = await packageTargets(dbPath, 'npm', refresh)
  for (const { entity_id: eid, name: pkg } of npmTargets) {
    if (!first) await sleep(NPM_GAP_MS)
    first = false
    try {
      const res = await fetchRetry(`https://registry.npmjs.org/${pkg}`, { notFoundOk: true, retries: 2, headers: { 'user-agent': UA } })
      const key = res.status === 404 ? null : npmRepoKey((await res.json()).repository)
      setKey(eid, key || eid)
      if (key) nHit++
    } catch (e) {
      nFailed++
      log(`  npm ${pkg}: 失败跳过:${e instanceof Error ? e.message : e}`)
    }
    if (writer.pending >= 50) await writer.flush()
  }
  await writer.flush()
  log(`npm: 检查 ${npmTargets.length} 条，${nHit} 个链到 github 仓，${nFailed} 个待重试`)

  // ── pypi:取 info.project_urls → github owner/name ──
  let pHit = 0
  nFailed = 0
  first = true
  const pypiTargets = await packageTargets(dbPath, 'pypi', refresh)
  for (const { entity_id: eid, name: pkg } of pypiTargets) {
    if (!first) await sleep(PYPI_GAP_MS)
    first = false
    try {
      const res = await fetchRetry(`https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`, { notFoundOk: true, retries: 2, headers: { 'user-agent': UA } })
      const key = res.status === 404 ? null : pypiRepoKey((await res.json()).info)
      setKey(eid, key || eid)
      if (key) pHit++
    } catch (e) {
      nFailed++
      log(`  pypi ${pkg}: 失败跳过:${e instanceof Error ? e.message : e}`)
    }
    if (writer.pending >= 50) await writer.flush()
  }
  await writer.flush()
  log(`pypi: 检查 ${pypiTargets.length} 条，${pHit} 个链到 github 仓，${nFailed} 个待重试`)

  // ── 其余实体(hf/openrouter/modelscope/vscode)project_key = 自身 ──
  // npm/PyPI 的临时请求失败必须保持 NULL；构建时仍会按 entity_id 单独展示，下轮会再次尝试归并。
  // 已检查但暂时没有仓库链接的包使用自身 key，也会在后续轮次轻量复查，以便元数据补全后自动合并。
  await runSqlite(dbPath, `UPDATE entities SET project_key = entity_id WHERE project_key IS NULL AND kind NOT IN ('npm','pypi');`)
  log('非包来源:project_key = 自身 entity_id；包来源临时失败项保留待重试')
  log('link done')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error('fatal:', e)
    process.exit(1)
  })
}
