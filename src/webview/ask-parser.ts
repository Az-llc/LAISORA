export interface AskOption {
  label: string;
  effect: string;
  pros: string;
  cons: string;
  recommended?: true;
}

export interface AskStep {
  do: string;
  look: string;
}

export type AskBlock = { title: string; why: string; default: string } & (
  | { kind: "decide"; options: AskOption[] }
  | { kind: "check"; steps: AskStep[] }
);

function scalar(raw: string): string | null {
  const value = raw.trim();
  if (!value || /[\u0000-\u001f]/.test(value)) return null;
  if (value.startsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      return typeof parsed === "string" && parsed.trim() && !/[\u0000-\u001f]/.test(parsed) ? parsed : null;
    } catch { return null; }
  }
  if (/^[\[\]{}&*!|>'%@`#]/.test(value) || /\s#/.test(value)) return null;
  return value;
}

export interface PlanBlock { goal: string }

export function parseAskBlock(source: string): AskBlock | null {
  return parseBlock(source, "ask") as AskBlock | null;
}

export function parsePlanBlock(source: string): PlanBlock | null {
  return parseBlock(source, "plan") as PlanBlock | null;
}

function parseBlock(source: string, type: "ask" | "plan"): AskBlock | PlanBlock | null {
  const root: Record<string, string> = Object.create(null);
  const entries: Record<string, string>[] = [];
  let list: "options" | "steps" | undefined;
  let inList = false;
  let entry: Record<string, string> | undefined;
  for (const line of source.replace(/\r\n/g, "\n").split("\n")) {
    if (!line.trim()) continue;
    const match = /^( *)(- )?([a-z]+):(?: (.*))?$/.exec(line);
    if (!match) return null;
    const [, indent, dash, key, raw = ""] = match;
    if (indent.length === 0 && !dash) {
      inList = false;
      if (type === "ask" && (key === "options" || key === "steps")) {
        if (list || raw.trim()) return null;
        list = key;
        inList = true;
      } else {
        if (!(type === "plan" ? ["goal"] : ["kind", "title", "why", "default"]).includes(key) || Object.hasOwn(root, key)) return null;
        const value = scalar(raw);
        if (value === null) return null;
        root[key] = value;
      }
      continue;
    }
    if (!inList || !list) return null;
    if (indent.length === 2 && dash) {
      entry = Object.create(null) as Record<string, string>;
      entries.push(entry);
    } else if (indent.length !== 4 || dash || !entry) return null;
    if (!entry || Object.hasOwn(entry, key)) return null;
    if (!(list === "options" ? ["label", "effect", "pros", "cons", "recommended"] : ["do", "look"]).includes(key)) return null;
    const value = scalar(raw);
    if (value === null || (key === "recommended" && raw !== "true")) return null;
    entry[key] = value;
  }
  if (type === "plan") return root.goal ? { goal: root.goal } : null;
  if (!root.title || !root.why || !root.default || entries.length === 0) return null;
  const base = { title: root.title, why: root.why, default: root.default };
  if (root.kind === "decide" && list === "options" && entries.every((e) => e.label && e.effect && e.pros && e.cons)) {
    return { ...base, kind: "decide", options: entries.map((e) => ({ label: e.label, effect: e.effect, pros: e.pros, cons: e.cons, ...(e.recommended ? { recommended: true as const } : {}) })) };
  }
  if (root.kind === "check" && list === "steps" && entries.every((e) => e.do && e.look)) {
    return { ...base, kind: "check", steps: entries.map((e) => ({ do: e.do, look: e.look })) };
  }
  return null;
}
