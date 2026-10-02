<div align="center">

#  NoriDroid
**Nori。（I_Nori二创）**
⚠️注：新手教程在设置最下方⚠️

反馈群：1041616195

小桧（471419518）~在群里活跃哦（1＆2）

Kotlin 原生外壳 + Vue 3 WebView 界面：Live2D 渲染 · LLM 聊天与长期记忆 · 语音合成。

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Android%2010%2B-3ddc84)](#安装)

</div>

> **本仓库只包含 Android 版**（`app/android`）。上游的桌面版（Tauri）与服务端（Go）不在本仓库内。

仓库地址：<https://github.com/furret2333/NoriDroid>

---

## 它能干什么

- **Live2D 桌宠** —— 主窗口 / 悬浮窗 / 聊天气泡三个界面；触摸互动、头部跟随、渲染分辨率与帧率上限可调
- **聊天 + 记忆** —— OpenAI 兼容接口（DeepSeek 等）流式对话；长期记忆 + 历史总结 + 语义召回，带「记忆库」面板
- **心情日记 · 番茄钟** —— 日记面板；专注 / 休息自动接续、专注期间静音、7 / 30 / 365 天统计
- **语音** —— Fish Audio / 千问 CosyVoice 双提供商、声音克隆、逐句流式朗读
- 聊天 / 记忆 / 日记 / 设置存在公共目录 `Download/NoriDroid/`（**卸载不丢**）；
  Live2D 模型在应用私有目录（**卸载需重新下载**）

---

## 安装

1. **下载 APK** —— [Releases](https://github.com/furret2333/NoriDroid/releases) 里有 `NoriDroid-*.apk` 就直接装
   （需要允许「安装未知来源应用」）。目前还没发过 Release，所以多半要走第 2 步。
2. **自己构建** —— 完整步骤见 **[SETUP.md](SETUP.md)**：先 `pnpm build` 打前端，再 `./gradlew assembleRelease`，
   产物在 `app/android/app/build/outputs/apk/release/`。

> ⚠️ **Live2D Cubism Core 不在本仓库内**（专有许可，不能随仓库分发）：构建前必须自己从 Live2D 官网下载
> `live2dcubismcore.min.js` 放进 `app/android/web-src/public/`。见 **SETUP.md** 第 1 节。

---

## ⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️第一次用：先看设置内的新手教程！！！⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️⚠️

装好之后的 Nori **没有人设、没有音效、没有模型** —— 这是有意的设计，不是 bug。

| 缺什么 | 怎么补 |
| --- | --- |
| **人设提示词** | 设置 →「人设文案（提示词）」→ 导入自己的 `.md` / `.txt`。**不导入就没有人格设定** |
| **音效**（按键音 + 番茄钟响铃） | 设置 →「下载音效」联网下载；背景音乐也有单独的下载按钮 |
| **Live2D 模型** | 模型不随包分发：在设置里选模型时**联网下载**（内置清单 `ARGNori` / `Nori`）；也可以放自己的模型 + 一份配置 |

> 下载模型 / 音频在国内不一定直连得上，请自备网络环境。
 
---

## 许可与衍生声明

- 本项目源码：[**GPL-3.0**](LICENSE)
- **衍生自 [erhiolab/DeepEr](https://github.com/erhiolab/DeepEr)**（同样 GPL-3.0）：本项目是它的**大规模重制版**，
  Android 主线以及记忆 / 语音 / 番茄钟 / 悬浮窗等改动都在本仓库完成；**不是上游官方仓库**，
- **例外**：Live2D Cubism SDK / Cubism Core 不属于 GPL-3.0 范围，受 Live2D Inc. 独立许可约束，
  且**不随本仓库分发**。
- 随应用分发的第三方组件（Vue / live2d-easy-control / AndroidX / Kotlin stdlib / Cubism Core）的版权与许可，
  见 **[THIRD-PARTY.md](THIRD-PARTY.md)**。

## 反馈

- Bug / 建议：[提 Issue](https://github.com/furret2333/NoriDroid/issues)
- QQ 群：**471419518**（inori 一群）
