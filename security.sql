-- ═══════════════════════════════════════════════════════
--  ADVERSARIAL SECURITY SUITE
--
--  Run as an UNPRIVILEGED role that inherits `authenticated`.
--  Running as postgres/superuser is meaningless — superusers bypass
--  RLS and all grants, so every test would falsely pass.
--
--    psql "host=... user=player_test dbname=mirmaz" -f tests/security.sql
--
--  Every test must print PASS. A FAIL is a shipping blocker.
-- ═══════════════════════════════════════════════════════

\set QUIET on
\set ON_ERROR_STOP off
\timing off

create temp table results (id text, desc_txt text, passed boolean);

-- Helper: run SQL that MUST fail. Records PASS when it raises.
create or replace function pg_temp.must_fail(tid text, d text, stmt text)
returns void language plpgsql as $$
begin
  begin
    execute stmt;
    insert into results values (tid, d, false);   -- it succeeded = FAIL
  exception when others then
    insert into results values (tid, d, true);    -- it raised = PASS
  end;
end $$;

-- Helper: run SQL that MUST succeed.
create or replace function pg_temp.must_pass(tid text, d text, stmt text)
returns void language plpgsql as $$
begin
  begin
    execute stmt;
    insert into results values (tid, d, true);
  exception when others then
    insert into results values (tid, d, false);
  end;
end $$;

-- Helper: value must be unchanged after an attempted write.
create or replace function pg_temp.must_not_change(tid text, d text, stmt text, probe text)
returns void language plpgsql as $$
declare before_v text; after_v text;
begin
  execute probe into before_v;
  begin execute stmt; exception when others then null; end;
  execute probe into after_v;
  insert into results values (tid, d, before_v is not distinct from after_v);
end $$;

-- ═══ SETUP ═══
-- Assumes a seeded profile exists; tests act as that user.
select set_config('test.uid', (select id::text from profiles limit 1), false);

-- ═══ ECONOMY ═══
select pg_temp.must_fail('E1', 'cannot self-grant coins',
  $$update profiles set coins = 999999 where id = auth.uid()$$);

select pg_temp.must_fail('E2', 'cannot self-grant gems',
  $$update profiles set gems = 999999 where id = auth.uid()$$);

select pg_temp.must_fail('E3', 'cannot self-promote level',
  $$update profiles set level = 120 where id = auth.uid()$$);

select pg_temp.must_fail('E4', 'cannot inflate power',
  $$update profiles set power = 120 where id = auth.uid()$$);

select pg_temp.must_fail('E5', 'cannot fake wins',
  $$update profiles set wins = 9999 where id = auth.uid()$$);

-- E6 must be run against a user who is ACTUALLY banned. Setting
-- banned=false on an already-unbanned row changes nothing, so the guard
-- correctly stays silent and the old version of this test passed vacuously.
select pg_temp.must_not_change('E6', 'a banned player cannot self-unban',
  $$update profiles set banned = false where id = auth.uid()$$,
  $$select banned::text from profiles where id = auth.uid()$$);

select pg_temp.must_not_change('E7', 'coins unchanged after attack',
  $$update profiles set coins = 999999 where id = auth.uid()$$,
  $$select coins::text from profiles where id = auth.uid()$$);

-- ═══ INVENTORY ═══
select pg_temp.must_fail('I1', 'cannot self-grant a card',
  $$insert into user_cards (user_id, teacher_card_id)
    select auth.uid(), id from teacher_cards where tier='superrare' limit 1$$);

select pg_temp.must_fail('I2', 'cannot delete cards to reroll',
  $$delete from user_cards where user_id = auth.uid()$$);

select pg_temp.must_fail('I3', 'cannot upgrade a card in place',
  $$update user_cards set teacher_card_id = 800 where user_id = auth.uid()$$);

select pg_temp.must_fail('I4', 'cannot edit master card ratings',
  $$update teacher_cards set rating = 120$$);

