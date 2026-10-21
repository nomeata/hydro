/**
 * Who sets the sluice gates (docs/GAMEPLAY.md §2). Villagers work a gate
 * near their village: in spring and summer they let water through to their
 * fields below it, as far as the fields need, never while houses below are
 * wet or the fields stand in water, and close it otherwise. Any gate, with
 * or without a village, lets just enough through before the water would
 * spill over its dike (flood relief). The water above the gate may be a
 * pond that only rain refills or a canal fed from a river: every rule looks
 * only at the level just upstream (`hU`) against the crest and the sill,
 * and at the fields below.
 *
 * The leaf is continuous: `aim` (0..1) is where it is set, `lift` follows
 * it. A partly raised leaf lowers the wall's crest (structures.ts), so the
 * rules think in terms of the *opening* o (0..1): the water runs over the
 * leaf o²·(hU − sill) deep (fine steps at the low end), o = 0 holds the
 * water at its level (the leaf fully down), o = 1 is the leaf fully up.
 *
 * Checked eight times a game day per finished gate; the gate is set to the
 * larger of:
 *  1. Flood relief: proportional to how close `hU` is to the crest: o = 0
 *     at 0.4 m below it, o = 1 at 0.05 m below it; once open, at least
 *     o + 1.5·(0.3 m − (crest − hU)), so it settles where the water stands
 *     0.3 m below the crest (or fully open if it cannot hold it there),
 *     and closes again below o = 0.08 as the water goes down.
 *  2. Keeper village only, spring and summer (else 0): 0 if a house within
 *     16 cells of the downstream end was in water (> 0.1 m) today or
 *     yesterday, or if ≥ 30 % of the village's fields within 24 cells of it
 *     are waterlogged (wet crop stress); ≥ 15 % waterlogged throttles an
 *     open gate to 0.4 of its opening at once. Otherwise a feedback
 *     controller on the shares of dry and wet served fields: a closed gate
 *     opens to o = min(0.4, 0.15 + 0.3·dry) when ≥ 15 % are dry and the
 *     head `hU − sill` is ≥ 0.4 m; an open one (head ≥ 0.25 m, else it
 *     closes) eases off by 2·wet (at most half) while ≥ 5 % are wet, opens
 *     further by 0.25·dry while ≥ 5 % are dry, trims 15 % when none are
 *     dry, and otherwise stays (settled). Below o = 0.08 it closes.
 * Changes of the opening smaller than 0.04 are not made. A change
 * waits at least two days after the last one (half a day for relief easing
 * off as the water goes down), except urgent ones: more relief, or closing
 * for wet houses or waterlogged fields. With a keeper
 * village, a villager walks to the gate and turns its wheel while the leaf
 * moves; if nobody comes in time (an eighth of a day when urgent, a day
 * otherwise) the gate moves by itself.
 *
 * Deterministic: no randomness; all state lives on the Gate records
 * (structures.ts) and is saved with them. Gates held by the toggleGate
 * command are left alone.
 */
import type { SimTime } from '../../shared/protocol';
import { STEPS_PER_DAY } from '../constants';
import { SiteKind, Task } from '../people/agents';
import type { PeopleSystem } from '../people/village';
import { LandUse, type World } from '../world';
import { gateAim, type Gate, type Structures } from './structures';

/** Why a gate is open. */
export const enum GateMode {
  None = 0,
  /** Rule 1: the water nearly reached the crest. */
  Relief = 1,
  /** Rule 2: the villagers water their fields. */
  Irrigate = 2,
}

export const GATEKEEPING = {
  /** Steps between checks (three game hours). */
  every: STEPS_PER_DAY / 8,
  /** Steps a gate stays as it is before it may change again (except urgent changes). */
  hold: 2 * STEPS_PER_DAY,
  /** The shorter wait before flood relief eases off again as the water goes down. */
  reliefHold: STEPS_PER_DAY / 2,
  /** Flood relief: the opening grows from 0 at this far below the crest (m) to 1 at this far below it. */
  reliefStart: 0.4,
  reliefFull: 0.05,
  /** An open relief gate then opens further or eases off by reliefGain per metre the water is above or below this far under the crest. */
  reliefKeep: 0.3,
  reliefGain: 1.5,
  /** Houses this close (cells) to the downstream end, in water this deep (m), keep the gate shut. */
  houseRange: 16,
  houseWet: 0.1,
  /** Fields this close (cells) to the downstream end are served by the gate; fewer than minFields count as none. */
  fieldRange: 24,
  minFields: 6,
  /** Share of dry served fields to open a closed gate for, and to open an open one further for. */
  dryOpen: 0.15,
  dryMore: 0.05,
  /** Share of waterlogged served fields to ease off for, to throttle at once for (to `throttle` of the opening), and to close at once for. */
  wetEase: 0.05,
  wetThrottle: 0.15,
  throttle: 0.4,
  wetClose: 0.3,
  /** Controller gains: first opening o = min(openMax, openBase + openGain·dry); then o += moreGain·dry, o −= o·min(easeMax, easeGain·wet); trim when none are dry. */
  openBase: 0.15,
  openGain: 0.3,
  openMax: 0.4,
  moreGain: 0.25,
  easeGain: 2,
  easeMax: 0.5,
  trim: 0.15,
  /** Openings below this close the gate. */
  minOpening: 0.08,
  /** Changes of the opening smaller than this are not made. */
  minChange: 0.04,
  /** Head above the sill (m) to open a closed gate for the fields, and to keep it open. */
  headOpen: 0.4,
  headStay: 0.25,
  /** Steps to wait for the villager before the gate moves by itself: urgent, otherwise. */
  waitUrgent: STEPS_PER_DAY / 8,
  waitWork: STEPS_PER_DAY,
} as const;

