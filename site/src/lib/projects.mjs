// 项目聚合层 —— 把同一项目的多源实体绑一起(靠 project_key,见 src/link.mjs),
// 每个项目 = 多源属性(star / 各源下载 / 动量),算综合分做旗舰榜;并算"热度 vs 真实使用"落差。
//
// project_key 由 src/link.mjs 从包元数据声明的 github 仓解析(权威),同 key = 同一项目。
// 下面 buildProjects() 是新的统一模型;hypeVsUsage() 是老的手工映射版,首页仍在用,逐步迁移。

import { allEntities, latestIndexSnapshot, latestMetricsAll, movers } from './data.mjs'
import { buildEntityPages } from './detail.mjs'

const WEEK_TO_MONTH = 4.345 // 周下载 → 月下载 近似
const DAY_MS = 86_400_000

export const METHODOLOGY_VERSION = '2.0'
export const SIGNAL_FRESHNESS_DAYS = 2
export const INDEX_MIN_SIGNAL_COVERAGE = 2
export const INDEX_MIN_SOURCE_COVERAGE = 2

/** 两个 ISO 日期的间隔；无效日期返回 Infinity，未来点按 0 天处理。 */
export function metricAgeDays(snapshot, observedAt) {
  if (!snapshot || !observedAt) return Infinity
  const ref = Date.parse(`${String(snapshot).slice(0, 10)}T00:00:00Z`)
  const seen = Date.parse(`${String(observedAt).slice(0, 10)}T00:00:00Z`)
  if (!Number.isFinite(ref) || !Number.isFinite(seen)) return Infinity
  return Math.max(0, Math.floor((ref - seen) / DAY_MS))
}

/** 最新点是否能进入本次快照的评分。 */
export function isFreshMetric(point, snapshot, maxAgeDays = SIGNAL_FRESHNESS_DAYS) {
  return Boolean(point?.captured_at) && metricAgeDays(snapshot, point.captured_at) <= maxAgeDays
}

/** 维度级状态：fresh 才可评分；stale 表示有历史值但已超 SLA。 */
function dimensionState(candidates, snapshot) {
  const present = candidates.filter((row) => row?.captured_at)
  const fresh = present.filter((row) => isFreshMetric(row, snapshot))
  const pool = fresh.length ? fresh : present
  const observedAt = pool.map((row) => row.captured_at).sort().at(-1) ?? null
  return {
    status: fresh.length ? 'fresh' : present.length ? 'stale' : 'missing',
    available: fresh.length > 0,
    observedAt,
    ageDays: observedAt ? metricAgeDays(snapshot, observedAt) : null,
  }
}

/** 主榜、观察池分组。buildProjects 已经保证两组内的稳定排序。 */
export function splitProjectIndex(projects) {
  return {
    ranked: projects.filter((project) => project.eligible),
    observed: projects.filter((project) => !project.eligible),
  }
}

/** entity_id → 统一项目，用于所有发现入口优先落到项目层。 */
export function buildEntityProjectMap(projects) {
  const map = new Map()
  for (const project of projects) {
    for (const member of project.members || []) {
      const existing = map.get(member.entity_id)
      if (existing && existing.key !== project.key) throw new Error(`entity ${member.entity_id} belongs to multiple projects`)
      map.set(member.entity_id, project)
    }
  }
  return map
}

/** 有统一项目时优先项目页，否则保留来源证据页。 */
export function entityPreferredHref(entityId, projectMap, base = '') {
  const project = projectMap.get(entityId)
  return project ? `${base}/project/${project.slug}` : `${base}/p/${entityId.replace(':', '/')}`
}

/** 某实体的"月等效下载量"(真实使用信号,跨源可比)。 */
function monthlyDownloads(kind, m) {
  if (kind === 'npm') return (m.downloads_week?.value ?? 0) * WEEK_TO_MONTH
  if (kind === 'pypi') return m.downloads_month?.value ?? 0
  return 0
}

/** 给 projects 按 field 打百分位(0–100,只在 >0 的集合内排),写入 outField。 */
function addPercentile(projects, field, outField, reference = projects) {
  const vals = reference.map((p) => p[field]).filter((v) => v > 0).sort((a, b) => a - b)
  const n = vals.length
  for (const p of projects) {
    if (!(p[field] > 0) || n === 0) {
      p[outField] = 0
      continue
    }
    let lo = 0
    let hi = n
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (vals[mid] <= p[field]) lo = mid + 1
      else hi = mid
    }
    p[outField] = Math.round((lo / n) * 100)
  }
}

