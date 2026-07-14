// GitHub 源 — GraphQL 批量抓取(阶段 1,关键路径)。
//
// 一次请求用 alias 打包最多 100 个 repo(r0/r1/...),把 5000 point/小时的额度用在刀刃上:
// 100 repo 抓一整套指标只花个位数 point。fetchRetry 负责二级限速退避。
//
// 一次快照取的指标(全在一次 GraphQL 里,cost 极低——只要 totalCount,不取节点):
//   stars / forks / watchers / open_issues / open_prs / releases / commits(默认分支累计)
// 贡献者多样性不在 GraphQL 里(要 REST + Link header,每 repo 一次),留给后续低频独立采集器。

import { fetchRetry, sleep, backoffMs } from './client.mjs'

export const GITHUB_GRAPHQL = 'https://api.github.com/graphql'
// 每批 repo 数。太大时单个 GraphQL 查询过重——每个 repo 的 history{totalCount} 要数全部
// 提交,很重;实测 35 个一批会网关超时(502),20 个稳(~8s)。取 20 留足余量。
export const BATCH_SIZE = 20
export const SOURCE = 'github'

/**
 * 发一个 GraphQL 请求并要求返回含 data。
 * GitHub GraphQL 偶发返回 200 + 顶层 errors 且无 data("Something went wrong...")——
 * 这类瞬时服务端错误 fetchRetry 不会重试(HTTP 是 200),故在此层退避重试。
 * 缺 repo 的 NOT_FOUND 会带 partial data(data 存在),不触发重试。
 * @param {string} query
 * @param {string} token
 * @param {{ retries?: number }} [opts]
 * @returns {Promise<any>}
 */
export async function githubGraphQLRequest(query, token, { retries = 4 } = {}) {
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetchRetry(GITHUB_GRAPHQL, {
      method: 'POST',
      headers: { authorization: `bearer ${token}`, 'content-type': 'application/json', 'user-agent': 'aiagent-club' },
      body: JSON.stringify({ query }),
    })
    const json = await res.json()
    if (json.data) return json
    lastErr = new Error(`GraphQL no data: ${JSON.stringify(json.errors ?? json).slice(0, 300)}`)
    if (attempt < retries) await sleep(backoffMs(attempt, 1000, null, Math.random()))
  }
  throw lastErr
}

/**
 * 把数组切成定长块。
 * @template T
 * @param {T[]} arr
 * @param {number} size
 * @returns {T[][]}
 */
export function chunk(arr, size) {
  const out = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
}

const REPO_FIELDS = `
  nameWithOwner
  url
  isArchived
  stargazerCount
  forkCount
  watchers { totalCount }
  issues(states: OPEN) { totalCount }
  pullRequests(states: OPEN) { totalCount }
  releases { totalCount }
  pushedAt
  createdAt
  primaryLanguage { name }
  defaultBranchRef { target { ... on Commit { history { totalCount } } } }
`

/**
 * 为一批 "owner/name" 构造带 alias 的 GraphQL 查询与 alias→repo 映射。
 * 纯函数,便于单测。
 * @param {string[]} repos
 * @returns {{ query: string, aliasToRepo: Record<string,string> }}
 */
export function buildBatchQuery(repos) {
  /** @type {Record<string,string>} */
  const aliasToRepo = {}
  const parts = repos.map((repo, i) => {
    const slash = repo.indexOf('/')
    if (slash <= 0 || slash === repo.length - 1) throw new Error(`invalid repo "owner/name": ${JSON.stringify(repo)}`)
    const owner = repo.slice(0, slash)
    const name = repo.slice(slash + 1)
    const alias = `r${i}`
    aliasToRepo[alias] = repo
    // owner/name 用 JSON.stringify 转义进 GraphQL 字符串字面量。
    return `  ${alias}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {${REPO_FIELDS}}`
  })
  const query = `query {\n${parts.join('\n')}\n  rateLimit { cost remaining resetAt }\n}`
  return { query, aliasToRepo }
}

/**
 * 把单个 repo 的 GraphQL 节点摊平成 { metrics, meta }。
 * @param {any} node
 * @returns {{ metrics: Record<string, number>, meta: { name: string, url: string, category: string|null, createdAt: string|null, archived: boolean } }}
 */
