import type { SemanticEvidenceIndex } from "./evidence-index";
import type {
  Coverage,
  EvidenceRef,
  ExecutionAttemptNode,
  SemanticCoverage,
  SemanticEdge,
  SemanticModel,
  TaskDefinitionNode,
} from "./semantic-model";

export const L3_ANALYSIS_SPEC_VERSION = 1;

export interface L3Basis {
  nodeIds: string[];
  edgeIds: string[];
  evidence: EvidenceRef[];
}

export type L3UnavailableReason =
  | "no_attempt_input"
  | "no_execution_window_input"
  // 両側 unknownEffects=false の対が存在しないと resource 系の辺は構造的に生じない。
  // 「辺が 0 本」を「競合なし」と書かないための分岐
  | "no_footprint_input"
  | "edge_limit_exceeded"
  // 窓を持つ Task はあるが逐次（非重複）の対が1件も無い
  | "no_serial_pair"
  // 観測制約辺（observed_data_dep ∪ resource_conflict の非重複対）が 0 本
  | "no_constraint_edges";

export interface L3MetricBase {
  metricId: string;
  basis: L3Basis;
  coverage: SemanticCoverage;
  counts?: Record<string, number>;
}

export interface L3ObservedMetric extends L3MetricBase {
  state: "observed";
  value: number;
}

export interface L3UnavailableMetric extends L3MetricBase {
  state: "unavailable";
  reason: L3UnavailableReason;
}

export type L3Metric = L3ObservedMetric | L3UnavailableMetric;

export interface L3TaskMetricSet {
  taskId: string;
  taskDurationMs: L3Metric;
  attemptCount: L3Metric;
}

export type SerializationClassification = "required" | "independent-serial" | "undetermined";

export interface SerializationPair {
  taskAId: string;
  taskBId: string;
  classification: SerializationClassification;
  basis: L3Basis;
}

export interface SerializationAttemptPair {
  // ソート済み nodeId を "|" で連結した決定論的 id。配列添字を期待値の係留先にしないため
  pairId: string;
  attemptAId: string;
  attemptBId: string;
  classification: SerializationClassification;
  basis: L3Basis;
}

export interface L3SerializationProfile {
  pairs: SerializationPair[];
  counts: Record<SerializationClassification, number>;
  // Attempt 対の serialization。Task 対とは別に数え、Task 対の値へ加算する
  attemptPairs: SerializationAttemptPair[];
  attemptPairCounts: Record<SerializationClassification, number>;
  basis: L3Basis;
  coverage: SemanticCoverage;
  // 「母集合が構造的に空」と「3分類すべて 0」を出力上区別する（unavailable を 0 と描かない）
  state: "observed" | "unavailable";
  reason?: L3UnavailableReason;
}

export interface EstimateValue {
  metricId: string;
  valueMs: number;
  estimateType: "upper_bound" | "model_estimate";
  assumptions: string[];
  basis: L3Basis;
  coverage: Coverage;
}

// 単一値。state="estimated" のとき EstimateValue の各フィールドを平坦に持つ
export interface L3ParallelizationEstimate {
  valueMs?: number;
  estimateType?: EstimateValue["estimateType"];
  assumptions?: string[];
  basis?: L3Basis;
  coverage?: Coverage;
  undeterminedPairCount: number;
  undeterminedTaskCount: number;
  excludedPairCounts: Record<string, number>;
  state: "estimated" | "unavailable";
  reason?: "no_candidate_group" | L3UnavailableReason;
}

export interface L3Report {
  specVersion: number;
  semanticHash: string;
  taskMetrics: L3TaskMetricSet[];
  metrics: {
    longGapMs: L3Metric;
    longGapCount: L3Metric;
    failureCount: L3Metric;
    actualConcurrency: L3Metric;
    fileWriteConflictCount: L3Metric;
    resourceDependencyCount: L3Metric;
    unknownEffectRatio: L3Metric;
    observedConstraintChainMs: L3Metric;
  };
  serializationProfile: L3SerializationProfile;
  estimates: {
    parallelizationUpperBound: L3ParallelizationEstimate;
  };
}

const MAX_EVIDENCE_PER_METRIC = 8;

function capEvidence(refs: EvidenceRef[]): EvidenceRef[] {
  return refs.slice(0, MAX_EVIDENCE_PER_METRIC);
}

function timingPatch(attempts: ExecutionAttemptNode[]): Partial<SemanticCoverage> | undefined {
  return attempts.some((a) => a.endedAt === undefined) ? { timing: "partial" } : undefined;
}

