import { Room, Client } from 'colyseus';
import { MatchState, PlayerState, SlotState, CardState } from './schema.js';
import { Rng, rollTier, goalsFromDiff } from './rng.js';
import { supabase, TeacherCard, loadCardPool } from './db.js';

/**
 * DRAFT MECHANIC
 *
 * Every SLOT gets its own set of 4 boxes — not 4 boxes for the whole squad.
 * A 3-slot pitch deals 12 boxes per player; an 11-slot pitch deals 44.
 *
 * Within a slot the player opens boxes in ANY order and may reject any of
 * them — except the last one still unopened. That final box is FORCED: it
 * has no reject button, so a slot can never be left empty and "reject is
 * final" stays meaningful.
 *
 * "Forced" is a property of BEING LAST, not of a fixed index. Open 2, 3, 4
 * and reject them and box 1 becomes forced. Open 1, 2, 3 and reject them
 * and box 4 becomes forced. Nothing is special about box 4.
 *
 * Each slot carries its own 60s timer, refreshed when a slot resolves.
 *
 * Cards are drawn from the whole pool regardless of position — a GK box can
 * contain a striker. The position on the card is cosmetic for now.
 */

const SECONDS_PER_SLOT = 60;
const BOXES_PER_SLOT = 4;

const FORMATIONS: Record<number, string[]> = {
  3:  ['GK', 'CB', 'ST'],
  5:  ['GK', 'CB', 'CM', 'LW', 'ST'],
  7:  ['GK', 'CB', 'LB', 'CM', 'CAM', 'RW', 'ST'],
  11: ['GK', 'CB', 'CB', 'LB', 'RB', 'CDM', 'CM', 'CAM', 'LW', 'RW', 'ST'],
};

/** Private per-player draft state. Never synced — clients must not see it. */
type SlotBoxes = {
  cards: TeacherCard[];        // the 4 cards behind this slot's boxes
  opened: boolean[];           // which have been revealed
  revealed: number | null;     // box index awaiting a keep/reject decision
  resolved: boolean;           // slot has a card locked in
};

export class MatchRoom extends Room<{ state: MatchState }> {
  maxClients = 2;

  state = new MatchState();

  private rng!: Rng;
  private seed!: number;
  private matchId!: string;
  private pool: TeacherCard[] = [];
  private ticker?: ReturnType<typeof setInterval>;

  /** sessionId -> per-slot box sets. Private: contents leak only on open. */
  private draft = new Map<string, SlotBoxes[]>();

  /** sessionId -> index of the slot they are currently drafting */
  private cursor = new Map<string, number>();

  private events: any[] = [];

  async onCreate(options: { formation?: number }) {
    const formation = FORMATIONS[options.formation ?? 3] ? (options.formation ?? 3) : 3;

    this.seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
    this.rng = new Rng(this.seed);
    this.pool = await loadCardPool();

    this.state.formation = formation;
    this.state.boxesPerSlot = BOXES_PER_SLOT;
    this.state.timeLeft = SECONDS_PER_SLOT;

    const { data, error } = await supabase
      .from('matches')
      .insert({ room_id: this.roomId, formation, seed: this.seed, state: 'waiting' })
      .select('id')
      .single();
    if (error) throw error;
    this.matchId = data.id;

    this.onMessage('openBox', (c: Client, m: { box: number }) => this.handleOpenBox(c, m));
    this.onMessage('decide',  (c: Client, m: { keep: boolean }) => this.handleDecide(c, m));

    this.log('room_created', { formation, boxesPerSlot: BOXES_PER_SLOT, seed: this.seed });
  }

  async onAuth(_client: Client, options: { token: string }) {
    const { data, error } = await supabase.auth.getUser(options.token);
    if (error || !data.user) throw new Error('unauthorized');

    const { data: profile } = await supabase
      .from('profiles')
      .select('id, full_name, platform, level, power, banned')
      .eq('id', data.user.id)
      .single();

    if (!profile) throw new Error('profile_missing');
    if (profile.banned) throw new Error('banned');
    return profile;
  }

