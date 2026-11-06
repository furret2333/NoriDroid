import assert from "node:assert/strict"
import {readdirSync} from "node:fs"
import {mkdtemp, rm} from "node:fs/promises"
import {tmpdir} from "node:os"
import path from "node:path"
import {pathToFileURL} from "node:url"

const root = path.resolve(import.meta.dirname, "..")
const esbuildDir = readdirSync(path.join(root, "node_modules/.pnpm")).find(d => d.startsWith("esbuild@"))
const {build} = await import(pathToFileURL(path.join(root, "node_modules/.pnpm", esbuildDir, "node_modules/esbuild/lib/main.js")))
const dir = await mkdtemp(path.join(tmpdir(), "nori-speech-feedback-"))
const originals = {
 setTimeout: globalThis.setTimeout, clearTimeout: globalThis.clearTimeout,
 dateNow: Date.now, performance: Object.getOwnPropertyDescriptor(globalThis, "performance"),
 harness: Object.getOwnPropertyDescriptor(globalThis, "__noriSpeechTest"),
}
let now = 1_000_000, timerId = 0
const timers = new Map()
const results = []

try {
 const outfile = path.join(dir, "feedback.mjs")
 const stubs = {
  "../services/tts": `
   const state = () => globalThis.__noriSpeechTest;
   export const isTtsReady = () => state().ready;
   export const speak = async (cfg, text) => { state().spoken.push({cfg, text}) };
   export const onSpeakingChange = cb => { state().registrations++; state().handler = cb };
  `,
  "../services/bgm": `export const setBgmDucking = playing => {
   const h = globalThis.__noriSpeechTest;
   h.ducking.push({playing, speakingAtDucking: h.feedback.speaking.value});
  };`,
  "../services/live2d/petSpeech": `export const maybePetSpeechLine = time => {
   const h = globalThis.__noriSpeechTest;
   h.lineCalls.push(time); return h.nextLine;
  };`,
 }
 await build({
  stdin: {contents: 'export {useSpeechFeedback} from "./src/composables/useSpeechFeedback"; export {ref, nextTick, effectScope} from "vue"', resolveDir: root},
  outfile, bundle: true, format: "esm", platform: "node",
  plugins: [{name: "speech-io-fixture", setup(b) {
   b.onResolve({filter: /^\.\.\/services\/(tts|bgm|live2d\/petSpeech)$/}, args => ({path: args.path, namespace: "speech-test"}))
   b.onLoad({filter: /.*/, namespace: "speech-test"}, args => ({contents: stubs[args.path], loader: "js"}))
  }}],
 })
 const {useSpeechFeedback, ref, nextTick, effectScope} = await import(pathToFileURL(outfile))
 globalThis.setTimeout = (callback, delay = 0, ...args) => {
  const id = ++timerId
  timers.set(id, {at: now + Math.max(0, Number(delay) || 0), callback: () => callback(...args)})
  return id
 }
 globalThis.clearTimeout = id => { timers.delete(id) }
 Date.now = () => now
 Object.defineProperty(globalThis, "performance", {value: {now: () => now}, configurable: true, writable: true})

 const advance = async ms => {
  await nextTick()
  const target = now + ms
  let loops = 0
  for (;;) {
   const next = [...timers].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
   if (!next) break
   assert.ok(++loops < 1000, "timer queue must terminate")
   const [id, timer] = next
   timers.delete(id); now = timer.at; timer.callback()
   await nextTick()
  }
  now = target
  await nextTick()
 }
 const fixture = ({register = true, bind = true} = {}) => {
  timers.clear(); now = 1_000_000
  const h = {ready: true, spoken: [], registrations: 0, handler: null, ducking: [], lineCalls: [], nextLine: "pet line", previews: []}
  globalThis.__noriSpeechTest = h
  const cfg = {id: "current-settings"}
  const flags = {typing: ref(false), chatStreaming: ref(false), touchStreaming: ref(false), chatOpen: ref(false), panel: ref("")}
  const scope = effectScope()
  const f = scope.run(() => {
   const value = useSpeechFeedback({settings: () => cfg,
    typing: () => flags.typing.value, chatStreaming: () => flags.chatStreaming.value,
    touchStreaming: () => flags.touchStreaming.value, chatOpen: () => flags.chatOpen.value,
    panel: () => flags.panel.value, updateTouchReplyPreview: text => h.previews.push(text),
   })
   h.feedback = value
   if (register) value.registerSpeakingHandler()
   if (bind) value.bindReplyWatcher()
   return value
  })
  return {f, h, cfg, flags, playing: value => h.handler(value), close: () => { scope.stop(); timers.clear() }}
 }
 const test = async (name, run) => {
  let current
  try {
   const make = options => { current?.close(); current = fixture(options); return current }
   await run(make)
   results.push({name, ok: true}); console.log(`PASS ${name}`)
  } catch (error) {
   results.push({name, ok: false}); console.error(`FAIL ${name}\n${error.stack}`)
  } finally { current?.close(); timers.clear() }
 }

 await test("construction defers late App getters and handler registration", async make => {
  const {h, f} = make({register: false, bind: false})
  assert.equal(h.registrations, 0)
  const lazy = useSpeechFeedback({settings: () => { throw Error("late cfg") },
   typing: () => { throw Error("late typing") }, chatStreaming: () => { throw Error("late stream") },
   touchStreaming: () => { throw Error("late touch") }, chatOpen: () => { throw Error("late chat") },
   panel: () => { throw Error("late panel") }, updateTouchReplyPreview: () => { throw Error("late preview") },
  })
  assert.equal(lazy.speaking.value, false)
  assert.equal(timers.size, 0)
  f.registerSpeakingHandler()
  assert.equal(h.registrations, 1)
 })
 await test("single speaking callback updates state before BGM ducking", async make => {
  const {f, h, playing} = make()
  playing(true); playing(false)
  assert.equal(f.speaking.value, false)
  assert.equal(h.registrations, 1)
  assert.deepEqual(h.ducking, [{playing: true, speakingAtDucking: true}, {playing: false, speakingAtDucking: false}])
 })
 await test("new touch notification replaces the previous expiry", async make => {
  const {f} = make()
  f.triggerBubble("first"); await advance(1500); f.triggerBubble("second")
  await advance(1999); assert.equal(f.touchBubble.value, "second")
  await advance(1); assert.equal(f.touchBubble.value, "")
 })
 await test("portrait reply delay supports short, long and explicit lifetimes", async make => {
  const {f} = make()
  f.showPortraitReply("short"); await advance(8999); assert.equal(f.portraitReply.value, "short")
  await advance(1); assert.equal(f.portraitReply.value, "")
  const long = "x".repeat(400)
  f.showPortraitReply(long); await advance(15999); assert.equal(f.portraitReply.value, long)
  await advance(1); assert.equal(f.portraitReply.value, "")
  f.showPortraitReply("explicit", 250); await advance(249); assert.equal(f.portraitReply.value, "explicit")
  await advance(1); assert.equal(f.portraitReply.value, "")
 })
 for (const busy of ["typing", "chatStreaming", "touchStreaming", "speaking"]) {
  await test(`portrait reply remains visible while ${busy} and expires after idle`, async make => {
   const {f, flags, playing} = make()
   if (busy === "speaking") playing(true); else flags[busy].value = true
   await nextTick(); f.showPortraitReply("active reply")
   await advance(30000); assert.equal(f.portraitReply.value, "active reply")
   if (busy === "speaking") playing(false); else flags[busy].value = false
   await nextTick(); await advance(8999); assert.equal(f.portraitReply.value, "active reply")
   await advance(1); assert.equal(f.portraitReply.value, "")
  })
 }
 await test("a new generation cancels pending portrait expiry and restarts after idle", async make => {
  const {f, flags} = make()
  f.showPortraitReply("previous reply"); await advance(8000)
  flags.chatStreaming.value = true; await nextTick(); await advance(5000)
  assert.equal(f.portraitReply.value, "previous reply")
  flags.chatStreaming.value = false; await nextTick(); await advance(8999)
  assert.equal(f.portraitReply.value, "previous reply")
  await advance(1); assert.equal(f.portraitReply.value, "")
 })
 await test("touch reply preview receives text only for an active editor stream", async make => {
  const {f, flags, h} = make()
  f.showPortraitReply("normal")
  flags.touchStreaming.value = true; f.showPortraitReply("not editor")
  flags.panel.value = "touch"; f.showPortraitReply("editor stream")
  flags.touchStreaming.value = false; f.showPortraitReply("finished")
  assert.deepEqual(h.previews, ["editor stream"])
 })
 await test("AI bubble replacement and touch notification have independent timers", async make => {
  const {f} = make()
  f.showAiBubble("first", 5000); f.triggerBubble("notice", 10000)
  await advance(1000); f.showAiBubble("replacement", 6000)
  await advance(5999)
  assert.equal(f.aiBubble.value, "replacement"); assert.equal(f.portraitReply.value, "replacement")
  await advance(1)
  assert.equal(f.aiBubble.value, ""); assert.equal(f.portraitReply.value, "")
  assert.equal(f.touchBubble.value, "notice")
  await advance(3000); assert.equal(f.touchBubble.value, "")
 })
 await test("unconfigured TTS does not consume the pet line window", async make => {
  const {f, h} = make()
  h.ready = false; f.maybeSpeakPetLine(); f.speakSideLine("side")
  assert.equal(h.lineCalls.length, 0); assert.equal(h.spoken.length, 0)
  h.ready = true; f.maybeSpeakPetLine()
  assert.equal(h.lineCalls.length, 1); assert.equal(h.spoken.length, 1)
  assert.equal(f.aiBubble.value, "pet line")
 })
 for (const busy of ["typing", "chatStreaming", "touchStreaming", "speaking"]) {
  await test(`pet and side speech never interrupt ${busy}`, async make => {
   const {f, h, flags, playing} = make()
   if (busy === "speaking") playing(true); else flags[busy].value = true
   f.maybeSpeakPetLine(); f.speakSideLine("side")
   assert.equal(h.lineCalls.length, 0); assert.equal(h.spoken.length, 0)
   assert.equal(f.aiBubble.value, "")
  })
 }
 await test("cooldown rejection produces no speech or bubbles", async make => {
  const {f, h} = make()
  h.nextLine = null; f.maybeSpeakPetLine()
  assert.equal(h.lineCalls.length, 1); assert.equal(h.spoken.length, 0)
  assert.equal(f.aiBubble.value, ""); assert.equal(f.portraitReply.value, "")
 })
 await test("an open chat allows local pet speech without an overlay bubble", async make => {
  const {f, h, flags} = make()
  flags.chatOpen.value = true; f.maybeSpeakPetLine()
  assert.equal(h.spoken.length, 1); assert.equal(f.aiBubble.value, "")
  assert.equal(f.portraitReply.value, ""); assert.equal(timers.size, 0)
 })
 await test("silent pet speech retains its 7-second fallback even after false state", async make => {
  const {f, playing} = make()
  f.maybeSpeakPetLine(); playing(false)
  await advance(6999); assert.equal(f.aiBubble.value, "pet line")
  await advance(1); assert.equal(f.aiBubble.value, ""); assert.equal(f.portraitReply.value, "")
 })
 await test("pet speech survives a short playback gap and clears after confirmed tail", async make => {
  const {f, playing} = make()
  f.maybeSpeakPetLine(); playing(true); await advance(1000); playing(false)
  await advance(699); assert.equal(f.aiBubble.value, "pet line")
  playing(true); await advance(1000); assert.equal(f.aiBubble.value, "pet line")
  playing(false); await advance(699); assert.equal(f.aiBubble.value, "pet line")
  await advance(1); assert.equal(f.aiBubble.value, ""); assert.equal(f.portraitReply.value, "")
 })
 await test("pet speech and side speech share the 700ms recent-voice guard", async make => {
  const {f, h, cfg, playing} = make()
  playing(true); playing(false)
  await advance(699); f.maybeSpeakPetLine(); f.speakSideLine("too early")
  assert.equal(h.lineCalls.length, 0); assert.equal(h.spoken.length, 0)
  await advance(1); f.speakSideLine("side after tail"); f.maybeSpeakPetLine()
  assert.equal(h.spoken.length, 2); assert.equal(h.spoken[0].text, "side after tail")
  assert.equal(h.spoken[0].cfg, cfg); assert.equal(h.lineCalls.length, 1)
 })
 await test("active pet fallback extends three times and still expires at 22 seconds", async make => {
  const {f, playing} = make()
  f.maybeSpeakPetLine(); playing(true)
  await advance(21999); assert.equal(f.aiBubble.value, "pet line"); assert.equal(f.portraitReply.value, "pet line")
  await advance(1); assert.equal(f.aiBubble.value, ""); assert.equal(f.portraitReply.value, "")
  assert.equal(f.speaking.value, true)
 })
 await test("an old pet fallback cannot erase newer AI and portrait replies", async make => {
  const {f} = make()
  f.maybeSpeakPetLine(); await advance(1000)
  f.showAiBubble("new AI reply", 30000); f.showPortraitReply("new portrait reply", 30000)
  await advance(6000)
  assert.equal(f.aiBubble.value, "new AI reply"); assert.equal(f.portraitReply.value, "new portrait reply")
  f.clearPetLineBubble()
  assert.equal(f.aiBubble.value, "new AI reply"); assert.equal(f.portraitReply.value, "new portrait reply")
 })
 await test("explicit reply and touch cleanup cancels pending presentation timers", async make => {
  const {f} = make()
  f.showAiBubble("AI"); f.triggerBubble("notice")
  assert.ok(timers.size > 0)
  f.clearReplyTimers(); f.clearTouchBubbleTimer()
  assert.equal(timers.size, 0)
  await advance(30000)
  assert.equal(f.aiBubble.value, "AI"); assert.equal(f.portraitReply.value, "AI"); assert.equal(f.touchBubble.value, "notice")
 })
 const passed = results.filter(r => r.ok).length
 console.log(`\n${passed}/${results.length} speech feedback groups passed`)
 if (passed !== results.length) process.exitCode = 1
} finally {
 globalThis.setTimeout = originals.setTimeout; globalThis.clearTimeout = originals.clearTimeout
 Date.now = originals.dateNow
 if (originals.performance) Object.defineProperty(globalThis, "performance", originals.performance)
 else delete globalThis.performance
 if (originals.harness) Object.defineProperty(globalThis, "__noriSpeechTest", originals.harness)
 else delete globalThis.__noriSpeechTest
 await rm(dir, {recursive: true, force: true})
}