function baseAxis(model: SemanticModel): Coverage {
  return model.coverage.base.summary === "prefix-truncated" ||
    model.coverage.base.details === "prefix-truncated"
    ? "partial"
    : "complete";
}

const COVERAGE_RANK: Record<Coverage, number> = { complete: 2, partial: 1, unavailable: 0 };

function weakerCoverage(a: Coverage, b: Coverage): Coverage {
  return COVERAGE_RANK[a] <= COVERAGE_RANK[b] ? a : b;
}

// 指標固有の軸は**降格のみ**適用する。上書きにすると model 側が partial（prefix-truncated 等）
// でも指標が complete を主張しうる
function coverageWith(
  model: SemanticModel,
  patch?: Partial<Pick<SemanticCoverage, "timing" | "dependency" | "artifact" | "identity" | "detail">>
): SemanticCoverage {
  const out: SemanticCoverage = { ...model.coverage };
  if (patch === undefined) return out;
  for (const axis of ["timing", "dependency", "artifact", "identity", "detail"] as const) {
    const v = patch[axis];
    if (v !== undefined) out[axis] = weakerCoverage(out[axis], v);
  }
  return out;
}

function observed(
  metricId: string,
  value: number,
  basis: L3Basis,
  coverage: SemanticCoverage,
  counts?: Record<string, number>
): L3ObservedMetric {
  return counts !== undefined
    ? { metricId, state: "observed", value, basis, coverage, counts }
    : { metricId, state: "observed", value, basis, coverage };
}

function unavailable(
  metricId: string,
  reason: L3UnavailableReason,
  coverage: SemanticCoverage,
  counts?: Record<string, number>,
  basis?: L3Basis
): L3UnavailableMetric {
  const b = basis ?? { nodeIds: [], edgeIds: [], evidence: [] };
  return counts !== undefined
    ? { metricId, state: "unavailable", reason, basis: b, coverage, counts }
    : { metricId, state: "unavailable", reason, basis: b, coverage };
}

function taskNodesOf(model: SemanticModel): TaskDefinitionNode[] {
  return model.nodes.filter((n): n is TaskDefinitionNode => n.kind === "task");
}

function attemptNodesOf(model: SemanticModel): ExecutionAttemptNode[] {
  return model.nodes.filter((n): n is ExecutionAttemptNode => n.kind === "attempt");
}

function taskOfAttempt(a: ExecutionAttemptNode): string | undefined {
  return a.parentId !== undefined && a.parentId.startsWith("task:") ? a.parentId : undefined;
}

interface PairRelations {
  overlaps: SemanticEdge[];
  observedDataDep: SemanticEdge[];
  resourceConflict: SemanticEdge[];
}

function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

// Task 対単位の relation 索引。dd/rc は Attempt 端点を parentId で
// Task へ射影する（contains/executes は非保存 — P1-B）
function buildPairRelations(model: SemanticModel): Map<string, PairRelations> {
  const attemptTask = new Map<string, string>();
  for (const a of attemptNodesOf(model)) {
    const t = taskOfAttempt(a);
    if (t !== undefined) attemptTask.set(a.nodeId, t);
  }
  const taskIds = new Set(taskNodesOf(model).map((t) => t.nodeId));
  const toTaskId = (nodeId: string): string | undefined =>
    taskIds.has(nodeId) ? nodeId : attemptTask.get(nodeId);

  const map = new Map<string, PairRelations>();
  const entry = (a: string, b: string): PairRelations => {
    const key = pairKey(a, b);
    let e = map.get(key);
    if (!e) {
      e = {
        overlaps: [],
        observedDataDep: [],
        resourceConflict: [],
      };
      map.set(key, e);
    }
    return e;
  };

  for (const edge of model.edges) {
    const from = toTaskId(edge.from);
    const to = toTaskId(edge.to);
    if (from === undefined || to === undefined || from === to) continue;
    const e = entry(from, to);
    switch (edge.kind) {
      case "overlaps":
        e.overlaps.push(edge);
        break;
      case "observed_data_dep":
        e.observedDataDep.push(edge);
        break;
      case "resource_conflict":
        e.resourceConflict.push(edge);
        break;
      default:
        break;
    }
  }
  return map;
}

function windowsOverlap(a: TaskDefinitionNode, b: TaskDefinitionNode): boolean {
  const aStart = a.executionWindow!.startedAt;
  const aEnd = a.executionWindow!.endedAt ?? Infinity;
  const bStart = b.executionWindow!.startedAt;
  const bEnd = b.executionWindow!.endedAt ?? Infinity;
  return Math.max(aStart, bStart) < Math.min(aEnd, bEnd);
}