  onJoin(client: Client, _options: any, profile: any) {
    const positions = FORMATIONS[this.state.formation];

    const p = new PlayerState();
    p.userId = profile.id;
    p.name = profile.full_name;
    p.platform = profile.platform;
    p.level = profile.level;
    p.power = profile.power;
    p.currentSlot = 0;

    for (const pos of positions) {
      const s = new SlotState();
      s.position = pos;
      for (let i = 0; i < BOXES_PER_SLOT; i++) s.boxesOpened.push(false);
      p.slots.push(s);
    }
    this.state.players.set(client.sessionId, p);

    // Deal 4 private cards behind every slot's boxes.
    const sets: SlotBoxes[] = positions.map(() => ({
      cards: Array.from({ length: BOXES_PER_SLOT }, () => this.drawCard()),
      opened: Array(BOXES_PER_SLOT).fill(false),
      revealed: null,
      resolved: false,
    }));
    this.draft.set(client.sessionId, sets);
    this.cursor.set(client.sessionId, 0);

    this.log('join', {
      userId: profile.id,
      totalBoxes: positions.length * BOXES_PER_SLOT,
    });

    if (this.state.players.size === 2) this.startDraft();
  }

  async onLeave(client: Client, code?: number) {
    const p = this.state.players.get(client.sessionId);
    if (!p) return;

    const consented = code === 1000 || (code ?? 0) >= 4000;
    p.connected = false;
    this.log('leave', { userId: p.userId, code, consented });

    if (this.state.phase === 'finished') return;

    if (consented && this.state.phase === 'drafting') {
      this.autoCompleteAll(client.sessionId);
      this.checkAllReady();
      return;
    }

    try {
      await this.allowReconnection(client, 20);
      p.connected = true;
      this.log('reconnect', { userId: p.userId });
    } catch {
      this.autoCompleteAll(client.sessionId);
      this.checkAllReady();
    }
  }

  // ── DRAFT ────────────────────────────────────────────
  private startDraft() {
    this.state.phase = 'drafting';
    this.state.timeLeft = SECONDS_PER_SLOT;
    this.log('draft_start', {});

    const ids = [...this.state.players.values()];
    supabase.from('matches').update({
      state: 'drafting',
      started_at: new Date().toISOString(),
      p1: ids[0]?.userId,
      p2: ids[1]?.userId,
    }).eq('id', this.matchId).then(() => {});

    // Players advance through their own slots independently, so the shared
    // clock tracks whoever is still drafting. When it expires, every player
    // with an unresolved slot has it force-resolved, then it resets.
    this.ticker = setInterval(() => {
      this.state.timeLeft--;
      if (this.state.timeLeft <= 0) {
        this.log('slot_timeout', {});
        for (const sid of this.state.players.keys()) this.forceCurrentSlot(sid);
        this.state.timeLeft = SECONDS_PER_SLOT;
        this.checkAllReady();
      }
    }, 1000);
  }

  private drawCard(): TeacherCard {
    const tier = rollTier(this.rng);
    const candidates = this.pool.filter(c => c.tier === tier);
    return this.rng.pick(candidates);
  }

