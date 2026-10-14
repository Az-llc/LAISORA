import * as l10n from "@vscode/l10n";
import { askQualityIssues, type AskBlock, type AskOption } from "../ask-parser";
import { bindUserLabel } from "./user-label";
import { isRejectedAsk } from "../markdown-ast";

export const askOtherChoice = (): string => l10n.t("Other");

function part<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

export function askHeading(kind: "decide" | "check", title: string, counter: string, header?: string): HTMLElement[] {
  const rail = part("span", "ask-rail");
  rail.setAttribute("aria-hidden", "true");
  const row = part("div", "ask-heading");
  const label = part("span", "ask-label");
  label.append(bindUserLabel(part("span", "ask-label-name")), part("span", "ask-label-kind", ` · ${kind === "decide" ? l10n.t("Decision") : l10n.t("Machine check")}`));
  row.append(label);
  if (header) row.append(part("span", "ask-topic", header));
  row.append(part("span", "ask-counter", counter));
  return [rail, row, part("div", "ask-title", title)];
}

export function askOptionContent(index: number, label: string, effect?: string, option?: AskOption): HTMLElement[] {
  let letter = "";
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) letter = String.fromCharCode(65 + (n - 1) % 26) + letter;
  const name = part("span", "ask-option-label", label);
  if (option?.recommended) name.append(part("span", "ask-recommended", l10n.t("Recommended")));
  const out: HTMLElement[] = [part("span", "ask-letter", letter), name];
  if (effect) out.push(part("span", "ask-effect", effect));
  if (option) {
    out.push(part("span", "ask-detail", l10n.t("Benefit: {0}", option.pros)));
    out.push(part("span", "ask-detail", l10n.t("Drawback: {0}", option.cons)));
  }
  return out;
}

export function askAnswerLine(title: string, choice: string, answer: string): string {
  return `${title} → ${choice}: ${answer}`;
}

export interface AskRenderContext {
  replyId: string;
  offset?: number;
  register(ask: AskBlock, offset: number): string;
  qualityTurn?: string;
  turnId?: string;
  rejected?(key: string): boolean;
  choose(text: string, askKey: string, title: string): void;
  checked(id: string, step: number): boolean;
  check(id: string, step: number, checked: boolean): void;
}

function renderComposerChoice(title: string, block: HTMLElement, context: AskRenderContext | undefined, choice: string, cls: string, hint: string): HTMLElement {
  const button = part("button", `ask-option ${cls}`);
  button.type = "button";
  button.append(part("span", "ask-letter"), part("span", "ask-option-label", choice), part("span", "ask-effect", hint));
  button.disabled = !context;
  button.onclick = () => { if (block.id) context?.choose(askAnswerLine(title, choice, ""), block.id, title); };
  return button;
}

export function goalLabel(): HTMLElement {
  return part("span", "plan-label", "GOAL");
}

export function renderGoal(goal: string, offset: number, context?: AskRenderContext): HTMLElement {
  const block = part("div", "laisora-plan");
  block.id = `goal-${context?.replyId ?? "message"}-${offset + (context?.offset ?? 0)}`;
  block.append(goalLabel(), part("span", "declared-goal", goal));
  return block;
}

const pendingReveals = new WeakSet<HTMLElement>();
const revealers = new WeakMap<HTMLElement, () => void>();
const renderedAsks = new WeakMap<HTMLElement, AskBlock>();

function uncheckedNote(): HTMLElement {
  return part("div", "ask-unchecked-note", l10n.t("This decision did not pass the writing check"));
}

function hideRejected(block: HTMLElement): void {
  block.hidden = true;
  block.classList.add("ask-rejected");
  pendingReveals.add(block);
}

