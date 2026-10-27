import { isHistoryEvent, type EventProvenance, type NormalizedEventBody } from "./protocol";

export function permissionDeniedTarget(ev: { classifierUnavailable?: boolean; inDelegate?: true }, ran: boolean): "conv" | "work" | null {
  if (ran) return null;
  return ev.classifierUnavailable && ev.inDelegate !== true ? "conv" : "work";
}

export function isConvRenderableEvent(ev: NormalizedEventBody & { provenance?: EventProvenance }): boolean {
  if (ev.kind === "local_command_output") return ev.priorGeneration !== true && !isHistoryEvent(ev);
  if (ev.kind === "replayed_message" || ev.kind === "model_refusal_fallback" || ev.kind === "model_fallback_revert") return true;
  if (ev.kind === "compact_boundary") return ev.priorGeneration !== true;
  if (ev.kind === "user_message" || ev.kind === "assistant_text_delta" || ev.kind === "model_observed") return ev.priorGeneration !== true;
  if (ev.kind === "permission_denied") return permissionDeniedTarget(ev, false) === "conv";
  return false;
}

export function isConvMessageEvent(ev: NormalizedEventBody & { provenance?: EventProvenance }): boolean {
  if (!isConvRenderableEvent(ev)) return false;
  if (ev.kind === "replayed_message") return ev.role !== "system";
  return ev.kind === "user_message" || ev.kind === "assistant_text_delta";
}
