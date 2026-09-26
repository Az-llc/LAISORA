import type {
  AttachedAnalysisView,
  AttachedEvidenceChip,
  AttachedFindingView,
  HistoryOption,
  LlmFindingReportView,
} from "../protocol";
import { vscode } from "./dom";
import * as l10n from "@vscode/l10n";

type AttachedView = AttachedAnalysisView;
type EvidenceNavigation = { has(toolUseId: string): boolean; navigate(toolUseId: string): void };

export interface LlmEntrySlots {
  // 入口の行。切り替えはここへ足し、.llm-run の中には入れない（入口の行はボタンとトークン消費の明示だけ — R-ANL-07）
  row: HTMLElement;
  targets?: { label: string; toolCalls: number };
}

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

function attachedOf(view: LlmFindingReportView | undefined): AttachedView | undefined {
  if (view === undefined || view.state === "disabled" || view.state === "idle") return undefined;
  return view.attached;
}

function renderHistoryText(btn: HTMLElement, opt: HistoryOption): void {
  if (
    opt.generatedAtLabel === undefined ||
    opt.findingsCount === undefined ||
    opt.requestedModel === undefined ||
    opt.requestedEffort === undefined
  ) {
    btn.textContent = opt.label;
    return;
  }
  btn.textContent = l10n.t("{0} · Findings {1} · {2} · effort {3}", opt.generatedAtLabel, opt.findingsCount, opt.requestedModel, opt.requestedEffort);
  if (opt.freshnessLabel !== undefined) {
    btn.appendChild(el("span", "llm-history-freshness", opt.freshnessLabel));
  }
}

function renderHistory(attached: AttachedView | undefined, tabId: string): HTMLElement {
  const list = el("ul", "llm-history");
  list.setAttribute("aria-label", l10n.t("Analysis history"));
  if (attached === undefined) {
    list.appendChild(el("li", "llm-history-empty", l10n.t("No history")));
    return list;
  }
  for (const opt of attached.historyOptions) {
    const item = el("li", "llm-history-item");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "llm-history-btn";
    btn.dataset.artifactId = opt.artifactId;
    renderHistoryText(btn, opt);
    if (opt.artifactId === attached.selectedArtifactId) {
      item.classList.add("llm-history-current");
      btn.setAttribute("aria-current", "true");
    } else {
      btn.onclick = () => {
        vscode.postMessage({ type: "selectAnalysisArtifact", tabId, artifactId: opt.artifactId });
      };
    }
    item.appendChild(btn);
    list.appendChild(item);
  }
  return list;
}

function renderCompletion(
  attached: AttachedView | undefined,
  targets: LlmEntrySlots["targets"]
): HTMLElement {
  const line = el("div", "llm-completion");
  if (attached !== undefined) {
    line.appendChild(el("span", "llm-freshness-badge", attached.freshnessLabel));
    if (
      attached.findingsCount !== undefined &&
      attached.rejectedCount !== undefined &&
      attached.modelsLabel !== undefined &&
      attached.slicesCount !== undefined
    ) {
      line.appendChild(el("span", "llm-completion-findings", l10n.t("Findings {0}", attached.findingsCount)));
      line.appendChild(el("span", "llm-completion-rejected", l10n.t("Rejected {0}", attached.rejectedCount)));
      line.appendChild(el("span", "llm-completion-models", attached.modelsLabel));
      // null は使用量を観測していない。「0k tok」と書かない（R-DSP-11）
      if (typeof attached.tokensLabel === "string") {
        line.appendChild(el("span", "llm-completion-tokens", attached.tokensLabel));
      }
      line.appendChild(el("span", "llm-completion-slices", l10n.t("Slices {0}", attached.slicesCount)));
    } else {
      line.appendChild(el("span", "llm-summary", attached.summaryLabel));
    }
    if (attached.inputCoverageLabel) {
      line.appendChild(el("span", "llm-input-coverage", attached.inputCoverageLabel));
    }
  }
  if (targets !== undefined) {
    const targetsEl = el("span", "llm-run-targets", targets.label);
    targetsEl.dataset.toolCalls = String(targets.toolCalls);
    line.appendChild(targetsEl);
  }
  if (attached !== undefined) {
    const persistBadge = el("span", "llm-persistence-badge", attached.persistenceLabel);
    persistBadge.dataset.artifactId = attached.artifactId;
    persistBadge.dataset.persistence = attached.persistence;
    line.appendChild(persistBadge);
  }
  return line;
}

