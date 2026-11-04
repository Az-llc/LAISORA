import { APPROVAL_RESOLVED_BY } from "./ask-unanswered";

export const MCP_ELICITATION_SETTING_KEY = "claude.mcpElicitation";

export function mcpElicitationEnabled(get: (key: typeof MCP_ELICITATION_SETTING_KEY) => unknown): boolean {
  return get(MCP_ELICITATION_SETTING_KEY) !== false;
}

export const ELICITATION_CONTENT_LIMITS = { fields: 100, keyLength: 2000, textLength: 10_000, picks: 100 } as const;

export const ELICITATION_STRING_FORMATS = ["email", "uri", "date", "date-time"] as const;
export type ElicitationStringFormat = (typeof ELICITATION_STRING_FORMATS)[number];

export interface ElicitationOption {
  value: string;
  label: string;
}

interface ElicitationFieldBase {
  name: string;
  title?: string;
  description?: string;
  required: boolean;
}

export type ElicitationField =
  | (ElicitationFieldBase & { kind: "text"; format?: ElicitationStringFormat; minLength?: number; maxLength?: number; default?: string })
  | (ElicitationFieldBase & { kind: "number"; integer: boolean; minimum?: number; maximum?: number; default?: number })
  | (ElicitationFieldBase & { kind: "boolean"; default?: boolean })
  | (ElicitationFieldBase & { kind: "choice"; options: ElicitationOption[]; default?: string })
  | (ElicitationFieldBase & { kind: "choices"; options: ElicitationOption[]; minItems?: number; maxItems?: number; default?: string[] });

export interface ElicitationSpec {
  mode: "form" | "url";
  server: string;
  message: string;
  title?: string;
  description?: string;
  fields?: ElicitationField[];
  url?: string;
  urlHost?: string;
}

export interface ElicitationRequestInput {
  serverName: string;
  message: string;
  mode?: "form" | "url";
  url?: string;
  requestedSchema?: Record<string, unknown>;
  title?: string;
  displayName?: string;
  description?: string;
}

export type ElicitationValue = string | number | boolean | string[];
export type ElicitationContent = Record<string, ElicitationValue>;
export type ElicitationIssueKind = "required" | "type" | "format" | "length" | "range" | "option" | "count";
export interface ElicitationIssue {
  field: string;
  kind: ElicitationIssueKind;
}

export type ElicitationAction = "accept" | "decline" | "cancel";

export type ElicitationAnswer = {
  action: ElicitationAction;
  content?: ElicitationContent;
};

const text = (value: unknown): string | undefined => (typeof value === "string" && value.length > 0 ? value : undefined);
const count = (value: unknown): number | undefined => (typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined);
const finite = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

function titledOptions(list: unknown): ElicitationOption[] | undefined {
  if (!Array.isArray(list) || list.length === 0) return undefined;
  const options: ElicitationOption[] = [];
  for (const entry of list) {
    const item = record(entry);
    if (item === undefined || typeof item.const !== "string") return undefined;
    options.push({ value: item.const, label: text(item.title) ?? item.const });
  }
  return options;
}

function enumOptions(values: unknown, names: unknown): ElicitationOption[] | undefined {
  if (!Array.isArray(values) || values.length === 0 || !values.every((v) => typeof v === "string")) return undefined;
  const labels = Array.isArray(names) && names.length === values.length && names.every((n) => typeof n === "string") ? (names as string[]) : undefined;
  return (values as string[]).map((value, i) => ({ value, label: labels?.[i] || value }));
}

