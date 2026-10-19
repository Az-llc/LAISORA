import {
  CAT_PALETTES, CAT_PROP_PALETTES, CAT_SIGN, CAT_SIGN_PALETTE, CAT_SPRITES, decodeCatFrame,
  type CatPose, type CatPropName, type CatSpriteFrame, type CatSpriteSet, type CatSpriteSize, type CatWalk, type CatWho,
} from "./todo-cat-sprites";

export const RUN_SPEED_FACTOR = 3;
export const RUN_FRAME_MIN_MS = 130;
export const CAT_WIDE_MIN_PX = 320;
export const CAT_SHOW_MIN_PX = 96;
export const PERCH_HOLD_MS = 20000;

const BLINK_MS = 140;
const BLINK_EVERY: Record<CatWho, number> = { a: 2900, b: 2300 };
const BREATH_MS: Record<CatWho, number> = { a: 1700, b: 1300 };
const PHASE: Record<CatWho, number> = { a: 0, b: 700 };
export const CAT_BLINK_POSES: ReadonlySet<CatPose> = new Set<CatPose>(["sit", "stand", "perch", "chair"]);
const BLINK_POSES = CAT_BLINK_POSES;
const BREATH_POSES: ReadonlySet<CatPose> = new Set<CatPose>(["loaf", "lie", "belly"]);
const SHUT_FRAME = 1;
const PERCH_BEAT_MS = 3200;
const PERCH_LOOK_MS = 700;
const CONTINUOUS_MS = 16;
const SLEEP_CHUNK_MS = 60000;
const HOME_PAD_PX = 4;
const HOME_GAP_PX = 10;

type Dir = 1 | -1;
const HOME_DIR: Record<CatWho, Dir> = { a: -1, b: 1 };
const ARRIVE_MS = 64;
const IDLE_HOLD_MIN_MS = 3000;
const IDLE_HOLD_MAX_MS = 3400;
const IDLE_MIN_PIECE_MS = 500;
const IDLE_CLEAR_PX = 4;
const IDLE_ALT_POSE: Record<CatWho, CatPose> = { a: "loaf", b: "stand" };
const SPAN_SAMPLE_MS = 100;
const IDLE_LOOKAHEAD_MS = 5000;
const TARGET_GRACE_MS = 500;
const TRAVEL_RUN_PX = 200;

export type GaitKind = "walk" | "run";
export interface GaitTiming { readonly frameMs: number; readonly steps: readonly number[] }

export function gaitTiming(walk: CatWalk, kind: GaitKind): GaitTiming {
  if (kind === "walk") return { frameMs: walk.ms, steps: walk.steps };
  const frameMs = Math.max(RUN_FRAME_MIN_MS, walk.ms / RUN_SPEED_FACTOR);
  const scale = RUN_SPEED_FACTOR * frameMs / walk.ms;
  return { frameMs, steps: walk.steps.map(step => step * scale) };
}

export function gaitSpeed(timing: GaitTiming): number {
  return timing.steps.reduce((sum, step) => sum + step, 0) / (timing.steps.length * timing.frameMs);
}

function stepSum(steps: readonly number[], count: number): number {
  let sum = 0;
  for (let i = 0; i < count; i++) sum += steps[i % steps.length];
  return sum;
}

export function gaitFrameCount(timing: GaitTiming, distance: number): number {
  let count = 0, sum = 0;
  while (sum < distance) sum += timing.steps[count++ % timing.steps.length];
  return Math.max(1, count);
}

export function gaitDuration(timing: GaitTiming, glide: boolean, distance: number): number {
  if (!glide) return gaitFrameCount(timing, distance) * timing.frameMs;
  return Math.ceil((distance / gaitSpeed(timing) + ARRIVE_MS) / timing.frameMs) * timing.frameMs;
}

export function gaitOffset(timing: GaitTiming, glide: boolean, distance: number, elapsed: number): { dx: number; index: number } {
  const index = Math.max(0, Math.floor(elapsed / timing.frameMs));
  return { dx: Math.min(distance, glide ? gaitSpeed(timing) * Math.max(0, elapsed) : stepSum(timing.steps, index + 1)), index };
}

export const CAT_DUO_SCENES = ["play", "chase", "nap", "mutual", "chair", "eat", "rollduo"] as const;
export const CAT_SOLO_SCENES = { a: ["yawn", "roll", "belly", "yarn", "fishnap"], b: ["zoom", "groom", "mouse", "wand", "look"] } as const;
export const CAT_REACTION_SCENES = ["ask", "busy", "yay", "sleep"] as const;
type DuoScene = typeof CAT_DUO_SCENES[number];
type SoloScene<W extends CatWho> = typeof CAT_SOLO_SCENES[W][number];
type ReactionScene = typeof CAT_REACTION_SCENES[number];
export type CatSceneName = DuoScene | SoloScene<"a"> | SoloScene<"b"> | ReactionScene;
export type SceneChoice = { readonly kind: "duo"; readonly name: DuoScene } | { readonly kind: "solo"; readonly who: CatWho; readonly name: SoloScene<CatWho> | "busy" };

const DUO_WEIGHT: Record<DuoScene, number> = { play: 1.2, chase: 1, nap: 0.7, mutual: 1.1, chair: 0.6, eat: 0.8, rollduo: 0.8 };
const SOLO_WEIGHT: { readonly [W in CatWho]: Record<SoloScene<W>, number> } = {
  a: { yawn: 1.2, roll: 0.9, belly: 0.8, yarn: 0.9, fishnap: 0.7 },
  b: { zoom: 1, groom: 1.2, mouse: 0.8, wand: 0.9, look: 1 },
};
const SOLOS_BEFORE_DUO = 3;

function pickWeighted<K extends string>(weights: Record<K, number>, random: () => number, avoid: string | null): K {
  const entries = (Object.entries(weights) as [K, number][]).filter(([name]) => name !== avoid);
  let roll = random() * entries.reduce((sum, [, weight]) => sum + weight, 0);
  for (const [name, weight] of entries) if ((roll -= weight) < 0) return name;
  return entries[entries.length - 1][0];
}

export interface SceneChoiceInput { readonly random: () => number; readonly busy: boolean; readonly last: string | null; readonly solosSinceDuo: number }

export function chooseScene(input: SceneChoiceInput): SceneChoice {
  const { random, last } = input;
  if (input.busy) return last === "busy" && random() < 0.4
    ? { kind: "solo", who: "a", name: pickWeighted(SOLO_WEIGHT.a, random, last) }
    : { kind: "solo", who: "b", name: "busy" };
  if (input.solosSinceDuo >= SOLOS_BEFORE_DUO || (input.solosSinceDuo >= 1 && random() < 0.35)) return { kind: "duo", name: pickWeighted(DUO_WEIGHT, random, last) };
  const who: CatWho = random() < 0.5 ? "a" : "b";
  return { kind: "solo", who, name: who === "a" ? pickWeighted(SOLO_WEIGHT.a, random, last) : pickWeighted(SOLO_WEIGHT.b, random, last) };
}

export function catSizeForWidth(width: number): CatSpriteSize | null {
  if (width < CAT_SHOW_MIN_PX) return null;
  return width >= CAT_WIDE_MIN_PX ? 48 : 32;
}

const frameCache = new Map<string, CatSpriteFrame>();
function spriteFrame(size: CatSpriteSize, key: string, code: string): CatSpriteFrame {
  const id = `${size}|${key}`;
  let frame = frameCache.get(id);
  if (!frame) { frame = decodeCatFrame(code); frameCache.set(id, frame); }
  return frame;
}
export function catSignFrame(size: CatSpriteSize): CatSpriteFrame {
  return spriteFrame(size, "sign", CAT_SIGN[size]);
}

export const catStageOffset = (size: CatSpriteSize) => catSignFrame(size).w + Math.round(8 * size / 48);