/** Checks run at this step of each interval (off the other subsystems' beats). */
const CHECK_PHASE = 37;

/** Achievement events: a villager opened a gate to water the fields; flood relief kept a dike from being overtopped. */
export type GateEvent = 'irrigated' | 'safetyValve';

/** What a check sees at a gate. */
export interface GateView {
  /** Mean water surface (m) at the upstream and downstream ends of the passage. */
  hU: number;
  hD: number;
  /** Downstream end (cell coordinates). */
  downX: number;
  downY: number;
  /** The lower of the dike crest beside the gate and the gate's top (m). */
  crest: number;
  /** Whether water runs over the dike beside the gate. */
  overtopped: boolean;
}

export class Gatekeeper {
  /** Told of achievement events (an observer). */
  onEvent: ((e: GateEvent) => void) | null = null;

  constructor(
    private readonly world: World,
    private readonly structures: Structures,
    private readonly clock: () => SimTime,
  ) {}

  /** Every step: move the leaves; every few game hours, decide. */
  tick(step: number, people: PeopleSystem | null): void {
    const st = this.structures;
    if (st.gates.length === 0) return;
    st.stepGates();
    if (step % GATEKEEPING.every !== CHECK_PHASE) return;
    const time = this.clock();
    for (const g of st.gates) if (g.progress >= 1 && !g.manual) this.check(g, step, time, people);
  }

  /**
   * A villager reached gate `id` (PeopleSystem.onGate): the waiting change
   * happens now. Returns the gate's centre to face, or null if there is
   * nothing to do there.
   */
  arrived(id: number, agent: number): readonly [number, number] | null {
    const g = this.structures.gates.find((g) => g.id === id);
    if (!g) return null;
    const want = g.want ?? -1;
    if (want >= 0) this.apply(g, want, g.wantMode ?? GateMode.None, agent, this.clock());
    else if ((g.lift ?? 0) === gateAim(g)) return null;
    return [g.x, g.y];
  }

  /** The water at a gate: which side is up, how high, and the crest beside it. */
  view(g: Gate): GateView {
    const w = this.world;
    const W = w.width;
    const along = Math.abs(Math.cos(g.rot)) > 0.5;
    const [dx, dy] = along ? [1, 0] : [0, 1];
    const [px, py] = [-dy, dx];
    // The passage's extent across the gate line, on either side.
    let kp = 0;
    let kn = 0;
    for (const c of g.passage) {
      const k = Math.round((c % W) * px + ((c / W) | 0) * py - (g.x * px + g.y * py));
      if (k > kp) kp = k;
      if (k < kn) kn = k;
    }
    const mean = (cx: number, cy: number): number => {
      let s = 0;
      let n = 0;
      for (let y = cy - 1; y <= cy + 1; y++)
        for (let x = cx - 1; x <= cx + 1; x++) {
          if (!w.inBounds(x, y)) continue;
          s += w.surface(w.idx(x, y));
          n++;
        }
      return n ? s / n : -Infinity;
    };
    const ax = Math.round(g.x + px * (kp + 2));
    const ay = Math.round(g.y + py * (kp + 2));
    const bx = Math.round(g.x + px * (kn - 2));
    const by = Math.round(g.y + py * (kn - 2));
    const ha = mean(ax, ay);
    const hb = mean(bx, by);
    const aUp = ha >= hb;
    // The dike beside the gate: up to three cells beyond the wall on its line.
    let crest = g.top;
    let overtopped = false;
    for (const c of this.flanks(g, 3)) {
      crest = Math.min(crest, w.terrain(c));
      if (w.water[c]! > 0.05) overtopped = true;
    }
    return { hU: aUp ? ha : hb, hD: aUp ? hb : ha, downX: aUp ? bx : ax, downY: aUp ? by : ay, crest, overtopped };
  }

