import * as l10n from "@vscode/l10n";
import type {
  AgentInspectorCoverage,
  AgentInspectorErrorReason,
  AgentInspectorMessageItem,
  AgentInspectorPage,
  AgentInspectorSection,
  AgentInspectorTruncatedReason,
  HostToWebview,
} from "../protocol";
import { formatDuration } from "./format";
import { formatDateTime, uiLocale } from "./l10n";
import { vscode } from "./dom";
import { failureCount } from "./failure-count";
import { createLoader } from "./loader";
import { termSpan, type TermKey } from "./term";

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
const BLOCK_TABS: readonly UiTab[] = [
  { id: "basic", label: l10n.t("Basic info") },
  { id: "request", label: l10n.t("Request") },
];

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
      rows: [TermKey | Node, string | Node][];
    };

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
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
  private readonly bodyEl: HTMLElement;
  private readonly contentEl: HTMLElement;
  private readonly coverageEl: HTMLElement;
  private readonly retryEl: HTMLButtonElement;
  private tabButtons = new Map<UiTabId, HTMLButtonElement>();
  private readonly pages = new Map<AgentInspectorSection, AgentInspectorPage>();
  private readonly toolOpen = new Map<string, boolean>();
  private target: InspectorTarget | undefined;
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

    const head = element("header", "wi-head");
    const line = element("div", "wi-head-line");
    this.kindEl = element("span", "wi-code");
    const actions = element("div", "wi-actions");
    this.maxEl = element("button", "wi-act wi-max");
    this.maxEl.type = "button";
    this.maxEl.title = l10n.t("Maximize / restore");
    this.maxEl.setAttribute("aria-label", l10n.t("Maximize / restore"));
    this.maxEl.append(element("span", "wi-max-icon"));
    this.maxEl.onclick = () => this.setMaximized(!this.popEl.classList.contains("max"));
    this.closeEl = element("button", "wi-act wi-close");
    this.closeEl.type = "button";
    this.closeEl.setAttribute("aria-keyshortcuts", "Escape");
    this.closeEl.append(l10n.t("Close"), element("kbd", "", "Esc"));
    this.closeEl.onclick = () => this.close();
    actions.append(this.maxEl, this.closeEl);
    line.append(this.kindEl, actions);
    this.titleEl = element("h3", "wi-title");
    this.titleEl.id = `wi-title-${tabId}`;
    this.metaEl = element("p", "wi-meta");
    this.axisEl = element("div", "wi-axis");
    head.append(line, this.titleEl, this.metaEl, this.axisEl);

    this.navEl = element("nav", "wi-sections");
    this.navEl.setAttribute("role", "tablist");
    this.navEl.setAttribute("aria-label", l10n.t("Inspector sections"));

    this.bodyEl = element("div", "wi-body");
    this.bodyEl.id = `wi-body-${tabId}`;
    this.bodyEl.setAttribute("role", "tabpanel");
    const state = element("div", "wi-state");
    this.statusEl = element("div", "wi-status");
    this.statusEl.setAttribute("role", "status");
    this.statusEl.setAttribute("aria-live", "polite");
    this.statusEl.setAttribute("aria-atomic", "true");
    this.retryEl = element("button", "wi-retry", l10n.t("Retry"));
    this.retryEl.type = "button";
    this.retryEl.hidden = true;
    this.retryEl.onclick = () => {
      if (this.pending) return;
      this.request(this.retryCursor);
    };
    state.append(this.statusEl, this.retryEl);
    this.contentEl = element("div", "wi-content");
    this.bodyEl.append(state, this.contentEl);
    this.coverageEl = element("footer", "wi-coverage");
    this.popEl.append(head, this.navEl, this.bodyEl, this.coverageEl);
    this.rootEl.append(scrim, this.popEl);
    this.setMaximized(false);
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
      this.toolOpen.clear();
      this.pending = undefined;
      this.lastError = undefined;
      this.retryCursor = undefined;
      this.activeTab = "basic";
    }
    this.visible = true;
    this.rootEl.hidden = false;
    this.setMaximized(false);
    this.renderHead(target);
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

  private setMaximized(maximized: boolean): void {
    this.popEl.classList.toggle("max", maximized);
    this.maxEl.setAttribute("aria-pressed", String(maximized));
  }

  private buildTabs(): void {
    this.navEl.textContent = "";
    this.tabButtons = new Map();
    for (const tab of this.tabs()) {
      const button = element("button", "wi-tab");
      button.type = "button";
      button.id = `wi-tab-${tab.id}-${this.tabId}`;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-controls", this.bodyEl.id);
      button.dataset.tab = tab.id;
      button.append(element("span", "wi-section-name", tab.label), element("span", "wi-cnt"));
      button.onclick = () => this.setTab(tab.id);
      button.addEventListener("keydown", (e) => this.onTabKey(e, tab.id));
      this.tabButtons.set(tab.id, button);
      this.navEl.appendChild(button);
    }
  }

  private onTabKey(e: KeyboardEvent, from: UiTabId): void {
    const tabs = this.tabs();
    const at = tabs.findIndex((t) => t.id === from);
    const next = e.key === "ArrowRight" ? (at + 1) % tabs.length
      : e.key === "ArrowLeft" ? (at + tabs.length - 1) % tabs.length
      : e.key === "Home" ? 0
      : e.key === "End" ? tabs.length - 1
      : -1;
    if (next < 0) return;
    e.preventDefault();
    this.setTab(tabs[next].id, true);
  }

  private setTab(tab: UiTabId, moveFocus = false): void {
    this.activeTab = tab;
    this.lastError = undefined;
    this.render();
    if (moveFocus) this.tabButtons.get(tab)?.focus();
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
    for (const tab of this.tabs()) {
      const button = this.tabButtons.get(tab.id);
      if (button === undefined) continue;
      const active = tab.id === this.activeTab;
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
      if (active) this.bodyEl.setAttribute("aria-labelledby", button.id);
      const cnt = button.querySelector<HTMLElement>(".wi-cnt");
      if (cnt) cnt.textContent = this.countLabel(tab);
    }
    const busy = this.pending !== undefined;
    this.popEl.setAttribute("aria-busy", String(busy));
    this.renderStatus(busy);
    const focused = document.activeElement;
    const focusKey = focused instanceof HTMLElement && this.contentEl.contains(focused) ? focused.dataset.focusKey ?? "" : undefined;
    this.contentEl.textContent = "";
    this.coverageEl.textContent = "";
    delete this.coverageEl.dataset.state;
    this.renderContent(target, busy);
    if (focusKey === undefined) return;
    const restored = Array.from(this.contentEl.querySelectorAll<HTMLElement>("[data-focus-key]")).find((el) => el.dataset.focusKey === focusKey);
    (restored ?? this.closeEl).focus({ preventScroll: true });
  }

  private renderContent(target: InspectorTarget, busy: boolean): void {
    if (target.kind === "block") {
      this.renderBlock(target);
      return;
    }
    const section = this.activeSection();
    const page = section !== undefined ? this.pages.get(section) : undefined;
    if (!page) {
      if (!busy && !this.lastError) this.contentEl.appendChild(element("p", "wi-empty", l10n.t("No history to show.")));
      return;
    }
    this.renderPage(page, target);
    this.renderCoverage(page.coverage);
  }

  private renderHead(target: InspectorTarget): void {
    this.kindEl.replaceChildren(
      element("b", "", target.kind === "agent" ? "SUBAGENT" : "REQUEST"),
      termSpan(target.kind === "agent" ? "Subagent" : "Request block")
    );
    this.titleEl.textContent = target.label;
    this.metaEl.textContent = target.meta ?? "";
    this.metaEl.hidden = !target.meta;
    this.renderAxis(target.axis);
  }

  private renderStatus(busy: boolean): void {
    this.statusEl.textContent = "";
    this.statusEl.classList.toggle("error", !busy && this.lastError !== undefined);
    if (busy) {
      this.statusEl.append(createLoader(12), element("span", "wi-status-text", l10n.t("Loading history…")));
    } else if (this.lastError !== undefined) {
      this.statusEl.append(element("span", "wi-x", "✗"), " ", element("span", "wi-status-text", ERROR_LABELS[this.lastError]));
    }
    this.retryEl.hidden = this.lastError === undefined;
    this.retryEl.setAttribute("aria-disabled", String(busy));
  }

  private renderCoverage(coverage: AgentInspectorCoverage): void {
    this.coverageEl.dataset.state = coverage.state;
    const code = element("span", "wi-code");
    code.append(element("b", "", "COV"));
    const complete = coverage.state === "complete";
    const count = l10n.t("{0} items", coverage.returnedRecords);
    const reasons = coverage.truncatedReasons.map((r) => ` · ${TRUNCATED_REASON_TEXT[r]}`).join("");
    this.coverageEl.append(
      code,
      element("span", "wi-cov-state", complete ? l10n.t("Fetched") : l10n.t("Partial")),
      complete ? ` ${count}` : ` · ${count}${reasons}`
    );
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
    this.axisEl.hidden = axis === undefined || axis.windowEnd <= axis.windowStart;
    if (axis === undefined || axis.windowEnd <= axis.windowStart) return;
    const span = axis.windowEnd - axis.windowStart;
    const x = (t: number) => (Math.max(axis.windowStart, Math.min(axis.windowEnd, t)) - axis.windowStart) / span * 100;
    const line = element("div", "wi-axis-line");
    const code = element("span", "wi-code");
    code.append(element("b", "", "SPAN"), element("span", "", l10n.t("Position within the graph's visible range")));
    line.append(code, element("span", "wi-axis-w", `${clock(axis.start)} – ${clock(axis.end)}`));
    const row = element("div", "wi-axis-row");
    const track = element("div", "wi-axis-t");
    const me = element("div", "wi-axis-me");
    me.style.left = `${x(axis.start)}%`;
    me.style.width = `${Math.max(1, x(axis.end) - x(axis.start))}%`;
    track.appendChild(me);
    row.append(element("span", "wi-axis-c", clock(axis.windowStart)), track, element("span", "wi-axis-c", clock(axis.windowEnd)));
    this.axisEl.append(line, row);
  }

  private renderBlock(target: Extract<InspectorTarget, { kind: "block" }>): void {
    if (this.activeTab === "request") {
      this.contentEl.appendChild(pre("wi-text", target.text));
      return;
    }
    const list = element("dl", "wi-overview");
    for (const [term, value] of target.rows) addDefinition(list, term, value);
    this.contentEl.appendChild(list);
  }

  private failuresValue(count: number): Node {
    const value = failureCount(count);
    if (count > 0) {
      const go = element("button", "wi-link wi-go", l10n.t("View in Tool execution ›"));
      go.type = "button";
      go.dataset.focusKey = "go-tools";
      go.onclick = () => this.setTab("tools", true);
      value.append(go);
    }
    return value;
  }

  private renderPage(page: AgentInspectorPage, target: Extract<InspectorTarget, { kind: "agent" }>): void {
    if (page.section === "overview") {
      if (this.activeTab === "instruction") {
        this.contentEl.appendChild(page.overview.instruction ? pre("wi-text", page.overview.instruction) : element("p", "wi-empty", l10n.t("No instruction was recorded.")));
        return;
      }
      const list = element("dl", "wi-overview");
      const tools = this.pages.get("tools");
      const values: Record<BasicFieldId, string | Node | undefined> = {
        type: page.overview.agentType,
        model: page.overview.modelMeasured,
        effort: page.overview.effortMeasured,
        started: formatDateTime(page.overview.startedAt ?? null),
        ended: formatDateTime(page.overview.endedAt ?? null),
        elapsed: formatDuration(page.overview.elapsedMs ?? 0),
        tools: target.stats !== undefined ? l10n.t("{0} times", target.stats.toolCount) :
          tools?.section === "tools" && tools.nextCursor === undefined ? l10n.t("{0} times", tools.tools.length) : undefined,
        failures: target.stats !== undefined ? this.failuresValue(target.stats.failCount) : undefined,
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
      this.renderTools(page);
      return;
    }
    if (page.section === "messages") {
      const replies = intermediateReplies(page);
      if (replies.length === 0) {
        this.contentEl.appendChild(element("p", "wi-empty", l10n.t("No intermediate replies were recorded.")));
        return;
      }
      const list = element("div", "wi-messages");
      replies.forEach((message, index) => {
        const item = element("article", "wi-message");
        const body = element("div", "wi-message-body");
        if (message.timestamp !== undefined) body.append(element("span", "wi-message-at", clock(message.timestamp)));
        body.append(pre("wi-message-text", message.text));
        item.append(element("span", "wi-message-no", String(index + 1).padStart(2, "0")), body);
        list.append(item);
      });
      this.contentEl.appendChild(list);
      return;
    }
    this.contentEl.appendChild(page.text ? pre("wi-text", page.text) : element("p", "wi-empty", l10n.t("No report was recorded.")));
  }

  private renderTools(page: Extract<AgentInspectorPage, { section: "tools" }>): void {
    if (page.tools.length === 0) {
      this.contentEl.appendChild(element("p", "wi-empty", l10n.t("No tool executions were recorded.")));
      return;
    }
    const failed = page.tools.filter((tool) => tool.isError === true).length;
    const head = element("div", "wi-tools-head");
    const total = element("span", "");
    total.append(l10n.t("{0} items", page.tools.length));
    if (failed > 0) total.append(" · ", element("span", "wi-x", "✗"), " ", l10n.t("{0} failed", failed));
    const toggle = element("button", "wi-link");
    toggle.type = "button";
    toggle.dataset.focusKey = "expand-all";
    head.append(total, toggle);
    const list = element("div", "wi-tools");
    const rows: HTMLDetailsElement[] = [];
    const sync = () => {
      toggle.textContent = rows.every((row) => row.open) ? l10n.t("Collapse all") : l10n.t("Expand all");
    };
    page.tools.forEach((tool, index) => {
      const key = tool.toolUseId || `#${index}`;
      const row = element("details", tool.isError === true ? "wi-tool failed" : "wi-tool");
      row.open = this.toolOpen.get(key) ?? tool.isError === true;
      const summary = element("summary", "");
      summary.dataset.focusKey = `tool:${key}`;
      const completed = tool.isError === false && tool.backgroundLaunch !== true;
      const mark = element("span", "wi-tool-mark", tool.isError === true ? "✗" : completed ? "✓" : "");
      if (tool.isError === true || completed) mark.setAttribute("aria-label", tool.isError ? l10n.t("Failed") : l10n.t("Completed"));
      const name = element("span", "wi-tool-name", tool.toolName);
      name.title = tool.toolName;
      const preview = element("span", "wi-tool-summary", tool.inputSummary ?? "");
      const tail = element("span", "wi-tool-tail");
      tail.append(preview);
      if (tool.isError === true) tail.append(element("span", "wi-tool-failtag", l10n.t("Failed")));
      else if (tool.backgroundLaunch === true) tail.append(element("span", "wi-tool-bgtag", l10n.t("Background")));
      summary.append(element("span", "wi-tool-at", tool.timestamp !== undefined ? clock(tool.timestamp) : ""), mark, name, tail);
      row.append(summary, labelledPre("wi-preview", tool.inputPreview, l10n.t("INPUT")));
      if (tool.resultPreview) {
        row.append(tool.isError === true
          ? labelledPre("wi-result wi-result-error", tool.resultPreview, l10n.t("ERROR"))
          : labelledPre("wi-result", tool.resultPreview, l10n.t("RESULT")));
      }
      row.addEventListener("toggle", () => {
        this.toolOpen.set(key, row.open);
        sync();
      });
      rows.push(row);
      list.append(row);
    });
    toggle.onclick = () => {
      const open = !rows.every((row) => row.open);
      for (const row of rows) row.open = open;
    };
    sync();
    this.contentEl.append(head, list);
  }
}

function intermediateReplies(page: Extract<AgentInspectorPage, { section: "messages" }>): AgentInspectorMessageItem[] {
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

function pre(className: string, text: string): HTMLElement {
  return element("pre", className, text);
}

function labelledPre(className: string, text: string, label: string): HTMLElement {
  const node = pre(className, text);
  node.dataset.label = label;
  return node;
}

function addDefinition(list: HTMLElement, term: TermKey | Node, value: string | Node): void {
  const dt = document.createElement("dt");
  dt.appendChild(typeof term === "string" ? termSpan(term) : term);
  const dd = document.createElement("dd");
  dd.append(value);
  list.append(dt, dd);
}