export function catFrame(size: CatSpriteSize, who: CatWho, pose: CatPose, index: number): CatSpriteFrame {
  const codes = CAT_SPRITES[size].cats[who][pose];
  if (!codes) throw new Error(`no ${pose} for ${who}`);
  const i = index % codes.length;
  return spriteFrame(size, `${who}|${pose}|${i}`, codes[i]);
}
export function catWalkFrameCount(size: CatSpriteSize, who: CatWho): number {
  return CAT_SPRITES[size].cats[who].walk?.length ?? 0;
}
function propFrame(size: CatSpriteSize, name: CatPropName, index: number): CatSpriteFrame {
  const frames = CAT_SPRITES[size].props[name].frames;
  const i = index % frames.length;
  return spriteFrame(size, `prop|${name}|${i}`, frames[i]);
}
function chairFrame(size: CatSpriteSize): CatSpriteFrame {
  return spriteFrame(size, "chair", CAT_SPRITES[size].chair);
}
function propBox(size: CatSpriteSize, name: CatPropName): { w: number; h: number } {
  const frames = CAT_SPRITES[size].props[name].frames.map((_, i) => propFrame(size, name, i));
  return { w: Math.max(...frames.map(frame => frame.w)), h: Math.max(...frames.map(frame => frame.h)) };
}

function leapFrame(size: CatSpriteSize, who: CatWho): number {
  let best = 0;
  for (let i = 0; i < catWalkFrameCount(size, who); i++) if (catFrame(size, who, "walk", i).w > catFrame(size, who, "walk", best).w) best = i;
  return best;
}

function bodySpan(set: CatSpriteSet, frame: CatSpriteFrame, dir: Dir): [number, number] {
  return dir === 1 ? [frame.x, frame.x + frame.w] : [set.W - frame.x - frame.w, set.W - frame.x];
}

interface Geometry {
  readonly size: CatSpriteSize;
  readonly set: CatSpriteSet;
  width: number;
  clampX(who: CatWho, x: number): number;
  body(who: CatWho, x: number, dir: Dir): [number, number];
  xForBodyLeft(who: CatWho, left: number, dir: Dir): number;
  xForBodyRight(who: CatWho, right: number, dir: Dir): number;
  home(who: CatWho): number;
  chairX(): number;
  propX(name: CatPropName, x: number): number;
}

function geometry(size: CatSpriteSize, width: number): Geometry {
  const set = CAT_SPRITES[size];
  const extent = {} as Record<CatWho, [number, number]>;
  for (const who of ["a", "b"] as const) {
    let lo = Infinity, hi = -Infinity;
    for (const [pose, codes] of Object.entries(set.cats[who]) as [CatPose, readonly string[]][]) {
      if (pose === "chair" || pose === "perch") continue;
      codes.forEach((_, i) => {
        const frame = catFrame(size, who, pose, i);
        for (const dir of [1, -1] as const) { const [l, r] = bodySpan(set, frame, dir); lo = Math.min(lo, l); hi = Math.max(hi, r); }
      });
    }
    extent[who] = [lo, hi];
  }
  const g: Geometry = {
    size, set, width,
    clampX(who, x) { const [lo, hi] = extent[who]; return Math.max(-lo, Math.min(g.width - hi, x)); },
    body(who, x, dir) { const [l, r] = bodySpan(set, catFrame(size, who, "sit", 0), dir); return [x + l, x + r]; },
    xForBodyLeft(who, left, dir) { return left - bodySpan(set, catFrame(size, who, "sit", 0), dir)[0]; },
    xForBodyRight(who, right, dir) { return right - bodySpan(set, catFrame(size, who, "sit", 0), dir)[1]; },
    home(who) {
      const b = g.clampX("b", g.xForBodyLeft("b", HOME_PAD_PX, HOME_DIR.b));
      if (who === "b") return b;
      return g.clampX("a", g.xForBodyLeft("a", g.body("b", b, HOME_DIR.b)[1] + HOME_GAP_PX, HOME_DIR.a));
    },
    chairX() {
      const frame = chairFrame(size);
      const left = g.body("a", g.home("a"), HOME_DIR.a)[1] + HOME_GAP_PX * 2 - frame.x;
      return Math.max(-frame.x, Math.min(g.width - set.W, left));
    },
    propX(name, x) { return Math.max(0, Math.min(g.width - propBox(size, name).w, x)); },
  };
  return g;
}

export interface CatDraw {
  readonly who: CatWho;
  readonly pose: CatPose;
  readonly frame: number;
  readonly x: number;
  readonly y: number;
  readonly dir: Dir;
  readonly motion: string;
  readonly gait: GaitKind | null;
}
export interface CatSample {
  readonly size: CatSpriteSize;
  readonly cats: readonly [CatDraw, CatDraw];
  readonly prop: { readonly name: CatPropName; readonly frame: number; readonly x: number } | null;
  readonly chair: { readonly x: number } | null;
  readonly scene: string;
}
export interface CatTarget { readonly x: number; readonly y: number }
export interface CatEngineState { readonly asking: boolean; readonly busy: boolean; readonly allDone: boolean }

interface SegBase { start: number; end: number; readonly motion: string; readonly dir: Dir }
type Seg =
  | (SegBase & { readonly kind: "hold"; readonly pose: CatPose; readonly x: number; readonly y: number; readonly frames: readonly number[] | null; readonly frameMs: number })
  | (SegBase & { readonly kind: "gait"; readonly gait: GaitKind; readonly x0: number; readonly x1: number; readonly y: number; readonly timing: GaitTiming; readonly glide: boolean })
  | (SegBase & { readonly kind: "jump"; readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number; readonly arc: number; readonly from: "point" | "target"; readonly to: "point" | "target"; readonly land: CatPose })
  | (SegBase & { readonly kind: "perch" });

interface PropPhase { readonly start: number; readonly end: number; readonly x0: number; readonly x1: number; readonly frames: readonly number[]; readonly frameMs: number }
interface Fixture { readonly kind: "prop" | "chair"; readonly name: CatPropName | null; readonly start: number; end: number; readonly x: number; readonly phases: PropPhase[] }
interface SceneWindow { readonly name: string; readonly start: number; end: number }

function autoFrame(who: CatWho, pose: CatPose, t: number): number {
  if (BLINK_POSES.has(pose)) return (t + PHASE[who]) % BLINK_EVERY[who] < BLINK_MS ? 1 : 0;
  if (BREATH_POSES.has(pose)) return Math.floor((t + PHASE[who]) / BREATH_MS[who]) % 2;
  return 0;
}
export function perchBeat(elapsed: number): { pose: CatPose; turned: boolean; left: number } {
  const e = Math.max(0, elapsed);
  if (e < PERCH_LOOK_MS) return { pose: "meow", turned: false, left: PERCH_LOOK_MS - e };
  const k = Math.floor((e - PERCH_LOOK_MS) / PERCH_BEAT_MS), into = (e - PERCH_LOOK_MS) % PERCH_BEAT_MS;
  const turned = k % 2 === 1;
  if (turned && into < PERCH_LOOK_MS) return { pose: "meow", turned, left: PERCH_LOOK_MS - into };
  return { pose: "sit", turned, left: PERCH_BEAT_MS - into };
}

function restPose(pose: CatPose): CatPose {
  return BLINK_POSES.has(pose) || BREATH_POSES.has(pose) ? pose : "sit";
}
function autoNext(who: CatWho, pose: CatPose, t: number): number {
  const local = t + PHASE[who];
  if (BLINK_POSES.has(pose)) {
    const period = BLINK_EVERY[who], into = local % period;
    return t + (into < BLINK_MS ? BLINK_MS - into : period - into);
  }
  if (BREATH_POSES.has(pose)) return t + BREATH_MS[who] - local % BREATH_MS[who];
  return Infinity;
}

export interface CatEngineOptions { readonly size: CatSpriteSize; readonly width: number; readonly random: () => number; readonly now: number }
export interface CatEngine {
  sample(t: number): CatSample;
  nextChange(t: number): number;
  setState(state: CatEngineState, t: number, freshAsk?: boolean): void;
  setTarget(target: CatTarget | null, t: number): void;
  setLayout(width: number, size: CatSpriteSize, t: number): void;
  force(scene: CatSceneName, t: number): void;
  sceneAt(t: number): string;
}

interface Cursor {
  readonly who: CatWho;
  t: number;
  x: number;
  y: number;
  dir: Dir;
  pose: CatPose;
  perched: boolean;
  motion: string;
}

