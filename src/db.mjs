// 数据层 — 通过 sqlite3 CLI 读写 data.db(阶段 1)。
//
// 为什么 shell 到 CLI 而不是驱动库:node 20.19 没有内置 node:sqlite(22.5+ 才有),
// 而项目纪律是"零依赖直跑"。sqlite3 CLI 本地/CI(ubuntu runner)都自带,db:init 也已在用。
//
// 安全:所有值经 sqlText()/sqlNum() 转义再拼进 SQL。SQLite 字符串字面量的转义规则极简
// ——单引号加倍即可——所以拼串在这里是安全的(不是通用 RDBMS 的复杂转义)。含 NUL 的文本直接拒绝。
//
// 写入模型:一次 run 内把语句攒在 writer 里,flush() 一个事务落盘。
// metrics 表的 UNIQUE(entity_id,metric,captured_at) ON CONFLICT REPLACE 保证幂等:
// 同一天重跑只覆盖当天,天然可无人值守。

import { spawn } from 'node:child_process'

/**
 * 把值转成 SQLite 字符串字面量;null/undefined → NULL。
 * @param {unknown} v
 * @returns {string}
 */
export function sqlText(v) {
  if (v === null || v === undefined) return 'NULL'
  const s = String(v)
  if (s.includes('\0')) throw new Error('NUL byte in SQL text value')
  return "'" + s.replace(/'/g, "''") + "'"
}

/**
 * 把值转成数字字面量;非有限数抛错(绝不把 NaN/Infinity 写进 value 列)。
 * @param {unknown} v
 * @returns {string}
 */
export function sqlNum(v) {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) throw new Error(`non-finite numeric value: ${JSON.stringify(v)}`)
  return String(n)
}

/**
 * 执行一段 SQL(经 stdin 喂给 sqlite3)。json=true 时用 -json 输出并解析。
 * @param {string} dbPath
 * @param {string} sql
 * @param {{ json?: boolean }} [opts]
 * @returns {Promise<string | any[]>}
 */
