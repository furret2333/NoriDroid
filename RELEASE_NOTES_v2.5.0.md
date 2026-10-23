# NoriDroid v2.5.0

Android 交付版本：`versionName 2.5.0`、`versionCode 7`，包名 `com.noridroid`。

## 更新内容

- 新增「在线人数」：设置一级页「开源许可 / 关于 / 隐私」入口下方显示「此刻在线 N 位同好 · 今日 M 位同好来过」，设置 → 更多工具里可关闭。
  - 匿名心跳：只上报随机安装 ID 与应用版本号，不含设备标识、聊天内容或人设；服务端只存哈希，不保存原始安装 ID。
  - 默认开启；关闭后不再发送任何请求，设置页也不显示人数。
  - 计数服务为 CloudBase（腾讯云开发）免费版 PostgreSQL RPC（`services/presence-cloudbase/`，国内直连）；旧 Cloudflare / Supabase 方案保留作备用。客户端优先 WebView fetch，失败回退原生桥。
- 修复悬浮窗渲染生命周期：原生暂停与网页 hidden 状态独立记录、按 OR 取最终暂停，重复状态不重复重启绘制；主模型与数据海背景一起停顿，聊天 / 记忆落盘与 TTS / BGM 行为保持。
- 修复悬浮聊天持续掉帧与时间信息隐藏问题：新增 `renderPause` 状态仲裁，`FloatApp` 首次 await 前安装暂停入口、异步加载完成后应用当前状态，卸载与异步续体增加 `disposed` 防护。
- 新增 `WebViewCleanup`：UI 线程按 onPause → stopLoading → 移出父容器 → 移除 JS 桥 → destroy 清理；主页面、聊天页、悬浮退出与窗口添加失败统一走该入口。
- 移除了此前的悬浮诊断模式、诊断面板、周期采样器与相关原生桥接口（详见 `docs/悬浮聊天持续掉帧-正式版修复-20261023.md`）。

## 验证范围

- 版本一致性检查、前端构建（vue-tsc + vite）通过。
- 在线人数：客户端单测 52/52、设置 / 关于页探针 41/41、CloudBase RPC 真实请求冒烟（节流 / 去重 / 非法 ID / RLS）、打包预检通过。
- 全量快速门禁 22/22 套通过（11 unit + 11 probe）。
- Android release 构建（`assembleRelease`）通过，APK 使用本地正式签名。
- 在线人数服务已部署（CloudBase 免费版 PostgreSQL RPC）并做过真实请求冒烟（节流、去重计数、非法 ID、RLS）。

## 安装

使用与此前版本相同的正式签名；已有版本可覆盖安装（versionCode 6 → 7）。升级前建议备份重要资料。

## 说明

- `services/presence` 的公开部署地址与隐私口径见 `docs/在线人数-实现与部署-20261021.md`。
- 未包含 Live2D Cubism Core（专有许可，不随仓库分发）。
- 在线人数服务使用 CloudBase 免费版（PostgreSQL RPC，国内直连）；旧 Cloudflare / Supabase 方案保留作备用。计数服务源码与部署说明见 `services/presence-cloudbase/`。
