/* 悬浮窗对话框**初始落点** —— 在 JVM 上真跑 Kotlin 纯函数 placeBubble() 的单测。
 *
 * 为什么不在浏览器里测: 对话框是独立 Activity 窗口, 落点在原生侧 (FloatBubbleActivity.onCreate,
 * 用 WindowManager.LayoutParams 的**物理像素**坐标), 浏览器 (harness) 里拿不到 ——
 * 所以把"算数"抽成纯函数 app/android/.../BubblePlacement.kt, 这里编译一个 Java 驱动直接调它。
 * 浏览器那半边 (喂进来的模型几何是不是物理像素、缩放后还准不准) 由 e2e-float.mjs 验。
 *
 * 依赖: 先 `cd app/android && gradlew compileReleaseKotlin`
 *       (产物 app/build/tmp/kotlin-classes/release/com/noridroid/BubblePlacementKt.class)
 *       再加一个 JDK (取 JAVA_HOME; 本项目 21)。
 * 运行: cd web-src && node tmp-memcheck/probe-bubble-place.mjs
 */
import {closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from "node:fs"
import {spawnSync} from "node:child_process"
import {tmpdir} from "node:os"
import {delimiter, join, resolve} from "node:path"

const HERE = import.meta.dirname
const ANDROID = resolve(HERE, "../..")           // app/android
const KOTLIN_CLASSES_ROOT = join(ANDROID, "app/build/tmp/kotlin-classes")

const JAVA_HOME = process.env.JAVA_HOME || ""
const exe = (n) => (process.platform === "win32" ? `${n}.exe` : n)
const javacBin = JAVA_HOME ? join(JAVA_HOME, "bin", exe("javac")) : "javac"
const javaBin = JAVA_HOME ? join(JAVA_HOME, "bin", exe("java")) : "java"
const javapBin = JAVA_HOME ? join(JAVA_HOME, "bin", exe("javap")) : "javap"

const tmp = mkdtempSync(join(tmpdir(), "nori-bubble-place-"))
let runSeq = 0

/** 跑外部命令并把 stdout/stderr 落文件再读 (不用管道: 受限环境下管道可能被挡) */
const run = (cmd, args, cwd) => {
	const logFile = join(tmp, `run-${++runSeq}.log`)
	const fd = openSync(logFile, "w")
	const r = spawnSync(cmd, args, {cwd, stdio: ["ignore", fd, fd], windowsHide: true})
	closeSync(fd)
	return {status: r.status, out: readFileSync(logFile, "utf8")}
}

/** 找编译产物目录 (含 com/noridroid/BubblePlacementKt.class 的那一层 build variant) */
const findKotlinClasses = () => {
	if (!existsSync(KOTLIN_CLASSES_ROOT)) return ""
	for (const v of readdirSync(KOTLIN_CLASSES_ROOT)) {
		const dir = join(KOTLIN_CLASSES_ROOT, v)
		if (existsSync(join(dir, "com/noridroid/BubblePlacementKt.class"))) return dir
	}
	return ""
}

/** 找 kotlin-stdlib jar (纯函数只用 Int/Boolean, 大概率不需要; 有就加上, 免得编译器挑刺) */
const findStdlib = () => {
	const base = join(process.env.USERPROFILE || process.env.HOME || "", ".gradle/caches/modules-2/files-2.1/org.jetbrains.kotlin/kotlin-stdlib")
	if (!existsSync(base)) return ""
	const jars = []
	const walk = (d) => {
		for (const e of readdirSync(d)) {
			const p = join(d, e)
			if (statSync(p).isDirectory()) walk(p)
			else if (/^kotlin-stdlib-.*\.jar$/.test(e)) jars.push(p)
		}
	}
	walk(base)
	if (!jars.length) return ""
	// 优先与项目 Kotlin 版本一致 (app/android/build.gradle: 1.9.22)
	return jars.find((j) => j.includes("kotlin-stdlib-1.9.22.jar")) || jars[jars.length - 1]
}

/* ---------------- Java 驱动 (表驱动: 每组输入 → 断言「不压模型 + 留在屏幕内」) ---------------- */
const DRIVER = String.raw`
import com.noridroid.BubbleLayout;
import com.noridroid.BubblePlacementKt;

public class PlaceProbe {
    static int pass = 0, fail = 0;

    static void check(String name, boolean ok, String detail) {
        if (ok) { pass++; System.out.println("PASS  " + name); }
        else { fail++; System.out.println("FAIL  " + name + "  <- " + detail); }
    }

    /** 与模型矩形是否重叠: 对话框在模型下方 (y >= 模型底) 或在悬浮窗上方 (y+h <= 悬浮窗顶) */
    static boolean noOverlap(int y, int h, int floatY, int modelBottom) {
        return y >= floatY + modelBottom || y + h <= floatY;
    }

    static boolean inside(int y, int h, int top, int bottom) {
        return y >= top && y + h <= bottom;
    }

    public static void main(String[] args) {
        // 屏幕可用区 (典型 1080p 手机, 已排除状态栏/导航栏; 物理像素)
        final int SX = 0, SY = 80, SR = 1080, SB = 2300;
        BubbleLayout L;
        String tag;

        // ① 典型: 悬浮窗 260x340 @ (80,200), 页面按**物理像素**上报模型底边 = 窗底(340)
        L = BubblePlacementKt.placeBubble(80, 200, 260, 340, 340, 260, SX, SY, SR, SB);
        tag = "y=" + L.getY() + " h=" + L.getH() + " safeTop=" + L.getSafeTop() + " belowModel=" + L.getBelowModel();
        check("① 模型下方 8px: y == 模型底(200+340) + 8 = 548", L.getY() == 548, tag);
        check("① 不压模型 (对话框顶边 >= 模型底边)", noOverlap(L.getY(), L.getH(), 200, 340), tag);
        check("① 输入行在悬浮窗底边之下 (y+h >= 浮窗底+64)", L.getY() + L.getH() >= 200 + 340 + 64, tag);
        check("① 完整留在屏幕可用区内", inside(L.getY(), L.getH(), SY, SB), tag);
        check("① belowModel 标记为真 (供日志/实机核对)", L.getBelowModel(), tag);
        check("① 宽度居中于悬浮窗 (80 + (260-260)/2 = 80)", L.getX() == 80, "x=" + L.getX());

        // ② 模型矩形比窗口小 (留白 120): 仍不重叠, 留白算进回复区高度
        L = BubblePlacementKt.placeBubble(80, 200, 260, 340, 220, 260, SX, SY, SR, SB);
        tag = "y=" + L.getY() + " h=" + L.getH() + " safeTop=" + L.getSafeTop();
        check("② 模型底 220 → y = 200+220+8 = 428", L.getY() == 428, tag);
        check("② safeTop = 窗内留白 340-220 = 120", L.getSafeTop() == 120, tag);
        check("② 高度 = 留白120 + 8 + 输入行56 + 回复区300 = 484", L.getH() == 484, tag);
        check("② 不压模型", noOverlap(L.getY(), L.getH(), 200, 220), tag);

        // ③ 缩放变小 (捏合缩小悬浮窗): 160x200, 模型底 = 窗底
        L = BubblePlacementKt.placeBubble(80, 200, 160, 200, 200, 160, SX, SY, SR, SB);
        tag = "y=" + L.getY() + " h=" + L.getH();
        check("③ 缩小后 y = 200+200+8 = 408", L.getY() == 408, tag);
        check("③ 缩小后不压模型", noOverlap(L.getY(), L.getH(), 200, 200), tag);

        // ④ 缩放变大: 600x900, 模型底 = 窗底
        L = BubblePlacementKt.placeBubble(100, 150, 600, 900, 900, 600, SX, SY, SR, SB);
        tag = "y=" + L.getY() + " h=" + L.getH();
        check("④ 放大后 y = 150+900+8 = 1058", L.getY() == 1058, tag);
        check("④ 放大后不压模型且在屏幕内", noOverlap(L.getY(), L.getH(), 150, 900) && inside(L.getY(), L.getH(), SY, SB), tag);

        // ⑤ 模型底未知 (-1): 退化成「悬浮窗底边下方」, 同样不重叠
        L = BubblePlacementKt.placeBubble(80, 200, 260, 340, -1, 260, SX, SY, SR, SB);
        tag = "y=" + L.getY() + " h=" + L.getH();
        check("⑤ 未知时 = 浮窗底 200+340 + 8 = 548", L.getY() == 548, tag);
        check("⑤ 未知时不压模型/不压浮窗", L.getY() >= 200 + 340, tag);

        // ⑥ 上报值比窗高还大 (模型画到窗外): 仍取「上报底边之下」, 保守不重叠
        L = BubblePlacementKt.placeBubble(80, 200, 260, 340, 500, 260, SX, SY, SR, SB);
        tag = "y=" + L.getY();
        check("⑥ 底边 500 → y = 200+500+8 = 708", L.getY() == 708, tag);
        check("⑥ 不压模型", noOverlap(L.getY(), L.getH(), 200, 500), tag);

        // ⑦ 屏幕放不下 (悬浮窗贴屏底, 屏高 800): 退到悬浮窗**上方**, 仍不与模型重叠
        L = BubblePlacementKt.placeBubble(80, 700, 260, 340, 340, 260, 0, 0, 1080, 800);
        tag = "y=" + L.getY() + " h=" + L.getH() + " belowModel=" + L.getBelowModel();
        check("⑦ 下方放不下 → 挪到悬浮窗上方 (y+h == 700-8)", L.getY() + L.getH() == 700 - 8, tag);
        check("⑦ 上方同样不压模型", noOverlap(L.getY(), L.getH(), 700, 340), tag);
        check("⑦ 高度没被压缩 (完整 364)", L.getH() == 364, tag);
        check("⑦ 完整留在屏幕内", inside(L.getY(), L.getH(), 0, 800), tag);
        check("⑦ belowModel=false (如实记录: 这条路径是「上方」)", !L.getBelowModel(), tag);

        // ⑧ 上下都塞不下 (300px 高的极端屏 + 悬浮窗贴顶): 只能钳进屏幕, 但保住输入行
        L = BubblePlacementKt.placeBubble(0, 20, 100, 150, 150, 100, 0, 0, 1080, 300);
        tag = "y=" + L.getY() + " h=" + L.getH();
        check("⑧ 极端屏: 完整留在屏幕内 (y+h <= 300)", inside(L.getY(), L.getH(), 0, 300), tag);
        check("⑧ 极端屏: 高度 = 下限 8+56+160 = 224 (输入行放得下)", L.getH() == 224, tag);

        // ⑨ 悬浮窗被拖到屏幕上方 (FLAG_LAYOUT_NO_LIMITS 允许): 地板线不能把框放到屏幕外
        L = BubblePlacementKt.placeBubble(80, -300, 260, 340, 340, 260, SX, SY, SR, SB);
        tag = "y=" + L.getY() + " h=" + L.getH();
        check("⑨ 悬浮窗在屏幕上方: 框被顶到可用区上沿 (y == 80) 而不是 y=48", L.getY() == SY, tag);
        check("⑨ 仍在模型底边(屏幕坐标 40)之下", L.getY() >= -300 + 340, tag);
        check("⑨ 完整留在屏幕可用区内", inside(L.getY(), L.getH(), SY, SB), tag);

        // ⑩ 反证 (防断言空转): 老公式 + 漏乘 dpr 的上报值 → 落点确实压在模型上
        int dprX100 = 275;                                  // dpr = 2.75 (用户那台)
        int feetCss = Math.round(340 * 100f / dprX100);     // 老代码上报的是 CSS 像素 ~124
        int oldSafeTop = Math.min(240, Math.max(0, 340 - feetCss));
        int oldTotalH = oldSafeTop + 8 + 56 + 300;
        int oldPy = Math.max(200 + feetCss + 8, 200 + 340 + 64 - oldTotalH);
        check("⑩ 反证: 老公式的落点(y=" + oldPy + ")确实压在模型里(模型底=540)",
              !noOverlap(oldPy, oldTotalH, 200, 340), "oldPy=" + oldPy);

        System.out.println("SUMMARY " + pass + "/" + (pass + fail));
        System.exit(fail > 0 ? 1 : 0);
    }
}
`

let bad = 0
const TOTAL = 4
const result = (name, ok, detail = "") => {
	if (ok) console.log(`PASS  ${name}`)
	else { bad++; console.log(`FAIL  ${name}${detail ? `  <- ${detail}` : ""}`) }
}

console.log("== probe-bubble-place: 在 JVM 上真跑 Kotlin 纯函数 placeBubble ==")

const classes = findKotlinClasses()
if (!classes) {
	console.log(`FAIL  找不到编译产物 (${KOTLIN_CLASSES_ROOT}/*/com/noridroid/BubblePlacementKt.class)`)
	console.log("      先跑: cd app/android && gradlew compileReleaseKotlin")
	process.exit(1)
}
console.log(`   Kotlin 产物: ${classes}`)
result("① 编译产物里有 BubblePlacementKt (纯函数已随包编译)", true)

const stdlib = findStdlib()
console.log(`   kotlin-stdlib: ${stdlib || "(未找到, 试无 stdlib 运行)"}`)
console.log(`   JDK: ${JAVA_HOME || "(取 PATH)"}`)

const cp = [classes, stdlib].filter(Boolean).join(delimiter)
const srcDir = join(tmp, "src")
const outDir = join(tmp, "out")
mkdirSync(srcDir, {recursive: true})
mkdirSync(outDir, {recursive: true})
writeFileSync(join(srcDir, "PlaceProbe.java"), DRIVER, "utf8")

const jc = run(javacBin, ["-encoding", "UTF-8", "-cp", cp, "-d", outDir, join(srcDir, "PlaceProbe.java")])
result("② 驱动编译通过 (javac 能直接调 Kotlin 顶层函数)", jc.status === 0, jc.out.split("\n").slice(0, 4).join(" | "))
if (jc.status !== 0) {
	console.log(jc.out)
	rmSync(tmp, {recursive: true, force: true})
	process.exit(1)
}

const jr = run(javaBin, ["-Dstdout.encoding=UTF-8", "-Dfile.encoding=UTF-8", "-cp", [outDir, cp].join(delimiter), "PlaceProbe"])
console.log("---- placeBubble 实测输出 ----")
console.log(jr.out.trimEnd())
console.log("------------------------------")
const m = jr.out.match(/SUMMARY (\d+)\/(\d+)/)
result(`③ 落点用例全部通过${m ? ` (${m[1]}/${m[2]})` : ""}`, jr.status === 0 && !!m, m ? m[0] : `java 退出码 ${jr.status}`)

// ④ 纯函数真的被 Activity 调用 —— 看**字节码**而不是源码文本 (防止「写了但没接上」)
const jp = run(javapBin, ["-c", "-p", "-cp", classes, "com.noridroid.FloatBubbleActivity"])
const called = jp.status === 0 && /BubblePlacementKt\.placeBubble/.test(jp.out)
result("④ FloatBubbleActivity 字节码里真的 invokestatic BubblePlacementKt.placeBubble", called,
	jp.status === 0 ? "javap 输出里没有该调用" : `javap 退出码 ${jp.status}`)

rmSync(tmp, {recursive: true, force: true})

console.log(`\n${TOTAL - bad}/${TOTAL} passed`)
if (bad > 0) process.exitCode = 1
