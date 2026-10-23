import assert from 'node:assert/strict'
import {mkdtempSync, readdirSync, readFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {pathToFileURL} from 'node:url'
const root = resolve(import.meta.dirname, '..')
const dir = readdirSync(join(root, 'node_modules/.pnpm')).find(d => d.startsWith('esbuild@'))
const {build} = await import(pathToFileURL(join(root, 'node_modules/.pnpm', dir, 'node_modules/esbuild/lib/main.js')))
const outfile = join(mkdtempSync(join(tmpdir(), 'nori-diary-test-')), 'diary.mjs')
await build({entryPoints: [join(root, 'src/services/nori-diary.ts')], bundle: true, format: 'esm', platform: 'node', outfile, logLevel: 'silent'})
const files = new Map()
// Use the native production allowlist, so a memory-only bridge fails diary tests.
const nativePolicy = readFileSync(join(root, '../app/src/main/java/com/noridroid/ConditionalFileWrite.kt'), 'utf8')
const supportedNames = new Set([...nativePolicy.match(/supportedNames = setOf\(([^)]+)\)/)[1].matchAll(/"([^"]+)"/g)].map(m => m[1]))
const nativeBridge = readFileSync(join(root, '../app/src/main/java/com/noridroid/ChatBridge.kt'), 'utf8')
assert.match(nativeBridge, /fun writeFileIfUnchanged[^]*?synchronized\(FILE_LOCK\)\s*\{\s*ConditionalFileWrite\.run\(/)
let writeFailure = '', writeReason = 'err:disk-full', readFailure = '', race = null, backupRace = null, writes = 0
const bridge = {
 readFile: name => files.get(name) ?? '',
 readFileState: name => JSON.stringify(name === readFailure ? {status:'error', message:'blocked'} : {status:files.has(name)?'ok':'missing',content:files.get(name)??''}),
 writeFile: (name, content) => { writes++; if(name === writeFailure) return writeReason; files.set(name,content); return 'ok' },
 writeFileIfUnchanged: (name, expected, content) => { if(!supportedNames.has(name)) return 'err:unsupported'; if(name===readFailure) return 'err:read'; if(race) {const action = race;race=null;action()}; if(name==='nori-diary.json.bak'&&backupRace){const action=backupRace;backupRace=null;action()}; if((files.get(name)??'')!==expected) return 'conflict';return bridge.writeFile(name,content) },
}
globalThis.window = {NoriChat:bridge}
const diary = await import(pathToFileURL(outfile))
const MAIN='nori-diary.json', BAK=MAIN+'.bak', SRC='nori-diary-src.json'
const today=diary.diaryDay(), yesterday=diary.shiftDiaryDay(today,-1)
const [y,m,d] = today.split('-').map(Number)
const ts = new Date(y,m-1,d,0,0).getTime()
const user=(content='今天面试顺利', at=ts+1000)=>({role:'user',content,ts:at})
const assistant=(content='替你开心',at=ts+2000)=>({role:'assistant',content,ts:at})
const stored=(date=today, content='原日记')=>({date,content,mood:'平静',msgCount:1,createdAt:ts})
const seed=(entries=[])=>files.set(MAIN,JSON.stringify({entries}))
const chat=(items=[user(),assistant()])=>files.set('chat.json',JSON.stringify({v:1,cutoff:0,msgs:items}))
const ok=async()=>JSON.stringify({content:'面试结束后，你终于松了一口气。我也替你开心，这一点小小的好消息，想替我们记住。',mood:'开心'})
const reset=()=>{files.clear();writeFailure='';writeReason='err:disk-full';readFailure='';race=null;backupRace=null;writes=0;diary.__resetDiaryCacheForTest()}
let passed=0
const test=async(name,fn)=>{reset();await fn();passed++;console.log('PASS '+name)}
await test('overwrite failure preserves old prose, primary and backup',async()=>{
 seed([stored()]);files.set(BAK,files.get(MAIN));chat();const r=await diary.createDiaryDraft(today,ok);writeFailure=MAIN
 assert.equal(diary.saveDiaryDraft(r.draft).code,'save_failed');assert.equal(diary.listDiary()[0].content,'原日记');assert.equal(files.get(MAIN),files.get(BAK))
 writeFailure='';assert.equal(diary.saveDiaryDraft(r.draft).code,'ok');assert.equal(diary.listDiary()[0].mood,'开心')
})
await test('a first-save failure creates neither a visible entry nor a backup',async()=>{chat();writeFailure=MAIN;assert.equal(await diary.writeTodayDiary(ok),'failed');assert.equal(diary.listDiary().length,0);assert.equal(files.has(BAK),false)})
await test('read errors block saves and recover without restarting',async()=>{seed([stored()]);chat();readFailure=MAIN;assert.equal(diary.diaryHealth().blocked,true);assert.equal((await diary.createDiaryDraft(today,ok)).code,'read_blocked');assert.equal(writes,0);readFailure='';assert.equal(diary.listDiary()[0].content,'原日记')})
await test('invalid primary uses backup, preserves damaged bytes on commit',async()=>{files.set(MAIN,'{broken');files.set(BAK,JSON.stringify({entries:[stored()]}));chat();const r=await diary.createDiaryDraft(today,ok);assert.equal(diary.saveDiaryDraft(r.draft).code,'ok');assert.ok([...files].some(([n,v])=>n.includes('.before-')&&v==='{broken'));assert.equal(diary.listDiary().length,1)})
await test('future version cannot be downgraded through an older backup',()=>{files.set(MAIN,JSON.stringify({schemaVersion:99,entries:[]}));files.set(BAK,JSON.stringify({entries:[stored()]}));assert.equal(diary.diaryHealth().blocked,true);assert.equal(diary.clearDiary(),false);assert.equal(writes,0)})
await test('malformed entry and suppression metadata stay read-only',()=>{files.set(MAIN,JSON.stringify({entries:[{...stored(),date:'2026-02-30'}]}));assert.equal(diary.diaryHealth().blocked,true);files.set(MAIN,JSON.stringify({entries:[],suppressed:[]}));assert.equal(diary.diaryHealth().blocked,true)})
await test('failed deletion leaves prose and suppression unchanged',()=>{seed([stored()]);writeFailure=MAIN;assert.equal(diary.deleteDiaryEntry(today),false);assert.equal(diary.listDiary().length,1);assert.equal(diary.diarySuppressed(today),false)})
await test('deletion survives reopen and prevents automatic resurrection',async()=>{seed([stored()]);chat();assert.equal(diary.deleteDiaryEntry(today),true);diary.__resetDiaryCacheForTest();let calls=0;assert.equal(await diary.ensureDiary(async()=>{calls++;return ok()}),null);assert.equal(calls,0);assert.equal(diary.diarySuppressed(today),true)})
await test('late generation cannot undo deletion or a user edit',async()=>{
 seed([stored()]);chat();let resolveOutput;const task=diary.createDiaryDraft(today,()=>new Promise(resolve=>resolveOutput=resolve));diary.deleteDiaryEntry(today);resolveOutput(await ok());const r=await task;assert.equal(diary.saveDiaryDraft(r.draft).code,'conflict');assert.equal(diary.listDiary().length,0)
})
await test('late generation cannot overwrite notes or favorites',async()=>{seed([stored()]);chat();const r=await diary.createDiaryDraft(today,ok);diary.updateDiaryEntry(today,{favorite:true});assert.equal(diary.saveDiaryDraft(r.draft).code,'conflict');assert.equal(diary.listDiary()[0].favorite,true)})
await test('CAS merges an unrelated day written by another window',async()=>{
 seed([stored()]);chat();const r=await diary.createDiaryDraft(today,ok);race=()=>files.set(MAIN,JSON.stringify({entries:[stored(),stored(yesterday,'另一窗口日记')]}));assert.equal(diary.saveDiaryDraft(r.draft).code,'ok');assert.equal(diary.listDiary().length,2)
})
await test('sampling covers first/last while counting all 100 user messages',async()=>{
 chat(Array.from({length:100},(_,i)=>user('话题'+i,ts+1000+i*1000)));let request;const r=await diary.createDiaryDraft(today,async(system,material)=>{request=JSON.parse(material);assert.ok(!system.includes('话题99'));return ok()});assert.equal(r.draft.entry.sourceUserCount,100);assert.ok(r.draft.entry.sampleCount<=30);assert.ok(request.conversations.some(m=>m.text==='话题0'));assert.ok(request.conversations.some(m=>m.text==='话题99'))
})
await test('assistant text is preserved, partial duplicates do not inflate counts',async()=>{chat([user(),assistant('完整回复')]);assert.equal(diary.bufferDiarySource([user(),assistant('完整')]),true);const info=diary.diarySourceInfo(today);assert.equal(info.userCount,1);assert.equal(info.assistantCount,1);assert.equal(info.items.find(m=>m.role==='assistant').content,'完整回复')})
await test('source writes reload other windows and handle CAS conflict',()=>{chat([]);diary.bufferDiarySource([user('早上',ts+1)]);race=()=>files.set(SRC,JSON.stringify([user('早上',ts+1),assistant('别的窗口',ts+2)]));assert.equal(diary.bufferDiarySource([user('晚上',ts+3)]),true);assert.equal(diary.diarySourceInfo(today).items.length,3)})
await test('source save/read failure explicitly prevents trimming',()=>{writeFailure=SRC;assert.equal(diary.bufferDiarySource([user()]),false);writeFailure='';files.set(SRC,'broken');assert.equal(diary.bufferDiarySource([user()]),false);assert.equal(files.get(SRC),'broken')})
await test('no conversation never calls model; output errors preserve the original',async()=>{chat([]);let calls=0;assert.equal((await diary.createDiaryDraft(today,async()=>{calls++;return ok()})).code,'no_source');assert.equal(calls,0);chat();seed([stored()]);assert.equal((await diary.createDiaryDraft(today,async()=>'{bad')).code,'invalid_output');assert.equal(diary.listDiary()[0].content,'原日记')})
await test('network errors remain distinct from storage errors',async()=>{chat();assert.equal((await diary.createDiaryDraft(today,async()=>{throw Error('HTTP 401')})).code,'request_failed')})
await test('cancellation discards late model output',async()=>{chat();const ac=new AbortController();const r=await diary.createDiaryDraft(today,async()=>{ac.abort();return ok()},ac.signal);assert.equal(r.code,'cancelled');assert.equal(diary.listDiary().length,0)})
await test('legacy explicit mood and JSON are accepted without guessing words',()=>{assert.equal(diary.parseDiaryOutput('虽然难过，后来开心起来。\n平静').mood,'平静');assert.equal(diary.parseDiaryOutput('正文里开心和难过都有。'),null);assert.equal(diary.parseDiaryOutput('开心'),null);assert.equal(diary.parseDiaryOutput('{"content":"","mood":"开心"}'),null)})
await test('automatic backlog handles older dates, one model call per pass',async()=>{
 const old=diary.shiftDiaryDay(today,-3), oldTs=new Date(...old.split('-').map((v,i)=>Number(v)-(i===1?1:0)),12).getTime();chat([user('旧对话',oldTs),user()]);let calls=0;assert.equal(await diary.ensureDiary(async()=>{calls++;return ok()}),old);assert.equal(calls,1);assert.equal(diary.listDiary()[0].status,'final')
})
await test('existing today entry never regenerates automatically',async()=>{seed([stored()]);chat();let calls=0;assert.equal(await diary.ensureDiary(async()=>{calls++;return ok()}),null);assert.equal(calls,0)})
await test('automatic failures cool down instead of repeated requests',async()=>{chat();let calls=0;const fail=async()=>{calls++;throw Error('offline')};await diary.ensureDiary(fail);await diary.ensureDiary(fail);assert.equal(calls,1)})
await test('Markdown contains only selected diaries and distinguishes old counts',()=>{const md=diary.buildDiaryMd([stored()]);assert.ok(md.includes('原日记'));assert.ok(md.includes(today));assert.ok(!md.includes('长期记忆'));assert.ok(!md.includes('聊了 1'))})
await test('backup import preserves deletions unless explicitly restored',async()=>{seed([stored()]);chat();const backup=diary.exportDiaryJson();diary.deleteDiaryEntry(today);const p=diary.previewDiaryImport(backup);assert.equal(diary.importDiaryJson(p).code,'ok');assert.equal(diary.listDiary().length,0);assert.equal(diary.importDiaryJson(diary.previewDiaryImport(backup),false,true).code,'ok');assert.equal(diary.listDiary().length,1)})
await test('backup preview detects changes before importing',()=>{seed([stored()]);const p=diary.previewDiaryImport(JSON.stringify({entries:[stored(yesterday)]}));diary.updateDiaryEntry(today,{note:'新的批注'});assert.equal(diary.importDiaryJson(p).code,'conflict');assert.equal(diary.listDiary()[0].note,'新的批注')})
await test('clear suppresses pending dates and survives process cache reset',async()=>{chat();assert.equal(diary.clearDiary(),true);diary.__resetDiaryCacheForTest();assert.deepEqual(diary.pendingDiaryDates(),[])})
await test('calendar arithmetic covers leap day and DST rather than 24-hour subtraction',()=>{assert.equal(diary.shiftDiaryDay('2024-03-01',-1),'2024-02-29');assert.equal(diary.shiftDiaryDay('2026-01-01',-1),'2025-12-31');const original=process.env.TZ ?? Intl.DateTimeFormat().resolvedOptions().timeZone;process.env.TZ='America/New_York';assert.equal(diary.shiftDiaryDay('2026-03-09',-1),'2026-03-08');assert.equal(diary.shiftDiaryDay('2026-11-02',-1),'2026-11-01');if(original===undefined)delete process.env.TZ;else process.env.TZ=original})
await test('generated preview survives failed automatic save without another model call',async()=>{
 chat();writeFailure=MAIN;let calls=0;await diary.ensureDiary(async()=>{calls++;return ok()});const pending=diary.pendingDiaryDraft();assert.ok(pending.draft);assert.equal(pending.saveFailed,true);writeFailure='';await diary.ensureDiary(async()=>{calls++;return ok()});assert.equal(calls,1);assert.equal(diary.saveDiaryDraft(pending.draft).code,'ok');assert.equal(diary.pendingDiaryDraft().draft,null)
})
await test('a retained preview prevents overlapping generation until explicitly discarded',async()=>{
 chat();await diary.createDiaryDraft(today,ok);assert.equal((await diary.createDiaryDraft(today,ok)).code,'busy');diary.discardDiaryDraft();assert.equal((await diary.createDiaryDraft(today,ok)).code,'ok')
})
await test('UTF-8 BOM legacy backup migrates without losing the original bytes',async()=>{
 seed([stored()]);files.set(MAIN,'\ufeff'+files.get(MAIN));chat();const generated=await diary.createDiaryDraft(today,ok);assert.equal(diary.saveDiaryDraft(generated.draft).code,'ok');assert.ok([...files].some(([n,v])=>n.includes('.before-')&&v.startsWith('\ufeff')))
})
await test('an unchanged historical draft finalizes without an extra model request',async()=>{
 const yesterdayTs=new Date(y,m-1,d-1,12).getTime();chat([user('昨日片段',yesterdayTs)]);const generated=await diary.createDiaryDraft(yesterday,ok);generated.draft.entry.status='draft';diary.saveDiaryDraft(generated.draft);let calls=0;assert.equal(await diary.ensureDiary(async()=>{calls++;return ok()}),yesterday);assert.equal(calls,0);assert.equal(diary.listDiary()[0].status,'final')
})
await test('user-kept prose is never included in the automatic rewrite backlog',()=>{
 const yesterdayTs=new Date(y,m-1,d-1,12).getTime();seed([{...stored(yesterday),status:'draft',editedByUser:true}]);chat([user('昨日片段',yesterdayTs)]);assert.deepEqual(diary.pendingDiaryDates(),[])
})
await test('source overflow retains the old file and tells callers not to trim',()=>{
 const original=JSON.stringify([user()]);files.set(SRC,original);const huge=Array.from({length:100},(_,i)=>user('长'.repeat(21000),ts+10000+i));assert.equal(diary.bufferDiarySource(huge),false);assert.equal(files.get(SRC),original)
})
await test('a delayed backup writer cannot undo a newer deletion snapshot',async()=>{
 seed([stored()]);chat();const generated=await diary.createDiaryDraft(today,ok)
 backupRace=()=>{const newer={schemaVersion:1,revision:20,entries:[],suppressed:{[today]:Date.now()}};files.set(MAIN,JSON.stringify(newer));files.set(BAK,JSON.stringify(newer))}
 assert.equal(diary.saveDiaryDraft(generated.draft).code,'ok');assert.ok(JSON.parse(files.get(BAK)).suppressed[today]);assert.equal(diary.listDiary().length,0)
})
await test('native file contract allows primary, backup and source persistence',async()=>{
 chat(); assert.equal(await diary.writeTodayDiary(ok),'ok'); assert.equal(files.get(MAIN),files.get(BAK)); assert.equal(diary.bufferDiarySource([user()]),true); assert.ok(files.has(SRC))
})
await test('unsupported native interface is not reported as missing permission',async()=>{
 chat();const r=await diary.createDiaryDraft(today,ok);writeFailure=MAIN;writeReason='err:unsupported'
 const saved=diary.saveDiaryDraft(r.draft);assert.equal(saved.code,'save_failed');assert.match(saved.message,/原生接口/);assert.doesNotMatch(saved.message,/权限/);assert.ok(diary.pendingDiaryDraft().draft)
 assert.equal(diary.pendingDiaryDraft().failure.message,saved.message)
 writeFailure='';assert.equal(diary.saveDiaryDraft(r.draft).code,'ok')
 assert.equal(diary.pendingDiaryDraft().failure,null)
})
await test('disk full and permission errors have different retry guidance',async()=>{
 chat();const r=await diary.createDiaryDraft(today,ok);writeFailure=MAIN
 assert.match(diary.saveDiaryDraft(r.draft).message,/空间不足/);writeReason='err:perm';assert.match(diary.saveDiaryDraft(r.draft).message,/系统拒绝/)
})
await test('BOM-prefixed future schema cannot downgrade through a valid backup',()=>{
 const future='\uFEFF'+JSON.stringify({schemaVersion:99,entries:[]});files.set(MAIN,future);files.set(BAK,JSON.stringify({entries:[stored()]}))
 assert.equal(diary.diaryHealth().blocked,true);assert.equal(diary.clearDiary(),false);assert.equal(files.get(MAIN),future);assert.equal(writes,0)
})
await test('chat sources use the validated snapshot without a second lossy read',()=>{
 chat();const original=bridge.readFile;bridge.readFile=name=>{if(name==='chat.json') throw Error('second read failed');return original(name)}
 try {assert.equal(diary.diarySourceInfo(today).userCount,1)} finally {bridge.readFile=original}
})
await test('BOM-prefixed source and chat files remain readable',()=>{
 files.set(SRC,'\uFEFF'+JSON.stringify([user()]));files.set('chat.json','\uFEFF'+JSON.stringify({msgs:[assistant()]}))
 const info=diary.diarySourceInfo(today);assert.equal(info.error,undefined);assert.equal(info.userCount,1);assert.equal(info.assistantCount,1);assert.equal(diary.bufferDiarySource([user()]),true)
})
await test('editing the displayed snapshot cannot overwrite an unseen newer edit',()=>{
 seed([stored()]);const displayed=diary.listDiary()[0];assert.equal(diary.updateDiaryEntry(today,{content:'另一窗口修改'}).code,'ok')
 const expected=diary.diaryEntryToken(today,displayed);assert.equal(diary.updateDiaryEntry(today,{content:'过期页面修改'},expected).code,'conflict');assert.equal(diary.listDiary()[0].content,'另一窗口修改')
})
await test('automatic finalization tolerates deletion during source inspection',async()=>{
 const oldTs=new Date(y,m-1,d-1,12).getTime();chat([user('昨天的话',oldTs)])
 const fingerprint=diary.diarySourceInfo(yesterday).fingerprint
 seed([{...stored(yesterday),status:'draft',sourceFingerprint:fingerprint}])
 const original=bridge.readFileState;let reads=0,calls=0
 bridge.readFileState=name=>{if(name==='chat.json'&&++reads===2)files.set(MAIN,JSON.stringify({schemaVersion:1,revision:2,entries:[],suppressed:{[yesterday]:Date.now()}}));return original(name)}
 try {assert.equal(await diary.ensureDiary(async()=>{calls++;return ok()}),null);assert.equal(calls,0);assert.equal(diary.listDiary().length,0);assert.equal(diary.diarySuppressed(yesterday),true)} finally {bridge.readFileState=original}
})
console.log(`\n${passed} diary regression scenarios passed.`)
