import assert from 'node:assert/strict'
import {readdirSync} from 'node:fs'
import path from 'node:path'
import {pathToFileURL} from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const esbuildDir = readdirSync(path.join(root, 'node_modules/.pnpm')).find(name => name.startsWith('esbuild@'))
const {build} = await import(pathToFileURL(path.join(root, 'node_modules/.pnpm', esbuildDir, 'node_modules/esbuild/lib/main.js')).href)
const result = await build({entryPoints: [path.join(root, 'src/services/chat/replyMetadata.ts')], bundle: true, platform: 'node', format: 'esm', write: false})
const {stripInternalPromptMetadata: strip, createReplyMetadataFilter: create} = await import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))
let passed = 0
const check = (name, test) => { test(); passed++; console.log('PASS ' + name) }
const samples = [
  '【消息发送时间】2026-10-2100:58\n(UTC+08:00)\n你好。',
  '【消息发送时间】2026-10-21 00:58 (UTC+08:00)\n你好。',
  '【消息发送时间未记录】\n你好。',
  '【当前时间】2026/10/21 00:58:01\r\n你好。',
  '2026-10-21 00:58:01 （ UTC + 08:00 ）\n你好。',
  '2026-10-2100:58\n你好。',
  '】2026-10-21 00:58\n你好。',
  'UTC+08:00\n你好。',
  '(utc+08:00)\n你好。',
]
for (const [index, sample] of samples.entries()) check('time metadata variant ' + (index + 1), () => {
  assert.equal(strip(sample).trim(), '你好。')
  // Check every two-chunk boundary and single-character delivery, including intermediate output.
  const deliveries = Array.from({length: sample.length + 1}, (_, cut) => [sample.slice(0, cut), sample.slice(cut)])
  deliveries.push([...sample])
  for (const chunks of deliveries) {
    const filter = create()
    let out = ''
    for (const chunk of chunks) {
      out += filter.push(chunk)
      assert.ok('你好。'.startsWith(out.trim()), JSON.stringify({chunks, out}))
    }
    assert.equal((out + filter.finish()).trim(), '你好。')
  }
})
check('metadata-only completion has no visible or spoken content', () => {
  for (const text of ['【消息发送时间】2026-10-21 00:58', '2026-10-21 00:58 (UTC+08:00)', '(UTC+08:00)']) {
    const filter = create()
    assert.equal([...text].map(char => filter.push(char)).join('') + filter.finish(), '')
  }
})
check('ordinary prose, dates and times remain intact', () => {
  for (const text of ['2026-10-21 我们去散步。', '2026年一起看星星。', '123 个小时后见。', '明天 08:00 见。', '这个标签【普通内容】也要保留。', 'UTC 是一种时间标准。']) {
    const filter = create()
    assert.equal([...text].map(char => filter.push(char)).join('') + filter.finish(), text)
  }
})
check('ordinary reply text streams without waiting for a newline', () => {
  const filter = create()
  assert.equal(filter.push('你好'), '你好')
  assert.equal(filter.push('呀。'), '呀。')
  assert.equal(filter.finish(), '')
})
check('a later metadata line is hidden without swallowing adjacent sentences', () => {
  const text = '第一句。\n【消息发送时间】2026-10-21 00:58\n第二句。'
  const filter = create()
  assert.equal([...text].map(char => filter.push(char)).join('') + filter.finish(), '第一句。\n第二句。')
})
console.log(`${passed}/${passed} passed`)
