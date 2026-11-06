# App.vue 维护地图

本页用于后续功能修改、排查和评审。先按功能查主模块，再检查同一行的联动与回归；模块已拆开不代表这些联动已经消失。

下文的 `src/`、`scripts/`、`tmp-memcheck/` 均相对仓库内 `app/android/web-src/`。运行 Web 命令也在该目录执行。

## 真实入口与职责边界

- 主页面入口是 `src/main.ts` → `src/App.vue`。不要修改仓库根目录的旧 `App.vue`。
- 悬浮模型入口是 `src/float/main.ts` → `src/float/FloatApp.vue`；悬浮聊天入口是 `src/float/bubble.ts` → `src/float/BubbleApp.vue`。共享设置、聊天、模型、TTS 或记忆服务的变动要检查这两个入口。
- `components/` 负责展示和用户事件；`composables/` 负责对应功能的响应式状态与操作；`services/` 负责传输、存储、模型、音频和业务规则。组件通过 props/events 接线，不各自维护第二份业务状态。
- `App.vue` 保留页面组合、跨功能回调、watch/hook 注册位置，以及启动、前后台和卸载编排。保留这些接线是为了让顺序可见，不以进一步压低行数为目标。
- `vite.config.ts` 同时构建 main、float、bubble，输出到 `app/android/app/src/main/assets/web/`。这是生成目录，修改源文件后通过构建更新，不直接编辑生成包。
- Android 接口位于 `app/android/app/src/main/java/com/noridroid/`，重点是 `ChatBridge.kt`、`MainActivity.kt`、`FloatService.kt`、`PomodoroEngine.kt`。

## 按功能查影响范围

表中测试名指对应 `.mjs` 文件。以 `test-` 开头的条目位于 `scripts/`，其余条目位于 `tmp-memcheck/`；正式统一入口见下一节。

