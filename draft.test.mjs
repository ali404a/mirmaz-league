/**
 * Headless test of the per-slot draft mechanic.
 *
 * Colyseus rooms need a running server + DB, so this reimplements the exact
 * decision logic from MatchRoom (openBox / decide / resolveSlot) against a
 * fake pool. If this drifts from MatchRoom.ts the test is worthless — keep
 * the rules in sync, or better, extract them into a shared module.
 *
 * Run: node tests/draft.test.mjs
 */

const BOXES_PER_SLOT = 4;

let failures = 0;
function check(name, cond, extra = '') {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failures++;
}

// ── minimal room model ──────────────────────────────────
function makeDraft(slots, cardFn) {
  return Array.from({ length: slots }, () => ({
    cards: Array.from({ length: BOXES_PER_SLOT }, cardFn),
    opened: Array(BOXES_PER_SLOT).fill(false),
    revealed: null,
    resolved: false,
  }));
}

function openBox(sets, cursor, box) {
  const set = sets[cursor];
  if (!set || set.resolved) return { ok: false, reason: 'resolved' };
  if (set.revealed !== null) return { ok: false, reason: 'pending_decision' };
  if (!Number.isInteger(box) || box < 0 || box >= BOXES_PER_SLOT)
    return { ok: false, reason: 'bad_index' };
  if (set.opened[box]) return { ok: false, reason: 'already_open' };

  set.opened[box] = true;
  set.revealed = box;
  // Forced = nothing left unopened. Not tied to any fixed index.
  const forced = set.opened.every(o => o);
  return { ok: true, forced, card: set.cards[box] };
}

function decide(sets, cursor, keep) {
  const set = sets[cursor];
  if (!set || set.resolved || set.revealed === null)
    return { ok: false, reason: 'nothing_revealed' };
  const b = set.revealed;
  if (set.opened.every(o => o)) return { ok: false, reason: 'forced_box_no_reject' };

  if (keep) { set.resolved = true; set.revealed = null; return { ok: true, took: b }; }
  set.revealed = null;
  return { ok: true, rejected: b };
}

function resolve(sets, cursor, box) {
  sets[cursor].resolved = true;
  sets[cursor].revealed = null;
  return sets[cursor].cards[box];
}

// ── fixtures ────────────────────────────────────────────
let seq = 0;
const card = () => ({ id: ++seq, rating: 50 + (seq * 7) % 60 });

console.log('\n═══ BOX COUNT ═══');
for (const [slots, expected] of [[3, 12], [5, 20], [7, 28], [11, 44]]) {
  const d = makeDraft(slots, card);
  const total = d.reduce((s, x) => s + x.cards.length, 0);
  check(`${slots}-slot pitch deals ${expected} boxes`, total === expected, `got ${total}`);
}

console.log('\n═══ FORCED BOX IS WHICHEVER IS LAST ═══');
{
  // Sequential order: 1,2,3 rejected -> box 4 forced
  const d = makeDraft(1, card);
  for (const b of [0, 1, 2]) { openBox(d, 0, b); decide(d, 0, false); }
  const r = openBox(d, 0, 3);
  check('open 1,2,3 → box 4 is forced', r.ok && r.forced === true);
  check('and it cannot be rejected',
    !decide(d, 0, false).ok);
}
{
  // The user's example: open 2,3,4 -> box 1 forced
  const d = makeDraft(1, card);
  for (const b of [1, 2, 3]) { openBox(d, 0, b); decide(d, 0, false); }
  const r = openBox(d, 0, 0);
  check('open 2,3,4 → box 1 is forced', r.ok && r.forced === true);
  check('and it cannot be rejected',
    !decide(d, 0, false).ok);
}
{
  // Scattered order: 3,1,4 -> box 2 forced
  const d = makeDraft(1, card);
  for (const b of [2, 0, 3]) { openBox(d, 0, b); decide(d, 0, false); }
  const r = openBox(d, 0, 1);
  check('open 3,1,4 → box 2 is forced', r.ok && r.forced === true);
}
{
  // Boxes 1-3 must all be rejectable when opened first
  for (const first of [0, 1, 2, 3]) {
    const d = makeDraft(1, card);
    const r = openBox(d, 0, first);
    check(`box ${first + 1} opened first is NOT forced`, r.ok && r.forced === false);
    check(`box ${first + 1} opened first can be rejected`,
      decide(d, 0, false).ok);
  }
}
{
  // Exhaustive: every one of the 24 opening orders must forbid rejecting
  // the 4th box opened, and allow rejecting the first three.
  const perms = [];
  const permute = (arr, cur = []) => {
    if (!arr.length) { perms.push(cur); return; }
    arr.forEach((x, i) => permute([...arr.slice(0, i), ...arr.slice(i + 1)], [...cur, x]));
  };
  permute([0, 1, 2, 3]);
  let bad = 0;
  for (const order of perms) {
    const d = makeDraft(1, card);
    for (let i = 0; i < 4; i++) {
      const r = openBox(d, 0, order[i]);
      const shouldBeForced = i === 3;
      if (!r.ok || r.forced !== shouldBeForced) { bad++; break; }
      const dec = decide(d, 0, false);
      if (dec.ok === shouldBeForced) { bad++; break; }   // 4th must refuse reject
      if (shouldBeForced) break;
    }
  }
  check(`all ${perms.length} opening orders force exactly the last box`, bad === 0, `${bad} broken`);
}

