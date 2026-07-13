// 种子实体清单(阶段 1 冷启动)。
//
// 这是"第一批要追踪什么"的默认集合——AI agent 框架、MCP 生态、agent 工具/基建。
// 只要出现在这里,collector 就会每天为它抓一套指标,时序从此开始积累。
// 增删只改这里;删掉某项不会删历史数据(metrics 里已积累的行原样保留)。
//
// 命名:全部是 GitHub "owner/name"。改名的 repo GitHub 会在 GraphQL 里返回 null,
// collector 记进 missing 并跳过,不会误伤整批——发现 missing 时把这里的名字改成新名即可。

/** @type {string[]} */
export const GITHUB_REPOS = [
  // ── agent 框架 ──
  'langchain-ai/langchain',
  'langchain-ai/langgraph',
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

  // ── agent 工具 / 应用 ──
  'Aider-AI/aider',
  'All-Hands-AI/OpenHands',
  'browser-use/browser-use',
  'assafelovic/gpt-researcher',
  'OpenBMB/ChatDev',
  'livekit/agents',

  // ── 基建 / 记忆 / 路由 ──
  'BerriAI/litellm',
  'deepset-ai/haystack',
  'mem0ai/mem0',
  'e2b-dev/E2B',

  // ── MCP 生态 ──
  'modelcontextprotocol/servers',
  'modelcontextprotocol/python-sdk',
  'modelcontextprotocol/typescript-sdk',
  'modelcontextprotocol/modelcontextprotocol',
]

// npm 包(周下载量)。scoped 用 @scope/name。
/** @type {string[]} */
export const NPM_PACKAGES = [
  'langchain',
  '@langchain/core',
  '@langchain/langgraph',
  'llamaindex',
  'ai', // Vercel AI SDK
  'openai',
  '@anthropic-ai/sdk',
  '@modelcontextprotocol/sdk',
  '@mastra/core',
  '@openai/agents',
]

// PyPI 包(下载量,名字用 PyPI 规范化后的连字符形式)。
/** @type {string[]} */
export const PYPI_PACKAGES = [
  'langchain',
  'langchain-core',
  'langgraph',
  'llama-index',
  'openai',
  'anthropic',
  'crewai',
  'litellm',
  'dspy',
  'mcp',
  'smolagents',
  'pydantic-ai',
]