/**
 * 统一项目模型 + 综合分。返回按综合分降序的项目数组:
 *   { key, name, slug, url, description, kinds, members, stars, usage, momentum,
 *     usagePct, attnPct, momPct, score }
 * 综合分 = usage 45% + 动量 30% + 关注 25%；缺失分量按 0 计且不重新分配权重。
 * 百分位只以满足当前跨来源门槛的主榜 cohort 为参照，观察池不会改写主榜分布。
 */
export async function buildProjects() {
  const [ents, latest, starMovers, snapshot] = await Promise.all([allEntities(), latestMetricsAll(), movers('github', 'stars', 7), latestIndexSnapshot()])
  const moverByEntity = new Map(starMovers.map((row) => [row.entity_id, row]))

  /** @type {Map<string, any[]>} */
  const groups = new Map()
  for (const e of ents) {
    const key = e.project_key || e.entity_id
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(e)
  }

  const met = (e) => latest.get(e.entity_id) || {}
  const projects = []
  for (const [key, members] of groups) {
    const gh = members.filter((e) => e.kind === 'github')
    const starCandidates = gh
      .map((entity) => ({ ...(met(entity).stars || {}), kind: 'github' }))
      .filter((point) => point.captured_at)
    const freshStars = starCandidates.filter((point) => isFreshMetric(point, snapshot))
    const stars = freshStars.reduce((mx, point) => Math.max(mx, point.value ?? 0), 0)

    const momentumCandidates = gh
      .map((entity) => {
        const row = moverByEntity.get(entity.entity_id)
        return row ? { value: row.delta, captured_at: row.observed_at, kind: 'github' } : null
      })
      .filter(Boolean)
    const freshMomentum = momentumCandidates.filter((point) => isFreshMetric(point, snapshot))
    const momentum = freshMomentum.length ? Math.max(...freshMomentum.map((point) => point.value)) : 0

    // 同一 registry 的多包 monorepo 取最大值，不直接相加，避免拆包数量变成排名优势。
    const adoptionCandidates = members.map((entity) => {
      const metrics = met(entity)
      if (entity.kind === 'npm' && metrics.downloads_week) {
        return { value: monthlyDownloads(entity.kind, metrics), captured_at: metrics.downloads_week.captured_at, kind: entity.kind }
      }
      if (entity.kind === 'pypi') {
        const point = metrics.downloads_month
        if (point) return { value: monthlyDownloads(entity.kind, metrics), captured_at: point.captured_at, kind: entity.kind }
      }
      return null
    }).filter(Boolean)
    const freshAdoption = adoptionCandidates.filter((point) => isFreshMetric(point, snapshot))
    const adoptionByKind = new Map()
    for (const point of freshAdoption) {
      const current = adoptionByKind.get(point.kind)
      if (!current || point.value > current.value) adoptionByKind.set(point.kind, point)
    }
    const usage = [...adoptionByKind.values()].reduce((sum, point) => sum + point.value, 0)

    const signals = {
      adoption: dimensionState(adoptionCandidates, snapshot),
      momentum: dimensionState(momentumCandidates, snapshot),
      attention: dimensionState(starCandidates, snapshot),
    }
    const coverage = Object.values(signals).filter((signal) => signal.available).length
    const signalSources = new Set([...adoptionByKind.keys()])
    if (signals.attention.available || signals.momentum.available) signalSources.add('github')
    // 展示名:优先 github 仓名(取 owner/name 的 name 段,保留原大小写);否则取下载量最高的成员名。
    // 仓名太泛(python-sdk / cli / core …)时带上 owner,免得旗舰榜出现一堆同名"sdk"。
    const byUse = members.slice().sort((a, b) => monthlyDownloads(b.kind, met(b)) - monthlyDownloads(a.kind, met(a)))
    const anchor = gh[0] || byUse[0]
    const GENERIC = new Set(['sdk', 'cli', 'core', 'api', 'python-sdk', 'typescript-sdk', 'js', 'py', 'agents', 'server', 'client', 'app'])
    const repoName = gh[0] ? gh[0].name.split('/').pop() : anchor.name
    const name = gh[0] && GENERIC.has(repoName.toLowerCase()) ? gh[0].name : repoName
    const description = gh[0]?.description || anchor.description || members.find((x) => x.description)?.description || null
    const kinds = [...new Set(members.map((e) => e.kind))]
    projects.push({
      key,
      name,
      slug: anchor.entity_id.replace(':', '/'), // 复用锚点实体的详情页
      url: anchor.url,
      description,
      kinds,
      members,
      stars,
      usage,
      momentum,
      signals,
      coverage,
      sourceCoverage: signalSources.size,
      snapshot,
      methodologyVersion: METHODOLOGY_VERSION,
    })
  }

  // 指数只收"软件项目"(有 github / npm / pypi 成员)。纯模型/扩展(openrouter / modelscope /
  // vscode / 未链到仓库的 huggingface)不是"项目",各有自己的榜,不进综合指数,免得榜里混一堆 0 分模型。
  const SOFTWARE = new Set(['github', 'npm', 'pypi'])
  const software = projects.filter((p) => p.kinds.some((k) => SOFTWARE.has(k)))

  // 单源观察项不应改写主榜的百分位分布。
  const cohort = software.filter((project) => project.coverage >= INDEX_MIN_SIGNAL_COVERAGE && project.sourceCoverage >= INDEX_MIN_SOURCE_COVERAGE)
  addPercentile(software, 'usage', 'usagePct', cohort)
  addPercentile(software, 'stars', 'attnPct', cohort)
  addPercentile(software, 'momentum', 'momPct', cohort)
  // 不做权重归一:缺的分量按 0 计。这样综合分高的项目必须"多个信号都强"(真实使用 + 动量 + 关注),
  // 单一可刷信号(只有 star,或只有下载)顶多拿到自己那份权重 —— 契合"没有单一可刷指标能主导"的主线。
  // 使用量 45%(最难造假,权重最高)+ 动量 30% + 关注 25%。
  for (const p of software) {
    p.score = Math.round(0.45 * p.usagePct + 0.3 * p.momPct + 0.25 * p.attnPct)
    p.eligible = cohort.includes(p)
  }
  const ranked = software.filter((project) => project.eligible).sort((a, b) => b.score - a.score || b.coverage - a.coverage || a.name.localeCompare(b.name))
  ranked.forEach((project, index) => { project.rank = index + 1 })
  // 观察池没有正式名次：只按证据覆盖分层，同层按名称稳定排列，不用内部试算分暗中排序。
  const observed = software.filter((project) => !project.eligible).sort((a, b) => b.coverage - a.coverage || a.name.localeCompare(b.name))
  return [...ranked, ...observed]
}

