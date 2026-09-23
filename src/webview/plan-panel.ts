import * as l10n from "@vscode/l10n";
import type { OrchestrationView, WorkModelPayload } from "../protocol";
import type { PlanUsage } from "../plan-usage";
import { derivePlanView, type PlanLane, type PlanView } from "./plan-view";

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  element.className = className;
  if (text !== undefined) {
    element.textContent = text;
    if (/[\u3040-\u30ff\u3400-\u9fff]/.test(text)) element.lang = "ja";
  }
  return element;
}
export function planDuration(ms: number | null): string {
  if (ms === null) return "—";
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
export function planTokens(value: number | null): string {
  return value === null ? "—" : value >= 1000000 ? `${(value / 1000000).toFixed(1)}M`
    : value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value));
}
function status(value: string): string {
  switch (value) {
    case "in_progress": case "running": return l10n.t("In progress");
    case "completed": return "✓";
    case "pending": return l10n.t("Pending");
    case "failed": return `✗ ${l10n.t("Failed")}`;
    case "stale": return l10n.t("Stopped");
    default: return "—";
  }
}

export class PlanPanel {
  readonly aside = node("aside", "plan-side");
  readonly you = node("div", "plan-side-you");
  readonly bar = node("button", "plan-bar");
  readonly waiting = node("span", "plan-bar-waiting");
  private readonly section = node("section", "plan-section");
  private readonly dialog = node("dialog", "plan-drawer");
  private readonly closeButton = node("button", "plan-drawer-close", "×");
  private readonly barTitle = node("span", "plan-bar-current");
  private readonly barCount = node("span", "plan-bar-count");
  private readonly barNumber = node("span", "plan-bar-number");
  private readonly barStats = node("span", "plan-bar-stats");
  private readonly barRunning = node("span", "plan-bar-running");
  private model?: WorkModelPayload;
  private orchestration?: OrchestrationView;
  private usage?: PlanUsage;
  private nowMs = 0;
  private signature = "";
  private youCount = 0;
  private readonly resize: ResizeObserver;
  private readonly theme: MutationObserver;
  private returnFocus: HTMLElement | null = null;

  constructor(content: HTMLElement, head: HTMLElement, tabId: string) {
    this.aside.id = `plan-side-${tabId}`;
    this.aside.setAttribute("aria-label", "PLAN");
    this.aside.append(this.you, this.section);
    this.dialog.setAttribute("aria-label", "PLAN");
    this.closeButton.type = "button";
    this.closeButton.setAttribute("aria-label", l10n.t("Close plan"));
    this.closeButton.onclick = () => this.close();
    this.dialog.append(this.closeButton);
    this.dialog.addEventListener("close", () => {
      content.append(this.aside);
      this.bar.setAttribute("aria-expanded", "false");
      this.returnFocus?.focus();
    });
    this.dialog.addEventListener("click", event => { if (event.target === this.dialog) this.close(); });
    this.dialog.addEventListener("cancel", event => { event.preventDefault(); this.close(); });
    this.bar.type = "button";
    this.bar.setAttribute("aria-controls", this.aside.id);
    this.bar.setAttribute("aria-expanded", "false");
    this.bar.setAttribute("aria-haspopup", "dialog");
    this.bar.append(node("span", "plan-label", "PLAN"), this.barCount, this.barNumber, this.barTitle, this.barStats, this.barRunning, this.waiting, node("span", "plan-bar-chevron", "▸"));
    this.bar.onclick = () => {
      this.returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : this.bar;
      this.dialog.append(this.aside);
      this.dialog.showModal();
      this.bar.setAttribute("aria-expanded", "true");
      this.closeButton.focus();
    };
    head.append(this.bar);
    content.append(this.aside, this.dialog);
    this.resize = new ResizeObserver(() => { if (content.clientWidth >= 1100 || content.getClientRects().length === 0) this.close(); });
    this.resize.observe(content);
    this.theme = new MutationObserver(() => { this.signature = ""; this.render(); });
    this.theme.observe(document.body, { attributes: true, attributeFilter: ["class", "style"] });
    this.theme.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
  }

  setWaiting(count: number, total = count): void {
    this.youCount = total;
    this.waiting.textContent = count ? l10n.t("Waiting on you {0}", count) : "";
    this.signature = "";
    this.render();
  }

  close(restoreFocus = true): void { if (!restoreFocus) this.returnFocus = null; if (this.dialog.open) this.dialog.close(); }
  destroy(): void { this.close(); this.resize.disconnect(); this.theme.disconnect(); this.dialog.remove(); }
  setModel(model: WorkModelPayload | undefined): void { this.model = model; this.render(); }
  setUsage(usage: PlanUsage | undefined): void { this.usage = usage; this.render(); }
  setOrchestration(view: OrchestrationView): void { this.orchestration = view; this.render(); }
  tick(nowMs: number): void { this.nowMs = nowMs; this.render(); }

