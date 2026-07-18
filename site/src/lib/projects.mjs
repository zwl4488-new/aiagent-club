// 项目聚合层 —— 把同一项目的多源实体绑一起(靠 project_key,见 src/link.mjs),
// 每个项目 = 多源属性(star / 各源下载 / 动量),算综合分做旗舰榜;并算"热度 vs 真实使用"落差。
//
// project_key 由 src/link.mjs 从包元数据声明的 github 仓解析(权威),同 key = 同一项目。
// 下面 buildProjects() 是新的统一模型;hypeVsUsage() 是老的手工映射版,首页仍在用,逐步迁移。

import { allEntities, latestMetricsAll, movers } from './data.mjs'
import { buildEntityPages } from './detail.mjs'

const WEEK_TO_MONTH = 4.345 // 周下载 → 月下载 近似

/** 某实体的"月等效下载量"(真实使用信号,跨源可比)。 */
function monthlyDownloads(kind, m) {
  if (kind === 'npm') return (m.downloads_week?.value ?? 0) * WEEK_TO_MONTH
  if (kind === 'pypi') return m.downloads_month?.value ?? 0
  if (kind === 'huggingface') return m.hf_downloads?.value ?? 0 // 30天 ≈ 月
  return 0
}

/** 给 projects 按 field 打百分位(0–100,只在 >0 的集合内排),写入 outField。 */
function addPercentile(projects, field, outField) {
  const vals = projects.map((p) => p[field]).filter((v) => v > 0).sort((a, b) => a - b)
  const n = vals.length
  for (const p of projects) {
    if (!(p[field] > 0)) {
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
 * 综合分 = 存在分量的加权平均(usage 45% / 动量 30% / 关注 25%,缺的分量按存在项归一)。
 * 用百分位而非原始值:量纲可比、单一可刷指标压不过相关性 —— 与本站反刷榜主线一致。
 */
export async function buildProjects() {
  const [ents, latest, starMovers] = await Promise.all([allEntities(), latestMetricsAll(), movers('github', 'stars', 7)])
  const deltaByEntity = new Map(starMovers.map((r) => [r.entity_id, r.delta]))

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
    const stars = gh.reduce((mx, e) => Math.max(mx, met(e).stars?.value ?? 0), 0)
    const momentum = gh.reduce((mx, e) => Math.max(mx, deltaByEntity.get(e.entity_id) ?? 0), 0)
    let usage = 0
    for (const e of members) usage += monthlyDownloads(e.kind, met(e))
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
    })
  }

  // 指数只收"软件项目"(有 github / npm / pypi 成员)。纯模型/扩展(openrouter / modelscope /
  // vscode / 未链到仓库的 huggingface)不是"项目",各有自己的榜,不进综合指数,免得榜里混一堆 0 分模型。
  const SOFTWARE = new Set(['github', 'npm', 'pypi'])
  const software = projects.filter((p) => p.kinds.some((k) => SOFTWARE.has(k)))

  addPercentile(software, 'usage', 'usagePct')
  addPercentile(software, 'stars', 'attnPct')
  addPercentile(software, 'momentum', 'momPct')
  // 不做权重归一:缺的分量按 0 计。这样综合分高的项目必须"多个信号都强"(真实使用 + 动量 + 关注),
  // 单一可刷信号(只有 star,或只有下载)顶多拿到自己那份权重 —— 契合"没有单一可刷指标能主导"的主线。
  // 使用量 45%(最难造假,权重最高)+ 动量 30% + 关注 25%。
  for (const p of software) {
    p.score = Math.round(0.45 * p.usagePct + 0.3 * p.momPct + 0.25 * p.attnPct)
  }
  software.sort((a, b) => b.score - a.score)
  return software
}

/**
 * 逐项目详情页数据:把 buildProjects 的项目 × buildEntityPages 的富实体页(含 sparkline/指标)绑一起。
 * 返回每个项目一条:综合分/分项/rank + memberPages(各源的详情页数据,按主指标降序)+ intro/slug。
 * slug = 锚点实体的详情 slug(如 github/browser-use/browser-use),作 /project/[...slug] 路径。
 */
export async function buildProjectPages() {
  const [entityPages, projects] = await Promise.all([buildEntityPages(), buildProjects()])
  const pageById = new Map(entityPages.map((p) => [p.entity_id, p]))
  return projects.map((proj, i) => {
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
      rank: i + 1,
      total: projects.length,
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