export function createCatEngine(options: CatEngineOptions): CatEngine {
  const random = options.random;
  let g = geometry(options.size, options.width);
  let state: CatEngineState = { asking: false, busy: false, allDone: false };
  let target: CatTarget | null = null;
  let lostAt: number | null = null;
  let lastTarget: CatTarget = { x: options.width, y: -24 };
  let askPending = false;
  let forced: CatSceneName | null = null;
  let afterScene = true;
  let lastScene: string | null = null;
  let solosSinceDuo = 0;
  const tracks: Record<CatWho, Seg[]> = { a: [], b: [] };
  let fixtures: Fixture[] = [];
  let scenes: SceneWindow[] = [];
  const rnd = (lo: number, hi: number) => lo + random() * (hi - lo);

  function placeAtHome(t: number) {
    for (const who of ["a", "b"] as const) tracks[who] = [{ kind: "hold", start: t, end: t, motion: "idle", dir: HOME_DIR[who], pose: "sit", x: g.home(who), y: 0, frames: null, frameMs: 0 }];
  }
  placeAtHome(options.now);

  const trackEnd = (who: CatWho) => tracks[who][tracks[who].length - 1].end;
  const segAt = (who: CatWho, t: number): Seg => {
    const segs = tracks[who];
    for (let i = segs.length - 1; i >= 0; i--) if (segs[i].start <= t) return segs[i];
    return segs[0];
  };

  function perchPoint(who: CatWho, dir: Dir): { x: number; y: number } {
    const tg = target ?? lastTarget;
    const [l, r] = bodySpan(g.set, catFrame(g.size, who, "sit", 0), dir);
    return { x: tg.x - (l + r) / 2, y: tg.y };
  }

  function sampleSeg(who: CatWho, seg: Seg, t: number): CatDraw {
    const base = { who, motion: seg.motion, dir: seg.dir };
    switch (seg.kind) {
      case "hold": {
        const frame = seg.frames ? seg.frames[Math.floor(Math.max(0, t - seg.start) / seg.frameMs) % seg.frames.length] : autoFrame(who, seg.pose, t);
        return { ...base, pose: seg.pose, frame, x: seg.y === 0 && seg.pose !== "chair" ? g.clampX(who, seg.x) : seg.x, y: seg.y, gait: null };
      }
      case "gait": {
        const distance = Math.abs(seg.x1 - seg.x0);
        const { dx, index } = t >= seg.end ? { dx: distance, index: 0 } : gaitOffset(seg.timing, seg.glide, distance, t - seg.start);
        return { ...base, pose: "walk", frame: index % catWalkFrameCount(g.size, who), x: g.clampX(who, seg.x0 + Math.sign(seg.x1 - seg.x0) * dx), y: seg.y, gait: seg.gait };
      }
      case "jump": {
        const from = seg.from === "target" ? perchPoint(who, seg.dir) : { x: seg.x0, y: seg.y0 };
        const to = seg.to === "target" ? perchPoint(who, seg.dir) : { x: seg.x1, y: seg.y1 };
        if (t >= seg.end) return { ...base, pose: seg.land, frame: autoFrame(who, seg.land, t), x: to.x, y: to.y, gait: null };
        const k = Math.min(1, Math.max(0, (t - seg.start) / Math.max(1, seg.end - seg.start - ARRIVE_MS)));
        return { ...base, pose: "walk", frame: leapFrame(g.size, who), x: from.x + (to.x - from.x) * k, y: from.y + (to.y - from.y) * k - seg.arc * 4 * k * (1 - k), gait: null };
      }
      case "perch": {
        const at = perchPoint(who, seg.dir);
        const { pose, turned } = perchBeat(t - seg.start);
        return { ...base, dir: turned ? (-seg.dir as Dir) : seg.dir, pose, frame: autoFrame(who, pose, t), x: at.x, y: at.y, gait: null };
      }
    }
  }
  const perchNext = (seg: Seg, t: number) => t + perchBeat(t - seg.start).left;

  function segNext(who: CatWho, seg: Seg, t: number): number {
    if (t >= seg.end) return Infinity;
    switch (seg.kind) {
      case "hold": return Math.min(seg.end, seg.frames ? seg.start + (Math.floor((t - seg.start) / seg.frameMs) + 1) * seg.frameMs : autoNext(who, seg.pose, t));
      case "gait": return seg.glide ? t + CONTINUOUS_MS : Math.min(seg.end, seg.start + (Math.floor((t - seg.start) / seg.timing.frameMs) + 1) * seg.timing.frameMs);
      case "jump": return t + CONTINUOUS_MS;
      case "perch": return Math.min(seg.end, autoNext(who, "sit", t), perchNext(seg, t));
    }
  }

  function cursorAt(who: CatWho, t: number): Cursor {
    const seg = segAt(who, t);
    const draw = sampleSeg(who, seg, t);
    const perched = seg.kind === "perch" || (seg.kind === "jump" && seg.to === "target" && t >= seg.end);
    return { who, t, x: draw.x, y: draw.y, dir: draw.dir, pose: draw.pose === "walk" ? "sit" : draw.pose, perched, motion: draw.motion };
  }

  const push = (c: Cursor, seg: Seg) => { tracks[c.who].push(seg); c.t = seg.end; };
  const hold = (c: Cursor, pose: CatPose, ms: number, frames: readonly number[] | null = null, frameMs = Infinity) => {
    push(c, { kind: "hold", start: c.t, end: c.t + Math.max(0, ms), motion: c.motion, dir: c.dir, pose, x: c.x, y: c.y, frames, frameMs });
    c.pose = pose;
  };
  const asleep = (pose: CatPose) => state.allDone && (pose === "chair" || pose === "perch");
  const rest = (c: Cursor, ms: number) => { const pose = restPose(c.pose); hold(c, pose, ms, asleep(pose) ? [SHUT_FRAME] : null); };
  const face = (c: Cursor, dir: Dir) => { c.dir = dir; };
  const faceToward = (c: Cursor, x: number) => { if (Math.abs(x - c.x) >= 1) c.dir = x > c.x ? 1 : -1; };
  const go = (c: Cursor, x: number, gait: GaitKind = "walk") => {
    x = g.clampX(c.who, x);
    const distance = Math.abs(x - c.x);
    if (distance < 1) return;
    faceToward(c, x);
    const walk = g.set.walk[c.who], timing = gaitTiming(walk, gait);
    push(c, { kind: "gait", start: c.t, end: c.t + gaitDuration(timing, walk.glide, distance), motion: c.motion, dir: c.dir, gait, x0: c.x, x1: x, y: c.y, timing, glide: walk.glide });
    c.x = x; c.pose = "sit";
  };
  const jump = (c: Cursor, x: number, y: number, arc: number, ms: number, land: CatPose = "sit") => {
    if (y === 0 && land !== "chair") x = g.clampX(c.who, x);
    faceToward(c, x);
    push(c, { kind: "jump", start: c.t, end: c.t + ms, motion: c.motion, dir: c.dir, x0: c.x, y0: c.y, x1: x, y1: y, arc, from: "point", to: "point", land });
    c.x = x; c.y = y; c.pose = land; c.perched = false;
  };
  const ground = (c: Cursor) => {
    if (c.pose === "chair") { jump(c, c.x - 30 * g.size / 48, 0, 6, 420); return; }
    if (c.perched) {
      const at = perchPoint(c.who, c.dir), x = g.clampX(c.who, at.x);
      push(c, { kind: "jump", start: c.t, end: c.t + 420, motion: c.motion, dir: c.dir, x0: 0, y0: 0, x1: x, y1: 0, arc: 6, from: "target", to: "point", land: "sit" });
      c.x = x; c.y = 0; c.pose = "sit"; c.perched = false;
      return;
    }
    if (c.y !== 0) jump(c, c.who === "b" && c.pose === "perch" ? c.x + 36 * g.size / 48 : c.x, 0, 4, 360);
  };
  const motion = (c: Cursor, name: string) => { c.motion = name; };
  const sync = (...cs: Cursor[]) => {
    const t = Math.max(...cs.map(c => c.t));
    for (const c of cs) if (c.t < t) restUntil(c, t);
  };
  const bats = (c: Cursor, n: number, ms = 230) => { for (let i = 0; i < n; i++) { hold(c, "bat", ms, [0]); hold(c, "bat", ms, [1]); } };
  const travel = (c: Cursor, x: number) => go(c, x, Math.abs(g.clampX(c.who, x) - c.x) > TRAVEL_RUN_PX * g.size / 48 ? "run" : "walk");
  const goHome = (c: Cursor) => { ground(c); travel(c, g.home(c.who)); face(c, HOME_DIR[c.who]); hold(c, "sit", 300); };
  const prop = (name: CatPropName, start: number, x: number): Fixture => {
    const fixture: Fixture = { kind: "prop", name, start, end: Infinity, x: g.propX(name, x), phases: [] };
    fixtures.push(fixture);
    return fixture;
  };
  const propMove = (f: Fixture, start: number, x1: number, pxPerMs: number, frames: readonly number[], frameMs: number) => {
    const x0 = f.phases.length ? f.phases[f.phases.length - 1].x1 : f.x;
    const to = f.name ? g.propX(f.name, x1) : x1;
    f.phases.push({ start, end: start + Math.max(frameMs, Math.abs(to - x0) / pxPerMs), x0, x1: to, frames, frameMs });
    return f.phases[f.phases.length - 1].end;
  };
  const propLoop = (f: Fixture, start: number, end: number, frames: readonly number[], frameMs: number) => {
    const x = f.phases.length ? f.phases[f.phases.length - 1].x1 : f.x;
    f.phases.push({ start, end, x0: x, x1: x, frames, frameMs });
  };
  const propEdge = (c: Cursor, name: CatPropName, gap: number) => {
    const [l, r] = g.body(c.who, c.x, c.dir);
    return c.dir === 1 ? r + gap : l - gap - propBox(g.size, name).w;
  };

  function makeRoom(actor: Cursor, idle: Cursor, need: number): Dir {
    const [il, ir] = g.body(idle.who, idle.x, idle.dir);
    const [l, r] = g.body(actor.who, actor.x, actor.dir);
    const fits = (lo: number, hi: number) => lo >= 0 && hi <= g.width && (hi + IDLE_CLEAR_PX <= il || lo >= ir + IDLE_CLEAR_PX);
    const away: Dir = (il + ir) / 2 > (l + r) / 2 ? -1 : 1;
    for (const d of [away, -away as Dir]) if (d === 1 ? fits(r, r + need) : fits(l - need, l)) return d;
    if (g.width - ir >= il) { travel(actor, g.xForBodyLeft(actor.who, ir + IDLE_CLEAR_PX * 2, 1)); return 1; }
    travel(actor, g.xForBodyRight(actor.who, il - IDLE_CLEAR_PX * 2, -1));
    return -1;
  }
  function occupied(other: CatWho, from: number, until: number): [number, number][] {
    const spans: [number, number][] = [];
    for (let t = from; t <= Math.min(until, from + IDLE_LOOKAHEAD_MS) + SPAN_SAMPLE_MS; t += SPAN_SAMPLE_MS) {
      const d = sampleSeg(other, segAt(other, t), t);
      spans.push(g.body(other, d.x, d.dir));
    }
    for (const f of fixtures) if (f.kind === "prop" && f.name && f.end > from && f.start < until) {
      const xs = [f.x, ...f.phases.flatMap(p => [p.x0, p.x1])];
      spans.push([Math.min(...xs), Math.max(...xs) + propBox(g.size, f.name).w]);
    }
    return spans;
  }
  function idleStep(c: Cursor, away: Dir, spans: readonly [number, number][]): boolean {
    for (const dir of [away, -away as Dir]) {
      const x = g.clampX(c.who, c.x + dir * rnd(10, 18) * g.size / 48);
      if (Math.abs(x - c.x) < 4) continue;
      const moveDir: Dir = x > c.x ? 1 : -1;
      const ends = [g.body(c.who, c.x, c.dir), g.body(c.who, c.x, moveDir), g.body(c.who, x, moveDir)];
      const lo = Math.min(...ends.map(([l]) => l)), hi = Math.max(...ends.map(([, r]) => r));
      if (spans.every(([l, r]) => hi + IDLE_CLEAR_PX <= l || lo >= r + IDLE_CLEAR_PX)) { go(c, x); return true; }
    }
    return false;
  }
  function idleMotion(c: Cursor, mate: CatWho, until: number) {
    motion(c, "idle");
    const beat = () => {
      const ms = rnd(IDLE_HOLD_MIN_MS, IDLE_HOLD_MAX_MS), left = until - c.t;
      if (left - ms >= IDLE_MIN_PIECE_MS) return ms;
      return left <= IDLE_HOLD_MAX_MS ? Math.max(0, left) : left - IDLE_MIN_PIECE_MS;
    };
    if (c.pose !== "sit") { hold(c, "sit", beat()); return; }
    const mateNow = sampleSeg(mate, segAt(mate, c.t), c.t);
    const toward: Dir = mateNow.x > c.x ? 1 : -1;
    const r = random();
    if (r < 0.4 && idleStep(c, -toward as Dir, occupied(mate, c.t, until))) { hold(c, "sit", beat()); return; }
    if (r < 0.6 && c.dir !== toward) { face(c, toward); hold(c, "sit", beat()); return; }
    if (c.who === "a") { if (r < 0.85) hold(c, "loaf", beat()); else hold(c, "meow", 900); }
    else if (r < 0.75) hold(c, "stand", beat());
    else hold(c, "groom", beat(), [0, 1], 460);
  }
  function restUntil(c: Cursor, t: number) {
    while (c.t < t) {
      const left = t - c.t, pose = restPose(c.pose);
      if (left < IDLE_MIN_PIECE_MS || !(pose === "sit" || pose === "stand")) { rest(c, left); return; }
      const ms = left <= IDLE_HOLD_MAX_MS ? left : Math.min(IDLE_HOLD_MIN_MS, left - IDLE_MIN_PIECE_MS);
      hold(c, pose === "sit" ? IDLE_ALT_POSE[c.who] : "sit", ms);
    }
  }
  function idleUntil(c: Cursor, mate: CatWho, t: number) {
    while (t - c.t > IDLE_HOLD_MAX_MS + IDLE_MIN_PIECE_MS) idleMotion(c, mate, t);
    motion(c, "idle");
    restUntil(c, t);
  }

  type Pair = { a: Cursor; b: Cursor };
  const SOLO: Record<SoloScene<"a"> | SoloScene<"b"> | "busy" | "ask", (p: Pair) => void> = {
    yawn({ a }) { hold(a, "meow", 1300, [0, 1], 650); hold(a, "sit", 900); },
    roll({ a }) { rollOver(a, 4); hold(a, "lie", 1200); hold(a, "roll", 600, [0]); hold(a, "sit", 400); },
    belly({ a }) {
      hold(a, "loaf", 700); hold(a, "lie", 800);
      hold(a, "belly", rnd(6500, 9000));
      hold(a, "lie", 700); hold(a, "loaf", 600); hold(a, "sit", 300);
    },
    yarn({ a, b }) {
      const w = propBox(g.size, "yarn").w;
      const d = makeRoom(a, b, 2 + w + 40 * g.size / 48);
      face(a, d);
      const yarn = prop("yarn", a.t, propEdge(a, "yarn", 2));
      hold(a, "sit", 900);
      for (let i = 0; i < 2; i++) {
        bats(a, 1);
        const rolled = propMove(yarn, a.t, (yarn.phases.at(-1)?.x1 ?? yarn.x) + d * rnd(10, 18) * g.size / 48, 0.03, [0, 1], 240);
        hold(a, "sit", rolled + 700 - a.t);
        const yx = yarn.phases[yarn.phases.length - 1].x1;
        go(a, d === 1 ? g.xForBodyRight("a", yx - 2, 1) : g.xForBodyLeft("a", yx + w + 2, -1)); face(a, d); hold(a, "sit", 500);
      }
      hold(a, "loaf", 1600);
      yarn.end = a.t;
      hold(a, "sit", 500);
    },
    fishnap({ a, b }) {
      face(a, makeRoom(a, b, 1 + propBox(g.size, "fish").w));
      const fish = prop("fish", a.t, propEdge(a, "fish", 1));
      hold(a, "loaf", 1000); hold(a, "lie", rnd(8000, 11000)); hold(a, "loaf", 900);
      fish.end = a.t; hold(a, "sit", 400);
    },
    zoom({ b }) {
      const far = g.clampX("b", g.home("a") + Math.max(120, g.width * 0.45) * g.size / 48);
      face(b, 1); hold(b, "bat", 400, [0]);
      go(b, far, "run"); hold(b, "sit", 450); face(b, -1);
      go(b, g.home("b"), "run"); face(b, 1); hold(b, "sit", 300);
    },
    groom({ b }) { hold(b, "groom", 8 * 380, [0, 1], 380); hold(b, "sit", 700); },
    look({ b }) { hold(b, "sit", 500); hold(b, "stand", rnd(2000, 2800)); hold(b, "sit", 600); },
    mouse({ a, b }) {
      const w = propBox(g.size, "mouse").w, [al, ar] = g.body("a", a.x, a.dir);
      const d: Dir = g.width - ar >= al ? 1 : -1;
      faceToward(b, d === 1 ? ar : al);
      const mouse = prop("mouse", b.t, d === 1 ? ar + 8 : al - 8 - w);
      hold(b, "sit", 700); hold(b, "bat", 700, [0]);
      const rolled = propMove(mouse, b.t, mouse.x + d * Math.max(120, g.width * 0.4), 0.12, [0, 1], 140);
      hold(b, "bat", 250, [0]);
      const mx = mouse.phases[0].x1;
      go(b, d === 1 ? g.xForBodyRight("b", mx - 2, 1) : g.xForBodyLeft("b", mx + w + 2, -1), "run");
      if (b.t < rolled) hold(b, "sit", rolled - b.t);
      face(b, d); bats(b, 3);
      propMove(mouse, b.t, mx + d * 26, 0.09, [0, 1], 140);
      hold(b, "sit", 350);
      jump(b, b.x + d * 22 * g.size / 48, 0, 6, 420);
      hold(b, "sit", 900);
      mouse.end = b.t; hold(b, "sit", 500);
    },
    wand({ a, b }) {
      const [al, ar] = g.body("a", a.x, a.dir);
      const d: Dir = g.width - ar >= al ? 1 : -1;
      go(b, d === 1 ? g.xForBodyLeft("b", ar + 6, 1) : g.xForBodyRight("b", al - 6, -1)); face(b, d);
      const wand = prop("wand", b.t, propEdge(b, "wand", rnd(16, 28) * g.size / 48));
      const t0 = b.t;
      hold(b, "sit", 1000); hold(b, "bat", 800, [0]);
      propLoop(wand, t0, b.t, [0, 1], 460);
      const t1 = b.t, mid = wand.x + propBox(g.size, "wand").w / 2;
      jump(b, d === 1 ? g.xForBodyRight("b", mid, 1) : g.xForBodyLeft("b", mid, -1), 0, 12, 560);
      propLoop(wand, t1, b.t, [0, 1], 220);
      const t2 = b.t;
      bats(b, 3); hold(b, "sit", 1300);
      propLoop(wand, t2, b.t, [0, 1], 460);
      wand.end = b.t; hold(b, "sit", 400);
    },
    busy({ b }) {
      const away = g.clampX("b", g.home("b") + rnd(30, 60) * g.size / 48);
      hold(b, "bat", rnd(1200, 1800), [0, 1], 160);
      go(b, away, "run"); hold(b, "bat", rnd(900, 1400), [0, 1], 160);
      go(b, g.home("b"), "run"); face(b, 1); hold(b, "sit", 400);
    },
    ask({ a }) {
      if (a.perched) { motion(a, "perch"); push(a, { kind: "perch", start: a.t, end: a.t + PERCH_HOLD_MS, motion: a.motion, dir: a.dir }); }
      else {
        ground(a); hold(a, "sit", 300);
        const tg = target;
        if (!tg) {
          go(a, g.width, "run"); face(a, 1); hold(a, "sit", 400); bats(a, 1, 260);
          hold(a, "meow", PERCH_LOOK_MS);
          for (let i = 0; i < 3; i++) { hold(a, "sit", PERCH_BEAT_MS); face(a, -a.dir as Dir); }
          return;
        }
        go(a, perchPoint("a", 1).x, "run");
        const [left, right] = g.body("a", a.x, a.dir);
        face(a, tg.x >= (left + right) / 2 ? 1 : -1);
        hold(a, "bat", 240, [0]);
        push(a, { kind: "jump", start: a.t, end: a.t + 520, motion: a.motion, dir: a.dir, x0: a.x, y0: 0, x1: 0, y1: 0, arc: 10, from: "point", to: "target", land: "sit" });
        a.perched = true;
        push(a, { kind: "perch", start: a.t, end: a.t + PERCH_HOLD_MS, motion: a.motion, dir: a.dir });
      }
      ground(a);
    },
  };

  function rollOver(c: Cursor, to: number) { hold(c, "roll", 600, [0]); for (let i = 1; i <= to; i++) hold(c, "roll", 520, [i]); }

  const DUO: Record<DuoScene | "sleep", (p: Pair) => void> = {
    play({ a, b }) {
      hold(a, "loaf", 500);
      go(b, g.xForBodyRight("b", g.body("a", a.x, a.dir)[0] - 6, 1)); face(b, 1); hold(b, "walk", 700, [0]);
      sync(a, b);
      for (let i = 0; i < 3; i++) {
        hold(b, "bat", 300, [0]); bats(b, 1); hold(b, "bat", 230, [0]);
        hold(a, "sit", b.t - a.t - 460); bats(a, 1);
        sync(a, b);
        if (i < 2) hold(a, "loaf", 300);
      }
      hold(a, "sit", 900); hold(b, "sit", 900);
    },
    chase({ a, b }) {
      const x1 = g.clampX("b", g.home("a") + Math.max(110, g.width * 0.35) * g.size / 48);
      face(b, 1); hold(b, "bat", 500, [0]); hold(a, "sit", 500);
      go(b, x1, "run");
      hold(a, "sit", 380); go(a, g.xForBodyRight("a", g.body("b", x1, 1)[0] - 6, 1), "run");
      face(b, -1); hold(b, "bat", Math.max(0, a.t - b.t), [0]);
      sync(a, b); hold(a, "bat", 600, [0]); hold(b, "bat", 600, [0]);
      jump(b, g.clampX("b", g.xForBodyRight("b", g.body("a", a.x, a.dir)[0] - 4, -1)), 0, 12 * g.size / 48, 560);
      go(b, g.home("b"), "run");
      hold(a, "sit", 560 + 250); go(a, g.home("a"), "run");
      face(b, 1); face(a, -1);
      sync(a, b); hold(a, "sit", 700); hold(b, "sit", 700);
    },
    nap({ a, b }) {
      hold(a, "loaf", 600);
      go(b, g.xForBodyRight("b", g.body("a", a.x, a.dir)[0] + 4, 1)); face(b, 1); hold(b, "sit", 900);
      sync(a, b);
      hold(a, "lie", 800); hold(b, "sit", 800);
      const nap = rnd(8000, 11000);
      hold(a, "lie", nap); hold(b, "lie", nap);
      hold(b, "stand", 1500); hold(b, "sit", 700); hold(a, "lie", 2200);
      hold(a, "meow", 1200, [0, 1], 600); hold(a, "loaf", 800); sync(a, b);
    },
    mutual({ a, b }) {
      hold(a, "sit", 300);
      go(b, g.xForBodyRight("b", g.body("a", a.x, a.dir)[0] + 8, 1)); face(b, 1);
      sync(a, b);
      const groom = rnd(2600, 3400);
      hold(b, "groom", groom, [0, 1], 420); hold(a, "sit", groom);
      hold(b, "sit", 700); hold(a, "loaf", 700);
      hold(b, "stand", 1600); hold(a, "loaf", 1600);
      hold(a, "sit", 900); hold(b, "sit", 900);
    },
    chair(p) { chairUp(p, false); },
    sleep(p) { chairUp(p, true); },
    eat({ a, b }) {
      const box = propBox(g.size, "bowl");
      const bowl = prop("bowl", Math.min(a.t, b.t), g.body("a", g.home("a"), HOME_DIR.a)[1] + 24 * g.size / 48);
      const center = bowl.x + box.w / 2;
      go(b, g.xForBodyRight("b", center - box.w / 2 + 4, 1)); face(b, 1);
      go(a, g.xForBodyLeft("a", center + box.w / 2 - 4, -1)); face(a, -1);
      sync(a, b);
      for (let i = 0; i < 6; i++) {
        hold(b, i % 2 ? "sit" : "walk", rnd(500, 900), i % 2 ? null : [0]);
        hold(a, i % 2 ? "walk" : "sit", rnd(500, 900), i % 2 ? [0] : null);
      }
      sync(a, b); hold(a, "sit", 1000); hold(b, "sit", 1000);
      bowl.end = a.t; hold(a, "sit", 400); hold(b, "sit", 400);
    },
    rollduo({ a, b }) {
      go(b, g.xForBodyRight("b", g.body("a", a.x, a.dir)[0] - 4, 1)); face(b, 1); hold(b, "sit", 500);
      sync(a, b);
      rollOver(a, 4); hold(b, "sit", a.t - b.t);
      rollOver(b, 4); hold(a, "lie", b.t - a.t);
      const rest = rnd(3500, 5000); hold(a, "lie", rest); hold(b, "lie", rest);
      hold(a, "roll", 500, [0]); hold(b, "lie", 500); hold(b, "roll", 700, [0]); hold(a, "sit", 700);
      hold(a, "sit", 400); hold(b, "sit", 400);
    },
  };

  function yay(b: Cursor) {
    hold(b, "sit", 200);
    for (let i = 0; i < 2; i++) { hold(b, "bat", 120, [0]); jump(b, b.x, 0, 7 * g.size / 48, 360); }
    hold(b, "sit", 900);
  }

  function chairUp({ a, b }: Pair, asleep: boolean) {
    const cx = g.chairX();
    const chair: Fixture = { kind: "chair", name: null, start: Math.max(a.t, b.t), end: Infinity, x: cx, phases: [] };
    fixtures.push(chair);
    sync(a, b); hold(a, "sit", 900); hold(b, "sit", 900);
    const shut = asleep ? [SHUT_FRAME] : null;
    travel(a, cx - 30 * g.size / 48); jump(a, cx, 0, 6, 420, "chair"); face(a, 1); hold(a, "chair", asleep ? 300 : 900, shut);
    hold(b, "sit", Math.max(0, a.t - b.t));
    travel(b, cx + 44 * g.size / 48); jump(b, cx + g.set.arm[0], g.set.arm[1], 6, 420, "perch"); face(b, -1);
    if (asleep) {
      const end = Math.max(a.t, b.t) + SLEEP_CHUNK_MS;
      hold(a, "chair", end - a.t, shut); hold(b, "perch", end - b.t, shut);
      return;
    }
    sync(a, b);
    const stay = rnd(10000, 15000);
    hold(a, "chair", stay); hold(b, "perch", stay);
    jump(b, cx + 44 * g.size / 48, 0, 6, 420); hold(b, "sit", 300);
    hold(a, "chair", b.t - a.t); jump(a, cx - 30 * g.size / 48, 0, 6, 420); hold(a, "sit", 300);
    sync(a, b);
    chair.end = a.t;
    hold(a, "sit", 600); hold(b, "sit", 600);
  }

  function cut(t: number) {
    const keep = (who: CatWho) => {
      const segs = tracks[who].filter(seg => seg.start < t || seg === tracks[who][0]);
      const last = segs[segs.length - 1];
      if (last.end > t) {
        const cursor = cursorAt(who, t);
        last.end = Math.max(last.start, t);
        tracks[who] = segs;
        return cursor;
      }
      tracks[who] = segs;
      return cursorAt(who, t);
    };
    const a = keep("a"), b = keep("b");
    const onChair = a.pose === "chair" || b.pose === "perch";
    fixtures = fixtures.filter(f => f.start < t);
    for (const f of fixtures) if (f.end > t) f.end = f.kind === "chair" && onChair ? t + 900 : t;
    scenes = scenes.filter(s => s.start < t);
    for (const s of scenes) if (s.end > t) s.end = t;
    for (const c of [a, b]) {
      tracks[c.who].push(c.perched
        ? { kind: "perch", start: t, end: t, motion: c.motion, dir: c.dir }
        : { kind: "hold", start: t, end: t, motion: c.motion, dir: c.dir, pose: c.pose, x: c.x, y: c.y, frames: null, frameMs: 0 });
    }
    return { a, b };
  }

  function play(name: CatSceneName | "idle", p: Pair) {
    const start = Math.max(p.a.t, p.b.t);
    const scene: SceneWindow = { name, start, end: Infinity };
    scenes.push(scene);
    for (const c of [p.a, p.b]) motion(c, name);
    if (name === "idle") {
      const end = start + rnd(2500, 6000);
      for (const c of [p.a, p.b]) { ground(c); idleUntil(c, c === p.a ? "b" : "a", end); }
      sync(p.a, p.b);
    } else if (name === "sleep" && p.a.pose === "chair") {
      hold(p.a, "chair", SLEEP_CHUNK_MS, [SHUT_FRAME]); hold(p.b, p.b.pose, SLEEP_CHUNK_MS, p.b.pose === "perch" ? [SHUT_FRAME] : null);
    } else if (name === "yay") {
      ground(p.a); goHome(p.a);
      ground(p.b); yay(p.b);
      idleUntil(p.a, "b", p.b.t);
      sync(p.a, p.b);
    } else if (name in DUO) {
      for (const c of [p.a, p.b]) { ground(c); if (name !== "sleep") goHome(c); motion(c, name); }
      sync(p.a, p.b);
      DUO[name as keyof typeof DUO](p);
      sync(p.a, p.b);
    } else {
      const actor = name === "busy" || (CAT_SOLO_SCENES.b as readonly string[]).includes(name) ? p.b : p.a;
      const other = actor === p.a ? p.b : p.a;
      if (name !== "ask") ground(actor);
      motion(actor, name);
      SOLO[name as keyof typeof SOLO](p);
      if (name !== "ask") goHome(actor);
      else { motion(actor, name); travel(actor, g.home(actor.who)); face(actor, HOME_DIR[actor.who]); hold(actor, "sit", 300); }
      if (!other.perched) ground(other);
      idleUntil(other, actor.who, actor.t);
      sync(p.a, p.b);
    }
    scene.end = Math.max(p.a.t, p.b.t);
    lastScene = name;
  }

  function planAt(t: number) {
    const p = { a: cursorAt("a", t), b: cursorAt("b", t) };
    if (forced) { const name = forced; forced = null; afterScene = true; play(name, p); return; }
    if (state.allDone) { play("sleep", p); return; }
    if (askPending) { askPending = false; afterScene = true; play("ask", p); return; }
    if (afterScene) { afterScene = false; play("idle", p); return; }
    afterScene = true;
    const choice = chooseScene({ random, busy: state.busy, last: lastScene, solosSinceDuo });
    solosSinceDuo = choice.kind === "duo" ? 0 : solosSinceDuo + 1;
    play(choice.name, p);
  }

  function ensure(t: number) {
    for (let guard = 0; guard < 64; guard++) {
      const endA = trackEnd("a"), endB = trackEnd("b");
      if (Math.min(endA, endB) > t) return;
      const end = Math.max(endA, endB);
      for (const who of ["a", "b"] as const) if (trackEnd(who) < end) {
        const c = cursorAt(who, trackEnd(who));
        restUntil(c, end);
      }
      if (end > t) return;
      planAt(end);
    }
  }

  function prune(t: number) {
    for (const who of ["a", "b"] as const) {
      const segs = tracks[who];
      let i = 0;
      while (i < segs.length - 1 && segs[i + 1].start <= t && segs[i].end <= t) i++;
      if (i) tracks[who] = segs.slice(i);
    }
    fixtures = fixtures.filter(f => f.end > t);
    scenes = scenes.filter(s => s.end > t || s === scenes[scenes.length - 1]);
  }

  function leaveLostTarget(t: number) {
    if (lostAt === null || t - lostAt < TARGET_GRACE_MS) return;
    lostAt = null;
    ensure(t);
    const seg = segAt("a", t);
    if ((seg.kind === "perch" && t < seg.end) || (seg.kind === "jump" && seg.to === "target" && t < seg.end)) interrupt(t, null);
  }

  function interrupt(t: number, next: CatSceneName | null) {
    cut(t);
    forced = next;
    afterScene = true;
    planAt(t);
  }

  function fixtureDraw(f: Fixture, t: number): { x: number; frame: number } {
    let x = f.x, frame = 0;
    for (const phase of f.phases) {
      if (t < phase.start) break;
      if (t >= phase.end) { x = phase.x1; frame = 0; continue; }
      x = phase.x0 + (phase.x1 - phase.x0) * (t - phase.start) / (phase.end - phase.start);
      frame = phase.frames[Math.floor((t - phase.start) / phase.frameMs) % phase.frames.length];
      break;
    }
    return { x, frame };
  }

  const engine: CatEngine = {
    sample(t) {
      leaveLostTarget(t);
      ensure(t);
      prune(t);
      const draw = (who: CatWho) => sampleSeg(who, segAt(who, t), t);
      const active = fixtures.filter(f => f.start <= t && t < f.end);
      const propFixture = active.find(f => f.kind === "prop");
      const chairFixture = active.find(f => f.kind === "chair");
      const prop = propFixture && propFixture.name ? { name: propFixture.name, ...fixtureDraw(propFixture, t) } : null;
      return { size: g.size, cats: [draw("a"), draw("b")], prop, chair: chairFixture ? { x: chairFixture.x } : null, scene: engine.sceneAt(t) };
    },
    nextChange(t) {
      ensure(t);
      let next = Math.min(trackEnd("a"), trackEnd("b"), lostAt === null ? Infinity : lostAt + TARGET_GRACE_MS);
      for (const who of ["a", "b"] as const) {
        const segs = tracks[who], seg = segAt(who, t);
        next = Math.min(next, segNext(who, seg, t));
        const after = segs[segs.indexOf(seg) + 1];
        if (after) next = Math.min(next, after.start);
      }
      for (const f of fixtures) {
        if (f.start > t) next = Math.min(next, f.start);
        if (f.end > t) next = Math.min(next, f.end);
        for (const phase of f.phases) {
          if (phase.start > t) next = Math.min(next, phase.start);
          else if (t < phase.end) next = Math.min(next, phase.x0 !== phase.x1 ? t + CONTINUOUS_MS : phase.start + (Math.floor((t - phase.start) / phase.frameMs) + 1) * phase.frameMs, phase.end);
        }
      }
      return Math.max(t + 1, next);
    },
    setState(next, t, freshAsk = false) {
      const prev = state;
      state = { asking: next.asking, busy: next.busy, allDone: next.allDone };
      ensure(t);
      const current = engine.sceneAt(t);
      if (state.allDone !== prev.allDone) {
        if (state.allDone) { interrupt(t, "sleep"); return; }
        askPending = freshAsk;
        interrupt(t, null);
        return;
      }
      if (state.allDone) return;
      if (freshAsk) { askPending = false; interrupt(t, "ask"); return; }
      if (prev.asking && !state.asking && current === "ask") { interrupt(t, "yay"); return; }
      if (state.busy && !prev.busy && current !== "ask") interrupt(t, "busy");
    },
    setTarget(next, t) {
      if (target !== null && next === null) lostAt = t;
      if (next) { lastTarget = next; lostAt = null; }
      target = next;
      leaveLostTarget(t);
    },
    setLayout(width, size, t) {
      if (size === g.size) { g.width = width; return; }
      const ratio = size / g.size;
      const { a, b } = cut(t);
      g = geometry(size, width);
      fixtures = [];
      for (const c of [a, b]) tracks[c.who] = [{ kind: "hold", start: t, end: t, motion: "idle", dir: c.dir, pose: "sit", x: g.clampX(c.who, c.x * ratio), y: 0, frames: null, frameMs: 0 }];
      if (state.allDone) forced = "sleep";
      planAt(t);
    },
    force(scene, t) { interrupt(t, scene); },
    sceneAt(t) {
      for (let i = scenes.length - 1; i >= 0; i--) if (scenes[i].start <= t && t < scenes[i].end) return scenes[i].name;
      return "idle";
    },
  };
  return engine;
}

