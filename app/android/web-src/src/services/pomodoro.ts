import {dayKey, dayMinutes, type PomoStatsFile} from "./pomo-stats"

export interface PomoConfig {
  focusMin: number; breakMin: number; autoBreak: boolean; notify: boolean; sulkMin: number
  autoFocus: boolean; cycleEnabled: boolean; longEvery: number; longBreakMin: number
  dailyGoal: number; goal: string; feedback: "gentle" | "character" | "silent"
  quietFocus: boolean; quietBreak: boolean; quietPaused: boolean
}
export const DEFAULT_POMO: PomoConfig = {
  focusMin: 25, breakMin: 5, autoBreak: true, notify: true, sulkMin: 10,
  autoFocus: false, cycleEnabled: false, longEvery: 4, longBreakMin: 15,
  dailyGoal: 60, goal: "", feedback: "gentle", quietFocus: true, quietBreak: true, quietPaused: true,
}
export function normalizePomo(value: unknown): PomoConfig {
  const o = value && typeof value === "object" ? value as Record<string, unknown> : {}
  const n = (key: keyof PomoConfig, min: number, max: number) => typeof o[key] === "number" && Number.isFinite(o[key])
    ? Math.min(max, Math.max(min, Math.round(o[key] as number))) : DEFAULT_POMO[key] as number
  const b = (key: keyof PomoConfig) => typeof o[key] === "boolean" ? o[key] as boolean : DEFAULT_POMO[key] as boolean
  return {focusMin: n("focusMin", 5, 120), breakMin: n("breakMin", 1, 30), sulkMin: n("sulkMin", 0, 15),
    autoBreak: b("autoBreak"), notify: b("notify"), autoFocus: b("autoFocus"), cycleEnabled: b("cycleEnabled"),
    longEvery: n("longEvery", 2, 12), longBreakMin: n("longBreakMin", 1, 60), dailyGoal: n("dailyGoal", 0, 720),
    goal: typeof o.goal === "string" ? o.goal.trim().slice(0, 100) : "",
    feedback: o.feedback === "character" || o.feedback === "silent" ? o.feedback : "gentle",
    quietFocus: b("quietFocus"), quietBreak: b("quietBreak"), quietPaused: b("quietPaused")}
}

/** 本地快照增量按日分摊，只用于显示，不回写已结算账本。 */
export function projectLiveDays(days: Record<string, number>, at: number, delta: number): Record<string, number> {
  const out = {...days}
  let cursor = at, left = Math.max(0, delta)
  while (left > 0) {
    const next = new Date(cursor); next.setHours(24, 0, 0, 0)
    const part = Math.min(left, Math.max(1, next.getTime() - cursor)), key = dayKey(new Date(cursor))
    out[key] = (out[key] || 0) + part; cursor += part; left -= part
  }
  return out
}
export const monthPercent = (min: number, months: {min: number}[]): number =>
  Math.max(0, Math.min(100, min / Math.max(1, ...months.map(m => m.min)) * 100))

export function parsePomoBackup(raw: string): {stats: PomoStatsFile; days: number; minutes: number} {
  if (raw.length > 10_000_000) throw new Error("备份超过 10MB")
  const o = JSON.parse(raw.replace(/^\uFEFF/, ""))
  if (o.kind !== "nori-pomodoro" || o.version !== 1 || !o.stats || ![1, 2].includes(o.stats.v) ||
    !o.stats.days || typeof o.stats.days !== "object" || Array.isArray(o.stats.days)) throw new Error("请选择番茄钟 JSON 备份")
  const entries = Object.entries(o.stats.days)
  if (entries.length > 100000) throw new Error("记录数量超过限制")
  for (const [date, day] of entries) {
    const dt = new Date(`${date}T12:00:00`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(dt.getTime()) || dayKey(dt) !== date || !day || typeof day !== "object" || Array.isArray(day))
      throw new Error("备份日期或记录格式无效")
    for (const key of ["focusMin", "countUpMin", "done", "abort", "focusMs", "countUpMs", "completedCount", "completedFocusMin", "switched", "stopped"]) {
      const n = (day as Record<string, unknown>)[key]
      if (n !== undefined && (typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1e15 ||
        (["done", "abort", "focusMs", "countUpMs", "completedCount", "switched", "stopped"].includes(key) && !Number.isInteger(n)))) throw new Error("备份数值无效")
    }
  }
  for (const field of ["total", "best", "celebrated"]) {
    if (o.stats[field] === undefined) continue
    if (!o.stats[field] || typeof o.stats[field] !== "object" || Array.isArray(o.stats[field]) ||
      Object.values(o.stats[field]).some(n => typeof n !== "number" || !Number.isFinite(n) || n < 0 || n > 1e15)) throw new Error("备份汇总数值无效")
  }
  return {stats: o.stats, days: entries.length, minutes: Math.round(Object.values(o.stats.days as PomoStatsFile["days"]).reduce((n, d) => n + dayMinutes(d), 0))}
}

export function pomoCsv(stats: PomoStatsFile): string {
  return "\uFEFF日期,总专注分钟,倒计时分钟,正向分钟,完成番茄,中断\r\n" + Object.entries(stats.days).sort(([a], [b]) => a.localeCompare(b))
    .map(([date, d]) => [date, dayMinutes(d).toFixed(2), (d.focusMs !== undefined ? d.focusMs / 60000 : d.focusMin || 0).toFixed(2),
      (d.countUpMs !== undefined ? d.countUpMs / 60000 : d.countUpMin || 0).toFixed(2), d.done || 0, d.abort || 0].join(",")).join("\r\n")
}
