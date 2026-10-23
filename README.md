<div align="center">

#  NoriDroid
**Nori。（I_Nori二创）（安卓陪伴型LLM&TTS）**
⚠️注：新手教程在App内设置最下方⚠️

请自行接入API！本项目不提供收费服务

反馈群：1041616195

小桧（471419518）~在群里活跃哦（1＆2）

Kotlin 原生外壳 + Vue 3 WebView 界面：Live2D 渲染 · LLM 聊天与长期记忆 · 语音合成。

社区项目声明：本项目为社区同好自发维护的非官方、非商业开源项目，与官方团队或母公司无商业关联与从属关系。

[![License: GPL-3.0](https://img.shields.io/badge/License-GPL--3.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Android%207%2B-3ddc84)](#安装)

</div>

> **本仓库只包含 Android 版**（`app/android`）。上游的桌面版（Tauri）与服务端（Go）不在本仓库内。

仓库地址：<https://github.com/furret2333/NoriDroid>

> **当前交付版本：** `v2.5.0`（`versionCode 7`），新增「在线人数」（匿名心跳，设置页显示此刻在线 / 今日来过，可在设置关闭），并包含悬浮窗渲染生命周期与悬浮聊天掉帧修复；APK 使用本地正式签名构建。此前版本说明见 [RELEASE_NOTES_v2.5.0.md](RELEASE_NOTES_v2.5.0.md)。

---

## 它能干什么

- **Live2D 桌宠** —— 主窗口 / 悬浮窗 / 聊天气泡三个界面；触摸互动、头部跟随、渲染分辨率与帧率上限可调
- **聊天 + 记忆** —— OpenAI 兼容接口（DeepSeek 等）流式对话；图片支持相册选择 / 拍摄（需模型支持识图），支持戳戳闲聊；长期记忆 + 历史总结 + 语义召回，带「记忆库」面板
- **心情日记 · 番茄钟** —— 日记面板；倒计时 / 正向计时、专注 / 休息自动接续、整个计时周期静音、7 / 30 / 365 天统计
- **语音** —— Fish Audio / 千问 CosyVoice 双提供商、声音克隆、逐句流式朗读；可选音频振幅口型，默认关闭
- **在线人数** —— 设置一级页（开源许可入口下方）显示「此刻在线 / 今日来过」（匿名心跳：随机安装 ID + 版本号，不含任何聊天或设备标识，可在设置里关闭）。计数服务用 Supabase 免费版（`services/presence-supabase`，一个 SQL 文件即可部署；旧的 Cloudflare 实现保留作备用），未配置时整块功能自动隐藏
- 聊天 / 记忆 / 日记 / 普通设置有意保存在公共目录 `Download/NoriDroid/`，让资料独立于应用安装，卸载后保留、重装后可接续。文件保留和重装读取需按设备与存储权限验证；API Key 保存在 Android Keystore 保护的私有存储中。
  记忆库保持公共 JSON 为权威来源，私有数据库迁移不作为默认升级路线。
  记忆支持正文与别名联合召回；删除、收起和事实纠正会过滤相关摘要，读取失败时暂停保存，恢复访问后合并未保存内容。
  番茄钟统计以应用私有账本为准，并同步公共目录兼容副本；Live2D 模型在应用私有目录（**卸载需重新下载**）。

---

## 安装

1. **下载 APK** —— [Releases](https://github.com/furret2333/NoriDroid/releases) 里有 `NoriDroid-*.apk` 就直接装
   （需要允许「安装未知来源应用」）。

> ⚠️ **Live2D Cubism Core 不在本仓库内**若自己构建需要自行下载

---

## ⚠️⚠️⚠️⚠️第一次用：先看设置内的新手教程！！！⚠️⚠️⚠️⚠️

装好之后的 Nori **没有人设、没有音效、没有模型** —— 这是有意的设计，不是 bug。

| 缺什么 | 怎么补 |
| --- | --- |
| **人设提示词** | 群内有原版提示词~也可以自行导入~设置 →「人设文案（提示词）」→ 导入自己的 `.md` / `.txt`。**不导入就没有人格设定** |
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
