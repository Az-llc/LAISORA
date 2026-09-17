import type {
  AttachedAnalysisView,
  AttachedEvidenceChip,
  AttachedFindingView,
  LlmFindingReportView,
} from "../protocol";
import { vscode } from "./dom";
import * as l10n from "@vscode/l10n";

type AttachedView = AttachedAnalysisView;

function unavailableText(reason: string): string | undefined {
  const texts: Record<string, string> = {
    not_configured: l10n.t("LLM client is not configured"),
    model_unresolved: l10n.t("The model of this conversation could not be determined"),
    client_error: l10n.t("The LLM call failed"),
    timeout: l10n.t("The LLM call timed out"),
    parse_failed: l10n.t("Could not read the LLM response as findings"),
    internal_error: l10n.t("Could not run the analysis (internal error)"),
  };
  return texts[reason];
}

function el(tag: string, className: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function renderEvidenceChip(
  chip: AttachedEvidenceChip,
  evidenceNavigation?: { has(toolUseId: string): boolean; navigate(toolUseId: string): void }
): HTMLElement {
  const toolUseId = chip.navigateToolUseId;
  if (toolUseId !== undefined && evidenceNavigation?.has(toolUseId) === true) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "llm-evidence-chip llm-evidence-btn";
    btn.dataset.alias = chip.alias;
    btn.dataset.kind = chip.kind;
    btn.dataset.evidenceToolUseId = toolUseId;
    btn.textContent = `[${chip.label} ▸]`;
    btn.onclick = () => {
      evidenceNavigation.navigate(toolUseId);
    };
    return btn;
  }
  const span = el("span", "llm-evidence-chip", `[${chip.label}]`);
  span.dataset.alias = chip.alias;
  span.dataset.kind = chip.kind;
  return span;
}

function renderFindingCard(
  finding: AttachedFindingView,
  attached: AttachedView,
  tabId: string,
  semanticHash: string,
  evidenceNavigation?: { has(toolUseId: string): boolean; navigate(toolUseId: string): void }
): HTMLElement {
  const card = el("div", "llm-finding-card");
  card.dataset.findingId = finding.findingId;
  card.dataset.confidence = finding.confidence;

  const titleRow = el("div", "llm-finding-title-row");
  const titleLeft = el("div", "llm-finding-title-left");
  titleLeft.appendChild(el("span", "llm-finding-num", finding.numberLabel));
  titleLeft.appendChild(el("span", "llm-finding-title", finding.title));
  titleRow.appendChild(titleLeft);
  titleRow.appendChild(el("span", "llm-finding-badge", l10n.t("LLM Generated")));
  card.appendChild(titleRow);

  const routing = el("div", "llm-finding-routing");
  routing.appendChild(el("span", "llm-finding-badge llm-destination-badge", l10n.t("Improvement area: {0}", finding.destinationLabel)));
  routing.appendChild(el("span", "llm-finding-badge", finding.target
    ? l10n.t("Suggested target: {0}", finding.target)
    : l10n.t("Specific target not identified")));
  card.appendChild(routing);

  card.appendChild(el("div", "llm-finding-observed", finding.observed));
  card.appendChild(el("div", "llm-finding-impact", l10n.t("Recorded value: {0}", finding.impactLabel)));
  card.appendChild(el("div", "llm-finding-action", finding.actionLine));

  const evidenceRow = el("div", "llm-finding-evidence");
  evidenceRow.appendChild(el("span", "llm-evidence-label", l10n.t("Evidence:")));
  const chipsBox = el("div", "llm-evidence-chips");
  for (const chip of finding.evidence) {
    chipsBox.appendChild(renderEvidenceChip(chip, evidenceNavigation));
  }
  evidenceRow.appendChild(chipsBox);
  card.appendChild(evidenceRow);

  const actionKind = finding.action.kind;
  const actionLabel = finding.action.label;

  if (actionKind !== "none") {
    const footer = el("div", "llm-finding-footer");
    const actionBtn = document.createElement("button");
    actionBtn.type = "button";
    actionBtn.className = "llm-start-session-btn";
    actionBtn.textContent = actionLabel;
    if (actionKind === "startCurrentFinding") {
      actionBtn.onclick = () => {
        vscode.postMessage({
          type: "startFindingSession",
          tabId,
          findingId: finding.findingId,
          analysisRunId: attached.artifactId,
          semanticHash,
        });
      };
      footer.appendChild(actionBtn);
      footer.appendChild(
        el("span", "llm-start-session-note", l10n.t("Creates a draft in a new tab. It will not run automatically."))
      );
    } else if (actionKind === "prepareHistoricalDraft") {
      actionBtn.onclick = () => {
        vscode.postMessage({
          type: "prepareHistoricalDraft",
          tabId,
          artifactId: attached.artifactId,
          findingId: finding.findingId,
        });
      };
      footer.appendChild(actionBtn);
      footer.appendChild(
        el("span", "llm-start-session-note", l10n.t("Creates a draft based on a past analysis in a new tab. It will not run automatically."))
      );
    }
    card.appendChild(footer);
  }

  return card;
}

