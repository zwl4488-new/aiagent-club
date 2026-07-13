// 结构双语:UI 文案翻译,数据本身用源语言不翻译(定价/许可翻译=制造不可检测的 bug)。

export const STRINGS = {
  en: {
    lang: 'en',
    tagline: 'Time-series tracking for the AI agent ecosystem',
    intro:
      'How agent frameworks, MCP servers, and packages grow over time — measured daily. Rankings cross-validate multiple signals so no single gameable metric dominates.',
    early: 'Early development — data is accumulating. Time series grow one day at a time.',
    snapshot: 'Snapshot',
    entities: 'entities',
    dataPoints: 'data points',
    days: 'days tracked',
    github: 'Agent frameworks & tools (GitHub)',
    npm: 'npm packages (weekly downloads)',
    pypi: 'PyPI packages (monthly downloads)',
    githubNote: 'Ranked by stars. Downloads can be gamed; sustained usage cannot.',
    npmNote: 'Ranked by last-week downloads — real usage, not stars.',
    pypiNote: 'Ranked by last-month downloads.',
    cols: { rank: '#', name: 'Name', stars: 'Stars', forks: 'Forks', commits: 'Commits', dl: 'Downloads' },
    trend: '7-day trend',
    switchLang: '中文',
    footer: 'Rankings public, full daily history private. Collectors are open source.',
  },
  zh: {
    lang: 'zh',
    tagline: 'AI agent 生态的时序数据站',
    intro:
      'agent 框架、MCP server、软件包如何随时间生长 —— 每天测量。榜单多指标交叉验证,任何单一可刷指标都无法主导。',
    early: '早期开发中 —— 数据正在积累,时序每天长一个点。',
    snapshot: '快照',
    entities: '个实体',
    dataPoints: '个数据点',
    days: '天数据',
    github: 'Agent 框架与工具(GitHub)',
    npm: 'npm 包(周下载量)',
    pypi: 'PyPI 包(月下载量)',
    githubNote: '按 star 排序。下载量能刷,持续的真实使用刷不出来。',
    npmNote: '按最近一周下载量排序 —— 真实使用量,而非 star。',
    pypiNote: '按最近一月下载量排序。',
    cols: { rank: '#', name: '名称', stars: 'Star', forks: 'Fork', commits: '提交', dl: '下载' },
    trend: '7 日趋势',
    switchLang: 'English',
    footer: '榜单公开,完整日粒度历史私有。抓取器开源。',
  },
}

/** @param {'en'|'zh'} locale */
export function t(locale) {
  return STRINGS[locale] ?? STRINGS.en
}