| 要改的功能 | 主要位置 | 必须联查 | 重点回归 |
| --- | --- | --- | --- |
| 文字聊天、图片、戳戳、停止、排队 | `components/ChatPanel.vue`、`composables/useChatSession.ts`、`services/chat/` | `useSpeechFeedback`、`useReplyReactions`、`useDiaryScheduler`、`useAppVisibility`、`services/memory/context.ts`、`services/nori-diary.ts`；悬浮聊天另查 `float/BubbleApp.vue` | `test-chat-session`、`test-app-resume`、`probe-chat-image-poke`、`run-chat-tests`、`run-marker-tests` |
| 记忆、总结、目标、导入导出 | `components/MemoryPanel.vue`、`composables/useMemoryPanel.ts`、`services/memory/` | `App.vue` 中 `analyzeAfterReply`、聊天上下文预算与安全裁剪、前后台落盘及恢复、悬浮聊天的共享历史 | `run-tests`、`run-memory-lifecycle-tests`、`run-memory-recall-tests`、`run-memory-collapse-tests`、`e2e-mem-menu`、`e2e-mem-gate`；按变更补选记忆专项 |
| 自动/手动日记 | `components/DiaryPanel.vue`、`composables/useDiary.ts`、`useDiaryScheduler.ts`、`services/nori-diary.ts` | 两种聊天流的忙状态、日记源缓冲、存储刷新、后台中止和面板打开时的调度 | `test-diary`、`test-diary-scheduler`、`test-app-visibility`、`test-app-resume` |
| 模型选择、下载、重挂 | `components/ModelPanels.vue`、`composables/useModelControls.ts`、`services/live2d/modelStore.ts` | 画布变换、注视状态、模型专属触摸区、动作/表情、WebGL 恢复、`float/FloatApp.vue` 的模型读取 | `probe-model-pick-persist`、`probe-model-download-gate`、`test-stage-interaction`、`test-canvas-transform` |
| 拖拽缩放、触摸命中、抚摸 | `useCanvasTransform.ts`、`useTouchEditor.ts`、`useStageInteraction.ts`、`components/TouchSettingsPage.vue` | 模型切换、布局版本、渲染分辨率、双指手势与触摸编辑的事件占用、背景触摸反馈、触摸回复忙状态 | `test-canvas-transform`、`test-stage-interaction`、`e2e-touch-settings`、`probe-chat-image-poke` |
| 背景、帧率、渲染分辨率 | `composables/useStageRendering.ts`、`services/background-controller.ts`、`services/live2d/` | 模型画布布局与命中坐标、前后台组合暂停、足光采样、悬浮窗独立分辨率设置 | `run-render-lifecycle-tests`、`test-stage-interaction`、`test-app-visibility`、`test-app-resume`；真实模型/性能另外实测 |
| TTS、音色、朗读提示、口型 | `components/TtsSettingsPage.vue`、`useVoiceSettings.ts`、`useSpeechFeedback.ts`、`services/tts/` | 两种聊天流的停止/完成、后台停止、音色防抖保存、授权门、口型按真实播放状态开关 | `test-speech-feedback`、`run-tts-tests`、`run-lipsync-tests`、`e2e-tts-hint`、`probe-clone-gate`、`test-app-resume` |
| BGM、音效、安静模式 | `composables/useAudioControls.ts`、`services/bgm.ts`、`services/sfx.ts`、`services/ambient.ts` | 番茄钟专注静音/恢复、启动时恢复顺序、前后台暂停、资源下载与实际文件状态 | `probe-bgm-state`、`probe-sfx-download`、`probe-pomodoro`、`test-app-visibility`、`test-app-resume` |
| 番茄钟及统计 | `usePomodoro.ts`、`components/PomodoroPanel.vue`、`PomodoroWidget.vue`、`PomodoroStatsPanel.vue`、`services/pomodoro.ts`、`services/pomo-stats.ts` | 原生 `PomodoroEngine.kt`、安静模式、提醒、通知入口、聊天专注提示、跨日刷新和进程重启恢复 | `test-pomodoro`、`probe-pomodoro`、`test-chat-session`；原生计时规则改动另跑对应 Android 测试 |
| 设置、默认值、保存与迁移 | `components/SettingsPage.vue`、`composables/useAppSettings.ts`、`services/chat/index.ts` 的 `Settings`/`DEFAULT_SETTINGS`/`loadSettings` | 所有消费者、番茄钟配置、两个悬浮入口；新增字段按下方全链路检查 | `test-app-settings`、`probe-thinking-default`、`probe-ui-font`、相关功能专项及重启恢复 |
| 悬浮权限、所有文件权限、前后台 | `useFloatControls.ts`、`useStorageAccess.ts`、`useAppVisibility.ts`、`services/renderPause.ts` | 原生生命周期/桥、渲染、聊天历史、日记、记忆落盘、BGM/TTS、番茄钟；不能只检查设置页开关 | `test-native-controls`、`test-app-visibility`、`test-app-resume`、`e2e-storage-probe`；系统权限与真实悬浮窗需手机验证 |
| 模型/官方人设/克隆下载授权 | `components/AuthorizationGate.vue`、`useAuthorizationGate.ts`、`usePersonaSettings.ts`、`useVoiceSettings.ts`、`useModelControls.ts` | 同一授权门的三个使用者、取消/拒绝不发下载、导入后实际聊天配置生效 | `probe-model-download-gate`、`probe-persona-download-gate`、`probe-persona-import`、`probe-clone-gate` |
| 聊天布局、键盘、导航、外观 | `useChatLayout.ts`、`components/ChatPanel.vue`、`App.vue` 的面板导航、`assets/style/app-shell.less`/`dialog-controls.less` | 横竖屏、键盘遮挡、菜单外点关闭、触摸穿透、记忆入口计数、主题选择器与弹窗层级 | `probe-chat-image-poke`、`e2e-pixel-ui`、`e2e-mem-menu`、`e2e-mem-gate`、`e2e-intro`、`probe-about-page` |
| 在线人数 | `composables/usePresence.ts`、`services/presence.ts` | 设置持久化、前台心跳、卸载清理；未配置计数服务时不建立请求 | `run-presence-tests`、`test-app-visibility` |

## 正式验证入口

```powershell
Set-Location app/android/web-src
pnpm test:core
pnpm check:growth
pnpm test:fast
pnpm build
pnpm test:ui
pnpm test:all
```

- `test:core` 是核心测试，不能把它的通过结果描述成完整功能回归。
- `test:fast` 是快速检查；`pnpm test` 的实际范围以当前 `package.json` 和运行输出为准，不默认表示运行了浏览器。
- `test:fast` 当前包含 35 套 Node 检查，涵盖核心门禁、拆分模块、源码增长提醒及其自测、运行器和暂存检查自测；运行器自测使用独立临时目录，检查失败判定、超时、锁、产物恢复与清理报告。
- `test:ui` 当前串行运行 22 套正式页面回归，包含真实 Vue App 接线，但部分测试模拟原生桥、模型渲染和外部请求。
- `test:all` 是快速检查、类型/生产构建和页面回归的统一入口；套件清单、筛选和环境要求以正式 runner 的帮助输出为准。
- 改功能时先运行表中相关专项；改共享服务、配置、App 接线或生命周期时，扩大到涉及的全部功能，并运行统一全量入口。新增行为要有能发现该行为出错的验证，不为搬文件重复编写同构测试。
- 汇报时分开说明已运行的范围、结果、未执行项和模拟条件。失败、超时、端口冲突或环境不满足不能记为通过。报告型评估探针也不能冒充门禁通过。
- 测试产生的 bundle、截图、日志不属于产品修改；保留运行前已有的用户改动，不能一概按 Git HEAD 覆盖还原。

