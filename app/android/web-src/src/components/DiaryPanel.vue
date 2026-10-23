<template>
	<section class="diary-notebook" aria-label="Nori 的日记本">
		<header class="notebook-intro"><div><span class="eyebrow">NORi · OUR DAYS</span><h2>把这一天，留在这里。</h2><p>一些小事，一点心情，还有一起度过的时间。</p></div><DiaryIcon class="intro-book" name="book" /></header>
		<div class="notebook-tools"><div class="view-tabs" aria-label="浏览日记"><button :class="{active: view === 'read'}" @click="view = 'read'"><DiaryIcon name="book" />阅读</button><button :class="{active: view === 'list'}" @click="view = 'list'"><DiaryIcon name="list" />时间线</button></div><div class="tool-right"><button class="icon-button" aria-label="搜索日记" :aria-expanded="searchOpen" @click="searchOpen = !searchOpen; view = 'list'"><DiaryIcon name="search" /></button><button class="icon-button" aria-label="日记管理" :aria-expanded="menuOpen" @click="menuOpen = !menuOpen"><DiaryIcon name="more" /></button></div></div>
		<div v-if="menuOpen" class="management"><button @click="exportMd(entries)"><DiaryIcon name="export" />导出全部日记</button><button @click="backup"><DiaryIcon name="book" />备份日记 JSON</button><button @click="pickImport"><DiaryIcon name="calendar" />从备份恢复</button><button @click="reviewOpen = true; menuOpen = false"><DiaryIcon name="spark" />本月回顾</button><button @click="refresh(); menuOpen = false">重新读取</button><button class="danger" @click="clearAll">清空日记</button></div>
		<div v-if="health.message" class="notice" :class="{error: health.blocked}" role="status">{{ health.message }}<button @click="refresh">重新读取</button></div>
		<div v-if="message" class="notice" :class="{error}" role="status">{{ message }}<button v-if="busy" @click="stop">停止</button></div>
		<div v-if="historyPending.length && !busy" class="pending-strip"><span><DiaryIcon name="pen" />还有 {{ historyPending.length }} 天等着写下来</span><button :disabled="!!draft || chatBusy" @click="fillHistory">补写日记</button></div>
		<template v-if="view === 'read'">
			<div class="day-navigation"><button class="icon-button" aria-label="前一天" @click="choose(shiftDiaryDay(selected, -1))"><DiaryIcon name="left" /></button><button class="date-choice" :aria-expanded="calendarOpen" @click="calendarOpen = !calendarOpen"><DiaryIcon name="calendar" /><span>{{ friendlyDate(selected) }}</span><DiaryIcon name="down" /></button><button class="icon-button" aria-label="后一天" :disabled="selected >= today" @click="choose(shiftDiaryDay(selected, 1))"><DiaryIcon name="right" /></button></div>
			<article class="diary-paper" :aria-label="selected + '的日记'">
				<div class="paper-top"><span class="paper-date">{{ selected.split('-').join(' / ') }}</span><button v-if="entry" class="paper-bookmark" :class="{saved: entry.favorite}" :aria-label="entry.favorite ? '取消收藏' : '收藏这篇日记'" :aria-pressed="!!entry.favorite" @click="toggleFavorite(entry)"><DiaryIcon name="star" /></button><span v-else class="paper-no">{{ String(entries.length + 1).padStart(2, '0') }}</span></div>
				<template v-if="entry"><div class="paper-caption"><span class="mood-mark"><i :class="moodClass(entry.mood)"></i>Nori · {{ entry.mood }}</span><span>{{ entry.editedByUser ? '已由你保留' : entry.status === 'draft' ? '今天的草稿' : '这一页已写好' }}</span></div><p class="letter-content">{{ entry.content }}</p><div class="paper-signature"><span></span><em>Nori</em><DiaryIcon name="spark" /></div><div class="paper-foot"><span>{{ entry.sourceUserCount !== undefined ? `你说了 ${entry.sourceUserCount} 条 · Nori 回了 ${entry.sourceAssistantCount ?? 0} 条` : `参考 ${entry.msgCount} 条消息` }}</span><span v-if="entry.favorite">珍藏的一天</span></div></template>
				<div v-else class="unwritten"><DiaryIcon name="pen" /><h3>{{ emptyTitle }}</h3><p>{{ emptyDescription }}</p><span></span></div>
			</article>
			<div class="reading-actions"><button class="write-button" :disabled="busy || health.blocked || !!draft || chatBusy || selected > today || !source.userCount" @click="generate()"><DiaryIcon name="pen" />{{ busy ? '正在写下这一天…' : hasNewMessages ? '有新对话，更新这一页' : entry ? '重新写这一页' : selected === today ? '写下今天' : suppressed ? '重新生成这一天' : '写下这一天' }}</button><button v-if="busy" class="text-button" @click="stop">停止</button><template v-if="entry"><button class="icon-button" aria-label="复制这篇日记" @click="copyEntry"><DiaryIcon name="copy" /></button><button class="icon-button" aria-label="生成日记分享卡" @click="createCard"><DiaryIcon name="share" /></button><button class="icon-button" aria-label="更多单篇操作" :aria-expanded="entryMenu" @click="entryMenu = !entryMenu"><DiaryIcon name="more" /></button></template></div>
			<div v-if="entryMenu && entry" class="entry-menu"><button @click="exportMd([entry])">导出这一篇</button><button @click="startEdit">修改正文</button><button v-if="entry.status === 'draft'" @click="keepEntry">保留这一版</button><button class="danger" @click="removeEntry">删除这一天</button></div>
			<div v-if="entry" class="annotation"><button :aria-expanded="noteOpen" @click="openNote"><DiaryIcon name="pen" />{{ entry.note ? '我的批注' : '留一句自己的话' }}<DiaryIcon name="down" /></button><p v-if="entry.note && !noteOpen">{{ entry.note }}</p><div v-if="noteOpen"><label class="sr-only" for="diary-note">我的批注</label><textarea id="diary-note" v-model="noteText" maxlength="4000" placeholder="这一页，也可以留一点你的心情。"></textarea><button class="small-button" @click="saveNote">保存批注</button></div></div>
			<div class="calendar-toggle"><button @click="calendarOpen = !calendarOpen"><DiaryIcon name="calendar" />翻看日历<DiaryIcon name="down" :class="{rotated: calendarOpen}" /></button><button v-if="selected !== today" @click="choose(today)">回到今天</button></div>
			<div v-if="calendarOpen" class="notebook-calendar"><div class="month-control"><button class="icon-button" aria-label="上个月" @click="moveMonth(-1)"><DiaryIcon name="left" /></button><label class="month-picker"><span>{{ monthDate.getFullYear() }} 年 {{ monthDate.getMonth() + 1 }} 月</span><input aria-label="选择年月" type="month" :value="month" :max="today.slice(0, 7)" min="1970-01" @change="setMonth(($event.target as HTMLInputElement).value)" /></label><button class="icon-button" aria-label="下个月" :disabled="month >= today.slice(0, 7)" @click="moveMonth(1)"><DiaryIcon name="right" /></button></div><div class="calendar-grid week"><span v-for="w in ['日','一','二','三','四','五','六']" :key="w">{{ w }}</span></div><div class="calendar-grid"><template v-for="(date, i) in calendarDays" :key="date || i"><span v-if="!date"></span><button v-else class="calendar-day" :class="{chosen: selected === date, 'is-today': today === date, written: !!byDate[date]}" :disabled="date > today" :aria-label="`${date}${byDate[date] ? '，Nori心情' + byDate[date].mood : '，未写日记'}`" :aria-pressed="selected === date" @click="choose(date)"><span>{{ Number(date.slice(-2)) }}</span><i v-if="byDate[date]" :class="moodClass(byDate[date].mood)"></i><i v-else-if="pendingDates.includes(date)" class="pending-dot"></i></button></template></div><div class="calendar-legend"><span v-for="m in DIARY_MOODS" :key="m"><i :class="moodClass(m)"></i>{{ m }}</span></div><div class="calendar-summary"><span>这个月，留下了 <b>{{ monthEntries.length }}</b> 篇日记</span><button @click="reviewOpen = true">本月回顾<DiaryIcon name="right" /></button></div></div>
			<button v-if="anniversaryEntry && anniversaryEntry.date !== selected" class="memory-day" @click="choose(anniversaryEntry.date)"><DiaryIcon name="book" /><span><small>那年今天</small>{{ anniversaryEntry.content.slice(0, 50) }}…</span><DiaryIcon name="right" /></button>
		</template>
		<template v-else><div v-if="searchOpen" class="search-field"><DiaryIcon name="search" /><input v-model="query" aria-label="搜索日记正文、批注或日期" placeholder="找找某一天，或一件小事…" /><button v-if="query" class="icon-button" aria-label="清空搜索" @click="query = ''"><DiaryIcon name="close" /></button></div><div class="timeline-filters"><button :class="{active: !favoritesOnly}" @click="favoritesOnly = false">全部 {{ entries.length }}</button><button :class="{active: favoritesOnly}" @click="favoritesOnly = true"><DiaryIcon name="star" />珍藏 {{ entries.filter(e => e.favorite).length }}</button><button class="today-link" @click="choose(today)">写今天<DiaryIcon name="pen" /></button></div><div v-if="!filtered.length" class="timeline-empty"><DiaryIcon name="book" /><h3>{{ query || favoritesOnly ? '还没有找到这一页' : '日记本，等着第一篇故事' }}</h3><p>{{ query || favoritesOnly ? '试着换个关键词，或看看全部日记。' : '聊过天之后，Nori 会把你们的一天写下来。' }}</p><button class="small-button" @click="query = ''; favoritesOnly = false; choose(today)">去今天看看</button></div><div v-else class="timeline"><button v-for="e in visibleEntries" :key="e.date" class="timeline-entry" @click="choose(e.date)"><span class="timeline-date"><strong>{{ Number(e.date.slice(-2)) }}</strong><small>{{ e.date.slice(0, 7).replace('-', '.') }}</small></span><span class="timeline-text"><span class="timeline-mood"><i :class="moodClass(e.mood)"></i>{{ e.mood }}<DiaryIcon v-if="e.favorite" name="star" /></span><span class="timeline-excerpt">{{ e.content }}</span></span><DiaryIcon name="right" /></button><button v-if="filtered.length > visibleCount" class="load-more" @click="visibleCount += 30">再翻一些日记</button></div></template>
		<footer class="notebook-footer"><span></span>每一页，都是我们的一天。<span></span></footer>
		<div v-if="draft" class="diary-overlay" role="dialog" aria-modal="true" aria-labelledby="draft-title" @keydown.esc="discardDraft"><div class="diary-dialog"><div class="dialog-heading"><div><span class="eyebrow">{{ draft.entry.date }}</span><h3 id="draft-title">{{ draftConflict ? '原文已经发生变化' : saveFailed ? '写好了，还没有存好' : '这一页的新写法' }}</h3></div><button class="icon-button" aria-label="关闭新稿预览" @click="discardDraft"><DiaryIcon name="close" /></button></div><p class="dialog-hint">{{ saveFailed ? '新稿留在这里，重存无需再次生成。' : '原文仍然保留，看看是否更喜欢这一版。' }}</p><div class="draft-preview"><span class="mood-mark"><i :class="moodClass(draft.entry.mood)"></i>{{ draft.entry.mood }}</span><p>{{ draft.entry.content }}</p></div><p v-if="error" class="dialog-error" role="alert">{{ message }}</p><div class="dialog-actions"><button class="small-button" @click="discardDraft">{{ saveFailed ? '放弃新稿' : '保留原文' }}</button><button class="write-button" :disabled="draftConflict" @click="saveDraft">{{ saveFailed ? '重新保存' : '使用这一版' }}</button></div></div></div>
		<div v-if="editOpen" class="diary-overlay" role="dialog" aria-modal="true" aria-labelledby="edit-title" @keydown.esc="editOpen = false"><div class="diary-dialog"><div class="dialog-heading"><h3 id="edit-title">修改这一页</h3><button class="icon-button" aria-label="取消修改" @click="editOpen = false"><DiaryIcon name="close" /></button></div><label class="field-label" for="diary-edit">日记正文</label><textarea id="diary-edit" v-model="editText" maxlength="4000" rows="8"></textarea><label class="field-label" for="diary-mood">Nori 的心情</label><select id="diary-mood" v-model="editMood"><option v-for="m in DIARY_MOODS" :key="m">{{ m }}</option></select><p class="dialog-hint">修改后将保留你的版本，不再自动改写。</p><p v-if="error" class="dialog-error" role="alert">{{ message }}</p><div class="dialog-actions"><button class="small-button" @click="editOpen = false">取消</button><button class="write-button" @click="saveEdit">保存修改</button></div></div></div>
		<div v-if="importPreview" class="diary-overlay" role="dialog" aria-modal="true" aria-labelledby="import-title" @keydown.esc="importPreview = null"><div class="diary-dialog"><div class="dialog-heading"><h3 id="import-title">恢复日记备份</h3><button class="icon-button" aria-label="取消恢复" @click="importPreview = null"><DiaryIcon name="close" /></button></div><p class="dialog-hint">找到 {{ importPreview.store.entries.length }} 篇日记，其中 {{ importPreview.added }} 篇可新增、{{ importPreview.replaced }} 篇日期重复。</p><label class="check-field"><input type="checkbox" v-model="replaceExisting" />用备份替换重复日期的日记</label><label class="check-field"><input type="checkbox" v-model="restoreDeleted" />主动恢复此前删除的日期</label><p class="dialog-hint">默认保留现有正文和删除状态。备份中的 {{ importPreview.suppressed }} 条删除记录也会恢复；恢复前会保存当前资料副本。</p><p v-if="error" class="dialog-error" role="alert">{{ message }}</p><div class="dialog-actions"><button class="small-button" @click="importPreview = null">取消</button><button class="write-button" @click="applyImport">确认恢复</button></div></div></div>
		<div v-if="reviewOpen" class="diary-overlay" role="dialog" aria-modal="true" aria-labelledby="review-title" @keydown.esc="reviewOpen = false"><div class="diary-dialog"><div class="dialog-heading"><div><span class="eyebrow">{{ month.replace('-', ' / ') }}</span><h3 id="review-title">这个月，我们留下了…</h3></div><button class="icon-button" aria-label="关闭月度回顾" @click="reviewOpen = false"><DiaryIcon name="close" /></button></div><div class="review-numbers"><div><strong>{{ monthEntries.length }}</strong><span>篇日记</span></div><div><strong>{{ monthEntries.filter(e => e.favorite).length }}</strong><span>个珍藏片段</span></div><div><strong>{{ monthEntries.filter(e => e.status === 'final' || !e.status).length }}</strong><span>篇已完成</span></div></div><div class="mood-distribution" v-for="m in DIARY_MOODS" :key="m"><span>{{ m }}</span><span class="mood-track"><i :class="moodClass(m)" :style="{width: `${monthEntries.length ? monthEntries.filter(e => e.mood === m).length / monthEntries.length * 100 : 0}%`}"></i></span><small>{{ monthEntries.filter(e => e.mood === m).length }}</small></div><p class="dialog-hint">记录的是 Nori 在日记里的感受。</p><button class="small-button" :disabled="!monthEntries.length" @click="exportMd(monthEntries)">导出这个月</button></div></div>
		<div v-if="cardUrl" class="diary-overlay" role="dialog" aria-modal="true" aria-labelledby="card-title" @keydown.esc="cardUrl = ''"><div class="diary-dialog"><div class="dialog-heading"><h3 id="card-title">把这一天带走</h3><button class="icon-button" aria-label="关闭分享卡" @click="cardUrl = ''"><DiaryIcon name="close" /></button></div><p v-if="cardExcerpt" class="dialog-hint">长日记的卡片展示节选，完整正文可以单篇导出。</p><p v-if="error" class="dialog-error" role="alert">{{ message }}</p><img class="share-card" :src="cardUrl" alt="日记分享卡预览，包含所选日期、Nori心情与正文" /><div class="dialog-actions"><button class="small-button" @click="cardUrl = ''">关闭</button><button class="write-button" @click="saveCard"><DiaryIcon name="export" />保存图片</button></div></div></div>
		<input ref="importInput" type="file" class="sr-only" accept=".json,application/json" aria-label="选择日记备份" @change="readImport" />
	</section>