export function stillScene(size: CatSpriteSize, width: number, allDone: boolean): CatSample {
  const g = geometry(size, width);
  const draw = (who: CatWho, pose: CatPose, frame: number, x: number, y: number, dir: Dir): CatDraw => ({ who, pose, frame, x, y, dir, motion: "still", gait: null });
  if (allDone) {
    const cx = g.chairX();
    return {
      size, scene: "still", prop: null, chair: { x: cx },
      cats: [draw("a", "chair", SHUT_FRAME, cx, 0, 1), draw("b", "perch", SHUT_FRAME, cx + g.set.arm[0], g.set.arm[1], -1)],
    };
  }
  return { size, scene: "still", prop: null, chair: null, cats: [draw("a", "sit", 0, g.home("a"), 0, HOME_DIR.a), draw("b", "sit", 0, g.home("b"), 0, HOME_DIR.b)] };
}

export interface TodoCatsState {
  readonly asks: readonly string[];
  readonly askTarget: Element | null;
  readonly busy: boolean;
  readonly allDone: boolean;
}
export interface TodoCats { setState(state: TodoCatsState): void; destroy(): void }
export interface TodoCatsOptions { readonly random?: () => number; readonly signLabel?: string }

const TEXT_INPUT_TYPES: ReadonlySet<string> = new Set(["text", "search", "email", "url", "tel", "password", "number"]);
const DRAG_HANDLE_SELECTOR = "[draggable=\"true\"], [data-drag-handle]";
const DRAG_PAUSE_MAX_MS = 30000;
const TARGET_READ_MS = 8;
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function isTextEntry(el: Element | null): boolean {
  if (!el) return false;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName === "INPUT") return TEXT_INPUT_TYPES.has((el as HTMLInputElement).type);
  return (el as HTMLElement).isContentEditable === true;
}

