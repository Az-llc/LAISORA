import * as l10n from "@vscode/l10n";
import { normalizeDisplayName } from "../display-name";

let displayName = "";
const labels = new Set<WeakRef<HTMLElement>>();
const PRUNE_FLOOR = 256;
let pruneAt = PRUNE_FLOOR;
const listeners = new Set<() => void>();

export function userLabel(): string {
  return displayName || l10n.t("You").toUpperCase();
}

export function setDisplayName(value: unknown): void {
  const next = normalizeDisplayName(value);
  if (next === displayName) return;
  displayName = next;
  for (const ref of labels) {
    const el = ref.deref();
    if (el) fill(el);
    else labels.delete(ref);
  }
  for (const listener of listeners) listener();
}

export function onUserLabelChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function bindUserLabel<T extends HTMLElement>(el: T, target: "text" | "aria" = "text"): T {
  el.dataset.userLabel = target;
  if (target === "text") el.classList.add("user-label");
  if (labels.size >= pruneAt) {
    for (const ref of labels) if (!ref.deref()) labels.delete(ref);
    pruneAt = Math.max(PRUNE_FLOOR, labels.size * 2);
  }
  labels.add(new WeakRef(el));
  fill(el);
  return el;
}

function fill(el: HTMLElement): void {
  if (el.dataset.userLabel === "aria") {
    el.setAttribute("aria-label", userLabel());
    return;
  }
  el.textContent = displayName || l10n.t("You");
  el.classList.toggle("user-label-custom", displayName !== "");
  if (displayName) el.title = displayName;
  else el.removeAttribute("title");
}
