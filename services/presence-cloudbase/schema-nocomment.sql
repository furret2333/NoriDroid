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

alter table public.presence enable row level security;

alter table public.presence_daily enable row level security;

drop function if exists public.presence_heartbeat(text, text);

create or replace function public.presence_heartbeat(p_id text, p_v text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
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

  h := left(md5($1), 32);

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

revoke all on function public.presence_heartbeat(text, text) from public;

grant execute on function public.presence_heartbeat(text, text) to anon, authenticated;