function paletteRgb(palette: readonly string[]): [number, number, number][] {
  return palette.map(hex => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)]);
}

export function createTodoCats(host: HTMLElement, options: TodoCatsOptions = {}): TodoCats {
  const doc = host.ownerDocument;
  const view = doc.defaultView ?? window;
  const layer = doc.createElement("div");
  layer.className = "todo-cats";
  layer.setAttribute("aria-hidden", "true");
  host.classList.add("todo-cats-host");
  const canvas = (cls: string) => { const el = doc.createElement("canvas"); el.className = cls; el.hidden = true; layer.append(el); return el; };
  const chairEl = canvas("todo-cat-chair"), bEl = canvas("todo-cat"), aEl = canvas("todo-cat"), propEl = canvas("todo-cat-prop");
  const signEl = doc.createElement("canvas");
  signEl.className = "todo-cat-sign";
  signEl.hidden = true;
  if (options.signLabel) {
    signEl.setAttribute("role", "img");
    signEl.setAttribute("aria-label", options.signLabel);
    signEl.title = options.signLabel;
  } else signEl.setAttribute("aria-hidden", "true");
  host.append(signEl, layer);

  const random = options.random ?? Math.random;
  const reduced = view.matchMedia(REDUCED_MOTION);
  const bitmaps = new Map<string, HTMLCanvasElement>();
  const painted = new WeakMap<HTMLCanvasElement, string>();
  let size: CatSpriteSize | null = null;
  let width = 0;
  let engine: CatEngine | null = null;
  let state: TodoCatsState = { asks: [], askTarget: null, busy: false, allDone: false };
  let seenAsks: Set<string> | null = null;
  let askPending = false;
  const pauses = new Set<string>();
  let acc = 0, t0 = view.performance.now(), raf = 0, timer = 0, focusTimer = 0;
  const releaseTimers = new Map<string, number>();
  let targetCache: { at: number; point: CatTarget | null } | null = null;

  const clock = () => pauses.size ? acc : acc + view.performance.now() - t0;
  function bitmap(key: string, frame: CatSpriteFrame, palette: readonly string[]): HTMLCanvasElement {
    let el = bitmaps.get(key);
    if (el) return el;
    el = doc.createElement("canvas");
    el.width = frame.w; el.height = frame.h;
    const ctx = el.getContext("2d");
    if (ctx) {
      const rgb = paletteRgb(palette), image = ctx.createImageData(frame.w, frame.h);
      frame.px.forEach((v, i) => { if (v) image.data.set([...rgb[v - 1], 255], i * 4); });
      ctx.putImageData(image, 0, 0);
    }
    bitmaps.set(key, el);
    return el;
  }
  function blit(el: HTMLCanvasElement, key: string, source: HTMLCanvasElement, left: number, top: number, flip: boolean) {
    el.hidden = false;
    if (painted.get(el) !== key) {
      painted.set(el, key);
      if (el.width !== source.width || el.height !== source.height) { el.width = source.width; el.height = source.height; }
      const ctx = el.getContext("2d");
      if (ctx) { ctx.clearRect(0, 0, el.width, el.height); ctx.drawImage(source, 0, 0); }
    }
    el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)${flip ? " scaleX(-1)" : ""}`;
  }
  function paint(sample: CatSample) {
    const set = CAT_SPRITES[sample.size];
    for (const [el, d] of [[aEl, sample.cats[0]], [bEl, sample.cats[1]]] as const) {
      const frame = catFrame(sample.size, d.who, d.pose, d.frame);
      const key = `${sample.size}|${d.who}|${d.pose}|${d.frame % (set.cats[d.who][d.pose]?.length ?? 1)}`;
      const left = d.dir === 1 ? d.x + frame.x : d.x + set.W - frame.x - frame.w;
      blit(el, key, bitmap(key, frame, CAT_PALETTES[d.who]), left, frame.y - set.H + d.y, d.dir === -1);
    }
    bEl.classList.toggle("todo-cat-front", sample.cats[1].pose === "perch");
    if (sample.prop) {
      const { name, frame: index, x } = sample.prop;
      const frame = propFrame(sample.size, name, index), box = propBox(sample.size, name);
      const key = `${sample.size}|prop|${name}|${index}`;
      blit(propEl, key, bitmap(key, frame, CAT_PROP_PALETTES[name]), x + Math.floor((box.w - frame.w) / 2), -frame.h, false);
    } else propEl.hidden = true;
    if (sample.chair) {
      const frame = chairFrame(sample.size), key = `${sample.size}|chair`;
      blit(chairEl, key, bitmap(key, frame, CAT_PALETTES.chair), sample.chair.x + frame.x, frame.y - set.H, false);
    } else chairEl.hidden = true;
  }

  function targetPoint(): CatTarget | null {
    const el = state.askTarget;
    if (!state.asks.length || !el || !el.isConnected) return null;
    const now = view.performance.now();
    if (targetCache && now - targetCache.at < TARGET_READ_MS) return targetCache.point;
    const r = el.getBoundingClientRect(), h = host.getBoundingClientRect();
    const sameRow = r.bottom > h.top && r.top < h.bottom;
    const point = (!r.width && !r.height) || size === null || !sameRow ? null : { x: r.left + r.width / 2 - h.left - catStageOffset(size), y: r.top - h.bottom };
    targetCache = { at: now, point };
    return point;
  }

  const engineState = (): CatEngineState => ({ asking: state.asks.length > 0, busy: state.busy, allDone: state.allDone });
  function deliver(t: number) {
    if (!engine) return;
    const point = targetPoint();
    if (point) engine.setTarget(point, t);
    const fresh = askPending && !state.allDone;
    if (fresh) askPending = false;
    engine.setState(engineState(), t, fresh);
    engine.setTarget(point, t);
  }

  function stop() { view.cancelAnimationFrame(raf); view.clearTimeout(timer); raf = timer = 0; }
  function render() {
    if (size === null) return;
    if (!engine) { paint(stillScene(size, width - catStageOffset(size), state.allDone)); return; }
    const t = clock();
    engine.setTarget(targetPoint(), t);
    paint(engine.sample(t));
  }
  function tick() {
    stop();
    render();
    if (!engine || pauses.size) return;
    const t = clock();
    const wait = engine.nextChange(t) - t;
    if (wait <= CONTINUOUS_MS * 2) raf = view.requestAnimationFrame(tick);
    else timer = view.setTimeout(tick, wait);
  }
  function setPause(reason: string, on: boolean) {
    if (on === pauses.has(reason)) return;
    if (on) { if (!pauses.size) acc += view.performance.now() - t0; pauses.add(reason); stop(); }
    else { pauses.delete(reason); if (!pauses.size) { t0 = view.performance.now(); tick(); } }
    layer.toggleAttribute("data-paused", pauses.size > 0);
  }
  function holdPause(reason: string, on: boolean) {
    view.clearTimeout(releaseTimers.get(reason));
    releaseTimers.delete(reason);
    if (on) releaseTimers.set(reason, view.setTimeout(() => holdPause(reason, false), DRAG_PAUSE_MAX_MS));
    setPause(reason, on);
  }

  function layout() {
    width = host.clientWidth;
    const nextSize = catSizeForWidth(width);
    layer.hidden = nextSize === null;
    signEl.hidden = nextSize === null;
    if (nextSize === null) { stop(); engine = null; size = null; return; }
    size = nextSize;
    const offset = catStageOffset(nextSize);
    layer.style.left = `${offset}px`;
    const sign = catSignFrame(nextSize), signKey = `${nextSize}|sign`;
    if (painted.get(signEl) !== signKey) {
      painted.set(signEl, signKey);
      signEl.width = sign.w; signEl.height = sign.h;
      signEl.getContext("2d")?.drawImage(bitmap(signKey, sign, CAT_SIGN_PALETTE), 0, 0);
    }
    if (reduced.matches) { stop(); engine = null; render(); return; }
    const t = clock();
    if (!engine) { engine = createCatEngine({ size: nextSize, width: width - offset, random, now: t }); deliver(t); }
    else engine.setLayout(width - offset, nextSize, t);
    tick();
  }

  const focusCheck = () => setPause("input", isTextEntry(doc.activeElement));
  const focusOut = () => { view.clearTimeout(focusTimer); focusTimer = view.setTimeout(focusCheck, 0); };
  const dragStart = () => holdPause("drag", true);
  const dragEnd = () => holdPause("drag", false);
  const pointerDown = (event: Event) => {
    const el = event.target as Element | null;
    if (el && typeof el.closest === "function" && el.closest(DRAG_HANDLE_SELECTOR)) holdPause("pointer", true);
  };
  const pointerUp = () => holdPause("pointer", false);
  const windowBlur = () => { holdPause("pointer", false); holdPause("drag", false); };
  const visibility = () => setPause("hidden", doc.visibilityState === "hidden");
  const motionChange = () => { engine = null; layout(); };
  const listeners: [EventTarget, string, EventListener, boolean][] = [
    [doc, "focusin", focusCheck, false],
    [doc, "focusout", focusOut, false],
    [view, "dragstart", dragStart, true],
    [view, "dragend", dragEnd, true],
    [view, "drop", dragEnd, true],
    [view, "pointerdown", pointerDown, true],
    [view, "pointerup", pointerUp, true],
    [view, "pointercancel", pointerUp, true],
    [view, "blur", windowBlur, false],
    [doc, "visibilitychange", visibility, false],
  ];
  for (const [target, type, listener, capture] of listeners) target.addEventListener(type, listener, capture);
  reduced.addEventListener("change", motionChange);
  const resize = new ResizeObserver(() => { if (host.clientWidth !== width) layout(); });
  resize.observe(host);
  focusCheck();
  visibility();
  layout();

  return {
    setState(next) {
      const first = seenAsks === null;
      const seen = seenAsks ?? new Set<string>();
      seenAsks = seen;
      if (!first && next.asks.some(id => !seen.has(id))) askPending = true;
      for (const id of next.asks) seen.add(id);
      if (!next.asks.length) askPending = false;
      state = next;
      targetCache = null;
      deliver(clock());
      tick();
    },
    destroy() {
      stop();
      view.clearTimeout(focusTimer);
      for (const id of releaseTimers.values()) view.clearTimeout(id);
      releaseTimers.clear();
      resize.disconnect();
      for (const [target, type, listener, capture] of listeners) target.removeEventListener(type, listener, capture);
      reduced.removeEventListener("change", motionChange);
      layer.remove();
      signEl.remove();
      host.classList.remove("todo-cats-host");
      engine = null;
    },
  };
}