function renderAttached(
  container: HTMLElement,
  attached: AttachedView,
  tabId: string,
  semanticHash: string,
  evidenceNavigation?: { has(toolUseId: string): boolean; navigate(toolUseId: string): void }
): void {
  container.dataset.llm = "attached";
  container.dataset.freshness = attached.freshness;
  container.dataset.persistence = attached.persistence;

  const metaBox = el("div", "llm-attached-meta");
  metaBox.appendChild(el("span", "llm-freshness-badge", attached.freshnessLabel));
  metaBox.appendChild(el("span", "llm-generated-at", attached.generatedAtLabel));
  metaBox.appendChild(el("span", "llm-requested-model", attached.requestedModelLabel));
  metaBox.appendChild(el("span", "llm-executed-models", attached.executedModelsLabel));

  const persistBadge = el("span", "llm-persistence-badge", attached.persistenceLabel);
  persistBadge.dataset.artifactId = attached.artifactId;
  persistBadge.dataset.persistence = attached.persistence;
  metaBox.appendChild(persistBadge);

  if (attached.historyOptions.length > 1) {
    const select = document.createElement("select");
    select.className = "llm-history-select";
    for (const opt of attached.historyOptions) {
      const option = document.createElement("option");
      option.value = opt.artifactId;
      option.textContent = opt.label;
      if (opt.artifactId === attached.selectedArtifactId) {
        option.selected = true;
      }
      select.appendChild(option);
    }
    select.onchange = () => {
      vscode.postMessage({
        type: "selectAnalysisArtifact",
        tabId,
        artifactId: select.value,
      });
    };
    metaBox.appendChild(select);
  }

  container.appendChild(metaBox);
  container.appendChild(el("div", "llm-summary", attached.summaryLabel));
  if (attached.inputCoverageLabel) {
    container.appendChild(el("div", "llm-provenance llm-input-coverage", attached.inputCoverageLabel));
  }

  if (attached.emptyStateLabel) {
    container.appendChild(el("div", "llm-none", attached.emptyStateLabel));
    return;
  }

  const cardsContainer = el("div", "llm-finding-cards");
  for (const finding of attached.findings) {
    cardsContainer.appendChild(
      renderFindingCard(finding, attached, tabId, semanticHash, evidenceNavigation)
    );
  }
  container.appendChild(cardsContainer);
}

export function renderLlmActionView(
  container: HTMLElement,
  view: LlmFindingReportView | undefined,
  llmAnalysisEnabled: boolean | undefined,
  tabId: string,
  semanticHash: string,
  evidenceNavigation?: { has(toolUseId: string): boolean; navigate(toolUseId: string): void }
): void {
  container.textContent = "";
  delete container.dataset.llmReason;
  delete container.dataset.freshness;
  delete container.dataset.persistence;
  container.dataset.llmEnabled = llmAnalysisEnabled === undefined ? "unknown" : String(llmAnalysisEnabled);

  const headRow = el("div", "llm-head-row");
  headRow.appendChild(el("span", "llm-head", l10n.t("LLM evaluation (verified findings only)")));
  if (llmAnalysisEnabled !== undefined) {
    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "llm-toggle";
    toggleBtn.setAttribute("role", "switch");
    toggleBtn.setAttribute("aria-checked", String(llmAnalysisEnabled));
    toggleBtn.setAttribute("aria-label", l10n.t("LLM Analysis"));
    toggleBtn.textContent = llmAnalysisEnabled ? l10n.t("LLM Analysis: Enabled") : l10n.t("LLM Analysis: Disabled");
    const onToggle = () => {
      toggleBtn.setAttribute("aria-busy", "true");
      vscode.postMessage({ type: "setLlmAnalysisEnabled", enabled: !llmAnalysisEnabled });
    };
    toggleBtn.onclick = onToggle;
    headRow.appendChild(toggleBtn);
  }
  container.appendChild(headRow);

  if (llmAnalysisEnabled !== undefined) {
    const note = el("div", "llm-state-note", llmAnalysisEnabled ? l10n.t("LLM analysis is enabled.") : l10n.t("LLM analysis is disabled."));
    container.appendChild(note);
  }

  if (view === undefined) {
    container.dataset.llm = "absent";
    container.appendChild(el("span", "llm-none", l10n.t("LLM analysis is not included in this record.")));
    return;
  }
  if (view.state === "disabled") {
    container.dataset.llm = "disabled";
    if (llmAnalysisEnabled === undefined) {
      container.appendChild(
        el("span", "llm-none", l10n.t("LLM analysis is disabled (setting laisora.workLog.llmAnalysis)."))
      );
    }
    return;
  }
  if (view.state === "idle") {
    container.dataset.llm = "idle";
    container.appendChild(el("span", "llm-none", l10n.t("LLM analysis has not been run. Use the button above to run it.")));
    return;
  }
  if (view.state === "running") {
    container.dataset.llm = "running";
    container.appendChild(el("span", "llm-running-banner", l10n.t("Running LLM analysis…")));
    if (view.attached) {
      renderAttached(container, view.attached, tabId, semanticHash, evidenceNavigation);
    }
    return;
  }
  if (view.state === "attemptFailed") {
    container.dataset.llm = "attemptFailed";
    container.dataset.llmReason = view.reason;
    container.appendChild(
      el("span", "llm-none", l10n.t("Could not run LLM analysis — {0}", unavailableText(view.reason) ?? view.reason))
    );
    if (view.attached) {
      renderAttached(container, view.attached, tabId, semanticHash, evidenceNavigation);
    }
    return;
  }
  if (view.state === "attached") {
    renderAttached(container, view.attached, tabId, semanticHash, evidenceNavigation);
    return;
  }
}
