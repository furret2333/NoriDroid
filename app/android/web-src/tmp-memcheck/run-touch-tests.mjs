// 触摸检测与旧配置迁移的行为回归；内存打包，不改已有测试产物。
import assert from "node:assert/strict"
import {readdirSync} from "node:fs"
import {pathToFileURL} from "node:url"
import path from "node:path"

const root = path.resolve(import.meta.dirname, "..")
const dir = readdirSync(path.join(root, "node_modules/.pnpm")).find(d => d.startsWith("esbuild@"))
const {build} = await import(pathToFileURL(path.join(root, "node_modules/.pnpm", dir, "node_modules/esbuild/lib/main.js")).href)
const moduleOf = async file => {
	const result = await build({entryPoints: [path.join(root, file)], bundle: true, write: false, platform: "node", format: "esm", logLevel: "silent"})
	return import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`)
}
const {TouchDetector, toModelPoint} = await moduleOf("src/services/live2d/touchDetection.ts")
const {loadTouchConfig, saveTouchConfig} = await moduleOf("src/services/live2d/touch.ts")
let count = 0
const test = (name, fn) => { fn(); count++; console.log(`PASS ${name}`) }
const rect = {left: 20, top: 30, width: 200, height: 300, right: 220, bottom: 330}
const canvas = {getBoundingClientRect: () => rect}
const area = {id: "a", name: "脸颊", type: "tap", x: .1, y: .1, w: .8, h: .8, image: "", prompt: "", gesture: "both"}
let now = 0, calls = [], accept = true
const oldNow = Date.now
Date.now = () => now
const detector = new TouchDetector((a, type) => { calls.push({id: a.id, type}); return accept })
const reset = (areas = [area]) => { detector.destroy(); detector.setPreview(false); detector.configure(areas, canvas); detector.setCooldown(10000); calls = []; accept = true; now = 0 }
const event = (x = 100, y = 150, pointerId = 1, type = "pointerup") => ({clientX: x, clientY: y, pointerId, type})
const tap = () => { detector.onPointerDown(event()); detector.onPointerUp(event()) }

try {
	test("第一次触摸在时钟零点也可触发，抬手前不触发", () => { reset(); detector.onPointerDown(event()); assert.equal(calls.length, 0); detector.onPointerUp(event()); assert.deepEqual(calls, [{id: "a", type: "tap"}]) })
	test("长滑动只在松手时触发一次", () => { reset(); detector.onPointerDown(event()); detector.onPointerMove(event(140)); now = 2000; detector.onPointerMove(event(100)); assert.equal(calls.length, 0); detector.onPointerUp(event()); detector.onPointerUp(event()); assert.deepEqual(calls, [{id: "a", type: "swipe"}]) })
	test("未收到 move 时仍计入抬手位置差", () => { reset(); detector.onPointerDown(event()); detector.onPointerUp(event(130)); assert.equal(calls[0].type, "swipe") })
	test("只点按区域忽略滑动", () => { reset([{...area, gesture: "tap"}]); detector.onPointerDown(event()); detector.onPointerUp(event(140)); assert.equal(calls.length, 0) })
	test("只滑动区域忽略点按", () => { reset([{...area, gesture: "swipe"}]); tap(); assert.equal(calls.length, 0) })
	test("缺少 gesture 的旧区域仍接受点按和滑动", () => { reset([{...area, gesture: undefined, type: "frenzy"}]); tap(); assert.equal(calls.length, 1) })
	test("取消手势不会触发", () => { reset(); detector.onPointerDown(event()); detector.cancel(); detector.onPointerUp(event()); assert.equal(calls.length, 0) })
	test("pointercancel 不会触发", () => { reset(); detector.onPointerDown(event()); detector.onPointerUp(event(100, 150, 1, "pointercancel")); assert.equal(calls.length, 0) })
	test("捕获丢失不会触发", () => { reset(); detector.onPointerDown(event()); detector.onPointerUp(event(100, 150, 1, "lostpointercapture")); assert.equal(calls.length, 0) })
	test("另一个指针不能完成手势", () => { reset(); detector.onPointerDown(event()); detector.onPointerMove(event(160, 150, 2)); detector.onPointerUp(event(100, 150, 2)); assert.equal(calls.length, 0); detector.onPointerUp(event()); assert.equal(calls[0].type, "tap") })
	test("在区域外松手不触发", () => { reset(); detector.onPointerDown(event()); detector.onPointerUp(event(219, 329)); assert.equal(calls.length, 0) })
	test("10 秒冷却边界正确", () => { reset(); tap(); assert.equal(detector.getCooldownRemaining("a"), 10000); now = 9999; tap(); assert.equal(calls.length, 1); now = 10000; tap(); assert.equal(calls.length, 2) })
	test("冷却按区域独立记录", () => { reset([area, {...area, id: "b"}]); detector.trigger(area, "tap"); assert.equal(detector.getCooldownRemaining("b"), 0) })
	test("忙碌等被拒绝的触发不消费冷却", () => { reset(); accept = false; tap(); assert.equal(detector.getCooldownRemaining("a"), 0); accept = true; tap(); assert.equal(calls.length, 2) })
	test("命中预览跳过冷却而且不延长冷却", () => { reset(); tap(); now = 1000; detector.setPreview(true); tap(); tap(); assert.equal(calls.length, 3); assert.equal(detector.getCooldownRemaining("a"), 9000) })
	test("预览模式切换取消未完成手势", () => { reset(); detector.onPointerDown(event()); detector.setPreview(true); detector.onPointerUp(event()); assert.equal(calls.length, 0) })
	test("预览仍报告不符合触发方式的命中，供界面说明", () => { reset([{...area, gesture: "swipe"}]); detector.setPreview(true); tap(); assert.equal(calls[0].type, "tap"); assert.equal(detector.getCooldownRemaining("a"), 0) })
	test("重配区域取消旧手势", () => { reset(); detector.onPointerDown(event()); detector.configure([], canvas); detector.onPointerUp(event()); assert.equal(calls.length, 0) })
	test("重叠区域优先选择后添加的区域", () => { reset([area, {...area, id: "b"}]); assert.equal(detector.hitTest(100, 150).id, "b"); assert.equal(calls.length, 0) })
	test("CSS 变换后的画布使用实际可见矩形", () => { assert.deepEqual(toModelPoint(120, 180, canvas, 0, 0), {x: .5, y: .5}) })
	test("容器外不命中", () => { reset(); assert.equal(detector.hitTest(0, 0), null) })

	const storage = new Map()
	globalThis.localStorage = {getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value)}
	test("旧区域几何、描述与类型无损迁移，不把描述当反应指令", () => {
		const old = {...area, type: "swipe", prompt: "头顶那撮头发"}; delete old.gesture
		storage.set("l2d_touch_old", JSON.stringify({version: 1, touches: [old]}))
		const loaded = loadTouchConfig("old")
		assert.equal(loaded.enabled, true); assert.equal(loaded.touches[0].gesture, "both")
		assert.equal(loaded.touches[0].prompt, old.prompt); assert.equal(loaded.touches[0].reactionPrompt, "")
		for (const key of ["x", "y", "w", "h", "type", "id"]) assert.equal(loaded.touches[0][key], old[key])
	})
	test("按模型隔离区域与启用开关", () => { const config = loadTouchConfig("old"); config.enabled = false; assert.equal(saveTouchConfig("other", config), true); assert.equal(loadTouchConfig("other").enabled, false); assert.equal(loadTouchConfig("old").enabled, true) })
	test("新手势和反应要求保存后保留", () => { const config = loadTouchConfig("new"); config.touches = [{...area, gesture: "swipe", reactionPrompt: "有点痒"}]; saveTouchConfig("new", config); assert.equal(loadTouchConfig("new").touches[0].reactionPrompt, "有点痒"); assert.equal(loadTouchConfig("new").touches[0].gesture, "swipe") })
	test("损坏条目不阻断合法旧区域", () => { storage.set("l2d_touch_bad", JSON.stringify({touches: [null, {id: "bad"}, area]})); assert.equal(loadTouchConfig("bad").touches.length, 1) })
	test("损坏 JSON 回落到空配置", () => { storage.set("l2d_touch_bad", "{"); assert.equal(loadTouchConfig("bad").touches.length, 0) })
	test("存储写失败明确返回 false", () => { globalThis.localStorage.setItem = () => { throw new Error("quota") }; assert.equal(saveTouchConfig("new", loadTouchConfig("new")), false) })
	console.log(`\n${count} touch tests passed`)
} finally { Date.now = oldNow }