  private render(): void {
    const view = derivePlanView(this.model, this.orchestration, this.usage, this.nowMs);
    const signature = JSON.stringify(view);
    if (signature === this.signature) return;
    this.signature = signature;
    this.aside.classList.toggle("plan-empty", !view.goal && !view.steps.length && !view.now.length && this.youCount === 0);
    this.bar.classList.toggle("plan-empty", !view.goal && !view.steps.length && !view.now.length && this.youCount === 0);
    const current = view.steps.find(step => step.number === view.current);
    this.barCount.textContent = view.steps.length ? `${view.current ?? view.completed}/${view.steps.length}` : "";
    this.barNumber.textContent = current ? String(current.number).padStart(2, "0") : "";
    this.barTitle.textContent = current?.title ?? "";
    const running = [...view.now, ...view.steps.flatMap(step => step.lanes)].filter(lane => lane.status === "running").length;
    this.barRunning.textContent = running ? l10n.t("Working {0}", running) : "";
    this.barStats.textContent = view.steps.length ? `${planDuration(view.elapsed)} · ${view.claude ? "≈" : ""}${planTokens(view.claude?.tokens ?? null)}` : "";
    renderPlanSection(this.section, view);
  }

}

function renderLane(lane: PlanLane): HTMLElement {
  const row = node("div", "plan-lane");
  row.dataset.laneId = lane.id;
  const name = node("span", "plan-agent", lane.agent);
  const metric = node("span", "plan-metric", `${status(lane.status)} ${planDuration(lane.elapsed)} · ${planTokens(lane.tokens)}`);
  metric.title = l10n.t("Cache read: {0} tokens", planTokens(lane.cacheRead));
  row.classList.toggle("plan-failed", lane.status === "failed");
  row.append(name, node("span", "plan-lane-title", lane.title), metric);
  return row;
}

export function renderPlanSection(section: HTMLElement, view: PlanView): void {
  section.lang = document.documentElement.lang;
  section.hidden = !view.goal && !view.steps.length && !view.now.length;
  const top = node("div", "plan-top");
  const stats = node("span", "plan-stats", `${planDuration(view.elapsed)} · ${view.claude ? "≈" : ""}${planTokens(view.claude?.tokens ?? null)} Claude · ${planTokens(view.external?.tokens ?? null)} ${l10n.t("External")}`);
  stats.title = l10n.t("Cache read: Claude {0} · External {1}", planTokens(view.claude?.cacheRead ?? null), planTokens(view.external?.cacheRead ?? null));
  top.append(node("span", "plan-label", view.steps.length ? `PLAN · ${view.current ?? view.completed} / ${view.steps.length}` : "PLAN"), stats);
  const goal = node("h3", "plan-goal", view.goal);
  const current = view.steps.find(step => step.number === view.current);
  goal.hidden = !view.goal;
  const lede = node("p", "plan-lede", current?.activeForm ?? (view.steps.length && view.completed === view.steps.filter(step => !step.removed).length ? `✓ ${l10n.t("All steps completed")}` : view.steps.length ? l10n.t("Declared steps") : l10n.t("Observed work")));
  const head = node("header", "plan-section-head");
  head.append(top, goal, lede);
  const children: HTMLElement[] = [];
  if (view.partial) children.push(node("p", "plan-lede", l10n.t("Some earlier plan details are unavailable.")));
  const firstOpen = view.steps.findIndex(step => step.removed || step.status !== "completed");
  const done = view.steps.slice(0, firstOpen < 0 ? view.steps.length : firstOpen);
  const collapsed = done.length > 4 && section.dataset.doneOpen !== "true";
  for (const step of view.steps) {
    if (done.length > 4 && step === done[0]) {
      const toggle = node("button", "plan-done-toggle", `✓ ${l10n.t("{0}–{1} done", String(done[0].number).padStart(2, "0"), String(done[done.length - 1].number).padStart(2, "0"))} ${collapsed ? "▸" : "▾"}`);
      toggle.type = "button";
      toggle.setAttribute("aria-expanded", String(!collapsed));
      toggle.onclick = () => {
        section.dataset.doneOpen = String(collapsed);
        renderPlanSection(section, view);
        section.querySelector<HTMLElement>(".plan-done-toggle")?.focus();
      };
      children.push(toggle);
    }
    if (collapsed && done.includes(step)) continue;
    const item = node("div", "plan-item");
    item.classList.toggle("plan-current", step.number === view.current);
    item.classList.toggle("plan-ahead", step.ahead || step.added && step.status === "in_progress");
    item.classList.toggle("plan-done", step.status === "completed");
    item.classList.toggle("plan-removed", step.removed);
    const body = node("div", "plan-item-body");
    const title = node("div", "plan-title");
    title.append(node("span", "plan-step-title", step.title));
    if (step.added) title.append(node("span", "plan-mark", `ADDED${step.addedAt === null ? "" : ` ${new Date(step.addedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })}`}`));
    if (step.ahead) title.append(node("span", "plan-mark", "AHEAD"));
    title.append(node("span", "plan-status", step.removed ? l10n.t("Removed") : status(step.status)));
    body.append(title);
    if (step.elapsed !== null || step.tokens !== null) {
      const metric = node("div", "plan-step-metric", `${planDuration(step.elapsed)} · ${step.tokens === null ? "—" : `≈${planTokens(step.tokens.tokens)}`}`);
      metric.title = l10n.t("Approximate time attribution. Cache read: {0} tokens", planTokens(step.tokens?.cacheRead ?? null));
      body.append(metric);
    }
    for (const lane of step.lanes) body.append(renderLane(lane));
    item.append(node("span", "plan-number", String(step.number).padStart(2, "0")), body);
    children.push(item);
  }
  if (view.now.length) {
    const now = node("div", "plan-now");
    now.append(node("div", "plan-label", "NOW"));
    for (const lane of view.now) now.append(renderLane(lane));
    children.push(now);
  }
  const body = node("div", "plan-section-body");
  body.append(...children);
  section.replaceChildren(head, body);
}