function fieldOf(name: string, raw: unknown, required: boolean): ElicitationField | undefined {
  const prop = record(raw);
  if (prop === undefined) return undefined;
  const base: ElicitationFieldBase = {
    name,
    required,
    ...(text(prop.title) !== undefined ? { title: text(prop.title) } : {}),
    ...(text(prop.description) !== undefined ? { description: text(prop.description) } : {}),
  };
  const single = enumOptions(prop.enum, prop.enumNames) ?? titledOptions(prop.oneOf) ?? titledOptions(prop.anyOf);
  if ((prop.type === "string" || prop.type === undefined) && single !== undefined) {
    const fallback = typeof prop.default === "string" && single.some((o) => o.value === prop.default) ? prop.default : undefined;
    return { ...base, kind: "choice", options: single, ...(fallback !== undefined ? { default: fallback } : {}) };
  }
  switch (prop.type) {
    case "string": {
      const format = (ELICITATION_STRING_FORMATS as readonly unknown[]).includes(prop.format) ? (prop.format as ElicitationStringFormat) : undefined;
      return {
        ...base, kind: "text",
        ...(format !== undefined ? { format } : {}),
        ...(count(prop.minLength) !== undefined ? { minLength: count(prop.minLength) } : {}),
        ...(count(prop.maxLength) !== undefined ? { maxLength: count(prop.maxLength) } : {}),
        ...(typeof prop.default === "string" ? { default: prop.default } : {}),
      };
    }
    case "number":
    case "integer":
      return {
        ...base, kind: "number", integer: prop.type === "integer",
        ...(finite(prop.minimum) !== undefined ? { minimum: finite(prop.minimum) } : {}),
        ...(finite(prop.maximum) !== undefined ? { maximum: finite(prop.maximum) } : {}),
        ...(finite(prop.default) !== undefined ? { default: finite(prop.default) } : {}),
      };
    case "boolean":
      return { ...base, kind: "boolean", ...(typeof prop.default === "boolean" ? { default: prop.default } : {}) };
    case "array": {
      const items = record(prop.items);
      const options = items === undefined ? undefined : enumOptions(items.enum, items.enumNames) ?? titledOptions(items.anyOf) ?? titledOptions(items.oneOf);
      if (options === undefined) return undefined;
      const fallback = Array.isArray(prop.default) && prop.default.every((v) => typeof v === "string" && options.some((o) => o.value === v))
        ? (prop.default as string[]) : undefined;
      return {
        ...base, kind: "choices", options,
        ...(count(prop.minItems) !== undefined ? { minItems: count(prop.minItems) } : {}),
        ...(count(prop.maxItems) !== undefined ? { maxItems: count(prop.maxItems) } : {}),
        ...(fallback !== undefined ? { default: fallback } : {}),
      };
    }
    default:
      return undefined;
  }
}

export function elicitationFieldsOf(schema: unknown): ElicitationField[] | undefined {
  if (schema === undefined) return [];
  const root = record(schema);
  if (root === undefined || (root.type !== undefined && root.type !== "object")) return undefined;
  if (root.properties === undefined) return [];
  const properties = record(root.properties);
  if (properties === undefined) return undefined;
  const required = new Set(Array.isArray(root.required) ? root.required.filter((r): r is string => typeof r === "string") : []);
  const entries = Object.entries(properties);
  if (entries.length > ELICITATION_CONTENT_LIMITS.fields) return undefined;
  const fields: ElicitationField[] = [];
  for (const [name, raw] of entries) {
    if (name.length === 0 || name.length > ELICITATION_CONTENT_LIMITS.keyLength) return undefined;
    const field = fieldOf(name, raw, required.has(name));
    if (field === undefined) return undefined;
    if ((field.kind === "choice" || field.kind === "choices") && field.options.some((o) => elicitationTextLength(o.value) > ELICITATION_CONTENT_LIMITS.textLength)) return undefined;
    fields.push(field);
  }
  return fields;
}

function webUrl(url: string | undefined): { href: string; host: string } | undefined {
  if (url === undefined) return undefined;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.host.length > 0 ? { href: parsed.href, host: parsed.host } : undefined;
  } catch {
    return undefined;
  }
}

export function elicitationSpecOf(request: ElicitationRequestInput): ElicitationSpec {
  const common = {
    server: text(request.displayName) ?? request.serverName,
    message: request.message,
    ...(text(request.title) !== undefined ? { title: text(request.title) } : {}),
    ...(text(request.description) !== undefined ? { description: text(request.description) } : {}),
  };
  if (request.mode === "url") {
    const web = webUrl(request.url);
    const shown = web?.href ?? text(request.url);
    return { mode: "url", ...common, ...(shown !== undefined ? { url: shown } : {}), ...(web !== undefined ? { urlHost: web.host } : {}) };
  }
  const fields = elicitationFieldsOf(request.requestedSchema);
  return { mode: "form", ...common, ...(fields !== undefined ? { fields } : {}) };
}

