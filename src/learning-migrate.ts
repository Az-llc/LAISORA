import { isLearningRecord, textHash, type LearningRecord, type QualificationState } from "./learning";

export interface LegacyRule {
  rule_id: string;
  src: string;
  source_failures?: string[];
  line: string;
  state: QualificationState;
  lastseen?: string;
  updated_at?: string;
  history?: Array<{ at: string }>;
}
export interface MigrationInputs {
  registry: { rules: LegacyRule[] };
  skillLines: Readonly<Record<string, string>>;
  failures: Array<{ id: string; manifest: { model?: string | null; created_at: string }; evidenceFiles: string[] }>;
  existingOpIds: Iterable<string>;
  batchId?: string;
  now: string;
}
export interface MigrationReport {
  batchId: string;
  inputManifestHash: string;
  converterVersion: string;
  migrationTime: string;
  counts: { rules: number; imported: number; missingModels: number; observations: number; versions: number; mismatches: number; missingRefs: number; planned: number; existing: number; new: number };
  rules: Array<{ ruleId: string; model: string | null; oldState: QualificationState; versions: number; mismatch: boolean; missingRefs: string[] }>;
  missingRefs: string[];
  text: string;
}

export function opaqueR34(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:@-]*$/.test(value)
    || /^(?:sk-|gh[pousr]_|github_pat_|AKIA)/i.test(value)) throw new Error("R-LRN-08: invalid opaque reference");
  return value;
}
function isoR34(value: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    || !Number.isFinite(Date.parse(value))) throw new Error("R-LRN-08: missing or invalid timestamp");
  return new Date(value).toISOString();
}
export function stripRuleComment(line: string): string { return line.replace(/\s*<!--[^]*?-->\s*$/, ""); }
export function referencedFailures(rule: LegacyRule): string[] {
  return [...new Set([rule.src, ...(rule.source_failures ?? [])].map(opaqueR34))].sort();
}

