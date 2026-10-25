# NoriDroid v2.5.3

Android 交付版本：`versionName 2.5.3`、`versionCode 10`，包名 `com.noridroid`。

## 更新内容

- 修复在线人数开关的竞态：快速「关 → 开」时，如果上一次心跳请求还在途，
  `start()` 会被 `inFlight` 挡掉，导致只能等下一个 10 分钟调度才刷新。
  现在会把这次刷新记成 `pending`，在途请求一结束立刻补发一次。
- 其余同 v2.5.2：心跳 10 分钟、服务端在线窗口 15 分钟、每分钟全局最多 20 个新安装。

## 验证范围

- 客户端单测 54/54（新增「在途请求期间关→开」回归）。
- 设置/关于页探针、fast 门禁、APK 打包预检。
- 在线人数服务端 CloudBase RPC（计数、去重、上限）实测正常。
- Android release 构建（`assembleRelease`）通过，APK 使用本地正式签名。