function taskUnknownEffects(t: TaskDefinitionNode): boolean | undefined {
  const fp = t.executionSummary?.footprint;
  if (fp === undefined) return undefined;
  return fp.unknownEffects;
}

// Attempt 対の serialization 観測。
// Task 対（deriveSerializationProfile）へ加算する第2の単位で、Task 対の値は変更しない。
// 分類入力は当該 Attempt 自身の footprint / unknownEffects / 実行窓に限る。
// 兄弟 Attempt や親の非委任 segment を OR した Task 集約値を使わない。
function deriveSerializationAttemptPairs(model: SemanticModel): {
  pairs: SerializationAttemptPair[];
  counts: Record<SerializationClassification, number>;
} {
  const taskOf = (a: ExecutionAttemptNode): string | undefined =>
    typeof a.parentId === "string" && a.parentId.startsWith("task:") ? a.parentId : undefined;

  // 母集団: endedAt 確定かつ Task 帰属。scanAttemptPairs（l3-divergence.ts）と同一
  const attempts = attemptNodesOf(model)
    .filter((a) => a.endedAt !== undefined && taskOf(a) !== undefined)
    .sort((x, y) => x.startedAt - y.startedAt || (x.nodeId < y.nodeId ? -1 : 1));

  const dep = new Set<string>();
  for (const e of model.edges) {
    if (e.kind === "observed_data_dep" || e.kind === "resource_conflict") {
      dep.add(pairKey(e.from, e.to));
    }
  }

  const pairs: SerializationAttemptPair[] = [];
  const counts: Record<SerializationClassification, number> = {
    required: 0,
    "independent-serial": 0,
    undetermined: 0,
  };

  for (let i = 0; i < attempts.length; i++) {
    for (let j = i + 1; j < attempts.length; j++) {
      const a = attempts[i];
      const b = attempts[j];
      // 同一 TaskDefinition 内は precedence があるため対象外
      if (taskOf(a) === taskOf(b)) continue;
      const aEnd = a.endedAt!;
      const bEnd = b.endedAt!;
      if (Math.max(a.startedAt, b.startedAt) < Math.min(aEnd, bEnd)) continue;

      let classification: SerializationClassification;
      if (dep.has(pairKey(a.nodeId, b.nodeId))) classification = "required";
      else if (a.footprint.unknownEffects === false && b.footprint.unknownEffects === false)
        classification = "independent-serial";
      else classification = "undetermined";

      counts[classification]++;
      const [x, y] = a.nodeId < b.nodeId ? [a.nodeId, b.nodeId] : [b.nodeId, a.nodeId];
      pairs.push({
        pairId: `${x}|${y}`,
        attemptAId: x,
        attemptBId: y,
        classification,
        basis: { nodeIds: [x, y], edgeIds: [], evidence: [] },
      });
    }
  }
  pairs.sort((p, q) => (p.pairId < q.pairId ? -1 : p.pairId > q.pairId ? 1 : 0));
  return { pairs, counts };
}

// serializationProfile（観測辺のみを判定入力にする）
function deriveSerializationProfile(
  model: SemanticModel,
  relations: Map<string, PairRelations>
): L3SerializationProfile {
  const tasks = taskNodesOf(model).filter((t) => t.executionWindow !== undefined);
  const pairs: SerializationPair[] = [];
  const counts: Record<SerializationClassification, number> = {
    required: 0,
    "independent-serial": 0,
    undetermined: 0,
  };

  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const a = tasks[i];
      const b = tasks[j];
      if (windowsOverlap(a, b)) continue;
      const rel = relations.get(pairKey(a.nodeId, b.nodeId));
      const ddEdges = rel?.observedDataDep ?? [];
      const rcEdges = rel?.resourceConflict ?? [];
      const unknownA = taskUnknownEffects(a);
      const unknownB = taskUnknownEffects(b);

      let classification: SerializationClassification;
      let edgeIds: string[] = [];
      if (ddEdges.length > 0 || rcEdges.length > 0) {
        classification = "required";
        edgeIds = [...ddEdges, ...rcEdges].map((e) => e.edgeId);
      } else if (unknownA === false && unknownB === false) {
        classification = "independent-serial";
      } else {
        classification = "undetermined";
      }
      counts[classification]++;
      const [taskAId, taskBId] =
        a.nodeId < b.nodeId ? [a.nodeId, b.nodeId] : [b.nodeId, a.nodeId];
      pairs.push({
        taskAId,
        taskBId,
        classification,
        basis: { nodeIds: [taskAId, taskBId], edgeIds, evidence: [] },
      });
    }
  }

  const basis: L3Basis = { nodeIds: tasks.map((t) => t.nodeId), edgeIds: [], evidence: [] };
  const coverage = coverageWith(model);

  // 裁定H3: 母集合が空（窓を持つ Task が2件未満 / 逐次対が1件も無い）と
  // 「3分類すべて 0」を区別する。裁定L5: 辺上限到達時は分類入力が欠けている
  let reason: L3UnavailableReason | undefined;
  if (model.coverage.detail === "partial") {
    reason = "edge_limit_exceeded";
  } else if (tasks.length < 2) {
    reason = "no_execution_window_input";
  } else if (pairs.length === 0) {
    reason = "no_serial_pair";
  }

  const attemptScan = deriveSerializationAttemptPairs(model);

  return {
    pairs,
    counts,
    attemptPairs: attemptScan.pairs,
    attemptPairCounts: attemptScan.counts,
    basis,
    coverage,
    state: reason === undefined ? "observed" : "unavailable",
    reason,
  };
}

