# 第三方组件与许可（THIRD-PARTY NOTICES）

本文件列出随应用分发的第三方组件及其许可。**本项目自身**（Android 壳 + WebView 前端）按仓库根
`LICENSE` 的 **GPL-3.0** 发布，并含上游衍生声明（见 `README.md` 的「与上游项目的关系」一节）。

| 组件 | 许可 | 说明 / 义务 |
|---|---|---|
| **Vue 3** | MIT | 前端框架。保留其版权与许可声明。 |
| **live2d-easy-control** 1.0.3 | MIT | Live2D 控制封装。⚠️ 本项目通过 `app/android/web-src/scripts/patch-live2d.mjs` 对它**打过补丁（修改版）**，MIT 允许修改，但**必须保留原版权与许可声明**，且本项目的修改部分同样按 GPL-3.0 提供。 |
| **AndroidX / androidx.webkit** | Apache-2.0 | Android 支持库。 |
| **Kotlin stdlib** | Apache-2.0 | Kotlin 标准库。 |
| **Live2D Cubism Core**（`live2dcubismcore.min.js`） | **Live2D Proprietary Software License Agreement**（专有，非开源） | ⚠️ **不随本仓库分发**（已从版本控制移除，见 `SETUP.md` 第 1 节：构建前自行去官网下载 SDK 并放置）。该文件按其头部声明属于协议里的 **"Redistributable Code"**：允许随应用（APK）分发，但 **不得修改**、 **不得置于会允许第三方修改的开源许可之下**（§5.3.2 / §6.8），且不得删除其版权与许可声明。协议全文：<https://www.live2d.com/eula/live2d-proprietary-software-license-agreement_en.html> |
| **Live2D 模型素材** | 各自作者所有 | **不随本仓库与本应用分发**；由使用者自行提供/导入。 |

| **音效 / 参考音频 / 人设文本** | 各自作者所有 | **不随本仓库与本应用分发**：音效由设置里的「下载音效」获取，参考音频在克隆时联网获取，人设由使用者导入自己的文本。 |

## Repository-specific notes

- The in-app About / open-source section is present in the Android settings screen. The old note saying that it was not implemented is obsolete.
- The Android build uses the checked-in Gradle wrapper. Gradle, AndroidX, Kotlin stdlib, Vue, and WebView dependencies keep their upstream licenses.
- Settings artwork and dock icons are project assets. Keep their source attribution and any file-specific license notice when redistributing them.
- Live2D Cubism Core is copied into the local build from the official SDK and is packaged only when the builder supplies it. It is not committed to this repository.

## 分发方义务（Live2D 协议 §5.2）

按 §5.2 的四个条件，本项目随 APK 分发 Cubism Core 时：
1. 应用基于它提供了主要功能（Live2D 桌宠本体）✓
2. 让最终用户知晓并接受同等保护条款 —— 由应用内「关于 / 许可」入口承担（见下）
3. 对 Live2D 免责、补偿 ✓（见仓库 `LICENSE` 与 `README` 的免责声明）
4. **按原样**分发（不修改 Core）✓

> 应用内「关于 / 开源许可」页已在 Android 设置页实现，并提供本文件与 Live2D 协议链接。
> `v2.0.0` is prepared for release from the Android build. Any published APK must include the required Live2D notices and a Core binary supplied under its own license.
