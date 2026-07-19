// 构建期生成所有 OG 卡片 PNG。路由 /og/<slug>.png。
//   首页:  /og/index-<shape>-<locale>.png
//   项目页:/og/p/<shape>-<locale>/<projectSlug>.png   (shape=h|v, locale=en|zh)
// 数据只在 getStaticPaths 取一次(buildProjectPages),按卡所需字段瘦身后当 props 传下去,GET 只渲染。
import { buildProjectPages } from '../../lib/projects.mjs'
import { ogPng, OG_SHAPES } from '../../lib/og.mjs'

const LOCALES = ['en', 'zh']
const V_TOP = 100 // 竖版海报只给首页 + 前 100 项目(长尾项目的竖版海报几乎没人下,省一半构建时间)

export async function getStaticPaths() {
  const pages = await buildProjectPages() // 已按综合分降序
  const total = pages.length
  const top10 = pages.slice(0, 10).map((p) => ({ name: p.name, score: p.score }))
  const slim = (p) => ({ name: p.name, rank: p.rank, total: p.total, score: p.score, usage: p.usage, momentum: p.momentum, stars: p.stars, usagePct: p.usagePct, momPct: p.momPct, attnPct: p.attnPct, kinds: p.kinds })
  const paths = []
  for (const locale of LOCALES) {
    // 首页卡:横+竖都要
    for (const shape of OG_SHAPES) {
      paths.push({ params: { slug: `index-${shape}-${locale}` }, props: { type: 'index', shape, locale, projects: top10, total } })
    }
    // 项目卡:横版全量(每页 og:image),竖版仅 top-100(海报)
    pages.forEach((p, i) => {
      const shapes = i < V_TOP ? OG_SHAPES : ['h']
      for (const shape of shapes) {
        paths.push({ params: { slug: `p/${shape}-${locale}/${p.slug}` }, props: { type: 'project', shape, locale, project: slim(p) } })
      }
    })
  }
  return paths
}

export async function GET({ props }) {
  const png = await ogPng(props)
  return new Response(png, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } })
}
