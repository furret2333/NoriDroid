# NoriDroid 在线人数 · 匿名心跳计数服务

> ⚠ **2026-10-23 起主后端已切换到 Supabase**（`services/presence-supabase/`）：
> `*.workers.dev` 在国内被 DNS 污染/阻断，本目录仅作海外/代理环境的备用实现。

Cloudflare Worker + 单个 Durable Object（SQLite）实现「此刻在线 / 今日来过」。
客户端在 `app/android/web-src/src/services/presence.ts`，通过原生桥 `NoriChat.presencePing`
调用本服务（不动 WebView 的域名白名单）。

## API

### `POST /v1/heartbeat`

```json
{"id":"<16~64 位字母数字>","v":"2.5.0","p":"android"}
```

```json
{"ok":true,"online":128,"today":4567,"ts":1690000000000,"windowMs":600000,"throttleMs":30000}
```

- 同一个 `id` 30 秒内重复心跳**不重复写库**；
- `online` = 最近 10 分钟内发过心跳的去重 ID 数；
- `today` = 当天（北京时间 UTC+8）去重 ID 数。
- 计数快照由 alarm 每分钟重算一次；心跳返回的快照最多慢 60 秒。

错误：`400`（id/版本非法）、`429`（同 IP 超过 120 次/分钟）。

### `GET /v1/online`

同上但只读，用于官网/README 徽章。

### `GET /healthz`

`{"ok":true}`，部署探活。

## 部署

前置：Cloudflare 账号；Node 20+。

```bash
cd services/presence
npx wrangler login          # 本机一次性
npx wrangler deploy         # 首次部署会创建 Durable Object 命名空间
```

部署完会得到形如 `https://noridroid-presence.<你的子域>.workers.dev` 的地址。
> ⚠ `*.workers.dev` 在国内会被 DNS 污染/阻断，**正式使用请绑自定义域名**（本项目用 `presence.inori.mom`）。
> 域名已托管在同一 Cloudflare 账号时，在 `wrangler.toml` 配
> `[[routes]]` / `pattern = "presence.inori.mom"` / `custom_domain = true` 后 deploy，会自动建 DNS 与证书。
把这个地址填进客户端（填服务根地址即可，客户端会自动补 `/v1/heartbeat`）：

- `app/android/web-src/src/services/presence.ts` 的 `PRESENCE_URL`，或
- 构建时注入（需要改代码，目前只有常量入口）。

> 国内可达性：不要用 `workers.dev`（DNS 污染/阻断）。绑自定义域名后即可；要换成
> 国内云函数/VPS，客户端只改 `PRESENCE_URL` 一处，协议照本文的 API 章节实现即可。

### CI 自动部署（可选）

`.github/workflows/presence.yml` 在 `services/presence/**` 变更时部署。需要在仓库
Settings → Secrets 里配置：

- `CLOUDFLARE_API_TOKEN`（Workers 部署权限）
- `CLOUDFLARE_ACCOUNT_ID`

## 成本

免费额度（Workers Free）：Workers 与 Durable Objects 各 **10 万请求/天**，
DO SQLite **10 万行写/天**、500 万行读/天。按客户端 5 分钟一次心跳：

| 同时在线 | 心跳/天 | 免费额度 |
|---|---|---|
| 100 | ≈ 2.9 万 | ✅ |
| 300 | ≈ 8.6 万 | ✅（接近请求上限） |
| 1000 | ≈ 28.8 万 | ❌ 需 Workers Paid（$5/月起） |

「在线 / 今日」由 alarm 每分钟重算并写入 `meta` 快照，心跳只读快照（1~4 行），
不会因为每次心跳 `COUNT(*)` 扫表而超出「行读」额度。

## 隐私

- 只存 `sha256(安装ID)[:32]` 与时间戳；服务端拿不到原始安装 ID，也无法关联到人。
- IP **只在内存里做 60 秒限流**，不写库、不打日志。
- `daily` 表保留 90 天（只用于「今日来过」计数），alarm 每分钟清理过期在线行。
- 不采集聊天、人设、设备标识、位置。

## 本地开发

```bash
cd services/presence
npm test                    # 纯逻辑单测（node --test）
npx wrangler dev            # 本地起 Worker（含 DO）
curl -X POST localhost:8787/v1/heartbeat \
  -H 'content-type: application/json' \
  -d '{"id":"0123456789abcdef0123456789abcdef","v":"2.5.0","p":"android"}'
```
