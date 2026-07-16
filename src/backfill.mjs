// 冷启动历史回填(阶段 1)。一次性补历史 captured_at 行;靠 metrics 的
// UNIQUE(entity_id,metric,captured_at) ON CONFLICT REPLACE 天然幂等,可安全重跑/断点续跑。
//
// ⚠️ 回填与每日 cron 都写 R2 data.db。跑法固定为:外部先 pull → 本脚本写本地 DB_PATH → 外部 push。
//    必须避开 01:17/13:47 UTC 的 cron 时窗,否则 last-push-wins 丢数据。
//
// 语义(见方法论页):GitHub stars/forks 重建的是"至今仍存在的累计",单调、适合展示,
// 但不等于当时真实瞬时值(被取消的 star / 删除的 fork 不可见)。commits 为默认分支可达累计。
//
// 用法:
//   node --env-file=.env src/backfill.mjs                # 默认:commits npm releases forks pypi(便宜,<1h)
//   node --env-file=.env src/backfill.mjs stars          # 单独长跑(~2.7h),写 cursor 断点续跑
//   node --env-file=.env src/backfill.mjs npm pypi       # 只跑指定项

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createWriter, runSqlite, query } from './db.mjs'
import { fetchRetry, sleep } from './fetch/client.mjs'
import { fetchRepoBatch, chunk, githubGraphQLRequest } from './fetch/github.mjs'
import { GITHUB_REPOS, NPM_PACKAGES, PYPI_PACKAGES } from './entities.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UA = 'aiagent-club'

// ── 日期工具(UTC)──
const isoDay = (d) => d.toISOString().slice(0, 10)
const isoDateTime = (d) => d.toISOString().slice(0, 19) + 'Z'
const addDays = (d, n) => new Date(d.getTime() + n * 86400000)
const dayStart = (s) => new Date(s + 'T00:00:00Z')

async function ensureSchema(dbPath) {
  const schema = await readFile(join(__dirname, '..', 'db', 'schema.sql'), 'utf8')
  await runSqlite(dbPath, schema)
}

/**
 * 断点续跑:某实体某指标是否已回填过历史(>1 个 captured_at,即不只今天那一行)。
 * @param {string} dbPath
 * @param {string} entityId
 * @param {string} metric
 * @returns {Promise<boolean>}
 */
