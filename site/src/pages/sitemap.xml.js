// 构建期生成 sitemap.xml —— 首页(中英)+ 每个实体的中英详情页。搜索引擎据此收录全部长尾页。
import { buildEntityPages } from '../lib/detail.mjs'
import { buildProjectPages } from '../lib/projects.mjs'

const SITE = 'https://www.aiagent.club'

export async function GET() {
  const [pages, projects] = await Promise.all([buildEntityPages(), buildProjectPages()])
  const urls = ['/', '/zh/', '/projects', '/zh/projects', '/changes', '/zh/changes', '/pricing', '/zh/pricing', '/methodology', '/zh/methodology', '/search', '/zh/search', '/browse', '/zh/browse']
  for (const p of projects) {
    urls.push(`/project/${p.slug}`)
    urls.push(`/zh/project/${p.slug}`)
  }
  for (const p of pages) {
    urls.push(`/p/${p.slug}`)
    urls.push(`/zh/p/${p.slug}`)
  }
  const body =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    urls.map((u) => `  <url><loc>${SITE}${encodeURI(u)}</loc></url>`).join('\n') +
    `\n</urlset>\n`
  return new Response(body, { headers: { 'Content-Type': 'application/xml; charset=utf-8' } })
}
