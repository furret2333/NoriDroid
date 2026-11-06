import assert from "node:assert/strict"
import {readdirSync} from "node:fs"
import {mkdtemp, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import {pathToFileURL} from "node:url"

const root = path.resolve(import.meta.dirname, "..")
const esbuildDir = readdirSync(path.join(root, "node_modules/.pnpm")).find(d => d.startsWith("esbuild@"))
const {build} = await import(pathToFileURL(path.join(root, "node_modules/.pnpm", esbuildDir, "node_modules/esbuild/lib/main.js")))
const dir = await mkdtemp(path.join(tmpdir(), "nori-diary-scheduler-"))
const names = ["window", "document", "__noriDiaryTest", "setTimeout", "clearTimeout"]
const originals = new Map(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]))
let now = 0, serial = 0, passed = 0
const timers = new Map(), failures = []
try {
 const outfile = path.join(dir, "scheduler.mjs")
 const stubs = {
  "../services/chat": `export const sendChat = async (...args) => {
   const h = globalThis.__noriDiaryTest; h.requests.push(args); return h.result;
  };`,
  "../services/nori-diary": `export const ensureDiary = async (generate, signal) => {
   const h = globalThis.__noriDiaryTest; h.runs.push({generate, signal});
   if (h.mode === "defer") await new Promise((resolve, reject) => {h.resolve = resolve; h.reject = reject});
   if (h.mode === "reject") throw new Error("ensure-failed");
   return generate("diary-system", "diary-material");
  };`,
 }
 await build({
  stdin: {contents: 'export {useDiaryScheduler} from "./src/composables/useDiaryScheduler"; export {ref, nextTick, effectScope} from "vue"', resolveDir: root},
  outfile, bundle: true, format: "esm", platform: "node",
  plugins: [{name: "diary-io-fixture", setup(b) {
   b.onResolve({filter: /^\.\.\/services\/(chat|nori-diary)$/}, args => ({path: args.path, namespace: "diary-test"}))
   b.onLoad({filter: /.*/, namespace: "diary-test"}, args => ({contents: stubs[args.path], loader: "js"}))
  }}],
 })
 const {useDiaryScheduler, ref, nextTick, effectScope} = await import(pathToFileURL(outfile))
 globalThis.setTimeout = (callback, delay = 0) => {
  const id = ++serial; timers.set(id, {at: now + Number(delay), callback}); return id
 }
 globalThis.clearTimeout = id => timers.delete(id)
 const settle = async () => { for (let i = 0; i < 12; i++) { await Promise.resolve(); await nextTick() } }
 const advance = async ms => {
  const target = now + ms
  for (;;) {
   const next = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0]
   if (!next) break
   timers.delete(next[0]); now = next[1].at
   Promise.resolve(next[1].callback()).catch(error => globalThis.__noriDiaryTest.errors.push(error))
   await settle()
  }
  now = target; await settle()
 }
 const fixture = () => {
  timers.clear(); now = 0
  const h = {runs: [], requests: [], events: [], errors: [], mode: "done", result: {ok: true, content: "diary"}}
  globalThis.__noriDiaryTest = h
  globalThis.window = {__noriAppPaused: false, dispatchEvent: event => h.events.push(event.type)}
  globalThis.document = {hidden: false}
  const cfg = {baseUrl: "base", apiKey: "key", model: "model"}
  const chat = ref(false), touch = ref(false), scope = effectScope()
  const f = scope.run(() => {
   const scheduler = useDiaryScheduler({settings: () => cfg, chatStreaming: chat, touchStreaming: touch})
   scheduler.bindDiaryWatcher(); return scheduler
  })
  return {h, cfg, chat, touch, f, close: () => { f.stopAutoDiary(); scope.stop(); timers.clear() }}
 }
 const test = async (name, run) => {
  const a = fixture()
  try { await run(a); passed++; console.log(`PASS ${name}`) }
  catch (error) { failures.push(name); console.error(`FAIL ${name}\n${error.stack}`) }
  finally { a.close() }
 }
 await test("construction defers settings and timer creation", async () => {
  const f = useDiaryScheduler({settings: () => {throw Error("late settings")}, chatStreaming: ref(false), touchStreaming: ref(false)})
  assert.equal(timers.size, 0); f.stopAutoDiary()
 })
 await test("idle generation begins at 1800ms and dispatches one update after completion", async ({h, f}) => {
  f.scheduleDiary(); await advance(1799); assert.equal(h.runs.length, 0)
  await advance(1); assert.equal(h.runs.length, 1); assert.deepEqual(h.events, ["nori-diary-updated"])
 })
 await test("rescheduling replaces the pending idle deadline", async ({h, f}) => {
  f.scheduleDiary(); await advance(1000); f.scheduleDiary(); await advance(800)
  assert.equal(h.runs.length, 0); await advance(1000); assert.equal(h.runs.length, 1)
 })
 for (const gate of ["hidden", "native pause", "chat stream", "touch stream", "empty key", "empty model"]) {
  await test(`${gate} blocks idle generation`, async ({h, f, cfg, chat, touch}) => {
   if (gate === "hidden") document.hidden = true
   if (gate === "native pause") window.__noriAppPaused = true
   if (gate === "chat stream") chat.value = true
   if (gate === "touch stream") touch.value = true
   if (gate === "empty key") cfg.apiKey = " "
   if (gate === "empty model") cfg.model = " "
   await nextTick(); f.scheduleDiary(); await advance(1800)
   assert.equal(h.runs.length, 0); assert.equal(h.requests.length, 0)
  })
 }
 await test("explicit stop cancels a pending idle timer", async ({h, f}) => {
  f.scheduleDiary(); await advance(1700); f.stopAutoDiary(); await advance(5000)
  assert.equal(h.runs.length, 0)
 })
 for (const stream of ["chat", "touch"]) {
  await test(`${stream} start aborts an in-flight diary and prevents overlap until settlement`, async a => {
   const {h, f} = a; h.mode = "defer"
   f.scheduleDiary(); await advance(1800); const signal = h.runs[0].signal
   a[stream].value = true; await nextTick(); assert.equal(signal.aborted, true)
   a[stream].value = false; await nextTick(); f.scheduleDiary(); await advance(1800)
   assert.equal(h.runs.length, 1)
   h.resolve(); await settle(); h.mode = "done"; f.scheduleDiary(); await advance(1800)
   assert.equal(h.runs.length, 2); assert.equal(h.runs[1].signal.aborted, false)
  })
 }
 await test("active diary excludes duplicate scheduling and reopens after completion", async ({h, f}) => {
  h.mode = "defer"; f.scheduleDiary(); await advance(1800)
  f.scheduleDiary(); await advance(1800); assert.equal(h.runs.length, 1)
  h.resolve(); await settle(); h.mode = "done"; f.scheduleDiary(); await advance(1800)
  assert.equal(h.runs.length, 2)
 })
 await test("generation uses current settings, material and the same cancellation signal", async ({h, f, cfg}) => {
  h.mode = "defer"; f.scheduleDiary(); await advance(1800)
  cfg.baseUrl = "new-base"; cfg.apiKey = "new-key"; cfg.model = "new-model"
  h.resolve(); await settle()
  const [base, key, model, messages, thinking, options] = h.requests[0]
  assert.deepEqual([base, key, model], ["new-base", "new-key", "new-model"])
  assert.deepEqual(messages.map(({role, content}) => ({role, content})), [
   {role: "system", content: "diary-system"}, {role: "user", content: "diary-material"},
  ])
  assert.equal(thinking, false); assert.equal(options.signal, h.runs[0].signal)
 })
 await test("failed chat releases the active guard without a success event", async ({h, f}) => {
  h.result = {ok: false, message: "request-failed"}; f.scheduleDiary(); await advance(1800)
  assert.equal(h.errors[0]?.message, "request-failed"); assert.deepEqual(h.events, [])
  h.result = {ok: true, content: "retry"}; f.scheduleDiary(); await advance(1800)
  assert.equal(h.runs.length, 2); assert.deepEqual(h.events, ["nori-diary-updated"])
 })
 await test("ensureDiary rejection releases the guard for a later attempt", async ({h, f}) => {
  h.mode = "reject"; f.scheduleDiary(); await advance(1800)
  assert.equal(h.errors[0]?.message, "ensure-failed"); assert.equal(h.requests.length, 0)
  h.mode = "done"; f.scheduleDiary(); await advance(1800); assert.equal(h.requests.length, 1)
 })
 console.log(`\n${passed}/${passed + failures.length} diary scheduler groups passed`)
 if (failures.length) process.exitCode = 1
} finally {
 for (const [name, descriptor] of originals) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor)
  else delete globalThis[name]
 }
 assert.equal(path.dirname(path.resolve(dir)), path.resolve(tmpdir()))
 assert.ok(path.basename(dir).startsWith("nori-diary-scheduler-"))
 await rm(dir, {recursive: true, force: true})
}