  /** Cells on the gate line beyond its wall, up to `reach` on each side (nearest first). */
  private flanks(g: Gate, reach: number): number[] {
    const w = this.world;
    const W = w.width;
    const along = Math.abs(Math.cos(g.rot)) > 0.5;
    const [dx, dy] = along ? [1, 0] : [0, 1];
    const first = g.cells[0]!;
    const last = g.cells[g.cells.length - 1]!;
    const out: number[] = [];
    for (let k = 1; k <= reach; k++)
      for (const [c, s] of [
        [first, -1],
        [last, 1],
      ] as const) {
        const x = (c % W) + dx * k * s;
        const y = ((c / W) | 0) + dy * k * s;
        if (w.inBounds(x, y)) out.push(w.idx(x, y));
      }
    return out;
  }

  /** The opening (0..1, see the header) that leaf position `aim` gives at upstream level hU. */
  static opening(g: Gate, aim: number, hU: number): number {
    if (aim <= 0) return 0;
    if (aim >= 1) return 1;
    const head = hU - g.sill;
    if (!(head > 1e-3)) return 0;
    const over = aim * (g.top - g.sill) - (g.top - hU);
    return over <= 0 ? 0 : Math.min(1, Math.sqrt(over / head));
  }

  /** The leaf position (0..1) for opening o at upstream level hU. */
  static aimFor(g: Gate, o: number, hU: number): number {
    if (o <= 0) return 0;
    if (o >= 1) return 1;
    const head = Math.max(0, hU - g.sill);
    return Math.max(0, Math.min(1, (g.top - hU + o * o * head) / Math.max(1e-3, g.top - g.sill)));
  }

  private check(g: Gate, step: number, time: SimTime, people: PeopleSystem | null): void {
    const w = this.world;
    const K = GATEKEEPING;
    const v = this.view(g);
    const day = time.day;

    // Safety Valve: a relief opening, and the dike beside the gate stayed dry that day.
    const rd = g.reliefDay ?? -1;
    if (rd >= 0) {
      if (v.overtopped) g.overtopped = true;
      if (day > rd) {
        if (!g.overtopped) this.onEvent?.('safetyValve');
        g.reliefDay = -1;
      }
    }

    const centre = w.idx(Math.round(g.x), Math.round(g.y));
    const keeper = people?.settlementNear(centre) ?? null;
    const keeperIndex = keeper && people ? people.settlements.indexOf(keeper) : -1;

    // Houses below the gate in water today.
    if (people) {
      const r2 = K.houseRange * K.houseRange;
      for (const b of people.buildings) {
        if (b.kind !== 'house') continue;
        if ((b.x - v.downX) ** 2 + (b.y - v.downY) ** 2 > r2) continue;
        if (w.water[w.idx(b.x, b.y)]! > K.houseWet) {
          g.wetDay = day;
          break;
        }
      }
    }

    const aim = gateAim(g);
    const o = Gatekeeper.opening(g, aim, v.hU);

    // 1. Flood relief: as much as keeps the water safely below the crest.
    const margin = v.crest - v.hU;
    let relief = Math.max(0, Math.min(1, (K.reliefStart - margin) / (K.reliefStart - K.reliefFull)));
    // An open relief gate is trimmed towards keeping the water `reliefKeep` below the crest.
    if (g.mode === GateMode.Relief && o > 0) relief = Math.max(relief, Math.min(1, o + K.reliefGain * (K.reliefKeep - margin)));
    if (relief < K.minOpening) relief = 0;

    // 2. The keeper village's fields.
    let fields = 0;
    let wetStop = false;
    if (keeper && people && (time.season === 0 || time.season === 1)) {
      const head = v.hU - g.sill;
      const { dry, wet } = this.fieldShares(people, keeper, v.downX, v.downY, time.season);
      const housesWet = (g.wetDay ?? -1e9) >= day - 1;
      if (housesWet || wet >= K.wetClose) wetStop = true;
      else if (o <= 0) {
        if (dry >= K.dryOpen && head >= K.headOpen) fields = Math.min(K.openMax, K.openBase + K.openGain * dry);
      } else if (wet >= K.wetThrottle) {
        wetStop = true;
        fields = o * K.throttle;
      } else if (head >= K.headStay) {
        if (wet >= K.wetEase) fields = o * (1 - Math.min(K.easeMax, K.easeGain * wet));
        else if (dry >= K.dryMore) fields = Math.min(1, o + K.moreGain * dry);
        else if (dry > 0) fields = o;
        else fields = o * (1 - K.trim);
      }
      if (fields < K.minOpening) fields = 0;
    }

    const target = Math.max(relief, fields);
    const mode = target <= 0 ? GateMode.None : relief >= fields ? GateMode.Relief : GateMode.Irrigate;
    let next = target > 0 ? Gatekeeper.aimFor(g, target, v.hU) : 0;
    // A gate that would let nothing over yet stays shut (no leaf in the way of nothing).
    if (next > 0 && Gatekeeper.opening(g, next, v.hU) <= 0) next = 0;
    // Urgent: more relief, or closing (down to the relief) for wet houses or drowned fields.
    const urgent = (mode === GateMode.Relief && next > aim) || (wetStop && next < aim);

    const pending = g.want ?? -1;
    if (Math.abs(Gatekeeper.opening(g, next, v.hU) - o) < K.minChange && (next > 0) === (aim > 0)) {
      // Nothing worth changing (a waiting call is no longer needed).
      if (pending >= 0) g.want = -1;
      if (aim > 0 && mode !== GateMode.None) g.mode = mode;
      return;
    }
    if (pending >= 0) {
      // Waiting for the villager: the new aim replaces the old; move by itself if nobody came in time.
      g.want = next;
      g.wantMode = mode;
      if (step - (g.wantStep ?? step) >= (urgent ? K.waitUrgent : K.waitWork)) this.apply(g, next, mode, -1, time);
      else if (people && keeperIndex >= 0 && !this.onTheWay(people, g)) this.call(g, people, keeperIndex, time);
      return;
    }
    const easing = g.mode === GateMode.Relief && mode !== GateMode.Irrigate && next < aim;
    if (!urgent && step - (g.lastSwitch ?? -1e9) < (easing ? K.reliefHold : K.hold)) return;
    if (!people || keeperIndex < 0) {
      this.apply(g, next, mode, -1, time);
      return;
    }
    g.want = next;
    g.wantMode = mode;
    g.wantStep = step;
    this.call(g, people, keeperIndex, time);
  }

