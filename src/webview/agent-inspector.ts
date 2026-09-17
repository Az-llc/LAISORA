import * as l10n from "@vscode/l10n";
import type {
  AgentInspectorErrorReason,
  AgentInspectorPage,
  AgentInspectorSection,
  AgentInspectorTruncatedReason,
  HostToWebview,
} from "../protocol";
import { formatDateTime, formatDuration, uiLocale } from "./format";
import { vscode } from "./dom";
import { termSpan, type TermKey } from "./term";

// インスペクターは独立タブではなくグラフの行から開くポップアップ。
// UI のタブ 5 枚は protocol の 4 section（overview / tools / messages / report）を描き分けたもの。
// 「思考」タブを作らない。thinking ブロックは実在するが 209 件すべて 0 字で、生の思考は API から返らない（R-DSP-10）。
// 使えるツール（権限）を出さない。availableTools / allowedTools / systemPrompt は記録に 0 件で、
// 権限は agent 定義ファイル側にある（R-DSP-11）
type UiTabId = "basic" | "instruction" | "report" | "messages" | "tools" | "request";

interface UiTab {
  id: UiTabId;
  label: string;
  section?: AgentInspectorSection;
}

const TRUNCATED_REASON_TEXT: Record<AgentInspectorTruncatedReason, string> = {
  "read-limit": l10n.t("Read limit"),
  "record-limit": l10n.t("Record limit"),
  "malformed-record": l10n.t("Some records could not be read"),
  "meta-limit": l10n.t("Auxiliary data size limit"),
  "preview-limit": l10n.t("Long items truncated"),
  "response-limit": l10n.t("Response limit"),
};

const AGENT_TABS: readonly UiTab[] = [
  { id: "basic", label: l10n.t("Basic info"), section: "overview" },
  { id: "instruction", label: l10n.t("Instruction"), section: "overview" },
  { id: "report", label: l10n.t("Report"), section: "report" },
  { id: "messages", label: l10n.t("Intermediate replies"), section: "messages" },
  { id: "tools", label: l10n.t("Tool execution"), section: "tools" },
];
// 依頼ブロックの 応答内容 / ツール実行 は親 transcript を読む Host API が無い（NEEDED-WIRING）。
// 中身の無いタブは置かない: 押しても何も起きない印は意味を持たない（R-DSP-10）
const BLOCK_TABS: readonly UiTab[] = [
  { id: "basic", label: l10n.t("Basic info") },
  { id: "request", label: l10n.t("Request") },
];

// 指示は所要時間より下。長文を先頭に置くと種別・モデル・所要時間が画面外へ出る（R-DSP-22）
// term を持つ項目は termSpan(term.ts のキー) で注記付きに描く。label だけの項目は翻訳済み文字列をそのまま出す
type BasicFieldId = "type" | "model" | "effort" | "started" | "ended" | "elapsed" | "tools" | "failures" | "isolated";
const BASIC_FIELDS: readonly ({ id: BasicFieldId } & ({ label: string } | { term: TermKey }))[] = [
  { id: "type", label: l10n.t("Type") },
  { id: "model", label: l10n.t("Model") },
  { id: "effort", term: "effort" },
  { id: "started", label: l10n.t("Started") },
  { id: "ended", label: l10n.t("Ended") },
  { id: "elapsed", label: l10n.t("Elapsed time") },
  { id: "tools", label: l10n.t("Tools run") },
  { id: "failures", label: l10n.t("Failures") },
  { id: "isolated", term: "Isolated run" },
];

