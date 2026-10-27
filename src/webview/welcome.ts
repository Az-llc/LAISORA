import * as l10n from "@vscode/l10n";
import { closeGlyphButton } from "./close-button";
import { ACTIONS_MENU_GLYPH } from "./todo-edit";
import { handoffMenuLabel } from "./session-header";
import { appearanceSectionTitle } from "./accent-settings";
import { isConvMessageEvent } from "../conv-renderable";
import { GREETING_SLOTS, welcomeGreetings, welcomeNews, welcomeTips, type GreetingSlot, type GreetingSpecialDay, type WelcomeGreetings, type WelcomeNewsItem, type WelcomeTip } from "../welcome-content";
import type { NormalizedEvent, SettingsRevealTarget, WebviewToHost, WelcomeState, WelcomeTab } from "../protocol";

declare const __LAISORA_WELCOME_MARK__: string;

export const GREETING_SLOT_START_HOURS: Record<GreetingSlot, number> = { late: 0, morning: 5, noon: 11, afternoon: 14, evening: 17, night: 19 };
export const WELCOME_CLASS = "welcome";
const HISTORY_ICON_MARK = "\uE000";
const NEWS_KIND_LABELS: Record<WelcomeNewsItem["kind"], string> = { new: "New", setting: "Setting" };

export function greetingSlot(at: Date): GreetingSlot {
  const hour = at.getHours();
  let slot: GreetingSlot = GREETING_SLOTS[0];
  let start = -1;
  for (const candidate of GREETING_SLOTS) {
    const from = GREETING_SLOT_START_HOURS[candidate];
    if (from <= hour && from > start) {
      slot = candidate;
      start = from;
    }
  }
  return slot;
}

export function greetingSpecialDay(at: Date): GreetingSpecialDay | undefined {
  const month = at.getMonth() + 1;
  const day = at.getDate();
  if (month === 1 && day === 1) return "newYear";
  if (month === 2 && day === 22) return "catDay";
  const slot = greetingSlot(at);
  if (at.getDay() === 1 && slot === "morning") return "mondayMorning";
  if (at.getDay() === 5 && slot === "evening") return "fridayEvening";
  return undefined;
}

export function greetingCandidates(at: Date, greetings: WelcomeGreetings): readonly string[] {
  const special = greetingSpecialDay(at);
  if (special !== undefined && greetings.specialDays[special].length > 0) return greetings.specialDays[special];
  return [...greetings.slots[greetingSlot(at)], ...greetings.anytime];
}

export function pickGreeting(at: Date, roll: number, greetings: WelcomeGreetings): string | undefined {
  const candidates = greetingCandidates(at, greetings);
  if (candidates.length === 0) return undefined;
  return candidates[Math.min(candidates.length - 1, Math.max(0, Math.floor(roll * candidates.length)))];
}

export function welcomeApplies(welcome: WelcomeTab | undefined, events: readonly NormalizedEvent[], headHasConvEvent: boolean): welcome is WelcomeTab {
  return welcome !== undefined && !headHasConvEvent && !events.some(isConvMessageEvent);
}

export function welcomeCardsShown(tab: WelcomeTab, live: WelcomeState | undefined, tipCount: number): { news: boolean; tips: boolean } {
  const settings = live ?? tab;
  return {
    news: tab.newsVersion !== undefined && settings.showNews && live?.dismissedNewsVersion !== tab.newsVersion,
    tips: tab.tipId !== undefined && tipCount > 0 && settings.showTips,
  };
}

export function tipIndexOf(tipId: string | undefined, ids: readonly string[]): number {
  const at = tipId === undefined ? -1 : ids.indexOf(tipId);
  return at >= 0 ? at : 0;
}

export type InlinePart = { kind: "text" | "code" | "icon"; text: string };

export function inlineParts(text: string): InlinePart[] {
  const segments = text.split("`");
  const coded = segments.length % 2 === 1;
  const parts: InlinePart[] = [];
  (coded ? segments : [text]).forEach((segment, index) => {
    if (coded && index % 2 === 1) {
      parts.push({ kind: "code", text: segment });
      return;
    }
    segment.split(HISTORY_ICON_MARK).forEach((piece, at) => {
      if (at > 0) parts.push({ kind: "icon", text: "" });
      parts.push({ kind: "text", text: piece });
    });
  });
  return parts.filter((part) => part.kind === "icon" || part.text !== "");
}

