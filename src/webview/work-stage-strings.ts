import * as l10n from "@vscode/l10n";
import type { StageTextPort } from "./work-stage-port";

export function stageRole(role: string): string {
  return role.toLowerCase();
}

export function workStageText(): StageTextPort {
  const conductor = l10n.t("Conductor");
  return {
    wait: {
      approve: l10n.t("Waiting for your approval"),
      decide: l10n.t("Waiting for your decision"),
      check: l10n.t("Waiting for your check"),
    },
    workerName: l10n.t("Worker"),
    conductorName: conductor,
    conductorRole: stageRole(conductor),
    placeholderMark: l10n.t("Placeholder"),
    failed: l10n.t("Failed"),
    overflowTitle: l10n.t("Workers waiting for a seat"),
    running: (n) => l10n.t("{0} workers at work", n),
    noneRunning: l10n.t("No workers at work"),
    waitingYou: l10n.t("Waiting for your reply"),
    stepDone: (n) => l10n.t("Done {0}", n),
    you: l10n.t("You"),
    stage: l10n.t("Work stage"),
  };
}
