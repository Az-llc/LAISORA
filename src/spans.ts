export type Span = [number, number];

export function unionSpans(spans: readonly Span[]): Span[] {
  const sorted = spans.filter((s) => s[1] > s[0]).sort((a, b) => a[0] - b[0]);
  const out: Span[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && s[0] <= last[1]) {
      if (s[1] > last[1]) last[1] = s[1];
    } else {
      out.push([s[0], s[1]]);
    }
  }
  return out;
}

export function intersectSpans(a: readonly Span[], b: readonly Span[]): Span[] {
  const out: Span[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    const start = Math.max(a[i][0], b[j][0]);
    const end = Math.min(a[i][1], b[j][1]);
    if (end > start) out.push([start, end]);
    if (a[i][1] < b[j][1]) i++;
    else j++;
  }
  return out;
}

export function subtractSpans(a: readonly Span[], b: readonly Span[]): Span[] {
  const out: Span[] = [];
  const bs = unionSpans(b);
  for (const [s0, s1] of unionSpans(a)) {
    let cursor = s0;
    for (const [b0, b1] of bs) {
      if (b1 <= cursor) continue;
      if (b0 >= s1) break;
      if (b0 > cursor) out.push([cursor, Math.min(b0, s1)]);
      cursor = Math.max(cursor, b1);
      if (cursor >= s1) break;
    }
    if (cursor < s1) out.push([cursor, s1]);
  }
  return out;
}

export function unfinishedCallEnd(startedAt: number, stoppedAt: number | undefined, lastActivity: number): number {
  return Math.max(startedAt, stoppedAt ?? lastActivity);
}

export function measureSpans(spans: readonly Span[]): number {
  let total = 0;
  for (const [s0, s1] of spans) total += Math.max(0, s1 - s0);
  return total;
}

export function insertSpan(sorted: readonly Span[], span: Span): Span[] {
  const [s0, s1] = span;
  if (!(s1 > s0)) return sorted.slice();
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid][1] < s0) lo = mid + 1;
    else hi = mid;
  }
  let next = lo;
  let start = s0;
  let end = s1;
  while (next < sorted.length && sorted[next][0] <= end) {
    start = Math.min(start, sorted[next][0]);
    end = Math.max(end, sorted[next][1]);
    next++;
  }
  return [...sorted.slice(0, lo), [start, end], ...sorted.slice(next)];
}

export function unionMs(spans: readonly Span[]): number {
  return measureSpans(unionSpans(spans));
}

export interface RunTimes {
  earlierRuns?: readonly Span[];
  runStart: number;
  runEnd: number;
}

export function currentRunStart(resumedAt: number | undefined, launchedAt: number | undefined): number | undefined {
  if (resumedAt !== undefined && resumedAt > 0) return resumedAt;
  return launchedAt !== undefined && launchedAt > 0 ? launchedAt : undefined;
}

export function stoppedRunEnd(runStart: number, stoppedAt: number, lastChildAt: number | undefined): number {
  return Math.max(runStart, stoppedAt, lastChildAt ?? stoppedAt);
}

export function closeRun(earlierRuns: readonly Span[] | undefined, runStart: number, stoppedAt: number, lastChildAt: number | undefined,
  resumedAt: number): Span[] {
  return [...earlierRuns ?? [], [runStart, Math.max(runStart, Math.min(resumedAt, stoppedRunEnd(runStart, stoppedAt, lastChildAt)))]];
}

export type CallLane = "main" | "sub";

export function callLane(parentToolUseId: string | null | undefined): CallLane {
  return parentToolUseId === null || parentToolUseId === undefined ? "main" : "sub";
}

export interface RecordedRuns {
  earlierRuns?: Span[];
  resumedAt?: number;
}

export interface ChildTranscriptSpan {
  toolUseId: string;
  startedAt?: number;
  endedAt?: number;
  readAt: number;
  runs?: RecordedRuns;
}

type RecordedEnds = { startedAt?: number; endedAt?: number };
export function launchlessRunSpan(child: ChildTranscriptSpan | undefined, recorded: RecordedEnds, fallbackStart: number): { start: number; end: number };
export function launchlessRunSpan(child: ChildTranscriptSpan | undefined, recorded: RecordedEnds): { start: number; end: number } | undefined;
export function launchlessRunSpan(child: ChildTranscriptSpan | undefined, recorded: RecordedEnds, fallbackStart?: number): { start: number; end: number } | undefined {
  const start = child?.startedAt ?? recorded.startedAt ?? fallbackStart;
  return start === undefined ? undefined : { start, end: Math.max(start, child?.endedAt ?? recorded.endedAt ?? start) };
}

