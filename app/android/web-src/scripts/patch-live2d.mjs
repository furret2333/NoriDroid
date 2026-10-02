/**
 * live2d-easy-control 补丁脚本
 *
 * 为什么要 fail-fast:
 * 这些补丁不是可选优化, 每一个都对应一个"已修复过"的实际问题 (表情叠加/表情参数残留/
 * 渲染分辨率开关/加载失败与超时/Core 本地化/纹理 CORS/跨动作残留/触摸注入点)。
 * 原来的实现锚点失配时只打印 "skip" 并继续、退出码 0 —— 库一升版就会静默丢掉一批
 * 已修复行为, 而 pnpm build / vue-tsc / 浏览器冒烟三重门禁全是绿的, 症状要等用户
 * 反馈"模型抽搐/断网消失/命中错位"才暴露, 且和几个月前刚修过的现象一模一样, 极难定位。
 *
 * 现在改成四态判定:
 *   ① 锚点命中              → 打补丁                    (applied)
 *   ② 锚点消失但哨兵在       → 幂等重跑, 已是新版产物     (already)
 *   ③ 锚点/哨兵都无但遗留形态在 → 迁移: 补哨兵, 代码不变   (migrated)
 *   ④ 三者都不在            → 真失配, 必须失败           (failed → 退出码 1, 中断 postinstall/构建)
 *
 * ③ 是必需的: 存量 node_modules 是旧脚本打的 (已打补丁但没有哨兵), 若只判 ①② 会把它们
 * 误报成"库升版失配"。迁移只加注释, 不改代码, 已用逐字节比对验证。
 *
 * 哨兵是内联块注释 (形如 nori-patch:xxx 的注释标记), 保持原代码换行结构不变, 对运行零影响。
 */
import {readFileSync, writeFileSync, existsSync} from "node:fs"
import {dirname, resolve} from "node:path"
import {fileURLToPath} from "node:url"

const TARGET = resolve(dirname(fileURLToPath(import.meta.url)), "../node_modules/live2d-easy-control/live2dEasyControl.js")

if (!existsSync(TARGET)) {
	console.error(`[patch-live2d] 找不到库文件: ${TARGET}`)
	console.error(`[patch-live2d] 请先执行 pnpm install (postinstall 会自动调用本脚本)`)
	process.exit(1)
}

let source = readFileSync(TARGET, "utf-8")

/* ---------------- 哨兵标记 (幂等判定 + 产物自检共用) ---------------- */
/** 补丁方案版本: 改动本脚本的任一 NEW 字符串时必须递增, 否则旧哨兵会被误判成"已打过" */
const PATCH_VERSION = 3
const VERSION_MARK = `/*[nori-patch-set:v${PATCH_VERSION}]*/`
/** 生成哨兵注释; token 唯一即可。
 *  注意: 调用点的模板字面量已自带行首缩进 (如 "      ${M("  x")}"), 本函数**不再**补缩进,
 *  否则缩进翻倍、剥掉哨兵后会留下"只有空格"的残行。
 *  token 允许带前导空白以便调用处对齐, 这里统一 trim。 */
const M = (spec) => {
	const token = String(spec).trim()
	if (!/^[a-z0-9-]+$/.test(token)) throw new Error(`非法哨兵 token: ${spec}`)
	return `/*[nori-patch:${token}]*/`
}

