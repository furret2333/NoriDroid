/** Real models/rendering with a fake Android bridge. Does not emulate WindowManager/One UI. */
import assert from 'node:assert/strict'
import {spawn} from 'node:child_process'
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve, dirname, basename} from 'node:path'

const modelName = process.argv[2] || 'ARGNori'
const model = JSON.parse(readFileSync(`D:/norios/models/${modelName}/${modelName}.model3.json`, 'utf8'))
const motions = Object.values(model.FileReferences.Motions).flat().map(item => item.File.replace(/^.*\//, '').replace(/\.motion3\.json$/, ''))
const expressions = model.FileReferences.Expressions.map(item => item.Name).filter(name => !/^(00_default|05_dark\.?|chibi|tailoff|longhairoff|shojo|finale_)/i.test(name))
const profile = mkdtempSync(join(tmpdir(), 'nori-float-crop-'))
const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', '--remote-debugging-port=9417', `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank',
], {stdio: 'ignore', windowsHide: true})
const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
let ws, serial = 0, sessionId, passed = 0
const pending = new Map(), errors = [], artifacts = []
const check = (label, condition) => { assert.ok(condition, label); passed++; console.log(`PASS ${modelName}: ${label}`) }
const send = (method, params = {}, session = sessionId) => new Promise((resolve, reject) => {
  const id = ++serial, timer = setTimeout(() => { pending.delete(id); reject(new Error(method + ' timeout')) }, 20000)
  pending.set(id, {resolve, reject, timer})
  ws.send(JSON.stringify({id, method, params, ...(session ? {sessionId: session} : {})}))
})
const evaluate = async expression => {
  const result = await send('Runtime.evaluate', {expression, awaitPromise: true, returnByValue: true})
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text)
  return result.result.value
}
const waitFor = async (expression, timeout = 25000) => {
  const until = Date.now() + timeout
  while (Date.now() < until) { const value = await evaluate(expression); if (value) return value; await delay(150) }
  throw new Error('not ready: ' + expression)
}
try {
  let endpoint
  for (let n = 0; n < 40 && !endpoint; n++) {
    try { endpoint = (await (await fetch('http://127.0.0.1:9417/json/version')).json()).webSocketDebuggerUrl } catch {}
    if (!endpoint) await delay(250)
  }
  ws = new WebSocket(endpoint)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  ws.onmessage = event => {
    const response = JSON.parse(event.data), request = pending.get(response.id)
    if (response.method === 'Runtime.exceptionThrown') {
      const detail = response.params.exceptionDetails.exception?.description || response.params.exceptionDetails.text
      errors.push(detail); console.error('PAGE ERROR ' + detail)
    }
    if (!request) return
    clearTimeout(request.timer); pending.delete(response.id)
    response.error ? request.reject(new Error(JSON.stringify(response.error))) : request.resolve(response.result)
  }
  const {targetId} = await send('Target.createTarget', {url: 'about:blank'})
  sessionId = (await send('Target.attachToTarget', {targetId, flatten: true})).sessionId
  await send('Page.enable'); await send('Runtime.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', {source: `(() => {
    window.__ft = {epoch: 0, reports: [], ack: true, applied: 0, starts: [], measures: 0};
    window.__noriFloatNativePaused = localStorage.getItem('__testHostPaused') === 'true';
    let models, chat;
    Object.defineProperty(window, 'NoriBridge', {get: () => models, set: value => {
      models = value; value.listInstalled = () => JSON.stringify([{id: ${JSON.stringify(modelName)}, entryBase: ${JSON.stringify(modelName)}, revision: localStorage.getItem('__testModelRevision') || 'test-v1'}]);
    }});
    Object.defineProperty(window, 'NoriChat', {get: () => chat, set: value => {
      chat = value;
      value.beginFloatModelGeometry = () => ++__ft.epoch;
      value.floatFrameDrawn = request => { __ft.frameAck = {request, draws: window.__noriL2dDraws}; };
      value.setFloatVisibleGeometry = json => {
        const report = JSON.parse(json); __ft.reports.push(report); __ft.last = report;
        if (__ft.ack) setTimeout(() => { __ft.applied = report.revision; window.__noriFloatGeometryApplied?.(report.generation, report.revision); }, 0);
      };
    }});
  })()`})
  await send('Emulation.setDeviceMetricsOverride', {width: 180, height: 236, deviceScaleFactor: 2.75, mobile: true})
  await send('Page.navigate', {url: 'http://127.0.0.1:8123/assets/web/float.html?shim=1'})
  // Geometry starts after asynchronous capability loading; the initial publication is a safe fallback.
  await waitFor('window.__noriL2dDraws > 2 && window.__noriVisibleBounds && window.__ft.last?.feet < window.__ft.last?.height')
  check('model loaded with post-render geometry hook', await evaluate('!!window.__noriAfterL2dDraw && document.querySelectorAll("canvas").length === 1'))
  check('frame cap and isolated floating renderer retained', await evaluate('Math.abs(window.__noriL2dMinInterval - 14.6667) < 0.01 && !window.__noriBeforeModelUpdate && !window.__noriDataseaMinInterval'))
  check('warmup uses complete canvas but already reports actual body feet', await evaluate('!__ft.last.precise && __ft.last.crop[3] === __ft.last.height && __ft.last.feet < __ft.last.height'))
  await evaluate(`(() => {
    const tick = window.__noriL2dTick;
    window.__noriL2dTick = (updater, manager) => {
      const before = window.__noriL2dDraws; tick(updater, manager);
      if (!manager._model.__testWrapped) {
        manager._model.__testWrapped = true;
        for (const name of ['startMotion', 'setExpression']) {
          const original = manager._model[name];
          manager._model[name] = function(...args) {
            const r = __ft.last;
            __ft.starts.push({name, args: args.slice(0, 2), safe: !!r && !r.precise && r.crop[0] === 0 && r.crop[2] === r.width && __ft.applied >= r.revision});
            return original.apply(this, args);
          };
        }
      }
      if (!__ft.capture || before === window.__noriL2dDraws) return;
      __ft.capture = false;
      const gl = manager._viewManager.getGl(), W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
      const pixels = new Uint8Array(W * H * 4), now = performance.now();
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let l = W, t = H, r = -1, b = -1;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (pixels[(y * W + x) * 4 + 3] >= 8) {
        l = Math.min(l, x); r = Math.max(r, x + 1); t = Math.min(t, H - 1 - y); b = Math.max(b, H - y);
      }
      const rect = gl.canvas.getBoundingClientRect(), dpr = devicePixelRatio;
      __ft.captured = {alpha: [l / W * rect.width * dpr, t / H * rect.height * dpr, r / W * rect.width * dpr, b / H * rect.height * dpr],
        report: __ft.last, buffer: [W, H], scale: window.__noriRenderScale, glError: gl.getError(), readMs: performance.now() - now};
    };
    const measure = window.__noriVisibleBounds;
    window.__noriVisibleBounds = () => { __ft.measures++; return measure(); };
  })()`)
  console.log(`WAIT ${modelName}: sample a complete idle cycle before tightening`)
  await waitFor('__ft.last.precise', 35000)
  check('stable idle range is visibly narrower than the old model canvas', await evaluate('(__ft.last.crop[2] - __ft.last.crop[0]) / __ft.last.width < 0.68'))
  const capture = async label => {
    await evaluate('__ft.captured = null; __ft.capture = true')
    const data = await waitFor('__ft.captured')
    artifacts.push({model: modelName, label, ...data})
    const {report: r, alpha: a} = data, pad = Math.ceil(20 * 2.75)
    const crop = [Math.max(0, r.crop[0] - pad), Math.max(0, r.crop[1] - pad), Math.min(r.width, r.crop[2] + pad), Math.min(r.height, r.crop[3] + pad)]
    check(label + ': alpha fits the proposed native crop with 20dp padding', data.glError === 0 && a[2] > a[0] && a[3] > a[1] &&
      crop[0] <= a[0] + 1 && crop[1] <= a[1] + 1 && crop[2] >= a[2] - 1 && crop[3] >= a[3] - 1)
    check(label + ': physical geometry matches viewport, independent of renderScale', r.width === Math.round((await evaluate('innerWidth')) * 2.75) && r.height === Math.round((await evaluate('innerHeight')) * 2.75))
    return data
  }
  const original = await capture('default')
  await evaluate('__ft.beforeFrameRequest = window.__noriL2dDraws; window.__noriFloatFrameRequest = 72')
  await waitFor('__ft.frameAck?.request === 72')
  check('window handoff acknowledges an actual model frame without remounting', await evaluate('__ft.frameAck.draws > __ft.beforeFrameRequest && !window.__noriFloatFrameRequest && __ft.epoch === 1'))
  for (const scale of [1, 0.5, 3]) {
    await evaluate(`window.__noriSetRenderScale(${scale})`); await delay(600)
    await capture('renderScale=' + scale)
  }
  await send('Emulation.setDeviceMetricsOverride', {width: 360, height: 472, deviceScaleFactor: 2.75, mobile: true})
  await delay(1000)
  const enlarged = await capture('double size')
  check('feet scale with the full canvas, rather than render buffer resolution', Math.abs(enlarged.report.feet / original.report.feet - 2) < 0.03)
  await evaluate('window.__noriSetRenderScale(1); __ft.ack = false; __ft.beforeStarts = __ft.starts.length')
  await evaluate(`window.__noriPlayMarker('', ${JSON.stringify(motions.find(name => /nod/i.test(name)))})`)
  await delay(180)
  check('playback waits until native expansion is acknowledged', await evaluate('__ft.starts.length === __ft.beforeStarts && !__ft.last.precise'))
  await evaluate('__ft.applied = __ft.last.revision; window.__noriFloatGeometryApplied(__ft.epoch - 1, __ft.last.revision)')
  await delay(80)
  check('stale native acknowledgement cannot start a motion', await evaluate('__ft.starts.length === __ft.beforeStarts'))
  await evaluate('__ft.ack = true; window.__noriFloatGeometryApplied(__ft.epoch, __ft.last.revision)')
  await waitFor('__ft.starts.length > __ft.beforeStarts')
  check('acknowledged expansion starts the reaction', await evaluate('__ft.starts.at(-1).safe'))
  for (const motion of motions) {
    await evaluate(`window.__noriTouchActive(); window.__noriPlayMarker('', ${JSON.stringify(motion)})`)
    await delay(140)
    check('safe playback: ' + motion, await evaluate('!__ft.last.precise && __ft.starts.at(-1).safe'))
  }
  for (const expression of expressions) {
    await evaluate(`window.__noriTouchActive(); window.__noriPlayMarker(${JSON.stringify(expression)}, '')`)
    await delay(120)
    check('safe expression: ' + expression, await evaluate('!__ft.last.precise && __ft.starts.at(-1).safe'))
  }
  console.log(`WAIT ${modelName}: return to neutral and settle before shrinking`)
  await waitFor('__ft.last.precise', 18000)
  await capture('after reactions')
  check('reaction effects did not overwrite the stable body feet', await evaluate('Math.abs(__ft.last.feet - __ft.last.hit[3]) <= 1'))
  const measureCount = await evaluate('__ft.measures')
  await delay(1200)
  check('mesh sampling is limited to about four times per second', (await evaluate('__ft.measures')) - measureCount <= 5)
  await evaluate('window.__noriSetPaused(true); __ft.pauseDraws = window.__noriL2dDraws; __ft.pauseMeasures = __ft.measures')
  await delay(600)
  check('paused floating renderer performs no drawing or mesh measurements', await evaluate('__ft.pauseDraws === window.__noriL2dDraws && __ft.pauseMeasures === __ft.measures'))
  await evaluate('document.dispatchEvent(new Event("visibilitychange"))')
  await delay(350)
  check('a visible event cannot undo native host pause during reattachment', await evaluate('__ft.pauseDraws === window.__noriL2dDraws && window.__noriL2dPaused'))
  await evaluate('Object.defineProperty(document, "hidden", {configurable: true, value: true}); document.dispatchEvent(new Event("visibilitychange")); window.__noriSetPaused(false)')
  await delay(350)
  check('host resume cannot draw while the document is hidden', await evaluate('__ft.pauseDraws === window.__noriL2dDraws && window.__noriL2dPaused'))
  await evaluate('Object.defineProperty(document, "hidden", {configurable: true, value: false}); document.dispatchEvent(new Event("visibilitychange"))')
  await evaluate('window.__noriSetPaused(false)')
  await waitFor('window.__noriL2dDraws > __ft.pauseDraws')
  await evaluate("document.querySelector('canvas').dispatchEvent(new Event('webglcontextlost', {cancelable: true})); __ft.lostMeasures = __ft.measures")
  await delay(400)
  check('context loss restores the complete canvas and suspends measurements until remount', await evaluate('!__ft.last.precise && __ft.last.crop[0] === 0 && __ft.last.crop[2] === __ft.last.width && __ft.measures === __ft.lostMeasures'))
  const epoch = await evaluate('__ft.epoch')
  const remountStart = Date.now()
  await evaluate('window.__noriRefresh(); window.__noriRefresh()')
  await waitFor(`__ft.epoch > ${epoch} && __ft.last.precise && __ft.last.generation === __ft.epoch && document.querySelectorAll('canvas').length === 1`, 8000)
  check('concurrent remount restores cached calibration without another idle-cycle wait', Date.now() - remountStart < 8000)
  const reloadStart = Date.now()
  const previousDocument = await evaluate('performance.timeOrigin')
  await send('Page.reload')
  await waitFor(`performance.timeOrigin !== ${previousDocument} && window.__ft?.last?.precise && window.__noriL2dDraws > 2`, 8000)
  check('new page reuses persisted crop after the first rendered frames', Date.now() - reloadStart < 8000)
  const cachedDocument = await evaluate('performance.timeOrigin')
  await evaluate("localStorage.setItem('__testModelRevision', 'test-v2')")
  await send('Page.reload')
  await waitFor(`performance.timeOrigin !== ${cachedDocument} && window.__noriL2dDraws > 2 && window.__ft?.last?.feet < window.__ft?.last?.height`)
  check('model revision change starts fresh calibration', await evaluate('!__ft.last.precise && __ft.last.crop[2] === __ft.last.width'))
  const activeDocument = await evaluate('performance.timeOrigin')
  await evaluate("localStorage.setItem('__testHostPaused', 'true')")
  await send('Page.reload')
  await waitFor(`performance.timeOrigin !== ${activeDocument} && window.__noriRefresh && document.querySelector('canvas')`)
  await delay(500)
  check('host pause delivered before model loading remains effective after mount', await evaluate('!window.__noriL2dDraws && window.__noriL2dPaused && __ft.epoch === 1'))
  await evaluate("localStorage.removeItem('__testHostPaused'); window.__noriSetPaused(false)")
  await waitFor('window.__noriL2dDraws > 2 && window.__ft.last')
  check('a paused startup resumes using the same model instance', await evaluate('__ft.epoch === 1 && document.querySelectorAll("canvas").length === 1'))
  check('no uncaught page errors', errors.length === 0)
  writeFileSync(join(tmpdir(), `nori-float-crop-e2e-${modelName}.json`), JSON.stringify({model: modelName, passed, artifacts, errors}, null, 2))
  console.log(`${passed}/${passed} passed (${modelName})`)
} catch (error) { console.error(error); console.error(JSON.stringify({errors}, null, 2)); process.exitCode = 1 }
finally {
  for (const entry of pending.values()) clearTimeout(entry.timer)
  ws?.close(); edge.kill(); await delay(500)
  if (dirname(resolve(profile)) !== resolve(tmpdir()) || !basename(profile).startsWith('nori-float-crop-')) throw new Error('Unexpected cleanup path')
  try { rmSync(profile, {recursive: true, force: true}) } catch {}
}