export function moreRuns<T extends RecordedRuns>(base: T, other: T): T {
  return (other.earlierRuns?.length ?? 0) > (base.earlierRuns?.length ?? 0) ? other : base;
}

export interface DelegationRuns {
  start: number;
  earlierRuns?: Span[];
  resumedAt?: number;
  runStart: number;
}

export function delegationRuns(launchedAt: number, earlierRuns: readonly Span[] | undefined, resumedAt: number | undefined,
  child: ChildTranscriptSpan | undefined): DelegationRuns {
  const start = child?.startedAt ?? launchedAt;
  const fromStart = (at: number) => Math.max(start, at);
  const resumed = resumedAt === undefined ? undefined : fromStart(resumedAt);
  return { start,
    ...(earlierRuns === undefined ? {} : { earlierRuns: earlierRuns.map(([runStart, runEnd]): Span => [fromStart(runStart), Math.max(fromStart(runStart), runEnd)]) }),
    ...(resumed === undefined ? {} : { resumedAt: resumed }),
    runStart: currentRunStart(resumed, start) ?? start };
}

export type RunStop = { kind: "ended"; at: number } | { kind: "interrupted"; at: number } | { kind: "woke" } | { kind: "lost" };

// A child record read (readAt) before a stop or child activity shows only part of the run, so its end is not the run's.
export function childRecordEnd(runs: DelegationRuns, child: ChildTranscriptSpan | undefined, stop: RunStop, lastChildAt: number | undefined): number | undefined {
  const bound = Math.max("at" in stop ? stop.at : -Infinity, lastChildAt ?? -Infinity);
  if (child?.endedAt === undefined || child.endedAt < runs.runStart || (child.readAt !== undefined && bound > child.readAt)) return undefined;
  return Math.max(child.endedAt, lastChildAt ?? child.endedAt);
}

export function runEnd(runs: DelegationRuns, child: ChildTranscriptSpan | undefined, stop: RunStop, lastChildAt: number | undefined): number {
  const fromChild = childRecordEnd(runs, child, stop, lastChildAt);
  if (fromChild !== undefined) return fromChild;
  if (stop.kind === "woke" || stop.kind === "lost") return Math.max(runs.runStart, lastChildAt ?? runs.runStart);
  if (stop.kind === "interrupted") return Math.max(runs.runStart, lastChildAt ?? stop.at);
  return stoppedRunEnd(runs.runStart, stop.at, lastChildAt);
}

export function childActivity(run: { runStart: number; earlierRuns?: readonly Span[]; stoppedAt?: number; lastChildAt?: number }, at: number):
  { lastChildAt: number; wokeAt?: number; earlierRuns?: Span[] } {
  if (run.stoppedAt !== undefined && at > run.stoppedAt) {
    return { lastChildAt: at, wokeAt: at, earlierRuns: closeRun(run.earlierRuns, run.runStart, run.stoppedAt, run.lastChildAt, at) };
  }
  return { lastChildAt: Math.max(run.lastChildAt ?? at, at) };
}

export function memberRunTimes(member: { start: number; end: number; earlierRuns?: readonly Span[]; resumedAt?: number }, end = member.end): RunTimes {
  return { earlierRuns: member.earlierRuns, runStart: currentRunStart(member.resumedAt, member.start) ?? member.start, runEnd: end };
}

export function runSpans(runs: RunTimes): Span[] {
  return [...runs.earlierRuns ?? [], [runs.runStart, Math.max(runs.runStart, runs.runEnd)]];
}

export function runElapsedMs(runs: RunTimes): number {
  return unionMs(runSpans(runs));
}

export function childUsageCounts(stoppedAt: number | undefined, woke: boolean, at: number): boolean {
  return woke || (stoppedAt !== undefined && at > stoppedAt);
}

export function isChildCall(parentToolUseId: string | null | undefined): parentToolUseId is string {
  return callLane(parentToolUseId) === "sub";
}