export function parseRepoNode(node) {
  const commits = node.defaultBranchRef?.target?.history?.totalCount
  const metrics = {
    stars: node.stargazerCount,
    forks: node.forkCount,
    watchers: node.watchers?.totalCount,
    open_issues: node.issues?.totalCount,
    open_prs: node.pullRequests?.totalCount,
    releases: node.releases?.totalCount,
  }
  if (typeof commits === 'number') metrics.commits = commits
  // 只保留数值指标(空分支的 repo 没有 commits,已在上面 gate)。
  for (const k of Object.keys(metrics)) {
    if (typeof metrics[k] !== 'number') delete metrics[k]
  }
  return {
    metrics,
    meta: {
      name: node.nameWithOwner,
      url: node.url,
      category: node.primaryLanguage?.name ?? null,
      createdAt: node.createdAt ? node.createdAt.slice(0, 10) : null,
      archived: Boolean(node.isArchived),
    },
  }
}

/**
 * 抓一批 repo,返回每个 repo 的解析结果 + 本批限额信息。
 * 单个 alias 为 null(repo 改名/删除)不影响整批:记进 missing 并跳过。
 * @param {string[]} repos
 * @param {string} token
 * @returns {Promise<{ results: Array<{repo: string, metrics: Record<string,number>, meta: any}>, missing: string[], rateLimit: any }>}
 */
export async function fetchRepoBatch(repos, token) {
  const { query, aliasToRepo } = buildBatchQuery(repos)
  // 缺 repo 的 NOT_FOUND 会带 partial data,正常处理;瞬时"无 data"错误由 helper 退避重试。
  const json = await githubGraphQLRequest(query, token)
  const results = []
  const missing = []
  for (const [alias, repo] of Object.entries(aliasToRepo)) {
    const node = json.data[alias]
    if (!node) {
      missing.push(repo)
      continue
    }
    const { metrics, meta } = parseRepoNode(node)
    results.push({ repo, metrics, meta })
  }
  return { results, missing, rateLimit: json.data.rateLimit }
}

/**
 * 抓取全部 repo,把结果写进 writer(entities + metrics)。返回统计。
 * @param {object} p
 * @param {string[]} p.repos           "owner/name" 列表
 * @param {string} p.token
 * @param {string} p.capturedAt        ISO date 'YYYY-MM-DD'
 * @param {import('../db.mjs').createWriter extends (...a:any)=>infer W ? W : never} p.writer
 * @param {(msg: string) => void} [p.log]
 * @returns {Promise<{ metricsWritten: number, entitiesSeen: number, missing: string[] }>}
 */
export async function collectGithub({ repos, token, capturedAt, writer, log = () => {} }) {
  const batches = chunk(repos, BATCH_SIZE)
  let metricsWritten = 0
  let entitiesSeen = 0
  /** @type {string[]} */
  const missingAll = []

  for (let b = 0; b < batches.length; b++) {
    const { results, missing, rateLimit } = await fetchRepoBatch(batches[b], token)
    missingAll.push(...missing)
    for (const { repo, metrics, meta } of results) {
      const entity_id = `${SOURCE}:${repo}`
      writer.upsertEntity({
        entity_id,
        kind: 'github',
        ecosystem: 'global',
        name: meta.name,
        url: meta.url,
        category: meta.category ?? undefined,
        first_seen: meta.createdAt ?? undefined,
        last_seen: capturedAt,
        active: meta.archived ? 0 : 1,
      })
      entitiesSeen++
      for (const [metric, value] of Object.entries(metrics)) {
        writer.upsertMetric({ entity_id, metric, value, captured_at: capturedAt, source: SOURCE })
        metricsWritten++
      }
    }
    log(
      `github batch ${b + 1}/${batches.length}: ${results.length} repos, ${missing.length} missing, ` +
        `rateLimit ${rateLimit?.remaining}/${rateLimit ? '5000' : '?'} (cost ${rateLimit?.cost})`
    )
  }
  if (missingAll.length) log(`github missing repos (改名/删除?): ${missingAll.join(', ')}`)
  return { metricsWritten, entitiesSeen, missing: missingAll }
}
