import assert from 'node:assert/strict'
import {readdirSync} from 'node:fs'
import path from 'node:path'
import {pathToFileURL} from 'node:url'

const root = path.resolve(import.meta.dirname, '..')
const esbuildDir = readdirSync(path.join(root, 'node_modules/.pnpm')).find(name => name.startsWith('esbuild@'))
const {build} = await import(pathToFileURL(path.join(root, 'node_modules/.pnpm', esbuildDir, 'node_modules/esbuild/lib/main.js')).href)
const bundle = async file => {
  const result = await build({entryPoints: [path.join(root, file)], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent'})
  return import('data:text/javascript;base64,' + Buffer.from(result.outputFiles[0].text).toString('base64'))
}
const {FloatingCropTracker, FULL_CANVAS, validCanvasBounds} = await bundle('src/services/live2d/floatingCrop.ts')
const {installFrameCap} = await bundle('src/services/live2d/frameCap.ts')
const {installFloatingGeometry} = await bundle('src/float/modelGeometry.ts')
const {loadFloatingCrop, saveFloatingCrop} = await bundle('src/services/live2d/floatingCropCache.ts')
let passed = 0
const check = (name, run) => { run(); passed++; console.log('PASS ' + name) }
const body = {l: 0.25, t: 0.025, r: 0.75, b: 0.81}
const calibrated = () => {
  const tracker = new FloatingCropTracker()
  tracker.resize(180, 236)
  for (let ms = 0; ms <= 12000; ms += 250) tracker.sample(body, ms)
  return tracker
}
check('initial and partially calibrated windows remain full size', () => {
  const tracker = new FloatingCropTracker()
  tracker.sample(body, 0); tracker.sample(body, 250)
  assert.deepEqual(tracker.geometry(300).crop, FULL_CANVAS)
})
check('a complete idle sampling interval enables a tight crop', () => {
  assert.deepEqual(calibrated().geometry(12000).crop, body)
})
check('breathing cannot repeatedly shrink the native window', () => {
  const tracker = calibrated()
  tracker.sample({l: 0.3, t: 0.1, r: 0.7, b: 0.8}, 12250)
  assert.deepEqual(tracker.geometry(12250).crop, body)
  tracker.sample({...body, l: 0.22}, 12500)
  assert.equal(tracker.geometry(12500).crop.l, 0.22)
})
check('reactions expand the crop while preserving body geometry and feet', () => {
  const tracker = calibrated()
  tracker.protect(); tracker.sample(FULL_CANVAS, 12500)
  assert.deepEqual(tracker.geometry(12500).crop, FULL_CANVAS)
  assert.deepEqual(tracker.geometry(12500).hit, body)
  assert.equal(tracker.geometry(12500).feet, body.b)
})
check('transition frames cannot poison the cached idle range', () => {
  const tracker = calibrated()
  tracker.protect(); tracker.neutral(14000)
  tracker.sample(FULL_CANVAS, 15000)
  assert.deepEqual(tracker.geometry(15000).crop, FULL_CANVAS)
  tracker.sample(body, 16250)
  assert.deepEqual(tracker.geometry(16250).crop, body)
})
check('transparent, invalid, and context-lost frames fall back without collapsing', () => {
  const tracker = calibrated()
  for (const value of [null, {...body, l: NaN}, {...body, r: 0}, {...body, t: Infinity}]) {
    tracker.sample(value, 12500)
    assert.deepEqual(tracker.geometry(12500).crop, FULL_CANVAS)
    assert.deepEqual(tracker.geometry(12500).hit, body)
  }
  tracker.sample(body, 13000)
  assert.deepEqual(tracker.geometry(13000).crop, body)
})
check('background time does not count as sampled idle time', () => {
  const tracker = new FloatingCropTracker(1000)
  tracker.sample(body, 0); tracker.sample(body, 250); tracker.pause()
  tracker.sample(body, 90000)
  assert.equal(tracker.geometry(90000).precise, false)
})
check('proportional resizing keeps calibration; changed aspect recalibrates', () => {
  const tracker = calibrated()
  tracker.resize(360, 472)
  assert.deepEqual(tracker.geometry(13000).crop, body)
  tracker.resize(472, 360)
  assert.deepEqual(tracker.geometry(13000).crop, FULL_CANVAS)
})
check('partially off-canvas geometry is clamped; entirely off-canvas is invalid', () => {
  const tracker = new FloatingCropTracker(0)
  tracker.sample({...body, l: -0.2, b: 1.2}, 0)
  assert.deepEqual(tracker.geometry(0).crop, {...body, l: 0, b: 1})
  assert.equal(validCanvasBounds({...body, l: 1.1, r: 1.2}), false)
})
const entries = new Map()
const cache = {getItem: key => entries.get(key) ?? null, setItem: (key, value) => entries.set(key, value)}
check('cache distinguishes model revisions and canvas aspects while allowing proportional resize', () => {
  saveFloatingCrop(cache, 'model@v1', 180 / 236, body, 1000)
  assert.deepEqual(loadFloatingCrop(cache, 'model@v1', 360 / 472, 1001), body)
  assert.equal(loadFloatingCrop(cache, 'model@v2', 180 / 236, 1001), null)
  assert.equal(loadFloatingCrop(cache, 'model@v1', 236 / 180, 1001), null)
})
check('cached calibration waits for an actual valid frame, then expands to include its bounds', () => {
  const tracker = new FloatingCropTracker()
  tracker.restore(body)
  assert.deepEqual(tracker.geometry(0).crop, FULL_CANVAS)
  tracker.sample({...body, l: 0.2}, 0)
  assert.deepEqual(tracker.geometry(0).crop, {...body, l: 0.2})
  tracker.protect()
  assert.deepEqual(tracker.geometry(250).crop, FULL_CANVAS)
})
check('corrupt, expired and invalid caches fall back and can be replaced', () => {
  for (const value of ['broken', '{}', '[null]', '[{"model":"x","aspect":1,"savedAt":1000,"bounds":{"l":-1,"t":0,"r":1,"b":1}}]']) {
    entries.set('nori.float-crop.v1', value)
    assert.equal(loadFloatingCrop(cache, 'x', 1, 1001), null)
    saveFloatingCrop(cache, 'x', 1, body, 1001)
    assert.deepEqual(loadFloatingCrop(cache, 'x', 1, 1002), body)
  }
  assert.equal(loadFloatingCrop(cache, 'x', 1, 1001 + 31 * 86400000), null)
})
check('cache stays bounded and denied storage does not stop rendering', () => {
  for (let i = 0; i < 30; i++) saveFloatingCrop(cache, 'model' + i, 1, body, 2000)
  assert.equal(JSON.parse(entries.get('nori.float-crop.v1')).length, 16)
  const denied = {getItem() {throw Error('denied')}, setItem() {throw Error('denied')}}
  assert.equal(loadFloatingCrop(denied, 'x', 1), null)
  saveFloatingCrop(denied, 'x', 1, body)
})
check('measurement runs after actual draws and stops while rendering is paused', () => {
  let now = 0, drawn = 0, measured = 0
  const host = {__noriAfterL2dDraw: () => { assert.equal(drawn, measured + 1); measured++ }}
  installFrameCap(host, 30, () => now)
  const step = () => host.__noriL2dTick({updateTime() {}}, {update() { drawn++ }})
  step(); now = 1; step(); host.__noriL2dPaused = true; now = 100; step()
  assert.equal(measured, 1)
})

const realWindow = globalThis.window, realPerformance = globalThis.performance
let now = 0, epoch = 10, lastReport
globalThis.performance = {now: () => now}
globalThis.window = {
  innerWidth: 180, innerHeight: 236, devicePixelRatio: 2.75,
  __noriVisibleBounds: () => body,
  NoriChat: {beginFloatModelGeometry: () => ++epoch, setFloatVisibleGeometry: json => { lastReport = JSON.parse(json) }},
}
try {
  const geometry = installFloatingGeometry()
  const frameRequests = []
  window.NoriChat.floatFrameDrawn = request => frameRequests.push(request)
  window.__noriFloatFrameRequest = 71
  window.__noriAfterL2dDraw()
  assert.deepEqual(frameRequests, [])
  geometry.start()
  for (now = 0; now <= 12250; now += 250) window.__noriAfterL2dDraw()
  check('bridge uses physical pixels, with outward edge rounding', () => {
    assert.equal(lastReport.width, 495); assert.equal(lastReport.height, 649)
    assert.deepEqual(lastReport.crop, [123, 16, 372, 526])
    assert.equal(lastReport.feet, 526)
  })
  check('window handoff confirms one actual model draw after mounting', () => {
    assert.deepEqual(frameRequests, [71])
    assert.equal(window.__noriFloatFrameRequest, undefined)
  })
  let resolved = false
  const protectedWindow = geometry.protect().then(value => { resolved = true; return value })
  check('reaction expansion is sent before waiting for native acknowledgement', () => {
    assert.deepEqual(lastReport.crop, [0, 0, 495, 649]); assert.equal(resolved, false)
  })
  window.__noriFloatGeometryApplied(epoch - 1, lastReport.revision)
  await Promise.resolve()
  check('old mount acknowledgements cannot start a reaction', () => assert.equal(resolved, false))
  window.__noriFloatGeometryApplied(epoch, lastReport.revision)
  assert.equal(await protectedWindow, true); passed++; console.log('PASS current native acknowledgement releases playback')
  const cancelled = geometry.protect()
  geometry.stop()
  assert.equal(await cancelled, false)
  check('unmount cancels pending playback and removes measurement hooks', () => {
    assert.equal(window.__noriAfterL2dDraw, undefined)
    assert.equal(window.__noriFloatGeometryApplied, undefined)
  })
} finally { globalThis.window = realWindow; globalThis.performance = realPerformance }
console.log(`${passed}/${passed} passed`)
