import {readdirSync} from "node:fs"
import assert from "node:assert/strict"
import {pathToFileURL} from "node:url"
import {mkdtemp, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
const root = path.resolve(import.meta.dirname, "..")
const esbuildDir = readdirSync(path.join(root, "node_modules/.pnpm")).find(d => d.startsWith("esbuild@"))
const {build} = await import(pathToFileURL(path.join(root, "node_modules/.pnpm", esbuildDir, "node_modules/esbuild/lib/main.js")))
const dir = await mkdtemp(path.join(tmpdir(), "nori-focus-test-"))
try {
  const outfile = path.join(dir, "pomo.mjs")
  await build({entryPoints: ["src/services/pomodoro.ts"], outfile, bundle: true, format: "esm", platform: "node"})
  const p = await import(pathToFileURL(outfile))
  const cfg = p.normalizePomo({focusMin: Infinity, breakMin: -5, autoFocus: "false", notify: false, dailyGoal: 0, goal: "  阅读  ", longEvery: 0})
  assert.equal(cfg.focusMin, 25); assert.equal(cfg.breakMin, 1); assert.equal(cfg.autoFocus, false)
  assert.equal(cfg.notify, false); assert.equal(cfg.dailyGoal, 0); assert.equal(cfg.goal, "阅读"); assert.equal(cfg.longEvery, 2)
  console.log("PASS 配置类型、范围、零值与文本归一化")
  const before = {"2026-10-06": 60000}, at = new Date("2026-10-06T23:59:30").getTime()
  assert.deepEqual(p.projectLiveDays(before, at, 90000), {"2026-10-06": 90000, "2026-10-07": 60000})
  assert.deepEqual(before, {"2026-10-06": 60000})
  console.log("PASS 进行中时长跨午夜分摊且不修改账本")
  assert.equal(p.monthPercent(120, [{min: 0}, {min: 120}, {min: 240}]), 50)
  assert.equal(p.monthPercent(0, [{min: 0}]), 0)
  console.log("PASS 本月无数据时历史月份比例和全零空态")
  const stats = {v: 2, days: {"2001-01-01": {focusMin: 25, countUpMin: 5, done: 1, abort: 0}}}
  const raw = JSON.stringify({kind: "nori-pomodoro", version: 1, stats})
  assert.equal(p.parsePomoBackup(raw).minutes, 30)
  assert.equal(p.parsePomoBackup(raw).days, 1)
  for (const invalid of [raw.replace("2001-01-01", "2001-02-30"), raw.replace('"done":1', '"done":0.5'), raw.replace('"focusMin":25', '"focusMin":-25'), raw.replace('"version":1','"version":2')]) assert.throws(() => p.parsePomoBackup(invalid))
  assert.match(p.pomoCsv(stats), /2001-01-01,30.00,25.00,5.00,1,0/)
  const partial = p.parsePomoBackup(JSON.stringify({kind: "nori-pomodoro", version: 1, stats: {v: 2, days: {"2001-01-01": {done: 1}}}})).stats
  assert.match(p.pomoCsv(partial), /2001-01-01,0.00,0.00,0.00,1,0/)
  console.log("PASS 备份格式和数值校验、长期历史与 CSV 口径")
  console.log("4/4 groups passed")
} finally { await rm(dir, {recursive: true, force: true}) }
