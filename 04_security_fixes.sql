-- ═══════════════════════════════════════════════════════
--  SECURITY FIXES
--  Each of these closes a hole found by an adversarial test
--  in supabase/tests/security.sql. Do not remove without
--  re-running that suite.
-- ═══════════════════════════════════════════════════════

-- ── FIX 1: user_cards was writable by its owner ────────
-- RLS was enabled with only a SELECT policy. In Postgres, "RLS on with no
-- INSERT policy" blocks inserts for normal roles — but the owner of the
-- table (and anyone reaching it through a SECURITY DEFINER path) bypassed
-- it. Being explicit costs nothing and documents the intent.
--
-- There is deliberately NO insert/update/delete policy for `authenticated`.
-- Cards are granted only by open_pack() and the game server (service_role),
-- both of which are SECURITY DEFINER / RLS-exempt.
drop policy if exists "user_cards own" on user_cards;

create policy "user_cards select own" on user_cards
  for select to authenticated using (auth.uid() = user_id);

-- force RLS even for the table owner, so a compromised app role
-- cannot quietly bypass these policies
alter table user_cards force row level security;
alter table profiles   force row level security;
alter table lineups    force row level security;
alter table matches    force row level security;
alter table transactions force row level security;
alter table user_quests  force row level security;

-- ── FIX 2: `banned` and other admin fields were editable ──
-- The original guard listed `banned` but the UPDATE still succeeded because
-- the policy allowed the row and the trigger compared new.banned to
-- old.banned only for *changes away from* the current value in some paths.
-- Rewritten to be explicit and fail closed.
create or replace function guard_profile_economy()
returns trigger language plpgsql security definer as $$
begin
  -- trusted path: a SECURITY DEFINER economy function opened the context
  if coalesce(current_setting('app.economy_ctx', true), '') = 'on' then
    new.updated_at := now();
    return new;
  end if;

  -- the game server / admin tooling
  if auth.role() = 'service_role' then
    new.updated_at := now();
    return new;
  end if;

  -- Everyone else: any attempt to touch a server-managed column is an
  -- attack or a bug. Raise rather than silently pinning the value back —
  -- a silent no-op keeps the client working but leaves no trace, so a
  -- scripted cheat would run forever without ever showing up in the logs.
  if new.coins       is distinct from old.coins       or
     new.gems        is distinct from old.gems        or
     new.power       is distinct from old.power       or
     new.level       is distinct from old.level       or
     new.xp          is distinct from old.xp          or
     new.wins        is distinct from old.wins        or
     new.losses      is distinct from old.losses      or
     new.draws       is distinct from old.draws       or
     new.streak      is distinct from old.streak      or
     new.best_streak is distinct from old.best_streak or
     new.banned      is distinct from old.banned      or
     new.id          is distinct from old.id          or
     new.created_at  is distinct from old.created_at
  then
    raise exception 'server_managed_field'
      using detail = format('user %s attempted to modify protected profile fields', old.id),
            hint   = 'coins, gems, level, xp, power, wins and banned are set by the game server only';
  end if;

  new.updated_at := now();
  return new;
end $$;

-- ── FIX 3: server-only functions were EXECUTE-able by players ──
-- CREATE FUNCTION grants EXECUTE to PUBLIC by default, and the REVOKE in
-- 03_rpc.sql ran before a later CREATE OR REPLACE restored it. Revoke after
-- definition, and revoke from PUBLIC explicitly (not just `authenticated`).
revoke all on function apply_match_result(uuid, boolean, boolean, int, int) from public, anon, authenticated;
revoke all on function bump_quest(uuid, text, int)                          from public, anon, authenticated;
revoke all on function recompute_power(uuid)                                from public, anon, authenticated;
revoke all on function economy_ctx_on()                                     from public, anon, authenticated;
revoke all on function refresh_leaderboard()                                from public, anon, authenticated;
revoke all on function guard_profile_economy()                              from public, anon, authenticated;
revoke all on function validate_lineup_ownership()                          from public, anon, authenticated;
revoke all on function handle_new_user()                                    from public, anon, authenticated;