</template>

<script setup lang="ts">
import {computed, nextTick, onBeforeUnmount, onMounted, ref, watch} from "vue"
import DiaryIcon from "./DiaryIcon.vue"
import {useDiary, type DiaryConfig} from "../composables/useDiary"
import {getStorageDir, writeFile} from "../services/chat"
import {buildDiaryMd, clearDiary, deleteDiaryEntry, diaryDay, diaryHealth, diaryEntryToken, DIARY_MOODS, discardDiaryDraft, exportDiaryJson, importDiaryJson, previewDiaryImport, shiftDiaryDay, updateDiaryEntry, type DiaryEntry, type DiaryImport, type DiaryResult} from "../services/nori-diary"
const props = defineProps<{config: DiaryConfig; chatBusy: boolean}>()
const emit = defineEmits<{notify: [message: string]}>()
const {entries, today, selected, health, pendingDates, source, suppressed, busy, draft, message, error, saveFailed, draftConflict, entry, hasNewMessages, refresh, select, cancel, saveDraft, generate} = useDiary(() => props.config, () => props.chatBusy)
const view = ref<"read" | "list">("read"), calendarOpen = ref(false), month = ref(today.value.slice(0, 7))
const searchOpen = ref(false), query = ref(""), favoritesOnly = ref(false), menuOpen = ref(false), entryMenu = ref(false)
const noteOpen = ref(false), noteText = ref(""), noteExpected = ref("")
const editOpen = ref(false), editText = ref(""), editMood = ref("平静"), editExpected = ref("")
const importInput = ref<HTMLInputElement | null>(null), importPreview = ref<DiaryImport | null>(null)
const replaceExisting = ref(false), restoreDeleted = ref(false), reviewOpen = ref(false), visibleCount = ref(30), cardUrl = ref("")
const cardExcerpt = ref(false)
let cardDate = "", filling = false
let clock: ReturnType<typeof setInterval> | undefined
const byDate = computed(() => Object.fromEntries(entries.value.map(e => [e.date, e])))
const monthDate = computed(() => { const [y, m] = month.value.split("-").map(Number); return new Date(y, m - 1, 1, 12) })
const monthEntries = computed(() => entries.value.filter(e => e.date.startsWith(month.value)))
const historyPending = computed(() => pendingDates.value.filter(d => d < today.value))
const calendarDays = computed<(string | null)[]>(() => [...Array(monthDate.value.getDay()).fill(null), ...Array.from({length: new Date(monthDate.value.getFullYear(), monthDate.value.getMonth() + 1, 0).getDate()}, (_, i) => `${month.value}-${String(i + 1).padStart(2, '0')}`)])
const filtered = computed(() => entries.value.filter(e => (!favoritesOnly.value || e.favorite) && `${e.date} ${e.content} ${e.note ?? ''} ${e.mood}`.toLocaleLowerCase().includes(query.value.trim().toLocaleLowerCase())))
const visibleEntries = computed(() => filtered.value.slice(0, visibleCount.value))
const anniversaryEntry = computed(() => entries.value.find(e => e.date.slice(5) === today.value.slice(5) && e.date.slice(0, 4) < today.value.slice(0, 4)))
const friendlyDate = (date: string) => {
	const [y, m, d] = date.split("-").map(Number)
	return `${date === today.value ? '今天 · ' : date === shiftDiaryDay(today.value, -1) ? '昨天 · ' : ''}${m}月${d}日 周${'日一二三四五六'[new Date(y, m - 1, d, 12).getDay()]}`
}
const moodClass = (mood: string) => ({开心: "m-happy", 平静: "m-calm", 孤单: "m-lonely", 难过: "m-sad", 兴奋: "m-excited"}[mood] || "m-calm")
const emptyTitle = computed(() => busy.value ? "Nori 正在写这一页" : suppressed.value ? "这一页已经删除" : source.value.error ? "先找回这一天的素材" : source.value.userCount ? "这一天，还没写下来" : selected.value === today.value ? "今天的故事，还在继续" : "这一天，留一页空白")
const emptyDescription = computed(() => suppressed.value ? "你删掉的日记不会自动补回。想再写一遍时，可以主动重新生成。" : source.value.error || (source.value.userCount ? "聊天片段已经备好，写下你们的小小日常吧。" : selected.value === today.value ? "聊过天之后，再来留住今天的一点心情。" : "没有可用的聊天记录，就不替回忆添写故事。"))
const choose = (date: string) => { select(date); month.value = date.slice(0, 7); view.value = "read"; entryMenu.value = false; noteOpen.value = false }
const setMonth = (value: string) => { if (!/^\d{4}-\d{2}$/.test(value) || value > today.value.slice(0, 7) || value < '1970-01') return; month.value = value; select(entries.value.find(e => e.date.startsWith(value))?.date ?? (value === today.value.slice(0, 7) ? today.value : `${value}-01`)) }
const moveMonth = (step: number) => { const d = monthDate.value; setMonth(diaryDay(new Date(d.getFullYear(), d.getMonth() + step, 1, 12)).slice(0, 7)) }
const report = (r: DiaryResult) => { message.value = r.message; error.value = r.code !== "ok"; if (r.code === "ok") { refresh(); window.dispatchEvent(new Event("nori-diary-updated")) } }
const toggleFavorite = (e: DiaryEntry) => report(updateDiaryEntry(e.date, {favorite: !e.favorite}, diaryEntryToken(e.date, e)))
const removeEntry = () => {
	if (!window.confirm(`删除 ${selected.value} 的日记？\n这一天不会自动补写。聊天记录和已有导出文件仍保留。`)) return
	const ok = deleteDiaryEntry(selected.value); message.value = ok ? "已删除，这一天不会再自动补写" : diaryHealth().lastMessage || "删除未能保存，原文已保留"; error.value = !ok; entryMenu.value = false; refresh()
}
const clearAll = () => {
	if (!entries.value.length || !window.confirm(`清空全部 ${entries.value.length} 篇日记？\n现有日期将停止自动补写。聊天和手工导出文件保留。`)) return
	const ok = clearDiary(); message.value = ok ? "已清空日记" : diaryHealth().lastMessage || "清空未能保存，原文已保留"; error.value = !ok; menuOpen.value = false; refresh()
}
const keepEntry = () => { report(updateDiaryEntry(selected.value, {status: "final"}, diaryEntryToken(selected.value, entry.value))); entryMenu.value = false }
const openNote = () => { if (!noteOpen.value) { noteText.value = entry.value?.note ?? ""; noteExpected.value = diaryEntryToken(selected.value, entry.value) }; noteOpen.value = !noteOpen.value }
const saveNote = () => { const r = updateDiaryEntry(selected.value, {note: noteText.value.trim()}, noteExpected.value); report(r); if (r.code === "ok") noteOpen.value = false }
const startEdit = () => { if (!entry.value) return; error.value = false; editText.value = entry.value.content; editMood.value = entry.value.mood; editExpected.value = diaryEntryToken(selected.value, entry.value); editOpen.value = true; entryMenu.value = false }
const saveEdit = () => { const r = updateDiaryEntry(selected.value, {content: editText.value.trim(), mood: editMood.value}, editExpected.value); report(r); if (r.code === "ok") editOpen.value = false }
const discardDraft = () => { if (saveFailed.value && !window.confirm("新稿还没保存，确定放弃吗？")) return; discardDiaryDraft(); draft.value = null; saveFailed.value = false; draftConflict.value = false; message.value = "已保留原文"; error.value = false }
const fileStamp = () => `${diaryDay()}-${new Date().toTimeString().slice(0, 8).split(':').join('')}-${Date.now().toString(36).slice(-4)}`
const saveText = (name: string, text: string) => {
	const ok = writeFile(name, text); message.value = ok ? `已保存到 ${getStorageDir() || 'Download/NoriDroid/'} / ${name}` : "导出失败，请检查存储权限和剩余空间"; error.value = !ok; if (ok) emit("notify", "日记已导出"); return ok
}
const exportMd = (items: readonly DiaryEntry[]) => { if (!items.length) { message.value = "还没有可导出的日记"; return }; saveText(`nori-diary-${fileStamp()}.md`, buildDiaryMd(items)); menuOpen.value = false; entryMenu.value = false }
const backup = () => { try { saveText(`nori-diary-backup-${fileStamp()}.json`, exportDiaryJson()) } catch (e) { message.value = (e as Error).message; error.value = true }; menuOpen.value = false }
const showImport = (raw: string) => { try { error.value = false; importPreview.value = previewDiaryImport(raw); replaceExisting.value = false; restoreDeleted.value = false } catch (e) { message.value = (e as Error).message; error.value = true } }
const pickImport = () => {
	menuOpen.value = false
	const bridge = window.NoriChat as unknown as {pickDiaryBackup?: () => void} | undefined
	if (bridge?.pickDiaryBackup) {
		const w = window as unknown as {__noriDiaryPickedRes?: (json: string) => void}
		w.__noriDiaryPickedRes = raw => { delete w.__noriDiaryPickedRes; try { const r = JSON.parse(raw); if (r.ok) showImport(r.content); else message.value = r.message || "未选择文件" } catch { message.value = "备份读取失败"; error.value = true } }
		bridge.pickDiaryBackup()
	} else importInput.value?.click()
}
const readImport = async (event: Event) => {
	const input = event.target as HTMLInputElement, file = input.files?.[0]; if (!file) return
	if (file.size > 10_000_000) { message.value = "备份过大，请选择10MB以内的日记备份"; error.value = true }
	else { try { showImport(await file.text()) } catch { message.value = "文件读取失败"; error.value = true } }; input.value = ""
}
const applyImport = () => {
	if (!importPreview.value) return
	try { if (!saveText(`nori-diary-before-restore-${fileStamp()}.json`, exportDiaryJson())) return; const r = importDiaryJson(importPreview.value, replaceExisting.value, restoreDeleted.value); report(r); if (r.code === "ok") { importPreview.value = null; message.value = "日记备份已恢复" } } catch (e) { message.value = (e as Error).message; error.value = true }
}
const copyEntry = async () => {
	if (!entry.value) return
	const text = `${entry.value.date} · ${entry.value.mood}\n${entry.value.content}`
	try {
		if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text)
		else { const area = document.createElement("textarea"); area.value = text; area.style.cssText = "position:fixed;left:-9999px;top:0"; document.body.appendChild(area); area.select(); const ok = document.execCommand("copy"); area.remove(); if (!ok) throw new Error() }
		message.value = "这一页已复制"; error.value = false
	} catch { message.value = "复制失败，可以导出这一篇日记"; error.value = true }
}
const stop = () => { filling = false; cancel() }
const fillHistory = async () => {
	if (filling || busy.value || draft.value || !historyPending.value.length || !window.confirm(`为 ${historyPending.value.length} 天补写日记？\n每篇会请求一次你配置的模型，可随时停止。已有草稿将逐篇预览。`)) return
	filling = true
	try { for (const date of [...historyPending.value]) { if (!filling || props.chatBusy) break; await generate(date); if (error.value || draft.value) break } } finally { filling = false }
}
const createCard = async () => {
	if (!entry.value) return
	error.value = false
	await document.fonts?.ready
	const e = entry.value, canvas = document.createElement("canvas"), ctx = canvas.getContext("2d")!
	const font = getComputedStyle(document.querySelector(".diary-notebook")!).fontFamily
	canvas.width = 1080; ctx.font = `36px ${font}`
	const lines: string[] = []
	for (const paragraph of e.content.split("\n")) { let line = ""; for (const char of paragraph) { if (ctx.measureText(line + char).width > 850) { lines.push(line); line = char } else line += char }; lines.push(line) }
	cardExcerpt.value = lines.length > 46
	if (cardExcerpt.value) lines.splice(45, lines.length - 45, "……（卡片节选）")
	canvas.height = Math.max(1000, 490 + lines.length * 66)
	ctx.fillStyle = "#0c2333"; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.fillStyle = "#f2eee4"; ctx.fillRect(44, 44, canvas.width - 88, canvas.height - 88)
	ctx.fillStyle = "#49646a"; ctx.font = `24px ${font}`; ctx.fillText("NORi · OUR DAYS", 112, 140)
	ctx.fillStyle = "#243d47"; ctx.font = `40px ${font}`; ctx.fillText(e.date.split('-').join(' / '), 112, 222)
	ctx.font = `26px ${font}`; ctx.fillStyle = "#637c7b"; ctx.fillText(`Nori 的心情 · ${e.mood}`, 112, 280)
	ctx.font = `36px ${font}`; ctx.fillStyle = "#243d47"; lines.forEach((line, i) => ctx.fillText(line, 112, 384 + i * 66))
	ctx.strokeStyle = "#cecfc4"; ctx.beginPath(); ctx.moveTo(112, canvas.height - 180); ctx.lineTo(968, canvas.height - 180); ctx.stroke()
	ctx.font = `26px ${font}`; ctx.fillStyle = "#637c7b"; ctx.fillText("每一页，都是我们的一天。", 112, canvas.height - 122); ctx.font = "italic 36px Georgia"; ctx.fillText("Nori", 866, canvas.height - 122)
	cardDate = e.date; cardUrl.value = canvas.toDataURL("image/png")
}
const saveCard = () => {
	const name = `nori-diary-${cardDate}-${Date.now()}.png`
	const bridge = window.NoriChat as unknown as {saveDiaryImage?: (name: string, data: string) => string} | undefined
	if (bridge?.saveDiaryImage) { const r = bridge.saveDiaryImage(name, cardUrl.value); message.value = r === "ok" ? `图片已保存到 ${getStorageDir() || 'Download/NoriDroid/'}` : "图片保存失败，请检查存储权限"; error.value = r !== "ok"; if (r === "ok") { cardUrl.value = ""; emit("notify", "日记图片已保存") } }
	else { const a = document.createElement("a"); a.download = name; a.href = cardUrl.value; a.click(); message.value = "已发起图片下载"; cardUrl.value = "" }
}
watch(() => props.chatBusy, value => { if (value && busy.value) stop() })
watch([query, favoritesOnly], () => { visibleCount.value = 30 })
watch([draft, editOpen, importPreview, reviewOpen, cardUrl], () => nextTick(() => document.querySelector<HTMLElement>(".diary-dialog button")?.focus()))
const onKeydown = (event: KeyboardEvent) => {
	const dialog = document.querySelector<HTMLElement>(".diary-dialog"); if (!dialog || event.key !== "Tab") return
	const list = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), textarea, input, select, [tabindex="0"]')], first = list[0], last = list[list.length - 1]
	if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}
