// 种子实体清单(阶段 1 冷启动 + 阶段 2 扩充)。
//
// 这是"追踪什么"的默认集合——AI agent 框架、MCP 生态、agent 工具/基建/可观测。
// 只要出现在这里,collector 就每天为它抓一套指标,时序从此积累。
// 增删只改这里;删掉某项不删历史(metrics 里已积累的行原样保留)。
//
// 命名:GitHub "owner/name"。改名的 repo GraphQL 返回 null,collector 记 missing 并跳过,
// 不误伤整批——发现 missing 时把名字改成新名即可。名字变动很常见,定期核对。
//
// 两层结构:SEED_*(手工策展基准,人改这里)+ discovered.json(src/discover.mjs 自动发现)。
// 导出的 GITHUB_REPOS/NPM_PACKAGES/PYPI_PACKAGES = SEED_* ∪ discovered,去重。collector 只认导出的合并集。
// 自动发现只增不改种子;去重以 SEED_* 为准(见 discover.mjs),故重跑发现不会吞掉旧发现。

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** @type {string[]} */
export const SEED_GITHUB_REPOS = [
  // ── agent 框架 ──
  'langchain-ai/langchain',
  'langchain-ai/langgraph',
  'langchain-ai/langchainjs',
  'run-llama/llama_index',
  'microsoft/autogen',
  'microsoft/semantic-kernel',
  'crewAIInc/crewAI',
  'Significant-Gravitas/AutoGPT',
  'geekan/MetaGPT',
  'pydantic/pydantic-ai',
  'stanfordnlp/dspy',
  'huggingface/smolagents',
  'openai/openai-agents-python',
  'google/adk-python',
  'agno-agi/agno',
  'camel-ai/camel',
  'kyegomez/swarms',
  'TransformerOptimus/SuperAGI',
  'reworkd/AgentGPT',
  'yoheinakajima/babyagi',
  'letta-ai/letta',
  'QwenLM/Qwen-Agent',
  'modelscope/agentscope',
  'PrefectHQ/marvin',
  'superagent-ai/superagent',

  // ── agent 应用 / 编码 agent ──
  'Aider-AI/aider',
  'All-Hands-AI/OpenHands',
  'browser-use/browser-use',
  'assafelovic/gpt-researcher',
  'OpenBMB/ChatDev',
  'livekit/agents',
  'OpenInterpreter/open-interpreter',
  'SWE-agent/SWE-agent',
  'cline/cline',
  'continuedev/continue',
  'block/goose',
  'stanford-oval/storm',

  // ── 平台 / 低代码 / RAG ──
  'langgenius/dify',
  'FlowiseAI/Flowise',
  'langflow-ai/langflow',
  'n8n-io/n8n',
  'activepieces/activepieces',
  'infiniflow/ragflow',
  'eosphoros-ai/DB-GPT',
  'QuivrHQ/quivr',
  'microsoft/promptflow',
  'lobehub/lobe-chat',

  // ── 基建 / 记忆 / 路由 / 工具 ──
  'BerriAI/litellm',
  'deepset-ai/haystack',
  'mem0ai/mem0',
  'e2b-dev/E2B',
  'vercel/ai',
  'mendableai/firecrawl',
  'unclecode/crawl4ai',
  'microsoft/markitdown',
  'Portkey-AI/gateway',
  'simonw/llm',

  // ── 可观测 / 评测 ──
  'langfuse/langfuse',
  'Arize-ai/phoenix',
  'AgentOps-AI/agentops',
  'traceloop/openllmetry',

  // ── MCP 生态 ──
  'modelcontextprotocol/servers',
  'modelcontextprotocol/python-sdk',
  'modelcontextprotocol/typescript-sdk',
  'modelcontextprotocol/modelcontextprotocol',
  'github/github-mcp-server',
  'lastmile-ai/mcp-agent',
  'jlowin/fastmcp',
]

