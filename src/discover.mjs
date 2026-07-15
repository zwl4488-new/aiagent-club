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
import { githubGraphQLRequest } from './fetch/github.mjs'
import { getJson, sleep } from './fetch/client.mjs'
import { SEED_GITHUB_REPOS, SEED_NPM_PACKAGES } from './entities.mjs'

const OUT_PATH = fileURLToPath(new URL('./discovered.json', import.meta.url))

// ── 门槛(保守,重质量;调这里控制扩容规模)──
const GH_MIN_STARS = 300 // 低于此不收:agent 生态里 300 星以下噪声/半成品居多
const GH_ALIVE_MONTHS = 12 // 最近一次 push 超过这么久 = 已死,不收
const NPM_MIN_POPULARITY = 0.08 // npm search 的 popularity 分(0..1),太低多为个人玩具

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

// npm 关键词发现:暂停。npm search 只给相关性分,不给下载量;关键词面(agents/mcp)噪声极高
// (chat / agent-device / @chat-adapter/* 一类),缺下载量无法定质量门槛。留待"按周下载量过滤"的后续实现。
const NPM_KEYWORDS = []
const DISCOVER_NPM = false

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

/** 收集 + 过滤 + 去重 npm 候选。 */
async function discoverNpm(log) {
  const seen = new Set(SEED_NPM_PACKAGES.map((p) => p.toLowerCase()))
  /** @type {Map<string, any>} */
  const found = new Map()
  let dropped = { pop: 0, junk: 0, dup: 0 }

  for (const kw of NPM_KEYWORDS) {
    let objs = []
    try {
      objs = await npmSearch(kw)
    } catch (e) {
      log(`  [npm] 查询失败,跳过:${kw} — ${e instanceof Error ? e.message : e}`)
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
      const pop = o.score?.detail?.popularity ?? 0
      if (pop < NPM_MIN_POPULARITY) {
        dropped.pop++
        continue
      }
      const text = `${name} ${o.package?.description ?? ''}`
      if (JUNK_RE.test(text)) {
        dropped.junk++
        continue
      }
      if (!found.has(key)) {
        found.set(key, { name, popularity: Number(pop.toFixed(3)), desc: (o.package?.description ?? '').slice(0, 200) })
      }
    }
    log(`  [npm] "${kw}" → ${objs.length} 命中,累计候选 ${found.size}`)
    await sleep(400)
  }

  const list = [...found.values()].sort((a, b) => b.popularity - a.popularity)
  log(`  [npm] 新候选 ${list.length}(去重跳过 ${dropped.dup},人气过低 ${dropped.pop},去噪 ${dropped.junk})`)
  return list
}

async function main() {
  const token = process.env.GITHUB_TOKEN
  if (!token) throw new Error('missing GITHUB_TOKEN')
  const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`)

  log(`discover start: gh 门槛 ≥${GH_MIN_STARS}★ & ${GH_ALIVE_MONTHS} 月内活跃;npm popularity ≥${NPM_MIN_POPULARITY}`)
  log('GitHub 发现:')
  const github = await discoverGithub(token, log)
  let npm = []
  if (DISCOVER_NPM) {
    log('npm 发现:')
    npm = await discoverNpm(log)
  } else {
    log('npm 发现:已暂停(见 NPM_KEYWORDS 注释),本轮只发现 GitHub')
  }

  const out = {
    generatedAt: new Date().toISOString(),
    thresholds: { GH_MIN_STARS, GH_ALIVE_MONTHS, NPM_MIN_POPULARITY },
    github, // [{ repo, stars, desc, lang }]
    npm, // [{ name, popularity, desc }]
    pypi: [], // PyPI 无公开搜索 API,留空;后续从发现的 GitHub 仓推导
  }
  await writeFile(OUT_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8')
  log(`写入 ${OUT_PATH}:github +${github.length},npm +${npm.length}`)
  log(`合并后规模预估:github ${SEED_GITHUB_REPOS.length}→${SEED_GITHUB_REPOS.length + github.length}`)
}

main().catch((e) => {
  console.error('discover fatal:', e)
  process.exit(1)
})