function renderEvidenceChip(chip: AttachedEvidenceChip, evidenceNavigation?: EvidenceNavigation): HTMLElement {
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
  evidenceNavigation?: EvidenceNavigation
): HTMLElement {
  const card = el("article", "llm-finding-card");
  card.dataset.findingId = finding.findingId;
  card.dataset.confidence = finding.confidence;

  if (finding.numberDigits !== undefined) {
    card.setAttribute("aria-label", finding.numberLabel);
    const digits = el("div", "llm-finding-num llm-finding-digits", finding.numberDigits);
    digits.setAttribute("aria-hidden", "true");
    card.appendChild(digits);
  } else {
    card.appendChild(el("div", "llm-finding-num", finding.numberLabel));
  }

  const body = el("div", "llm-finding-body");
  body.appendChild(el("div", "llm-finding-title", finding.title));
  body.appendChild(el("p", "llm-finding-observed", finding.observed));
  body.appendChild(el("p", "llm-finding-action", finding.actionLine));

  const actionKind = finding.action.kind;
  if (actionKind !== "none") {
    const footer = el("div", "llm-finding-footer");
    const actionBtn = document.createElement("button");
    actionBtn.type = "button";
    actionBtn.className = "llm-start-session-btn";
    actionBtn.textContent = finding.action.label;
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
    body.appendChild(footer);
  }
  card.appendChild(body);

  const margin = el("aside", "llm-finding-margin");
  margin.appendChild(el("div", "llm-finding-impact", finding.impactLabel));
  margin.appendChild(el("div", "llm-finding-impact-caption", l10n.t("Recorded value")));
  margin.appendChild(el("div", "llm-finding-destination", l10n.t("Improvement area: {0}", finding.destinationLabel)));
  margin.appendChild(el("div", "llm-finding-target", finding.target
    ? l10n.t("Suggested target: {0}", finding.target)
    : l10n.t("Specific target not identified")));
  const evidenceRow = el("div", "llm-finding-evidence");
  evidenceRow.appendChild(el("span", "llm-evidence-label", l10n.t("Evidence:")));
  for (const chip of finding.evidence) {
    evidenceRow.appendChild(renderEvidenceChip(chip, evidenceNavigation));
  }
  margin.appendChild(evidenceRow);
  card.appendChild(margin);

  return card;
}

function renderFindings(
  container: HTMLElement,
  attached: AttachedView,
  tabId: string,
  semanticHash: string,
  evidenceNavigation?: EvidenceNavigation
): void {
  container.dataset.llm = "attached";
  container.dataset.freshness = attached.freshness;
  container.dataset.persistence = attached.persistence;

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
  evidenceNavigation?: EvidenceNavigation,
  entry?: LlmEntrySlots
): void {
  container.textContent = "";
  delete container.dataset.llmReason;
  delete container.dataset.freshness;
  delete container.dataset.persistence;
  container.dataset.llmEnabled = llmAnalysisEnabled === undefined ? "unknown" : String(llmAnalysisEnabled);

  if (llmAnalysisEnabled !== undefined) {
    const toggleBtn = document.createElement("button");
    toggleBtn.type = "button";
    toggleBtn.className = "llm-toggle";
    toggleBtn.setAttribute("role", "switch");
    toggleBtn.setAttribute("aria-checked", String(llmAnalysisEnabled));
    toggleBtn.setAttribute("aria-label", l10n.t("LLM Analysis"));
    toggleBtn.textContent = llmAnalysisEnabled ? l10n.t("LLM Analysis: Enabled") : l10n.t("LLM Analysis: Disabled");
    toggleBtn.onclick = () => {
      toggleBtn.setAttribute("aria-busy", "true");
      vscode.postMessage({ type: "setLlmAnalysisEnabled", enabled: !llmAnalysisEnabled });
    };
    (entry?.row ?? container).appendChild(toggleBtn);
  }

  const attached = attachedOf(view);
  // disabled / 不在では保存済みの結果が見えていないだけなので「履歴なし」と言わない（R-DSP-01）
  if (view !== undefined && view.state !== "disabled") {
    container.appendChild(renderHistory(attached, tabId));
  }
  if (attached !== undefined || entry?.targets !== undefined) {
    container.appendChild(renderCompletion(attached, entry?.targets));
  }

  container.appendChild(el("div", "llm-head", l10n.t("LLM evaluation (verified findings only)")));

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
      renderFindings(container, view.attached, tabId, semanticHash, evidenceNavigation);
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
      renderFindings(container, view.attached, tabId, semanticHash, evidenceNavigation);
    }
    return;
  }
  if (view.state === "attached") {
    renderFindings(container, view.attached, tabId, semanticHash, evidenceNavigation);
    return;
  }
}
