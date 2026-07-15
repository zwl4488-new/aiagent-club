// 项目聚合层 —— 把同一项目的多源实体绑一起,算"热度 vs 真实使用"落差。
//
// 现库里实体按源分开(github:crewAIInc/crewAI 和 pypi:crewai 各算各的)。这里手工映射
// "项目 → {github 仓, 包}",于是能把 star(热度,可刷)对下载量(真实使用,刷不出来)。
// 手工映射先覆盖有明确 github↔包 对应的框架/工具;发现式自动关联留后续。

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

const WEEK_TO_MONTH = 4.345 // 周下载 → 月下载 近似

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
