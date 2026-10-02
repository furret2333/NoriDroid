// src/services/pomo-stats.ts
var KEEP_DAYS = 3650;
var dayKey = (d = /* @__PURE__ */ new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
var dayMinutes = (d) => (d?.focusMin || 0) + (d?.countUpMin || 0);
var isActiveDay = (d) => !!d && (dayMinutes(d) > 0 || (d.done || 0) > 0);
var addToStore = (stats, delta) => {
  stats.total = {
    focusMin: (stats.total?.focusMin || 0) + (delta.focusMin || 0),
    done: (stats.total?.done || 0) + (delta.done || 0),
    countUpMin: (stats.total?.countUpMin || 0) + (delta.countUpMin || 0)
  };
  let dayMin = stats.best?.dayMin || 0;
  for (const k of Object.keys(stats.days)) dayMin = Math.max(dayMin, dayMinutes(stats.days[k]));
  stats.best = { dayMin, streak: bestStreak(stats.days) };
};
var migrateStats = (stats, now = /* @__PURE__ */ new Date()) => {
  let changed = false;
  if (!stats.total) {
    const t = { focusMin: 0, done: 0, countUpMin: 0 };
    for (const k of Object.keys(stats.days)) {
      t.focusMin += stats.days[k]?.focusMin || 0;
      t.done += stats.days[k]?.done || 0;
      t.countUpMin += stats.days[k]?.countUpMin || 0;
    }
    stats.total = t;
    changed = true;
  }
  if (!stats.best) {
    let dayMin = 0;
    for (const k of Object.keys(stats.days)) dayMin = Math.max(dayMin, dayMinutes(stats.days[k]));
    stats.best = { dayMin, streak: bestStreak(stats.days) };
    changed = true;
  }
  const cutoff = dayKey(new Date(now.getTime() - KEEP_DAYS * 864e5));
  for (const k of Object.keys(stats.days)) {
    if (k < cutoff) {
      delete stats.days[k];
      changed = true;
    }
  }
  return changed;
};
var summarize = (days, rangeDays = 7, now = /* @__PURE__ */ new Date()) => {
  const today = days[dayKey(now)];
  const doneToday = today?.done || 0;
  const abortToday = today?.abort || 0;
  const attempts = doneToday + abortToday;
  let rangeMin = 0;
  let rangeBest = 0;
  let rangeDone = 0;
  for (let i = 0; i < rangeDays; i++) {
    const k = dayKey(new Date(now.getTime() - i * 864e5));
    const d = days[k];
    const min = dayMinutes(d);
    rangeMin += min;
    if (min > rangeBest) rangeBest = min;
    rangeDone += d?.done || 0;
  }
  return {
    todayMin: dayMinutes(today),
    todayDone: doneToday,
    todayAbort: abortToday,
    // 没有任何完成/放弃时不显示 0% (那是"没数据", 不是"全失败")
    todayRate: attempts > 0 ? doneToday / attempts : -1,
    todayAvgMin: doneToday > 0 ? Math.round((today?.focusMin || 0) / doneToday) : -1,
    rangeMin,
    rangeBest,
    rangeDone,
    streak: computeStreak(days, now)
  };
};
var computeStreak = (days, now = /* @__PURE__ */ new Date()) => {
  let offset = isActiveDay(days[dayKey(now)]) ? 0 : 1;
  let n = 0;
  for (let i = offset; i < 4e3; i++) {
    if (!isActiveDay(days[dayKey(new Date(now.getTime() - i * 864e5))])) break;
    n += 1;
  }
  return n;
};
var bestStreak = (days) => {
  const keys = Object.keys(days).filter((k) => isActiveDay(days[k])).sort();
  let best = 0;
  let run = 0;
  let prev = null;
  for (const k of keys) {
    const cur = /* @__PURE__ */ new Date(`${k}T12:00:00`);
    if (prev && Math.round((cur.getTime() - prev.getTime()) / 864e5) === 1) run += 1;
    else run = 1;
    if (run > best) best = run;
    prev = cur;
  }
  return best;
};
var monthlyRollup = (days, months = 12, now = /* @__PURE__ */ new Date()) => {
  const map = /* @__PURE__ */ new Map();
  for (const [k, d] of Object.entries(days)) {
    const m = k.slice(0, 7);
    const cur = map.get(m) ?? { min: 0, done: 0 };
    cur.min += dayMinutes(d);
    cur.done += d?.done || 0;
    map.set(m, cur);
  }
  const out = [];
  for (let i = 0; i < months; i++) {
    const dt = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const key = `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}`;
    const v = map.get(key);
    out.push({ month: key, min: v?.min || 0, done: v?.done || 0 });
  }
  return out;
};
var heatLevel = (min) => {
  if (!min) return 0;
  if (min < 25) return 1;
  if (min < 50) return 2;
  if (min < 100) return 3;
  return 4;
};
var buildHeatmap = (days, weeks = 52, now = /* @__PURE__ */ new Date()) => {
  const doy = now.getDay();
  const start = new Date(now.getTime() - ((weeks - 1) * 7 + doy) * 864e5);
  const cells = [];
  const monthLabels = [];
  let lastMonth = -1;
  for (let w = 0; w < weeks; w++) {
    for (let row = 0; row < 7; row++) {
      const d = new Date(start.getTime() + (w * 7 + row) * 864e5);
      if (d.getTime() > now.getTime()) {
        cells.push(null);
        continue;
      }
      const date = dayKey(d);
      const min = dayMinutes(days[date]);
      cells.push({ date, min, level: heatLevel(min) });
      if (row === 0) {
        const m = d.getMonth();
        if (m !== lastMonth) {
          monthLabels.push({ col: w, text: `${m + 1}\u6708` });
          lastMonth = m;
        }
      }
    }
  }
  return { weeks, cells, monthLabels };
};
var MILESTONES = [
  { key: "streak7", need: (s) => s.streak >= 7, text: "\u4E3B\u4EBA\u5DF2\u7ECF\u8FDE\u7EED\u4E00\u5468\u6BCF\u5929\u90FD\u4E13\u6CE8\u4E86" },
  { key: "streak3", need: (s) => s.streak >= 3, text: "\u4E3B\u4EBA\u5DF2\u7ECF\u8FDE\u7740\u597D\u51E0\u5929\u90FD\u4E13\u6CE8\u4E86" }
];
var TOPIC_RE = /(工作|上班|加班|学习|复习|考试|论文|项目|写代码|编程|赶工|赶进度|专注|摸鱼|效率|图书馆|自习|作业|ddl)/i;
var topicRelated = (text) => TOPIC_RE.test(String(text ?? ""));
var buildFocusHint = (s, userText, celebrated = {}) => {
  if (!topicRelated(userText)) return { hint: "" };
  for (const m of MILESTONES) {
    if (m.need(s) && !celebrated[m.key]) {
      return {
        hint: `\u3010\u81EA\u7136\u5730\u63D0\u4E00\u53E5\u3011${m.text}\u3002\u53EF\u4EE5\u9AD8\u5174\u4E00\u70B9\u5730\u5938\u4ED6\u4E00\u53E5\uFF0C\u6700\u591A\u63D0\u8FD9\u4E00\u4EF6\u4E8B\uFF0C\u4E0D\u8981\u7F57\u5217\u5176\u5B83\u6570\u636E\uFF0C\u4E0D\u8981\u62A5\u6570\u5B57\u5806\u780C\u3002`,
        milestoneKey: m.key
      };
    }
  }
  if (s.streak >= 3) {
    return {
      hint: `\u3010\u81EA\u7136\u5730\u63D0\u4E00\u53E5\u3011\u4E3B\u4EBA\u5DF2\u7ECF\u8FDE\u7EED ${s.streak} \u5929\u6709\u4E13\u6CE8\u4E86\u3002\u6700\u591A\u63D0\u8FD9\u4E00\u4EF6\u4E8B\uFF0C\u4E0D\u8981\u7F57\u5217\u5176\u5B83\u6570\u636E\uFF1B\u82E5\u548C\u5F53\u524D\u8BDD\u9898\u4E0D\u642D\u5C31\u4E0D\u8981\u63D0\u3002`
    };
  }
  if (s.todayMin >= 25) {
    return {
      hint: `\u3010\u81EA\u7136\u5730\u63D0\u4E00\u53E5\u3011\u4E3B\u4EBA\u4ECA\u5929\u5DF2\u7ECF\u4E13\u6CE8 ${s.todayMin} \u5206\u949F\u4E86\u3002\u6700\u591A\u63D0\u8FD9\u4E00\u4EF6\u4E8B\uFF0C\u4E0D\u8981\u7F57\u5217\u5176\u5B83\u6570\u636E\uFF1B\u82E5\u548C\u5F53\u524D\u8BDD\u9898\u4E0D\u642D\u5C31\u4E0D\u8981\u63D0\u3002`
    };
  }
  return { hint: "" };
};
export {
  KEEP_DAYS,
  MILESTONES,
  addToStore,
  bestStreak,
  buildFocusHint,
  buildHeatmap,
  computeStreak,
  dayKey,
  dayMinutes,
  heatLevel,
  isActiveDay,
  migrateStats,
  monthlyRollup,
  summarize,
  topicRelated
};