const ERROR_LABELS: Record<AgentInspectorErrorReason, string> = {
  "session-unavailable": l10n.t("The session log is not available yet."),
  "session-scan-failed": l10n.t("Could not determine whether the session log exists (scanning the storage location failed). Retry after sync or locks are released."),
  "agent-unavailable": l10n.t("Could not locate this subagent's history."),
  "transcript-unavailable": l10n.t("Could not read this subagent's conversation history."),
  "invalid-cursor": l10n.t("The history was updated. Reload from the beginning."),
  "stale-request": l10n.t("The target changed, so the stale response was discarded."),
  "read-failed": l10n.t("Failed to read the history."),
  "response-too-large": l10n.t("The display data exceeded the limit."),
  "meta-limit": l10n.t("Could not locate this subagent's history because the auxiliary data reached its size limit."),
};

export interface InspectorAxis {
  windowStart: number;
  windowEnd: number;
  start: number;
  end: number;
}

export type InspectorTarget =
  | {
      kind: "agent";
      agentId: string;
      label: string;
      meta?: string;
      axis?: InspectorAxis;
      stats?: { toolCount: number; failCount: number };
    }
  | {
      kind: "block";
      label: string;
      meta?: string;
      axis?: InspectorAxis;
      text: string;
      rows: [TermKey | Node, string][];
    };

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  return node;
}

