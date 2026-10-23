-- NoriDroid 在线人数 · Supabase 版
-- 用法：Supabase Dashboard → SQL Editor → 粘贴整段 → Run
--
-- 设计：
--   - 客户端 POST /rest/v1/rpc/presence_heartbeat  body {"id":"...","v":"..."}
--   - 函数内部：哈希 ID、30 秒节流、10 分钟窗口去重计数、今日（北京时间）去重计数
--   - 表只给 service_role / 函数所有者访问；anon（publishable key）只能执行这个函数
--   - 顺带清理：10 分钟前的在线行、90 天前的每日行

create extension if not exists pgcrypto;

create table if not exists public.presence (
  id text primary key,
  ts timestamptz not null default now()
);
create index if not exists presence_ts_idx on public.presence (ts);

create table if not exists public.presence_daily (
  day date not null,
  id text not null,
  primary key (day, id)
);
create index if not exists presence_daily_day_idx on public.presence_daily (day);

-- 直接访问这两张表一律拒绝（没有 policy）；函数以 owner 身份运行，不受 RLS 影响
alter table public.presence enable row level security;
alter table public.presence_daily enable row level security;

-- 参数名用 p_id / p_v：函数参数若叫 id，会和表列 id 冲突（42702 ambiguous），
-- 之前第一次部署就是这个错误；这里 drop 掉旧签名再重建。
drop function if exists public.presence_heartbeat(text, text);

create or replace function public.presence_heartbeat(p_id text, p_v text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  h text;
  last_ts timestamptz;
  online int;
  today int;
  today_key date := (now() at time zone 'Asia/Shanghai')::date;
begin
  if $1 is null or $1 !~ '^[A-Za-z0-9_-]{16,64}$' then
    return jsonb_build_object('ok', false, 'message', 'id 非法');
  end if;
  if $2 is null or length($2) = 0 or length($2) > 32 or $2 ~ '[\r\n]' then
    return jsonb_build_object('ok', false, 'message', '版本号非法');
  end if;

  h := left(encode(digest($1, 'sha256'), 'hex'), 32);

  select ts into last_ts from public.presence where public.presence.id = h;
  if last_ts is null or now() - last_ts > interval '30 seconds' then
    insert into public.presence (id, ts) values (h, now())
    on conflict (id) do update set ts = excluded.ts;

    insert into public.presence_daily (day, id) values (today_key, h)
    on conflict (day, id) do nothing;
  end if;

  delete from public.presence where ts < now() - interval '10 minutes';
  delete from public.presence_daily where day < (today_key - 90);

  select count(*) into online from public.presence where ts >= now() - interval '10 minutes';
  select count(*) into today from public.presence_daily where day = today_key;

  return jsonb_build_object(
    'ok', true,
    'online', online,
    'today', today,
    'ts', (extract(epoch from clock_timestamp()) * 1000)::bigint
  );
end;
$$;

-- 只允许 anon / authenticated 调用这个函数；表本身不给任何直接权限
revoke all on function public.presence_heartbeat(text, text) from public;
grant execute on function public.presence_heartbeat(text, text) to anon, authenticated;
-- 让 PostgREST 立即刷新 schema cache
notify pgrst, 'reload schema';