onMounted(() => { if (!byDate.value[today.value] && entries.value.length) choose(entries.value[0].date); window.addEventListener("nori-diary-updated", refresh); window.addEventListener("focus", refresh); document.addEventListener("keydown", onKeydown); clock = setInterval(() => { if (!document.hidden) refresh() }, 60_000) })
onBeforeUnmount(() => { if (clock) clearInterval(clock); filling = false; window.removeEventListener("nori-diary-updated", refresh); window.removeEventListener("focus", refresh); document.removeEventListener("keydown", onKeydown); delete (window as unknown as {__noriDiaryPickedRes?: unknown}).__noriDiaryPickedRes })
</script>

<style scoped lang="less">
.diary-notebook { --diary-ink: #29414a; --diary-paper: #f2eee4; color: var(--fg); min-width: 0; }
.diary-notebook * { box-sizing: border-box; }
:where(.diary-notebook) button { font: inherit; cursor: pointer; }
.diary-notebook button:disabled { cursor: default; opacity: .42; }
.diary-notebook :is(button,input,textarea,select):focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
.notebook-intro { display: flex; justify-content: space-between; gap: 16px; align-items: center; padding: 5px 0 22px; }
.eyebrow { color: var(--accent); font: 10px ui-monospace, monospace; letter-spacing: 2px; }
.notebook-intro h2 { font-size: 21px; font-weight: 500; margin: 10px 0 9px; letter-spacing: 1px; line-height: 1.5; }
.notebook-intro p { color: var(--fg-3); font-size: 11px; line-height: 1.8; margin: 0; }
.intro-book { width: 44px; height: 44px; color: var(--accent); opacity: .45; transform: rotate(-8deg); margin-right: 6px; }
.notebook-tools { display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--line); padding-bottom: 12px; margin-bottom: 14px; gap: 8px; }
.view-tabs,.tool-right { display: flex; gap: 4px; }
.view-tabs { background: rgba(0,0,0,.13); padding: 3px; border-radius: var(--ui-radius-ctl); border: 1px solid var(--line-soft); }
.view-tabs button { display: flex; align-items: center; gap: 7px; color: var(--fg-3); background: transparent; border: 0; padding: 8px 12px; font-size: 12px; border-radius: var(--ui-radius-ctl); }
.view-tabs button.active { color: var(--accent); background: var(--surface-raise); }
.view-tabs svg { width: 15px; height: 15px; }
.icon-button { display: inline-flex; align-items: center; justify-content: center; width: 36px; min-width: 36px; height: 36px; padding: 0; border: 1px solid transparent; background: transparent; color: var(--fg-3); border-radius: var(--ui-radius-ctl); }
.icon-button:hover { color: var(--accent); background: var(--surface-raise); }
.day-navigation { display: flex; align-items: center; justify-content: space-between; padding: 0 0 12px; }
.date-choice { display: flex; align-items: center; gap: 9px; border: 0; background: transparent; color: var(--fg-2); font-size: 12px; padding: 8px; }
.date-choice svg { width: 14px; height: 14px; color: var(--fg-3); }
.diary-paper { position: relative; padding: 23px 25px 17px; background: var(--diary-paper); color: var(--diary-ink); border-radius: var(--ui-radius-card); box-shadow: 0 5px 0 rgba(242,238,228,.14),0 10px 0 rgba(242,238,228,.05); min-height: 260px; overflow-wrap: anywhere; }
.diary-paper::before { content: ''; position: absolute; top: 0; left: 25px; width: 24px; height: 4px; background: #779898; }
.paper-top { display: flex; align-items: center; justify-content: space-between; min-height: 30px; }
.paper-date { font: 11px ui-monospace,monospace; letter-spacing: 2px; color: #738180; }
.paper-bookmark { width: 34px; height: 34px; background: transparent; border: 0; color: #8a958e; display: flex; align-items: center; justify-content: center; }
.paper-bookmark.saved { color: #a17c37; } .paper-bookmark.saved svg { fill: #dac18b; }
.paper-no { font: 25px Georgia,serif; color: #c3c8bb; }
.paper-caption { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; margin: 11px 0 18px; font-size: 10px; color: #74807a; }
.mood-mark { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: #526862; }
.mood-mark i,.calendar-legend i,.timeline-mood i { width: 6px; height: 6px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
.m-happy { background: #bd9a4c; } .m-calm { background: #65948b; } .m-lonely { background: #6c96ba; } .m-sad { background: #9c89b5; } .m-excited { background: #cb8364; }
.letter-content { font-size: 16px; line-height: 2.1; letter-spacing: .45px; white-space: pre-wrap; margin: 0; min-height: 126px; }
.paper-signature { display: flex; align-items: center; justify-content: flex-end; gap: 10px; padding: 18px 0 17px; color: #587974; }
.paper-signature span { width: 26px; height: 1px; background: #a4b4a6; } .paper-signature em { font: italic 24px Georgia,serif; } .paper-signature svg { width: 13px; height: 13px; }
.paper-foot { display: flex; gap: 8px; flex-wrap: wrap; justify-content: space-between; border-top: 1px solid #d8dacd; padding-top: 12px; font-size: 9px; line-height: 1.6; color: #6c7d76; }
.unwritten { min-height: 214px; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; padding: 23px 12px 9px; }
.unwritten > svg { width: 27px; height: 27px; color: #819c90; } .unwritten h3 { font-size: 17px; font-weight: 500; margin: 21px 0 12px; }
.unwritten p { color: #74847a; max-width: 270px; font-size: 12px; line-height: 1.9; margin: 0; } .unwritten > span { width: 35px; height: 1px; background: #b9c5b6; margin-top: 25px; }
.reading-actions { display: flex; flex-wrap: wrap; gap: 5px; align-items: center; margin-top: 23px; }
.write-button { display: inline-flex; justify-content: center; align-items: center; gap: 8px; border: 1px solid var(--accent-strong); background: var(--accent); color: #092732; border-radius: var(--ui-radius-ctl); font-size: 12px; font-weight: 600; min-height: 39px; padding: 10px 14px; line-height: 1.4; }
.reading-actions > .write-button { flex: 1; margin-right: 4px; } .write-button svg { width: 16px; height: 16px; }
.small-button { color: var(--fg-2); border: 1px solid var(--line); background: var(--surface-raise); border-radius: var(--ui-radius-ctl); padding: 9px 12px; font-size: 12px; min-height: 36px; }
.text-button { background: transparent; border: 0; color: var(--accent); font-size: 12px; padding: 8px; }
.annotation { margin-top: 18px; border-left: 2px solid var(--line); padding-left: 13px; }
.annotation > button { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: 11px; color: var(--fg-3); background: transparent; border: 0; }
.annotation svg { width: 13px; height: 13px; } .annotation p { font-size: 12px; color: var(--fg-2); line-height: 1.9; white-space: pre-wrap; overflow-wrap: anywhere; margin: 8px 0; } .annotation textarea { margin: 10px 0; }
.calendar-toggle { display: flex; justify-content: space-between; gap: 8px; margin-top: 22px; border-top: 1px solid var(--line); padding-top: 14px; }
.calendar-toggle button { border: 0; background: transparent; color: var(--fg-3); font-size: 11px; padding: 6px 0; display: flex; gap: 8px; align-items: center; }
.calendar-toggle button:last-child:not(:first-child) { color: var(--accent); } .calendar-toggle svg { width: 14px; height: 14px; } .rotated { transform: rotate(180deg); }
.notebook-calendar { margin-top: 10px; padding: 12px; border: 1px solid var(--line-soft); border-radius: var(--ui-radius-card); background: rgba(0,0,0,.09); }
.month-control { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.month-picker { position: relative; padding: 8px 12px; color: var(--fg-2); font-size: 13px; } .month-picker input { position: absolute; inset: 0; opacity: 0; width: 100%; cursor: pointer; }
.calendar-grid { display: grid; grid-template-columns: repeat(7,minmax(0,1fr)); gap: 5px; } .week { font-size: 10px; color: var(--fg-dim); text-align: center; margin-bottom: 7px; } .week span { padding: 5px 0; }
.calendar-day { min-height: 34px; aspect-ratio: 1.1; position: relative; border: 1px solid transparent; border-radius: var(--ui-radius-ctl); color: var(--fg-3); background: transparent; font-size: 12px; display: flex; align-items: center; justify-content: center; }
.calendar-day.written { color: var(--fg); background: rgba(148,163,184,.045); } .calendar-day.is-today span { color: var(--accent); font-weight: bold; } .calendar-day.chosen { background: rgba(79,184,204,.13); border-color: var(--accent); color: var(--accent); }
.calendar-day i { position: absolute; width: 4px; height: 4px; border-radius: 50%; bottom: 4px; left: calc(50% - 2px); } .calendar-day .pending-dot { background: none; border: 1px solid var(--fg-dim); }
.calendar-legend { display: flex; flex-wrap: wrap; gap: 12px; justify-content: center; font-size: 9px; color: var(--fg-3); margin: 15px 0; } .calendar-legend span { display: inline-flex; gap: 4px; align-items: center; }
.calendar-summary { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding-top: 12px; border-top: 1px solid var(--line); font-size: 10px; color: var(--fg-3); }
.calendar-summary b { color: var(--fg-2); font-weight: 500; } .calendar-summary button { display: flex; gap: 2px; align-items: center; background: none; border: 0; color: var(--accent); font-size: 10px; padding: 5px 0; } .calendar-summary svg { width: 12px; height: 12px; }
.notice { font-size: 11px; line-height: 1.8; color: var(--fg-2); border-left: 2px solid var(--accent); background: rgba(79,184,204,.06); padding: 9px 11px; margin-bottom: 12px; overflow-wrap: anywhere; }
.notice.error { border-color: #c98c83; color: #e0afa4; background: rgba(201,140,131,.06); } .notice button { background: transparent; border: 0; color: var(--accent); margin-left: 8px; padding: 3px; font-size: 11px; }
.pending-strip { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px; font-size: 10px; padding: 0 0 14px; color: var(--fg-3); } .pending-strip span { display: flex; align-items: center; gap: 6px; } .pending-strip svg { width: 13px; height: 13px; } .pending-strip button { border: 0; background: none; color: var(--accent); font-size: 11px; padding: 6px 0; }
.management,.entry-menu { display: grid; grid-template-columns: repeat(2,minmax(0,1fr)); border: 1px solid var(--line); border-radius: var(--ui-radius-ctl); padding: 6px; margin: 0 0 14px; gap: 2px; background: var(--surface-raise); }
.management button,.entry-menu button { border: 0; border-radius: var(--ui-radius-ctl); background: none; color: var(--fg-2); padding: 12px 8px; font-size: 11px; display: flex; align-items: center; gap: 8px; text-align: left; } .management button:hover,.entry-menu button:hover { background: rgba(79,184,204,.08); } .entry-menu { margin-top: 10px; } .diary-notebook .danger { color: #db9b91; }
.notebook-footer { display: flex; gap: 11px; align-items: center; justify-content: center; color: var(--fg-dim); font-size: 9px; letter-spacing: 1px; margin: 28px 0 6px; } .notebook-footer span { width: 18px; height: 1px; background: var(--line); }
.search-field { display: flex; gap: 9px; align-items: center; background: rgba(0,0,0,.12); border: 1px solid var(--line); border-radius: var(--ui-radius-ctl); padding: 3px 10px; margin-bottom: 16px; color: var(--fg-3); } .search-field input { flex: 1; min-width: 0; border: 0; padding: 11px 0; background: transparent; color: var(--fg); font: inherit; font-size: 12px; }
.timeline-filters { display: flex; align-items: center; gap: 6px; padding-bottom: 12px; } .timeline-filters button { display: flex; align-items: center; gap: 5px; background: none; color: var(--fg-3); border: 1px solid transparent; border-radius: var(--ui-radius-pill); font-size: 10px; padding: 7px 9px; } .timeline-filters button.active { color: var(--accent); border-color: var(--line); background: rgba(79,184,204,.07); } .timeline-filters svg { width: 12px; height: 12px; } .timeline-filters .today-link { margin-left: auto; padding-right: 0; color: var(--accent); }
.timeline-entry { display: flex; gap: 16px; align-items: center; text-align: left; width: 100%; padding: 19px 0; border: 0; border-bottom: 1px solid var(--line-soft); background: transparent; color: var(--fg-2); } .timeline-date { display: flex; flex-direction: column; gap: 5px; width: 48px; flex-shrink: 0; text-align: center; } .timeline-date strong { font: 29px Georgia,serif; color: var(--fg); } .timeline-date small { font-size: 9px; color: var(--fg-dim); }
.timeline-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 9px; } .timeline-mood { display: flex; align-items: center; gap: 6px; font-size: 10px; color: var(--fg-3); } .timeline-mood svg { width: 12px; height: 12px; margin-left: auto; color: #bd9a4c; } .timeline-excerpt { font-size: 12px; line-height: 1.9; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow-wrap: anywhere; } .timeline-entry > svg { width: 13px; height: 13px; color: var(--fg-dim); }
.timeline-empty { text-align: center; padding: 55px 20px; color: var(--fg-3); } .timeline-empty > svg { width: 36px; height: 36px; opacity: .6; } .timeline-empty h3 { font-size: 15px; color: var(--fg-2); font-weight: 400; margin-top: 20px; } .timeline-empty p { font-size: 11px; line-height: 1.9; margin-bottom: 22px; } .load-more { width: 100%; background: none; border: 0; color: var(--accent); font-size: 12px; padding: 18px; }
.memory-day { display: flex; gap: 10px; width: 100%; align-items: center; background: none; border: 1px solid var(--line-soft); padding: 14px; margin-top: 16px; color: var(--fg-3); text-align: left; border-radius: var(--ui-radius-card); } .memory-day span { flex: 1; font-size: 11px; line-height: 1.8; overflow-wrap: anywhere; } .memory-day small { display: block; font-size: 9px; color: var(--accent); margin-bottom: 3px; }
.diary-overlay { position: fixed; inset: 0; z-index: 100; background: rgba(3,10,18,.83); display: flex; align-items: center; justify-content: center; padding: 18px; }
.diary-dialog { width: min(100%,490px); max-height: 88vh; overflow-y: auto; overscroll-behavior: contain; background: var(--surface); border: 1px solid var(--line); padding: 23px; border-radius: var(--ui-radius-panel); box-shadow: 0 18px 80px rgba(0,0,0,.4); }
.dialog-heading { display: flex; gap: 12px; align-items: center; justify-content: space-between; } .dialog-heading h3 { font-size: 17px; font-weight: 500; line-height: 1.6; margin: 7px 0; color: var(--fg); }
.dialog-hint { color: var(--fg-3); font-size: 11px; line-height: 1.9; margin: 13px 0 18px; } .draft-preview { padding: 20px; border-radius: var(--ui-radius-card); background: var(--diary-paper); color: var(--diary-ink); } .draft-preview p { font-size: 14px; line-height: 2; white-space: pre-wrap; overflow-wrap: anywhere; margin-bottom: 0; }
.dialog-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; } .dialog-error { font-size: 12px; color: #e0afa4; line-height: 1.7; }
.diary-notebook textarea,.diary-dialog select { width: 100%; background: rgba(0,0,0,.12); border: 1px solid var(--line); border-radius: var(--ui-radius-ctl); color: var(--fg); font: inherit; font-size: 13px; line-height: 1.9; padding: 12px; resize: vertical; }
.field-label { display: block; margin: 16px 0 9px; font-size: 11px; color: var(--fg-3); } .check-field { display: flex; gap: 10px; align-items: center; color: var(--fg-2); font-size: 12px; padding: 10px 0; } .check-field input { accent-color: var(--accent); width: 16px; height: 16px; }
.review-numbers { display: grid; grid-template-columns: repeat(3,1fr); gap: 8px; padding: 25px 0; border-bottom: 1px solid var(--line); margin-bottom: 20px; } .review-numbers div { display: flex; align-items: center; flex-direction: column; gap: 10px; } .review-numbers strong { font: 31px Georgia,serif; color: var(--accent); } .review-numbers span { font-size: 10px; color: var(--fg-3); }
.mood-distribution { display: flex; align-items: center; gap: 14px; padding: 8px 0; font-size: 11px; color: var(--fg-2); } .mood-distribution small { width: 15px; color: var(--fg-3); text-align: right; } .mood-track { flex: 1; height: 5px; background: var(--line-soft); border-radius: var(--ui-radius-pill); overflow: hidden; } .mood-track i { display: block; height: 100%; }
.share-card { display: block; width: 100%; margin-top: 15px; max-height: 63vh; object-fit: contain; }
.sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
@media (max-width: 370px) { .notebook-intro h2 { font-size: 18px; } .intro-book { display: none; } .diary-paper { padding: 19px 18px 15px; } .letter-content { font-size: 15px; } .reading-actions { gap: 1px; } .reading-actions .icon-button { width: 30px; min-width: 30px; } .reading-actions .write-button { font-size: 11px; padding: 9px 10px; } .diary-dialog { padding: 17px; } .calendar-grid { gap: 3px; } .calendar-legend { gap: 9px; } }
</style>