  private handleOpenBox(client: Client, msg: { box: number }) {
    if (this.state.phase !== 'drafting') return;

    const p = this.state.players.get(client.sessionId);
    const sets = this.draft.get(client.sessionId);
    const slotIdx = this.cursor.get(client.sessionId);
    if (!p || !sets || slotIdx === undefined || slotIdx >= sets.length) return;

    const set = sets[slotIdx];
    if (set.resolved) return;
    if (set.revealed !== null) return;          // must decide on the open one first

    const b = msg?.box;
    if (typeof b !== 'number' || !Number.isInteger(b) || b < 0 || b >= BOXES_PER_SLOT) return;
    if (set.opened[b]) return;                  // replay attempt

    set.opened[b] = true;
    set.revealed = b;
    p.slots[slotIdx].boxesOpened[b] = true;

    // Forced when nothing remains unopened behind it. Position-independent:
    // whichever box the player leaves for last is the one they must take.
    const forced = set.opened.every(o => o);

    // Contents go ONLY to the owner. The opponent sees which box index was
    // opened via boxesOpened, but never the card behind it.
    client.send('boxOpened', {
      slot: slotIdx,
      box: b,
      card: this.serialize(set.cards[b]),
      forced,                                    // client hides the reject button
    });

    this.log('open_box', {
      userId: p.userId, slot: slotIdx, box: b,
      cardId: set.cards[b].id, forced,
    });

    // The last box is compulsory — resolve immediately rather than waiting
    // for a decide() that has no legal alternative.
    if (forced) this.resolveSlot(client.sessionId, b, true);
  }

  private handleDecide(client: Client, msg: { keep: boolean }) {
    if (this.state.phase !== 'drafting') return;

    const sets = this.draft.get(client.sessionId);
    const slotIdx = this.cursor.get(client.sessionId);
    if (!sets || slotIdx === undefined || slotIdx >= sets.length) return;

    const set = sets[slotIdx];
    if (set.resolved || set.revealed === null) return;

    const b = set.revealed;

    // Guard: the last remaining box was already resolved on open, so a
    // decide() naming it is a stale client or someone probing for a reject
    // path that does not exist.
    if (set.opened.every(o => o)) return;

    if (msg?.keep) {
      this.resolveSlot(client.sessionId, b, false);
      return;
    }

    set.revealed = null;
    const p = this.state.players.get(client.sessionId)!;
    this.log('reject', { userId: p.userId, slot: slotIdx, cardId: set.cards[b].id });

    // Rejecting down to a single remaining box leaves nothing to decide —
    // open it for them rather than making them click a foregone conclusion.
    // Whichever index survived is the forced one.
    const remaining = set.opened.filter(o => !o).length;
    if (remaining === 1) {
      const last = set.opened.findIndex(o => !o);
      this.handleOpenBox(client, { box: last });
    }
  }

  /** Lock a card into the current slot and advance the cursor. */
  private resolveSlot(sessionId: string, box: number, forced: boolean) {
    const p = this.state.players.get(sessionId);
    const sets = this.draft.get(sessionId);
    const slotIdx = this.cursor.get(sessionId);
    if (!p || !sets || slotIdx === undefined) return;

    const set = sets[slotIdx];
    if (set.resolved) return;

    set.resolved = true;
    set.revealed = null;

    const card = set.cards[box];
    p.slots[slotIdx].card = this.toCardState(card);
    this.log('resolve_slot', {
      userId: p.userId, slot: slotIdx, box, cardId: card.id, forced,
    });

    const next = sets.findIndex(s => !s.resolved);
    if (next === -1) {
      p.ready = true;
      p.currentSlot = sets.length;
      this.log('ready', { userId: p.userId });
      this.checkAllReady();
      return;
    }

    this.cursor.set(sessionId, next);
    p.currentSlot = next;

    // A fresh slot gets a fresh minute — but only if the opponent is not
    // mid-slot on a clock of their own; the shared timer already tracks the
    // slowest player, so we only extend, never shorten.
    if (this.state.timeLeft < SECONDS_PER_SLOT) {
      this.state.timeLeft = SECONDS_PER_SLOT;
    }
  }

  /** Timer expired on the current slot: take whatever is revealed, or force-open. */
  private forceCurrentSlot(sessionId: string) {
    const sets = this.draft.get(sessionId);
    const slotIdx = this.cursor.get(sessionId);
    if (!sets || slotIdx === undefined || slotIdx >= sets.length) return;

    const set = sets[slotIdx];
    if (set.resolved) return;

    if (set.revealed !== null) {
      this.resolveSlot(sessionId, set.revealed, true);
      return;
    }

    // Nothing revealed — open the first unopened box and take it.
    const b = set.opened.findIndex(o => !o);
    if (b === -1) return;
    set.opened[b] = true;
    const p = this.state.players.get(sessionId);
    if (p) p.slots[slotIdx].boxesOpened[b] = true;
    this.resolveSlot(sessionId, b, true);
  }