const PARALLELIZATION_ASSUMPTIONS = [
  "simultaneous_start_possible",
  "no_worker_count_limit",
  "no_hidden_dependency_outside_observed_scope",
  "reviewer_availability",
  "no_resource_contention",
];

// 除外規則: 同一 Task 内 Attempt（単位が TaskDefinition 間である時点で対象外）/
// observed_data_dep / resource_conflict / unknownEffects / overlaps。結果は単一値
function deriveParallelizationEstimate(
  model: SemanticModel,
  relations: Map<string, PairRelations>
): L3ParallelizationEstimate {
  const tasks = taskNodesOf(model).filter((t) => t.executionWindow !== undefined);
  // 裁定L6: 欠けているのは Task ではなく executionWindow（timing 入力）。
  // 裁定L5: 辺上限到達時は除外規則の入力が欠けており候補群を確定できない
  const gateReason: L3UnavailableReason | undefined =
    model.coverage.detail === "partial"
      ? "edge_limit_exceeded"
      : tasks.length < 2
      ? "no_execution_window_input"
      : undefined;
  if (gateReason !== undefined) {
    return {
      undeterminedPairCount: 0,
      undeterminedTaskCount: 0,
      excludedPairCounts: {},
      state: "unavailable",
      reason: gateReason,
    };
  }

  const byStage = new Map<string, TaskDefinitionNode[]>();
  for (const t of tasks) {
    const stage = t.parentId ?? "";
    const list = byStage.get(stage) ?? [];
    list.push(t);
    byStage.set(stage, list);
  }

  let undeterminedPairCount = 0;
  const undeterminedTaskIds = new Set<string>();
  const excludedPairCounts: Record<string, number> = {};
  const bumpExcluded = (kind: string) => {
    excludedPairCounts[kind] = (excludedPairCounts[kind] ?? 0) + 1;
  };

  const candidateGroups: TaskDefinitionNode[][] = [];

  for (const stageTasks of byStage.values()) {
    if (stageTasks.length < 2) continue;

    // unknownEffects=true（不明含む）の Task は候補ですらなく undetermined（保守的既定）
    const pool = stageTasks.filter((t) => taskUnknownEffects(t) === false);
    for (const t of stageTasks) {
      if (taskUnknownEffects(t) !== false) undeterminedTaskIds.add(t.nodeId);
    }
    for (let i = 0; i < stageTasks.length; i++) {
      for (let j = i + 1; j < stageTasks.length; j++) {
        const a = stageTasks[i];
        const b = stageTasks[j];
        if (windowsOverlap(a, b)) continue;
        if (taskUnknownEffects(a) !== false || taskUnknownEffects(b) !== false) {
          undeterminedPairCount++;
        }
      }
    }

    const confirmedExcluded = new Set<string>();
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        const a = pool[i];
        const b = pool[j];
        const rel = relations.get(pairKey(a.nodeId, b.nodeId));
        const confirmedKinds: string[] = [];
        if (windowsOverlap(a, b) || (rel?.overlaps.length ?? 0) > 0) confirmedKinds.push("overlaps");
        if ((rel?.observedDataDep.length ?? 0) > 0) confirmedKinds.push("observed_data_dep");
        if ((rel?.resourceConflict.length ?? 0) > 0) confirmedKinds.push("resource_conflict");

        if (confirmedKinds.length > 0) {
          for (const k of confirmedKinds) bumpExcluded(k);
          confirmedExcluded.add(a.nodeId);
          confirmedExcluded.add(b.nodeId);
        }
      }
    }

    const candidateG = pool.filter((t) => !confirmedExcluded.has(t.nodeId));
    if (candidateG.length >= 2) candidateGroups.push(candidateG);
  }

  const estimateOf = (groups: TaskDefinitionNode[][]): EstimateValue | undefined => {
    if (groups.length === 0) return undefined;
    let valueMs = 0;
    const nodeIds: string[] = [];
    for (const g of groups) {
      const durations = g.map((t) => t.executionWindow!.durationUnionMs);
      valueMs += durations.reduce((s, d) => s + d, 0) - Math.max(...durations);
      nodeIds.push(...g.map((t) => t.nodeId));
    }
    const windowsComplete = groups.every((g) =>
      g.every((t) => t.executionWindow!.coverage === "complete")
    );
    const coverage: Coverage =
      undeterminedPairCount > 0 || !windowsComplete || baseAxis(model) === "partial"
        ? "partial"
        : "complete";
    return {
      metricId: "parallelizationUpperBoundMs",
      valueMs,
      estimateType: "upper_bound",
      assumptions: [...PARALLELIZATION_ASSUMPTIONS],
      basis: { nodeIds, edgeIds: [], evidence: [] },
      coverage,
    };
  };

  const estimate = estimateOf(candidateGroups);
  const state: L3ParallelizationEstimate["state"] = estimate !== undefined ? "estimated" : "unavailable";
  return {
    ...(estimate !== undefined
      ? {
          valueMs: estimate.valueMs,
          estimateType: estimate.estimateType,
          assumptions: estimate.assumptions,
          basis: estimate.basis,
          coverage: estimate.coverage,
        }
      : {}),
    undeterminedPairCount,
    undeterminedTaskCount: undeterminedTaskIds.size,
    excludedPairCounts,
    state,
    reason: state === "unavailable" ? "no_candidate_group" : undefined,
  };
}