export function runSqlite(dbPath, sql, { json = false } = {}) {
  return new Promise((resolve, reject) => {
    const args = json ? ['-json', dbPath] : [dbPath]
    const p = spawn('sqlite3', args, { stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    p.stdout.on('data', (d) => (out += d))
    p.stderr.on('data', (d) => (err += d))
    p.on('error', reject)
    p.on('close', (code) => {
      if (code !== 0) return reject(new Error(`sqlite3 exit ${code}: ${err.trim() || '(no stderr)'}`))
      if (!json) return resolve(out)
      const trimmed = out.trim()
      resolve(trimmed ? JSON.parse(trimmed) : [])
    })
    // busy_timeout:并发写(如回填 + 采集同时跑)时等待而非立刻 SQLITE_BUSY 报错。
    // 仅写模式加(json 读模式下该 PRAGMA 会污染 -json 输出;读在 WAL 下本就不阻塞)。
    if (!json) p.stdin.write('PRAGMA busy_timeout=30000;\n')
    p.stdin.write(sql)
    p.stdin.end()
  })
}

/**
 * 只读查询,返回行对象数组。
 * @param {string} dbPath
 * @param {string} sql
 * @returns {Promise<any[]>}
 */
export async function query(dbPath, sql) {
  return /** @type {any[]} */ (await runSqlite(dbPath, sql, { json: true }))
}

/**
 * @typedef {Object} EntityRow
 * @property {string} entity_id
 * @property {string} kind
 * @property {'global'|'cn'} ecosystem
 * @property {string} [name]
 * @property {string} [url]
 * @property {string} [category]
 * @property {string} [description]
 * @property {'en'|'zh'} [lang]
 * @property {string} [first_seen]  ISO date
 * @property {string} [last_seen]   ISO date
 * @property {number} [active]
 */

/**
 * @typedef {Object} MetricRow
 * @property {string} entity_id
 * @property {string} metric
 * @property {number} value
 * @property {string} captured_at  ISO date 'YYYY-MM-DD'
 * @property {string} source
 */

/**
 * @typedef {Object} RunRow
 * @property {string} source
 * @property {string} environment
 * @property {'ok'|'partial'|'error'} status
 * @property {number} [rows_written]
 * @property {string} [error]
 * @property {string} started_at   ISO datetime
 * @property {string} [finished_at]
 */

/**
 * 攒语句、一次事务落盘的写入器。
 * @param {string} dbPath
 */
export function createWriter(dbPath) {
  /** @type {string[]} */
  const stmts = []

  return {
    /** @param {EntityRow} e */
    upsertEntity(e) {
      // 维度表用显式 upsert:name/url/category/description/lang 用 COALESCE 保留已有非空值,
      // first_seen 取最早(保留旧值),last_seen 取最新。
      // description 采到新值就刷新(excluded 优先),采不到(NULL)则保留旧简介——单次抓取失败绝不抹掉已有描述。
      stmts.push(
        `INSERT INTO entities (entity_id,kind,ecosystem,name,url,category,description,lang,first_seen,last_seen,active) VALUES (` +
          `${sqlText(e.entity_id)},${sqlText(e.kind)},${sqlText(e.ecosystem)},${sqlText(e.name)},${sqlText(e.url)},` +
          `${sqlText(e.category)},${sqlText(e.description)},${sqlText(e.lang)},${sqlText(e.first_seen)},${sqlText(e.last_seen)},${sqlNum(e.active ?? 1)}) ` +
          `ON CONFLICT(entity_id) DO UPDATE SET ` +
          `kind=excluded.kind, ecosystem=excluded.ecosystem, ` +
          `name=COALESCE(excluded.name,entities.name), url=COALESCE(excluded.url,entities.url), ` +
          `category=COALESCE(excluded.category,entities.category), ` +
          `description=COALESCE(excluded.description,entities.description), lang=COALESCE(excluded.lang,entities.lang), ` +
          `first_seen=COALESCE(entities.first_seen,excluded.first_seen), ` +
          `last_seen=COALESCE(excluded.last_seen,entities.last_seen), active=excluded.active;`
      )
    },

    /**
     * 只更新某实体的 intro(项目介绍摘录),不动其它列。实体不存在则无操作(intro 无处可挂)。
     * @param {string} entity_id
     * @param {string} intro
     */
    setIntro(entity_id, intro) {
      stmts.push(`UPDATE entities SET intro=${sqlText(intro)} WHERE entity_id=${sqlText(entity_id)};`)
    },

    /**
     * 只更新某实体的 project_key(多源归并键)。
     * @param {string} entity_id
     * @param {string} project_key
     */
    setProjectKey(entity_id, project_key) {
      stmts.push(`UPDATE entities SET project_key=${sqlText(project_key)} WHERE entity_id=${sqlText(entity_id)};`)
    },

    /** @param {MetricRow} m */
    upsertMetric(m) {
      // metrics 的 UNIQUE...ON CONFLICT REPLACE 由 schema 保证 → 直接 INSERT,冲突自动替换当天值。
      stmts.push(
        `INSERT INTO metrics (entity_id,metric,value,captured_at,source) VALUES (` +
          `${sqlText(m.entity_id)},${sqlText(m.metric)},${sqlNum(m.value)},${sqlText(m.captured_at)},${sqlText(m.source)});`
      )
    },

    /** @param {RunRow} r */
    recordRun(r) {
      stmts.push(
        `INSERT INTO fetch_runs (source,environment,status,rows_written,error,started_at,finished_at) VALUES (` +
          `${sqlText(r.source)},${sqlText(r.environment)},${sqlText(r.status)},${sqlNum(r.rows_written ?? 0)},` +
          `${sqlText(r.error)},${sqlText(r.started_at)},${sqlText(r.finished_at)});`
      )
    },

    /** 当前攒了多少条待写语句。 */
    get pending() {
      return stmts.length
    },

    /**
     * 一个事务落盘,返回写入的语句条数;清空缓冲。
     * @returns {Promise<number>}
     */
    async flush() {
      if (stmts.length === 0) return 0
      const sql = 'BEGIN;\n' + stmts.join('\n') + '\nCOMMIT;\n'
      await runSqlite(dbPath, sql)
      const n = stmts.length
      stmts.length = 0
      return n
    },
  }
}
