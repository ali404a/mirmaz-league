-- ═══════════════════════════════════════════════════════
--  MIRMAZ LEAGUE — Schema v1
--  Postgres 15 / Supabase
-- ═══════════════════════════════════════════════════════

create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;

-- ── ENUMS ──────────────────────────────────────────────
create type platform_t as enum ('academy','zone');
create type tier_t as enum ('bronze','silver','gold','elite','epic','legendary','master','superrare');
create type subject_t as enum ('islamic','arabic','english','math','physics','chem','bio','french','social','general');
create type match_state_t as enum ('waiting','drafting','revealing','finished','abandoned');
create type currency_t as enum ('coins','gems');
create type txn_t as enum ('pack_open','match_reward','daily_quest','admin_grant','level_up');

-- ── PROFILES ───────────────────────────────────────────
create table profiles (
  id           uuid primary key references auth.users on delete cascade,
  full_name    text not null check (char_length(full_name) between 2 and 60),
  phone        text unique,
  platform     platform_t not null,
  governorate  text not null,
  grade        text not null,
  avatar_url   text,

  level        int  not null default 1  check (level between 1 and 120),
  xp           int  not null default 0  check (xp >= 0),
  power        int  not null default 50,
  coins        int  not null default 500 check (coins >= 0),
  gems         int  not null default 10  check (gems >= 0),

  wins         int not null default 0,
  losses       int not null default 0,
  draws        int not null default 0,
  streak       int not null default 0,
  best_streak  int not null default 0,

  banned       boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index profiles_power_idx on profiles (power desc) where banned = false;
create index profiles_platform_idx on profiles (platform);

-- ── TEACHERS (master data, 100 rows) ───────────────────
create table teachers (
  id          int primary key,
  name        text not null,
  subject     subject_t not null,
  platform    platform_t not null,
  base_rating int not null check (base_rating between 40 and 95),
  position    text not null,
  photo_url   text,
  active      boolean not null default true
);

-- ── TEACHER CARDS (100 × 8 = 800 rows) ─────────────────
create table teacher_cards (
  id          int generated always as identity primary key,
  teacher_id  int not null references teachers on delete cascade,
  tier        tier_t not null,
  rating      int not null check (rating between 40 and 120),
  power       int not null,
  drop_weight numeric(6,3) not null,
  unique (teacher_id, tier)
);

create index teacher_cards_tier_idx on teacher_cards (tier);

-- ── USER CARDS (inventory) ─────────────────────────────
create table user_cards (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references profiles on delete cascade,
  teacher_card_id int  not null references teacher_cards,
  obtained_at     timestamptz not null default now(),
  source          txn_t not null default 'pack_open'
);

create index user_cards_user_idx on user_cards (user_id);
create index user_cards_user_card_idx on user_cards (user_id, teacher_card_id);

-- ── LINEUPS ────────────────────────────────────────────
create table lineups (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles on delete cascade,
  name       text not null default 'تشكيلتي',
  formation  int  not null check (formation in (3,5,7,11)),
  slots      jsonb not null,          -- [{pos:'ST', user_card_id:'uuid'}, ...]
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

create index lineups_user_idx on lineups (user_id);
create unique index lineups_one_default on lineups (user_id) where is_default;

-- ── MATCHES ────────────────────────────────────────────
create table matches (
  id          uuid primary key default gen_random_uuid(),
  room_id     text,
  p1          uuid references profiles on delete set null,
  p2          uuid references profiles on delete set null,
  formation   int not null default 3,
  p1_total    int,
  p2_total    int,
  p1_score    int,
  p2_score    int,
  winner      uuid references profiles on delete set null,
  mvp_card_id int references teacher_cards,
  seed        bigint not null,
  replay      jsonb,                  -- full event log for dispute resolution
  state       match_state_t not null default 'waiting',
  started_at  timestamptz,
  ended_at    timestamptz,
  created_at  timestamptz not null default now()
);

create index matches_p1_idx on matches (p1, created_at desc);
create index matches_p2_idx on matches (p2, created_at desc);
create index matches_state_idx on matches (state) where state in ('waiting','drafting');

-- ── PACKS ──────────────────────────────────────────────
create table packs (
  id             text primary key,
  name_ar        text not null,
  description_ar text not null,
  price          int not null check (price > 0),
  currency       currency_t not null,
  card_count     int not null check (card_count between 1 and 12),
  floor_tier     tier_t,               -- guaranteed minimum on last card
  active         boolean not null default true,
  sort_order     int not null default 0
);

-- ── TRANSACTIONS (audit trail) ─────────────────────────
create table transactions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references profiles on delete cascade,
  kind       txn_t not null,
  currency   currency_t,
  amount     int not null,          -- negative = spend
  balance_after int not null,
  meta       jsonb,
  created_at timestamptz not null default now()
);

create index transactions_user_idx on transactions (user_id, created_at desc);

-- ── DAILY QUESTS ───────────────────────────────────────
create table quests (
  id         text primary key,
  name_ar    text not null,
  target     int not null,
  reward_coins int not null default 0,
  reward_gems  int not null default 0,
  active     boolean not null default true
);

create table user_quests (
  user_id    uuid not null references profiles on delete cascade,
  quest_id   text not null references quests,
  day        date not null default current_date,
  progress   int not null default 0,
  claimed    boolean not null default false,
  primary key (user_id, quest_id, day)
);

-- ═══════════════════════════════════════════════════════
--  ROW LEVEL SECURITY
--  Rule: clients READ their own data. Only service_role WRITES
--  anything that affects game economy or match outcomes.
-- ═══════════════════════════════════════════════════════

alter table profiles       enable row level security;
alter table teachers       enable row level security;
alter table teacher_cards  enable row level security;
alter table user_cards     enable row level security;
alter table lineups        enable row level security;
alter table matches        enable row level security;
alter table packs          enable row level security;
alter table transactions   enable row level security;
alter table quests         enable row level security;
alter table user_quests    enable row level security;

-- profiles: read all (needed for leaderboard), update only safe fields on self
create policy "profiles readable" on profiles
  for select using (true);

create policy "profiles self insert" on profiles
  for insert with check (auth.uid() = id);

create policy "profiles self update" on profiles
  for update using (auth.uid() = id)
  with check (auth.uid() = id);

-- Guard: prevent client from editing economy fields.
--
-- Trusted writes are marked by setting `app.economy_ctx = 'on'` for the
-- duration of a transaction. Only SECURITY DEFINER functions in this file
-- set it, and it resets at commit — so a direct client UPDATE (which never
-- passes through those functions) still hits the raise below.
--
-- Checking auth.role() alone is NOT enough: SECURITY DEFINER runs with the
-- definer's privileges but keeps the *caller's* auth.role(), so open_pack
-- called by a normal player would have been blocked by its own guard.
create or replace function economy_ctx_on() returns void
language sql security definer as $$
  select set_config('app.economy_ctx', 'on', true);
$$;

create or replace function guard_profile_economy()
returns trigger language plpgsql security definer as $$
begin
  if coalesce(current_setting('app.economy_ctx', true), '') = 'on' then
    new.updated_at := now();
    return new;
  end if;
  if auth.role() = 'service_role' then return new; end if;
  if new.coins   is distinct from old.coins   or
     new.gems    is distinct from old.gems    or
     new.power   is distinct from old.power   or
     new.level   is distinct from old.level   or
     new.xp      is distinct from old.xp      or
     new.wins    is distinct from old.wins    or
     new.losses  is distinct from old.losses  or
     new.streak  is distinct from old.streak  or
     new.banned  is distinct from old.banned  then
    raise exception 'economy fields are server-managed';
  end if;
  new.updated_at := now();
  return new;
end $$;

create trigger trg_guard_profile_economy
  before update on profiles
  for each row execute function guard_profile_economy();

-- teachers / teacher_cards / packs / quests: public read, no client write
create policy "teachers readable" on teachers for select using (active);
create policy "teacher_cards readable" on teacher_cards for select using (true);
create policy "packs readable" on packs for select using (active);
create policy "quests readable" on quests for select using (active);

-- user_cards: own only, server writes
create policy "user_cards own" on user_cards
  for select using (auth.uid() = user_id);

-- lineups: full CRUD on own
create policy "lineups own select" on lineups
  for select using (auth.uid() = user_id);
create policy "lineups own insert" on lineups
  for insert with check (auth.uid() = user_id);
create policy "lineups own update" on lineups
  for update using (auth.uid() = user_id);
create policy "lineups own delete" on lineups
  for delete using (auth.uid() = user_id);

-- matches: readable if participant
create policy "matches participant" on matches
  for select using (auth.uid() = p1 or auth.uid() = p2);

-- transactions / user_quests: own read only
create policy "transactions own" on transactions
  for select using (auth.uid() = user_id);
create policy "user_quests own" on user_quests
  for select using (auth.uid() = user_id);

-- ── VALIDATE LINEUP OWNERSHIP ──────────────────────────
-- A lineup may only reference cards the user actually owns.
create or replace function validate_lineup_ownership()
returns trigger language plpgsql as $$
declare
  slot jsonb;
  cnt  int;
begin
  for slot in select * from jsonb_array_elements(new.slots) loop
    if slot->>'user_card_id' is null then continue; end if;
    select count(*) into cnt from user_cards
      where id = (slot->>'user_card_id')::uuid and user_id = new.user_id;
    if cnt = 0 then
      raise exception 'card % not owned by user', slot->>'user_card_id';
    end if;
  end loop;

  if jsonb_array_length(new.slots) <> new.formation then
    raise exception 'slot count % does not match formation %',
      jsonb_array_length(new.slots), new.formation;
  end if;
  return new;
end $$;

create trigger trg_validate_lineup
  before insert or update on lineups
  for each row execute function validate_lineup_ownership();

-- ── AUTO-CREATE PROFILE ON SIGNUP ──────────────────────
create or replace function handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, phone, platform, governorate, grade)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', 'لاعب جديد'),
    new.raw_user_meta_data->>'phone',
    coalesce((new.raw_user_meta_data->>'platform')::platform_t, 'zone'),
    coalesce(new.raw_user_meta_data->>'governorate', 'بغداد'),
    coalesce(new.raw_user_meta_data->>'grade', 'غير محدد')
  );
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ── RECOMPUTE POWER (top 11 average) ───────────────────
create or replace function recompute_power(uid uuid)
returns int language plpgsql security definer as $$
declare p int;
begin
  perform economy_ctx_on();

  select coalesce(round(avg(r)), 50)::int into p
  from (
    select tc.rating as r
    from user_cards uc
    join teacher_cards tc on tc.id = uc.teacher_card_id
    where uc.user_id = uid
    order by tc.rating desc
    limit 11
  ) t;
  update profiles set power = p where id = uid;
  return p;
end $$;

-- ── LEADERBOARD VIEW (materialized, refreshed hourly) ──
create materialized view leaderboard as
select
  row_number() over (order by p.power desc, p.wins desc) as rank,
  p.id, p.full_name, p.platform, p.governorate, p.power, p.level,
  p.wins, p.losses,
  case when (p.wins + p.losses) = 0 then 0
       else round(100.0 * p.wins / (p.wins + p.losses))::int end as win_rate
from profiles p
where p.banned = false
order by p.power desc, p.wins desc
limit 100;

create unique index leaderboard_rank_idx on leaderboard (rank);

-- refresh: select refresh_leaderboard();  (call from cron)
create or replace function refresh_leaderboard()
returns void language sql security definer as $$
  refresh materialized view concurrently leaderboard;
$$;