// endedAt 確定の Attempt をノード（重み = durationMs）、observed_data_dep ∪
// resource_conflict のうち overlaps しない対を辺（向きは全順序 (endedAt, startedAt, nodeId) の前→後）
// とする DAG の最長路。観測辺は依存の完全集合ではない（「クリティカルパス」と呼ばない）
function attemptOrder(a: ExecutionAttemptNode, b: ExecutionAttemptNode): number {
  if (a.endedAt! !== b.endedAt!) return a.endedAt! - b.endedAt!;
  if (a.startedAt !== b.startedAt) return a.startedAt - b.startedAt;
  return a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0;
}

function deriveObservedConstraintChain(model: SemanticModel): L3Metric {
  const metricId = "observedConstraintChainMs";
  const allAttempts = attemptNodesOf(model);
  const cov = coverageWith(model);
  if (allAttempts.length === 0) {
    return unavailable(metricId, "no_attempt_input", cov);
  }
  const attempts = allAttempts.filter((a) => a.endedAt !== undefined).sort(attemptOrder);
  const byId = new Map(attempts.map((a) => [a.nodeId, a]));

  const edges: { edgeId: string; from: string; to: string }[] = [];
  for (const e of model.edges) {
    if (e.kind !== "observed_data_dep" && e.kind !== "resource_conflict") continue;
    const u = byId.get(e.from);
    const v = byId.get(e.to);
    if (u === undefined || v === undefined || u === v) continue;
    // overlaps（deriveEdges と同じ strict <）する対は辺にしない
    if (Math.max(u.startedAt, v.startedAt) < Math.min(u.endedAt!, v.endedAt!)) continue;
    const [from, to] = attemptOrder(u, v) < 0 ? [u, v] : [v, u];
    edges.push({ edgeId: e.edgeId, from: from.nodeId, to: to.nodeId });
  }
  // unknownEffects=true の Attempt は辺を張れず、鎖から漏れうる
  const unknownEffectCount = allAttempts.filter((a) => a.footprint.unknownEffects).length;
  const chainCov = coverageWith(model, unknownEffectCount > 0 ? { artifact: "partial" } : undefined);
  if (edges.length === 0) {
    return unavailable(metricId, "no_constraint_edges", chainCov, {
      nodeCount: attempts.length,
      unknownEffectAttemptCount: unknownEffectCount,
    });
  }

  const adj = new Map<string, { to: string; edgeId: string }[]>();
  for (const a of attempts) adj.set(a.nodeId, []);
  for (const e of edges) adj.get(e.from)!.push(e);

  const weightOf = (a: ExecutionAttemptNode): number => a.elapsedMs > 0 ? a.elapsedMs : Math.max(0, a.endedAt! - a.startedAt);
  // ノードは全順序で並んでおり辺は前→後にしか向かないので、順に緩和すれば最長路が確定する
  const best = new Map<string, { cost: number; nodeIds: string[]; edgeIds: string[] }>();
  for (const a of attempts) best.set(a.nodeId, { cost: weightOf(a), nodeIds: [a.nodeId], edgeIds: [] });
  for (const u of attempts) {
    const cur = best.get(u.nodeId)!;
    for (const { to, edgeId } of adj.get(u.nodeId)!) {
      const cost = cur.cost + weightOf(byId.get(to)!);
      const prev = best.get(to)!;
      if (cost > prev.cost) {
        best.set(to, { cost, nodeIds: [...cur.nodeIds, to], edgeIds: [...cur.edgeIds, edgeId] });
      }
    }
  }
  // 鎖は辺 1 本以上の路に限る。辺を持たない単独 Attempt を制約鎖として数えると、長い単独作業が鎖を偽装する
  let longest = { cost: 0, nodeIds: [] as string[], edgeIds: [] as string[] };
  for (const a of attempts) {
    const b = best.get(a.nodeId)!;
    if (b.edgeIds.length > 0 && b.cost > longest.cost) longest = b;
  }
  return observed(
    metricId,
    longest.cost,
    { nodeIds: longest.nodeIds, edgeIds: longest.edgeIds, evidence: [] },
    chainCov,
    {
      chainLength: longest.nodeIds.length,
      constraintEdgeCount: edges.length,
      unknownEffectAttemptCount: unknownEffectCount,
    }
  );
}