// npm 包(周下载量)。scoped 用 @scope/name。
/** @type {string[]} */
export const SEED_NPM_PACKAGES = [
  'langchain',
  '@langchain/core',
  '@langchain/community',
  '@langchain/openai',
  '@langchain/anthropic',
  '@langchain/langgraph',
  'llamaindex',
  'ai', // Vercel AI SDK
  '@ai-sdk/openai',
  '@ai-sdk/anthropic',
  '@ai-sdk/react',
  'openai',
  '@anthropic-ai/sdk',
  '@google/genai',
  '@mistralai/mistralai',
  'cohere-ai',
  '@modelcontextprotocol/sdk',
  'fastmcp',
  '@mastra/core',
  '@openai/agents',
  '@browserbasehq/stagehand',
  '@e2b/code-interpreter',
  'langsmith',
  'chromadb',
  '@pinecone-database/pinecone',
  '@qdrant/js-client-rest',
  '@huggingface/inference',
]

// PyPI 包(下载量,名字用 PyPI 规范化后的连字符形式)。
/** @type {string[]} */
export const SEED_PYPI_PACKAGES = [
  'langchain',
  'langchain-core',
  'langchain-community',
  'langchain-openai',
  'langchain-anthropic',
  'langgraph',
  'llama-index',
  'llama-index-core',
  'openai',
  'anthropic',
  'google-genai',
  'mistralai',
  'cohere',
  'crewai',
  'pyautogen',
  'autogen-agentchat',
  'agno',
  'litellm',
  'dspy',
  'mcp',
  'fastmcp',
  'smolagents',
  'pydantic-ai',
  'instructor',
  'outlines',
  'guidance',
  'browser-use',
  'crawl4ai',
  'firecrawl-py',
  'tavily-python',
  'e2b-code-interpreter',
  'agentops',
  'langfuse',
  'haystack-ai',
  'chromadb',
  'qdrant-client',
]

// 魔搭 ModelScope 模型(国内真实下载量,kind=modelscope,ecosystem=cn)。全部实测有效。
// 精选主流国产 LLM(agent 相关);发现式扩容(dolphin 端点)留后续。
/** @type {string[]} */
export const MODELSCOPE_MODELS = [
  'Qwen/Qwen2.5-7B-Instruct',
  'Qwen/Qwen2.5-72B-Instruct',
  'Qwen/Qwen3-8B',
  'Qwen/Qwen3-235B-A22B',
  'deepseek-ai/DeepSeek-V3',
  'deepseek-ai/DeepSeek-R1',
  'deepseek-ai/DeepSeek-V3.1',
  'ZhipuAI/glm-4-9b-chat',
  'ZhipuAI/GLM-4.5',
  'ZhipuAI/GLM-4.6',
  '01ai/Yi-1.5-9B-Chat',
  'baichuan-inc/Baichuan2-13B-Chat',
  'Shanghai_AI_Laboratory/internlm2_5-7b-chat',
  'moonshotai/Kimi-K2-Instruct',
  'OpenBMB/MiniCPM-V-2_6',
  'LLM-Research/Meta-Llama-3.1-8B-Instruct',
]

// HuggingFace 开源模型(近30天下载量 + likes,ecosystem=global)。org/name,策展主流开源 LLM /
// agent 常用底座。改名/下架的 collector 记 missing 跳过,不误伤整源;定期核对。
/** @type {string[]} */
export const HF_MODELS = [
  // ── Meta Llama ──
  'meta-llama/Llama-3.1-8B-Instruct',
  'meta-llama/Llama-3.1-70B-Instruct',
  'meta-llama/Llama-3.3-70B-Instruct',
  'meta-llama/Llama-3.2-3B-Instruct',
  // ── Qwen ──
  'Qwen/Qwen2.5-7B-Instruct',
  'Qwen/Qwen2.5-72B-Instruct',
  'Qwen/Qwen2.5-Coder-32B-Instruct',
  'Qwen/QwQ-32B',
  // ── DeepSeek ──
  'deepseek-ai/DeepSeek-R1',
  'deepseek-ai/DeepSeek-V3',
  'deepseek-ai/DeepSeek-Coder-V2-Instruct',
  // ── Mistral ──
  'mistralai/Mistral-7B-Instruct-v0.3',
  'mistralai/Mixtral-8x7B-Instruct-v0.1',
  'mistralai/Mistral-Nemo-Instruct-2407',
  // ── Google Gemma ──
  'google/gemma-2-9b-it',
  'google/gemma-2-27b-it',
  // ── Microsoft Phi ──
  'microsoft/Phi-3.5-mini-instruct',
  'microsoft/phi-4',
  // ── agent 常用微调 / 其它 ──
  'HuggingFaceH4/zephyr-7b-beta',
  'NousResearch/Hermes-3-Llama-3.1-8B',
  'teknium/OpenHermes-2.5-Mistral-7B',
  'bigcode/starcoder2-15b',
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
]

