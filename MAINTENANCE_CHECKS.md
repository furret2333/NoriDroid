# 自动检查与打包校验

本页说明 App.vue 拆分后的日常提交和本地出包流程。业务模块归属和联动回归见 [维护地图](MAINTENANCE.md)。源码由 Git 保存，APK、签名私钥、临时报告和个人资料不纳入本轮检查点。

## 安装与日常检查

Web 工具要求 Node 22 或更新版本，包管理器固定为 pnpm 9.15.9。CI 使用 Node 22.22.0 和 pnpm 9.15.9；锁文件冻结安装并正常执行 Live2D 补丁 postinstall。

```powershell
Set-Location app/android/web-src
pnpm install --frozen-lockfile
pnpm hooks:install
pnpm test:fast
pnpm typecheck
```

`hooks:install` 仅设置本仓库 `core.hooksPath=.githooks`，重复执行安全。已有自定义 hooksPath 或默认 pre-commit 时会停止并提示整合，不覆盖原配置。Git 不会因克隆而自动安装本地 hook，因此每个新 checkout 都需执行安装命令。`.gitattributes` 固定 hook 为 LF 换行。

提交涉及 Web、Android 源码、打包版本文件、测试 harness 或维护检查工具时，pre-commit 导出 **Git 暂存区** 的 Android 文件到临时目录，运行暂存版快速回归和类型检查。源码不链接工作区；仅复用已安装的 node_modules。未暂存修复不会替代暂存错误版本；漏暂存的模块也会被检测出来。

检查不会 stash、重置或改写工作区与 index；测试生成物留在临时快照并在结束后清理。锁文件、依赖声明和 Live2D 补丁脚本必须与本地依赖安装来源一致；依赖变更后先冻结安装再提交。该快速检查复用本机依赖，干净安装的验证由 CI 补充。可用 `pnpm check:staged` 手动检查当前暂存区；没有相关暂存修改时会明确跳过。

出现失败应修复代码或补齐暂存内容，保持错误检查有效。用户授权提交后，只暂存本次任务相关文件，评审 `git diff --cached`，再提交；不得用 `git add .` 顺带提交个人资料、测试生成物或其他任务的改动。

## 自动回归

`.github/workflows/android-web-checks.yml` 在相关路径的 push、PR 和手动触发时运行，使用 Windows，包含：

1. 冻结安装依赖及补丁。
2. 35 套快速检查（含增长提醒、运行器与暂存检查自测）。
3. Android/Web 版本一致性和 TypeScript 检查。
4. APK 校验脚本的 12 项临时夹具自测。
5. 无论结果如何保留回归日志七天。

同一分支或 PR 的旧运行会被新运行取消。该流水线不使用签名私钥、不上传 APK，也不运行浏览器或手机测试。原有 `android.yml` 保留手动完整构建，快速测试已改用统一入口。

配置文件提交后，推送才会触发远端运行；本地通过不等于远端已运行。是否把 `Fast regression and TypeScript` 设为合并必需检查，属于远端分支保护设置，需要在确认首轮 Actions 成功后按仓库协作方式设置。

## 本地出包与已有包校验

```powershell
Set-Location app/android/web-src
pnpm test:all
pnpm test:apk-verification
pnpm build:apk
pnpm verify:apk -ApkPath 'D:\path\NoriDroid-2.5.3-release.apk'
```

最后一条也可直接调用 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/verify-apk.ps1 -ApkPath <绝对路径>`。APK 路径按调用时目录解析，推荐绝对路径；SDK 可通过 `-SdkPath` 指定。

`build:apk` 先完成 `pnpm build`，再用项目配置版本的已缓存 Gradle 离线执行 `assembleRelease`，随后核验确定的版本文件名。Gradle 分发包及依赖必须预先安装；脚本不会为本次操作下载它们或改写签名配置。缺少 SDK、构建失败或校验失败都会返回非零，不会报告旧 APK 为成功的新包。

`verify:apk` 检查如下事实并输出 JSON：

- APK 内 `assets/web/` 与当前 Web 构建目录的文件集合完全一致，每个文件长度和 SHA-256 一致；缺失、额外、大小写错误、重复条目或非法相对路径均失败。
- aapt 读取的 applicationId、versionCode、versionName 与 Gradle 声明一致。
- apksigner 真实验证签名有效，且签名证书与 `scripts/testing/apk-policy.json` 默认固定的已验收证书匹配。
- 输出 APK 大小、SHA-256、版本、Web 文件数及公开证书指纹，不读取私钥或口令。

SDK 从显式参数、ANDROID_SDK_ROOT、ANDROID_HOME、local.properties 或本机常规安装目录寻找，选择包含 aapt/apksigner 的最新稳定 build-tools。版本声明改为动态计算后，需调整解析方式或为校验显式传入预期身份，不能静默忽略解析错误。

证书策略固定的是已验收签名证书的公开指纹 SHA-256。签名轮换需单独评审更新兼容性；显式 `-SignerSha256` 可用于受控核验其他身份，不代表允许将该包直接覆盖现有安装。Gradle 回退到其他 debug 证书时，默认校验会拒绝该包。

独立校验只证明 APK 对应当前构建目录，不能证明该目录由最新源码生成；新包交付使用 `build:apk` 的顺序构建，相关行为变化仍按维护地图做浏览器或手机验证。

