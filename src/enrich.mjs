// 项目介绍富集(阶段 9 收尾)。给实体补一段"项目本身的介绍"——从 README / long_description
// 清洗出前几段可读 prose,存进 entities.intro,详情页展示。
//
// 与采集/回填一致的纪律:逐项 try/catch 错误隔离、幂等(默认跳过已有 intro,--refresh 强制重取)、
// 写本地库,收尾 union-merge 回 R2。介绍很少变,故做成独立低频富集(非每次 collect)。
//
// 数据源:github REST /readme(自动识别 README 文件名/大小写)、npm packument .readme、
// pypi JSON info.description。清洗见 cleanReadmeIntro(纯函数,可单测)。

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { runSqlite, createWriter, query } from './db.mjs'
import { fetchRetry, sleep } from './fetch/client.mjs'
import { GITHUB_REPOS, NPM_PACKAGES, PYPI_PACKAGES, HF_MODELS, MODELSCOPE_MODELS, VSCODE_EXTENSIONS } from './entities.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UA = 'aiagent-club'
const INTRO_MAX = 700 // 介绍摘录上限字符
const GH_GAP_MS = 120
const NPM_GAP_MS = 150
const PYPI_GAP_MS = 300

/**
 * 把 README / long_description markdown 清成一段可读的项目介绍(前几段 prose)。纯函数。
 * 去掉 HTML / 代码块 / 徽章 / 图片 / 导航栏 / TOC / 列表,链接保留文字,截到 maxLen。
 * @param {string} md
 * @param {number} [maxLen]
 * @returns {string|null}
 */
export function cleanReadmeIntro(md, maxLen = INTRO_MAX) {
  if (!md || typeof md !== 'string') return null
  let t = md.replace(/\r\n/g, '\n')
  t = t.replace(/<!--[\s\S]*?-->/g, '') // HTML 注释
  t = t.replace(/```[\s\S]*?```/g, '') // 代码块
  t = t.replace(/<[^>]+>/g, '') // HTML 标签
  const lines = t.split('\n')
  /** @type {string[]} */
  const paras = []
  let cur = []
  const flush = () => {
    if (cur.length) {
      paras.push(cur.join(' ').trim())
      cur = []
    }
  }
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) {
      flush()
      continue
    }
    if (/^#{1,6}\s/.test(line)) {
      flush()
      continue
    } // 标题
    if (/^[-=*_]{3,}$/.test(line)) {
      flush()
      continue
    } // 分隔线
    if (/^!\[/.test(line) || /^\[!\[/.test(line)) continue // 图片 / 徽章
    if (/shields\.io|badge/i.test(line) && /\]\(/.test(line)) continue
    if ((line.match(/[·•|]/g) || []).length >= 2) continue // 导航栏
    if (/^\s*(https?:\/\/\S+)\s*$/.test(line)) continue // 独占一行的裸链接
    if (/^\s*[-*+]\s/.test(line) || /^\s*\d+\.\s/.test(line)) {
      flush()
      continue
    } // 列表项
    if (/table of contents|目录/i.test(line)) {
      flush()
      continue
    }
    if (/^>\s/.test(line)) {
      cur.push(line.replace(/^>\s*/, ''))
      continue
    } // 引用当正文
    cur.push(line)
  }
  flush()

  const clean = (s) =>
    s
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '') // 图片
      .replace(/\[!\w+\]/g, '') // [!TIP] 等 GitHub alert
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // 链接 → 文字
      .replace(/https?:\/\/\S+/g, '') // 残留裸链接
      .replace(/[*_~`]+/g, '') // 强调 / 行内码标记
      .replace(/\s+/g, ' ')
      .trim()

  /** @type {string[]} */
  const good = []
  for (const p of paras) {
    const c = clean(p)
    if (c.length < 40) continue // 太短(标语碎片)
    if (!/[a-zA-Z一-龥]/.test(c)) continue
    if ((c.match(/[·•|]/g) || []).length >= 2) continue // 导航栏段落
    if (!/[.。!?！?]/.test(c) && c.split(' ').length < 8) continue // 无句读短碎片
    good.push(c)
    if (good.join('\n\n').length >= maxLen) break
  }
  if (!good.length) return null
  let out = good.join('\n\n')
  if (out.length > maxLen) out = out.slice(0, maxLen).replace(/\s+\S*$/, '') + '…'
  return out
}

async function ensureSchema(dbPath) {
  const schema = await readFile(join(__dirname, '..', 'db', 'schema.sql'), 'utf8')
  await runSqlite(dbPath, schema)
  const cols = /** @type {any[]} */ (await runSqlite(dbPath, `PRAGMA table_info(entities);`, { json: true }))
  if (!cols.some((c) => c.name === 'intro')) await runSqlite(dbPath, `ALTER TABLE entities ADD COLUMN intro TEXT;`)
}

/** 已有 intro?(幂等跳过;--refresh 时恒为 false) */
async function hasIntro(dbPath, entityId, refresh) {
  if (refresh) return false
  const safe = entityId.replace(/'/g, "''")
  const [r] = await query(dbPath, `SELECT intro FROM entities WHERE entity_id='${safe}'`)
  return Boolean(r && r.intro)
}

/** github REST /readme:自动识别 README 文件名,raw 直接给内容。404/无则 null。 */
async function fetchGithubReadme(repo, token) {
  const res = await fetchRetry(`https://api.github.com/repos/${repo}/readme`, {
    notFoundOk: true,
    retries: 2,
    headers: { authorization: `bearer ${token}`, accept: 'application/vnd.github.raw+json', 'user-agent': UA },
  })
  if (res.status === 404) return null
  return res.text()
}

