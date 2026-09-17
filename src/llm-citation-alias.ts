export interface CitationAliasSource {
  readonly events?: readonly { readonly toolUseId: string }[];
  readonly userMessages?: readonly { readonly messageId: string }[];
  readonly metrics?: readonly { readonly metricId: string }[];
  readonly divergenceRecords?: readonly { readonly divergenceId: string }[];
  readonly guardrailSignals?: readonly { readonly signalId: string }[];
  readonly contextFiles?: readonly { readonly fileId: string }[];
  readonly entries?: readonly { readonly canonicalId: string; readonly alias: string }[];
}

export interface CitationAliasTable {
  readonly aliasOf: ReadonlyMap<string, string>;
  readonly canonicalOf: ReadonlyMap<string, string>;
}

export function buildCitationAliasTable(source: CitationAliasSource): CitationAliasTable {
  if (!source || typeof source !== "object") {
    throw new Error("llm-citation-alias: invalid source object");
  }

  const aliasOf = new Map<string, string>();
  const canonicalOf = new Map<string, string>();

  const register = (canonicalId: string, alias: string): void => {
    if (typeof canonicalId !== "string" || canonicalId.length === 0) {
      throw new Error("llm-citation-alias: invalid canonical ID");
    }
    if (typeof alias !== "string" || alias.length === 0) {
      throw new Error("llm-citation-alias: invalid alias");
    }
    if (aliasOf.has(canonicalId)) {
      throw new Error(`llm-citation-alias: duplicate canonical ID ${canonicalId}`);
    }
    if (canonicalOf.has(alias)) {
      throw new Error(`llm-citation-alias: duplicate alias ${alias}`);
    }
    aliasOf.set(canonicalId, alias);
    canonicalOf.set(alias, canonicalId);
  };

  if (Array.isArray(source.events)) {
    for (let i = 0; i < source.events.length; i++) {
      const item = source.events[i];
      if (item && typeof item.toolUseId === "string") {
        register(item.toolUseId, `E${i + 1}`);
      }
    }
  }

  if (Array.isArray(source.userMessages)) {
    for (let i = 0; i < source.userMessages.length; i++) {
      const item = source.userMessages[i];
      if (item && typeof item.messageId === "string") {
        register(item.messageId, `U${i + 1}`);
      }
    }
  }

  if (Array.isArray(source.metrics)) {
    for (const item of source.metrics) {
      if (item && typeof item.metricId === "string") {
        const id = item.metricId.startsWith("M:") ? item.metricId : `M:${item.metricId}`;
        register(id, id);
      }
    }
  }

  if (Array.isArray(source.divergenceRecords)) {
    for (let i = 0; i < source.divergenceRecords.length; i++) {
      const item = source.divergenceRecords[i];
      if (item && typeof item.divergenceId === "string") {
        register(item.divergenceId, `D${i + 1}`);
      }
    }
  }

  if (Array.isArray(source.guardrailSignals)) {
    for (let i = 0; i < source.guardrailSignals.length; i++) {
      const item = source.guardrailSignals[i];
      if (item && typeof item.signalId === "string") {
        register(item.signalId, `G${i + 1}`);
      }
    }
  }

  if (Array.isArray(source.contextFiles)) {
    for (let i = 0; i < source.contextFiles.length; i++) {
      const item = source.contextFiles[i];
      if (item && typeof item.fileId === "string") {
        const alias = `F${i + 1}`;
        register(item.fileId, alias);
      }
    }
  }

  if (Array.isArray(source.entries)) {
    for (const entry of source.entries) {
      if (entry && typeof entry.canonicalId === "string" && typeof entry.alias === "string") {
        register(entry.canonicalId, entry.alias);
      }
    }
  }

  return Object.freeze({
    aliasOf,
    canonicalOf,
  });
}
