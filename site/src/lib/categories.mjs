// 语义分类层：从统一项目的名称、简介与成员标识推断产品类型。
// 分类是可解释的发现入口，不改写来源数据，也不参与综合分计算。

export const CATEGORY_DEFS = [
  { slug: 'coding-agents', icon: '</>', test: /\b(coding agents?|code agents?|ai pair programming|software engineering agents?|code review|codebase intelligence|ide (?:extension|assistant)|terminal (?:agent|assistant)|swe-agent|devin|coding assistant)\b/i },
  { slug: 'agent-frameworks', icon: '◇', test: /\b(agent framework|agentic framework|multi-agent|multi agent|agents? sdk|agent (?:engineering )?platform|orchestrat(?:e|ion|ing)|build(?:ing)? (?:ai )?agents?|autonomous agents?|resilient agents?)\b/i },
  { slug: 'mcp-tools', icon: '↔', test: /\b(model context protocol|mcp(?: server| client| toolkit| sdk| adapter| proxy| remote| tools?)?)\b/i },
  { slug: 'browser-web', icon: '◎', test: /\b(browser|browsing|web automation|scrap(?:e|ing)|crawl(?:er|ing)?|playwright|puppeteer|search api|web search)\b/i },
  { slug: 'rag-memory', icon: '▦', test: /\b(rag|retrieval|vector|embedding|knowledge graph|knowledge base|memory|semantic search|document agent|context engine|context layer)\b/i },
  { slug: 'observability-evals', icon: '◫', test: /\b(observability|evaluation|evals?|tracing|monitoring|benchmark|prompt management|telemetry|cost tracking|guardrails?)\b/i },
  { slug: 'workflow-automation', icon: '⇢', test: /\b(workflow|automation|pipeline|integration|low-code|no-code|schedule|approval gates?|operations)\b/i },
  { slug: 'agent-infrastructure', icon: '⬡', test: /\b(gateway|proxy|sandbox|runtime|structured outputs?|inference|llm api|model api|toolkit|platform|client sdk|api client|code execution)\b/i },
]

/** Build the searchable text while keeping source-language metadata untouched. */
function haystack(project) {
  return [
    project.name,
    project.description,
    project.key,
    ...(project.members || []).flatMap((m) => [m.name, m.entity_id, m.description, m.category]),
  ].filter(Boolean).join(' ')
}

/**
 * A project may appear in more than one category. This is intentional: categories
 * are discovery facets, not mutually exclusive editorial labels.
 */
export function categorizeProject(project) {
  const text = haystack(project)
  const matches = CATEGORY_DEFS.filter((category) => category.test.test(text)).map((category) => category.slug)
  return matches.length ? matches : ['agent-infrastructure']
}

export function buildCategoryRankings(projects) {
  const rows = new Map(CATEGORY_DEFS.map((category) => [category.slug, []]))
  for (const project of projects) {
    for (const slug of categorizeProject(project)) rows.get(slug)?.push(project)
  }
  return CATEGORY_DEFS.map((category) => ({ ...category, projects: rows.get(category.slug) || [] }))
}

export function categoryBySlug(slug) {
  return CATEGORY_DEFS.find((category) => category.slug === slug) || null
}