export function elicitationDraftOf(fields: readonly ElicitationField[]): Record<string, ElicitationValue | undefined> {
  const draft: Record<string, ElicitationValue | undefined> = {};
  for (const field of fields) {
    switch (field.kind) {
      case "boolean": draft[field.name] = field.default ?? false; break;
      case "choices": draft[field.name] = field.default ?? []; break;
      case "number": draft[field.name] = field.default === undefined ? "" : String(field.default); break;
      default: draft[field.name] = field.default ?? "";
    }
  }
  return draft;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i;

function validDate(value: string): boolean {
  const m = DATE_RE.exec(value);
  if (!m) return false;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return date.getUTCFullYear() === Number(m[1]) && date.getUTCMonth() === Number(m[2]) - 1 && date.getUTCDate() === Number(m[3]);
}

function formatHolds(format: ElicitationStringFormat, value: string): boolean {
  switch (format) {
    case "email": return EMAIL_RE.test(value);
    case "uri":
      try {
        new URL(value);
        return true;
      } catch {
        return false;
      }
    case "date": return validDate(value);
    case "date-time": {
      const m = DATE_TIME_RE.exec(value);
      return m !== null && validDate(m[1]) && Number.isFinite(Date.parse(value));
    }
  }
}

export function elicitationTextLength(value: string): number {
  return [...value].length;
}

export function elicitationMarkedRequired(field: ElicitationField): boolean {
  return field.required && (field.kind !== "choices" || (field.minItems ?? 0) > 0);
}

export function elicitationMaxLength(field: Extract<ElicitationField, { kind: "text" }>): number {
  return Math.min(field.maxLength ?? ELICITATION_CONTENT_LIMITS.textLength, ELICITATION_CONTENT_LIMITS.textLength);
}

export function elicitationMaxItems(field: Extract<ElicitationField, { kind: "choices" }>): number {
  return Math.min(field.maxItems ?? ELICITATION_CONTENT_LIMITS.picks, ELICITATION_CONTENT_LIMITS.picks);
}

function fieldIssue(field: ElicitationField, value: unknown): { issue?: ElicitationIssueKind; value?: ElicitationValue } {
  switch (field.kind) {
    case "text": {
      if (value === undefined || value === "") return field.required ? { issue: "required" } : {};
      if (typeof value !== "string") return { issue: "type" };
      const length = elicitationTextLength(value);
      if ((field.minLength !== undefined && length < field.minLength) || length > elicitationMaxLength(field)) return { issue: "length" };
      if (field.format !== undefined && !formatHolds(field.format, value)) return { issue: "format" };
      return { value };
    }
    case "number": {
      const raw = typeof value === "string" ? value.trim() : value;
      if (raw === undefined || raw === "") return field.required ? { issue: "required" } : {};
      const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : Number.NaN;
      if (!Number.isFinite(n) || (field.integer && !Number.isInteger(n))) return { issue: "type" };
      if ((field.minimum !== undefined && n < field.minimum) || (field.maximum !== undefined && n > field.maximum)) return { issue: "range" };
      return { value: n };
    }
    case "boolean":
      if (value === undefined) return field.required ? { issue: "required" } : {};
      return typeof value === "boolean" ? { value } : { issue: "type" };
    case "choice":
      if (value === undefined || value === "") return field.required ? { issue: "required" } : {};
      if (typeof value !== "string") return { issue: "type" };
      return field.options.some((o) => o.value === value) ? { value } : { issue: "option" };
    case "choices": {
      if (value === undefined) return field.required ? { issue: "required" } : {};
      if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) return { issue: "type" };
      const picked = [...new Set(value as string[])];
      if (!picked.every((v) => field.options.some((o) => o.value === v))) return { issue: "option" };
      if (picked.length === 0 && !field.required) return {};
      if ((field.minItems !== undefined && picked.length < field.minItems) || picked.length > elicitationMaxItems(field)) return { issue: "count" };
      return { value: picked };
    }
  }
}

export function validateElicitationContent(
  fields: readonly ElicitationField[],
  draft: Readonly<Record<string, unknown>>
): { content: ElicitationContent; issues: ElicitationIssue[] } {
  const content: ElicitationContent = {};
  const issues: ElicitationIssue[] = [];
  for (const field of fields) {
    const own = Object.prototype.hasOwnProperty.call(draft, field.name) ? draft[field.name] : undefined;
    const checked = fieldIssue(field, own);
    if (checked.issue !== undefined) issues.push({ field: field.name, kind: checked.issue });
    else if (checked.value !== undefined) content[field.name] = checked.value;
  }
  return { content, issues };
}

export function elicitationAnswer(
  spec: ElicitationSpec,
  decision: { behavior: "allow" | "deny"; resolvedBy?: string; content?: Readonly<Record<string, unknown>> }
): ElicitationAnswer {
  if (decision.behavior === "deny") return { action: (decision.resolvedBy ?? APPROVAL_RESOLVED_BY.user) === APPROVAL_RESOLVED_BY.user ? "decline" : "cancel" };
  if (spec.mode === "url") return spec.urlHost !== undefined ? { action: "accept" } : { action: "cancel" };
  if (spec.fields === undefined) return { action: "cancel" };
  const { content, issues } = validateElicitationContent(spec.fields, decision.content ?? {});
  return issues.length === 0 ? { action: "accept", content } : { action: "cancel" };
}

const LOCAL_DATE_TIME_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2}(?:\.\d+)?)?$/;

export function localDateTimeToRfc3339(local: string, offsetMinutesEast: number): string | undefined {
  const m = LOCAL_DATE_TIME_RE.exec(local);
  if (!m || !Number.isInteger(offsetMinutesEast)) return undefined;
  const sign = offsetMinutesEast < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutesEast);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${m[1]}${m[2] ?? ":00"}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

export function rfc3339ToLocalDateTime(value: string, offsetMinutesEastAt: (epochMs: number) => number): string | undefined {
  if (!DATE_TIME_RE.test(value)) return undefined;
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return undefined;
  const shifted = new Date(epoch + offsetMinutesEastAt(epoch) * 60_000);
  return shifted.toISOString().slice(0, 19);
}