// VS Code Marketplace 扩展(编码 agent/助手,安装量)。publisher.extension。含国产(灵码/CodeGeeX)。
/** @type {string[]} */
export const VSCODE_EXTENSIONS = [
  'saoudrizwan.claude-dev', // Cline
  'Continue.continue',
  'RooVeterinaryInc.roo-cline', // Roo Code
  'kilocode.kilo-code', // Kilo Code
  'Codeium.codeium',
  'sourcegraph.cody-ai',
  'github.copilot',
  'github.copilot-chat',
  'TabNine.tabnine-vscode',
  'AmazonWebServices.amazon-q-vscode',
  'google.geminicodeassist',
  'augment.vscode-augment',
  'anthropic.claude-code',
  'aminer.codegeex', // CodeGeeX(智谱)
  'Alibaba-Cloud.tongyi-lingma', // 通义灵码
]

// ── 自动发现合并层 ──────────────────────────────────────────────
// discovered.json 由 src/discover.mjs 生成(可能不存在:fresh clone / 尚未跑发现)。缺失时静默降级为纯种子。
const DISCOVERED_PATH = fileURLToPath(new URL('./discovered.json', import.meta.url))

/** @returns {{ github: Array<{repo:string}>, npm: Array<{name:string}>, pypi: Array<{name:string}> }} */
function loadDiscovered() {
  const empty = { github: [], npm: [], pypi: [] }
  if (!existsSync(DISCOVERED_PATH)) return empty
  try {
    const j = JSON.parse(readFileSync(DISCOVERED_PATH, 'utf8'))
    return { github: j.github ?? [], npm: j.npm ?? [], pypi: j.pypi ?? [] }
  } catch {
    return empty // 损坏的发现文件绝不能拖垮采集:降级为纯种子。
  }
}

/** 合并种子与新增标识符,大小写不敏感去重,保持"种子在前、发现在后"的稳定顺序。 */
function mergeUnique(seed, extra) {
  const seen = new Set(seed.map((s) => s.toLowerCase()))
  const out = [...seed]
  for (const id of extra) {
    const key = id.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(id)
  }
  return out
}

const _disc = loadDiscovered()

/**
 * 手工排除名单(数据清洗)。key = entity_id('<kind>:<identifier>')。
 * 两处用途:① 从采集目标里剔除,不再抓;② src/prune.mjs 据此删掉存量实体+指标。
 * 只放"确证的噪声 / 重复身份",宁缺毋滥——误杀会删掉真实项目历史。
 * 说明:GitHub 换 org/改名产生的重定向重复由 collectGithub 按 nameWithOwner 收敛 + prune 自动处理,
 * 不必列在这里;这里只列跨包生态无法自动识别的那类(如 PyPI 废弃别名、明显跑题的通用包)。
 */
export const EXCLUDE = new Set([
  // —— 跑题噪声(非 agent 生态,发现关键词误收) ——
  'npm:chat', // 通用聊天占位包,与 AI agent 无关
  'npm:mockserver-client', // 测试用 mock server 客户端
  // —— 重复身份(同一项目的废弃/别名包) ——
  'pypi:pyautogen', // AutoGen 的旧名,现为 autogen-agentchat(保留后者)
])

/** 从合并集里剔除 EXCLUDE(按 '<kind>:<id>' 匹配)。 */
function withoutExcluded(kind, ids) {
  return ids.filter((id) => !EXCLUDE.has(`${kind}:${id}`))
}

/** @type {string[]} 采集目标 = (种子 ∪ 自动发现) − 排除名单。 */
export const GITHUB_REPOS = withoutExcluded('github', mergeUnique(SEED_GITHUB_REPOS, _disc.github.map((d) => d.repo)))
/** @type {string[]} */
export const NPM_PACKAGES = withoutExcluded('npm', mergeUnique(SEED_NPM_PACKAGES, _disc.npm.map((d) => d.name)))
/** @type {string[]} */
export const PYPI_PACKAGES = withoutExcluded('pypi', mergeUnique(SEED_PYPI_PACKAGES, _disc.pypi.map((d) => d.name)))