async function fetchNpmReadme(pkg) {
  const res = await fetchRetry(`https://registry.npmjs.org/${pkg}`, { notFoundOk: true, retries: 2, headers: { 'user-agent': UA } })
  if (res.status === 404) return null
  const j = await res.json()
  return typeof j.readme === 'string' ? j.readme : null
}

async function fetchPypiLongDesc(pkg) {
  const res = await fetchRetry(`https://pypi.org/pypi/${encodeURIComponent(pkg)}/json`, { notFoundOk: true, retries: 2, headers: { 'user-agent': UA } })
  if (res.status === 404) return null
  const j = await res.json()
  return typeof j.info?.description === 'string' ? j.info.description : null
}

/** 剥掉 HuggingFace 模型卡开头的 YAML frontmatter(--- … ---),只留正文 markdown。 */
export function stripHfFrontmatter(md) {
  if (!md || typeof md !== 'string') return md
  const m = md.match(/^\s*---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  return m ? md.slice(m[0].length) : md
}

async function fetchHuggingFaceReadme(id) {
  // 模型卡原文在 raw 端点;开头常带 YAML frontmatter,先剥掉再清洗。
  const res = await fetchRetry(`https://huggingface.co/${id}/raw/main/README.md`, { notFoundOk: true, retries: 2, headers: { 'user-agent': UA } })
  if (res.status === 404) return null
  return stripHfFrontmatter(await res.text())
}

/** ModelScope 模型卡:raw README(与 HF 同构,含 YAML frontmatter,剥掉再清洗)。 */
async function fetchModelScopeReadme(id) {
  const res = await fetchRetry(`https://modelscope.cn/models/${id}/resolve/master/README.md`, { notFoundOk: true, retries: 2, headers: { 'user-agent': UA } })
  if (res.status === 404) return null
  return stripHfFrontmatter(await res.text())
}

/**
 * VS Code 扩展 README:先查 Marketplace gallery(POST extensionquery)拿 README 资源 URL,再取 markdown。
 * flags=103 让响应带上 versions[].files[](含 Content.Details 资源)。找不到资源则 null。
 */
async function fetchVscodeReadme(id) {
  const q = await fetchRetry('https://marketplace.visualstudio.com/_apis/public/gallery/extensionquery', {
    method: 'POST',
    notFoundOk: true,
    retries: 2,
    headers: { 'content-type': 'application/json', accept: 'application/json;api-version=7.2-preview.1', 'user-agent': UA },
    body: JSON.stringify({ filters: [{ criteria: [{ filterType: 7, value: id }] }], flags: 103 }),
  })
  if (q.status === 404) return null
  const j = await q.json()
  const version = j?.results?.[0]?.extensions?.[0]?.versions?.[0]
  const asset = version?.files?.find((f) => /Content\.Details/.test(f.assetType))
  if (!asset?.source) return null
  const res = await fetchRetry(asset.source, { notFoundOk: true, retries: 2, headers: { 'user-agent': UA } })
  if (res.status === 404) return null
  return res.text()
}

/**
 * 通用富集循环:逐项取原文 → 清洗 → 存 intro。容错、幂等、间隔温和。
 * @param {object} p
 */
async function enrichKind({ kind, ids, entityId, fetchRaw, writer, dbPath, log, refresh, gapMs }) {
  let written = 0
  let first = true
  for (const id of ids) {
    const eid = entityId(id)
    if (await hasIntro(dbPath, eid, refresh)) continue
    if (!first) await sleep(gapMs)
    first = false
    try {
      const raw = await fetchRaw(id)
      const intro = cleanReadmeIntro(raw)
      if (!intro) continue
      // 只更新 intro(实体由采集器建;不存在则无操作)。
      writer.setIntro(eid, intro)
      await writer.flush()
      written++
      if (written % 25 === 0) log(`  ${kind}: ${written} 条 intro 已写`)
    } catch (e) {
      log(`  ${kind} ${id}: 失败跳过,下次补:${e instanceof Error ? e.message : e}`)
    }
  }
  log(`${kind}: 共写 ${written} 条 intro`)
  return written
}

async function main() {
  const dbPath = process.env.DB_PATH || 'data.db'
  const token = process.env.GITHUB_TOKEN
  const args = process.argv.slice(2)
  const refresh = args.includes('--refresh')
  const kinds = args.filter((a) => !a.startsWith('--'))
  const want = kinds.length ? kinds : ['github', 'npm', 'pypi', 'huggingface', 'modelscope', 'vscode']
  const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`)
  log(`enrich start: db=${dbPath} kinds=${want.join(',')} refresh=${refresh}`)
  await ensureSchema(dbPath)
  const writer = createWriter(dbPath)

  if (want.includes('github')) {
    if (!token) throw new Error('missing GITHUB_TOKEN')
    log('── github intro ──')
    await enrichKind({
      kind: 'github',
      ids: GITHUB_REPOS,
      entityId: (r) => `github:${r}`,
      fetchRaw: (r) => fetchGithubReadme(r, token),
      writer,
      dbPath,
      log,
      refresh,
      gapMs: GH_GAP_MS,
    })
  }
  if (want.includes('npm')) {
    log('── npm intro ──')
    await enrichKind({
      kind: 'npm',
      ids: NPM_PACKAGES,
      entityId: (p) => `npm:${p}`,
      fetchRaw: (p) => fetchNpmReadme(p),
      writer,
      dbPath,
      log,
      refresh,
      gapMs: NPM_GAP_MS,
    })
  }
  if (want.includes('pypi')) {
    log('── pypi intro ──')
    await enrichKind({
      kind: 'pypi',
      ids: PYPI_PACKAGES,
      entityId: (p) => `pypi:${p}`,
      fetchRaw: (p) => fetchPypiLongDesc(p),
      writer,
      dbPath,
      log,
      refresh,
      gapMs: PYPI_GAP_MS,
    })
  }
  if (want.includes('huggingface')) {
    log('── huggingface intro ──')
    await enrichKind({
      kind: 'huggingface',
      ids: HF_MODELS,
      entityId: (id) => `huggingface:${id}`,
      fetchRaw: (id) => fetchHuggingFaceReadme(id),
      writer,
      dbPath,
      log,
      refresh,
      gapMs: GH_GAP_MS,
    })
  }
  if (want.includes('modelscope')) {
    log('── modelscope intro ──')
    await enrichKind({
      kind: 'modelscope',
      ids: MODELSCOPE_MODELS,
      entityId: (id) => `modelscope:${id}`,
      fetchRaw: (id) => fetchModelScopeReadme(id),
      writer,
      dbPath,
      log,
      refresh,
      gapMs: GH_GAP_MS,
    })
  }
  if (want.includes('vscode')) {
    log('── vscode intro ──')
    await enrichKind({
      kind: 'vscode',
      ids: VSCODE_EXTENSIONS,
      entityId: (id) => `vscode:${id}`,
      fetchRaw: (id) => fetchVscodeReadme(id),
      writer,
      dbPath,
      log,
      refresh,
      gapMs: GH_GAP_MS,
    })
  }
  await writer.flush()
  log('enrich done')
}

// 仅在直接运行时执行(被 import 作纯函数测试时不跑)。
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error('fatal:', e)
    process.exit(1)
  })
}
