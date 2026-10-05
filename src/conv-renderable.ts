import type { NormalizedEvent } from "./protocol";

export function isConvRenderableEvent(ev: NormalizedEvent): boolean {
  if (ev.kind === "local_command_output") return ev.priorGeneration !== true && ev.provenance?.path !== "history";
  if (ev.kind === "replayed_message" || ev.kind === "model_observed" || ev.kind === "model_refusal_fallback" || ev.kind === "model_fallback_revert") return true;
  if (ev.kind === "compact_boundary") return ev.priorGeneration !== true;
  if (ev.kind === "user_message" || ev.kind === "assistant_text_delta") {
    return ev.provenance?.path !== "history";
  }
  return false;
}