console.log('\n═══ REJECT IS FINAL ═══');
{
  const d = makeDraft(1, card);
  openBox(d, 0, 0);
  decide(d, 0, false);
  const again = openBox(d, 0, 0);
  check('cannot reopen a rejected box', !again.ok && again.reason === 'already_open');
}

console.log('\n═══ ONE DECISION AT A TIME ═══');
{
  const d = makeDraft(1, card);
  openBox(d, 0, 0);
  const second = openBox(d, 0, 1);
  check('cannot open a 2nd box while one awaits a decision',
    !second.ok && second.reason === 'pending_decision');
}

console.log('\n═══ SLOT NEVER LEFT EMPTY ═══');
{
  // Reject everything, opening in RANDOM order each time. The last box
  // standing must still fill the slot.
  let R = 999;
  const rnd = () => (R = (R * 1103515245 + 12345) % 2147483648) / 2147483648;
  const shuffle = a => { const x = [...a]; for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; };

  let filled = 0;
  for (let trial = 0; trial < 1000; trial++) {
    const d = makeDraft(3, card);
    for (let s = 0; s < 3; s++) {
      for (const b of shuffle([0, 1, 2, 3])) {
        const r = openBox(d, s, b);
        if (!r.ok) continue;
        if (r.forced) { resolve(d, s, b); break; }
        decide(d, s, false);
      }
    }
    if (d.every(x => x.resolved)) filled++;
  }
  check('1000 random-order all-reject drafts fill every slot', filled === 1000, `${filled}/1000`);
}

console.log('\n═══ INPUT VALIDATION ═══');
{
  const d = makeDraft(1, card);
  for (const bad of [-1, 4, 99, 1.5, NaN, null, undefined, '2']) {
    const r = openBox(d, 0, bad);
    check(`rejects box index ${JSON.stringify(bad)}`, !r.ok);
  }
}

console.log('\n═══ CURSOR ADVANCES IN ORDER ═══');
{
  const d = makeDraft(3, card);
  const order = [];
  for (let s = 0; s < 3; s++) {
    openBox(d, s, 0);
    decide(d, s, true);
    order.push(d.findIndex(x => !x.resolved));
  }
  check('cursor walks 1 → 2 → done', JSON.stringify(order) === JSON.stringify([1, 2, -1]),
    JSON.stringify(order));
}

console.log('\n═══ STRATEGY MATTERS (not pure luck) ═══');
{
  // A real decision game must reward a middling threshold over extremes.
  let S = 12345;
  const rnd = () => (S = (S * 1664525 + 1013904223) % 4294967296) / 4294967296;
  const TIERS = [[34,50,64],[26,63,73],[18,72,81],[11,80,88],[6,87,93],[3,92,97],[1.5,96,99],[0.5,99,120]];
  const TOT = TIERS.reduce((s,t)=>s+t[0],0);
  const draw = () => {
    let r = rnd()*TOT;
    for (const [w,lo,hi] of TIERS) if ((r -= w) <= 0) return Math.round(lo + rnd()*(hi-lo));
    return 55;
  };
  const play = (th) => {
    let total = 0;
    for (let s = 0; s < 3; s++) {
      for (let b = 0; b < 4; b++) {
        const c = draw();
        if (b === 3 || c >= th) { total += c; break; }
      }
    }
    return total;
  };
  const avg = (th) => { let s=0; for(let i=0;i<40000;i++) s+=play(th); return s/40000; };
  const results = [60,70,75,80,90,95].map(th => [th, avg(th)]);
  results.forEach(([th,a]) => console.log(`    threshold ${th} → ${a.toFixed(1)}`));
  const best = results.reduce((a,b) => b[1] > a[1] ? b : a);
  const tooGreedy = results.find(r => r[0] === 95)[1];
  const tooLoose  = results.find(r => r[0] === 60)[1];
  check('an interior threshold beats greedy extremes',
    best[0] > 60 && best[0] < 95, `best=${best[0]}`);
  check('over-greedy (95) is punished', tooGreedy < best[1], `${tooGreedy.toFixed(1)} < ${best[1].toFixed(1)}`);
  check('too-loose (60) is punished', tooLoose < best[1], `${tooLoose.toFixed(1)} < ${best[1].toFixed(1)}`);
}

console.log(`\n${failures === 0 ? 'ALL CLEAR' : failures + ' FAILURE(S)'}\n`);
process.exit(failures === 0 ? 0 : 1);
