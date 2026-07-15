// 自动发现 — 把"追踪什么"从手工清单扩展到全生态。
//
// 思路:GitHub 按 topic/关键词搜索 + npm 按关键词搜索 → 过滤(星数/活跃/去噪)→ 去重(已在种子里的跳过)
//        → 写 src/discovered.json。entities.mjs 在导入时把 discovered 并进 SEED_* 集合,collector 自动开始为新项目抓指标。
//
// 手工种子(entities.mjs 里的 SEED_*)是策展基准,永远保留;发现只做"增量补全",且门槛保守以保质量。
// 运行:node --env-file=.env src/discover.mjs   (需要 GITHUB_TOKEN;npm 公开无需 key)
//
// 幂等:每次全量重算 discovered.json。删项目只需调高门槛或加进排除名单后重跑;历史 metrics 不受影响(留存)。

import { writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { githubGraphQLRequest, chunk } from './fetch/github.mjs'
import { getJson, sleep } from './fetch/client.mjs'
import { SEED_GITHUB_REPOS, SEED_NPM_PACKAGES, SEED_PYPI_PACKAGES } from './entities.mjs'

const OUT_PATH = fileURLToPath(new URL('./discovered.json', import.meta.url))

// ── 门槛(保守,重质量;调这里控制扩容规模)──
const GH_MIN_STARS = 300 // 低于此不收:agent 生态里 300 星以下噪声/半成品居多
const GH_ALIVE_MONTHS = 12 // 最近一次 push 超过这么久 = 已死,不收

// 刷星识别(on-thesis:star 可刷)。真实巨星仓"自建仓至今的日均新增"约 200–250(open-webui 227、
// firecrawl 207、gemini-cli ~230);刷星仓远超此值(ECC ~1280、ponytail ~2500、hermes ~600)。
// 只审高星仓(刷星都冲大数,小仓不值得刷),日均超阈值判为刷星,剔除。
const FARM_SCRUTINY_STARS = 15000 // 仅对 star 高于此的仓做速率审查
const FARM_MAX_STARS_PER_DAY = 400 // 自建仓至今日均新增 star 上限(超出 = 疑似刷星)

// GitHub 搜索面 —— 只保留 agent / agentic / MCP 核心 topic。每条已在服务端加 stars/archived/fork 过滤。
// 刻意剔除 rag / llmops / llm-framework 及泛关键词搜索:它们把 OCR/监控/学习仓等非 agent 巨星拖进来,信噪比差。
const GH_QUERIES = [
  'topic:ai-agents',
  'topic:ai-agent',
  'topic:llm-agent',
  'topic:agentic',
  'topic:agentic-ai',
  'topic:autonomous-agents',
  'topic:multi-agent',
  'topic:multi-agent-systems',
  'topic:ai-agents-framework',
  'topic:agent-framework',
  'topic:mcp',
  'topic:mcp-server',
  'topic:mcp-servers',
  'topic:model-context-protocol',
]

// npm 关键词面。search 只给相关性分(噪声高),故拿到候选名后再用真实"周下载量"过滤定质量。
const NPM_KEYWORDS = ['ai-agent', 'llm-agent', 'agentic', 'autonomous-agent', 'mcp', 'model-context-protocol']
const NPM_MIN_WEEKLY = 3000 // 周下载量门槛:刷不出来的真实使用量,低于此多为玩具/个人包
const NPM_DL_API = 'https://api.npmjs.org/downloads/point/last-week'

// PyPI 无公开搜索 API → 从已发现的 Python GitHub 仓推导候选包名(仓名规范化),再用 pypistats 月下载量验证+过滤。
const PYPI_MIN_MONTHLY = 20000 // 月下载量门槛
const PYPISTATS_API = 'https://pypistats.org/api/packages'

// 去噪:名字/描述命中这些词多为教程/清单/课程,而非可追踪的工具/框架。
const JUNK_RE =
  /\b(awesome|tutorials?|courses?|roadmap|cheat[-\s]?sheets?|handbook|bootcamp|curriculum|papers?|reading[-\s]?list|interview|leetcode|study|learn(ing)?[-\s]?path|100[-\s]?days|from[-\s]?scratch|build[-\s]?your[-\s]?own|for[-\s]?beginners|examples?|demos?|playground|starter[-\s]?kit|boilerplate|template|checklist|best[-\s]?practices?|system[-\s]?prompts?|prompt[-\s]?(leaks?|collections?)|collection[-\s]?of|list[-\s]?of|curated)\b/i

// 明确排除(topic 误挂但明显非 agent 生态的高星仓 / 内容合集)。owner/name 小写。
const GH_EXCLUDE = new Set([
  'paddlepaddle/paddleocr',
  'netdata/netdata',
  'snailclimb/javaguide',
  'thedaviddias/front-end-checklist',
  'asgeirtj/system_prompts_leaks',
  'zhulinsen/daily_stock_analysis',
  'sansan0/trendradar',
  'koala73/worldmonitor',
  'shanraisshan/claude-code-best-practice',
])

/** n 个月前的 'YYYY-MM-DD'。 */
function monthsAgo(n) {
  const d = new Date()
  d.setMonth(d.getMonth() - n)
  return d.toISOString().slice(0, 10)
}

/** 一次 GitHub 搜索(单页 100 条,sort:stars 已够);返回原始 Repository 节点数组。 */
async function ghSearch(queryText, token) {
  const full = `${queryText} stars:>=${GH_MIN_STARS} archived:false fork:false sort:stars-desc`
  const query = `query {
    search(query: ${JSON.stringify(full)}, type: REPOSITORY, first: 100) {
      nodes {
        ... on Repository {
          nameWithOwner
          url
          description
          stargazerCount
          isArchived
          isFork
          pushedAt
          createdAt
          primaryLanguage { name }
        }
      }
    }
    rateLimit { remaining resetAt }
  }`
  const json = await githubGraphQLRequest(query, token)
  return json.data.search.nodes.filter(Boolean)
}

/** 收集 + 过滤 + 去重 GitHub 候选。 */
async function discoverGithub(token, log) {
  const aliveCutoff = monthsAgo(GH_ALIVE_MONTHS)
  // 只对种子去重:重跑发现应完整重建 discovered.json,不能因"上次发现已并入导出集"而把旧发现当成重复丢掉。
  const seen = new Set(SEED_GITHUB_REPOS.map((r) => r.toLowerCase()))
  const nowMs = Date.now()
  /** @type {Map<string, any>} */
  const found = new Map() // key: lower(repo) → { repo, stars, desc, lang }
  let dropped = { junk: 0, dead: 0, dup: 0, farm: 0 }

  /** 疑似刷星:仅审高星仓,自建仓至今日均新增 star 超阈值判真。 */
  const isStarFarm = (n) => {
    if (n.stargazerCount < FARM_SCRUTINY_STARS || !n.createdAt) return false
    const ageDays = Math.max(14, (nowMs - Date.parse(n.createdAt)) / 86400000)
    return n.stargazerCount / ageDays > FARM_MAX_STARS_PER_DAY
  }

  for (const q of GH_QUERIES) {
    let nodes = []
    try {
      nodes = await ghSearch(q, token)
    } catch (e) {
      log(`  [gh] 查询失败,跳过:${q} — ${e instanceof Error ? e.message : e}`)
      continue
    }
    for (const n of nodes) {
      const repo = n.nameWithOwner
      const key = repo.toLowerCase()
      if (seen.has(key) || GH_EXCLUDE.has(key)) {
        dropped.dup++
        continue
      }
      const text = `${repo} ${n.description ?? ''}`
      if (JUNK_RE.test(text)) {
        dropped.junk++
        continue
      }
      if (!n.pushedAt || n.pushedAt.slice(0, 10) < aliveCutoff) {
        dropped.dead++
        continue
      }
      if (isStarFarm(n)) {
        const perDay = Math.round(n.stargazerCount / Math.max(14, (nowMs - Date.parse(n.createdAt)) / 86400000))
        log(`  [gh] 疑似刷星,剔除:${repo}(${n.stargazerCount}★,建仓至今日均 ${perDay}/天)`)
        dropped.farm++
        continue
      }
      if (!found.has(key)) {
        found.set(key, {
          repo,
          stars: n.stargazerCount,
          desc: (n.description ?? '').slice(0, 200),
          lang: n.primaryLanguage?.name ?? null,
        })
      }
    }
    log(`  [gh] "${q}" → ${nodes.length} 命中,累计候选 ${found.size}`)
    await sleep(300) // 温和,别打满搜索限速(搜索额度独立且较紧)
  }

  const list = [...found.values()].sort((a, b) => b.stars - a.stars)
  log(`  [gh] 新候选 ${list.length}(去重 ${dropped.dup},去噪 ${dropped.junk},不活跃 ${dropped.dead},刷星 ${dropped.farm})`)
  return list
}

/** 一次 npm 搜索。 */
async function npmSearch(keyword) {
  const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent('keywords:' + keyword)}&size=250`
  const json = await getJson(url, { headers: { 'user-agent': 'aiagent-club-discover' } })
  return json.objects ?? []
}

/** 批量取非 scoped 包周下载量(bulk API,单次≤100);返回 name→weekly。 */
async function npmWeeklyBulk(names, log) {
  const out = new Map()
  for (const grp of chunk(names, 100)) {
    try {
      const j = await getJson(`${NPM_DL_API}/${grp.join(',')}`, { headers: { 'user-agent': 'aiagent-club-discover' } })
      // 单包时返回 {downloads,...};多包时返回 { name: {downloads,...} }。
      if (grp.length === 1) {
        if (typeof j?.downloads === 'number') out.set(grp[0], j.downloads)
      } else {
        for (const [k, v] of Object.entries(j)) if (v && typeof v.downloads === 'number') out.set(k, v.downloads)
      }
    } catch (e) {
      log(`  [npm] 下载量批次失败(${grp.length} 包):${e instanceof Error ? e.message : e}`)
    }
    await sleep(250)
  }
  return out
}

/** scoped 包(@scope/name)只能逐个查周下载量。fail-fast(少重试短超时),不存在/失败返回 null。 */
async function npmWeeklyOne(name) {
  try {
    const j = await getJson(`${NPM_DL_API}/${name}`, {
      headers: { 'user-agent': 'aiagent-club-discover' },
      notFoundOk: true,
      retries: 1,
      baseDelayMs: 300,
      timeoutMs: 8000,
    })
    return typeof j?.downloads === 'number' ? j.downloads : null
  } catch {
    return null
  }
}

/** 有界并发跑一批异步任务。npm/pypistats 的 CDN 扛得住小并发,把上百个逐个请求压成几秒。 */
async function pool(items, concurrency, worker) {
  const results = new Array(items.length)
  let next = 0
  async function run() {
    while (next < items.length) {
      const i = next++
      results[i] = await worker(items[i], i)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, run))
  return results
}

/** 收集 npm 候选 → 按真实周下载量过滤。 */
async function discoverNpm(log) {
  const seen = new Set(SEED_NPM_PACKAGES.map((p) => p.toLowerCase()))
  /** @type {Map<string, string>} */
  const cand = new Map() // key: lower(name) → name(原样)
  const desc = new Map()
  let dropped = { junk: 0, dup: 0 }

  for (const kw of NPM_KEYWORDS) {
    let objs = []
    try {
      objs = await npmSearch(kw)
    } catch (e) {
      log(`  [npm] 搜索失败,跳过:${kw} — ${e instanceof Error ? e.message : e}`)
      continue
    }
    for (const o of objs) {
      const name = o.package?.name
      if (!name) continue
      const key = name.toLowerCase()
      if (seen.has(key)) {
        dropped.dup++
        continue
      }
      if (JUNK_RE.test(`${name} ${o.package?.description ?? ''}`)) {
        dropped.junk++
        continue
      }
      if (!cand.has(key)) {
        cand.set(key, name)
        desc.set(key, (o.package?.description ?? '').slice(0, 200))
      }
    }
    log(`  [npm] "${kw}" → ${objs.length} 命中,累计候选 ${cand.size}`)
    await sleep(300)
  }

  // 按真实周下载量过滤:非 scoped 走 bulk,scoped 逐个。
  const names = [...cand.values()]
  const scoped = names.filter((n) => n.startsWith('@'))
  const plain = names.filter((n) => !n.startsWith('@'))
  log(`  [npm] 候选 ${names.length}(scoped ${scoped.length}),取周下载量过滤(≥${NPM_MIN_WEEKLY})…`)

  const weekly = await npmWeeklyBulk(plain, log)
  // scoped 无 bulk → 有界并发(10 路)逐个查,几秒完成。
  const scopedDl = await pool(scoped, 10, (s) => npmWeeklyOne(s))
  scoped.forEach((s, i) => {
    if (scopedDl[i] != null) weekly.set(s, scopedDl[i])
  })

  const list = []
  for (const name of names) {
    const w = weekly.get(name)
    if (w != null && w >= NPM_MIN_WEEKLY) list.push({ name, weekly: w, desc: desc.get(name.toLowerCase()) ?? '' })
  }
  list.sort((a, b) => b.weekly - a.weekly)
  log(`  [npm] 过关 ${list.length}(去重 ${dropped.dup},去噪 ${dropped.junk},下载量不足 ${names.length - list.length})`)
  return list
}

/** pypistats recent:取月下载量;不存在/失败返回 null。发现是尽力而为,故 fail-fast(少重试、短超时),
 *  避免个别 429/超时触发长退避把整轮拖死。 */
async function pypiMonthly(pkg) {
  try {
    const res = await getJson(`${PYPISTATS_API}/${encodeURIComponent(pkg)}/recent`, {
      headers: { 'user-agent': 'aiagent-club-discover' },
      notFoundOk: true,
      retries: 1,
      baseDelayMs: 400,
      timeoutMs: 8000,
    })
    const m = res?.data?.last_month
    return typeof m === 'number' ? m : null
  } catch {
    return null
  }
}

/** PyPI 规范化包名:小写,下划线→连字符(PEP 503)。 */
function normalizePypi(name) {
  return name.toLowerCase().replace(/[_.]+/g, '-')
}

/**
 * PyPI 发现:从已发现的 Python GitHub 仓推候选包名(仓名规范化),pypistats 验证 + 月下载量过滤。
 * @param {Array<{repo:string, lang:string|null}>} githubList
 */
async function discoverPypi(githubList, log) {
  const seen = new Set(SEED_PYPI_PACKAGES.map((p) => normalizePypi(p)))
  // 候选:Python 仓的 name 段规范化,去重、排除已在种子的。按 star 降序取前 PYPI_MAX_CANDIDATES 个,
  // 既优先高价值仓,又给 pypistats(志愿者服务)逐个验证设一个有界的量。
  const PYPI_MAX_CANDIDATES = 200
  const cand = new Map() // norm → { guess, repo }
  for (const g of [...githubList].filter((g) => g.lang === 'Python').sort((a, b) => b.stars - a.stars)) {
    if (cand.size >= PYPI_MAX_CANDIDATES) break
    const nameSeg = g.repo.slice(g.repo.indexOf('/') + 1)
    const guess = normalizePypi(nameSeg)
    if (!guess || seen.has(guess) || cand.has(guess)) continue
    if (JUNK_RE.test(nameSeg)) continue
    cand.set(guess, { guess, repo: g.repo })
  }
  const candArr = [...cand.values()]
  log(`  [pypi] Python 仓推出候选 ${candArr.length},pypistats 并发验证(≥${PYPI_MIN_MONTHLY}/月)…`)

  // 有界并发(6 路;pypistats 是志愿者服务,并发压低些)。
  const monthlies = await pool(candArr, 6, ({ guess }) => pypiMonthly(guess))
  const list = []
  candArr.forEach(({ guess, repo }, i) => {
    const monthly = monthlies[i]
    if (monthly != null && monthly >= PYPI_MIN_MONTHLY) list.push({ name: guess, monthly, repo })
  })
  list.sort((a, b) => b.monthly - a.monthly)
  log(`  [pypi] 过关 ${list.length} / 候选 ${candArr.length}`)
  return list
}

async function main() {
  const token = process.env.GITHUB_TOKEN
  if (!token) throw new Error('missing GITHUB_TOKEN')
  const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`)

  log(
    `discover start: gh ≥${GH_MIN_STARS}★ & ${GH_ALIVE_MONTHS}月活跃;npm ≥${NPM_MIN_WEEKLY}/周;pypi ≥${PYPI_MIN_MONTHLY}/月`
  )
  log('GitHub 发现:')
  const github = await discoverGithub(token, log)
  log('npm 发现:')
  const npm = await discoverNpm(log)
  log('PyPI 发现:')
  const pypi = await discoverPypi(github, log)

  const out = {
    generatedAt: new Date().toISOString(),
    thresholds: { GH_MIN_STARS, GH_ALIVE_MONTHS, NPM_MIN_WEEKLY, PYPI_MIN_MONTHLY },
    github, // [{ repo, stars, desc, lang }]
    npm, // [{ name, weekly, desc }]
    pypi, // [{ name, monthly, repo }]
  }
  await writeFile(OUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8')
  log(`写入 ${OUT_PATH}:github +${github.length},npm +${npm.length},pypi +${pypi.length}`)
  log(
    `合并后规模预估:github ${SEED_GITHUB_REPOS.length}→${SEED_GITHUB_REPOS.length + github.length},` +
      `npm ${SEED_NPM_PACKAGES.length}→${SEED_NPM_PACKAGES.length + npm.length},` +
      `pypi ${SEED_PYPI_PACKAGES.length}→${SEED_PYPI_PACKAGES.length + pypi.length}`
  )
}

main().catch((e) => {
  console.error('discover fatal:', e)
  process.exit(1)
})