export function planMigration(inputs: MigrationInputs): { records: LearningRecord[]; report: MigrationReport } {
  const rules = [...inputs.registry.rules].sort((a, b) => a.rule_id < b.rule_id ? -1 : a.rule_id > b.rule_id ? 1 : 0);
  if (new Set(rules.map(rule => opaqueR34(rule.rule_id))).size !== rules.length) throw new Error("R-LRN-08: duplicate rule id");
  if (rules.some(rule => !["candidate", "active", "quarantined", "review_due", "retired", "rejected"].includes(rule.state)))
    throw new Error("R-LRN-08: invalid old state");
  const inputManifestHash = textHash(rules.map(rule => `${rule.rule_id}:${textHash(stripRuleComment(rule.line))}:${rule.state}`).sort().join("\n"));
  const batchId = opaqueR34(inputs.batchId ?? textHash(inputManifestHash));
  const opId = (kind: LearningRecord["kind"], id: string, hash = "") => textHash("import:" + batchId + ":" + kind + ":" + id + ":" + hash);
  const records: LearningRecord[] = [];
  const failures = new Map(inputs.failures.map(failure => [opaqueR34(failure.id), failure]));
  if (failures.size !== inputs.failures.length) throw new Error("R-LRN-08: duplicate failure id");
  const references = [...new Set(rules.flatMap(referencedFailures))].sort();
  const missingRefs = references.filter(id => !failures.has(id));
  for (const id of references) {
    const failure = failures.get(id);
    if (!failure) continue;
    const model = failure.manifest.model == null ? null : opaqueR34(failure.manifest.model.replace(/^[^/]+\//, ""));
    records.push({ kind: "observation", opId: opId("observation", id), at: isoR34(failure.manifest.created_at), type: "failure",
      model, scope: "global", conversationRef: "import:" + batchId, sessionRef: null, runRef: null, sourceRef: id,
      refs: [...new Set(failure.evidenceFiles.map(name => `${id}:${opaqueR34(name)}`))].sort() });
  }
  const rulePlans: MigrationReport["rules"] = [];
  for (const rule of rules) {
    const text = stripRuleComment(rule.line), hash = textHash(text);
    const skillText = Object.hasOwn(inputs.skillLines, rule.rule_id) ? stripRuleComment(inputs.skillLines[rule.rule_id]) : undefined;
    const mismatch = skillText !== undefined && textHash(skillText) !== hash;
    const match = rule.lastseen?.match(/^([^/]+)\/\d{4}-\d{2}-\d{2}$/);
    const model = match ? opaqueR34(match[1]) : null;
    rulePlans.push({ ruleId: rule.rule_id, model, oldState: rule.state, versions: model ? (mismatch ? 2 : 1) : 0,
      mismatch, missingRefs: referencedFailures(rule).filter(id => !failures.has(id)) });
    if (!model) continue;
    const at = isoR34(rule.updated_at ?? rule.history?.at(-1)?.at!);
    records.push({ kind: "ruleVersion", opId: opId("ruleVersion", rule.rule_id, hash), at, rule_id: rule.rule_id, text, hash, scope: "global", domain: "orchestration" });
    records.push({ kind: "candidate", opId: opId("candidate", rule.rule_id, hash), at, rule_id: rule.rule_id, hash, model,
      sourceRef: opaqueR34(rule.src), sourceAt: at, evidence: { sessions: [], recurrences: [],
        observations: referencedFailures(rule).filter(id => failures.has(id)).map(id => opId("observation", id)) } });
    records.push({ kind: "import", opId: opId("import", rule.rule_id, hash), at, rule_id: rule.rule_id,
      batchId, oldId: rule.rule_id, oldState: rule.state, reason: "import_unverified" });
    if (mismatch) {
      const skillHash = textHash(skillText!);
      records.push({ kind: "ruleVersion", opId: opId("ruleVersion", rule.rule_id, skillHash), at, rule_id: rule.rule_id,
        text: skillText!, hash: skillHash, scope: "global", domain: "orchestration", expectHash: hash });
    }
  }
  if (records.some(record => !isLearningRecord(record))) throw new Error("R-LRN-08: invalid planned record");
  const existing = new Set(inputs.existingOpIds);
  const fresh = records.filter(record => !existing.has(record.opId));
  const counts = { rules: rules.length, imported: rulePlans.filter(rule => rule.model !== null).length,
    missingModels: rulePlans.filter(rule => rule.model === null).length, observations: records.filter(record => record.kind === "observation").length,
    versions: records.filter(record => record.kind === "ruleVersion").length, mismatches: rulePlans.filter(rule => rule.mismatch).length,
    missingRefs: missingRefs.length, planned: records.length, existing: records.length - fresh.length, new: fresh.length };
  const report: MigrationReport = { batchId, inputManifestHash, converterVersion: "learning-migrate/1", migrationTime: isoR34(inputs.now),
    counts, rules: rulePlans, missingRefs, text: "" };
  report.text = [
    `batch: ${batchId}`, `input manifest hash: ${inputManifestHash}`, `converter: ${report.converterVersion}`, `migration time: ${report.migrationTime}`,
    `rules: ${counts.rules}; imported: ${counts.imported}; missing models: ${counts.missingModels}`,
    `records: ${counts.planned} planned; ${counts.new} new; ${counts.existing} existing`,
    `versions: ${counts.versions}; candidates: ${counts.imported}; imports: ${counts.imported}; observations: ${counts.observations}`,
    `mismatches: ${counts.mismatches}; missing refs: ${counts.missingRefs}`,
    ...rulePlans.map(rule => `rule ${rule.ruleId}: ${rule.model === null ? "missing model; skipped" : `${rule.oldState}; model ${rule.model}; ${rule.versions} version(s)`}${rule.mismatch ? "; text mismatch" : ""}`),
    ...missingRefs.map(id => `missing evidence: ${id}`),
  ].join("\n");
  return { records: fresh, report };
}
