# 在线人数 · Supabase 免费版后端（RPC）

> 2026-10-23 起，主用后端从 Cloudflare Worker 切到 Supabase：
> `*.workers.dev` 在国内被 DNS 污染/阻断，自定义域名解析到 Cloudflare IP 后仍连不上；
> 而 Supabase（AWS）在你的网络可达。
>
> 客户端不需要 Edge Function，直接调用 Postgres 函数：
> `POST https://<ref>.supabase.co/rest/v1/rpc/presence_heartbeat`
> header 带 `apikey: sb_publishable_...`，body `{"p_id":"<32位>","p_v":"2.5.0"}`。

## 一次性部署（用户操作）

1. Supabase Dashboard → **SQL Editor** → New query
2. 把 [schema.sql](schema.sql) 全文粘进去 → **Run**
3. 看到 `Success. No rows returned` 即可

## 验证

### 本机（PowerShell）

```powershell
$base = "https://xztoatqtnlehfauywosa.supabase.co"
$key  = "sb_publishable_5DOhaCD0oQUeGFHK9Bcbyg_NMR7gHjj"
Invoke-RestMethod -Method Post -Uri "$base/rest/v1/rpc/presence_heartbeat" `
  -Headers @{apikey=$key} -ContentType "application/json" `
  -Body '{"p_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","p_v":"2.5.0"}'
```

预期：`ok=True, online=1, today=1`；30 秒内重复同一 id → 不涨；换 id → +1。

### 手机（不开代理）

浏览器打开（`<publishable key>` 换成项目 Settings → API 里的 publishable key；能返回一大段 JSON 就说明网络可达）：

```
https://xztoatqtnlehfauywosa.supabase.co/auth/v1/settings?apikey=<publishable key>
```

> 公开仓库里故意不写真实 key 的查询串，避免隐私扫描把公开 key 误判成泄露。

## 客户端配置

`app/android/web-src/src/services/presence.ts`：

```ts
export const PRESENCE_URL = "https://xztoatqtnlehfauywosa.supabase.co/rest/v1/rpc/presence_heartbeat"
export const PRESENCE_KEY = "sb_publishable_5DOhaCD0oQUeGFHK9Bcbyg_NMR7gHjj"
```

`heartbeatUrl()` 识别 `/rest/v1/rpc/` 时直接使用整条地址；原生桥 `presencePing`
会把 `PRESENCE_KEY` 作为 `apikey` header 发送。

## 口径

- `online` = 最近 10 分钟内发过心跳的去重安装数；
- `today` = 北京时间当天去重安装数（PG 里 `Asia/Shanghai`）；
- 同 ID 30 秒内重复心跳不写库；
- 服务端只存 `sha256(id)[:32]`，不存原始安装 ID；
- 表开了 RLS 且没有任何 policy：anon 只能执行这一个函数，不能直接读写表。

## 已知限制

1. **免费项目 7 天无活动会被自动暂停**：App 有人用就有心跳，不会闲；真被暂停了，
   去 Dashboard 点 Restore 即可（恢复后计数从新开始）。
2. 函数是公开可调的（publishable key 打进客户端），和任何公开计数接口一样无法完全防刷；
   只做了同 ID 30 秒节流。人数仅供参考。
3. 每次心跳都会执行两条 `delete` 清理；数据量小时没问题，用户量上来可以改成定时任务。
4. 免费额度：500MB 数据库、无限 API 请求、5GB 流量——这个场景用量远低于限额。
5. 旧 Cloudflare Worker（`services/presence/`）保留作参考/备用，客户端已不再使用。