-- Player-callable surface — exactly two functions, nothing else.
revoke all on function open_pack(text)  from public, anon;
revoke all on function claim_quest(text) from public, anon;
grant execute on function open_pack(text)   to authenticated;
grant execute on function claim_quest(text) to authenticated;

-- ── FIX 4: lock down default privileges on tables ──────
-- Supabase grants broad table access to `authenticated` by default; RLS is
-- what actually constrains it. Remove write grants entirely on the tables
-- where the client has no business writing, so RLS is a second line of
-- defence rather than the only one.
--
-- SELECT stays granted everywhere the app needs to read — RLS policies do
-- the row filtering. Revoking SELECT here instead of trusting RLS locked
-- players out of their own profiles; grants control *which tables*, RLS
-- controls *which rows*, and conflating the two breaks the app.
grant usage on schema public to authenticated, anon;

grant select on
  profiles, teachers, teacher_cards, packs, quests,
  user_cards, matches, transactions, user_quests, lineups
to authenticated;

-- anonymous visitors see only the public catalogue and the leaderboard
grant select on teachers, teacher_cards, packs, profiles to anon;

revoke insert, update, delete on user_cards    from authenticated, anon;
revoke insert, update, delete on teacher_cards from authenticated, anon;
revoke insert, update, delete on teachers      from authenticated, anon;
revoke insert, update, delete on packs         from authenticated, anon;
revoke insert, update, delete on quests        from authenticated, anon;
revoke insert, update, delete on matches       from authenticated, anon;
revoke insert, update, delete on transactions  from authenticated, anon;
revoke insert, update, delete on user_quests   from authenticated, anon;
revoke update, delete            on profiles   from anon;

-- Players update their own profile (name, avatar, governorate). The
-- guard_profile_economy trigger is what protects coins/level/banned at the
-- column level, so a blanket UPDATE grant here is safe and necessary — the
-- alternative locked players out of editing their own display name.
grant update on profiles to authenticated;

-- lineups is the one table a client legitimately writes
grant select, insert, update, delete on lineups to authenticated;

-- Player-callable RPC needs the schema and auth helpers reachable.
-- Supabase already grants these; the guard keeps this migration safe to run
-- against both a real project and a local test database.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'auth') then
    execute 'grant usage on schema auth to authenticated, anon';
    execute 'grant execute on function auth.uid() to authenticated, anon';
    execute 'grant execute on function auth.role() to authenticated, anon';
  end if;
exception when insufficient_privilege then
  raise notice 'auth schema owned by Supabase — grants already in place, skipping';
end $$;

-- ── FIX 5: prevent user_id spoofing on lineups ─────────
-- The RLS policy checks auth.uid() = user_id, but a client could still
-- insert with someone else's id if the policy were ever loosened. Pin it.
create or replace function pin_lineup_owner()
returns trigger language plpgsql as $$
begin
  if auth.role() <> 'service_role' then
    new.user_id := auth.uid();
  end if;
  return new;
end $$;

drop trigger if exists trg_pin_lineup_owner on lineups;
create trigger trg_pin_lineup_owner
  before insert on lineups
  for each row execute function pin_lineup_owner();

-- ── FIX 6: cap inventory to stop unbounded growth ──────
-- A scripted client opening packs in a loop could otherwise store millions
-- of rows. 5000 cards is far beyond any real collection.
create or replace function cap_user_cards()
returns trigger language plpgsql as $$
declare n int;
begin
  select count(*) into n from user_cards where user_id = new.user_id;
  if n >= 5000 then
    raise exception 'card_limit_reached';
  end if;
  return new;
end $$;

drop trigger if exists trg_cap_user_cards on user_cards;
create trigger trg_cap_user_cards
  before insert on user_cards
  for each row execute function cap_user_cards();