/* ---------------- 检测: 上个版本的本脚本留下的旧哨兵 ---------------- */
const setMarkMatch = source.match(/\/\*\[nori-patch-set:v(\d+)\]\*\//)
const patchedByVersion = setMarkMatch ? Number(setMarkMatch[1]) : 0
const staleSentinels = patchedByVersion !== PATCH_VERSION && source.includes("[nori-patch:")
if (staleSentinels) {
	console.error(`[patch-live2d] 检测到本文件是旧版脚本 (v${patchedByVersion || "无版本标记"}) 打过的产物, 当前脚本是 v${PATCH_VERSION}。`)
	console.error(`[patch-live2d] 旧哨兵会让新补丁被误判成"已打过", 因此拒绝继续。`)
	console.error(`[patch-live2d] 修复: cd app/android/web-src && pnpm install --force  (或删掉 node_modules/live2d-easy-control 后重装)`)
	process.exit(1)
}

const CLEANUP_OLD = `    if (s.getSize() > 1 && this.getFadeWeight(
      this._fadeWeights.getSize() - 1
    ) >= 1)
      for (let o = s.getSize() - 2; o >= 0; --o) {
        const u = s.at(o);
        xt(u), s.remove(o), this._fadeWeights.remove(o);
      }`
const CLEANUP_NEW = `    ${M("expression-stacking")}`

const STOP_OLD = `  stopAllExpressions() {
    this._expressionManager != null && this._expressionManager.stopAllMotions();
  }`
const STOP_NEW = `  stopAllExpressions() {
    ${M("    expression-param-restore")}
    if (this._expressionManager == null) return;
    const values = this._expressionManager._expressionParameterValues;
    if (values) {
      for (let i = 0; i < values.getSize(); i++) {
        const p = values.at(i);
        if (p != null && p.parameterId != null) this._model.setParameterValueById(p.parameterId, p.overwriteValue, 1);
      }
    }
    this._expressionManager.stopAllMotions();
  }`

const GL_OLD = `getContext("webgl2", { preserveDrawingBuffer: true })`
const GL_NEW = `getContext("webgl2")${M("preserve-drawing-buffer")}`

// 渲染分辨率: 由 __noriRenderScale 控制 (设置里的"渲染分辨率"), 缺省用原生 DPR
const RESIZE_DPR_OLD = `this._canvas.width = this._canvas.clientWidth * window.devicePixelRatio, this._canvas.height = this._canvas.clientHeight * window.devicePixelRatio, this._gl.viewport(0, 0, this._gl.drawingBufferWidth, this._gl.drawingBufferHeight);`
const DPR_READ = `(window.__noriRenderScale || window.devicePixelRatio || 1)`
const RESIZE_DPR_NEW = `this._canvas.width = this._canvas.clientWidth * ${DPR_READ}, this._canvas.height = this._canvas.clientHeight * ${DPR_READ}, this._gl.viewport(0, 0, this._gl.drawingBufferWidth, this._gl.drawingBufferHeight);${M("render-scale")}`
// 兼容已打过旧补丁 (封顶 DPR=1) 的 node_modules
const RESIZE_DPR_OLD_PATCHED = `this._canvas.width = this._canvas.clientWidth * Math.min(window.devicePixelRatio || 1, 1), this._canvas.height = this._canvas.clientHeight * Math.min(window.devicePixelRatio || 1, 1), this._gl.viewport(0, 0, this._gl.drawingBufferWidth, this._gl.drawingBufferHeight);`

const LOAD_ASSETS_OLD = `}).catch((e) => {
      F(` + "`Failed to load file ${this._modelHomeDir}.model3.json`" + `);
    });`
const LOAD_ASSETS_NEW = `}).catch((e) => {
      F(` + "`Failed to load file ${this._modelHomeDir}.model3.json`" + `);
      this._loadFailed = !0;${M("load-failed-flag")}
    });`

const WAITING_OLD = `  waiting() {
    return new Promise((t) => {
      const e = () => {
        this._model.getLoadState() ? t() : setTimeout(e, 10);
      };
      e();
    });
  }`
const WAITING_NEW = `  waiting() {
    return new Promise((t, r) => {
      ${M("      load-timeout-reject")}
      let n = 0;
      const e = () => {
        if (this._model.getLoadState()) t();
        else if (this._model._loadFailed) r(new Error("模型加载失败"));
        else if (++n > 6000) r(new Error("模型加载超时"));
        else setTimeout(e, 10);
      };
      e();
    });
  }`

// [patch] Cubism Core 加载改造: 原实现从官方 CDN 拉核心脚本且只挂 onload (无 onerror 无超时),
// CDN 不通时 load() 永久挂起、模型无声无息不出现。改为: 已加载直接跳过 → 本地副本优先
// (import.meta.url 相对定位到 chunk 上级的 assets/web/live2dcubismcore.min.js, APK 自带) →
// 失败回退官方 CDN; 全程 8 秒超时, 超时/失败 reject 给上层报错提示。
// 注意: 库源码里这是 "const _a = ..., Zt = ..., O = ...;" 一条多声明语句,
// OLD 必须吃掉 new Promise 的收尾 ")", NEW 结尾不带分号, 让 ", Zt = ..." 合法续接
const CORE_OLD = `const _a = () => new Promise((r) => {
  const t = document.createElement("script");
  t.src = "https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js", t.async = !0, t.onload = () => r(), document.head.appendChild(t);
})`
const CORE_NEW = `const _a = () => {
  ${M("  cubism-core-local")}
  if (window.Live2DCubismCore) return Promise.resolve();
  return new Promise((r, rej) => {
    let done = !1;
    const ok = () => { if (!done) { done = !0; r(); } };
    const bad = (m) => { if (!done) { done = !0; rej(new Error(m)); } };
    const load = (src, next) => {
      const t = document.createElement("script");
      t.src = src, t.async = !0, t.onload = ok, t.onerror = next || (() => bad("Cubism Core 加载失败(本地与CDN均不可达)")), document.head.appendChild(t);
    };
    load(new URL("../live2dcubismcore.min.js", /* @vite-ignore */ import.meta.url).href, () => load("https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js"));
    setTimeout(() => bad("Cubism Core 加载超时(8s)"), 8000);
  });
}`

const TEX_IMG_OLD = `a.ptr().img = new Image(), a.ptr().img.addEventListener("load", () => i(a.ptr()), {
          passive: !0
        }), a.ptr().img.src = t;`
const TEX_IMG_NEW = `a.ptr().img = new Image(), a.ptr().img.crossOrigin = "anonymous",${M("texture-cors-1")} a.ptr().img.addEventListener("load", () => i(a.ptr()), {
          passive: !0
        }), a.ptr().img.src = t;`

const TEX_NEW_OLD = `    const s = new Image();
    s.addEventListener(`
const TEX_NEW_NEW = `    const s = new Image();
    s.crossOrigin = "anonymous";
    ${M("    texture-cors-2")}
    s.addEventListener(`

const MOTION_RESET_OLD = `    if (i == B.priorityForce)
      this._motionManager.setReservePriority(i);`
const MOTION_RESET_NEW = `    if (i == B.priorityForce) {
      ${M("      motion-param-reset")}
      this._motionManager.setReservePriority(i);
      // [patch] 强行动作前先清空所有动作并把参数复位到默认值,
      // 避免上一个动作(如 Bow)未覆盖的肢体参数残留叠加(手臂重叠)
      this._motionManager.stopAllMotions();
      if (this._model != null) {
        for (let p = 0; p < this._model.getParameterCount(); p++) this._model.setParameterValueByIndex(p, this._model.getParameterDefaultValue(p));
        this._model.saveParameters();
      }
    }`

// 暴露模型自然画布尺寸到全局: 用于触摸区域通过 contain() 映射对齐到真实模型内容矩形,
// 使框随模型缩放/位移而同步 (移动端的画布是 100% 全屏, 模型在内部等比适配, 尺寸会丢失)
const MODEL_INFO_OLD = `this._model.saveParameters(), this._modelMatrix = new qi(`
// 同时暴露"任意参数设置"接口 (视线跟随需要直接改 ParamEyeBallX/Y)
const GAZE_API = `window.__noriSetParam = (id, v) => { try { this._model.setParameterValueById(id, v, 1) } catch (e) {} }; window.__noriHasParam = (id) => { try { return this._model.getParameterIndex(id) >= 0 } catch (e) { return false } }; `
// 暴露模型命中测试: 遍历全部 drawable 顶点矩形判定 (区分模型实体与留白区域)。
// 注 1: ARG Nori 的 model3.json 未定义 HitAreas, 语义 hitTest(areaName) 恒 false, 故逐 drawable 判定。
// 注 2: isHit 定义在用户模型类自身 (与 getModel/createRenderer 同级), 内层 _model(CubismModel)
//       没有 isHit —— 之前调 this._model.isHit 必抛 TypeError, 钩子吞掉后恒返回 null (调试片恒"未知")。
// 注 3: deviceToScreen 按画布背缓冲 (css × renderScale||dpr, 见 initViewMatrix 的 this._canvas) 标定,
//       坐标必须乘同一个系数 —— 之前乘纯 dpr, 真机渲染分辨率=1 时坐标过冲 ~dpr 倍, 命中区缩成一小团错位。
const HIT_FACTOR = `(window.__noriRenderScale || window.devicePixelRatio || 1)`
const HIT_TEST_API = `window.__noriHitTest = (cx, cy) => { try { const dX = cx * ${HIT_FACTOR}, dY = cy * ${HIT_FACTOR}, vx = this._viewManager.transformViewX(dX), vy = this._viewManager.transformViewY(dY), n = this._model.getDrawableCount(); for (let i = 0; i < n; i++) { if (this.isHit(this._model.getDrawableId(i), vx, vy)) return { hit: true }; } return { hit: false }; } catch (e) { return { hit: false, err: String((e && e.message) || e) } } }; `

/* ---------------- Phase 3a 探针: 部位/顶点几何 (只读诊断, 不改任何行为) ----------------
 *
 * 目的: 摸头目前只能判"实体/留白"(逐 drawable), 判不出"头"。网页版是用**部件**做的
 * (`getPartsBounds(["Part9"])` + 一条 skullTopBand 带)。要在安卓端复刻, 先得确认这套
 * Cubism Core 到底暴露了哪些几何 API —— 所以这里**只加探针**, 先用 probe 脚本读真实返回值,
 * 拿到结论之后再写真正的判定逻辑（探针本身可以留着当诊断）。
 *
 * 为什么锚在 __noriHitTest 上: 它在产物里唯一(有断言), 且同处一个方法作用域,
 * `this._model` / `this._viewManager` 都可用。
 *
 * 为什么**不**递增 PATCH_VERSION: 本补丁是**纯增量**(全新 token `part-bounds-probe`,
 * 产物里不存在同名旧哨兵), 不存在"旧哨兵让新补丁被误判成已打过"的风险; 而
 * PATCH_VERSION 一改, 版本守卫会当场拒绝现有产物并强制 `pnpm install --force`。 */
/* ---------------- 摸头"低头"的独立参数通道 (追踪与低头解耦) ----------------
 *
 * 库把注视方向(drag) **同时**加到头部角度(ParamAngleX/Y/Z)与眼珠(ParamEyeBallX/Y)上 —— 只有一条通道。
 * 所以"低头"若走注视通道, 眼珠必然被一起压低; 若不走通道(把注视目标锚到中立点), 追踪就没了。
 * 这里额外暴露两个钩子, 让 App 能在**库每帧更新之后**单独给头部加低头、并给眼珠反向补偿:
 *   - __noriAddParam(id, v): addParameterValueById (**相加**, 不是覆盖) —— 不会覆盖库刚写进去的值
 *   - __noriGetParam(id): 读回当前值 (给门禁/E2E 断言用, 也方便实机调试)
 * 施加时机在 App 侧 (frameCap.ts 的 tick 里, model.update() 之后), 顺序确定, 不与库的叠加打架。
 *
 * 为什么**不**递增 PATCH_VERSION: 同"部位几何探针" —— 纯增量、全新 token(`param-add-get`),
 * 产物里不存在同名旧哨兵; 而 PATCH_VERSION 一改, 版本守卫会当场拒绝现有产物并要求 pnpm install --force。 */
const PARAM_API = `${M("param-add-get")} window.__noriParamIndexOf = (id) => { try { const m = this._model, n = m.getParameterCount(); for (let i = 0; i < n; i++) { if (window.__noriIdStr(m.getParameterId(i)) === id) return i; } return -1 } catch (e) { return -1 } }; window.__noriAddParam = (id, v) => { try { const i = window.__noriParamIndexOf(id); if (i < 0) return false; if (typeof this._model.addParameterValueByIndex === "function") this._model.addParameterValueByIndex(i, v); else this._model.addParameterValueById(id, v); return true } catch (e) { return false } }; window.__noriGetParam = (id) => { try { const i = window.__noriParamIndexOf(id); return i < 0 ? null : this._model.getParameterValueByIndex(i) } catch (e) { return null } }; window.__noriParamInfo = (id) => { try { const m = this._model, i = window.__noriParamIndexOf(id); if (i < 0) return null; return { i: i, count: m.getParameterCount(), value: m.getParameterValueByIndex(i), min: m.getParameterMinimumValue(i), max: m.getParameterMaximumValue(i), def: m.getParameterDefaultValue(i) } } catch (e) { return null } }; `

/* ---------------- 摸头"低头"的**正确注入点**: 顶点计算之前 ----------------
 *
 * 库每帧的参数流水线 (minified 单行里就在这一处):
 *   ... motions/expressions → breath → **physics** → lipsync → **pose** → `this._model.update()`
 * 之后才由 renderer 画。`this._model.update()` 一执行, 顶点就按当时的参数算完了。
 * ⇒ "额外加参数"必须在 `this._model.update()` **之前**。加在之后(例如渲染循环的 tick 里)
 *   顶点早已算完 ⇒ 画面上**一点都看不出来**, 而且下一帧库重载参数会把它丢掉。
 *   （第一版就是加在 tick 里, 实机反馈"低头一点都看不出来"。）
 * 锚点实测唯一 (count=1)。 */
const PARAM_INJECT_OLD = `this._pose != null && this._pose.updateParameters(this._model, t), this._model.update();`
const PARAM_INJECT_NEW = `this._pose != null && this._pose.updateParameters(this._model, t), window.__noriBeforeModelUpdate && window.__noriBeforeModelUpdate(), ${M("param-inject")} this._model.update();`

const PART_PROBE_ANCHOR = `window.__noriHitTest = (cx, cy) => {`
const PART_PROBE_API = `${M("part-bounds-probe")} window.__noriIdStr = (v) => { try { if (typeof v === "string") return v; if (v && typeof v.getString === "function") { const g = v.getString(); return typeof g === "string" ? g : String(g && g.s !== undefined ? g.s : g); } if (v && v.s !== undefined) return String(v.s); return String(v); } catch (e) { return "?" } }; window.__noriPartProbe = () => { try {
  const m = this._model;
  const has = (n) => typeof m[n] === "function";
  const vp = has("getDrawableVertexPositions") ? "getDrawableVertexPositions" : (has("getDrawableVertices") ? "getDrawableVertices" : null);
  const boxOf = (i) => { if (!vp) return null; const vc = m.getDrawableVertexCount(i); if (!vc) return null; const v = m[vp](i); let b = null; for (let k = 0; k < vc; k++) { const x = v[k * 2], y = v[k * 2 + 1]; if (!b) b = { left: x, right: x, top: y, bottom: y }; else { if (x < b.left) b.left = x; if (x > b.right) b.right = x; if (y > b.top) b.top = y; if (y < b.bottom) b.bottom = y; } } return b; };
  const desc = (v) => { try { return { t: typeof v, keys: v && typeof v === "object" ? Object.keys(v).slice(0, 6) : null, getString: typeof (v && v.getString), sType: v ? typeof v.s : null, str: window.__noriIdStr(v) } } catch (e) { return { err: String(e) } } };
  const dc = m.getDrawableCount();
  let allBox = null;
  for (let i = 0; i < dc; i++) { const b = boxOf(i); if (!b) continue; if (!allBox) allBox = b; else { if (b.left < allBox.left) allBox.left = b.left; if (b.right > allBox.right) allBox.right = b.right; if (b.top > allBox.top) allBox.top = b.top; if (b.bottom < allBox.bottom) allBox.bottom = b.bottom; } }
  const parts = has("getDrawableParentPartIndex") ? (() => { const acc = {}; for (let d = 0; d < dc; d++) { const p = m.getDrawableParentPartIndex(d); if (p < 0) continue; const b = boxOf(d); if (!b) continue; const cur = acc[p] || (acc[p] = { i: p, drawables: 0, box: { left: b.left, right: b.right, top: b.top, bottom: b.bottom } }); cur.drawables += 1; if (b.left < cur.box.left) cur.box.left = b.left; if (b.right > cur.box.right) cur.box.right = b.right; if (b.top > cur.box.top) cur.box.top = b.top; if (b.bottom < cur.box.bottom) cur.box.bottom = b.bottom; } return Object.keys(acc).map((k) => acc[k]); })() : null;
  const names = has("getPartCount") ? Array.from({ length: m.getPartCount() }, (_, i) => window.__noriIdStr(m.getPartId(i))) : null;
  const params = has("getParameterCount") ? Array.from({ length: m.getParameterCount() }, (_, i) => window.__noriIdStr(m.getParameterId(i))) : null;
  let flagTrue = 0;
  if (has("getDrawableDynamicFlagIsVisible")) { for (let i = 0; i < dc; i++) if (m.getDrawableDynamicFlagIsVisible(i) === true) flagTrue += 1; }
  const flagSample = has("getDrawableDynamicFlagIsVisible") ? [0, 1, 2].map((i) => m.getDrawableDynamicFlagIsVisible(i)) : null;
  const drawableNames = Array.from({ length: Math.min(6, dc) }, (_, i) => window.__noriIdStr(m.getDrawableId(i)));
  return { ok: true, canvas: { w: m.getCanvasWidth(), h: m.getCanvasHeight() }, idSample: [desc(has("getPartCount") && m.getPartCount() > 0 ? m.getPartId(0) : null), desc(m.getDrawableId(0))], partCount: has("getPartCount") ? m.getPartCount() : -1, names, params, drawableCount: dc, drawableNames, flagTrue, flagSample, sample: [0, 1, 2, 3].map((i) => ({ i, box: boxOf(i) })), allBox, parts };
} catch (e) { return { ok: false, err: String((e && e.message) || e) } } }; window.__noriPartBounds = (ids) => { try {
  const m = this._model;
  const has = (n) => typeof m[n] === "function";
  if (!has("getDrawableParentPartIndex") || !has("getPartCount")) return { ok: false, err: "Core 缺少 getDrawableParentPartIndex/getPartCount" };
  const vp = has("getDrawableVertexPositions") ? "getDrawableVertexPositions" : (has("getDrawableVertices") ? "getDrawableVertices" : null);
  if (!vp) return { ok: false, err: "无可用的顶点 API" };
  const want = {}; (ids || []).forEach((s) => { want[String(s)] = 1 });
  let box = null, matched = 0, names = {}, visible = 0;
  const dc = m.getDrawableCount();
  for (let d = 0; d < dc; d++) {
    let p = m.getDrawableParentPartIndex(d), ok = false;
    for (let guard = 0; p >= 0 && guard < 128; guard++) { if (want[String(p)] || want[window.__noriIdStr(m.getPartId(p))]) { ok = true; names[window.__noriIdStr(m.getPartId(p)) || String(p)] = 1; break; } p = has("getPartParentPartIndex") ? m.getPartParentPartIndex(p) : -1; }
    if (!ok) continue;
    matched += 1;
    if (has("getDrawableDynamicFlagIsVisible") && m.getDrawableDynamicFlagIsVisible(d) === true) visible += 1;
    const vc = m.getDrawableVertexCount(d); if (!vc) continue;
    const v = m[vp](d);
    for (let k = 0; k < vc; k++) { const x = v[k * 2], y = v[k * 2 + 1]; if (!box) box = { left: x, right: x, top: y, bottom: y }; else { if (x < box.left) box.left = x; if (x > box.right) box.right = x; if (y > box.top) box.top = y; if (y < box.bottom) box.bottom = y; } }
  }
  return { ok: true, box, matched, visible, names: Object.keys(names) };
} catch (e) { return { ok: false, err: String((e && e.message) || e) } } }; window.__noriModelPoint = (cx, cy) => { try { const f = (window.__noriRenderScale || window.devicePixelRatio || 1); return { x: this._viewManager.transformViewX(cx * f), y: this._viewManager.transformViewY(cy * f) }; } catch (e) { return { err: String((e && e.message) || e) } } }; `

/* ---------------- 应用器: 三态判定 ---------------- */
let changed = false
const applied = []
const already = []
const migrated = []
const failures = []

/** 单体替换: 锚点唯一, 只替换第一处 */
const apply = (name, oldStr, newStr) => {
	if (!source.includes(oldStr)) return "miss"
	source = source.replace(oldStr, newStr)
	changed = true
	applied.push(name)
	console.log(`[patch-live2d] ${name} applied`)
	return "applied"
}

/** 多处等值替换: 锚点可重复 (如 preserveDrawingBuffer 出现 2 次) */
const applyAll = (name, oldStr, newStr) => {
	const count = source.split(oldStr).length - 1
	if (count <= 0) return "miss"
	source = source.split(oldStr).join(newStr)
	changed = true
	applied.push(name)
	console.log(`[patch-live2d] ${name} applied (${count})`)
	return "applied"
}

/**
 * 遗留产物形态: 旧脚本打的补丁**没有哨兵**。新脚本必须能识别这种状态, 否则会把
 * "已打过补丁的现有 node_modules"误判成"库升版失配"而报假失败。
 * 处理: 命中遗留 NEW 形态 → 换成带哨兵的新 NEW 形态 (迁移), 记 applied。
 */
const LEGACY = {
	"expression-stacking": `    // [patch] allow expression stacking`,
	"expression-param-restore": `  stopAllExpressions() {
    if (this._expressionManager == null) return;
    const values = this._expressionManager._expressionParameterValues;
    if (values) {
      for (let i = 0; i < values.getSize(); i++) {
        const p = values.at(i);
        if (p != null && p.parameterId != null) this._model.setParameterValueById(p.parameterId, p.overwriteValue, 1);
      }
    }
    this._expressionManager.stopAllMotions();
  }`,
	"preserve-drawing-buffer": `getContext("webgl2")`,
	"render-scale": `this._canvas.width = this._canvas.clientWidth * ${DPR_READ}, this._canvas.height = this._canvas.clientHeight * ${DPR_READ}, this._gl.viewport(0, 0, this._gl.drawingBufferWidth, this._gl.drawingBufferHeight);`,
	"load-failed-flag": `}).catch((e) => {
      F(` + "`Failed to load file ${this._modelHomeDir}.model3.json`" + `);
      this._loadFailed = !0;
    });`,
	"load-timeout-reject": `  waiting() {
    return new Promise((t, r) => {
      let n = 0;
      const e = () => {
        if (this._model.getLoadState()) t();
        else if (this._model._loadFailed) r(new Error("模型加载失败"));
        else if (++n > 6000) r(new Error("模型加载超时"));
        else setTimeout(e, 10);
      };
      e();
    });
  }`,
	"cubism-core-local": `const _a = () => {
  if (window.Live2DCubismCore) return Promise.resolve();
  return new Promise((r, rej) => {
    let done = !1;
    const ok = () => { if (!done) { done = !0; r(); } };
    const bad = (m) => { if (!done) { done = !0; rej(new Error(m)); } };
    const load = (src, next) => {
      const t = document.createElement("script");
      t.src = src, t.async = !0, t.onload = ok, t.onerror = next || (() => bad("Cubism Core 加载失败(本地与CDN均不可达)")), document.head.appendChild(t);
    };
    load(new URL("../live2dcubismcore.min.js", /* @vite-ignore */ import.meta.url).href, () => load("https://cubism.live2d.com/sdk-web/cubismcore/live2dcubismcore.min.js"));
    setTimeout(() => bad("Cubism Core 加载超时(8s)"), 8000);
  });
}`,
	"texture-cors-1": `a.ptr().img = new Image(), a.ptr().img.crossOrigin = "anonymous", a.ptr().img.addEventListener("load", () => i(a.ptr()), {
          passive: !0
        }), a.ptr().img.src = t;`,
	"texture-cors-2": `    const s = new Image();
    s.crossOrigin = "anonymous";
    s.addEventListener(`,
	"motion-param-reset": `    if (i == B.priorityForce) {
      this._motionManager.setReservePriority(i);
      // [patch] 强行动作前先清空所有动作并把参数复位到默认值,
      // 避免上一个动作(如 Bow)未覆盖的肢体参数残留叠加(手臂重叠)
      this._motionManager.stopAllMotions();
      if (this._model != null) {
        for (let p = 0; p < this._model.getParameterCount(); p++) this._model.setParameterValueByIndex(p, this._model.getParameterDefaultValue(p));
        this._model.saveParameters();
      }
    }`,
}

/**
 * 先查锚点, 再查哨兵, 最后查遗留形态:
 *   锚点在            → 打补丁                         (applied)
 *   哨兵在            → 幂等重跑, 已是新版产物          (already)
 *   遗留 NEW 形态在    → 迁移: 补上哨兵, 代码不变        (migrated)
 *   三者都不在         → 真失配, 失败并中断构建          (failed)
 * alternatives 用于同一补丁的历史锚点变体 (如渲染分辨率的"封顶 DPR=1"旧形态),
 * 任一命中即算成功。
 */
const patch = (name, token, alternatives) => {
	if (source.includes(M(token))) {
		already.push(name)
		console.log(`[patch-live2d] ${name} already-patched (skip)`)
		return "already"
	}
	for (const [oldStr, newStr, mode] of alternatives) {
		const r = mode === "all" ? applyAll(name, oldStr, newStr) : apply(name, oldStr, newStr)
		if (r === "applied") return "applied"
	}
	// 遗留产物迁移: 旧脚本已打过这个补丁, 只是没有哨兵
	const legacy = LEGACY[token]
	if (legacy && source.includes(legacy)) {
		const newStr = alternatives[0][1]
		const mode = alternatives[0][2]
		if (mode === "all") source = source.split(legacy).join(newStr)
		else source = source.replace(legacy, newStr)
		changed = true
		migrated.push(name)
		console.log(`[patch-live2d] ${name} migrated (遗留产物补哨兵, 代码未变)`)
		return "migrated"
	}
	failures.push(name)
	console.error(`[patch-live2d] ${name} FAILED —— 锚点/哨兵/遗留形态均未命中 (库很可能已升版)`)
	return "failed"
}

/* ---- 渲染帧率上限 (60fps) ----
 * 库的渲染循环是裸 requestAnimationFrame, 屏幕给多少就跑多少 (120Hz 屏 = 常驻 120fps
 * 全屏 WebGL, 耗电/发热主因之一)。这里把"更新+绘制"换成优先调用 App 侧注入的
 * window.__noriL2dTick (带时间戳门控的节流版), 保留 rAF 以对齐 vsync。
 *
 * 兜底: 助手不存在时退回原行为 (不会黑屏) —— 因此即使 App 侧模块未加载也只是"没节流"。
 * 助手实现见 src/services/live2d/index.ts 的 installFrameCap()。
 * 该循环在库里唯一 (全库 requestAnimationFrame 只出现 1 次), 故 mode 用 one。 */
const L2D_LOOP_OLD = `this._isShow && (ht.updateTime(), this.update(), requestAnimationFrame(t));`
const L2D_LOOP_NEW = `this._isShow && (window.__noriL2dTick ? window.__noriL2dTick(ht, this) : (ht.updateTime(), this.update()), ${M("l2d-fps-cap")} requestAnimationFrame(t));`

patch("多表情叠加", "expression-stacking", [[CLEANUP_OLD, CLEANUP_NEW, "one"]])
patch("表情参数还原", "expression-param-restore", [[STOP_OLD, STOP_NEW, "one"]])
patch("preserveDrawingBuffer", "preserve-drawing-buffer", [[GL_OLD, GL_NEW, "all"]])
// 同一补丁的两个历史锚点形态 (原始 / 已打过"封顶 DPR=1"旧补丁), 共用 render-scale 哨兵
patch("背缓冲DPR封顶", "render-scale", [[RESIZE_DPR_OLD, RESIZE_DPR_NEW, "one"]])
patch("渲染分辨率开关", "render-scale", [[RESIZE_DPR_OLD_PATCHED, RESIZE_DPR_NEW, "one"]])
patch("加载失败标记", "load-failed-flag", [[LOAD_ASSETS_OLD, LOAD_ASSETS_NEW, "one"]])
// 注意: waiting() 在库里有**两份**实现 (两个模型类), 必须都补 —— 只补第一处会让另一条
// 加载路径保留"永久挂起"的老行为。历史产物里 0 处残留, 故用 all 模式保持等价。
patch("加载超时reject", "load-timeout-reject", [[WAITING_OLD, WAITING_NEW, "all"]])
patch("Core本地化加载", "cubism-core-local", [[CORE_OLD, CORE_NEW, "one"]])
patch("纹理CORS1", "texture-cors-1", [[TEX_IMG_OLD, TEX_IMG_NEW, "one"]])
patch("纹理CORS2", "texture-cors-2", [[TEX_NEW_OLD, TEX_NEW_NEW, "one"]])
// 强行动作前重置模型参数, 消除跨动作的肢体残留(手臂重叠)
patch("动作前参数复位", "motion-param-reset", [[MOTION_RESET_OLD, MOTION_RESET_NEW, "one"]])
// 渲染帧率上限 60fps (120Hz 屏省一半; 60Hz 屏无变化)。助手缺失时自动退回原行为。
patch("渲染帧率上限", "l2d-fps-cap", [[L2D_LOOP_OLD, L2D_LOOP_NEW, "one"]])

// 规范化注入点: 历史补丁可能在 saveParameters 前堆叠多份 (ModelCanvas/GAZE/旧钩子),
// 无论堆了几份, 一律收敛为唯一一份规范版 (ModelCanvas + GAZE + 新钩子)。
// 规范版本身即哨兵, 因此不额外插标记 (避免破坏 HIT_TEST_API 模板上下文)。
// 注意顺序: 必须**先**确保注入点存在 (全新安装时 __noriModelCanvas 还不存在, 由下面的
// "模型尺寸暴露"补丁注入), 再做规范化收敛 —— 反过来会在全新安装的库上误报锚点失配。
const MODEL_INFO_ANCHOR = `this._model.saveParameters(), this._modelMatrix = new qi(`
// 注意: 规范版**必须**以锚点收尾。原先漏了这一段, 于是"全新安装"路径把锚点替换掉后
// 只剩孤儿 `this._model.getCanvasWidth(), this._model.getCanvasHeight() );` —— 产物是
// 语法错误 (vite/rollup 报 "Expression expected"), 且脚本自身判定为成功、静默通过。
// 存量 node_modules 已是规范版, 走的是上面的 canonical 分支, 所以这个坑一直没暴露,
// 只在干净安装/重装依赖时才踩到。MODEL_INFO_NEW 里本来就有这个后缀 (可作为对照)。
const MODEL_INFO_CANON = `window.__noriModelCanvas = { w: this._model.getCanvasWidth(), h: this._model.getCanvasHeight() }; ${GAZE_API}${HIT_TEST_API}${MODEL_INFO_ANCHOR}`
let normState = "skipped" // canonical | applied | failed

if (source.includes(MODEL_INFO_CANON)) {
	// 已是规范版: 无需改动
	normState = "canonical"
	already.push("触摸注入点规范化")
	console.log(`[patch-live2d] 注入点规范化 already-patched (已是规范版)`)
} else if (source.includes(MODEL_INFO_ANCHOR)) {
	// 先把注入点补上 (原始形态 → 规范形态, 含 GAZE/HitTest), 再统一收敛
	source = source.replace(MODEL_INFO_ANCHOR, MODEL_INFO_CANON)
	changed = true
	normState = "applied"
	applied.push("触摸注入点规范化")
	console.log(`[patch-live2d] 注入点规范化 applied (+${MODEL_INFO_CANON.length - MODEL_INFO_ANCHOR.length} 字符, 含 GAZE/HitTest 钩子)`)
	// 清理历史上堆叠的多份注入 (旧副本) → 只留第一份规范版。
	// 只在**确实多于一份**时才裁剪: 全新安装替换后只有一份, 此时任何裁剪都会把规范版
	// 自带的尾部锚点复制成两份 → 语法错误 (旧实现正是在这里出事)。
	// 裁剪方式: 删掉后续副本的"注入体", 保留其后的锚点 (锚点是原代码, 必须留)。
	for (let guard = 0; guard < 8; guard += 1) {
		const first = source.indexOf("window.__noriModelCanvas")
		const second = source.indexOf("window.__noriModelCanvas", first + 1)
		if (first < 0 || second < 0) break
		const anchorAfter = source.indexOf(MODEL_INFO_ANCHOR, second)
		if (anchorAfter < 0) break
		source = source.slice(0, second) + source.slice(anchorAfter)
		console.log(`[patch-live2d] 注入点规范化 去重 (移除一份堆叠副本)`)
	}
} else {
	normState = "failed"
	failures.push("触摸注入点规范化")
	console.error(`[patch-live2d] 触摸注入点规范化 FAILED —— 找不到 saveParameters/getCanvasWidth 注入点 (锚点失配)`)
}

/* ---- Phase 3a: 部位几何探针 ----
 * 必须放在**注入点规范化之后**: 它的锚点 (`window.__noriHitTest = ...`) 是规范版里才存在的,
 * 全新安装时先由上面的规范化补上, 这里才锚得到。 */
patch("部位几何探针", "part-bounds-probe", [[PART_PROBE_ANCHOR, PART_PROBE_API + PART_PROBE_ANCHOR, "one"]])
patch("参数相加/读回", "param-add-get", [[PART_PROBE_ANCHOR, PARAM_API + PART_PROBE_ANCHOR, "one"]])
patch("参数注入点(顶点前)", "param-inject", [[PARAM_INJECT_OLD, PARAM_INJECT_NEW, "one"]])

/* ---------------- 写入 + 自检 ---------------- */
if (changed) {
	// 产物版本标记: 下次运行据此判断"是本脚本哪一版打的", 防止旧哨兵让新补丁被误判成已打过
	if (!source.includes(VERSION_MARK)) source = VERSION_MARK + "\n" + source
	writeFileSync(TARGET, source)
}

// 自检: 只要本轮没有失败, 所有哨兵都必须存在于产物中 (防"判定成功但产物没打上")
if (!failures.length) {
	for (const [name, token] of [
		["多表情叠加", "expression-stacking"],
		["表情参数还原", "expression-param-restore"],
		["preserveDrawingBuffer", "preserve-drawing-buffer"],
		["渲染分辨率", "render-scale"],
		["加载失败标记", "load-failed-flag"],
		["加载超时reject", "load-timeout-reject"],
		["Core本地化加载", "cubism-core-local"],
		["纹理CORS1", "texture-cors-1"],
		["纹理CORS2", "texture-cors-2"],
		["动作前参数复位", "motion-param-reset"],
		["渲染帧率上限", "l2d-fps-cap"],
		["部位几何探针", "part-bounds-probe"],
		["参数相加/读回", "param-add-get"],
		["参数注入点(顶点前)", "param-inject"],
	]) {
		if (!source.includes(M(token))) failures.push(`${name}(自检: 哨兵缺失)`)
	}
}

/* ---------------- 汇总 ---------------- */
console.log(`[patch-live2d] 本轮: 新打 ${applied.length} / 迁移 ${migrated.length} / 已打过 ${already.length} / 失败 ${failures.length}`)
if (changed) console.log(`[patch-live2d] 已写回 ${TARGET}`)
else console.log(`[patch-live2d] 无需写回 (产物已是最新)`)

if (failures.length) {
	console.error("")
	console.error(`[patch-live2d] ✗ ${failures.length} 个补丁未能应用: ${failures.join(", ")}`)
	console.error(`[patch-live2d] 这些补丁各自对应一个已修复的行为, 静默跳过会让它在线下复活。`)
	console.error(`[patch-live2d] 请对照 live2d-easy-control 当前版本更新本脚本的锚点字符串后重试。`)
	process.exit(1)
}