  /** Send a villager to the gate (or let it move by itself if nobody can stand there). */
  private call(g: Gate, people: PeopleSystem, index: number, time: SimTime): void {
    const w = this.world;
    const s = people.settlements[index]!.state;
    let stand = -1;
    let bestD = Infinity;
    for (const c of this.flanks(g, 2)) {
      if (w.water[c]! > 0.05 || w.landuse[c] === LandUse.Building) continue;
      const d = Math.hypot((c % w.width) - s.x, ((c / w.width) | 0) - s.y);
      if (d < bestD) {
        bestD = d;
        stand = c;
      }
    }
    if (stand < 0) {
      this.apply(g, Math.max(0, g.want ?? 0), g.wantMode ?? GateMode.None, -1, time);
      return;
    }
    people.callToGate(index, stand, g.id, time);
  }

  private onTheWay(people: PeopleSystem, g: Gate): boolean {
    return people.agents.some((a) => a.siteKind === SiteKind.Gate && a.site === g.id && a.task === Task.Walk);
  }

  private apply(g: Gate, aim: number, mode: GateMode, operator: number, time: SimTime): void {
    g.want = -1;
    const before = gateAim(g);
    if (aim !== before) {
      const opened = before <= 0 && aim > 0;
      g.aim = aim;
      g.open = aim > 0;
      g.lastSwitch = time.step;
      g.operator = operator;
      this.structures.structuresDirty = true;
      if (aim > before && mode === GateMode.Relief && (g.reliefDay ?? -1) < 0) {
        g.reliefDay = time.day;
        g.overtopped = false;
      }
      if (opened && mode === GateMode.Irrigate && operator >= 0) this.onEvent?.('irrigated');
    }
    g.mode = aim > 0 ? mode : GateMode.None;
  }

  /** Shares of the keeper village's fields near the downstream end that are dry and waterlogged (0 with fewer than minFields). */
  private fieldShares(people: PeopleSystem, keeper: NonNullable<ReturnType<PeopleSystem['settlementNear']>>, x0: number, y0: number, season: number): { dry: number; wet: number } {
    const w = this.world;
    const R = GATEKEEPING.fieldRange;
    const many = people.settlements.length > 1;
    let n = 0;
    let dry = 0;
    let wet = 0;
    for (let y = Math.max(0, y0 - R); y <= Math.min(w.height - 1, y0 + R); y++)
      for (let x = Math.max(0, x0 - R); x <= Math.min(w.width - 1, x0 + R); x++) {
        if ((x - x0) ** 2 + (y - y0) ** 2 > R * R) continue;
        const i = w.idx(x, y);
        if (w.landuse[i] !== LandUse.Field) continue;
        if (many && people.ownerOf(x, y) !== keeper) continue;
        n++;
        const s = people.stressAt(i, season);
        if (s >= 1 && s <= 127) dry++;
        else if (s >= 128) wet++;
      }
    return n < GATEKEEPING.minFields ? { dry: 0, wet: 0 } : { dry: dry / n, wet: wet / n };
  }
}
