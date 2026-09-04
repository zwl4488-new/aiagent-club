import { buildEvents } from '../lib/events.mjs'
import { renderRss } from '../lib/feed.mjs'
import { t } from '../lib/i18n.mjs'
import { latestSnapshot } from '../lib/data.mjs'
import { buildEntityProjectMap, buildProjects } from '../lib/projects.mjs'

export async function GET() {
  const [events, snapshot, projects] = await Promise.all([buildEvents({ windowDays: 30, limit: 80 }), latestSnapshot(), buildProjects()])
  const projectMap = buildEntityProjectMap(projects)
  const linkedEvents = events.map((event) => ({ ...event, project_slug: projectMap.get(event.entity_id)?.slug ?? null }))
  const xml = renderRss({ events: linkedEvents, locale: 'en', s: t('en'), generatedAt: `${snapshot || new Date().toISOString().slice(0, 10)}T12:00:00Z` })
  return new Response(xml, { headers: { 'Content-Type': 'application/rss+xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } })
}
