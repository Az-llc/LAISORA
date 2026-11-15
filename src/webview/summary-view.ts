import * as l10n from "@vscode/l10n";
import type { SummaryBlock, SummaryWait } from "../summary-block";
import { element as part, markJapanese, textElement } from "./element";

export type SummaryInlineRenderer = (text: string, target: HTMLElement) => void;

const waitKindLabel = (wait: SummaryWait): string => wait.kind === "approve" ? l10n.t("Approval") : wait.kind === "check" ? l10n.t("Machine check") : l10n.t("Decision");

export function renderSummary(summary: SummaryBlock, inline?: SummaryInlineRenderer): HTMLElement {
  const rich = (tag: "div" | "span" | "li", cls: string, text: string): HTMLElement => {
    const el = part(tag, cls);
    markJapanese(el, text);
    if (inline) inline(text, el);
    else el.textContent = text;
    return el;
  };
  const card = part("section", `laisora-summary summary-${summary.state}`);
  const label = summary.state === "done" ? l10n.t("Completion report") : l10n.t("Interim report");
  card.setAttribute("aria-label", label);
  const rail = part("span", "summary-rail");
  rail.setAttribute("aria-hidden", "true");
  const mark = summary.state === "done" ? part("span", "summary-mark", "✓") : part("span", "summary-mark summary-mark-square");
  mark.setAttribute("aria-hidden", "true");
  const heading = part("div", "summary-heading");
  heading.append(mark, part("span", "summary-label", label));
  const parts = part("div", "summary-parts");
  const row = (term: string, desc: HTMLElement, cls = ""): void => {
    const line = part("div", `summary-part${cls}`);
    line.append(part("div", "summary-term", term), desc);
    parts.append(line);
  };
  const list = (term: string, items: readonly string[]): void => {
    if (items.length === 0) return;
    const ul = part("ul", "summary-desc");
    for (const item of items) ul.append(rich("li", "", item));
    row(term, ul);
  };
  if (summary.state === "done") {
    row(l10n.t("Summary"), rich("div", "summary-result", summary.summary), " summary-part-result");
    list(l10n.t("Work done"), summary.done);
    list(l10n.t("Verified"), summary.verified);
    list(l10n.t("Not verified"), summary.unverified);
    if (summary.left.length === 0) row(l10n.t("Remaining"), part("div", "summary-none", l10n.t("None")));
    else list(l10n.t("Remaining"), summary.left);
  } else {
    list(l10n.t("Progress"), summary.progress);
    const ul = part("ul", "summary-desc");
    for (const wait of summary.waiting) {
      const li = part("li", "summary-wait");
      li.dataset.waitKind = wait.kind;
      li.append(part("span", "summary-wait-square"), part("span", `summary-wait-kind summary-wait-${wait.kind}`, waitKindLabel(wait)), textElement("span", "summary-wait-title", wait.title));
      ul.append(li);
    }
    row(l10n.t("Waiting on you"), ul);
  }
  card.append(rail, heading, parts);
  return card;
}

const WAIT_CARD_KIND: Readonly<Record<SummaryWait["kind"], string | undefined>> = { decide: "ask-decide", check: "ask-check", approve: undefined };

const HISTORY_CONTAINER = ".convlog-history";
const USER_ROW = ".block.user";

function turnBlocks(card: HTMLElement): HTMLElement[] {
  const block = card.closest<HTMLElement>(".block");
  if (block === null) return [];
  const blocks = [block];
  for (let at = block.previousElementSibling; at instanceof HTMLElement && !at.matches(`${USER_ROW}, ${HISTORY_CONTAINER}`); at = at.previousElementSibling) blocks.unshift(at);
  let at = block.nextElementSibling;
  for (; at instanceof HTMLElement && !at.matches(USER_ROW); at = at.nextElementSibling) blocks.push(at);
  const history = block.parentElement?.closest<HTMLElement>(HISTORY_CONTAINER);
  if (at === null && history) {
    for (let live = history.nextElementSibling; live instanceof HTMLElement && !live.matches(USER_ROW); live = live.nextElementSibling) blocks.push(live);
  }
  return blocks;
}

export function waitCardOf(card: HTMLElement, kind: SummaryWait["kind"], title: string): HTMLElement | undefined {
  const cardKind = WAIT_CARD_KIND[kind];
  if (cardKind === undefined) return undefined;
  return turnBlocks(card).flatMap((block) => Array.from(block.querySelectorAll<HTMLElement>(`.laisora-ask.${cardKind}[id]:not([hidden]):not(.ask-replaced)`)))
    .filter((ask) => ask.querySelector(":scope > .ask-title")?.textContent === title).at(-1);
}

export function linkSummaryWaits(root: HTMLElement, go: (target: HTMLElement) => void): void {
  root.querySelectorAll<HTMLElement>(".laisora-summary .summary-wait").forEach((li) => {
    const title = li.querySelector<HTMLElement>(".summary-wait-title");
    const card = li.closest<HTMLElement>(".laisora-summary");
    const kind = li.dataset.waitKind as SummaryWait["kind"];
    if (title === null || card === null) return;
    const text = title.textContent ?? "";
    const target = waitCardOf(card, kind, text);
    if (target === undefined) {
      if (title instanceof HTMLButtonElement) title.replaceWith(textElement("span", "summary-wait-title", text));
      li.querySelector(":scope > .summary-wait-go")?.remove();
      return;
    }
    if (title instanceof HTMLButtonElement && title.dataset.target === target.id) return;
    const link = textElement("button", "summary-wait-title summary-wait-link", text);
    link.type = "button";
    link.dataset.target = target.id;
    link.onclick = () => {
      const now = link.isConnected ? root.querySelector<HTMLElement>(`#${CSS.escape(link.dataset.target ?? "")}`) : null;
      if (now) go(now);
    };
    title.replaceWith(link);
    if (li.querySelector(":scope > .summary-wait-go") === null) {
      const marker = part("span", "summary-wait-go", "\u2191");
      marker.setAttribute("aria-hidden", "true");
      li.append(marker);
    }
  });
}
