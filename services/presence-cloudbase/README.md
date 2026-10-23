# 在线人数 · CloudBase（腾讯云开发）PostgreSQL 后端

> 2026-10-23 起正式切换到 CloudBase：国内直连、免费体验版 ¥0（3,000 资源点/月），
> 不需要 Cloudflare / Supabase / 海外服务器。
> 当前环境：`noridroid-presence`（envId `noridroid-presence-d8csu101fba36`，上海）。

CloudBase 的 Data API 基于 PostgREST，和 Supabase 的结构几乎一样：

```
POST https://<envId>.api.tcloudbasegateway.com/v1/rdb/rest/rpc/presence_heartbeat
Authorization: Bearer <Publishable Key>
Content-Type: application/json

{"p_id":"<32位随机>","p_v":"2.5.0"}
```

## 一次性部署

1. CloudBase 控制台 → 数据库 → **SQL 编辑器**（PostgreSQL 版环境）
2. 把 [schema-nocomment.sql](schema-nocomment.sql) 全文粘进去 → Run
   - 编辑器提示「SQL 里避免带注释」，所以用无注释版
   - 执行后建表 `presence` / `presence_daily` + 函数 `presence_heartbeat`
3. 环境管理 → 复制 **环境 ID**
4. 身份认证 → API Key → 复制/新建 **Publishable Key**（`publish_key`，只显示一次）
5. 验证：

```powershell
$u = "https://<envId>.api.tcloudbasegateway.com/v1/rdb/rest/rpc/presence_heartbeat"
$k = "<Publishable Key>"
Invoke-RestMethod -Method Post -Uri $u `
  -Headers @{Authorization="Bearer $k"} -ContentType "application/json" `
  -Body '{"p_id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","p_v":"2.5.0"}'
```

实测（2026-10-23）：`1 → 1 → 2`、非法 ID 返回 `{ok:false,"message":"id 非法"}`、
直接读表返回 `[]`（RLS + 无 policy，anon 只能执行函数）。

## 关于 RLS / Policy

控制台在开启 RLS 后会提示「新建 Policy 放行 anon/authenticated」，**本项目不需要**：

- `presence_heartbeat` 是 `security definer`，以管理员身份运行，绕过 RLS；
- anon 只被授予**函数**的 EXECUTE，没有表权限；
- 所以直接读表返回空数组是预期行为，心跳函数照常工作。

## 客户端配置

`app/android/web-src/src/services/presence.ts`：

```ts
export const PRESENCE_URL =
  "https://<envId>.api.tcloudbasegateway.com/v1/rdb/rest/rpc/presence_heartbeat"
export const PRESENCE_KEY = "<Publishable Key>"
```

- 请求头：`Authorization: Bearer <key>`
- body：`{"p_id":"...","p_v":"2.5.0"}`
- `heartbeatUrl()` 识别 `/rdb/rest/rpc/`，原样使用，不补 `/v1/heartbeat`
- `WebAssets.ALLOWED_SUBRESOURCE_DOMAINS` 精确放行 `<envId>.api.tcloudbasegateway.com`
- 原生桥 `presencePing` 同样发 `Authorization: Bearer`，key 长度上限放宽到 4096（JWT 很长）

## 口径 / 限制

- `online` = 最近 10 分钟去重安装数；`today` = 北京时间当天去重安装数
- 同 ID 30 秒内重复心跳不写库；每次调用顺带清理 10 分钟前在线行、90 天前每日行
- ID 只存 `md5(id)[:32]`（CloudBase 内置函数，不依赖 pgcrypto），不存原始安装 ID
- 表开 RLS 且无 policy：anon 不能直接读写表，只能执行函数
- 免费体验版有 3,000 资源点/月与到期时间；流量异常可能触发平台风控，人多了要升级
- API 网关默认域名（`*.api.tcloudbasegateway.com`）是接口域名，不是网站默认域名，
  App/curl 调用不会有浏览器中间页