function deriveActualConcurrency(model: SemanticModel): L3Metric {
  const metricId = "actualConcurrency";
  const attempts = attemptNodesOf(model);
  const cov = coverageWith(model);
  if (attempts.length === 0) {
    return unavailable(metricId, "no_attempt_input", cov);
  }
  // 区間 sweep。端点一致（前の終了=次の開始）は非重複（deriveEdges overlaps と同じ strict <）
  const points: { at: number; delta: number }[] = [];
  for (const a of attempts) {
    const end = a.endedAt ?? Infinity;
    points.push({ at: a.startedAt, delta: 1 });
    if (Number.isFinite(end)) points.push({ at: end, delta: -1 });
  }
  points.sort((p, q) => p.at - q.at || p.delta - q.delta);
  let cur = 0;
  let max = 0;
  for (const p of points) {
    cur += p.delta;
    if (cur > max) max = cur;
  }
  const overlapEdges = model.edges.filter(
    (e) =>
      e.kind === "overlaps" && e.from.startsWith("attempt:") && e.to.startsWith("attempt:")
  );
  // 裁定H2: sweep が開区間を ∞ とみなす規約は overlaps 辺生成（semantic-model.ts の
  // Math.min(aEnd, bEnd) with Infinity）と同一。ただし開区間が値へ寄与しうる以上、
  // 他の union 系と同じく timing を降格する
  return observed(
    metricId,
    max,
    {
      nodeIds: attempts.map((a) => a.nodeId),
      edgeIds: overlapEdges.map((e) => e.edgeId),
      evidence: [],
    },
    coverageWith(model, timingPatch(attempts))
  );
}

function deriveTaskMetricSets(model: SemanticModel): L3TaskMetricSet[] {
  const attempts = attemptNodesOf(model);
  const out: L3TaskMetricSet[] = [];
  for (const task of taskNodesOf(model)) {
    const taskAttempts = attempts.filter((a) => a.parentId === task.nodeId);
    const cov = coverageWith(model);

    const taskDurationMs: L3Metric =
      task.executionWindow !== undefined
        ? observed(
            "taskDurationMs",
            task.executionWindow.durationUnionMs,
            {
              nodeIds: [task.nodeId, ...taskAttempts.map((a) => a.nodeId)],
              edgeIds: [],
              evidence: capEvidence(task.evidence),
            },
            // 裁定M1: window の coverage は降格のみ（coverageWith が weaker を取る）
            coverageWith(model, { timing: task.executionWindow.coverage })
          )
        : unavailable("taskDurationMs", "no_execution_window_input", cov, undefined, {
            nodeIds: [task.nodeId],
            edgeIds: [],
            evidence: capEvidence(task.evidence),
          });

    const counted = taskAttempts.filter((a) => a.ownerState !== "undetermined");
    const attemptCount = observed(
      "attemptCount",
      counted.length,
      {
        nodeIds: counted.map((a) => a.nodeId),
        edgeIds: [],
        evidence: [],
      },
      cov,
      { undeterminedAttemptCount: taskAttempts.length - counted.length }
    );

    out.push({
      taskId: task.nodeId,
      taskDurationMs,
      attemptCount,
    });
  }
  return out;
}

