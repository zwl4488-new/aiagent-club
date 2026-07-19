// OG 卡片渲染:构建期把首页/项目页数据画成分享图 PNG。satori(JSX-free 元素树)→ SVG → resvg → PNG。
// 两种卡:index(首页 top-10 榜)、project(单项目战绩卡);两种形状:h(1200×630,给 og:image,信息流不裁)、
// v(1000×高度自适应,竖版海报,可下载)。中英双语。字体 Noto Sans SC(latin+CJK,已是 devDependency)。
import satori from 'satori'
import { Resvg } from '@resvg/resvg-js'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

// 从 cwd 解析字体:astro build 的工作目录是 site/,bundle 后 import.meta.url 会指进 dist/ 故不能用它。
const FD = join(process.cwd(), 'node_modules', '@fontsource', 'noto-sans-sc', 'files')
let _fonts // 字体只加载一次(1.5MB CJK),全量渲染复用
async function fonts() {
  if (_fonts) return _fonts
  const load = (f) => readFile(join(FD, f))
  const [l4, c4, l7, c7] = await Promise.all([
    load('noto-sans-sc-latin-400-normal.woff'),
    load('noto-sans-sc-chinese-simplified-400-normal.woff'),
    load('noto-sans-sc-latin-700-normal.woff'),
    load('noto-sans-sc-chinese-simplified-700-normal.woff'),
  ])
  // latin 与 CJK 用不同 name,否则同 name+weight 被 satori 去重丢一个 → CJK 变豆腐块;fontFamily 指 latin,汉字自动回退 CJK。
  _fonts = [
    { name: 'Noto', data: l4, weight: 400, style: 'normal' },
    { name: 'Noto', data: l7, weight: 700, style: 'normal' },
    { name: 'NotoCJK', data: c4, weight: 400, style: 'normal' },
    { name: 'NotoCJK', data: c7, weight: 700, style: 'normal' },
  ]
  return _fonts
}

const ORANGE = '#ea580c'
const ORANGE_HI = '#fb923c'
const INK = '#1c1714'
const INK2 = '#6b635c'
const TRACK = '#efe6dd'
const ARROW =
  'data:image/svg+xml;base64,' +
  Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h15"/><path d="M13 5l7 7-7 7"/></svg>',
  ).toString('base64')

// satori 元素工厂:所有 div 默认 display:flex
const e = (type, style, ...children) => {
  const s = style.display ? style : { display: 'flex', ...style }
  return { type, props: { style: s, children: children.length === 1 ? children[0] : children } }
}
const arrowImg = (sz) => ({ type: 'img', props: { src: ARROW, width: sz, height: sz, style: { marginLeft: 12 } } })

const STR = {
  en: {
    badge: 'updated daily',
    title: 'The AI Agent Index',
    sub: 'Hype vs. real usage · momentum · attention',
    foot: (n) => `${n} projects · ranked by real traction`,
    score: 'Score',
    usage: 'Usage',
    momentum: 'Momentum',
    attention: 'Attention',
    rankOf: (r, t) => `#${r} / ${t}`,
    onIndex: 'on the AI Agent Index',
  },
  zh: {
    badge: '每日更新',
    title: 'AI Agent 指数',
    sub: '热度 vs 真实使用 · 动量 · 关注度',
    foot: (n) => `${n} 个项目 · 按真实生命力排序`,
    score: '综合分',
    usage: '真实使用',
    momentum: '动量',
    attention: '关注度',
    rankOf: (r, t) => `第 ${r} / ${t}`,
    onIndex: '· AI Agent 指数',
  },
}

const KIND = { github: 'GitHub', npm: 'npm', pypi: 'PyPI', huggingface: 'Hugging Face', modelscope: 'ModelScope', vscode: 'VS Code' }

// 形状参数
const SHAPES = {
  h: { w: 1200, autoH: false, h: 630, pad: '44px 58px', brandFS: 30, badgeFS: 24, dot: 13, titleFS: 50, titleH: 62, subFS: 25, dashW: 40, rowH: 24, nameW: 292, nameFS: 23, barW: 600, barH: 16, scoreW: 58, scoreFS: 26, rankW: 42, rankFS: 23, footFS: 24, ctaFS: 25, ctaPad: '13px 26px', arrow: 26 },
  v: { w: 1000, autoH: true, pad: '60px 56px', brandFS: 32, badgeFS: 26, dot: 14, titleFS: 56, titleH: 72, subFS: 27, dashW: 44, rowH: 40, rowGap: 32, nameW: 322, nameFS: 30, barW: 400, barH: 18, scoreW: 62, scoreFS: 32, rankW: 48, rankFS: 28, footFS: 27, ctaFS: 26, ctaPad: '14px 28px', arrow: 26 },
}

