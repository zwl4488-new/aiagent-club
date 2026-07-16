// 构建期生成搜索索引 —— 每个实体一条 { n:名称, k:kind, s:slug, d:一句话简介, v:主指标值 }。
// 站点是纯静态,搜索走客户端:/search 页拉这份 JSON,在浏览器里过滤排序。索引精简(名称+简介),
// 1485 实体约 ~200KB(gzip 后更小),只在访问 /search 时加载一次。
import { buildEntityPages } from '../lib/detail.mjs'

export async function GET() {
  const pages = await buildEntityPages()
  // 简介截到 140 字:够匹配 + 展示(UI 再省略号截断),把索引压小。
  const snip = (d) => (d && d.length > 140 ? d.slice(0, 140).replace(/\s+\S*$/, '') + '…' : d || '')
  const idx = pages.map((p) => ({
    n: p.name,
    k: p.kind,
    s: p.slug,
    d: snip(p.description),
    v: p.primaryValue ?? 0,
  }))
  return new Response(JSON.stringify(idx), {
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=3600' },
  })
}