筛选使用精确套件名或功能组；先列清单，再执行，避免把部分验证当成全量：

```powershell
pnpm test:ui --list
pnpm test:all "--group=chat,audio" --list
pnpm test:ui --suite=test-app-resume
```

PowerShell 中含逗号的参数需整体加引号，例如 `"--suite=a,b"`、`"--group=a,b"`，避免逗号被解释为数组分隔。

`--suite=a,b` 与 `--group=a,b` 同时指定时取交集；同一个参数内的多个组取并集。带筛选的运行只代表列出的范围，筛选后没有浏览器套件时不执行构建。页面运行默认先检查类型并构建当前源码；`--no-build` 明确复用现有产物并跳过新鲜度检查，交付时应说明该跳过项。日志和 JSON 汇总保存在被忽略的 `tmp-memcheck/_regression-*.log/.txt`。

## 源码增长提醒

`pnpm check:growth` 使用 `scripts/check-source-growth.mjs`，扫描 `src/` 下的 Vue、TS/TSX、JS/JSX/MJS、CSS/LESS/SCSS/SASS。它读取固定的 `scripts/testing/source-growth-baseline.json`，包含本轮 106 个源码文件的行数；未跟踪的新文件也会被检查，不跟随符号链接，不修改源码或基线。

| 情况 | 提醒条件 |
| --- | --- |
| App.vue | 相对基线 1123 行累计增长达到 80 行，即达到 1203 行 |
| 其他既有源码文件 | 累计增长达到原行数的 25%，向上取整；最低 80 行，最高 200 行 |
| 基线中没有的新源码文件 | 超过 400 行；在完成评审并更新基线前，后续检查持续提醒 |
| 基线中的文件已删除 | 正常允许，不阻止重构 |

物理行数包含空行和注释，统一处理 LF/CRLF 与末尾换行。既有大文件不会仅因原有长度触发提醒；检查不能识别职责混杂、状态复制或同等行数的复杂改动，这些仍按 AGENTS.md 和功能地图评审。

提醒输出为 `WARN`，在快速回归终端和 JSON 报告中可见；提醒本身不导致测试失败。源码读取失败、基线缺失/格式错误或错误调用会返回非零。快速回归通过且带提醒时，交付仍需说明提醒涉及文件的职责、状态归属、关联功能，以及保留或拆分的理由。

检查不会自动更新基线。合理新增接线或同一职责的扩展可以保留；发现第二项独立职责时按业务边界调整。不要为了消除提醒机械拆文件、压缩排版或整体提高基线。评审后确需更新时，仅调整已核对条目并记录依据；文件重命名会按新文件检查，应同时核对职责和旧条目。

## 必须保持的不变量

### 聊天、日记和共享历史

1. 文字流与触摸流共用传输/排队约束。新增“忙碌”状态时，检查停止按钮、队列、触摸防重入、主动搭话和自动日记是否仍一致。
2. 只有 `chatStreaming` 和 `touchStreaming` 都为 false 时，回前台才可用 `loadChat()` 整体替换 `messages`。进行中的回调持有当前回复对象；换掉数组会让后续内容写到旧对象上。
3. 自动日记只在可见、原生未暂停、两种流都空闲且配置可用时发起。任一聊天流开始要中止自动日记；后台和卸载也要停止。
4. 共享历史由主页面与悬浮聊天共同使用。不能为主页面修复简单覆盖悬浮窗刚写入的数据，也不能将单窗口缓存当作全局最新历史。
5. 后台要刷新聊天防抖写入并触发记忆落盘；不能把记忆落盘等待挪到立即停止 TTS/BGM 之前，导致音频停止被存储阻塞。

### 可见性、音频和番茄钟

