import test from 'node:test'
import assert from 'node:assert/strict'
import { escapeXml, renderRss } from '../site/src/lib/feed.mjs'
import { t } from '../site/src/lib/i18n.mjs'

test('escapeXml escapes markup and attributes', () => {
  assert.equal(escapeXml(`A&B <C> "D" 'E'`), 'A&amp;B &lt;C&gt; &quot;D&quot; &apos;E&apos;')
})

test('RSS renders stable bilingual-safe event items', () => {
  const xml = renderRss({
    locale: 'en', s: t('en'), generatedAt: '2026-09-02T12:00:00Z',
    events: [{ type: 'milestone', entity_id: 'github:a&b/repo', slug: 'github/a&b/repo', name: 'A&B <Agent>', kind: 'github', at: '2026-09-01', value: 1000 }],
  })
  assert.match(xml, /^<\?xml version="1.0" encoding="UTF-8"\?>/)
  assert.match(xml, /A&amp;B &lt;Agent&gt;/)
  assert.match(xml, /application\/rss\+xml/)
  assert.match(xml, /aiagent\.club:milestone:github:a&amp;b\/repo:2026-09-01/)
})

test('RSS prefers a unified project URL while keeping the source event GUID', () => {
  const xml = renderRss({
    locale: 'en', s: t('en'), generatedAt: '2026-09-02T12:00:00Z',
    events: [{ type: 'release', entity_id: 'github:a/repo', slug: 'github/a/repo', project_slug: 'github/a/repo', name: 'A', kind: 'github', at: '2026-09-01', count: 1 }],
  })
  assert.match(xml, /https:\/\/www\.aiagent\.club\/project\/github\/a\/repo\//)
  assert.match(xml, /aiagent\.club:release:github:a\/repo:2026-09-01/)
})
