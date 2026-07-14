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
    trend: 'Trend',
    theme: 'Toggle light / dark',
    switchLang: '中文',
    footer: 'Rankings public, full daily history private. Collectors are open source.',
  },
  zh: {
    lang: 'zh',
    tagline: 'AI agent 生态的时序追踪',
    intro:
      'agent 框架、MCP 服务器、软件包如何随时间涨落 —— 每日记录一次。榜单交叉验证多项信号,任何单一可刷的指标都无法主导排名。',
    early: '尚在早期开发 —— 数据仍在积累,每天新增一个时间点。',
    snapshot: '最新快照',
    entities: '个项目',
    dataPoints: '个数据点',
    days: '天数据',
    github: 'agent 框架与工具(GitHub)',
    npm: 'npm 包(按周下载量)',
    pypi: 'PyPI 包(按月下载量)',
    githubNote: '按 star 数排序。star 好刷,真实使用量难刷 —— 所以榜单要交叉验证多项指标。',
    npmNote: '按最近一周下载量排序 —— 反映真实使用量,而非 star 数。',
    pypiNote: '按最近一个月下载量排序。',
    cols: { rank: '#', name: '名称', stars: 'Star', forks: 'Fork', commits: '提交', dl: '下载' },
    trend: '趋势',
    theme: '切换浅色 / 深色模式',
    switchLang: 'English',
    footer: '榜单公开,完整的每日历史数据私有;抓取器开源。',
  },
}

/** @param {'en'|'zh'} locale */
export function t(locale) {
  return STRINGS[locale] ?? STRINGS.en
}