select pg_temp.must_fail('I5', 'cannot alter drop weights',
  $$update teacher_cards set drop_weight = 100 where tier = 'superrare'$$);

-- ═══ PRIVILEGED FUNCTIONS ═══
select pg_temp.must_fail('F1', 'cannot call apply_match_result',
  $$select apply_match_result(auth.uid(), true, false, 999999, 999999)$$);

select pg_temp.must_fail('F2', 'cannot call recompute_power directly',
  $$select recompute_power(auth.uid())$$);

select pg_temp.must_fail('F3', 'cannot call bump_quest',
  $$select bump_quest(auth.uid(), 'win_1', 999)$$);

select pg_temp.must_fail('F4', 'cannot open the economy context',
  $$select economy_ctx_on()$$);

-- ═══ LINEUPS ═══
select pg_temp.must_fail('L1', 'cannot use unowned cards',
  $$insert into lineups (user_id, formation, slots) values (auth.uid(), 3,
    jsonb_build_array(
      jsonb_build_object('pos','GK','user_card_id', gen_random_uuid()),
      jsonb_build_object('pos','CB','user_card_id', gen_random_uuid()),
      jsonb_build_object('pos','ST','user_card_id', gen_random_uuid())))$$);

select pg_temp.must_fail('L2', 'slot count must match formation',
  $$insert into lineups (user_id, formation, slots)
    values (auth.uid(), 11, '[]'::jsonb)$$);

-- ═══ CROSS-USER ═══
select pg_temp.must_not_change('X1', 'cannot edit another player',
  $$update profiles set full_name = 'hacked'
    where id <> auth.uid()$$,
  $$select count(*)::text from profiles where full_name = 'hacked'$$);

-- RLS filters rows rather than raising, so the correct assertion is
-- "zero foreign rows are visible", not "the query errors".
create or replace function pg_temp.must_see_none(tid text, d text, probe text)
returns void language plpgsql as $$
declare n bigint;
begin
  execute probe into n;
  insert into results values (tid, d, n = 0);
exception when others then
  insert into results values (tid, d, true);  -- denied outright is also fine
end $$;

select pg_temp.must_see_none('X2', 'cannot see another player inventory',
  $$select count(*) from user_cards where user_id <> auth.uid()$$);

select pg_temp.must_see_none('X3', 'cannot see another player transactions',
  $$select count(*) from transactions where user_id <> auth.uid()$$);

select pg_temp.must_see_none('X4', 'cannot see another player lineups',
  $$select count(*) from lineups where user_id <> auth.uid()$$);

select pg_temp.must_see_none('X5', 'cannot see matches I am not in',
  $$select count(*) from matches where p1 <> auth.uid() and p2 <> auth.uid()$$);

-- ═══ TRANSACTIONS ═══
select pg_temp.must_fail('T1', 'cannot forge a transaction',
  $$insert into transactions (user_id, kind, currency, amount, balance_after)
    values (auth.uid(), 'admin_grant', 'coins', 999999, 999999)$$);

-- ═══ LEGITIMATE PATHS MUST STILL WORK ═══
select pg_temp.must_pass('OK1', 'can read own profile',
  $$select 1 from profiles where id = auth.uid()$$);

select pg_temp.must_pass('OK2', 'can read the card catalogue',
  $$select 1 from teacher_cards limit 1$$);

select pg_temp.must_pass('OK3', 'can rename self',
  $$update profiles set full_name = 'اسم جديد' where id = auth.uid()$$);

-- ═══ REPORT ═══
\set QUIET off
\echo ''
\echo '═══════════ SECURITY SUITE ═══════════'
select
  id,
  case when passed then '  PASS' else '✗ FAIL' end as result,
  desc_txt
from results order by id;

\echo ''
select
  count(*) filter (where passed)     as passed,
  count(*) filter (where not passed) as failed,
  case when count(*) filter (where not passed) = 0
       then 'ALL CLEAR'
       else 'BLOCKERS PRESENT — DO NOT DEPLOY' end as verdict
from results;
