import * as l10n from "@vscode/l10n";
import type { AskBlock, AskOption } from "./ask-parser";

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
  row.append(part("span", "ask-label", kind === "decide" ? l10n.t("YOU · Decision") : l10n.t("YOU · Machine check")));
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

export interface AskRenderContext {
  replyId: string;
  offset?: number;
  register(ask: AskBlock, offset: number): string;
  choose(text: string, askKey: string, title: string): void;
  checked(id: string, step: number): boolean;
  check(id: string, step: number, checked: boolean): void;
}

export function renderGoal(goal: string, offset: number, context?: AskRenderContext): HTMLElement {
  const block = part("div", "laisora-plan");
  block.id = `goal-${context?.replyId ?? "message"}-${offset + (context?.offset ?? 0)}`;
  block.append(part("span", "plan-label", "GOAL"), part("span", "declared-goal", goal));
  return block;
}

export function renderAsk(ask: AskBlock, offset: number, context?: AskRenderContext): HTMLElement {
  const block = part("section", `laisora-ask ask-${ask.kind}`);
  const id = context?.register(ask, offset + (context.offset ?? 0));
  if (id) block.id = id;
  if (context) block.dataset.askReply = context.replyId;
  block.append(...askHeading(ask.kind, ask.title, ""), part("div", "ask-why", ask.why));
  if (ask.kind === "decide") {
    const options = part("div", "ask-options");
    ask.options.forEach((option, index) => {
      const button = part("button", `ask-option${option.recommended ? " recommended" : ""}`);
      button.type = "button";
      button.append(...askOptionContent(index, option.label, option.effect, option));
      button.disabled = !context;
      button.onclick = () => context?.choose(`${ask.title} → ${button.querySelector(".ask-letter")!.textContent}: ${option.label}`, id!, ask.title);
      options.append(button);
    });
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

export function updateAskCounters(root: HTMLElement): void {
  const groups = new Map<string, HTMLElement[]>();
  root.querySelectorAll<HTMLElement>(".laisora-ask[data-ask-reply]").forEach((el) => {
    const key = el.dataset.askReply!;
    const group = groups.get(key) ?? [];
    group.push(el);
    groups.set(key, group);
  });
  for (const group of groups.values()) group.forEach((el, index) => {
    el.querySelector(".ask-counter")!.textContent = `${index + 1} / ${group.length}`;
  });
}
