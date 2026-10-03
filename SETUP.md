# 构建前需要自己做两件事

这个仓库**不包含** Live2D Cubism Core（专有许可，不能随仓库分发）。

## 1. 放一份 Live2D Cubism Core

1. 去 Live2D 官网下载 **Cubism SDK for Web**（需同意其许可协议）：<https://www.live2d.com/sdk/download/web/>
2. 从 SDK 里找到 `Core/live2dcubismcore.min.js`
3. 放到 `app/android/web-src/public/live2dcubismcore.min.js`（构建时会自动拷进 assets）

该文件**已从版本控制移除**（`.gitignore` 已忽略它）：历史提交里仍有旧 blob，但线上公开快照不含它（`scripts/sync-public.mjs` 导出时强制剔除并硬校验）。

协议：<https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html>
（文件头部的注释也写明它属于 "Redistributable Code"：可以随应用一起分发，但**不得修改**、也**不得置于会允许第三方修改的开源许可之下** —— 所以它不进这个仓库。）

## 2. 人设、音效、参考音频都不内置，由用户导入或下载

App **不再内置**这些东西：

| 内容 | 现在怎么来 | 存在哪 |
|---|---|---|
| **人设提示词** | 设置 → 最上面「人设文案（提示词）」→ 导入自己的 `.md` / `.txt` | `Download/NoriDroid/persona.md` |
| **音效**（按键音 + 番茄钟 4 声） | 设置 →「下载音效」按钮 | 应用私有目录 |
| **一键克隆的参考音频** | 一键克隆时自动联网下载 | 应用私有目录（有缓存） |

所以：**没导入人设时，Nori 没有人格设定**（这是有意的设计，不是 bug）。

## 3. 构建

```bash
cd app/android/web-src
pnpm install
pnpm build          # vue-tsc 类型检查 + vite 构建 → app/src/main/assets/web/

cd ..
./gradlew assembleRelease
```

测试（各探针脚本见 `app/android/web-src/tmp-memcheck/`）：

```bash
cd app/android/web-src
node tmp-memcheck/run-tests.mjs                  # 单元测试
node tmp-memcheck/run-all-gates.mjs --fast       # 快速档（不开浏览器）
node tmp-memcheck/run-all-gates.mjs              # 全套（需要 Edge，约 18 分钟）

```

完整门禁需要 Windows 上的 Edge 与 harness；没有 Edge 时使用 `--fast` 只运行 Node 门禁。API keys are kept in the Android Keystore-backed private store; other user data remains in `Download/NoriDroid/`.