// 判定"已回填过":要有深度历史(跨度 > 30 天),而非只有近几天的日采点。
// 关键:自动发现来的实体每天累积一个点,几天后就 >1 个 captured_at——用旧的"n>1"判定会把它们
// 误判成已回填而永久跳过,深度历史再也补不上。改用首末日期跨度,只有真正回填过(历史回到建库/首发)才跳过。
const BACKFILL_MIN_SPAN_DAYS = 30
async function alreadyBackfilled(dbPath, entityId, metric) {
  const safe = entityId.replace(/'/g, "''")
  const [r] = await query(
    dbPath,
    `SELECT count(DISTINCT captured_at) n, min(captured_at) lo, max(captured_at) hi FROM metrics WHERE entity_id='${safe}' AND metric='${metric}'`
  )
  if (!r || (r.n ?? 0) <= 1) return false
  const span = Math.round((new Date(r.hi + 'T00:00:00Z') - new Date(r.lo + 'T00:00:00Z')) / 86400000)
  return span > BACKFILL_MIN_SPAN_DAYS
}

// GraphQL 请求走 github.mjs 的 githubGraphQLRequest(含瞬时错误退避重试)。
const githubGraphQL = githubGraphQLRequest

// ── npm 日下载(range 端点,≤540 天分段;深度到包首发/2015)──
const NPM_FLOOR = '2015-01-10'

async function backfillNpmDaily({ packages, writer, log, dbPath }) {
  let written = 0
  for (const pkg of packages) {
    const entity_id = `npm:${pkg}`
    if (dbPath && (await alreadyBackfilled(dbPath, entity_id, 'downloads_day'))) {
      log(`  npm ${pkg}: 已有历史,跳过`)
      continue
    }
    if (written > 0) await sleep(500) // 温和,避免 npm downloads API 429
    let end = dayStart(isoDay(new Date())) // 今天 UTC
    let pkgDays = 0
    // 从今往回按 539 天窗口滚动,直到窗口全零(包尚未存在)或触底。
    for (let guard = 0; guard < 40; guard++) {
      const startD = addDays(end, -539)
      const start = isoDay(startD) < NPM_FLOOR ? NPM_FLOOR : isoDay(startD)
      const res = await fetchRetry(`https://api.npmjs.org/downloads/range/${start}:${isoDay(end)}/${pkg}`, {
        notFoundOk: true,
        headers: { 'user-agent': UA },
      })
      if (res.status === 404) {
        log(`  npm ${pkg}: 404(未发布?)`)
        break
      }
      const j = await res.json()
      const arr = Array.isArray(j.downloads) ? j.downloads : []
      let anyNonZero = false
      for (const d of arr) {
        if (typeof d.downloads === 'number' && d.downloads > 0) {
          writer.upsertMetric({ entity_id, metric: 'downloads_day', value: d.downloads, captured_at: d.day, source: 'npm' })
          written++
          pkgDays++
          anyNonZero = true
        }
      }
      const earliest = arr.length ? arr[0].day : null
      if (!anyNonZero || !earliest || earliest <= NPM_FLOOR) break
      end = addDays(dayStart(earliest), -1)
      if (isoDay(end) < NPM_FLOOR) break
    }
    writer.upsertEntity({ entity_id, kind: 'npm', ecosystem: 'global', name: pkg, url: `https://www.npmjs.com/package/${pkg}`, active: 1 })
    await writer.flush()
    log(`  npm ${pkg}: +${pkgDays} 天`)
  }
  return written
}

// ── PyPI 日下载(pypistats overall,仅 180 天,取 without_mirrors)──
async function backfillPypiDaily({ packages, writer, log, dbPath }) {
  let written = 0
  for (const pkg of packages) {
    const entity_id = `pypi:${pkg}`
    if (dbPath && (await alreadyBackfilled(dbPath, entity_id, 'downloads_day'))) {
      log(`  pypi ${pkg}: 已有历史,跳过`)
      continue
    }
    const res = await fetchRetry(`https://pypistats.org/api/packages/${encodeURIComponent(pkg)}/overall`, {
      notFoundOk: true,
      headers: { 'user-agent': UA },
    })
    if (res.status === 404) {
      log(`  pypi ${pkg}: 404`)
      continue
    }
    const j = await res.json()
    const rows = (j.data ?? []).filter((r) => r.category === 'without_mirrors' && typeof r.downloads === 'number')
    for (const r of rows) {
      writer.upsertMetric({ entity_id, metric: 'downloads_day', value: r.downloads, captured_at: r.date, source: 'pypi' })
      written++
    }
    writer.upsertEntity({ entity_id, kind: 'pypi', ecosystem: 'global', name: pkg, url: `https://pypi.org/project/${pkg}/`, active: 1 })
    await writer.flush()
    log(`  pypi ${pkg}: +${rows.length} 天`)
    await sleep(300) // 志愿者服务,温和
  }
  return written
}

// ── GitHub commits 周累计(history(since:createdAt, until:weekEnd){totalCount},alias 打包)──
async function backfillGithubCommits({ repos, token, writer, log, dbPath }) {
  const today = dayStart(isoDay(new Date()))
  let written = 0
  // 先批量取各 repo 的 createdAt(只取尚未回填的)。
  const todo = []
  for (const repo of repos) {
    if (await alreadyBackfilled(dbPath, `github:${repo}`, 'commits')) {
      log(`  github ${repo} commits: 已有历史,跳过`)
    } else todo.push(repo)
  }
  const meta = new Map()
  // fetchRepoBatch 带 history{totalCount} 很重,100 个一批会 504 —— 与日采集器同理用 20。
  for (const batch of chunk(todo, 20)) {
    // 瞬时错误(502/504/超时)不掀翻整个回填:跳过本批,repo 未回填,下次运行补(幂等可续)。
    try {
      const { results } = await fetchRepoBatch(batch, token)
      for (const r of results) meta.set(r.repo, r.meta.createdAt)
    } catch (e) {
      log(`  commits: 批量取 createdAt 失败(${batch.length} repo),跳过本批,下次补:${e instanceof Error ? e.message : e}`)
    }
  }
  for (const repo of todo) {
    const created = meta.get(repo)
    if (!created) {
      log(`  github ${repo}: 无 createdAt,跳过 commits`)
      continue
    }
    try {
    const [owner, name] = [repo.slice(0, repo.indexOf('/')), repo.slice(repo.indexOf('/') + 1)]
    const since = isoDateTime(dayStart(created))
    // 生成每周的 until 边界。
    const weekEnds = []
    let d = addDays(dayStart(created), 7)
    while (d <= today) {
      weekEnds.push(d)
      d = addDays(d, 7)
    }
    weekEnds.push(today)
    let repoWritten = 0
    // 每 40 个 until 打包一个请求(cost≈1)。
    for (const slice of chunk(weekEnds, 40)) {
      const aliases = slice
        .map((w, i) => `w${i}: history(since:"${since}", until:"${isoDateTime(w)}"){ totalCount }`)
        .join(' ')
      const q = `query { repository(owner:"${owner}", name:"${name}"){ defaultBranchRef { target { ... on Commit { ${aliases} } } } } }`
      const j = await githubGraphQL(q, token)
      const target = j.data.repository?.defaultBranchRef?.target
      if (!target) break
      slice.forEach((w, i) => {
        const tc = target[`w${i}`]?.totalCount
        if (typeof tc === 'number') {
          writer.upsertMetric({ entity_id: `github:${repo}`, metric: 'commits', value: tc, captured_at: isoDay(w), source: 'github' })
          repoWritten++
          written++
        }
      })
    }
    await writer.flush()
    log(`  github ${repo} commits: +${repoWritten} 周`)
    } catch (e) {
      log(`  github ${repo} commits: 失败跳过,下次补:${e instanceof Error ? e.message : e}`)
    }
  }
  return written
}

// ── GitHub 累计型(stars/forks/releases):翻页取时间戳 → 按日装桶 → 前缀和 ──
const CUMULATIVE = {
  stars: { connection: 'stargazers', order: 'STARRED_AT', wrap: 'edges', ts: 'starredAt' },
  forks: { connection: 'forks', order: 'CREATED_AT', wrap: 'nodes', ts: 'createdAt' },
  releases: { connection: 'releases', order: 'CREATED_AT', wrap: 'nodes', ts: 'createdAt' },
}

async function backfillGithubCumulative({ repos, token, metric, writer, log, dbPath }) {
  const cfg = CUMULATIVE[metric]
  let written = 0
  for (const repo of repos) {
    if (await alreadyBackfilled(dbPath, `github:${repo}`, metric)) {
      log(`  github ${repo} ${metric}: 已有历史,跳过`)
      continue
    }
    try {
    const [owner, name] = [repo.slice(0, repo.indexOf('/')), repo.slice(repo.indexOf('/') + 1)]
    /** @type {Map<string, number>} */
    const dayCount = new Map()
    let cursor = null
    let pages = 0
    for (;;) {
      const after = cursor ? `"${cursor}"` : 'null'
      // 带上 rateLimit,便于额度耗尽前主动睡到重置(stars 全量会耗尽额度多次)。
      const q = `query { rateLimit { remaining resetAt } repository(owner:"${owner}", name:"${name}"){ ${cfg.connection}(first:100, after:${after}, orderBy:{field:${cfg.order}, direction:ASC}){ pageInfo{ hasNextPage endCursor } ${cfg.wrap} { ${cfg.ts} } } } }`
      const j = await githubGraphQL(q, token)
      const conn = j.data.repository?.[cfg.connection]
      if (!conn) break
      for (const it of conn[cfg.wrap]) {
        const day = String(it[cfg.ts]).slice(0, 10)
        dayCount.set(day, (dayCount.get(day) ?? 0) + 1)
      }
      pages++
      // 额度快见底 → 睡到 resetAt(+2s 缓冲),避免撞硬限速把整批打挂。
      const rl = j.data.rateLimit
      if (rl && rl.remaining < 50) {
        const waitMs = Math.max(0, new Date(rl.resetAt).getTime() - Date.now()) + 2000
        log(`  额度剩 ${rl.remaining},睡 ${Math.round(waitMs / 1000)}s 到重置(${rl.resetAt})`)
        await sleep(waitMs)
      }
      if (!conn.pageInfo.hasNextPage) break
      cursor = conn.pageInfo.endCursor
    }
    const days = [...dayCount.keys()].sort()
    let run = 0
    for (const day of days) {
      run += dayCount.get(day)
      writer.upsertMetric({ entity_id: `github:${repo}`, metric, value: run, captured_at: day, source: 'github' })
      written++
    }
    await writer.flush()
    log(`  github ${repo} ${metric}: 累计 ${run},${days.length} 个活跃日,${pages} 页`)
    } catch (e) {
      log(`  github ${repo} ${metric}: 失败跳过,下次补:${e instanceof Error ? e.message : e}`)
    }
  }
  return written
}

// ── 编排 ──
const TASKS = {
  commits: (ctx) => backfillGithubCommits({ ...ctx, repos: GITHUB_REPOS }),
  npm: (ctx) => backfillNpmDaily({ ...ctx, packages: NPM_PACKAGES }),
  releases: (ctx) => backfillGithubCumulative({ ...ctx, repos: GITHUB_REPOS, metric: 'releases' }),
  forks: (ctx) => backfillGithubCumulative({ ...ctx, repos: GITHUB_REPOS, metric: 'forks' }),
  pypi: (ctx) => backfillPypiDaily({ ...ctx, packages: PYPI_PACKAGES }),
  stars: (ctx) => backfillGithubCumulative({ ...ctx, repos: GITHUB_REPOS, metric: 'stars' }),
}
const DEFAULT_TASKS = ['commits', 'npm', 'releases', 'forks', 'pypi'] // 便宜项;stars 需显式指定

async function main() {
  const dbPath = process.env.DB_PATH || 'data.db'
  const token = process.env.GITHUB_TOKEN
  const requested = process.argv.slice(2)
  const names = requested.length ? requested : DEFAULT_TASKS
  const needToken = names.some((n) => ['commits', 'releases', 'forks', 'stars'].includes(n))
  if (needToken && !token) throw new Error('missing GITHUB_TOKEN')

  const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`)
  log(`backfill start: db=${dbPath} tasks=${names.join(',')}`)
  await ensureSchema(dbPath)
  const writer = createWriter(dbPath)

  for (const name of names) {
    const task = TASKS[name]
    if (!task) {
      log(`unknown task: ${name}(跳过)`)
      continue
    }
    log(`── task: ${name} ──`)
    const n = await task({ token, writer, log, dbPath })
    log(`task ${name}: 写入 ${n} 行`)
  }
  await writer.flush()
  log('backfill done')
}

main().catch((e) => {
  console.error('fatal:', e)
  process.exit(1)
})
