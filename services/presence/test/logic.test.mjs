/* 在线人数计数服务的纯逻辑单测（node --test，无需 wrangler / workerd） */

import test from "node:test"
import assert from "node:assert/strict"
import {
	DAY_KEEP_DAYS,
	IDLE_THROTTLE_MS,
	WINDOW_MS,
	createRateLimiter,
	dayCutoff,
	dayKey,
	isValidId,
	isValidVersion,
	normalizeCount,
	onlineCutoff,
	shouldCount,
} from "../src/logic.mjs"

test("isValidId: 16~64 位字母数字下划线连字符", () => {
	assert.equal(isValidId("a".repeat(16)), true)
	assert.equal(isValidId("a".repeat(64)), true)
	assert.equal(isValidId("a".repeat(15)), false)
	assert.equal(isValidId("a".repeat(65)), false)
	assert.equal(isValidId("0123456789abcdef0123456789abcdef"), true)
	assert.equal(isValidId("has space in the id"), false)
	assert.equal(isValidId("中文标识符中文标识符中文标识符"), false)
	assert.equal(isValidId(null), false)
	assert.equal(isValidId(123), false)
})

test("isValidVersion: 非空、<=32 字符、不含换行", () => {
	assert.equal(isValidVersion("2.5.0"), true)
	assert.equal(isValidVersion(""), false)
	assert.equal(isValidVersion("x".repeat(32)), true)
	assert.equal(isValidVersion("x".repeat(33)), false)
	assert.equal(isValidVersion("2.5\n0"), false)
	assert.equal(isValidVersion(undefined), false)
})

test("dayKey：按北京时间（UTC+8）切日 / dayCutoff / onlineCutoff", () => {
	const now = Date.UTC(2026, 9, 21, 23, 30, 0) // 2026-10-21T23:30Z → 北京 10-22 07:30
	assert.equal(dayKey(now), "2026-10-22")
	assert.equal(onlineCutoff(now), now - WINDOW_MS)
	assert.equal(dayCutoff(now), dayKey(now - DAY_KEEP_DAYS * 86400000))
	// 北京 00:00 边界：UTC 16:00 整
	const midnight = Date.UTC(2026, 9, 21, 16, 0, 0) // 北京 2026-10-22 00:00
	assert.equal(dayKey(midnight - 1), "2026-10-21", "北京 23:59:59.999 仍算前一天")
	assert.equal(dayKey(midnight), "2026-10-22", "北京 00:00 起算新一天")
})

test("shouldCount: 同 ID 30 秒内重复不写库", () => {
	const now = 1_000_000_000_000
	assert.equal(shouldCount(null, now), true)
	assert.equal(shouldCount(now - 1, now), false)
	assert.equal(shouldCount(now - IDLE_THROTTLE_MS, now), true)
	assert.equal(shouldCount(now - IDLE_THROTTLE_MS + 1, now), false)
})

test("normalizeCount: 脏数据收敛成非负整数", () => {
	assert.equal(normalizeCount(12), 12)
	assert.equal(normalizeCount(12.9), 12)
	assert.equal(normalizeCount(-5), 0)
	assert.equal(normalizeCount(NaN), 0)
	assert.equal(normalizeCount(Infinity), 0)
	assert.equal(normalizeCount("7"), 7)
})

test("RateLimiter: 窗口内超过上限拒绝，窗口滑动后恢复", () => {
	const rl = createRateLimiter({limit: 3, windowMs: 60_000})
	const t0 = 10_000
	assert.equal(rl.allow("ip", t0), true)
	assert.equal(rl.allow("ip", t0 + 1), true)
	assert.equal(rl.allow("ip", t0 + 2), true)
	assert.equal(rl.allow("ip", t0 + 3), false, "第 4 次应被拒绝")
	assert.equal(rl.allow("other", t0 + 3), true, "不同 IP 互不影响")
	assert.equal(rl.allow("ip", t0 + 60_001), true, "滑出窗口后恢复")
})

test("RateLimiter.prune 清掉过期条目", () => {
	const rl = createRateLimiter({limit: 2, windowMs: 1000})
	rl.allow("a", 0)
	rl.allow("b", 0)
	assert.equal(rl.size(), 2)
	rl.prune(5000)
	assert.equal(rl.size(), 0)
})