export function renderAsk(ask: AskBlock, offset: number, context?: AskRenderContext, marked = false): HTMLElement {
  const block = part("section", `laisora-ask ask-${ask.kind}`);
  const position = offset + (context?.offset ?? 0);
  const key = `${context?.replyId ?? ""}:${position}`;
  const rejected = context?.rejected?.(key) === true;
  const unchecked = !rejected && !marked && context?.qualityTurn !== undefined && askQualityIssues(ask).length > 0;
  const id = unchecked || rejected ? undefined : context?.register(ask, position);
  if (id) block.id = id;
  renderedAsks.set(block, ask);
  block.dataset.askKey = key;
  if (context) block.dataset.askReply = context.replyId;
  if (context?.turnId !== undefined) block.dataset.askTurnId = context.turnId;
  if (context) revealers.set(block, () => {
    if (!block.id) block.id = context.register(ask, position);
    block.hidden = false;
    if (!block.querySelector(".ask-unchecked-note")) block.querySelector(".ask-why")!.before(uncheckedNote());
  });
  if (rejected) hideRejected(block);
  if (unchecked) {
    block.hidden = true;
    block.classList.add("ask-unchecked");
    pendingReveals.add(block);
  }
  block.append(...askHeading(ask.kind, ask.title, ""), ...(marked ? [uncheckedNote()] : []), part("div", "ask-why", ask.why));
  if (ask.details) {
    const toggle = part("button", "ask-more-toggle", l10n.t("Full explanation"));
    const body = part("div", "ask-more-body", ask.details);
    toggle.type = "button";
    toggle.setAttribute("aria-expanded", "false");
    body.hidden = true;
    toggle.onclick = () => {
      body.hidden = !body.hidden;
      toggle.setAttribute("aria-expanded", String(!body.hidden));
    };
    block.append(toggle, body);
  }
  if (ask.kind === "decide") {
    const options = part("div", "ask-options");
    ask.options.forEach((option, index) => {
      const button = part("button", `ask-option${option.recommended ? " recommended" : ""}`);
      button.type = "button";
      button.append(...askOptionContent(index, option.label, option.effect, option));
      button.disabled = !context;
      button.onclick = () => { if (block.id) context?.choose(askAnswerLine(ask.title, button.querySelector(".ask-letter")!.textContent!, option.label), block.id, ask.title); };
      options.append(button);
    });
    options.append(renderComposerChoice(ask.title, block, context, askOtherChoice(), "ask-other", l10n.t("Type here if no option fits, or if you need a fuller explanation")));
    block.append(options);
  } else {
    const steps = part("div", "ask-steps");
    ask.steps.forEach((step, index) => {
      const label = part("label", "ask-step");
      const input = part("input", "ask-checkbox");
      input.type = "checkbox";
      input.disabled = !context;
      input.checked = id !== undefined && context?.checked(id, index) === true;
      input.onchange = () => { if (id) context?.check(id, index, input.checked); };
      label.append(input, part("span", "ask-do", step.do), part("span", "ask-look", step.look));
      steps.append(label);
    });
    block.append(steps);
  }
  block.append(part("div", "ask-default", ask.default));
  return block;
}

export function settleUncheckedAsks(root: HTMLElement, ended: (turn: string) => boolean): void {
  const last = new Map<string, HTMLElement>();
  root.querySelectorAll<HTMLElement>(".laisora-ask.ask-decide[data-ask-turn-id]").forEach((el) => { last.set(el.dataset.askTurnId!, el); });
  for (const [turn, el] of last) {
    if (!ended(turn) || !pendingReveals.has(el)) continue;
    pendingReveals.delete(el);
    revealers.get(el)?.();
  }
}

export function rejectRenderedAsks(root: HTMLElement, turnId: string, titles: readonly string[], rejected: (key: string, anchorId: string) => void): void {
  root.querySelectorAll<HTMLElement>(".laisora-ask[data-ask-turn-id]:not(.ask-rejected)").forEach((el) => {
    const ask = renderedAsks.get(el);
    if (el.dataset.askTurnId !== turnId || ask === undefined || !isRejectedAsk(ask, titles)) return;
    hideRejected(el);
    rejected(el.dataset.askKey!, el.id);
  });
}

export function updateAskCounters(root: HTMLElement): void {
  const groups = new Map<string, HTMLElement[]>();
  root.querySelectorAll<HTMLElement>(".laisora-ask[data-ask-reply]:not([hidden])").forEach((el) => {
    const key = el.dataset.askReply!;
    const group = groups.get(key) ?? [];
    group.push(el);
    groups.set(key, group);
  });
  for (const group of groups.values()) group.forEach((el, index) => {
    el.querySelector(".ask-counter")!.textContent = `${index + 1} / ${group.length}`;
  });
}