export function welcomeFillHeight(ownHeight: number, room: number): number {
  return Math.max(0, ownHeight + room);
}

const views = new Set<WelcomeView>();
let liveState: WelcomeState | undefined;

export function applyWelcomeState(next: WelcomeState | undefined): void {
  liveState = next;
  for (const view of views) view.refresh();
}

export interface WelcomeHost {
  post(message: WebviewToHost): void;
  port: HTMLElement;
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function historyIcon(): HTMLElement {
  const icon = element("span", "l-icon l-icon-history welcome-inline-icon");
  icon.setAttribute("role", "img");
  icon.setAttribute("aria-label", l10n.t("Resume from history"));
  return icon;
}

function appendInline(target: HTMLElement, text: string): void {
  for (const part of inlineParts(text)) {
    if (part.kind === "text") target.append(part.text);
    else if (part.kind === "code") target.appendChild(element("code", "inline-code", part.text));
    else target.appendChild(historyIcon());
  }
}

export class WelcomeView {
  readonly element = element("div", WELCOME_CLASS);
  private readonly cards = element("div", "welcome-cards");
  private readonly tips: readonly WelcomeTip[];
  private readonly resize: ResizeObserver | undefined;
  private newsCard: HTMLElement | undefined;
  private tipCard: HTMLElement | undefined;
  private shown: { news: boolean; tips: boolean } | undefined;
  private fitFrame: number | undefined;

  constructor(private readonly conv: HTMLElement, private readonly tab: WelcomeTab, private readonly host: WelcomeHost) {
    this.tips = welcomeTips({ menuGlyph: ACTIONS_MENU_GLYPH, handoffItem: handoffMenuLabel(), appearanceSection: appearanceSectionTitle(), historyButton: HISTORY_ICON_MARK });
    const brand = element("div", "welcome-brand");
    const mark = element("span", "welcome-mark");
    mark.setAttribute("aria-hidden", "true");
    if (typeof __LAISORA_WELCOME_MARK__ === "string") mark.style.setProperty("--welcome-mark", __LAISORA_WELCOME_MARK__);
    brand.append(mark, element("div", "welcome-name", "LAISORA"));
    const greeting = pickGreeting(new Date(tab.openedAt), tab.roll, welcomeGreetings());
    if (greeting !== undefined) brand.appendChild(element("p", "welcome-greeting", greeting));
    this.element.append(brand, this.cards);
    conv.prepend(this.element);
    views.add(this);
    this.resize = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(() => this.scheduleFit());
    this.resize?.observe(host.port);
    this.resize?.observe(conv);
    this.refresh();
  }

  refresh(): void {
    const shown = welcomeCardsShown(this.tab, liveState, this.tips.length);
    if (this.shown?.news === shown.news && this.shown.tips === shown.tips) return;
    this.shown = shown;
    if (shown.news) this.newsCard ??= this.buildNewsCard(this.tab.newsVersion!);
    if (shown.tips) this.tipCard ??= this.buildTipCard();
    if (this.newsCard) this.newsCard.hidden = !shown.news;
    if (this.tipCard) this.tipCard.hidden = !shown.tips;
    this.cards.replaceChildren(...[this.newsCard, this.tipCard].filter((card): card is HTMLElement => card !== undefined));
    this.cards.hidden = !shown.news && !shown.tips;
  }

  dispose(): void {
    views.delete(this);
    this.resize?.disconnect();
    if (this.fitFrame !== undefined) cancelAnimationFrame(this.fitFrame);
    this.element.remove();
  }

  private scheduleFit(): void {
    if (this.fitFrame !== undefined) return;
    this.fitFrame = requestAnimationFrame(() => {
      this.fitFrame = undefined;
      this.fit();
    });
  }

