// entity_id — 全局主键规范(阶段 0 固化)
//
// 格式:  '<kind>:<identifier>'    以第一个 ':' 分割,identifier 内可含 ':'（少见）。
// 例:    'github:langchain-ai/langchain'
//         'npm:@langchain/core'
//         'pypi:langchain'
//         'coze:bot/7300000000'
//         'pricing:openai/gpt-store'
//
// 为什么现在固化:entity_id 是 metrics/entities 所有行的键,改一次要迁移全表。
// 命名空间不重叠,是"国内外两条管道各写各的、构建时一次 append 合并、永不撞键"的前提。
//
// JSDoc + tsconfig(checkJs) 提供类型检查;写成 .mjs 是为了在 node 20 上零依赖直接跑。

/** @typedef {'global' | 'cn'} Ecosystem */
/** @typedef {{ kind: string, id: string }} ParsedEntity */

export const KINDS = /** @type {const} */ ([
  // ── global(境外 Actions 抓)──
  'github',
  'npm',
  'pypi',
  'hf', // Hugging Face
  'openrouter',
  'mcp',
  // ── cn(国内源)──
  'modelscope', // 魔搭:国内模型下载量
  'gitee',
  'coze',
  'tongyi',
  'wenxin',
  'zhipu',
  'minimax',
  'baichuan',
  // ── 跨生态,ecosystem 需在 entities 表显式指定 ──
  'pricing',
])

const KIND_SET = new Set(KINDS)
const GLOBAL_KINDS = new Set(['github', 'npm', 'pypi', 'hf', 'openrouter', 'mcp'])
const CN_KINDS = new Set(['modelscope', 'gitee', 'coze', 'tongyi', 'wenxin', 'zhipu', 'minimax', 'baichuan'])

/**
 * kind → 默认 ecosystem;返回 null 表示无法从 kind 推断(如 pricing),必须显式指定。
 * @param {string} kind
 * @returns {Ecosystem | null}
 */
export function ecosystemForKind(kind) {
  if (GLOBAL_KINDS.has(kind)) return 'global'
  if (CN_KINDS.has(kind)) return 'cn'
  return null
}

/**
 * 构造并校验一个 entity_id。id 非法时抛错。
 * @param {string} kind
 * @param {string} id
 * @returns {string}
 */
export function buildEntityId(kind, id) {
  const trimmed = id.trim()
  if (!KIND_SET.has(kind)) throw new Error(`unknown kind: ${kind}`)
  if (!isValidId(trimmed)) throw new Error(`invalid identifier: ${JSON.stringify(id)}`)
  return `${kind}:${trimmed}`
}

/**
 * 解析 entity_id;非法返回 null(不抛,便于批处理中过滤)。
 * @param {string} entityId
 * @returns {ParsedEntity | null}
 */
export function parseEntityId(entityId) {
  const idx = entityId.indexOf(':')
  if (idx <= 0) return null
  const kind = entityId.slice(0, idx)
  const id = entityId.slice(idx + 1)
  if (!KIND_SET.has(kind) || !isValidId(id)) return null
  return { kind, id }
}

/**
 * @param {string} entityId
 * @returns {boolean}
 */
export function isValidEntityId(entityId) {
  return parseEntityId(entityId) !== null
}

// identifier 规则:非空、无空白字符、无首尾斜杠。
/**
 * @param {string} id
 * @returns {boolean}
 */
function isValidId(id) {
  if (id.length === 0) return false
  if (/\s/.test(id)) return false
  if (id.startsWith('/') || id.endsWith('/')) return false
  return true
}
