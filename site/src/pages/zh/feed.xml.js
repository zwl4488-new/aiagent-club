import { buildEvents } from '../../lib/events.mjs'
import { renderRss } from '../../lib/feed.mjs'
import { t } from '../../lib/i18n.mjs'
import { latestSnapshot } from '../../lib/data.mjs'

export async function GET() {
  const [events, snapshot] = await Promise.all([buildEvents({ windowDays: 30, limit: 80 }), latestSnapshot()])
  const xml = renderRss({ events, locale: 'zh', s: t('zh'), generatedAt: `${snapshot || new Date().toISOString().slice(0, 10)}T12:00:00Z` })
  return new Response(xml, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } })
}
