/** Background mode UI/lifecycle regression against the local Android WebView harness.
 * Build first (`pnpm build`); start `node ../.harness/server.mjs` from web-src.
 * Edge uses software WebGL here: these are behavior checks, not phone performance measurements. */
import {spawn} from 'node:child_process'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

const PORT = 9467
const profile = mkdtempSync(join(tmpdir(), 'nori-background-'))
const edge = spawn('C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', [
  '--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check', '--use-gl=angle', '--use-angle=swiftshader',
  '--enable-unsafe-swiftshader', '--window-size=360,640', 'about:blank',
], {stdio: 'ignore', windowsHide: true})
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
let ws, id = 0, session
const pending = new Map(), results = [], errors = []
const check = (label, ok, detail = '') => {
  results.push(!!ok)
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : `: ${detail}`}`)
}
const send = (method, params = {}, sessionId = session) => new Promise((resolve, reject) => {
  const next = ++id
  const timer = setTimeout(() => { pending.delete(next); reject(new Error(`${method} timeout`)) }, 15000)
  pending.set(next, {resolve, reject, timer})
  ws.send(JSON.stringify({id: next, method, params, ...(sessionId ? {sessionId} : {})}))
})
const evaluate = async expression => {
  const response = await send('Runtime.evaluate', {expression, returnByValue: true, awaitPromise: true})
  if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text)
  return response.result.value
}
const waitFor = async expression => {
  for (let i = 0; i < 100; i++) {
    if (await evaluate(expression)) return
    await sleep(100)
  }
  throw new Error(`not ready: ${expression}`)
}
const visible = cls => `(() => { const c = document.querySelector(${JSON.stringify(cls)}); return !!c && getComputedStyle(c).display !== 'none' && getComputedStyle(c).visibility !== 'hidden' })()`
const selector = `Array.from(document.querySelectorAll('select')).find(s => Array.from(s.options).some(o => o.value === 'deep-sea'))`
const select = mode => evaluate(`(() => { const s = ${selector}; s.value = ${JSON.stringify(mode)}; s.dispatchEvent(new Event('change', {bubbles: true})) })()`)
const openSettings = async () => {
  await waitFor("!!Array.from(document.querySelectorAll('button')).find(b => b.querySelector('.fab-label')?.textContent === '设置')")
  await evaluate("Array.from(document.querySelectorAll('button')).find(b => b.querySelector('.fab-label')?.textContent === '设置').click()")
  await waitFor(`!!(${selector})`)
}
try {
  let endpoint
  for (let i = 0; i < 50 && !endpoint; i++) {
    try { endpoint = (await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json()).webSocketDebuggerUrl } catch {}
    if (!endpoint) await sleep(200)
  }
  if (!endpoint) throw new Error('Edge CDP 未启动')
  ws = new WebSocket(endpoint)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  ws.onmessage = event => {
    const m = JSON.parse(event.data)
    if (m.method === 'Runtime.exceptionThrown') errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text)
    const p = pending.get(m.id)
    if (!p) return
    clearTimeout(p.timer); pending.delete(m.id)
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
  }
  const target = await send('Target.createTarget', {url: 'about:blank'})
  session = (await send('Target.attachToTarget', {targetId: target.targetId, flatten: true})).sessionId
  await send('Runtime.enable'); await send('Page.enable')
  await send('Page.addScriptToEvaluateOnNewDocument', {source: `
    window.__bgProbe = {dataDraws: 0, deepDraws: 0, fail: false};
    const originalContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
      if (this.classList.contains('deepsea-bg') && /^webgl/.test(type) && window.__bgProbe.fail) return null;
      return originalContext.call(this, type, ...args);
    };
    const originalImage = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function(...args) {
      if (this.canvas.classList.contains('datasea-bg')) window.__bgProbe.dataDraws++;
      return originalImage.apply(this, args);
    };
    for (const type of [window.WebGLRenderingContext, window.WebGL2RenderingContext]) {
      if (!type) continue;
      const proto = type.prototype;
      for (const method of ['drawArrays', 'drawElements']) {
        const original = proto[method];
        if (!original) continue;
        proto[method] = function(...args) {
          if (this.canvas.classList.contains('deepsea-bg')) window.__bgProbe.deepDraws++;
          return original.apply(this, args);
        };
      }
    }
  `})
  await send('Emulation.setDeviceMetricsOverride', {width: 360, height: 640, deviceScaleFactor: 1, mobile: true})
  const seed = Buffer.from(JSON.stringify({dataseaBg: false, ambientEnabled: false})).toString('base64url')
  await send('Page.navigate', {url: `http://127.0.0.1:8123/assets/web/index.html?seed=${seed}`})
  await openSettings()
  check('旧版关闭设置升级后保持关闭', await evaluate(`(${selector}).value === 'off' && !${visible('.datasea-bg')} && !${visible('.deepsea-bg')}`))
  await select('datasea')
  await waitFor(`${visible('.datasea-bg')} && __bgProbe.dataDraws > 0`)
  check('关闭状态启动后可开启现有数据海', await evaluate(`${visible('.datasea-bg')} && !${visible('.deepsea-bg')}`))
  await select('deep-sea')
  await waitFor(`${visible('.deepsea-bg')} && __bgProbe.deepDraws > 0`)
  // Optional preview of the scene with the real model; model files must be served by the harness.
  if (process.env.NORI_BG_FULL_SCREENSHOT) {
    await waitFor('window.__noriL2dDraws > 2')
    await sleep(2300)
    console.log('REAL_MODEL', JSON.stringify(await evaluate(`({bounds: window.__noriVisibleBounds?.(), footlight: !!document.querySelector('.deepsea-footlight')})`)))
    await evaluate("document.querySelector('.intro-mask')?.click(); document.querySelector('.sheet-mask')?.click()")
    await sleep(500)
    const screenshot = await send('Page.captureScreenshot', {format: 'png'})
    writeFileSync(process.env.NORI_BG_FULL_SCREENSHOT, Buffer.from(screenshot.data, 'base64'))
    await openSettings()
  }
  // These checks need a real model in NORI_MODELS_DIR. Override only its bounds
  // after it is loaded so the clipping and lifecycle cases are deterministic.
  if (process.env.NORI_BG_MODEL_CHECKS) {
    await waitFor('window.__noriL2dDraws > 2 && typeof window.__noriVisibleBounds === "function"')
    await evaluate(`window.__originalFootBounds = window.__noriVisibleBounds;
      window.__footSamples = 0;
      window.__noriVisibleBounds = () => { window.__footSamples++; return null }`)
    await sleep(2200)
    check('模型边界不可用时脚下光晕隐藏', await evaluate("!document.querySelector('.deepsea-footlight')"))
    await evaluate(`window.__noriVisibleBounds = () => { window.__footSamples++; return {l: 0.35, t: 0.15, r: 0.65, b: 0.8} }`)
    await waitFor("!!document.querySelector('.deepsea-footlight')")
    check('可见边界产生光晕且不拦截触摸', await evaluate(`(() => {
      const el = document.querySelector('.deepsea-footlight'), rect = el.getBoundingClientRect();
      return getComputedStyle(el).pointerEvents === 'none' && rect.width > 0 && rect.height > 0 && Number.isFinite(rect.x) && Number.isFinite(rect.y)
    })()`))
    await evaluate("window.__noriAppPaused = true; window.dispatchEvent(new Event('nori-app-pause'))")
    await sleep(100)
    check('暂停时脚下光晕隐藏', await evaluate("!document.querySelector('.deepsea-footlight')"))
    await evaluate("window.__noriAppPaused = false; window.dispatchEvent(new Event('nori-app-resume'))")
    await waitFor("!!document.querySelector('.deepsea-footlight')")
    check('恢复时重新显示脚下光晕', true)
    await select('datasea')
    await waitFor(visible('.datasea-bg'))
    check('切换数据海时脚下光晕隐藏', await evaluate("!document.querySelector('.deepsea-footlight')"))
    await select('deep-sea')
    await waitFor(`${visible('.deepsea-bg')} && !!document.querySelector('.deepsea-footlight')`)
    check('重新切到深海后恢复光晕', true)
    await evaluate('window.__noriVisibleBounds = window.__originalFootBounds')
  }
  // Optional visual artifact; the routine regression does not write outside its test profile.
  if (process.env.NORI_BG_SCREENSHOT) {
    await evaluate(`(() => { const s = document.createElement('style'); s.id = '__bgScreenshotStyle'; s.textContent = 'body * { visibility: hidden !important } .deepsea-bg { visibility: visible !important }'; document.head.appendChild(s) })()`)
    await sleep(200)
    const screenshot = await send('Page.captureScreenshot', {format: 'png'})
    writeFileSync(process.env.NORI_BG_SCREENSHOT, Buffer.from(screenshot.data, 'base64'))
    await evaluate("document.getElementById('__bgScreenshotStyle')?.remove()")
  }
  await sleep(200)
  check('深海启用时旧背景不再绘制', await evaluate(`(async () => { const n = __bgProbe.dataDraws; await new Promise(r => setTimeout(r, 300)); return !${visible('.datasea-bg')} && __bgProbe.dataDraws === n })()`))
  check('设置持久化新模式', await evaluate(`(() => { const s = JSON.parse(NoriChat.readFile('settings.json')); return s.backgroundMode === 'deep-sea' })()`))
  await evaluate("window.__noriAppPaused = true; window.dispatchEvent(new Event('nori-app-pause'))")
  await sleep(150)
  check('原生暂停时深海停止绘制', await evaluate(`(async () => { const n = __bgProbe.deepDraws; await new Promise(r => setTimeout(r, 400)); return __bgProbe.deepDraws === n })()`))
  const before = await evaluate('__bgProbe.deepDraws')
  await evaluate("window.__noriAppPaused = false; window.dispatchEvent(new Event('nori-app-resume'))")
  await waitFor(`__bgProbe.deepDraws > ${before}`)
  check('原生恢复后深海继续绘制', true)
  const hasLoseContext = await evaluate(`(() => {
    window.__lostContext = document.querySelector('.deepsea-bg').getContext('webgl');
    window.__lostExt = window.__lostContext.getExtension('WEBGL_lose_context');
    if (!window.__lostExt) return false;
    window.__lostExt.loseContext();
    return true;
  })()`)
  check('测试环境支持模拟 WebGL 上下文丢失', hasLoseContext)
  if (hasLoseContext) {
    await waitFor(`${visible('.datasea-bg')} && document.body.textContent.includes('深海场景暂时不可用')`)
    check('WebGL 上下文丢失后回退并保留选择', await evaluate(`(${selector}).value === 'deep-sea' && !${visible('.deepsea-bg')}`))
    await evaluate('__lostExt.restoreContext()')
    await waitFor('!__lostContext.isContextLost()')
    const retryBefore = await evaluate('__bgProbe.deepDraws')
    await evaluate("Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '重试').click()")
    await waitFor(`${visible('.deepsea-bg')} && __bgProbe.deepDraws > ${retryBefore}`)
    check('上下文恢复后重试可重新启动深海', true)
  }
  await select('datasea')
  await waitFor(visible('.datasea-bg'))
  await evaluate('__bgProbe.fail = true')
  await select('deep-sea')
  await waitFor(`${visible('.datasea-bg')} && document.body.textContent.includes('深海场景暂时不可用')`)
  check('WebGL 初始化失败时回退并保留用户选择', await evaluate(`(${selector}).value === 'deep-sea' && !${visible('.deepsea-bg')} && JSON.parse(NoriChat.readFile('settings.json')).backgroundMode === 'deep-sea'`))
  await evaluate('__bgProbe.fail = false')
  await select('off')
  await sleep(250)
  check('关闭后没有背景显示和绘制', await evaluate(`(async () => { const a = __bgProbe.dataDraws, b = __bgProbe.deepDraws; await new Promise(r => setTimeout(r, 300)); return !${visible('.datasea-bg')} && !${visible('.deepsea-bg')} && a === __bgProbe.dataDraws && b === __bgProbe.deepDraws })()`))
  await evaluate(`(() => { const s = ${selector}; for (const mode of ['deep-sea','datasea','off']) { s.value = mode; s.dispatchEvent(new Event('change', {bubbles: true})) } })()`)
  await sleep(600)
  check('快速切换以后期选择为准', await evaluate(`(${selector}).value === 'off' && !${visible('.datasea-bg')} && !${visible('.deepsea-bg')}`))
  check('无未捕获异常', errors.length === 0, errors.join('\n'))
} catch (error) { check('测试执行', false, error.stack) }
finally {
  console.log(`${results.filter(Boolean).length}/${results.length} passed`)
  if (results.some(result => !result)) process.exitCode = 1
  for (const p of pending.values()) clearTimeout(p.timer)
  ws?.close(); edge.kill(); await sleep(400)
  try { rmSync(profile, {recursive: true, force: true}) } catch {}
}
