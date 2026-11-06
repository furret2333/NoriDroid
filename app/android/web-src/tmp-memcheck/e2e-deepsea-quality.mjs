/** Deep-sea quality through the actual settings UI and WebGL draw calls.
 * Build first (`pnpm build`) and start `node ../.harness/server.mjs`.
 * SwiftShader checks functionality, not phone frame rate or power consumption. */
import {spawn} from 'node:child_process'
import {mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

const PORT = 9468
const profile = mkdtempSync(join(tmpdir(), 'nori-quality-'))
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
  for (let i = 0; i < 120; i++) {
    if (await evaluate(expression)) return
    await sleep(100)
  }
  throw new Error(`not ready: ${expression}`)
}
const visible = cls => `(() => { const c = document.querySelector(${JSON.stringify(cls)}); return !!c && getComputedStyle(c).display !== 'none' })()`
const modeSelector = `Array.from(document.querySelectorAll('select')).find(s => Array.from(s.options).some(o => o.value === 'deep-sea'))`
const qualitySelector = `document.querySelector('select[aria-label="深海画质"]')`
const select = (selector, value) => evaluate(`(() => { const s = ${selector}; if (!s) throw new Error('missing select'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change', {bubbles: true})) })()`)
const openSettings = async () => {
  await waitFor("!!Array.from(document.querySelectorAll('button')).find(b => b.querySelector('.fab-label')?.textContent === '设置')")
  await evaluate("Array.from(document.querySelectorAll('button')).find(b => b.querySelector('.fab-label')?.textContent === '设置').click()")
  await waitFor(`!!(${modeSelector})`)
}
const navigate = async seed => {
  const data = Buffer.from(JSON.stringify(seed)).toString('base64url')
  await send('Page.navigate', {url: `http://127.0.0.1:8123/assets/web/index.html?seed=${data}`})
  await openSettings()
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
    window.__qualityProbe = {points: [], fail: false};
    const originalContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
      if (this.classList.contains('deepsea-bg') && /^webgl/.test(type) && window.__qualityProbe.fail) return null;
      return originalContext.call(this, type, ...args);
    };
    const originalDraw = WebGLRenderingContext.prototype.drawArrays;
    WebGLRenderingContext.prototype.drawArrays = function(mode, first, count) {
      if (this.canvas.classList.contains('deepsea-bg') && mode === this.POINTS) {
        window.__qualityProbe.points.push({time: performance.now(), count});
        if (window.__qualityProbe.points.length > 300) window.__qualityProbe.points.shift();
      }
      return originalDraw.call(this, mode, first, count);
    };
  `})
  await send('Emulation.setDeviceMetricsOverride', {width: 360, height: 640, deviceScaleFactor: 2, mobile: true})
  // Legacy configuration has no quality field and must keep the current 30 FPS / 150-particle effect.
  await navigate({dataseaBg: true, backgroundMode: 'deep-sea', renderScale: 2, l2dFps: 60, ambientEnabled: false})
  await waitFor(`${visible('.deepsea-bg')} && ${qualitySelector} && __qualityProbe.points.length > 1`)
  check('旧配置默认均衡画质', await evaluate(`(${qualitySelector}).value === 'balanced'`))
  check('均衡画质实际画布使用 1.5 倍且绘制 150 粒子', await evaluate(`(() => {
    const c = document.querySelector('.deepsea-bg');
    return c.width === Math.round(innerWidth * 1.5) && c.height === Math.round(innerHeight * 1.5) && __qualityProbe.points.at(-1).count === 150
  })()`))
  const beforeModel = await evaluate(`({scale: window.__noriRenderScale, interval: window.__noriL2dMinInterval})`)
  await select(qualitySelector, 'fine')
  await waitFor(`document.querySelector('.deepsea-bg').width === Math.round(innerWidth * 2) && __qualityProbe.points.at(-1)?.count === 240`)
  check('切换精细画质立即提高背景分辨率和粒子数', true)
  check('精细画质持久化且不改人物设置', await evaluate(`(() => {
    const s = JSON.parse(NoriChat.readFile('settings.json'));
    return s.deepseaQuality === 'fine' && s.renderScale === 2 && s.l2dFps === 60 && window.__noriRenderScale === ${JSON.stringify(beforeModel.scale)} && window.__noriL2dMinInterval === ${JSON.stringify(beforeModel.interval)}
  })()`))
  await select(modeSelector, 'datasea')
  await waitFor(visible('.datasea-bg'))
  check('离开深海隐藏画质选择器', await evaluate(`!(${qualitySelector})`))
  await select(modeSelector, 'deep-sea')
  await waitFor(`${visible('.deepsea-bg')} && (${qualitySelector})?.value === 'fine' && __qualityProbe.points.at(-1)?.count === 240`)
  check('重进深海保留精细画质', true)
  await evaluate("window.__noriAppPaused = true; window.dispatchEvent(new Event('nori-app-pause'))")
  await sleep(100)
  check('暂停后精细画质停止绘制', await evaluate(`(async () => { const n = __qualityProbe.points.length; await new Promise(r => setTimeout(r, 400)); return n === __qualityProbe.points.length })()`))
  await evaluate("window.__noriAppPaused = false; window.dispatchEvent(new Event('nori-app-resume'))")
  await waitFor(`${visible('.deepsea-bg')} && __qualityProbe.points.at(-1)?.count === 240`)
  const loseContext = await evaluate(`(() => {
    window.__qualityContext = document.querySelector('.deepsea-bg').getContext('webgl');
    window.__qualityLoss = window.__qualityContext.getExtension('WEBGL_lose_context');
    if (!window.__qualityLoss) return false;
    window.__qualityLoss.loseContext();
    return true;
  })()`)
  check('测试环境支持模拟图形上下文丢失', loseContext)
  if (loseContext) {
    await waitFor(`${visible('.datasea-bg')} && document.body.textContent.includes('深海场景暂时不可用')`)
    check('上下文丢失时回退并保留精细画质', await evaluate(`(${qualitySelector}).value === 'fine' && JSON.parse(NoriChat.readFile('settings.json')).deepseaQuality === 'fine'`))
    await evaluate('__qualityLoss.restoreContext()')
    await waitFor('!__qualityContext.isContextLost()')
    await evaluate("Array.from(document.querySelectorAll('button')).find(b => b.textContent.trim() === '重试').click()")
    await waitFor(`${visible('.deepsea-bg')} && document.querySelector('.deepsea-bg').width === Math.round(innerWidth * 2) && __qualityProbe.points.at(-1)?.count === 240`)
    check('恢复后重试使用精细画质', true)
  }
  const saved = await evaluate("JSON.parse(NoriChat.readFile('settings.json'))")
  await navigate(saved)
  await waitFor(`${visible('.deepsea-bg')} && (${qualitySelector})?.value === 'fine' && __qualityProbe.points.at(-1)?.count === 240`)
  check('模拟重启后恢复精细画质', true)
  // Simulate a separately set lower resolution/FPS; fine must respect both limits.
  await navigate({...saved, renderScale: 1, l2dFps: 15})
  await waitFor(`${visible('.deepsea-bg')} && __qualityProbe.points.length > 1`)
  check('精细画质遵从较低分辨率', await evaluate(`(() => { const c = document.querySelector('.deepsea-bg'); return c.width === innerWidth && c.height === innerHeight })()`))
  const timestamps = await evaluate(`(async () => { __qualityProbe.points.length = 0; await new Promise(r => setTimeout(r, 1100)); return __qualityProbe.points.map(p => p.time) })()`)
  const deltas = timestamps.slice(1).map((t, i) => t - timestamps[i])
  check('精细画质遵从 15 FPS 上限', deltas.length >= 3 && deltas.filter(d => d >= 58).length >= deltas.length * 0.8, JSON.stringify(deltas))
  await select(qualitySelector, 'balanced')
  await waitFor('__qualityProbe.points.at(-1)?.count === 150')
  check('精细切回均衡后粒子立即回到 150', true)
  check('无未捕获异常', errors.length === 0, errors.join('\n'))
} catch (error) { check('测试执行', false, error.stack) }
finally {
  console.log(`${results.filter(Boolean).length}/${results.length} passed`)
  if (results.some(result => !result)) process.exitCode = 1
  for (const p of pending.values()) clearTimeout(p.timer)
  ws?.close(); edge.kill(); await sleep(400)
  try { rmSync(profile, {recursive: true, force: true}) } catch {}
}
