-- デジタルまちづくり議会：Supabase セットアップ
-- Supabase の「SQL Editor」にこのファイルの中身を全部貼りつけて「Run」を押してください。
-- 何度実行しても大丈夫です。
-- テーブルや関数の名前はすべて machi_ で始まるので、ほかのアプリと同じプロジェクトに入れても混ざりません。

-- 1. テーブル ------------------------------------------------------------
create table if not exists public.machi_rooms (
  code        text primary key check (code ~ '^[0-9]{4}$'),
  state       jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.machi_chat (
  id     bigint generated always as identity primary key,
  room   text not null references public.machi_rooms(code) on delete cascade,
  seat   text not null check (seat in ('mayor','c1','c2','c3')),
  text   text not null check (char_length(text) between 1 and 80),
  t      bigint not null,
  npc    boolean not null default false
);
create index if not exists machi_chat_room_t on public.machi_chat(room, t desc);

-- 2. JSON を深くマージする関数（スマホから同時に書きこんでも消えないように、サーバーで合成する）
create or replace function public.machi_jsonb_deep_merge(a jsonb, b jsonb)
returns jsonb language sql immutable as $$
  select case
    when jsonb_typeof(a) = 'object' and jsonb_typeof(b) = 'object' then
      coalesce((
        select jsonb_object_agg(k,
          case
            when a ? k and b ? k then public.machi_jsonb_deep_merge(a -> k, b -> k)
            when b ? k then b -> k
            else a -> k
          end)
        from (select jsonb_object_keys(a) as k union select jsonb_object_keys(b)) keys
      ), '{}'::jsonb)
    else b
  end
$$;

-- 3. 書きこみは関数からだけ行う ----------------------------------------
-- 部屋をつくる（同じコードが6時間以上使われていなければ上書き）
create or replace function public.machi_create_room(p_code text, p_state jsonb)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if octet_length(p_state::text) > 200000 then raise exception 'state too large'; end if;
  insert into machi_rooms(code, state) values (p_code, p_state)
  on conflict (code) do update
    set state = excluded.state, created_at = now(), updated_at = now()
    where machi_rooms.updated_at < now() - interval '6 hours';
  if not found then return false; end if;
  delete from machi_chat where room = p_code and t < (extract(epoch from now()) * 1000)::bigint - 60000;
  return true;
end $$;

-- 部屋の状態を丸ごと置きかえる（「もう一度」用）
create or replace function public.machi_set_room(p_code text, p_state jsonb)
returns void language plpgsql security definer set search_path = public as $$
begin
  if octet_length(p_state::text) > 200000 then raise exception 'state too large'; end if;
  update machi_rooms set state = p_state, updated_at = now() where code = p_code;
end $$;

-- 部屋の状態に変更を重ねる（投票・修正案・進行など）
create or replace function public.machi_merge_room(p_code text, p_patch jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare result jsonb;
begin
  if octet_length(p_patch::text) > 50000 then raise exception 'patch too large'; end if;
  update machi_rooms set state = machi_jsonb_deep_merge(state, p_patch), updated_at = now()
   where code = p_code
   returning state into result;
  if result is null then raise exception 'room not found'; end if;
  if octet_length(result::text) > 200000 then raise exception 'state too large'; end if;
  return result;
end $$;

-- 4. 権限（だれでも読める・チャットは書ける・部屋は関数経由でだけ変えられる）
alter table public.machi_rooms enable row level security;
alter table public.machi_chat  enable row level security;

drop policy if exists machi_rooms_read on public.machi_rooms;
create policy machi_rooms_read on public.machi_rooms for select to anon, authenticated using (true);

drop policy if exists machi_chat_read on public.machi_chat;
create policy machi_chat_read on public.machi_chat for select to anon, authenticated using (true);

drop policy if exists machi_chat_write on public.machi_chat;
create policy machi_chat_write on public.machi_chat for insert to anon, authenticated
  with check (exists (select 1 from public.machi_rooms r where r.code = room and r.updated_at > now() - interval '12 hours'));

revoke all on public.machi_rooms from anon, authenticated;
grant select on public.machi_rooms to anon, authenticated;
revoke all on public.machi_chat from anon, authenticated;
grant select, insert on public.machi_chat to anon, authenticated;
grant execute on function public.machi_create_room(text, jsonb) to anon, authenticated;
grant execute on function public.machi_set_room(text, jsonb)    to anon, authenticated;
grant execute on function public.machi_merge_room(text, jsonb)  to anon, authenticated;

-- 5. リアルタイム配信をオンにする ---------------------------------------
do $$ begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.machi_rooms; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.machi_chat;  exception when duplicate_object then null; end;
  end if;
end $$;