const shell = (c, height, children) =>
  e('div', {
    position: 'relative', display: 'flex', flexDirection: 'column', width: '100%', height: '100%',
    padding: c.pad, backgroundColor: '#fdf8f2', backgroundImage: 'linear-gradient(155deg, #fffdfb 0%, #fdeede 100%)', fontFamily: 'Noto',
  },
    e('div', { position: 'absolute', top: -240, right: -180, width: 780, height: 780, borderRadius: 780, backgroundImage: 'radial-gradient(circle, rgba(251,146,60,0.42) 0%, rgba(251,146,60,0.0) 60%)' }),
    ...children,
  )

const brandRow = (c, s, mb) =>
  e('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0, marginBottom: mb },
    e('div', { fontSize: c.brandFS, fontWeight: 700, color: ORANGE }, 'aiagent.club'),
    e('div', { display: 'flex', alignItems: 'center', fontSize: c.badgeFS, fontWeight: 400, color: INK2 },
      e('div', { width: c.dot, height: c.dot, borderRadius: c.dot, backgroundColor: ORANGE, marginRight: 11 }), s.badge),
  )

const ctaPill = (c, label) =>
  e('div', { display: 'flex', alignItems: 'center', backgroundColor: ORANGE, borderRadius: 999, padding: c.ctaPad, fontSize: c.ctaFS, fontWeight: 700, color: '#ffffff' },
    e('div', { display: 'flex' }, label), arrowImg(c.arrow))

// ── 首页 index 卡:top-10 榜 ──
function indexTree(c, s, projects, total) {
  const row = (p, i) =>
    e('div', { display: 'flex', alignItems: 'center', width: '100%', flexShrink: 0, height: c.rowH, ...(c.autoH ? { marginBottom: c.rowGap } : {}) },
      e('div', { flexShrink: 0, width: c.rankW, fontSize: c.rankFS, fontWeight: 400, color: '#a89f97' }, String(i + 1)),
      e('div', { flexShrink: 0, width: c.nameW, fontSize: c.nameFS, fontWeight: 700, color: INK, overflow: 'hidden', whiteSpace: 'nowrap' }, p.name),
      e('div', { display: 'flex', flexShrink: 0, width: c.barW, height: c.barH, backgroundColor: TRACK, borderRadius: c.barH / 2, marginRight: 24, overflow: 'hidden' },
        e('div', { width: `${p.score}%`, height: '100%', backgroundImage: `linear-gradient(90deg, ${ORANGE}, ${ORANGE_HI})`, borderRadius: c.barH / 2 })),
      e('div', { flexShrink: 0, width: c.scoreW, fontSize: c.scoreFS, fontWeight: 700, color: ORANGE }, String(p.score)),
    )
  const header = [
    brandRow(c, s, c.autoH ? 22 : 14),
    e('div', { display: 'flex', alignItems: 'center', flexShrink: 0, height: c.titleH, fontSize: c.titleFS, fontWeight: 700, color: INK }, s.title),
    e('div', { display: 'flex', alignItems: 'center', flexShrink: 0, height: 40, marginTop: 4, marginBottom: c.autoH ? 34 : 14 },
      e('div', { flexShrink: 0, width: c.dashW, height: 6, borderRadius: 3, marginRight: 16, backgroundImage: `linear-gradient(90deg, ${ORANGE}, ${ORANGE_HI})` }),
      e('div', { fontSize: c.subFS, fontWeight: 400, color: INK2 }, s.sub)),
  ]
  const rowsBox = c.autoH
    ? e('div', { display: 'flex', flexDirection: 'column', flexShrink: 0 }, ...projects.map(row))
    : e('div', { display: 'flex', flexDirection: 'column', flexGrow: 1, justifyContent: 'space-between', paddingTop: 6, paddingBottom: 6 }, ...projects.map(row))
  const footer = e('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0, height: 56, ...(c.autoH ? {} : { marginTop: 8 }) },
    e('div', { fontSize: c.footFS, fontWeight: 400, color: INK2 }, s.foot(total)), ctaPill(c, 'www.aiagent.club'))
  // 竖版:画布高度贴内容;横版:固定 630
  const H = c.autoH ? 60 * 2 + (c.brandFS + 22) + c.titleH + (4 + 40 + 34) + projects.length * (c.rowH + c.rowGap) + 56 : c.h
  return { tree: shell(c, H, [...header, rowsBox, footer]), H }
}

