# NoriDroid v2.5.2

Android 交付版本：`versionName 2.5.2`、`versionCode 9`，包名 `com.noridroid`。

## 更新内容

- 在线人数心跳间隔从 **5 分钟改为 10 分钟**（服务端在线窗口从 10 分钟改为 **15 分钟**），
  在 CloudBase 免费体验版（3,000 资源点/月）下约可支撑 **50 人全天在线**。
- 服务端新增「**每分钟全局最多计入 20 个新安装**」上限：超出的新安装返回 `limited: true`，
  不写库；已有用户的正常刷新不受影响。
- 在线人数后端使用 CloudBase（腾讯云开发）PostgreSQL RPC，国内直连；
  服务端源码与 SQL 见 `services/presence-cloudbase/`。
- 其余修复同 v2.5.1。

## 验证范围

- 在线人数：客户端单测、设置/关于页探针、全量 fast 门禁、APK 打包预检。
- CloudBase RPC 真实请求：计数、30 秒去重、20/分钟上限、非法 ID、直接读表被 RLS 拦截。
- Android release 构建（`assembleRelease`）通过，APK 使用本地正式签名。