  /** Disconnect / forfeit: resolve every remaining slot immediately. */
  private autoCompleteAll(sessionId: string) {
    const sets = this.draft.get(sessionId);
    if (!sets) return;
    let guard = 0;
    while (sets.some(s => !s.resolved) && guard++ < 200) {
      this.forceCurrentSlot(sessionId);
    }
    const p = this.state.players.get(sessionId);
    if (p) {
      p.ready = true;
      this.log('autocomplete', { userId: p.userId });
    }
  }

  private checkAllReady() {
    if (this.state.players.size < 2) return;
    if ([...this.state.players.values()].every(p => p.ready)) this.finish();
  }

  // ── REVEAL ───────────────────────────────────────────
  private async finish() {
    if (this.state.phase === 'finished') return;
    if (this.ticker) clearInterval(this.ticker);
    this.state.phase = 'revealing';

    const list = [...this.state.players.entries()];
    for (const [, p] of list) {
      p.total = p.slots.reduce(
        (acc: number, sl: SlotState) => acc + (sl.card?.rating ?? 0), 0);
    }

    const [[, a], [, b]] = list;
    const diff = Math.abs(a.total - b.total);
    const goals = goalsFromDiff(diff);

    if (a.total > b.total)      { a.score = goals; b.score = 0; this.state.winnerId = a.userId; }
    else if (b.total > a.total) { b.score = goals; a.score = 0; this.state.winnerId = b.userId; }
    else                        { a.score = 0; b.score = 0; this.state.winnerId = ''; }

    const mvpPool = this.state.winnerId
      ? list.find(([, p]) => p.userId === this.state.winnerId)![1].slots
      : [...a.slots, ...b.slots];
    const mvp = [...mvpPool].sort(
      (x: SlotState, y: SlotState) => (y.card?.rating ?? 0) - (x.card?.rating ?? 0))[0];
    this.state.mvpCardId = mvp?.card?.teacherCardId ?? 0;

    this.state.phase = 'finished';
    this.log('finish', { aTotal: a.total, bTotal: b.total, diff, goals, winner: this.state.winnerId });

    await this.persist(a, b);
    this.broadcast('matchOver', { winnerId: this.state.winnerId });
  }

  private async persist(a: PlayerState, b: PlayerState) {
    await supabase.from('matches').update({
      p1_total: a.total, p2_total: b.total,
      p1_score: a.score, p2_score: b.score,
      winner: this.state.winnerId || null,
      mvp_card_id: this.state.mvpCardId || null,
      replay: { seed: this.seed, events: this.events },
      state: 'finished',
      ended_at: new Date().toISOString(),
    }).eq('id', this.matchId);

    for (const p of [a, b]) {
      const won = p.userId === this.state.winnerId;
      const drew = !this.state.winnerId;
      await supabase.rpc('apply_match_result', {
        uid: p.userId,
        won,
        drew,
        reward_coins: won ? this.rng.int(180, 320) : drew ? 120 : this.rng.int(50, 110),
        reward_xp: won ? 100 : drew ? 60 : 30,
      });
    }
  }

  onDispose() {
    if (this.ticker) clearInterval(this.ticker);
  }

  // ── HELPERS ──────────────────────────────────────────
  private serialize(c: TeacherCard) {
    return {
      teacherCardId: c.id, teacherId: c.teacher_id, name: c.name,
      subject: c.subject, tier: c.tier, position: c.position,
      rating: c.rating, power: c.power,
    };
  }

  private toCardState(c: TeacherCard): CardState {
    const s = new CardState();
    Object.assign(s, this.serialize(c));
    return s;
  }

  private log(type: string, data: any) {
    this.events.push({ t: Date.now(), type, ...data });
  }
}
