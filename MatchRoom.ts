import { Room, Client } from 'colyseus';
import { MatchState, PlayerState, SlotState, CardState } from './schema.js';
import { Rng, rollTier, goalsFromDiff } from './rng.js';
import { supabase, TeacherCard, loadCardPool } from './db.js';

const DRAFT_SECONDS = 60;
const BOX_COUNT = 4;
const FORMATIONS: Record<number, string[]> = {
  3:  ['GK', 'CB', 'ST'],
  5:  ['GK', 'CB', 'CM', 'LW', 'ST'],
  7:  ['GK', 'CB', 'LB', 'CM', 'CAM', 'RW', 'ST'],
  11: ['GK', 'CB', 'CB', 'LB', 'RB', 'CDM', 'CM', 'CAM', 'LW', 'RW', 'ST'],
};

type BoxSlot = { card: TeacherCard; opened: boolean };

/**
 * Colyseus 0.17 takes an options *shape* as the generic, not the state class
 * directly (0.15 used `Room<MatchState>`). The state is declared as a field
 * rather than passed to setState().
 */
export class MatchRoom extends Room<{ state: MatchState }> {
  maxClients = 2;

  /** 0.17 requires the state instance up-front rather than via setState(). */
  state = new MatchState();

  private rng!: Rng;
  private seed!: number;
  private matchId!: string;
  private pool: TeacherCard[] = [];
  private ticker?: ReturnType<typeof setInterval>;

  /**
   * PRIVATE. Box contents live here, never in MatchState.
   * A client learns a box's contents only in the openBox response,
   * and only for their own boxes.
   */
  private boxes = new Map<string, BoxSlot[]>();

  /** Full event log — written to matches.replay on finish. */
  private events: any[] = [];

  async onCreate(options: { formation?: number }) {
    const formation = FORMATIONS[options.formation ?? 3] ? (options.formation ?? 3) : 3;

    this.seed = (Date.now() ^ (Math.random() * 0xffffffff)) >>> 0;
    this.rng = new Rng(this.seed);
    this.pool = await loadCardPool();

    this.state.formation = formation;
    this.state.timeLeft = DRAFT_SECONDS;

    const { data, error } = await supabase
      .from('matches')
      .insert({ room_id: this.roomId, formation, seed: this.seed, state: 'waiting' })
      .select('id')
      .single();
    if (error) throw error;
    this.matchId = data.id;

    this.onMessage('openBox', (client, msg: { index: number }) => this.handleOpenBox(client, msg));
    this.onMessage('decide', (client, msg: { keep: boolean }) => this.handleDecide(client, msg));

    this.log('room_created', { formation, seed: this.seed });
  }

  /** Auth happens here — a client cannot claim to be someone else. */
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
    const p = new PlayerState();
    p.userId = profile.id;
    p.name = profile.full_name;
    p.platform = profile.platform;
    p.level = profile.level;
    p.power = profile.power;

    for (const pos of FORMATIONS[this.state.formation]) {
      const s = new SlotState();
      s.position = pos;
      p.slots.push(s);
    }
    this.state.players.set(client.sessionId, p);

    // Deal this player's private boxes.
    const dealt: BoxSlot[] = [];
    for (let i = 0; i < BOX_COUNT; i++) {
      dealt.push({ card: this.drawCard(), opened: false });
    }
    this.boxes.set(client.sessionId, dealt);

    this.log('join', { userId: profile.id, sessionId: client.sessionId });

