/**
 * NoriDroid 在线人数 · 匿名心跳计数（Cloudflare Worker + Durable Object）
 *
 * 设计口径见仓库 `docs/在线人数-实现与部署-20261021.md`：
 *   - 客户端每 5 分钟发一次 {id, v, p}；id 是随机安装 ID，不含设备标识；
 *   - 服务端只做去重计数（10 分钟窗口），ID 先 SHA-256 再存；
 *   - IP 只在内存里做限流（60s 窗口），不落库、不打日志；
 *   - 单实例 DO 串行化，避免并发计数漂移；alarm 每分钟清理过期行。
 *
 * 路由：
 *   POST /v1/heartbeat  {id, v, p} → {ok, online, today, ts}
 *   GET  /v1/online               → {ok, online, today, ts}   （官网徽章用）
 *   GET  /healthz                 → {ok:true}
 */

import {DurableObject} from "cloudflare:workers"
import {
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
} from "./logic.mjs"

const CORS = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET, POST, OPTIONS",
	"access-control-allow-headers": "content-type, accept",
	"access-control-max-age": "86400",
}

const json = (body, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: {"content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...CORS},
	})

const sha256Hex = async (text) => {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32)
}

export default {
	async fetch(request, env) {
		const url = new URL(request.url)
		if (request.method === "OPTIONS") return new Response(null, {status: 204, headers: CORS})
		if (url.pathname === "/healthz") return json({ok: true})
		if (url.pathname !== "/v1/heartbeat" && url.pathname !== "/v1/online") {
			return json({ok: false, message: "not found"}, 404)
		}
		if (url.pathname === "/v1/heartbeat" && request.method !== "POST") {
			return json({ok: false, message: "method not allowed"}, 405)
		}
		const stub = env.PRESENCE.get(env.PRESENCE.idFromName("global"))
		return stub.fetch(request)
	},
}

export class Presence extends DurableObject {
	constructor(ctx, env) {
		super(ctx, env)
		this.sql = ctx.storage.sql
		// 内存限流：每个实例（单实例）一份即可，重启后清零没有副作用
		this.limiter = createRateLimiter({limit: 120, windowMs: 60_000})
		this.sql.exec("CREATE TABLE IF NOT EXISTS presence(id TEXT PRIMARY KEY, ts INTEGER NOT NULL)")
		this.sql.exec("CREATE INDEX IF NOT EXISTS presence_ts ON presence(ts)")
		this.sql.exec(
			"CREATE TABLE IF NOT EXISTS daily(day TEXT NOT NULL, id TEXT NOT NULL, PRIMARY KEY(day, id))",
		)
		// 计数快照（alarm 每分钟重算一次）。心跳只读这张表，避免每次 COUNT(*) 扫全表
		// 把免费额度的「行读」打爆（行读按扫描行数计费，不是按查询次数）。
		this.sql.exec("CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v INTEGER NOT NULL)")
		this.ctx.blockConcurrencyWhile(async () => {
			if ((await this.ctx.storage.getAlarm()) == null) {
				await this.ctx.storage.setAlarm(Date.now() + 60_000)
			}
		})
	}

	async alarm() {
		const now = Date.now()
		try {
			this.prune(now)
			this.recount(now)
		} finally {
			// 即使 prune/recount 出错也要把下一次 alarm 排上，否则清理和计数会永久停摆
			await this.ctx.storage.setAlarm(Date.now() + 60_000)
		}
	}

	async fetch(request) {
		const url = new URL(request.url)
		const now = Date.now()
		const ip = request.headers.get("cf-connecting-ip") || "unknown"

		if (url.pathname === "/v1/online") {
			if (!this.limiter.allow(`read:${ip}`, now)) return json({ok: false, message: "请求过于频繁"}, 429)
			return json(this.snapshot(now))
		}

		if (!this.limiter.allow(`beat:${ip}`, now)) return json({ok: false, message: "请求过于频繁"}, 429)

		let body
		try {
			body = await request.json()
		} catch {
			return json({ok: false, message: "body 不是合法 JSON"}, 400)
		}
		const id = body?.id
		const version = body?.v
		if (!isValidId(id) || !isValidVersion(version)) {
			return json({ok: false, message: "id 或版本号非法"}, 400)
		}

		const key = await sha256Hex(id)
		const row = this.sql.exec("SELECT ts FROM presence WHERE id = ?", key).toArray()[0]
		const wasOnline = row != null && now - row.ts <= WINDOW_MS
		if (shouldCount(row?.ts, now)) {
			this.sql.exec(
				"INSERT INTO presence(id, ts) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET ts = excluded.ts",
				key,
				now,
			)
			// 快照最多慢 60 秒；新上线的人先手动 +1，避免"自己在线却显示 0 位同好"
			if (!wasOnline) this.bump("online", 1)
			const seenToday = this.sql.exec(
				"SELECT 1 AS x FROM daily WHERE day = ? AND id = ?",
				dayKey(now),
				key,
			).toArray()[0]
			if (!seenToday) {
				this.sql.exec("INSERT OR IGNORE INTO daily(day, id) VALUES (?, ?)", dayKey(now), key)
				this.bump("today", 1)
			}
		}
		return json(this.snapshot(now))
	}

	readMeta(key) {
		const row = this.sql.exec("SELECT v FROM meta WHERE k = ?", key).toArray()[0]
		return row == null ? null : normalizeCount(row.v)
	}

	writeMeta(key, value) {
		this.sql.exec(
			"INSERT INTO meta(k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v",
			key,
			normalizeCount(value),
		)
	}

	/** 快照存在时做增量修正（没有快照就交给 recount；下一个 alarm 会重算收敛） */
	bump(key, delta) {
		if (this.readMeta(key) == null) return
		this.sql.exec("UPDATE meta SET v = v + ? WHERE k = ?", delta, key)
	}

	/** 重算并落盘计数快照（只由 alarm / 首次冷启动调用，避免每次心跳扫表） */
	recount(now) {
		const online = normalizeCount(
			this.sql.exec("SELECT COUNT(*) AS n FROM presence WHERE ts >= ?", onlineCutoff(now)).one().n,
		)
		const today = normalizeCount(
			this.sql.exec("SELECT COUNT(*) AS n FROM daily WHERE day = ?", dayKey(now)).one().n,
		)
		this.writeMeta("online", online)
		this.writeMeta("today", today)
		this.writeMeta("updatedAt", now)
		return {online, today}
	}

	snapshot(now) {
		let online = this.readMeta("online")
		let today = this.readMeta("today")
		const updatedAt = this.readMeta("updatedAt")
		// 冷启动 / alarm 停了 / 跨天：快照缺失或超过 5 分钟，就现算一次
		if (online == null || today == null || updatedAt == null || now - updatedAt > 5 * 60_000) {
			;({online, today} = this.recount(now))
		}
		return {ok: true, online, today, ts: now, windowMs: WINDOW_MS, throttleMs: IDLE_THROTTLE_MS}
	}

	prune(now) {
		this.sql.exec("DELETE FROM presence WHERE ts < ?", onlineCutoff(now))
		this.sql.exec("DELETE FROM daily WHERE day < ?", dayCutoff(now))
		this.limiter.prune(now)
	}
}