1. 原生暂停与 `document.hidden` 是两个独立暂停原因。网页变为可见不应解除原生暂停，原生 resume 也不应覆盖隐藏页面。
2. `focus` 当前只刷新存储；不要不经联动验证就把它改成完整 resume。`refreshStorage` 中的日记/番茄钟刷新按 `document.hidden` 判断，保持与组合暂停状态的区别。
3. 启动恢复音频时，先执行 `mountPomodoro()` → `applyQuiet()`，再 `restoreBgm()`，避免上次专注状态恢复时短暂出声。
4. 前台 BGM 恢复还要遵守 `bgmHeld()`，其中包括安静模式与专注静音。不能仅按 `cfg.bgmEnabled` 强制播放。
5. 原生生命周期管理悬浮窗启动；Web 页面卸载不再重复拉起悬浮窗。权限申请“已发起”不等于“已授予”，返回后必须查询真实状态再同步开关与原生标记。

### 模型、坐标和资源清理

1. 切模型保持下载/加载防重入，失败路径在 `finally` 释放守卫；新画布挂载后再恢复变换、布局、动作/表情和模型触摸区。
2. 画布变换、命中测试、触摸编辑和背景反馈使用同一套坐标关系。修改 scale、offset、DPR 或渲染分辨率时，把命中与显示一起验证。
3. 全局事件使用同一具名处理函数注册和移除；watch、timer、原生回调、音频、WebGL 资源都有明确所有者与清理路径。
4. 卸载主顺序仍由 App 编排：移除监听/清 timer → 刷新聊天写入 → 销毁背景 → 等待记忆写入 → 停止语音/聊天流/BGM/ambient → 清功能资源 → 销毁 Live2D。不要随手并行化带依赖的清理。

### 模块初始化与接口

1. App 的模块构造顺序中存在“先构造模块、后声明依赖”。`settings: () => cfg`、DPR、番茄钟、触摸编辑器等 getter 是延迟读取约定，不能移到模块构造阶段立即执行；类型检查不一定能发现这种时序错误。
2. `bindFootlightSampling` → `bindQueueWatcher` → `bindDiaryWatcher` → 日记 hooks → `bindReplyWatcher` → 两个音色 watch → 主 hooks 的注册位置有行为含义。调整前先确认读取依赖、立即执行选项和清理顺序。
3. 模块只暴露必要状态与操作，依赖优先使用明确的 Options、`Pick` 和只读引用；确需写共享字段时明确列出写入范围。不要把整个 App 或一个万能回调集合传给子模块。
4. 以“只有一个权威状态”为目标，不新增与 `cfg`、`messages`、模型 ID、原生计时器各自竞争的镜像状态。单独建模块不能替代状态所有权设计。

当前已收窄的接口包括：模型控制只接收 `live2dModel`；舞台渲染只接收分辨率、帧率和背景相关的五个配置字段，三个输入 Ref 只读；舞台交互只读抚摸、注视与分辨率的八个配置字段。新增依赖应显式扩展契约，避免重新传入全量可写配置。

## 新增或修改设置的全链路

1. 明确字段含义、类型、默认值和缺省迁移；先检查 `services/chat/index.ts` 的 `Settings`、`DEFAULT_SETTINGS`、`loadSettings`。
2. 检查 `useAppSettings.ts` 的 `createSettingsState`、`hydrateSettings`、`persistSettings`。保存使用逐字段清单，单改界面会出现“当场生效，重启丢失”。
3. 检查 UI 写入路径、立即生效操作、保存触发与失败反馈。音色当前通过 watch 防抖保存；不能简单改为只依赖 `change`/失焦。
4. 检查所有消费者，特别是 `FloatApp.vue`、`BubbleApp.vue` 与原生桥读取；使用同一字段不意味着这些入口共享同一个 Vue 实例。
5. 覆盖缺字段旧设置、合法/非法值、保存后重启读取。影响渲染、音频、番茄钟或权限时，还要验证对应的实际生效和恢复路径。

## 交付与验证边界

- 本地提交检查、CI 和打包流程见 [自动检查与打包校验](MAINTENANCE_CHECKS.md)。首次克隆需显式安装本地 Git hook，普通依赖安装不修改 Git 配置。

- 运行时修改需要先 `pnpm build` 更新 Web 产物，再进行 Android 打包；不要假定 Gradle 自动构建最新 Web。核对应用版本、APK 签名和包内 Web 内容后再交付。
- 浏览器与模拟桥能验证调用、状态和页面接线，不能证明 Android 授权页、真实悬浮窗、音频焦点、WebGL 性能及系统杀进程恢复已经正常。改动这些边界时保留对应手机验收。
- 已知原有基线：参数白名单检查为 16/18；流式回调修改原始 `liveBubble` 后，历史气泡的部分文本可能在回复完成时才重绘。不要将其误记为本轮通过或新拆分回归；若修改这些行为，明确作为修复验证，更新本页和相关测试。
