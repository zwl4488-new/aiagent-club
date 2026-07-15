// 种子实体清单(阶段 1 冷启动 + 阶段 2 扩充)。
//
// 这是"追踪什么"的默认集合——AI agent 框架、MCP 生态、agent 工具/基建/可观测。
// 只要出现在这里,collector 就每天为它抓一套指标,时序从此积累。
// 增删只改这里;删掉某项不删历史(metrics 里已积累的行原样保留)。
//
// 命名:GitHub "owner/name"。改名的 repo GraphQL 返回 null,collector 记 missing 并跳过,
// 不误伤整批——发现 missing 时把名字改成新名即可。名字变动很常见,定期核对。

/** @type {string[]} */
export const GITHUB_REPOS = [
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
export const NPM_PACKAGES = [
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
export const PYPI_PACKAGES = [
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