    if (this.state.players.size === 2) this.startDraft();
  }

  async onLeave(client: Client, code?: number) {
    const p = this.state.players.get(client.sessionId);
    if (!p) return;
    // Colyseus 0.17 reports a close code instead of a boolean.
    // 1000 = normal close, 4000+ = client called leave() deliberately.
    const consented = code === 1000 || (code ?? 0) >= 4000;
    p.connected = false;
    this.log('leave', { userId: p.userId, code, consented });

    // A deliberate quit forfeits immediately — no reconnection grace.
    if (consented && this.state.phase === 'drafting') {
      this.autoFill(client.sessionId);
      this.checkAllReady();
      return;
    }

    if (this.state.phase === 'finished') return;

    // Give a disconnected player 20s to come back before autocompleting.
    try {
      await this.allowReconnection(client, 20);
      p.connected = true;
      this.log('reconnect', { userId: p.userId });
    } catch {
      this.autoFill(client.sessionId);
      this.checkAllReady();
    }
  }

  // ── DRAFT ────────────────────────────────────────────
  private startDraft() {
    this.state.phase = 'drafting';
    this.state.timeLeft = DRAFT_SECONDS;
    this.log('draft_start', {});

    supabase.from('matches').update({
      state: 'drafting',
      started_at: new Date().toISOString(),
      p1: [...this.state.players.values()][0]?.userId,
      p2: [...this.state.players.values()][1]?.userId,
    }).eq('id', this.matchId).then(() => {});

    // Server owns the clock. A client that lags or tampers cannot extend it.
    this.ticker = setInterval(() => {
      this.state.timeLeft--;
      if (this.state.timeLeft <= 0) {
        this.log('timeout', {});
        for (const sid of this.state.players.keys()) this.autoFill(sid);
        this.finish();
      }
    }, 1000);
  }

  private drawCard(floorTier?: string): TeacherCard {
    const tier = rollTier(this.rng, floorTier);
    const candidates = this.pool.filter(c => c.tier === tier);
    return this.rng.pick(candidates);
  }

  private handleOpenBox(client: Client, msg: { index: number }) {
    if (this.state.phase !== 'drafting') return;
    const p = this.state.players.get(client.sessionId);
    const boxes = this.boxes.get(client.sessionId);
    if (!p || !boxes) return;

    const i = msg?.index;
    if (typeof i !== 'number' || i < 0 || i >= BOX_COUNT) return;
    if (boxes[i].opened) return;                 // replay attempt
    if (p.ready) return;                         // already done
    if (this.pendingDecision.has(client.sessionId)) return;  // one at a time

    boxes[i].opened = true;
    p.boxesUsed[i] = true;
    this.pendingDecision.set(client.sessionId, i);

    // Contents go ONLY to the owner.
    client.send('boxOpened', { index: i, card: this.serialize(boxes[i].card) });
    this.log('open_box', { userId: p.userId, index: i, cardId: boxes[i].card.id });
  }

  private pendingDecision = new Map<string, number>();

  private handleDecide(client: Client, msg: { keep: boolean }) {
    if (this.state.phase !== 'drafting') return;
    const p = this.state.players.get(client.sessionId);
    const boxes = this.boxes.get(client.sessionId);
    const idx = this.pendingDecision.get(client.sessionId);
    if (!p || !boxes || idx === undefined) return;

    this.pendingDecision.delete(client.sessionId);

    if (msg?.keep) {
      const free = p.slots.findIndex((s: SlotState) => !s.card);
      if (free >= 0) {
        p.slots[free].card = this.toCardState(boxes[idx].card);
        this.log('keep', { userId: p.userId, cardId: boxes[idx].card.id, slot: free });
      }
    } else {
      this.log('discard', { userId: p.userId, cardId: boxes[idx].card.id });
    }

    const filled = p.slots.filter((s: SlotState) => s.card).length;
    const boxesLeft = boxes.filter(b => !b.opened).length;

    // Ran out of boxes before filling the lineup — deal replacements so a
    // player is never left with an incomplete squad through no fault of theirs.
    if (filled < this.state.formation && boxesLeft === 0) {
      this.autoFill(client.sessionId);
    }

    if (p.slots.every((s: SlotState) => s.card)) {
      p.ready = true;
      this.log('ready', { userId: p.userId });
    }
    this.checkAllReady();
  }

  private autoFill(sessionId: string) {
    const p = this.state.players.get(sessionId);
    if (!p) return;
    for (const slot of p.slots) {
      if (!slot.card) slot.card = this.toCardState(this.drawCard());
    }
    p.ready = true;
    this.log('autofill', { userId: p.userId });
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
      p.total = p.slots.reduce((acc: number, sl: SlotState) => acc + (sl.card?.rating ?? 0), 0);
    }

    const [[, a], [, b]] = list;
    const diff = Math.abs(a.total - b.total);
    const goals = goalsFromDiff(diff);

    if (a.total > b.total)      { a.score = goals; b.score = 0; this.state.winnerId = a.userId; }
    else if (b.total > a.total) { b.score = goals; a.score = 0; this.state.winnerId = b.userId; }
    else                        { a.score = 0; b.score = 0; this.state.winnerId = ''; }

    // MVP = highest single rating on the winning side (or overall on a draw)
    const mvpPool = this.state.winnerId
      ? list.find(([, p]) => p.userId === this.state.winnerId)![1].slots
      : [...a.slots, ...b.slots];
    const mvp = [...mvpPool].sort((x: SlotState, y: SlotState) => (y.card?.rating ?? 0) - (x.card?.rating ?? 0))[0];
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

    // Rewards are applied server-side via RPC so the client never touches coins.
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
