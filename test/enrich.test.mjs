import assert from 'node:assert/strict'
import { test } from 'node:test'
import { cleanReadmeIntro } from '../src/enrich.mjs'

test('cleanReadmeIntro: 剥掉徽章/图片/HTML/标题,留 prose', () => {
  const md = [
    '<p align="center"><img src="logo.png"></p>',
    '# MyProject',
    '',
    '[![Build](https://shields.io/x)](https://ci) [![npm](https://img.shields.io/npm/v/x)](https://npm)',
    '',
    'MyProject is a framework for building AI agents. It makes orchestration simple and testable.',
    '',
    '## Install',
    '```bash',
    'npm install myproject',
    '```',
  ].join('\n')
  const out = cleanReadmeIntro(md)
  assert.ok(out.startsWith('MyProject is a framework for building AI agents'), out)
  assert.ok(!/shields\.io|logo\.png|npm install|# MyProject/.test(out), 'no badges/code/heading leaked')
})

test('cleanReadmeIntro: 跳过导航栏段落(Home · Docs · Blog)', () => {
  const md = ['[Home](/) · [Docs](/d) · [Blog](/b)', '', 'Acme is a tool that turns prompts into workflows for real production use.'].join('\n')
  const out = cleanReadmeIntro(md)
  assert.ok(out.startsWith('Acme is a tool'), out)
  assert.ok(!out.includes('·'), 'nav bar excluded')
})

test('cleanReadmeIntro: 去 [!TIP] alert 与裸链接', () => {
  const md = 'Foo is a library for X. [!TIP] see https://example.com/guide for more. It is widely used in production.'
  const out = cleanReadmeIntro(md)
  assert.ok(!out.includes('[!TIP]'))
  assert.ok(!out.includes('http'))
  assert.ok(out.includes('Foo is a library'))
})

test('cleanReadmeIntro: 截断到 maxLen 加省略号', () => {
  const long = 'This project does something. ' + 'word '.repeat(300)
  const out = cleanReadmeIntro(long, 120)
  assert.ok(out.length <= 121, `len ${out.length}`)
  assert.ok(out.endsWith('…'))
})

test('cleanReadmeIntro: 无 prose / 空 → null', () => {
  assert.equal(cleanReadmeIntro(''), null)
  assert.equal(cleanReadmeIntro(null), null)
  assert.equal(cleanReadmeIntro('# Title\n\n![img](x.png)\n\n```\ncode\n```'), null)
})
