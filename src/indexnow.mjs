// IndexNow:每次部署后主动通知搜索引擎(Bing / Yandex / DuckDuckGo 等)核心页面已刷新,
// 秒级触发重抓,不必等爬虫。key 的公钥校验文件在 site/public/<KEY>.txt(部署后可公网访问)。
//
// 只推"每天随数据变的索引页"(首页/榜单/变更日志/定价/方法论/浏览,中英),约 12 个 —— 爬虫会由此
// 顺链再抓详情页。不逐条推 5000 个长尾页(既无必要、也易被限速)。失败只告警,绝不拖垮部署。
//
// 用法:node src/indexnow.mjs   (deploy 收尾调用)

const KEY = '6e09da7bb0844b5fbb612e284c716569'
const HOST = 'www.aiagent.club'
const ORIGIN = `https://${HOST}`

const PATHS = [
  '/', '/zh/',
  '/projects', '/zh/projects',
  '/changes', '/zh/changes',
  '/pricing', '/zh/pricing',
  '/methodology', '/zh/methodology',
  '/browse', '/zh/browse',
]

async function main() {
  const urlList = PATHS.map((p) => ORIGIN + p)
  const body = { host: HOST, key: KEY, keyLocation: `${ORIGIN}/${KEY}.txt`, urlList }
  const log = (m) => console.log(`[${new Date().toISOString()}] indexnow: ${m}`)
  try {
    const res = await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    })
    // 200/202 = 已接受;其它状态只记录不报错(IndexNow 抽风不该拖垮部署)。
    log(`${urlList.length} urls → HTTP ${res.status}${res.status === 200 || res.status === 202 ? ' (accepted)' : ''}`)
  } catch (e) {
    log(`ping 失败(忽略,不影响部署):${e instanceof Error ? e.message : e}`)
  }
}

main()