/**
 * 逐项目详情页数据:把 buildProjects 的项目 × buildEntityPages 的富实体页(含 sparkline/指标)绑一起。
 * 返回每个项目一条:综合分/分项/rank + memberPages(各源的详情页数据,按主指标降序)+ intro/slug。
 * slug = 锚点实体的详情 slug(如 github/browser-use/browser-use),作 /project/[...slug] 路径。
 */
export async function buildProjectPages() {
  const [entityPages, projects] = await Promise.all([buildEntityPages(), buildProjects()])
  const pageById = new Map(entityPages.map((p) => [p.entity_id, p]))
  const { ranked } = splitProjectIndex(projects)
  return projects.map((proj) => {
    const memberPages = proj.members
      .map((m) => pageById.get(m.entity_id))
      .filter(Boolean)
      .sort((a, b) => (b.primaryValue ?? -1) - (a.primaryValue ?? -1))
    const intro = memberPages.find((pg) => pg.intro)?.intro || proj.description || null
    return {
      key: proj.key,
      name: proj.name,
      slug: proj.slug,
      url: proj.url,
      kinds: proj.kinds,
      description: proj.description,
      intro,
      stars: proj.stars,
      usage: proj.usage,
      momentum: proj.momentum,
      usagePct: proj.usagePct,
      momPct: proj.momPct,
      attnPct: proj.attnPct,
      score: proj.score,
      eligible: proj.eligible,
      coverage: proj.coverage,
      sourceCoverage: proj.sourceCoverage,
      signals: proj.signals,
      snapshot: proj.snapshot,
      methodologyVersion: proj.methodologyVersion,
      rank: proj.rank ?? null,
      total: ranked.length,
      members: proj.members,
      memberPages,
    }
  })
}

// ── 以下为老的手工映射版(首页 hype 模块仍在用) ──

