// 变更日志 / 异动引擎(构建期)—— 把时序数据里的变化提炼成"结构化事件"。
//
// 为什么结构化而非自然语言:事件是 { 类型, 实体, 指标, 数值, 日期 } 的数据对象,渲染时才套双语模板。
// 这样同一份事件中英一致、可排序、可上 JSON-LD,也不会把翻译当成无法检测的 bug(与全站"数据用源语言"一致)。
//
// v1 三类高信号、有界的事件(直接服务"动量信号"定位):
//   · milestone —— 累计型指标(star)越过整数里程碑(1k/5k/10k/50k/100k…)
//   · surge     —— 周下载量环比大涨(≥阈值%,且绝对量过地板,滤掉小包噪声)
//   · release   —— GitHub 发了新 release(releases 计数在窗口内增加)
// 窗口默认 14 天,保证页面始终有内容;事件按发生日期倒序(最新在前),同日按重要度排。
// 历史越积越厚,可检测的事件越多(尤其发现来的实体回填后)。

import { allEntities, seriesByKind, latestSnapshot } from './data.mjs'

/** star 里程碑阈值(log 间隔的整数)。越过即成事件。 */
const STAR_MILESTONES = [1e3, 2.5e3, 5e3, 1e4, 2.5e4, 5e4, 1e5, 2e5, 3e5, 5e5]
/** 周下载环比涨幅阈值 + 绝对量地板(滤掉小包的百分比噪声)。 */
const SURGE_MIN_PCT = 0.3
const SURGE_MIN_ABS = 50_000
const SURGE_LOOKBACK_DAYS = 7
const DEFAULT_WINDOW_DAYS = 14
// release 事件门槛:只报有关注度的仓库(滤掉冷门);只认"相邻两日"的增量(回填是稀疏历史点,
// 与采集点不相邻,天然被跳过,避免把补历史/漏读的接缝跃变当成发版);单日增量过大(>6)当噪声丢弃。
const RELEASE_MIN_STARS = 1_000
const RELEASE_MAX_DAILY_INC = 6

/** ISO 日期减 n 天。 */
function minusDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z')
  return new Date(d.getTime() - n * 86400000).toISOString().slice(0, 10)
}

/** entity_id 的 identifier 部分 → 详情页 slug。 */
function slugOf(entityId) {
  const i = entityId.indexOf(':')
  const kind = entityId.slice(0, i)
  const id = entityId.slice(i + 1)
  return `${kind}/${id}`
}

/** 累计序列在窗口内越过的里程碑(prev < T ≤ cur,且发生日期 ≥ cutoff)。 */
function milestoneCrossings(series, thresholds, cutoff) {
  const out = []
  for (let i = 1; i < series.length; i++) {
    const at = series[i].captured_at
    if (at < cutoff) continue
    const prev = series[i - 1].value
    const cur = series[i].value
    for (const T of thresholds) {
      if (prev < T && cur >= T) out.push({ at, threshold: T, value: cur })
    }
  }
  return out
}

/** 两个 ISO 日期相差天数(b - a)。 */
function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000)
}

/** 序列里 captured_at ≤ day 的最后一个点(用于取"若干天前"的基准)。 */
function valueAtOrBefore(series, day) {
  for (let i = series.length - 1; i >= 0; i--) {
    if (series[i].captured_at <= day) return series[i]
  }
  return null
}

/**
 * 构建全部事件(结构化)。返回按日期倒序、同日按 importance 降序的事件数组。
 * 每条:{ entity_id, kind, name, slug, url, type, metric, at, ...typeFields, importance }
 * @param {{ windowDays?: number, limit?: number }} [opts]
 */
export async function buildEvents({ windowDays = DEFAULT_WINDOW_DAYS, limit = 80 } = {}) {
  const [ents, latest] = await Promise.all([allEntities(), latestSnapshot()])
  const meta = new Map(ents.map((e) => [e.entity_id, e]))
  if (!latest) return []
  const cutoff = minusDays(latest, windowDays)

  const [starSeries, relSeries, npmDl, pypiDl] = await Promise.all([
    seriesByKind('github', 'stars'),
    seriesByKind('github', 'releases'),
    seriesByKind('npm', 'downloads_week'),
    seriesByKind('pypi', 'downloads_week'),
  ])

  /** @type {any[]} */
  const events = []
  const push = (entity_id, e) => {
    const m = meta.get(entity_id)
    if (!m) return
    events.push({ entity_id, kind: m.kind, name: m.name || entity_id, slug: slugOf(entity_id), url: m.url ?? null, ...e })
  }

  // ── milestone:star 越过里程碑 ──
  for (const [id, s] of starSeries) {
    for (const c of milestoneCrossings(s, STAR_MILESTONES, cutoff)) {
      push(id, { type: 'milestone', metric: 'stars', at: c.at, value: c.threshold, importance: Math.log10(c.threshold) + 3 })
    }
  }

  // ── release:releases 计数在窗口内增加(发新版) ──
  // 日照快照看不到确切发版时刻,但能看到计数在哪天变大 → 事件日期取"最后一次增量日"(而非今天),
  // count 汇总窗口内总增量,一个活跃仓库一条(不按每次发版刷屏)。
  // 只统计相邻两日的正增量,天然跳过"首次采集即满值"(无 0→N 跃变),不会把存量误判成新发版。
  for (const [id, s] of relSeries) {
    if (s.length < 2) continue
    const stars = starSeries.get(id)?.at(-1)?.value ?? 0
    if (stars < RELEASE_MIN_STARS) continue // 冷门仓库的发版不上榜
    // 从最新往回找"最近一次相邻两日的真实增量",取那天当事件(准确日期 + 准确单日发版数)。
    for (let i = s.length - 1; i >= 1; i--) {
      if (s[i].captured_at < cutoff) break
      if (daysBetween(s[i - 1].captured_at, s[i].captured_at) !== 1) continue
      const inc = s[i].value - s[i - 1].value
      if (inc >= 1 && inc <= RELEASE_MAX_DAILY_INC) {
        push(id, { type: 'release', metric: 'releases', at: s[i].captured_at, count: inc, importance: Math.log10(stars + 10) })
        break
      }
    }
  }

  // ── surge:周下载量环比大涨 ──
  for (const map of [npmDl, pypiDl]) {
    for (const [id, s] of map) {
      if (s.length < 2) continue
      const last = s[s.length - 1]
      if (last.captured_at < cutoff || last.value < SURGE_MIN_ABS) continue
      const prev = valueAtOrBefore(s, minusDays(last.captured_at, SURGE_LOOKBACK_DAYS))
      if (!prev || prev.captured_at === last.captured_at || prev.value <= 0) continue
      const pct = (last.value - prev.value) / prev.value
      if (pct < SURGE_MIN_PCT) continue
      push(id, {
        type: 'surge',
        metric: 'downloads_week',
        at: last.captured_at,
        from: prev.value,
        to: last.value,
        pct,
        importance: pct * Math.log10(last.value),
      })
    }
  }

  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : b.importance - a.importance))
  return events.slice(0, limit)
}

/** 把事件按日期分组(保持倒序)。返回 [{ date, items }]。 */
export function groupByDate(events) {
  const groups = []
  let cur = null
  for (const e of events) {
    if (!cur || cur.date !== e.at) {
      cur = { date: e.at, items: [] }
      groups.push(cur)
    }
    cur.items.push(e)
  }
  return groups
}
