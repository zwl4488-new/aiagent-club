// R2 / 环境配置(阶段 0 只定义名字,阶段 1 才真正读写)。
//
// data.db 存在 Cloudflare R2(私有 bucket),只有 CI/采集器会碰它,终端用户永远不碰。
// bucket 必须保持私有:绝不绑自定义域名、绝不开公开访问——按错一个开关,历史资产当场送人。

/**
 * @typedef {Object} R2Config
 * @property {string} accountId
 * @property {string} accessKeyId
 * @property {string} secretAccessKey
 * @property {string} bucket
 * @property {string} endpoint  S3 兼容 endpoint,由 accountId 推出
 */

/** @typedef {'actions' | 'fc-cn' | 'local'} Environment */

/**
 * 从环境变量读 R2 配置;缺任意一项即抛错(仅在真正需要 R2 时调用)。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {R2Config}
 */
export function loadR2Config(env = process.env) {
  const accountId = req(env, 'R2_ACCOUNT_ID')
  return {
    accountId,
    accessKeyId: req(env, 'R2_ACCESS_KEY_ID'),
    secretAccessKey: req(env, 'R2_SECRET_ACCESS_KEY'),
    bucket: req(env, 'R2_BUCKET'),
    // 优先用显式给出的 S3 端点(Cloudflare 控制台提供);留空才从 accountId 推。
    endpoint: env.S3_API_ENDPOINT?.trim() || `https://${accountId}.r2.cloudflarestorage.com`,
  }
}

/**
 * 执行环境标识,写入 fetch_runs.environment。
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {Environment}
 */
export function currentEnvironment(env = process.env) {
  if (env.FC_CN === '1') return 'fc-cn'
  if (env.GITHUB_ACTIONS === 'true') return 'actions'
  return 'local'
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} key
 * @returns {string}
 */
function req(env, key) {
  const v = env[key]
  if (!v) throw new Error(`missing required env var: ${key}`)
  return v
}
