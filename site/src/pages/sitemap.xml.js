// 构建期生成 sitemap.xml —— 首页(中英)+ 项目/实体详情页。
// 格式含 <lastmod>(YYYY-MM-DD),与 Google sitemap 示例一致。
import { latestSnapshot } from '../lib/data.mjs'
import { buildEntityPages } from '../lib/detail.mjs'
import { buildProjectPages } from '../lib/projects.mjs'

const SITE = 'https://www.aiagent.club'

/** @param {string|null|undefined} iso */
function day(iso) {
  if (!iso) return null
  const d = String(iso).slice(0, 10)
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null
}

/** 实体最新指标日期(取各 metric captured_at 的 max)。 */
function lastmodFromMetrics(metrics) {
  let max = null
  for (const m of Object.values(metrics || {})) {
    const d = day(/** @type {{captured_at?: string}} */ (m)?.captured_at)
    if (d && (!max || d > max)) max = d
  }
  return max
}

/**
 * Astro `build.format: 'directory'` → 真页在 /foo/index.html。
 * OSS/CF 对无尾斜杠返回 302→/foo/;sitemap 应写最终 URL,避免 Google 测到一堆跳转。
 * @param {string} path
 */
function pagePath(path) {
  if (!path || path === '/') return '/'
  return path.endsWith('/') ? path : `${path}/`
}

/**
 * @param {string} path
 * @param {string} lastmod
 */
function urlEntry(path, lastmod) {
  return (
    `  <url>\n` +
    `    <loc>${SITE}${encodeURI(pagePath(path))}</loc>\n` +
    `    <lastmod>${lastmod}</lastmod>\n` +
    `  </url>`
  )
}

export async function GET() {
  const [pages, projects, snap] = await Promise.all([buildEntityPages(), buildProjectPages(), latestSnapshot()])
  const siteDay = day(snap) || new Date().toISOString().slice(0, 10)

  /** @type {string[]} */
  const entries = []
  for (const path of [
    '/',
    '/zh/',
    '/projects/',
    '/zh/projects/',
    '/changes/',
    '/zh/changes/',
    '/pricing/',
    '/zh/pricing/',
    '/methodology/',
    '/zh/methodology/',
    '/search/',
    '/zh/search/',
    '/browse/',
    '/zh/browse/',
  ]) {
    entries.push(urlEntry(path, siteDay))
  }

  for (const p of projects) {
    const lm =
      lastmodFromMetrics(
        Object.assign({}, ...p.memberPages.map((m) => m.metrics || {})),
      ) || siteDay
    entries.push(urlEntry(`/project/${p.slug}/`, lm))
    entries.push(urlEntry(`/zh/project/${p.slug}/`, lm))
  }

  for (const p of pages) {
    if (!p.intro) continue // 薄页已 noindex,不进 sitemap
    const lm = lastmodFromMetrics(p.metrics) || day(p.first_seen) || siteDay
    entries.push(urlEntry(`/p/${p.slug}/`, lm))
    entries.push(urlEntry(`/zh/p/${p.slug}/`, lm))
  }

  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    entries.join('\n') +
    `\n</urlset>\n`
  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } })
}