function clock(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}:${String(d.getSeconds()).padStart(2, "0")}`;
}

export class AgentInspector {
  readonly rootEl: HTMLElement;
  private readonly popEl: HTMLElement;
  private readonly kindEl: HTMLElement;
  private readonly titleEl: HTMLElement;
  private readonly metaEl: HTMLElement;
  private readonly maxEl: HTMLButtonElement;
  private readonly closeEl: HTMLButtonElement;
  private readonly axisEl: HTMLElement;
  private readonly statusEl: HTMLElement;
  private readonly navEl: HTMLElement;
  private readonly contentEl: HTMLElement;
  private readonly coverageEl: HTMLElement;
  private readonly retryEl: HTMLButtonElement;
  private tabButtons = new Map<UiTabId, HTMLButtonElement>();
  private readonly pages = new Map<AgentInspectorSection, AgentInspectorPage>();
  private target: InspectorTarget | undefined;
  // 開いた行は再描画で要素が入れ替わるので、要素ではなく引き当て関数を持つ
  private opener: (() => HTMLElement | undefined) | undefined;
  private activeTab: UiTabId = "basic";
  private visible = false;
  private serial = 0;
  private pending: { requestId: string; agentId: string; section: AgentInspectorSection } | undefined;
  private lastError: AgentInspectorErrorReason | undefined;
  private retryCursor: string | undefined;

  constructor(private readonly tabId: string, private readonly onClose?: () => void) {
    this.rootEl = element("section", "work-inspector");
    this.rootEl.id = `wi-panel-${tabId}`;
    this.rootEl.hidden = true;

    const scrim = element("div", "wi-scrim");
    scrim.addEventListener("click", () => this.close());
    this.popEl = element("div", "wi-pop");
    this.popEl.setAttribute("role", "dialog");
    this.popEl.setAttribute("aria-modal", "true");
    this.popEl.setAttribute("aria-labelledby", `wi-title-${tabId}`);
    this.popEl.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    });

    const head = element("div", "wi-head");
    this.kindEl = element("span", "wi-kind");
    this.titleEl = element("h3", "wi-title");
    this.titleEl.id = `wi-title-${tabId}`;
    this.metaEl = element("span", "wi-meta");
    this.maxEl = element("button", "wi-max") as HTMLButtonElement;
    this.maxEl.type = "button";
    this.maxEl.textContent = "⤢";
    this.maxEl.title = l10n.t("Maximize / restore");
    this.maxEl.setAttribute("aria-label", l10n.t("Maximize / restore"));
    this.maxEl.onclick = () => this.popEl.classList.toggle("max");
    this.closeEl = element("button", "wi-close") as HTMLButtonElement;
    this.closeEl.type = "button";
    this.closeEl.textContent = l10n.t("Close");
    this.closeEl.onclick = () => this.close();
    head.append(this.kindEl, this.titleEl, this.metaEl, this.maxEl, this.closeEl);

    this.axisEl = element("div", "wi-axis");
    this.statusEl = element("div", "wi-status");
    this.statusEl.setAttribute("role", "status");
    this.statusEl.setAttribute("aria-live", "polite");
    this.statusEl.setAttribute("aria-atomic", "true");
    this.navEl = element("nav", "wi-sections");
    this.navEl.setAttribute("role", "tablist");
    this.navEl.setAttribute("aria-label", l10n.t("Inspector sections"));
    const body = element("div", "wi-body");
    this.contentEl = element("div", "wi-content");
    this.coverageEl = element("div", "wi-coverage");
    this.retryEl = element("button", "wi-retry") as HTMLButtonElement;
    this.retryEl.type = "button";
    this.retryEl.textContent = l10n.t("Retry");
    this.retryEl.hidden = true;
    this.retryEl.onclick = () => {
      if (this.pending) return;
      this.request(this.retryCursor);
    };
    body.append(this.contentEl, this.coverageEl, this.retryEl);
    this.popEl.append(head, this.axisEl, this.statusEl, this.navEl, body);
    this.rootEl.append(scrim, this.popEl);
  }

  isOpen(): boolean {
    return this.visible;
  }

  open(target: InspectorTarget, opener?: () => HTMLElement | undefined): void {
    const sameAgent =
      target.kind === "agent" && this.target?.kind === "agent" && this.target.agentId === target.agentId;
    this.target = target;
    this.opener = opener;
    if (!sameAgent) {
      this.pages.clear();
      this.pending = undefined;
      this.lastError = undefined;
      this.retryCursor = undefined;
      this.activeTab = "basic";
    }
    this.visible = true;
    this.rootEl.hidden = false;
    this.popEl.classList.remove("max");
    this.buildTabs();
    this.render();
    this.closeEl.focus();
    if (target.kind === "agent") this.requestIfNeeded();
  }

  close(): void {
    if (!this.visible) return;
    this.visible = false;
    this.rootEl.hidden = true;
    const openerEl = this.opener?.();
    this.opener = undefined;
    this.onClose?.();
    if (openerEl !== undefined && openerEl.isConnected) openerEl.focus();
  }

  handleResult(message: Extract<HostToWebview, { type: "agentInspectorResult" }>): void {
    if (!this.pending || message.requestId !== this.pending.requestId ||
        message.agentId !== this.pending.agentId || message.page.section !== this.pending.section) return;
    const previous = this.pages.get(message.page.section);
    const merged = mergePage(previous, message.page);
    this.pages.set(message.page.section, merged);
    this.pending = undefined;
    this.lastError = undefined;
    this.retryCursor = undefined;
    this.render();
    // 各タブの中身は全文。「続きを読み込む」を押させず、続きがある限り自動で取り寄せる
    if (merged.nextCursor !== undefined && this.visible && this.activeSection() === merged.section) {
      this.request(merged.nextCursor);
    }
  }

  handleError(message: Extract<HostToWebview, { type: "agentInspectorError" }>): void {
    if (!this.pending || message.requestId !== this.pending.requestId || message.agentId !== this.pending.agentId) return;
    const failedSection = this.pending.section;
    this.pending = undefined;
    this.lastError = message.reason;
    if (message.reason === "invalid-cursor" || message.reason === "response-too-large") {
      this.pages.delete(failedSection);
      this.retryCursor = undefined;
    }
    this.render();
  }

  private tabs(): readonly UiTab[] {
    return this.target?.kind === "block" ? BLOCK_TABS : AGENT_TABS;
  }

  private activeSection(): AgentInspectorSection | undefined {
    return this.tabs().find((t) => t.id === this.activeTab)?.section;
  }

  private buildTabs(): void {
    this.navEl.textContent = "";
    this.tabButtons = new Map();
    for (const tab of this.tabs()) {
      const button = element("button", "wi-section-button") as HTMLButtonElement;
      button.type = "button";
      button.setAttribute("role", "tab");
      button.dataset.tab = tab.id;
      const name = element("span", "wi-section-name");
      name.textContent = tab.label;
      const count = element("span", "wi-cnt");
      button.append(name, count);
      button.onclick = () => this.setTab(tab.id);
      this.tabButtons.set(tab.id, button);
      this.navEl.appendChild(button);
    }
  }

  private setTab(tab: UiTabId): void {
    this.activeTab = tab;
    this.lastError = undefined;
    this.render();
    this.requestIfNeeded();
  }

  private requestIfNeeded(): void {
    const section = this.activeSection();
    if (!this.visible || section === undefined || this.target?.kind !== "agent") return;
    if (this.pages.has(section) || this.pending) return;
    this.request();
  }

  private request(cursor?: string): void {
    const section = this.activeSection();
    if (!this.visible || this.target?.kind !== "agent" || section === undefined) return;
    const requestId = `${this.tabId}:inspector:${++this.serial}`;
    this.pending = { requestId, agentId: this.target.agentId, section };
    this.lastError = undefined;
    this.retryCursor = cursor;
    this.render();
    vscode.postMessage({
      type: "agentInspectorRequest",
      tabId: this.tabId,
      agentId: this.target.agentId,
      section,
      requestId,
      cursor,
    });
  }

  private render(): void {
    const target = this.target;
    if (target === undefined) return;
    this.kindEl.textContent = target.kind === "agent" ? l10n.t("Subagent") : l10n.t("Request block");
    this.kindEl.dataset.kind = target.kind;
    this.titleEl.textContent = target.label;
    this.metaEl.textContent = target.meta ?? "";
    this.renderAxis(target.axis);
    for (const tab of this.tabs()) {
      const button = this.tabButtons.get(tab.id);
      if (button === undefined) continue;
      const active = tab.id === this.activeTab;
      button.classList.toggle("active", active);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
      const cnt = button.querySelector<HTMLElement>(".wi-cnt");
      if (cnt) cnt.textContent = this.countLabel(tab);
    }
    const busy = this.pending !== undefined;
    this.popEl.setAttribute("aria-busy", String(busy));
    this.retryEl.setAttribute("aria-disabled", String(busy));
    this.statusEl.textContent = busy ? l10n.t("Loading history…") :
      this.lastError ? ERROR_LABELS[this.lastError] : "";
    this.retryEl.hidden = this.lastError === undefined;
    this.contentEl.textContent = "";
    this.coverageEl.textContent = "";
    if (target.kind === "block") {
      this.renderBlock(target);
      return;
    }
    const section = this.activeSection();
    const page = section !== undefined ? this.pages.get(section) : undefined;
    if (!page) {
      if (!busy && !this.lastError) this.contentEl.appendChild(textBlock("wi-empty", l10n.t("No history to show.")));
      return;
    }
    this.renderPage(page, target);
    const coverage = page.coverage;
    this.coverageEl.dataset.state = coverage.state;
    this.coverageEl.textContent = coverage.state === "complete"
      ? l10n.t("Fetched {0} records", coverage.returnedRecords)
      : l10n.t("Partial · {0} records", coverage.returnedRecords) +
        (coverage.truncatedReasons.length > 0 ? ` · ${coverage.truncatedReasons.map((r) => TRUNCATED_REASON_TEXT[r]).join(" · ")}` : "");
  }

  private countLabel(tab: UiTab): string {
    const target = this.target;
    const chars = (n: number) => l10n.t("{0} chars", n.toLocaleString(uiLocale()));
    if (target?.kind === "block") return tab.id === "request" ? chars(target.text.length) : "";
    const page = tab.section !== undefined ? this.pages.get(tab.section) : undefined;
    if (page === undefined) return "";
    if (tab.id === "instruction" && page.section === "overview") return chars(page.overview.instruction.length);
    if (tab.id === "report" && page.section === "report") return chars(page.text.length);
    if (tab.id === "messages" && page.section === "messages") return l10n.t("{0} items", intermediateReplies(page).length);
    if (tab.id === "tools" && page.section === "tools") return l10n.t("{0} items", page.tools.length);
    return "";
  }

  private renderAxis(axis: InspectorAxis | undefined): void {
    this.axisEl.textContent = "";
    if (axis === undefined || axis.windowEnd <= axis.windowStart) return;
    const span = axis.windowEnd - axis.windowStart;
    const x = (t: number) => (Math.max(axis.windowStart, Math.min(axis.windowEnd, t)) - axis.windowStart) / span * 100;
    const startEl = element("span", "wi-axis-c");
    startEl.textContent = clock(axis.windowStart);
    const track = element("div", "wi-axis-t");
    const me = element("div", "wi-axis-me");
    me.style.left = `${x(axis.start)}%`;
    me.style.width = `${Math.max(1, x(axis.end) - x(axis.start))}%`;
    track.appendChild(me);
    const endEl = element("span", "wi-axis-c");
    endEl.textContent = clock(axis.windowEnd);
    const range = element("span", "wi-axis-w");
    range.textContent = `${clock(axis.start)} – ${clock(axis.end)}`;
    this.axisEl.append(startEl, track, endEl, range);
  }

  private renderBlock(target: Extract<InspectorTarget, { kind: "block" }>): void {
    if (this.activeTab === "request") {
      this.contentEl.appendChild(pre("wi-report", target.text));
      return;
    }
    const list = element("dl", "wi-overview");
    for (const [term, value] of target.rows) addDefinition(list, term, value);
    this.contentEl.appendChild(list);
  }

  private renderPage(page: AgentInspectorPage, target: Extract<InspectorTarget, { kind: "agent" }>): void {
    if (page.section === "overview") {
      if (this.activeTab === "instruction") {
        this.contentEl.appendChild(page.overview.instruction ? pre("wi-report", page.overview.instruction) : textBlock("wi-empty", l10n.t("No instruction was recorded.")));
        return;
      }
      const list = element("dl", "wi-overview");
      const tools = this.pages.get("tools");
      const values: Record<BasicFieldId, string | undefined> = {
        type: page.overview.agentType,
        model: page.overview.modelMeasured,
        effort: page.overview.effortMeasured,
        started: formatDateTime(page.overview.startedAt ?? null),
        ended: formatDateTime(page.overview.endedAt ?? null),
        elapsed: formatDuration(page.overview.elapsedMs ?? 0),
        tools: target.stats !== undefined ? l10n.t("{0} times", target.stats.toolCount) :
          tools?.section === "tools" && tools.nextCursor === undefined ? l10n.t("{0} times", tools.tools.length) : undefined,
        failures: target.stats !== undefined ? l10n.t("{0} items", target.stats.failCount) : undefined,
        isolated: page.overview.spawnedWithWorktree === undefined ? undefined : page.overview.spawnedWithWorktree ? l10n.t("Yes") : l10n.t("No"),
      };
      for (const field of BASIC_FIELDS) {
        const value = values[field.id];
        if (value === undefined) continue;
        addDefinition(list, "term" in field ? field.term : document.createTextNode(field.label), value);
      }
      if (page.overview.worktreeBranch) addDefinition(list, document.createTextNode("worktree branch"), page.overview.worktreeBranch);
      this.contentEl.appendChild(list);
      return;
    }
    if (page.section === "tools") {
      if (page.tools.length === 0) this.contentEl.appendChild(textBlock("wi-empty", l10n.t("No tool executions were recorded.")));
      for (const tool of page.tools) {
        const card = element("article", "wi-tool");
        const title = element("h4", "wi-tool-title");
        title.textContent = tool.isError ? l10n.t("{0} (failed)", tool.toolName) : tool.toolName;
        card.appendChild(title);
        if (tool.inputSummary) card.appendChild(textBlock("wi-tool-summary", tool.inputSummary));
        card.appendChild(pre("wi-preview", tool.inputPreview));
        if (tool.resultPreview) card.appendChild(pre("wi-result", tool.resultPreview));
        this.contentEl.appendChild(card);
      }
      return;
    }
    if (page.section === "messages") {
      const replies = intermediateReplies(page);
      if (replies.length === 0) this.contentEl.appendChild(textBlock("wi-empty", l10n.t("No intermediate replies were recorded.")));
      for (const message of replies) {
        const card = element("article", "wi-message wi-message-assistant");
        card.appendChild(pre("wi-message-text", message.text));
        this.contentEl.appendChild(card);
      }
      return;
    }
    this.contentEl.appendChild(page.text ? pre("wi-report", page.text) : textBlock("wi-empty", l10n.t("No report was recorded.")));
  }
}

// 途中の応答 = assistant の本文のうち最後以外（最後は報告内容として別タブ）
function intermediateReplies(page: Extract<AgentInspectorPage, { section: "messages" }>): { text: string }[] {
  const assistant = page.messages.filter((m) => m.role === "assistant");
  return page.nextCursor === undefined ? assistant.slice(0, -1) : assistant;
}

function mergePage(previous: AgentInspectorPage | undefined, next: AgentInspectorPage): AgentInspectorPage {
  if (!previous || previous.section !== next.section) return next;
  if (next.section === "tools" && previous.section === "tools") {
    return { ...next, tools: [...previous.tools, ...next.tools], coverage: mergeCoverage(previous, next) };
  }
  if (next.section === "messages" && previous.section === "messages") {
    return { ...next, messages: [...previous.messages, ...next.messages], coverage: mergeCoverage(previous, next) };
  }
  if (next.section === "report" && previous.section === "report") {
    return { ...next, text: previous.text + next.text, coverage: mergeCoverage(previous, next) };
  }
  return next;
}

function mergeCoverage(previous: AgentInspectorPage, next: AgentInspectorPage): AgentInspectorPage["coverage"] {
  let truncatedReasons = [...new Set([
    ...previous.coverage.truncatedReasons,
    ...next.coverage.truncatedReasons,
  ])];
  if (next.nextCursor === undefined) {
    truncatedReasons = truncatedReasons.filter((reason) => reason !== "response-limit");
  }
  return {
    ...next.coverage,
    state: truncatedReasons.length === 0 ? "complete" : "partial",
    returnedRecords: previous.coverage.returnedRecords + next.coverage.returnedRecords,
    bytesRead: Math.max(previous.coverage.bytesRead, next.coverage.bytesRead),
    fileSize: Math.max(previous.coverage.fileSize, next.coverage.fileSize),
    malformedRecordCount: Math.max(
      previous.coverage.malformedRecordCount,
      next.coverage.malformedRecordCount
    ),
    skippedRecordCount: Math.max(previous.coverage.skippedRecordCount, next.coverage.skippedRecordCount),
    previewTruncatedCount:
      (previous.coverage.previewTruncatedCount ?? 0) + (next.coverage.previewTruncatedCount ?? 0) || undefined,
    truncatedReasons,
  };
}

function textBlock(className: string, text: string): HTMLElement {
  const node = element("div", className);
  node.textContent = text;
  return node;
}

function pre(className: string, text: string): HTMLElement {
  const node = element("pre", className);
  node.textContent = text;
  return node;
}

// 文字列は term.ts のキーとして termSpan へ通す（注記が付く）。翻訳済みの見出しは Node で渡す
function addDefinition(list: HTMLElement, term: TermKey | Node, value: string): void {
  const dt = document.createElement("dt");
  dt.appendChild(typeof term === "string" ? termSpan(term) : term);
  const dd = document.createElement("dd");
  dd.textContent = value;
  list.append(dt, dd);
}
