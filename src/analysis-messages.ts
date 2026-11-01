import type { WebviewToHost } from "./protocol";
import type { Session } from "./extension";

export async function handleAnalysisMessage(
  msg: Extract<WebviewToHost, { type: "summarizeSession" | "suggestSessionName" }>,
  target: Session | undefined
): Promise<void> {
  switch (msg.type) {
    case "suggestSessionName":
      await target!.summaryRunner.requestSessionNameSuggestion();
      break;
    case "summarizeSession":
      await target!.summaryRunner.requestSessionSummary();
      break;
  }
}