/**
 * @typedef {{ name: string, gh: string, pypi?: string, npm?: string }} ProjectLink
 */

/** @type {ProjectLink[]} */
export const PROJECTS = [
  { name: 'LangChain', gh: 'langchain-ai/langchain', pypi: 'langchain', npm: 'langchain' },
  { name: 'LangGraph', gh: 'langchain-ai/langgraph', pypi: 'langgraph', npm: '@langchain/langgraph' },
  { name: 'LlamaIndex', gh: 'run-llama/llama_index', pypi: 'llama-index', npm: 'llamaindex' },
  { name: 'CrewAI', gh: 'crewAIInc/crewAI', pypi: 'crewai' },
  { name: 'AutoGen', gh: 'microsoft/autogen', pypi: 'autogen-agentchat' },
  { name: 'Pydantic AI', gh: 'pydantic/pydantic-ai', pypi: 'pydantic-ai' },
  { name: 'DSPy', gh: 'stanfordnlp/dspy', pypi: 'dspy' },
  { name: 'smolagents', gh: 'huggingface/smolagents', pypi: 'smolagents' },
  { name: 'Agno', gh: 'agno-agi/agno', pypi: 'agno' },
  { name: 'LiteLLM', gh: 'BerriAI/litellm', pypi: 'litellm' },
  { name: 'Haystack', gh: 'deepset-ai/haystack', pypi: 'haystack-ai' },
  { name: 'browser-use', gh: 'browser-use/browser-use', pypi: 'browser-use' },
  { name: 'Firecrawl', gh: 'mendableai/firecrawl', pypi: 'firecrawl-py' },
  { name: 'Crawl4AI', gh: 'unclecode/crawl4ai', pypi: 'crawl4ai' },
  { name: 'Langfuse', gh: 'langfuse/langfuse', pypi: 'langfuse' },
  { name: 'AgentOps', gh: 'AgentOps-AI/agentops', pypi: 'agentops' },
  { name: 'E2B', gh: 'e2b-dev/E2B', pypi: 'e2b-code-interpreter', npm: '@e2b/code-interpreter' },
  { name: 'Vercel AI SDK', gh: 'vercel/ai', npm: 'ai' },
  { name: 'OpenAI Agents', gh: 'openai/openai-agents-python', npm: '@openai/agents' },
  { name: 'Mastra', gh: 'mastra-ai/mastra', npm: '@mastra/core' }, // gh 未必在种子里,取不到 star 则跳过
]

/**
 * 计算热度-使用落差。传入 latestMap 结果(entity_id→value)。
 * 排名法:项目集合内分别按 star / 月下载排名,gap = 下载排名 − star 排名。
 *   gap > 0:star 排名比下载排名更靠前 → 热度 > 使用(透支/overhyped)
 *   gap < 0:下载排名更靠前 → 使用 > 热度(被低估/underrated)
 * @param {Map<string,number>} stars       'stars'
 * @param {Map<string,number>} dlMonth     'downloads_month'(pypi)
 * @param {Map<string,number>} dlWeek      'downloads_week'(npm)
 * @returns {Array<{ name, gh, stars, downloads, starRank, dlRank, gap }>}
 */
export function hypeVsUsage(stars, dlMonth, dlWeek) {
  const rows = []
  for (const p of PROJECTS) {
    const s = stars.get(`github:${p.gh}`)
    let downloads = null
    if (p.pypi != null && dlMonth.get(`pypi:${p.pypi}`) != null) downloads = dlMonth.get(`pypi:${p.pypi}`)
    else if (p.npm != null && dlWeek.get(`npm:${p.npm}`) != null) downloads = dlWeek.get(`npm:${p.npm}`) * WEEK_TO_MONTH
    if (s == null || downloads == null) continue
    rows.push({ name: p.name, gh: p.gh, stars: s, downloads })
  }
  const byStars = [...rows].sort((a, b) => b.stars - a.stars)
  const byDl = [...rows].sort((a, b) => b.downloads - a.downloads)
  const starRank = new Map(byStars.map((r, i) => [r.gh, i]))
  const dlRank = new Map(byDl.map((r, i) => [r.gh, i]))
  for (const r of rows) {
    r.starRank = starRank.get(r.gh)
    r.dlRank = dlRank.get(r.gh)
    r.gap = r.dlRank - r.starRank
  }
  return rows
}
