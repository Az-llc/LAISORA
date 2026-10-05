import type { ExposureRecord, LedgerV2Record } from "./learning-episodes";

export function validExposures(records: Iterable<LedgerV2Record>): ExposureRecord[] {
  const groups = new Map<string, ExposureRecord[]>();
  for (const record of records) if (record.kind === "exposure") {
    const key = JSON.stringify([record.conversation, record.recipient, record.run, record.dispatchId, record.exposureId]);
    const group = groups.get(key);
    if (group) group.push(record); else groups.set(key, [record]);
  }
  return [...groups.values()].flatMap(group => {
    const sent = group.find(record => record.outcome === "sent");
    if (!sent || group.some(record => ["model-mismatch", "dispatch-failed"].includes(record.outcome))) return [];
    const identity = (record: ExposureRecord) => JSON.stringify([record.promptHash, record.requestedModel, record.requestedEffort, record.route,
      record.executor, record.role, record.items.map(item => `${item.type}:${item.id}`).sort()]);
    const sentIdentity = identity(sent);
    if (group.some(record => record !== sent && identity(record) !== sentIdentity)) return [];
    const observed = [...group].reverse().find(record => record.observedModel !== "unknown" && record.attestation?.length
      && (record.route === "conductor" || record.observedEffort !== "unknown"));
    const unresolvedConductor = sent.route === "conductor" && sent.requestedModel === "unknown";
    const requestedModel = unresolvedConductor ? group.find(record => record.observedModel !== "unknown")?.observedModel : sent.requestedModel;
    if (unresolvedConductor && group.some(record => record.observedModel !== "unknown" && record.observedModel !== requestedModel)) return [];
    if (!observed || observed.promptHash !== sent.promptHash || observed.requestedModel !== sent.requestedModel
      || observed.observedModel !== requestedModel || observed.route !== sent.route
      || observed.route === "target" && observed.observedEffort !== sent.requestedEffort) return [];
    return [{ ...sent, observedModel: observed.observedModel, observedEffort: observed.observedEffort, attestation: observed.attestation }];
  });
}

export function exposureUsage(records: Iterable<LedgerV2Record>) {
  const all = [...records], valid = validExposures(all);
  const delivered = new Map<string, Set<string>>(), used = new Map<string, Set<string>>(), ineffective = new Map<string, Set<string>>();
  const add = (map: Map<string, Set<string>>, id: string, value: string) => {
    const values = map.get(id);
    if (values) values.add(value); else map.set(id, new Set([value]));
  };
  for (const exposure of valid) for (const item of exposure.items) add(delivered, item.id, exposure.conversation);
  const subjectKey = (record: { conversation: string; recipient: string; run: string }) => JSON.stringify([record.conversation, record.recipient, record.run]);
  const bySubject = new Map<string, ExposureRecord[]>();
  for (const exposure of valid) {
    const key = subjectKey(exposure), group = bySubject.get(key);
    if (group) group.push(exposure); else bySubject.set(key, [exposure]);
  }
  const matching = (record: { conversation: string; recipient: string; run: string; dispatchId: string; at: string }, id: string) => (bySubject.get(subjectKey(record)) ?? []).filter(exposure =>
    exposure.dispatchId === record.dispatchId && exposure.at <= record.at && exposure.items.some(item => item.id === id));
  const firstEpisode = new Map<string, Extract<LedgerV2Record, { kind: "episode" }>>();
  const countedEpisodes = new Set<string>();
  const successes = new Map<string, Extract<LedgerV2Record, { kind: "episode-state" }>[]>();
  for (const record of all) {
    if (record.kind === "episode") {
      if (!firstEpisode.has(record.ruleId)) firstEpisode.set(record.ruleId, record);
      if (record.status === "counted") countedEpisodes.add(JSON.stringify([record.ruleId, record.conversation, record.recipient, record.run]));
    } else if (record.kind === "episode-state" && record.action === "success" && record.status === undefined) {
      const key = subjectKey(record), group = successes.get(key);
      if (group) group.push(record); else successes.set(key, [record]);
    }
  }
  for (const episode of all) if (episode.kind === "episode" && episode.status === "counted") {
    if (matching(episode, episode.ruleId).some(exposure => exposure.route === (episode.key.bind === "target" ? "target" : "conductor"))) add(ineffective, episode.ruleId, episode.opId);
  }
  for (const use of all) if (use.kind === "use") {
    const id = use.item.type === "rule" ? use.item.ruleId : use.item.itemId;
    const received = matching(use, id);
    if (!received.length) continue;
    if (use.item.type === "claim" && !use.runs?.length) continue;
    if (use.item.type === "rule") {
      const rule = firstEpisode.get(id);
      if (!rule || !received.some(exposure => exposure.route === (rule.key.bind === "target" ? "target" : "conductor"))) continue;
      if (countedEpisodes.has(JSON.stringify([id, use.conversation, use.recipient, use.run]))) continue;
      if (!(successes.get(subjectKey(use)) ?? []).some(record => record.tool === rule.tool && record.head === rule.head && record.at <= use.at
        && received.some(exposure => exposure.at <= record.at))) continue;
    }
    add(used, id, use.conversation);
  }
  const counts = (map: Map<string, Set<string>>) => new Map([...map].map(([id, values]) => [id, values.size]));
  return { delivered: counts(delivered), used: counts(used), ineffective: counts(ineffective) };
}
