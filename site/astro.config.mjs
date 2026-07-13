import { defineConfig } from 'astro/config'

// 纯静态站(SSG):构建产物是静态 HTML,推 CF Pages(境外)+ 阿里云 OSS(境内)。
// 不接分析、不追踪访客。
export default defineConfig({
  site: 'https://aiagent.club',
  build: { format: 'directory' }, // /zh/ → /zh/index.html
  trailingSlash: 'ignore',
})