// 裁定M4: model 単独では longGap 入力を運べない（SemanticModel は宣言フィールドのみで、
// Payload 往復・spread・structuredClone を跨いでも意味が変わらないことが前提）。
// deriveSemanticModel(state, evidence) と同じ2入力にし、evidence 由来の値は evidence から読む。
// model と evidence は同一 fold 由来の対で渡すこと（対応しない組でも型は通る）
export function deriveL3(model: SemanticModel, evidence: SemanticEvidenceIndex): L3Report {
  const attempts = attemptNodesOf(model);
  const cov = coverageWith(model);

  // longGap（裁定A3: 入力は evidence.longGaps。走査済みで該当ゼロ = observed 0）
  let longGapMs: L3Metric;
  let longGapCount: L3Metric;
  {
    // 裁定M6: 閾値判定は fold 側（evidence-index の IDLE_GAP_MS）が単一出所。
    // L3 で再フィルタしない（二重定義になり、閾値変更時に静かに食い違う）
    const longGaps = evidence.longGaps;
    // gap は Attempt/Task へ帰属させない（LongGapRecord は at と durationMs のみを持ち、
    // 区間を含む Attempt へ結びつけるのは帰属の推定になる — 裁定L4 の埋められない側）
    const basis: L3Basis = { nodeIds: [], edgeIds: [], evidence: [] };
    // 裁定C4: MAX_LONG_GAPS 超過で捨てられた記録も合計へ足す。捨てたのは個々の記録であって
    // 合計時間と件数は evidence 側に残っているため、総量は欠測ではない（列挙だけが欠ける
    // ので detail のみ降格する）。count だけ読んで ms を落とすと合計が過少になる
    const droppedCount = evidence.coverage.longGaps;
    const droppedMs = evidence.droppedLongGapMs;
    const gapCov = coverageWith(model, droppedCount > 0 ? { detail: "partial" } : undefined);
    const counts = { droppedLongGapCount: droppedCount, droppedLongGapMs: droppedMs };
    longGapMs = observed(
      "longGapMs",
      longGaps.reduce((s, g) => s + g.durationMs, 0) + droppedMs,
      basis,
      gapCov,
      counts
    );
    longGapCount = observed(
      "longGapCount",
      longGaps.length + droppedCount,
      basis,
      gapCov,
      counts
    );
  }

  // failureCount（原始集計の写し）。L1 は 1 件の失敗を段落側に 1 回だけ記帳する（自レーンは failCount、
  // 委任配下は深さを問わず childFailCount）。委任 Attempt の failCount / childFailCount は同じ失敗を
  // Agent 単位で見直した値なので、段落 Attempt と合算すると二重になる（HANDOFF）。
  // 委任 Attempt を足すのは、その段落が段落 Attempt に束ねられていない（dispatch だけの段落は L2 が落とす）ときだけ。
  // segmentIds が空の委任 Attempt はどの段落の代役でもないので足さない（空配列では some() が常に false になり、
  // 交差判定だけでは「束ねられていない段落」と同じ扱いで素通りする）
  let failureCount: L3Metric;
  if (attempts.length === 0) {
    failureCount = unavailable("failureCount", "no_attempt_input", cov);
  } else {
    const bundledSegmentIds = new Set(
      attempts.filter((a) => a.actor === undefined).flatMap((a) => a.anchors.segmentIds)
    );
    const counted = attempts.filter(
      (a) =>
        a.actor === undefined ||
        (a.anchors.segmentIds.length > 0 && !a.anchors.segmentIds.some((id) => bundledSegmentIds.has(id)))
    );
    let total = 0;
    const failing: ExecutionAttemptNode[] = [];
    for (const a of counted) {
      const f = (a.result?.failCount ?? 0) + (a.result?.childFailCount ?? 0);
      total += f;
      if (f > 0) failing.push(a);
    }
    failureCount = observed(
      "failureCount",
      total,
      {
        nodeIds: failing.map((a) => a.nodeId),
        edgeIds: [],
        evidence: capEvidence(failing.flatMap((a) => a.evidence)),
      },
      cov
    );
  }

  const actualConcurrency = deriveActualConcurrency(model);

  // 裁定H1（B2 と同型）: resource 系の辺は両側 unknownEffects=false のときだけ張られる。
  // 評価可能な対が構造的に 1 組も無いなら「辺 0 本」は競合の不在ではないので
  // observed 0 と書かない（観測できなかったことを競合しないとして扱わない）
  const footprintObservable = attempts.filter((a) => a.footprint.unknownEffects === false);
  const footprintGate: L3UnavailableReason | undefined =
    attempts.length === 0
      ? "no_attempt_input"
      : model.coverage.detail === "partial"
      ? "edge_limit_exceeded"
      : footprintObservable.length < 2
      ? "no_footprint_input"
      : undefined;

  // 裁定M5: undetermined の母集合は「overlaps した対のうち unknownEffects で
  // 判定できなかったもの」。全 Attempt 総当たりだと母集合が意図とずれる
  const attemptById = new Map(attempts.map((a) => [a.nodeId, a]));
  const overlapAttemptEdges = model.edges.filter(
    (e) => e.kind === "overlaps" && attemptById.has(e.from) && attemptById.has(e.to)
  );
  let undeterminedOverlapPairs = 0;
  for (const e of overlapAttemptEdges) {
    const a = attemptById.get(e.from)!;
    const b = attemptById.get(e.to)!;
    if (a.footprint.unknownEffects || b.footprint.unknownEffects) undeterminedOverlapPairs++;
  }

  // fileWriteConflictCount: resource_conflict のうち overlaps する対（実際に同時に触った）
  let fileWriteConflictCount: L3Metric;
  {
    const overlapPairs = new Set(overlapAttemptEdges.map((e) => pairKey(e.from, e.to)));
    const conflicting = model.edges.filter(
      (e) => e.kind === "resource_conflict" && overlapPairs.has(pairKey(e.from, e.to))
    );
    fileWriteConflictCount =
      footprintGate !== undefined
        ? unavailable("fileWriteConflictCount", footprintGate, cov, {
            undeterminedPairCount: undeterminedOverlapPairs,
          })
        : observed(
            "fileWriteConflictCount",
            conflicting.length,
            {
              nodeIds: [],
              edgeIds: conflicting.map((e) => e.edgeId),
              evidence: capEvidence(conflicting.flatMap((e) => e.evidence)),
            },
            cov,
            { undeterminedPairCount: undeterminedOverlapPairs }
          );
  }

  // resourceDependencyCount: observed_data_dep 辺の件数（Footprint 由来の観測のみ）
  let resourceDependencyCount: L3Metric;
  {
    const ddEdges = model.edges.filter((e) => e.kind === "observed_data_dep");
    resourceDependencyCount =
      footprintGate !== undefined
        ? unavailable("resourceDependencyCount", footprintGate, cov, {
            undeterminedPairCount: undeterminedOverlapPairs,
          })
        : observed(
            "resourceDependencyCount",
            ddEdges.length,
            {
              nodeIds: [],
              edgeIds: ddEdges.map((e) => e.edgeId),
              evidence: capEvidence(ddEdges.flatMap((e) => e.evidence)),
            },
            cov
          );
  }

  // unknownEffectRatio: unknownEffects=true の Attempt 割合
  let unknownEffectRatio: L3Metric;
  if (attempts.length === 0) {
    unknownEffectRatio = unavailable("unknownEffectRatio", "no_attempt_input", cov);
  } else {
    const unknowns = attempts.filter((a) => a.footprint.unknownEffects);
    unknownEffectRatio = observed(
      "unknownEffectRatio",
      unknowns.length / attempts.length,
      { nodeIds: unknowns.map((a) => a.nodeId), edgeIds: [], evidence: [] },
      cov,
      { unknownEffectAttemptCount: unknowns.length, attemptCount: attempts.length }
    );
  }

  const observedConstraintChainMs = deriveObservedConstraintChain(model);

  const relations = buildPairRelations(model);
  const serializationProfile = deriveSerializationProfile(model, relations);
  const parallelizationUpperBound = deriveParallelizationEstimate(model, relations);

  const taskMetrics = deriveTaskMetricSets(model);

  return {
    specVersion: L3_ANALYSIS_SPEC_VERSION,
    semanticHash: model.semanticHash,
    taskMetrics,
    metrics: {
      longGapMs,
      longGapCount,
      failureCount,
      actualConcurrency,
      fileWriteConflictCount,
      resourceDependencyCount,
      unknownEffectRatio,
      observedConstraintChainMs,
    },
    serializationProfile,
    estimates: {
      parallelizationUpperBound,
    },
  };
}
