// 采集编排器(阶段 1)。
//
// 职责:确保建表 → 逐源抓取(失败隔离)→ 每源写一行 fetch_runs → 一次事务落盘。
// 失败隔离是无人值守的底线:一个源挂了(限速/改版/网络)绝不能拖垮其余源当天的数据点。
//
// 用法:
//   node --env-file=.env src/run.mjs              # 抓全部源
//   node --env-file=.env src/run.mjs github       # 只抓指定源
//   DB_PATH=/tmp/x.db node --env-file=.env src/run.mjs
//
// 环境:DB_PATH(默认 data.db)、GITHUB_TOKEN、CAPTURED_AT(默认今天 UTC,回填用)。

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createWriter, runSqlite } from './db.mjs'
import { currentEnvironment } from './config.mjs'
import { collectGithub } from './fetch/github.mjs'
import { collectNpm } from './fetch/npm.mjs'
import { collectPypi } from './fetch/pypi.mjs'
import { collectOpenRouterModels, collectOpenRouterUsage } from './fetch/openrouter.mjs'
import { collectModelScope } from './fetch/modelscope.mjs'
import { collectVscode } from './fetch/vscode.mjs'
import { GITHUB_REPOS, NPM_PACKAGES, PYPI_PACKAGES, MODELSCOPE_MODELS, VSCODE_EXTENSIONS } from './entities.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** 今天的 UTC 日期 'YYYY-MM-DD'。 */
export function todayUTC() {
  return new Date().toISOString().slice(0, 10)
}

/** 现在的 ISO datetime。 */
function nowISO() {
  return new Date().toISOString()
}

/**
 * 确保 schema 已建(CREATE TABLE IF NOT EXISTS,幂等)。fresh clone 也能直接跑。
 * @param {string} dbPath
 */
async function ensureSchema(dbPath) {
  const schema = await readFile(join(__dirname, '..', 'db', 'schema.sql'), 'utf8')
  await runSqlite(dbPath, schema)
}

/**
 * 源注册表:name → 执行函数。执行函数拿 ctx,返回 { metricsWritten, missing }。
 * @type {Record<string, (ctx: { writer: any, capturedAt: string, log: (m:string)=>void }) => Promise<{ metricsWritten: number, missing: string[] }>>}
 */
const SOURCES = {
  async github({ writer, capturedAt, log }) {
    const token = process.env.GITHUB_TOKEN
    if (!token) throw new Error('missing GITHUB_TOKEN')
    const { metricsWritten, missing } = await collectGithub({
      repos: GITHUB_REPOS,
      token,
      capturedAt,
      writer,
      log,
    })
    return { metricsWritten, missing }
  },

  async npm({ writer, capturedAt, log }) {
    // 公开 API,无需 token。
    const { metricsWritten, missing } = await collectNpm({ packages: NPM_PACKAGES, capturedAt, writer, log })
    return { metricsWritten, missing }
  },

  async pypi({ writer, capturedAt, log }) {
    // 公开 API(pypistats),无需 token。
    const { metricsWritten, missing } = await collectPypi({ packages: PYPI_PACKAGES, capturedAt, writer, log })
    return { metricsWritten, missing }
  },

  async openrouter({ writer, capturedAt, log }) {
    // /models 公开无 key(定价 + 模型元信息);用量排行需 OPENROUTER_API_KEY,有则带上。
    const m = await collectOpenRouterModels({ capturedAt, writer, log })
    let metricsWritten = m.metricsWritten
    const key = process.env.OPENROUTER_API_KEY
    if (key) {
      try {
        const u = await collectOpenRouterUsage({ capturedAt, writer, apiKey: key, log })
        metricsWritten += u.metricsWritten
      } catch (e) {
        log(`openrouter usage 跳过:${e instanceof Error ? e.message : e}`)
      }
    } else {
      log('openrouter usage:无 OPENROUTER_API_KEY,跳过用量排行')
    }
    return { metricsWritten, missing: [] }
  },

  async modelscope({ writer, capturedAt, log }) {
    // 国内模型下载量,公开无需 key。
    const { metricsWritten, missing } = await collectModelScope({ models: MODELSCOPE_MODELS, capturedAt, writer, log })
    return { metricsWritten, missing }
  },

  async vscode({ writer, capturedAt, log }) {
    // VS Code Marketplace 安装量,公开无需 key。
    const { metricsWritten, missing } = await collectVscode({ extensions: VSCODE_EXTENSIONS, capturedAt, writer, log })
    return { metricsWritten, missing }
  },
}

async function main() {
  const dbPath = process.env.DB_PATH || 'data.db'
  const capturedAt = process.env.CAPTURED_AT || todayUTC()
  const environment = currentEnvironment()
  const requested = process.argv.slice(2)
  const names = requested.length ? requested : Object.keys(SOURCES)

  const log = (m) => console.log(`[${new Date().toISOString()}] ${m}`)
  log(`run start: env=${environment} capturedAt=${capturedAt} db=${dbPath} sources=${names.join(',')}`)

  await ensureSchema(dbPath)
  const writer = createWriter(dbPath)

  let hadError = false
  for (const name of names) {
    const source = SOURCES[name]
    if (!source) {
      log(`unknown source: ${name} (跳过)`)
      hadError = true
      continue
    }
    const started_at = nowISO()
    try {
      const { metricsWritten, missing } = await source({ writer, capturedAt, log })
      writer.recordRun({
        source: name,
        environment,
        status: missing.length ? 'partial' : 'ok',
        rows_written: metricsWritten,
        error: missing.length ? `missing repos: ${missing.join(', ')}` : undefined,
        started_at,
        finished_at: nowISO(),
      })
      log(`source ${name}: ok, ${metricsWritten} metric rows${missing.length ? `, ${missing.length} missing` : ''}`)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // 隔离:记 error 行,继续下一个源。partial 写入仍留在 writer 缓冲里,一起落盘。
      writer.recordRun({
        source: name,
        environment,
        status: 'error',
        rows_written: 0,
        error: msg.slice(0, 500),
        started_at,
        finished_at: nowISO(),
      })
      log(`source ${name}: ERROR ${msg}`)
      hadError = true
    }
  }

  const written = await writer.flush()
  log(`run done: flushed ${written} statements`)
  // 非零退出让 CI 显示红,但数据(含部分成功)已落盘。
  process.exit(hadError ? 1 : 0)
}

main().catch((e) => {
  console.error('fatal:', e)
  process.exit(1)
})