  private fit(): void {
    if (!this.element.isConnected || this.element.getClientRects().length === 0) return;
    const port = this.host.port;
    const portTop = port.getBoundingClientRect().top + port.clientTop;
    const contentBottom = this.conv.getBoundingClientRect().bottom - portTop + port.scrollTop;
    const room = port.clientHeight - (Number.parseFloat(getComputedStyle(port).paddingBottom) || 0) - contentBottom;
    const height = `${welcomeFillHeight(this.element.getBoundingClientRect().height, room)}px`;
    if (this.element.style.minHeight !== height) this.element.style.minHeight = height;
  }

  private card(label: string, name: string, meta: HTMLElement, close: HTMLButtonElement): HTMLElement {
    const card = element("section", "welcome-card");
    const head = element("div", "welcome-card-head");
    head.append(element("span", "l-label", label), meta);
    card.setAttribute("aria-label", name);
    card.append(close, head);
    return card;
  }

  private settingLink(target: SettingsRevealTarget): HTMLButtonElement {
    const link = element("button", "welcome-link", l10n.t("Open settings"));
    link.type = "button";
    link.addEventListener("click", () => this.host.post({ type: "runHostAction", action: "openSettings", target }));
    return link;
  }

  private buildNewsCard(version: string): HTMLElement {
    const close = closeGlyphButton(element("button", "welcome-close"), l10n.t("Close the news"), l10n.t("Close the news"));
    close.type = "button";
    close.addEventListener("click", () => {
      this.host.post({ type: "welcomeAction", action: "dismissNews", version });
      applyWelcomeState({ ...(liveState ?? this.tab), dismissedNewsVersion: version });
    });
    const card = this.card("What's new", l10n.t("What's new in LAISORA"), element("span", "welcome-card-meta", version), close);
    const list = element("ul", "welcome-news");
    for (const item of welcomeNews()[version] ?? []) {
      const row = element("li", "welcome-news-row");
      const text = element("span", "welcome-news-text");
      appendInline(text, item.text);
      if (item.setting) text.append(" ", this.settingLink(item.setting));
      row.append(element("span", "l-label welcome-news-kind", NEWS_KIND_LABELS[item.kind]), text);
      list.appendChild(row);
    }
    card.appendChild(list);
    return card;
  }

  private buildTipCard(): HTMLElement {
    const close = closeGlyphButton(element("button", "welcome-close"), l10n.t("Close tips (they will not show again)"), l10n.t("Close tips (they will not show again)"));
    close.type = "button";
    close.addEventListener("click", () => this.host.post({ type: "welcomeAction", action: "hideTips" }));
    const meta = element("span", "welcome-card-meta");
    const card = this.card("Tip", l10n.t("LAISORA tip"), meta, close);
    const stack = element("div", "welcome-tip-stack");
    const items = this.tips.map((tip, index) => {
      const item = element("div", "welcome-tip");
      const title = element("div", "welcome-tip-title");
      title.append(element("span", "welcome-tip-number", String(index + 1).padStart(2, "0")), tip.title);
      const body = element("div", "welcome-tip-body");
      appendInline(body, tip.body);
      if (tip.setting) body.append(" ", this.settingLink(tip.setting));
      item.append(title, body);
      stack.appendChild(item);
      return item;
    });
    const foot = element("div", "welcome-tip-foot");
    const kind = element("span", "welcome-tip-kind");
    const next = element("button", "welcome-link", l10n.t("Next tip →"));
    next.type = "button";
    foot.append(kind, next);
    let current = tipIndexOf(this.tab.tipId, this.tips.map((tip) => tip.id));
    const show = (): void => {
      items.forEach((item, at) => {
        const on = at === current;
        item.classList.toggle("welcome-tip-off", !on);
        if (on) item.removeAttribute("aria-hidden");
        else item.setAttribute("aria-hidden", "true");
      });
      kind.textContent = this.tips[current].kind;
      meta.textContent = `${current + 1} / ${this.tips.length}`;
    };
    next.addEventListener("click", () => {
      current = (current + 1) % this.tips.length;
      show();
    });
    show();
    card.append(stack, foot);
    return card;
  }
}