// ── 项目 project 卡:单项目战绩 ──
function projectTree(c, s, p) {
  const pct = (label, val, on) =>
    e('div', { display: 'flex', alignItems: 'center', width: '100%', flexShrink: 0, marginBottom: c.autoH ? 26 : 16 },
      e('div', { flexShrink: 0, width: c.autoH ? 220 : 200, fontSize: c.nameFS, fontWeight: 400, color: INK2 }, label),
      e('div', { display: 'flex', flexShrink: 0, width: c.autoH ? 470 : 620, height: c.barH, backgroundColor: TRACK, borderRadius: c.barH / 2, marginRight: 24, overflow: 'hidden' },
        e('div', { width: `${on ? val : 0}%`, height: '100%', backgroundImage: `linear-gradient(90deg, ${ORANGE}, ${ORANGE_HI})`, borderRadius: c.barH / 2 })),
      e('div', { flexShrink: 0, width: c.scoreW, fontSize: c.scoreFS, fontWeight: 700, color: on ? ORANGE : '#c9beb4' }, on ? String(val) : '—'))
  const badges = e('div', { display: 'flex', alignItems: 'center', flexShrink: 0, marginTop: 4, marginBottom: c.autoH ? 40 : 22 },
    ...p.kinds.filter((k) => KIND[k]).map((k) =>
      e('div', { display: 'flex', flexShrink: 0, marginRight: 12, padding: '6px 16px', borderRadius: 999, backgroundColor: '#f3e4d8', fontSize: c.badgeFS - 2, fontWeight: 700, color: '#9a3412' }, KIND[k])))
  const header = [
    brandRow(c, s, c.autoH ? 26 : 16),
    e('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', flexShrink: 0 },
      e('div', { fontSize: c.titleFS, fontWeight: 700, color: INK, overflow: 'hidden', whiteSpace: 'nowrap', flexShrink: 1, marginRight: 20 }, p.name),
      e('div', { display: 'flex', flexShrink: 0, fontSize: c.titleFS - 8, fontWeight: 700, color: ORANGE }, s.rankOf(p.rank, p.total))),
    badges,
    e('div', { display: 'flex', alignItems: 'baseline', flexShrink: 0, marginBottom: c.autoH ? 30 : 18 },
      e('div', { fontSize: c.autoH ? 96 : 84, fontWeight: 700, color: INK }, String(p.score)),
      e('div', { fontSize: c.subFS, fontWeight: 400, color: INK2, marginLeft: 16 }, s.score)),
  ]
  const bars = e('div', { display: 'flex', flexDirection: 'column', flexShrink: 0, ...(c.autoH ? {} : { flexGrow: 1, justifyContent: 'center' }) },
    pct(s.usage, p.usagePct, p.usage > 0), pct(s.momentum, p.momPct, p.momentum > 0), pct(s.attention, p.attnPct, p.stars > 0))
  const footer = e('div', { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexShrink: 0, height: 56, marginTop: c.autoH ? 40 : 0 },
    e('div', { fontSize: c.footFS, fontWeight: 400, color: INK2 }, s.sub), ctaPill(c, 'www.aiagent.club'))
  const H = c.autoH ? 60 * 2 + (c.brandFS + 26) + c.titleH + (c.badgeFS + 4 + 40) + (96 + 30) + 3 * (c.barH < 20 ? 44 : 44) + (40 + 56) : c.h
  return { tree: shell(c, H, [...header, bars, footer]), H }
}

async function toPng(tree, w, h) {
  const svg = await satori(tree, { width: w, height: h, fonts: await fonts() })
  return new Resvg(svg, { fitTo: { mode: 'width', value: w } }).render().asPng()
}

/**
 * 渲染一张 OG 卡 → PNG Buffer。
 * @param {{type:'index'|'project', locale:'en'|'zh', shape:'h'|'v', projects?:any[], total?:number, project?:any}} o
 */
export async function ogPng(o) {
  const c = SHAPES[o.shape]
  const s = STR[o.locale] ?? STR.en
  const { tree, H } = o.type === 'project' ? projectTree(c, s, o.project) : indexTree(c, s, o.projects, o.total)
  return toPng(tree, c.w, H)
}

export const OG_SHAPES = ['h', 'v']
