import { containsAbsolutePath } from "./path-redaction";

export type RedactionViolation =
  | { field: string; kind: "absolute_path" }
  | { field: string; kind: "host_only_key" };

export type RedactionCheckResult =
  | { ok: true }
  | { ok: false; violations: RedactionViolation[] };

const HOST_ONLY_KEYS = ["canonicalPath", "baseDir", "sourceRoot", "cwd"];

export function checkEnvelopeRedaction(envelopeText: string): RedactionCheckResult {
  const violations: RedactionViolation[] = [];
  for (const key of HOST_ONLY_KEYS) {
    if (envelopeText.includes(`"${key}"`)) {
      violations.push({ field: key, kind: "host_only_key" });
    }
  }
  if (containsAbsolutePath(envelopeText)) {
    violations.push({ field: "envelope", kind: "absolute_path" });
  }
  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}
