const SITE = 'https://www.aiagent.club'

export function escapeXml(value) {
  return String(value ?? '').replace(/[<>&"']/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char])
}

export function eventSentence(event, s) {
  if (event.type === 'milestone') return s.events.milestone(Number(event.value).toLocaleString('en-US'))
  if (event.type === 'release') return s.events.release(event.count)
  if (event.type === 'surge') return s.events.surge(`${Math.round(event.pct * 100)}%`)
  return ''
}

/** Render an RSS 2.0 document from structured events. */
export function renderRss({ events, locale, s, generatedAt }) {
  const base = locale === 'zh' ? '/zh' : ''
  const feedUrl = `${SITE}${base}/feed.xml`
  const weeklyUrl = `${SITE}${base}/weekly/`
  const items = events.map((event) => {
    const link = event.project_slug
      ? `${SITE}${base}/project/${event.project_slug}/`
      : `${SITE}${base}/p/${event.slug}/`
    const sentence = eventSentence(event, s)
    const title = `${event.name} ${sentence}`
    const pubDate = new Date(`${event.at}T12:00:00Z`).toUTCString()
    return `    <item>\n      <title>${escapeXml(title)}</title>\n      <link>${escapeXml(link)}</link>\n      <guid isPermaLink="false">${escapeXml(`aiagent.club:${event.type}:${event.entity_id}:${event.at}`)}</guid>\n      <pubDate>${pubDate}</pubDate>\n      <description>${escapeXml(`${s.events.typeLabel[event.type]} · ${s.kindLabel[event.kind] ?? event.kind}`)}</description>\n    </item>`
  }).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">\n  <channel>\n    <title>${escapeXml(s.weekly.title)}</title>\n    <link>${weeklyUrl}</link>\n    <description>${escapeXml(s.weekly.intro)}</description>\n    <language>${locale === 'zh' ? 'zh-CN' : 'en'}</language>\n    <lastBuildDate>${new Date(generatedAt).toUTCString()}</lastBuildDate>\n    <atom:link href="${feedUrl}" rel="self" type="application/rss+xml" />\n${items}\n  </channel>\n</rss>\n`
}
