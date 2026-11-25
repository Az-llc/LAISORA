import { isComposingKey } from "./composing";
import { handleSegmentedArrow } from "./segmented-keys";
import { fieldLeaveCommits, settleFieldEdit, type FieldEdit, type FieldReply } from "./field-edit";
import { CLOSE_GLYPH } from "./close-button";
import { appearanceSectionTitle, createAccentSettings } from "./accent-settings";
import { bindUserLabel, setDisplayName, turnLabel } from "./user-label";
import { askHeading } from "./ask-view";
import { YouList } from "./you-list";
import type { YouItem } from "./you-items";
import { DISPLAY_NAME_MAX, displayNameLength, normalizeDisplayName } from "../display-name";
import { normalizeSystemAppExtension } from "../file-link-open-mode";
import { EVENT_LIMIT_DEFAULT, EVENT_LIMIT_MIN, EVENT_LIMIT_MAX, isEventLimit } from "../event-limits";
import { TRANSCRIPT_RETENTION_DAYS_MIN, isTranscriptRetentionDays, type TranscriptRetentionFallback } from "../transcript-retention";
import { EXECUTORS, EXTERNAL_EXECUTORS, DEFAULT_EXECUTOR, canonicalExecutorEfforts, claudeModelIdLabel, EXTERNAL_TIMEOUT_MAX_MINUTES, EXTERNAL_TIMEOUT_MIN_MINUTES, executorModelList, executorServesRole, modelSelectionState, isExecutorId, isExternalExecutorId, rowEfforts, rowComplete, type ExecutorId, type ExecutorRow, type ExternalModels } from "../orchestration-executors";
import { findModelRow, modelListStatusText, modelsLoadingText, shortModelDisplayName } from "../model-display-name";
import { resolveOrchestrationCacheTtl, emptyOrchestrationRole, externalExecutorName, isExternalModel, isExternalTimeout, isRoleName, orchestrationVariants, orchestrationExternalTargets, ROSTER_ROWS_MAX } from "../orchestration-roster";
import { type OrchestrationSettingRow, type RecommendedRosterChange } from "../orchestration-roster";
import * as l10n from "@vscode/l10n";
import { uiLocale } from "./l10n";
import { formatBytes as formatByteCount, formatElapsed, MIGRATION_CATEGORIES, MIGRATION_OPERATIONS, migrationCategoryTitle, migrationProgressView, type MigrationCategory, type MigrationOperation, type MigrationProgress, type MigrationProgressView } from "../migration-categories";
import { CACHE_EXPIRY_LEAD_MS, CACHE_EXPIRY_MIN_TOTAL_TOKENS } from "../handoff-auto";
import { CLAUDE_MODEL_PRICES, PROMPT_CACHE_PRICES_CHECKED_ON, PROMPT_CACHE_WRITE_MULTIPLIER, type TokenPrices } from "../claude-prices";
import {
  FILE_LINK_BOOLEAN_SETTINGS,
  HANDOFF_AUTO_PERCENT_MAX,
  HANDOFF_AUTO_PERCENT_MIN,
  HANDOFF_AUTO_TOKENS_MIN,
  handoffContinuesWork,
  isHandoffAutoSettingValue,
  isHostToSettingsPage,
  isWaitNotifySettingValue,
  WAIT_NOTIFY_MINUTES_MAX,
  WAIT_NOTIFY_MINUTES_MIN,
  type HandoffAutoMode,
  type HandoffAutoSettingName,
  type WaitNotifySettingName,
  type ApiKeyPolicy,
  type ComposerSendKey,
  type FileLinkBooleanSetting,
  type HostToSettingsPage,
  type SettingsPageToHost,
  type SettingsRevealTarget,
  type WelcomeSetting,
  type SettingWriteFailure,
  type SettingWriteFailureAction,
} from "../protocol";
import { element } from "./element";
import { capNameInput, row, rowNote, section, select, switchButton } from "./settings-rows";
import { createWorkStageCastSettings } from "./work-stage-cast-settings";

declare function acquireVsCodeApi(): { postMessage(message: SettingsPageToHost): void; getState(): { category?: string } | undefined; setState(state: { category: string }): void };

const vscode = acquireVsCodeApi();

function usesClaudeUsage(row: ExecutorRow): boolean {
  return EXECUTORS[row.executor].kind === "agent";
}

export type RosterPriceRow = { readonly name: string; readonly aboveTokens?: number; readonly prices: readonly number[] };

export function deriveRosterPriceRows(enabled: boolean, agents: readonly OrchestrationSettingRow[], externalModels: ExternalModels): RosterPriceRow[] {
  if (!enabled) return [];
  const used = new Set(agents.filter((entry) => entry.enabled).flatMap((entry) => entry.rows)
    .filter((row) => usesClaudeUsage(row) && rowComplete(row, externalModels))
    .map((row) => {
      const list = externalModels[row.executor];
      const resolved = findModelRow(list.state === "ok" ? list.models : [], row.model)?.resolvedModel ?? row.model;
      return shortModelDisplayName(claudeModelIdLabel(resolved));
    }));
  const line = (name: string, price: TokenPrices, aboveTokens?: number): RosterPriceRow => ({ name, aboveTokens,
    prices: [price.input, price.input * PROMPT_CACHE_WRITE_MULTIPLIER["5m"], price.input * PROMPT_CACHE_WRITE_MULTIPLIER["1h"], price.read, price.output] });
  return Object.entries(CLAUDE_MODEL_PRICES).filter(([name]) => used.has(name))
    .flatMap(([name, price]) => [line(name, price), ...(price.overLongPrompt ? [line(name, price.overLongPrompt, price.overLongPrompt.aboveTokens)] : [])]);
}

type SettingsState = Extract<HostToSettingsPage, { type: "settingsState" }>;

const root = document.getElementById("settings-root") ?? document.body;
const status = element("p", "settings-status", l10n.t("Loading…"));
status.setAttribute("role", "status");
root.appendChild(status);

const settingsShell = element("div", "settings-shell");
const settingsNav = element("nav", "settings-nav");
settingsNav.setAttribute("aria-label", l10n.t("Settings categories"));
const settingsContent = element("div", "settings-content");
const settingsMain = element("div", "settings-main");
const settingsPageHead = element("div", "settings-page-head");
const settingsPageTitle = element("div", "settings-page-title");
settingsPageHead.append(settingsPageTitle, element("div", "settings-page-sub", l10n.t("LAISORA Settings")));
const settingsBody = element("div", "settings-body");
const settingsToc = element("nav", "settings-toc");
settingsToc.setAttribute("aria-label", l10n.t("On this page"));
const settingsTocList = element("ol", "settings-toc-list");
settingsToc.append(element("div", "l-label settings-toc-label", l10n.t("On this page")), settingsTocList);
let settingsTocSections: Array<{ heading: HTMLElement; link: HTMLButtonElement }> = [];
const settingsBetaMark = (): HTMLElement => element("span", "settings-beta", l10n.t("Beta"));
const settingsCategoryList: ReadonlyArray<{ key: string; title: string; beta?: true }> = [
  { key: "general", title: l10n.t("General") },
  { key: "files", title: l10n.t("File links") },
  { key: "roster", title: l10n.t("Agent roster") },
  { key: "cli", title: l10n.t("CLI") },
  { key: "migration", title: l10n.t("Migration") },
  { key: "workStage", title: l10n.t("Work stage"), beta: true },
];
const settingsCategories = settingsCategoryList.map((category, index) => {
  const button = element("button", "settings-tab");
  button.type = "button";
  button.id = `settings-nav-${category.key}`;
  const number = element("span", "settings-tab-number", String(index + 1).padStart(2, "0"));
  number.setAttribute("aria-hidden", "true");
  const label = element("span", "settings-tab-label", category.title);
  if (category.beta) label.append(" ", settingsBetaMark());
  button.append(number, label);
  const panel = element("div", "settings-category");
  panel.id = `settings-category-${category.key}`;
  panel.setAttribute("aria-labelledby", button.id);
  button.setAttribute("aria-controls", panel.id);
  settingsNav.appendChild(button);
  settingsContent.appendChild(panel);
  return { ...category, button, panel };
});
let requestedSettingsCategory: string | null = null;
function activateSettingsCategory(requested: string): void {
  const shown = settingsCategories.some((category) => category.key === requested && !category.button.hidden);
  const key = shown ? requested : "general";
  requestedSettingsCategory = shown || !settingsCategories.some((category) => category.key === requested) ? null : requested;
  for (const category of settingsCategories) {
    const active = category.key === key;
    category.panel.hidden = !active;
    if (active) category.button.setAttribute("aria-current", "page");
    else category.button.removeAttribute("aria-current");
    if (active) settingsPageTitle.replaceChildren(category.title, ...category.beta ? [" ", settingsBetaMark()] : []);
  }
  if (shown) vscode.setState({ category: key });
  renderSettingsToc();
  if (key === "migration") vscode.postMessage({ type: "migrationScan" });
}
function renderSettingsToc(): void {
  const panel = settingsCategories.find((category) => !category.panel.hidden)?.panel;
  const headings = panel ? Array.from(panel.querySelectorAll<HTMLElement>("h2")).filter((heading) => !heading.closest("[hidden]")) : [];
  settingsTocSections = headings.map((heading, index) => {
    const link = element("button", "settings-toc-link");
    link.type = "button";
    const number = element("span", "settings-toc-number", String(index + 1).padStart(2, "0"));
    number.setAttribute("aria-hidden", "true");
    link.append(number, element("span", "settings-toc-text", heading.textContent ?? ""));
    link.addEventListener("click", () => {
      heading.scrollIntoView({ block: "start" });
      markSettingsToc(heading);
    });
    return { heading, link };
  });
  settingsTocList.replaceChildren(...settingsTocSections.map(({ link }) => {
    const item = element("li", "settings-toc-item");
    item.appendChild(link);
    return item;
  }));
  settingsToc.hidden = settingsTocSections.length < 2;
  markSettingsToc();
}
function markSettingsToc(target?: HTMLElement): void {
  const current = target ?? [...settingsTocSections].reverse().find(({ heading }) => heading.getBoundingClientRect().top <= 96)?.heading ?? settingsTocSections[0]?.heading;
  for (const { heading, link } of settingsTocSections) {
    if (heading === current) link.setAttribute("aria-current", "location");
    else link.removeAttribute("aria-current");
  }
}
window.addEventListener("scroll", () => markSettingsToc(), { passive: true });
const workStageNav = settingsCategories.find((category) => category.key === "workStage")!;
workStageNav.button.hidden = true;
for (const category of settingsCategories) {
  category.button.addEventListener("click", () => activateSettingsCategory(category.key));
  category.button.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activateSettingsCategory(category.key);
      return;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    const visible = settingsCategories.filter((entry) => !entry.button.hidden);
    const index = visible.indexOf(category);
    visible[(index + (event.key === "ArrowDown" ? 1 : -1) + visible.length) % visible.length].button.focus();
  });
}
activateSettingsCategory(vscode.getState()?.category ?? "general");
settingsBody.append(settingsContent, settingsToc);
settingsMain.append(settingsPageHead, settingsBody);
settingsShell.append(settingsNav, settingsMain);
root.appendChild(settingsShell);
const [generalCategory, fileCategory, rosterCategory, cliCategory, migrationCategory, workStageCategory] = settingsCategories.map((category) => category.panel);
const workStageCard = section(workStageCategory, l10n.t("Work stage"));
const workStageSwitch = switchButton("setting-work-stage-enabled");
const workStageText = row(workStageCard, l10n.t("Show the work stage"),
  l10n.t("A button in the chat opens a drawer that shows the conversation's work as a room. Turning this off closes the drawer in every chat."), workStageSwitch);
const workStageCast = createWorkStageCastSettings(workStageCategory, workStageCard, (setting, value) => {
  const requestId = nextRequestId();
  post({ type: "setWorkStageCast", requestId, setting, value });
  return requestId;
}, { row, rowNote, section });
const accentCard = section(generalCategory, appearanceSectionTitle());
const displayNameField = element("div", "settings-name-field");
const displayNameInput = element("input", "settings-input settings-name-input");
displayNameInput.id = "setting-display-name";
displayNameInput.type = "text";
displayNameInput.placeholder = l10n.t("You");
displayNameInput.spellcheck = false;
displayNameInput.autocomplete = "off";
displayNameInput.disabled = true;
const displayNameMeta = element("div", "settings-name-meta");
const displayNameCount = element("span", "settings-name-count");
displayNameCount.setAttribute("aria-hidden", "true");
const displayNameReset = element("button", "settings-link", l10n.t("Use the default"));
displayNameReset.id = "setting-display-name-reset";
displayNameReset.type = "button";
displayNameReset.disabled = true;
displayNameMeta.append(displayNameCount, displayNameReset);
displayNameField.append(displayNameInput, displayNameMeta);
const displayNameText = row(accentCard, l10n.t("Display name"), l10n.t("Shown instead of YOU in the chat, the YOU column and the decision and machine-check cards, and used as the user heading of the Markdown export. Leave empty to keep YOU. Up to {0} characters.", DISPLAY_NAME_MAX), displayNameField, () => displayNameInput);
displayNameText.querySelector("label")!.htmlFor = displayNameInput.id;
const displayNameRow = displayNameText.parentElement!;
displayNameRow.classList.add("settings-row-you");
const displayNameNotice = rowNote(displayNameText, "settings-row-note settings-name-notice", "");
displayNameNotice.setAttribute("role", "status");
displayNameNotice.setAttribute("aria-live", "polite");
displayNameInput.setAttribute("aria-labelledby", displayNameField.getAttribute("aria-labelledby")!);
displayNameInput.setAttribute("aria-describedby", `${displayNameField.getAttribute("aria-describedby")} ${displayNameNotice.id}`);
displayNameField.removeAttribute("aria-labelledby");
displayNameField.removeAttribute("aria-describedby");
displayNameRow.appendChild(displayNamePreview(displayNameText.querySelector(".settings-row-description")!.id));
let pendingDisplayName: number | null = null;
let queuedDisplayName: string | null = null;
let displayNameEdited = false;
function displayNamePreview(rowDescriptionId: string): HTMLElement {
  const preview = element("div", "settings-name-preview");
  preview.setAttribute("role", "group");
  const caption = element("div", "l-label settings-preview-caption", l10n.t("Where it appears"));
  caption.id = "setting-display-name-preview";
  preview.setAttribute("aria-labelledby", caption.id);
  const decision = l10n.t("Should it also mark todos hidden by the current filter?");
  const check = l10n.t("Check the footer buttons in the app");
  const conversation = element("div", "panel-conv");
  const user = element("div", "block user", l10n.t("Add a Mark all done button to the footer."));
  user.prepend(turnLabel(bindUserLabel(element("span", ""))));
  const card = (kind: "decide" | "check", title: string): HTMLElement => {
    const ask = element("div", "laisora-ask");
    ask.append(...askHeading(kind, title, ""));
    return ask;
  };
  const assistant = element("div", "block assistant");
  assistant.append(turnLabel(element("span", "", "Claude")), card("decide", decision), card("check", check));
  conversation.append(user, assistant);
  const chat = element("div", "settings-preview-chat");
  chat.append(element("div", "l-label settings-preview-place", l10n.t("Chat")), conversation);
  const markdown = element("div", "settings-preview-export");
  const markdownHeading = element("span", "settings-preview-md-name");
  const markdownLine = element("pre", "settings-preview-md");
  markdownLine.append(element("span", "settings-preview-md-mark", "## "), markdownHeading);
  markdown.append(element("div", "l-label settings-preview-place", l10n.t("Markdown export")), markdownLine);
  const left = element("div", "settings-preview-left");
  left.append(chat, markdown);
  const items: YouItem[] = [
    { id: "decide", kind: "decide", title: decision, createdAt: 0, anchor: { id: "decide" } },
    { id: "check", kind: "check", title: check, createdAt: 0, anchor: { id: "check" } },
  ];
  const youList = new YouList({ get: () => items, subscribe: () => () => {} }, () => {});
  const youColumn = element("div", "settings-preview-you");
  youColumn.append(element("div", "l-label settings-preview-place", l10n.t("YOU column")), youList.element);
  const description = element("p", "l-visually-hidden", l10n.t("A non-interactive sample."));
  description.id = "setting-display-name-preview-description";
  preview.setAttribute("aria-describedby", `${rowDescriptionId} ${description.id}`);
  const grid = element("div", "settings-preview-grid");
  grid.inert = true;
  grid.append(left, youColumn);
  preview.append(caption, description, grid);
  return preview;
}
function displayNameInputValue(): string {
  return normalizeDisplayName(displayNameInput.value);
}
function renderDisplayNameInput(): void {
  const length = displayNameLength(displayNameInputValue());
  displayNameCount.textContent = `${length} / ${DISPLAY_NAME_MAX}`;
  displayNameCount.classList.toggle("settings-name-count-full", length >= DISPLAY_NAME_MAX);
  displayNameReset.disabled = displayNameInput.disabled || displayNameInput.value === "";
  setDisplayName(displayNameInputValue());
  const markdownHeading = displayNameRow.querySelector(".settings-preview-md-name");
  if (markdownHeading) markdownHeading.textContent = displayNameInputValue() || "User";
}
displayNameInput.addEventListener("input", (event) => {
  displayNameEdited = true;
  if (!isComposingKey(event as InputEvent)) capNameInput(displayNameInput, displayNameNotice);
  renderDisplayNameInput();
});
displayNameInput.addEventListener("compositionend", () => {
  capNameInput(displayNameInput, displayNameNotice);
  renderDisplayNameInput();
});
function writeDisplayName(value: string): void {
  if (current === null) return;
  if (pendingDisplayName !== null) {
    queuedDisplayName = value;
    return;
  }
  if (value === (current.displayName ?? "")) return;
  pendingDisplayName = nextRequestId();
  post({ type: "setDisplayName", requestId: pendingDisplayName, value });
}
displayNameInput.addEventListener("change", () => {
  displayNameInput.value = displayNameInputValue();
  displayNameEdited = false;
  renderDisplayNameInput();
  writeDisplayName(displayNameInput.value);
});
displayNameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !isComposingKey(event)) displayNameInput.dispatchEvent(new Event("change"));
});
displayNameReset.addEventListener("click", () => {
  displayNameInput.value = "";
  displayNameNotice.textContent = "";
  displayNameEdited = false;
  renderDisplayNameInput();
  writeDisplayName("");
  displayNameInput.focus();
});
function renderDisplayName(state: SettingsState): void {
  if (pendingDisplayName === state.replyTo) {
    pendingDisplayName = null;
    const queued = queuedDisplayName;
    queuedDisplayName = null;
    if (queued !== null) writeDisplayName(queued);
  }
  displayNameInput.disabled = false;
  if (pendingDisplayName === null && !(displayNameEdited && document.activeElement === displayNameInput)) displayNameInput.value = state.displayName ?? "";
  renderDisplayNameInput();
}
const renderAccent = createAccentSettings(accentCard, (setting, value) => {
  const requestId = nextRequestId();
  post({ type: "setAccentSetting", requestId, setting, value });
  return requestId;
}, { row, rowNote });
const chatCard = section(generalCategory, l10n.t("Chat"));
const guardCard = section(generalCategory, l10n.t("Instruction and memory protection"));
const guardSwitch = switchButton("setting-guard-enabled");
const guardText = row(guardCard, l10n.t("Protect instruction files and memory"), l10n.t("Tells Claude where knowledge belongs, refuses notes about specific models in CLAUDE.md, rules and memory, keeps subagents from changing instruction, settings and hook files, and checks memory writes. Turn off to let Claude Code write these files as it normally does. Applies from the next conversation you start or resume."), guardSwitch);
const memoryBlockProjectTypeSwitch = switchButton("setting-memory-block-project-type");
const memoryBlockProjectTypeText = row(guardCard, l10n.t("Block project-type memory writes"), l10n.t("Stops writes of project-type memory (the state of ongoing work). When off, it can be written, but finished work or changed policies can remain in memory, and Claude may act on them as if they were still correct. Applies from the next conversation you start or resume."), memoryBlockProjectTypeSwitch);
const todoCard = section(generalCategory, "ToDo");
const todoSwitch = switchButton("setting-todo-enabled");
const todoText = row(todoCard, l10n.t("Enable ToDo"), l10n.t("The ToDo tab and drawer switch right away. Claude's ToDo tools are available from the next conversation you start or resume."), todoSwitch);

const handoffAutoTitle = l10n.t("Automatic handoff");
const handoffClosingSummaryLabel = l10n.t("After a handoff, summarize the continued work when it ends");
const handoffAutoCard = section(generalCategory, handoffAutoTitle);
type TextControl = HTMLInputElement | HTMLTextAreaElement;
interface EditedField {
  control: TextControl;
  saved: string;
  written: string | null;
  tried: string | null;
  request: number | null;
  invalid: string | null;
  commit: () => FieldCommit;
}
type FieldCommit = number | "invalid" | undefined;
let rosterRebuilding = false;
function editedField(control: TextControl, commit: () => FieldCommit): EditedField {
  const field: EditedField = { control, saved: control.value, written: null, tried: null, request: null, invalid: null, commit };
  bindEditedField(field, control);
  return field;
}
function fieldEditOf(field: EditedField): FieldEdit {
  return { text: field.control.value, dirty: field.control.value !== field.saved, written: field.written };
}
function bindEditedField(field: EditedField, control: TextControl): void {
  field.control = control;
  control.addEventListener("input", () => {
    if (field.control === control) field.tried = null;
  });
  const leave = (event: Event) => {
    if (field.control !== control || rosterRebuilding) return;
    if (fieldLeaveCommits(fieldEditOf(field), field.tried)) {
      field.tried = control.value;
      const result = field.commit();
      if (result === "invalid") field.invalid = control.value;
      else if (result !== undefined) {
        field.request = result;
        field.written = control.value;
      }
    }
    if (event.type !== "blur" || field.invalid !== control.value) return;
    field.invalid = null;
    field.tried = null;
    setTextKeepingSelection(control, field.saved);
  };
  control.addEventListener("change", leave);
  control.addEventListener("blur", leave);
}
function showEditedField(field: EditedField, saved: string, state: SettingsState): void {
  const reply: FieldReply = field.request === null || state.replyTo !== field.request ? "none" : state.writeFailure ? "failed" : "saved";
  if (reply !== "none") field.request = null;
  const next = settleFieldEdit(fieldEditOf(field), reply, saved);
  field.saved = saved;
  field.written = next.written;
  if (!next.dirty) {
    field.tried = null;
    field.invalid = null;
  }
  setTextKeepingSelection(field.control, next.text);
}
type TextSelection = { start: number; end: number; direction: "forward" | "backward" | "none" };
function selectionOf(control: Element | null): TextSelection | undefined {
  if (!(control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement)) return undefined;
  const { selectionStart, selectionEnd, selectionDirection } = control;
  return selectionStart === null || selectionEnd === null ? undefined : { start: selectionStart, end: selectionEnd, direction: selectionDirection ?? "none" };
}
function restoreSelection(control: TextControl, selection: TextSelection | undefined): void {
  if (selection === undefined || control.selectionStart === null) return;
  const length = control.value.length;
  control.setSelectionRange(Math.min(selection.start, length), Math.min(selection.end, length), selection.direction);
}
function setTextKeepingSelection(control: TextControl, text: string): void {
  if (control.value === text) return;
  const selection = document.activeElement === control ? selectionOf(control) : undefined;
  control.value = text;
  restoreSelection(control, selection);
}
function numberInput(id: string, min: number | undefined, max: number | undefined, step: string): HTMLInputElement {
  const input = element("input", "settings-input");
  input.id = id;
  input.type = "number";
  if (min !== undefined) input.min = String(min);
  if (max !== undefined) input.max = String(max);
  input.step = step;
  input.required = true;
  input.disabled = true;
  return input;
}
const handoffAutoModeSelect = select<HandoffAutoMode>([
  ["ratio", l10n.t("Share of the automatic compact amount")],
  ["tokens", l10n.t("Token count")],
]);
handoffAutoModeSelect.id = "setting-handoff-auto-mode";
const handoffAutoControls = {
  enabled: switchButton("setting-handoff-auto-enabled"),
  mode: handoffAutoModeSelect,
  percent: numberInput("setting-handoff-auto-percent", HANDOFF_AUTO_PERCENT_MIN, HANDOFF_AUTO_PERCENT_MAX, "1"),
  tokens: numberInput("setting-handoff-auto-tokens", HANDOFF_AUTO_TOKENS_MIN, undefined, "1"),
  continueWork: switchButton("setting-handoff-auto-continue-work"),
  closingSummary: switchButton("setting-handoff-auto-closing-summary"),
  cacheExpiryEnabled: switchButton("setting-handoff-cache-expiry-enabled"),
  closeSourceTab: switchButton("setting-handoff-close-source-tab"),
} satisfies Record<HandoffAutoSettingName, HTMLElement>;
const handoffAutoTexts: Record<HandoffAutoSettingName, HTMLElement> = {
  enabled: row(handoffAutoCard, l10n.t("Hand off automatically when the context is large"), l10n.t("When a conversation finishes its turn and is waiting with a context at or above the threshold below, hand it off to a new conversation. It starts only when nothing runs in the background, no message is waiting to be sent and the message box is empty, and at most once per conversation."), handoffAutoControls.enabled),
  mode: row(handoffAutoCard, l10n.t("Threshold"), l10n.t("Share: a share of the amount at which Claude Code compacts the conversation automatically. Token count: a fixed number of tokens, or that automatic compact amount if it is smaller."), handoffAutoControls.mode),
  percent: row(handoffAutoCard, l10n.t("Share"), HANDOFF_AUTO_PERCENT_MIN !== undefined && HANDOFF_AUTO_PERCENT_MAX !== undefined
    ? l10n.t("Percent of the automatic compact amount, from {0}% to {1}%.", HANDOFF_AUTO_PERCENT_MIN, HANDOFF_AUTO_PERCENT_MAX)
    : l10n.t("Percent of the automatic compact amount."), handoffAutoControls.percent),
  tokens: row(handoffAutoCard, l10n.t("Token count"), HANDOFF_AUTO_TOKENS_MIN !== undefined
    ? l10n.t("Context tokens, {0} or more.", HANDOFF_AUTO_TOKENS_MIN.toLocaleString(uiLocale()))
    : l10n.t("Token count"), handoffAutoControls.tokens),
  continueWork: row(handoffAutoCard, l10n.t("After an automatic handoff, continue unfinished work"), l10n.t("When a handoff that started automatically because of the context size completes and the previous conversation had an unfinished PLAN step and no unanswered decision, ask Claude in the new conversation to continue that work instead of waiting for your message. Claude does not start steps that wait for your approval and does not decide open decisions for you. A handoff before the prompt cache expires does not continue."), handoffAutoControls.continueWork),
  closingSummary: row(handoffAutoCard, handoffClosingSummaryLabel, l10n.t("Needs automatic handoff and continuing unfinished work. When the work Claude continued after an automatic handoff ends, or has completely stopped to wait for you with nothing still running, Claude ends its last reply with a short summary of the whole work since your last work instruction, including what the earlier conversations did. In a conversation linked to a ToDo item, Claude also writes it into the item's work memo. Applies from the next time LAISORA asks Claude to continue after an automatic handoff."), handoffAutoControls.closingSummary),
  cacheExpiryEnabled: row(handoffAutoCard, l10n.t("Hand off before the prompt cache expires"), l10n.t("When a waiting conversation's last reply was cached for 1 hour, work is unfinished (a PLAN step or an unanswered decision) and the context holds at least {0} tokens, hand it off {1} minutes before that cache expires unless you send a message first. The same background and message box conditions apply.", CACHE_EXPIRY_MIN_TOTAL_TOKENS.toLocaleString(uiLocale()), CACHE_EXPIRY_LEAD_MS / 60_000), handoffAutoControls.cacheExpiryEnabled),
  closeSourceTab: row(handoffAutoCard, l10n.t("Close the previous conversation's tab after a handoff"), l10n.t("When a handoff completes, manual or automatic, close the previous conversation's tab. It stays open when its message box holds unsent text or attachments, a turn is running or a message waits to be sent, background work (agents, commands, external runs) is running, or the handoff fails or is cancelled. Open it again from the handoff card or the history."), handoffAutoControls.closeSourceTab),
};
handoffAutoControls.percent.parentElement?.appendChild(element("span", "settings-input-unit", "%"));
function settingGroup<N extends string, V>(controls: Record<N, { disabled: boolean }>, isValue: (setting: N, value: V) => boolean,
  loaded: () => boolean, send: (requestId: number, setting: N, value: V) => void) {
  const pending = Object.fromEntries(Object.keys(controls).map((name) => [name, null])) as Record<N, number | null>;
  return {
    pending,
    request(setting: N, value: V): FieldCommit {
      if (!loaded() || pending[setting] !== null) return undefined;
      if (!isValue(setting, value)) {
        const control = controls[setting];
        if (control instanceof HTMLInputElement) control.reportValidity();
        return "invalid";
      }
      const requestId = nextRequestId();
      pending[setting] = requestId;
      controls[setting].disabled = true;
      send(requestId, setting, value);
      return requestId;
    },
    settle(replyTo: number | undefined): void {
      for (const name of Object.keys(pending) as N[]) if (pending[name] === replyTo) pending[name] = null;
    },
  };
}
const handoffAutoGroup = settingGroup<HandoffAutoSettingName, boolean | number | string>(handoffAutoControls, isHandoffAutoSettingValue,
  () => current?.handoffAuto !== undefined, (requestId, setting, value) => post({ type: "setHandoffAutoSetting", requestId, setting, value }));
const pendingHandoffAuto = handoffAutoGroup.pending;
const requestHandoffAutoSetting = handoffAutoGroup.request;
function renderHandoffAuto(state: SettingsState): void {
  const settings = state.handoffAuto;
  handoffAutoGroup.settle(state.replyTo);
  if (settings === undefined) return;
  const { enabled, mode, percent, tokens, cacheExpiryEnabled, continueWork, closingSummary, closeSourceTab } = handoffAutoControls;
  enabled.setAttribute("aria-checked", String(settings.enabled));
  enabled.disabled = pendingHandoffAuto.enabled !== null;
  mode.querySelector(".settings-option-unknown")?.remove();
  if (pendingHandoffAuto.mode === null) mode.value = settings.mode;
  mode.disabled = pendingHandoffAuto.mode !== null || !settings.enabled;
  showEditedField(handoffPercentField, String(settings.percent), state);
  percent.disabled = pendingHandoffAuto.percent !== null || !settings.enabled || settings.mode !== "ratio";
  showEditedField(handoffTokensField, String(settings.tokens), state);
  tokens.disabled = pendingHandoffAuto.tokens !== null || !settings.enabled || settings.mode !== "tokens";
  cacheExpiryEnabled.setAttribute("aria-checked", String(settings.cacheExpiryEnabled));
  cacheExpiryEnabled.disabled = pendingHandoffAuto.cacheExpiryEnabled !== null;
  continueWork.setAttribute("aria-checked", String(settings.continueWork));
  continueWork.disabled = pendingHandoffAuto.continueWork !== null || !settings.enabled;
  closingSummary.setAttribute("aria-checked", String(settings.closingSummary));
  closingSummary.disabled = pendingHandoffAuto.closingSummary !== null || !handoffContinuesWork(settings);
  closeSourceTab.setAttribute("aria-checked", String(settings.closeSourceTab));
  closeSourceTab.disabled = pendingHandoffAuto.closeSourceTab !== null;
}
handoffAutoControls.enabled.addEventListener("click", () => requestHandoffAutoSetting("enabled", current?.handoffAuto?.enabled !== true));
handoffAutoControls.cacheExpiryEnabled.addEventListener("click", () => requestHandoffAutoSetting("cacheExpiryEnabled", current?.handoffAuto?.cacheExpiryEnabled !== true));
handoffAutoControls.continueWork.addEventListener("click", () => requestHandoffAutoSetting("continueWork", current?.handoffAuto?.continueWork !== true));
handoffAutoControls.closingSummary.addEventListener("click", () => requestHandoffAutoSetting("closingSummary", current?.handoffAuto?.closingSummary !== true));
handoffAutoControls.closeSourceTab.addEventListener("click", () => requestHandoffAutoSetting("closeSourceTab", current?.handoffAuto?.closeSourceTab !== true));
handoffAutoControls.mode.addEventListener("change", () => requestHandoffAutoSetting("mode", handoffAutoControls.mode.value));
const handoffPercentField = editedField(handoffAutoControls.percent, () => requestHandoffAutoSetting("percent", handoffAutoControls.percent.valueAsNumber));
const handoffTokensField = editedField(handoffAutoControls.tokens, () => requestHandoffAutoSetting("tokens", handoffAutoControls.tokens.valueAsNumber));

const waitNotifyCard = section(generalCategory, l10n.t("Mobile notifications"));
const waitNotifyControls = {
  enabled: switchButton("setting-wait-notify-enabled"),
  minutes: numberInput("setting-wait-notify-minutes", WAIT_NOTIFY_MINUTES_MIN, WAIT_NOTIFY_MINUTES_MAX, "1"),
} satisfies Record<WaitNotifySettingName, HTMLElement>;
const waitNotifyTexts: Record<WaitNotifySettingName, HTMLElement> = {
  enabled: row(waitNotifyCard, l10n.t("Notify my phone when a conversation has waited for me too long"), l10n.t("Remote Control turns on only when a notification is needed and turns off again when you send a message or answer in LAISORA; Remote Control you turned on yourself stays on. When a conversation has ended its turn with an unanswered decision or check card, LAISORA turns Remote Control on after the minutes below and wakes Claude to send one notification to the Claude app, which uses a short Claude turn. When an approval or a question during a turn stays unanswered for a short while, Remote Control turns on so that Claude Code can notify at its own timing. Applies from the next conversation you start or resume."), waitNotifyControls.enabled),
  minutes: row(waitNotifyCard, l10n.t("Minutes before notifying"), WAIT_NOTIFY_MINUTES_MIN !== undefined && WAIT_NOTIFY_MINUTES_MAX !== undefined
    ? l10n.t("Counted from the end of the turn, from {0} to {1} minutes.", WAIT_NOTIFY_MINUTES_MIN, WAIT_NOTIFY_MINUTES_MAX)
    : l10n.t("Counted from the end of the turn."), waitNotifyControls.minutes),
};
const waitNotifyDescribedBy = waitNotifyControls.enabled.getAttribute("aria-describedby") ?? "";
const waitNotifyTelemetryHint = rowNote(waitNotifyTexts.enabled, "settings-row-hint", l10n.t("Unavailable because Claude Code's telemetry is disabled, and Claude Code cannot send phone notifications then. It is disabled while VS Code's telemetry.telemetryLevel setting is not \"all\" or while DISABLE_TELEMETRY is set for Claude Code. To use it, set telemetry.telemetryLevel to \"all\" and remove DISABLE_TELEMETRY."));
waitNotifyTelemetryHint.hidden = true;
const waitNotifyGroup = settingGroup<WaitNotifySettingName, boolean | number>(waitNotifyControls, isWaitNotifySettingValue,
  () => current?.waitNotify !== undefined, (requestId, setting, value) => post({ type: "setWaitNotifySetting", requestId, setting, value }));
const pendingWaitNotify = waitNotifyGroup.pending;
const requestWaitNotifySetting = waitNotifyGroup.request;
function renderWaitNotify(state: SettingsState): void {
  waitNotifyGroup.settle(state.replyTo);
  const settings = state.waitNotify;
  if (settings === undefined) return;
  const { enabled, minutes } = waitNotifyControls;
  const telemetryOff = state.waitNotifyTelemetryOff === true;
  enabled.setAttribute("aria-checked", String(settings.enabled));
  enabled.disabled = pendingWaitNotify.enabled !== null || telemetryOff;
  showEditedField(waitNotifyMinutesField, String(settings.minutes), state);
  minutes.disabled = pendingWaitNotify.minutes !== null || !settings.enabled;
  waitNotifyTelemetryHint.hidden = !telemetryOff;
  enabled.setAttribute("aria-describedby", telemetryOff ? `${waitNotifyDescribedBy} ${waitNotifyTelemetryHint.id}`.trim() : waitNotifyDescribedBy);
}
waitNotifyControls.enabled.addEventListener("click", () => requestWaitNotifySetting("enabled", current?.waitNotify?.enabled !== true));
const waitNotifyMinutesField = editedField(waitNotifyControls.minutes, () => requestWaitNotifySetting("minutes", waitNotifyControls.minutes.valueAsNumber));

const sendKeySelect = select<ComposerSendKey>([
  ["enter", "Enter"],
  ["shiftEnter", "Shift+Enter"],
]);
sendKeySelect.id = "setting-composer-send-key";
const sendKeyText = row(chatCard, l10n.t("Send shortcut"), l10n.t("Key that sends the message box contents. The other combination inserts a new line."), sendKeySelect);

const initialModelSelect = select<string>([]);
initialModelSelect.id = "setting-initial-model";
const initialModelText = row(chatCard, l10n.t("Initial model"), l10n.t("Choose a model for new and resumed conversations. A model chosen in a tab still wins. Off uses Claude's normal settings. Running conversations are unchanged."), initialModelSelect);
const initialModelNote = rowNote(initialModelText, "settings-row-note", "");
let pendingInitialModel: number | null = null;
function renderInitialModel(state: SettingsState): void {
  if (pendingInitialModel === state.replyTo) pendingInitialModel = null;
  if (pendingInitialModel !== null) return;
  const selected = state.initialModel ?? "";
  const list = state.externalModels.claude;
  const models = list?.state === "ok" ? list.models : [];
  initialModelSelect.replaceChildren();
  for (const model of [{ id: "", label: l10n.t("Off") }, ...models.filter(model => model.id !== "default")]) {
    const option = element("option", "", model.label);
    option.value = model.id;
    initialModelSelect.appendChild(option);
  }
  const missing = selected !== "" && !models.some(model => model.id === selected && model.id !== "default");
  if (missing) {
    const option = element("option", "", selected);
    option.value = selected;
    initialModelSelect.appendChild(option);
  }
  initialModelSelect.value = selected;
  initialModelSelect.disabled = false;
  initialModelNote.textContent = missing
    ? l10n.t("The configured model is not in the available list. New and resumed conversations will request this ID; Claude may reject it.")
    : list?.state !== "ok" ? modelsLoadingText() : "";
  if (!missing && list?.state === "failed") initialModelNote.textContent = modelListStatusText(list, state.externalDetection.claude);
  initialModelNote.hidden = !initialModelNote.textContent;
}
initialModelSelect.addEventListener("change", () => {
  if (pendingInitialModel !== null) return;
  pendingInitialModel = nextRequestId();
  initialModelSelect.disabled = true;
  post({ type: "setInitialModel", requestId: pendingInitialModel, model: initialModelSelect.value });
});

const restoreSwitch = element("button", "l-switch");
restoreSwitch.id = "setting-restore-tabs";
restoreSwitch.type = "button";
restoreSwitch.setAttribute("role", "switch");
restoreSwitch.disabled = true;
restoreSwitch.appendChild(element("span", "l-switch-thumb"));
const restoreText = row(
  chatCard,
  l10n.t("Restore tabs on startup"),
  l10n.t("Reopen the conversation tabs that were open when the window was last closed or reloaded. Tabs that never sent a message are not restored."),
  restoreSwitch
);
const eventLimitInput = element("input", "settings-input");
eventLimitInput.id = "setting-event-limit";
eventLimitInput.type = "number";
eventLimitInput.min = String(EVENT_LIMIT_MIN);
eventLimitInput.max = String(EVENT_LIMIT_MAX);
eventLimitInput.step = "1";
eventLimitInput.required = true;
eventLimitInput.disabled = true;
const eventLimitText = row(chatCard, l10n.t("Events kept per conversation"), l10n.t("The official Claude Code VS Code extension keeps about 600 chat rows. LAISORA keeps more because SUMMARY and ANALYSIS read the log. Higher values use more memory and make long conversations slower. Events older than the limit drop out of the live log."), eventLimitInput);
let pendingEventLimit: number | null = null;
const eventLimitField = editedField(eventLimitInput, () => {
  const value = eventLimitInput.valueAsNumber;
  if (pendingEventLimit !== null) return undefined;
  if (!isEventLimit(value)) {
    eventLimitInput.reportValidity();
    return "invalid";
  }
  pendingEventLimit = nextRequestId();
  eventLimitInput.disabled = true;
  post({ type: "setEventLimit", requestId: pendingEventLimit, value });
  return pendingEventLimit;
});
const retentionDaysInput = element("input", "settings-input");
retentionDaysInput.id = "setting-transcript-retention-days";
retentionDaysInput.type = "number";
retentionDaysInput.min = String(TRANSCRIPT_RETENTION_DAYS_MIN);
retentionDaysInput.step = "1";
retentionDaysInput.disabled = true;
const retentionDaysText = row(chatCard, l10n.t("Days to keep conversation records"), l10n.t("Each time Claude Code starts, it deletes conversation records of all projects older than this many days. Empty follows Claude Code's own setting, shown in the field. A number applies only to Claude Code started by LAISORA; Claude Code started from a terminal still deletes by ~/.claude/settings.json, so set the same value there to keep records longer."), retentionDaysInput);
let pendingRetentionDays: number | null = null;
function transcriptRetentionFallbackText(fallback: TranscriptRetentionFallback): string {
  if (fallback.source === "noUserSource") return l10n.t("No deletion");
  return fallback.source === "userSettings"
    ? l10n.t("{0} (~/.claude/settings.json)", fallback.days)
    : l10n.t("{0} (Claude Code default)", fallback.days);
}
const retentionDaysField = editedField(retentionDaysInput, () => {
  if (pendingRetentionDays !== null) return undefined;
  const value = retentionDaysInput.value.trim() === "" ? null : retentionDaysInput.valueAsNumber;
  if (retentionDaysInput.validity.badInput || value !== null && !isTranscriptRetentionDays(value)) {
    retentionDaysInput.reportValidity();
    return "invalid";
  }
  pendingRetentionDays = nextRequestId();
  retentionDaysInput.disabled = true;
  post({ type: "setTranscriptRetentionDays", requestId: pendingRetentionDays, value });
  return pendingRetentionDays;
});

const autoContinueSwitch = switchButton("setting-auto-continue-usage-limit");
row(chatCard, l10n.t("Resume automatically when the usage limit resets"), l10n.t("When the claude.ai usage limit stops a conversation, continue it automatically after the limit resets. The same setting is used by Claude Code in the terminal."), autoContinueSwitch);
const chromeIntegrationSwitch = switchButton("setting-chrome-integration");
row(chatCard, l10n.t("Use Claude in Chrome"), l10n.t("Let Claude use the Claude in Chrome extension, which acts in your Chrome. Needs the extension installed and connected. Applies to conversations started or resumed afterwards; running conversations are not changed."), chromeIntegrationSwitch);
const mcpElicitationSwitch = switchButton("setting-mcp-elicitation");
row(chatCard, l10n.t("Show input requests from MCP servers"), l10n.t("When an MCP server asks you for input or to open a page, show a card in the conversation to answer it. Off declines these requests automatically. Applies to conversations started or resumed afterwards; running conversations are not changed."), mcpElicitationSwitch);
const writesLostNoticeSwitch = switchButton("setting-writes-lost-notice");
row(chatCard, l10n.t("Show when the conversation record could not be saved"), l10n.t("When the disk was full or its quota was used up and Claude Code could not save part of the conversation record or its settings, show a notice in the conversation. When part of the conversation record was lost, that notice shows again when you reopen the conversation."), writesLostNoticeSwitch);
const editSummarySwitch = switchButton("setting-edit-summary-enabled");
const editSummaryText = row(chatCard, l10n.t("Show edited files after each reply"), l10n.t("At the end of each reply, list the files Claude edited in that turn with the lines added and removed. Click a file to compare it before and after the turn."), editSummarySwitch);
const remoteControlCardSwitch = switchButton("setting-remote-control-card");
const remoteControlCardText = row(chatCard, l10n.t("Show the Remote Control card"), l10n.t("When Remote Control turns on for a conversation, show a card in the conversation with the claude.ai link, the connection state and when the session is reachable. The card also shows when Remote Control turns off."), remoteControlCardSwitch);
const improvementMenuSwitch = switchButton("setting-improvement-menu");
const improvementMenuText = row(chatCard, l10n.t("Show “Start LLM improvement analysis” in the ☰ menu"), l10n.t("The item in each conversation's ☰ menu that counts recurring failures across all local Claude Code conversations and starts a new conversation where Claude analyses them."), improvementMenuSwitch);
const welcomeSwitches: Record<WelcomeSetting, HTMLButtonElement> = {
  showNews: switchButton("setting-welcome-show-news"),
  showTips: switchButton("setting-welcome-show-tips"),
};
const welcomeTexts: Record<WelcomeSetting, HTMLElement> = {
  showNews: row(chatCard, l10n.t("Show news on new conversations"), l10n.t("On a new conversation, show the new features and added settings of this LAISORA version until you close them with ×."), welcomeSwitches.showNews),
  showTips: row(chatCard, l10n.t("Show tips on new conversations"), l10n.t("On a new conversation, show one tip; each new conversation shows the next one. Closing the tip card with × turns this setting off."), welcomeSwitches.showTips),
};
const pendingWelcome: Record<WelcomeSetting, number | null> = { showNews: null, showTips: null };
function renderWelcomeSettings(state: SettingsState): void {
  for (const setting of Object.keys(welcomeSwitches) as WelcomeSetting[]) {
    if (pendingWelcome[setting] === state.replyTo) pendingWelcome[setting] = null;
    if (state.welcome === undefined) continue;
    welcomeSwitches[setting].setAttribute("aria-checked", String(state.welcome[setting]));
    welcomeSwitches[setting].disabled = pendingWelcome[setting] !== null;
  }
}
for (const setting of Object.keys(welcomeSwitches) as WelcomeSetting[]) {
  welcomeSwitches[setting].addEventListener("click", () => {
    if (current?.welcome === undefined || pendingWelcome[setting] !== null) return;
    const requestId = nextRequestId();
    pendingWelcome[setting] = requestId;
    welcomeSwitches[setting].disabled = true;
    post({ type: "setWelcomeSetting", requestId, setting, enabled: !current.welcome[setting] });
  });
}

const apiKeyGroup = element("div", "settings-segmented");
apiKeyGroup.id = "setting-api-key-policy";
apiKeyGroup.setAttribute("role", "radiogroup");
const apiKeyOptions: Array<[ApiKeyPolicy, string]> = [
  ["inherit", l10n.t("Inherit")],
  ["subscriptionOnly", l10n.t("Subscription only")],
];
const apiKeyRadios = apiKeyOptions.map(([value, text]) => {
  const radio = element("button", "settings-segment", text);
  radio.type = "button";
  radio.setAttribute("role", "radio");
  radio.dataset.value = value;
  radio.tabIndex = -1;
  radio.disabled = true;
  apiKeyGroup.appendChild(radio);
  return radio;
});
const checkedApiKeyRadio = (): HTMLButtonElement | undefined => apiKeyRadios.find((r) => r.getAttribute("aria-checked") === "true");
const apiKeyText = row(
  section(generalCategory, l10n.t("Authentication")),
  l10n.t("API key"),
  l10n.t("Inherit uses ANTHROPIC_API_KEY if it is set (billed to the API); Subscription only uses your signed-in subscription. Applies to conversations started afterwards."),
  apiKeyGroup,
  checkedApiKeyRadio
);

const fileLinkCard = section(fileCategory, l10n.t("File links"));
const fileLinkSwitches: Record<FileLinkBooleanSetting, HTMLButtonElement> = {
  fileLinkInstruction: switchButton("setting-file-link-instruction"),
  planInstruction: switchButton("setting-plan-instruction"),
  closingSummary: switchButton("setting-closing-summary"),
  chromeIntegration: chromeIntegrationSwitch,
  mcpElicitation: mcpElicitationSwitch,
  writesLostNotice: writesLostNoticeSwitch,
  revealInExplorer: switchButton("setting-file-link-reveal-in-explorer"),
  allowOutsideWorkspace: switchButton("setting-file-link-allow-outside"),
  confirmOutsideWorkspace: switchButton("setting-file-link-confirm-outside"),
  openOutsideReadOnly: switchButton("setting-file-link-outside-read-only"),
};
row(
  fileLinkCard,
  l10n.t("Ask Claude to write files as links"),
  l10n.t("Applies to conversations started or resumed afterwards. Running conversations are not changed, because changing the system prompt mid-conversation invalidates the prompt cache and the next reply would resend the whole conversation."),
  fileLinkSwitches.fileLinkInstruction
);
row(
  fileLinkCard,
  l10n.t("Ask Claude to show plans, decisions and checks"),
  l10n.t("Applies to conversations started or resumed afterwards. Running conversations are not changed, because changing the system prompt mid-conversation invalidates the prompt cache and the next reply would resend the whole conversation."),
  fileLinkSwitches.planInstruction
);
row(
  fileLinkCard,
  l10n.t("Ask Claude to summarize work when it ends"),
  l10n.t("When work you asked for in a conversation ends or stops to wait for you, Claude ends its last reply with a short summary: the result, what was done, what was verified and what was not, and what is left or waits for you. In a conversation linked to a ToDo item, Claude also writes it into the item's work memo. Work Claude continued after an automatic handoff follows \"{1}\" under \"{0}\" instead. Applies to conversations started or resumed afterwards.", handoffAutoTitle, handoffClosingSummaryLabel),
  fileLinkSwitches.closingSummary
);
row(
  fileLinkCard,
  l10n.t("Show the file in the Explorer"),
  l10n.t("When a link is clicked in the LAISORA editor tab, also selects the file in the Explorer. Links clicked in the side bar never do, because the Explorer would replace the conversation there."),
  fileLinkSwitches.revealInExplorer
);
const allowOutsideText = row(
  fileLinkCard,
  l10n.t("Open files outside the workspace"),
  l10n.t("Also opens file links that point outside the workspace and the conversation folder."),
  fileLinkSwitches.allowOutsideWorkspace
);
const refusedNote = rowNote(allowOutsideText, "settings-row-note", l10n.t("Network shares (UNC paths) and device paths are always refused and never become links."));
fileLinkSwitches.allowOutsideWorkspace.setAttribute(
  "aria-describedby",
  `${fileLinkSwitches.allowOutsideWorkspace.getAttribute("aria-describedby")} ${refusedNote.id}`
);
const outsideGroup = element("div", "settings-subgroup");
outsideGroup.setAttribute("role", "group");
outsideGroup.setAttribute("aria-labelledby", fileLinkSwitches.allowOutsideWorkspace.getAttribute("aria-labelledby") ?? "");
fileLinkCard.appendChild(outsideGroup);
const outsideChildren = ([
  ["confirmOutsideWorkspace", l10n.t("Ask before opening"), l10n.t("Shows the file path and asks before opening a file outside the workspace.")],
  ["openOutsideReadOnly", l10n.t("Open as read-only"), l10n.t("Files outside the workspace open in a read-only editor and cannot be saved. Files inside the workspace open normally.")],
] as const).map(([key, label, description]) => {
  const control = fileLinkSwitches[key];
  const text = row(outsideGroup, label, description, control);
  const describedBy = control.getAttribute("aria-describedby") ?? "";
  const hint = rowNote(text, "settings-row-hint", l10n.t("Available when \"Open files outside the workspace\" is on."));
  hint.hidden = true;
  return { control, describedBy, hint };
});

const extensionControl = element("div", "settings-extension-control");
extensionControl.setAttribute("role", "group");
const extensionChips = element("div", "settings-extension-chips");
const extensionInput = element("input", "settings-input");
extensionInput.id = "setting-system-app-extension";
extensionInput.disabled = true;
extensionInput.setAttribute("aria-label", l10n.t("File extension"));
const extensionAdd = element("button", "settings-segment", l10n.t("Add"));
extensionAdd.id = "setting-system-app-add";
extensionAdd.type = "button";
extensionAdd.disabled = true;
const extensionError = element("div", "settings-row-note");
extensionError.id = "setting-system-app-error";
extensionError.setAttribute("role", "alert");
extensionInput.setAttribute("aria-describedby", extensionError.id);
extensionControl.append(extensionChips, extensionInput, extensionAdd, extensionError);
const extensionText = row(fileLinkCard, l10n.t("Open with the default app"), l10n.t("Open these file extensions with the default app only inside the workspace and conversation folder."), extensionControl, () => extensionInput);
let pendingExtensions: number | null = null;
function writeSystemAppExtensions(value: string[]): void {
  if (current === null || pendingExtensions !== null) return;
  pendingExtensions = nextRequestId();
  post({ type: "setFileLinkSetting", requestId: pendingExtensions, setting: "openWithSystemApp", value });
}
function addSystemAppExtension(): void {
  if (current === null || pendingExtensions !== null) return;
  const extension = normalizeSystemAppExtension(extensionInput.value);
  if (extension === null) {
    extensionError.textContent = l10n.t("Enter a valid extension; executable and script extensions are not allowed.");
    return;
  }
  extensionError.textContent = "";
  extensionInput.value = "";
  writeSystemAppExtensions([...new Set([...current.openWithSystemApp, extension])]);
}
extensionAdd.addEventListener("click", addSystemAppExtension);
extensionInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); addSystemAppExtension(); }
});
function renderSystemAppExtensions(state: SettingsState): void {
  if (pendingExtensions === state.replyTo) pendingExtensions = null;
  extensionInput.disabled = extensionAdd.disabled = pendingExtensions !== null;
  extensionChips.replaceChildren();
  for (const extension of state.openWithSystemApp) {
    const chip = element("span", "settings-extension-chip", extension);
    const remove = element("button", "settings-segment", CLOSE_GLYPH);
    remove.type = "button";
    remove.setAttribute("aria-label", l10n.t("Remove {0}", extension));
    remove.disabled = pendingExtensions !== null;
    remove.addEventListener("click", () => writeSystemAppExtensions(state.openWithSystemApp.filter((item) => item !== extension)));
    chip.appendChild(remove);
    extensionChips.appendChild(chip);
  }
}

const orchestrationCard = element("div", "settings-card");
rosterCategory.appendChild(orchestrationCard);
const orchestrationSwitch = switchButton("setting-orchestration-enabled");
const orchestrationText = row(orchestrationCard, l10n.t("Enable the agent roster"), l10n.t("Changes apply from the next session. The roster of running conversations will not change."), orchestrationSwitch);
const orchestrationNote = orchestrationText.querySelector<HTMLElement>(".settings-row-description")!;
orchestrationNote.id = "orchestration-note";
const recommendButton = element("button", "settings-segment", l10n.t("Run"));
recommendButton.id = "setting-recommended-roster";
recommendButton.type = "button";
recommendButton.disabled = true;
recommendButton.setAttribute("aria-expanded", "false");
const recommendText = row(orchestrationCard, l10n.t("Roster suggestion"), "", recommendButton);
const recommendSame = element("span", "settings-row-description", l10n.t("The roster already matches the suggestion."));
recommendSame.id = "setting-recommended-same";
recommendSame.hidden = true;
recommendButton.before(recommendSame);
const recommendPanel = element("div", "settings-recommend");
recommendPanel.id = "setting-recommended-panel";
recommendPanel.hidden = true;
recommendPanel.setAttribute("role", "region");
const recommendHeading = element("div", "l-label", l10n.t("Review the changes"));
recommendHeading.id = "setting-recommended-heading";
recommendPanel.setAttribute("aria-labelledby", recommendHeading.id);
recommendButton.setAttribute("aria-controls", recommendPanel.id);
const recommendBody = element("div", "settings-recommend-scroll");
const recommendNote = element("p", "settings-row-description", l10n.t("Rows other than Claude are not changed."));
const recommendApply = element("button", "settings-segment settings-primary", l10n.t("Confirm"));
recommendApply.id = "setting-recommended-apply";
recommendApply.type = "button";
const recommendCancel = element("button", "settings-segment", l10n.t("Not now"));
recommendCancel.id = "setting-recommended-cancel";
recommendCancel.type = "button";
const recommendActions = element("div", "settings-recommend-actions");
recommendActions.append(recommendApply, recommendCancel);
recommendPanel.append(recommendHeading, recommendBody, recommendNote, recommendActions);
orchestrationCard.appendChild(recommendPanel);
let recommendSource: string | null = null;
let recommendRevision: string | null = null;
let pendingRecommend: number | null = null;
function requestRecommendation(): void {
  if (!current) return;
  recommendSource = JSON.stringify(current.orchestrationAgents);
  post({ type: "proposeRecommendedRoster" });
}
function closeRecommendation(): void {
  recommendSource = null;
  recommendRevision = null;
  recommendPanel.hidden = true;
  recommendButton.setAttribute("aria-expanded", "false");
}
recommendButton.addEventListener("click", () => {
  if (recommendButton.disabled) return;
  recommendButton.setAttribute("aria-expanded", "true");
  requestRecommendation();
});
recommendCancel.addEventListener("click", () => { closeRecommendation(); recommendButton.focus(); });
recommendApply.addEventListener("click", () => {
  if (!current || pendingOrchestration !== null || recommendApply.disabled || recommendRevision === null) return;
  const revision = recommendRevision;
  recommendRevision = null;
  const requestId = nextRequestId();
  pendingOrchestration = requestId;
  pendingRecommend = requestId;
  settingsRosterFocus = { id: recommendButton.id };
  lockOrchestration();
  post({ type: "applyRecommendedRoster", requestId, revision });
});
const RECOMMEND_CHANGE_TEXT: Record<RecommendedRosterChange["change"], string> = {
  same: l10n.t("No change"), add: l10n.t("Add"), remove: l10n.t("Drop"), change: l10n.t("Change it"),
};
function renderRecommendation(revision: string, changes: readonly RecommendedRosterChange[]): void {
  if (recommendSource === null || !current) return;
  recommendRevision = revision;
  if (changes.every((change) => change.change === "same")) {
    closeRecommendation();
    return;
  }
  const claudeChoices = EXECUTORS.claude.models(current.externalModels.claude);
  const modelLabel = (model: string) => claudeChoices?.find((choice) => choice.model === model)?.label ?? model;
  const efforts = (list: readonly string[]) => list.length ? list.join(" · ") : "―";
  const table = element("table", "settings-recommend-table");
  const head = element("tr", "");
  for (const title of ["Role", "Model", l10n.t("Now"), "", l10n.t("Suggested"), l10n.t("Difference")]) {
    const cell = element("th", "", title);
    cell.scope = "col";
    head.appendChild(cell);
  }
  const body = element("tbody", "");
  for (const change of changes) {
    const line = element("tr", change.change === "remove" ? "settings-recommend-removed" : "");
    const struck = (text: string) => {
      const cell = element("td", "");
      cell.appendChild(change.change === "remove" ? element("s", "", text) : document.createTextNode(text));
      return cell;
    };
    line.append(element("td", "settings-mono", change.role), struck(modelLabel(change.model)), struck(efforts(change.current)),
      element("td", "settings-recommend-muted", "→"), element("td", "", efforts(change.recommended)),
      element("td", change.change === "same" ? "settings-recommend-muted" : "", RECOMMEND_CHANGE_TEXT[change.change]));
    body.appendChild(line);
  }
  const thead = element("thead", "");
  thead.appendChild(head);
  table.append(thead, body);
  recommendBody.replaceChildren(table);
  recommendPanel.hidden = false;
}
function renderRecommendedState(state: SettingsState): void {
  if (pendingRecommend !== null && pendingRecommend === state.replyTo) {
    pendingRecommend = null;
    if (!state.writeFailure && recommendRevision === null) closeRecommendation();
  }
  const busy = pendingOrchestration !== null && pendingOrchestration !== state.replyTo;
  const same = state.recommendedRosterSame === true;
  recommendSame.hidden = !same || !state.orchestrationEnabled;
  recommendButton.setAttribute("aria-describedby", same ? recommendSame.id : recommendText.querySelector(".settings-row-description")!.id);
  if (same) closeRecommendation();
  recommendButton.disabled = !state.orchestrationEnabled || busy || same;
  recommendApply.disabled = !state.orchestrationEnabled || busy;
  recommendCancel.disabled = false;
  if (!state.orchestrationEnabled) closeRecommendation();
  else if (recommendSource !== null && recommendSource !== JSON.stringify(state.orchestrationAgents)) requestRecommendation();
}
const rosterRows = element("div", "settings-roster-rows");
const rosterCacheNote = element("p", "settings-row-description");
rosterCacheNote.hidden = true;
const rosterPricePanel = element("div", "settings-recommend settings-price-table");
rosterPricePanel.id = "setting-roster-prices";
rosterPricePanel.hidden = true;
rosterCategory.append(rosterCacheNote, rosterPricePanel, rosterRows);
const tokenCount = (value: number) => new Intl.NumberFormat(uiLocale(), { notation: "compact" }).format(value);
const priceNumber = (value: number) => value.toLocaleString("en-US", { minimumFractionDigits: Number.isInteger(value) ? 0 : 2, maximumFractionDigits: 4 });
function renderRosterPrices(state: SettingsState): void {
  const prices = deriveRosterPriceRows(state.orchestrationEnabled, state.orchestrationAgents, state.externalModels);
  rosterCacheNote.textContent = l10n.t("Prompt cache applies to Claude agents only. 1 hour bills cache writes at {0}x the input price (5 min: {1}x); reads cost the same for both. {2}", PROMPT_CACHE_WRITE_MULTIPLIER["1h"], PROMPT_CACHE_WRITE_MULTIPLIER["5m"],
    prices.length ? l10n.t("The table below shows official prices as of {0}.", PROMPT_CACHE_PRICES_CHECKED_ON) : l10n.t("Official prices as of {0}.", PROMPT_CACHE_PRICES_CHECKED_ON));
  rosterPricePanel.hidden = prices.length === 0;
  if (!prices.length) { rosterPricePanel.replaceChildren(); return; }
  const heading = element("div", "l-label", l10n.t("Prices of the models in the roster (USD per 1M tokens)"));
  heading.id = "setting-roster-prices-heading";
  const table = element("table", "settings-recommend-table");
  table.setAttribute("aria-labelledby", heading.id);
  const head = element("tr", "");
  const headers: Array<[string, string?]> = [["Model"], [l10n.t("Input")], [l10n.t("Write"), l10n.t("5 min")], [l10n.t("Write"), l10n.t("1 hour")], [l10n.t("Read")], [l10n.t("Output")]];
  headers.forEach(([title, sub], column) => {
    const cell = element("th", column ? "settings-price-number" : "", title);
    cell.scope = "col";
    if (sub) cell.append(" ", element("span", "settings-price-sub", sub));
    head.appendChild(cell);
  });
  const thead = element("thead", "");
  thead.appendChild(head);
  const body = element("tbody", "");
  for (const price of prices) {
    const line = element("tr", "");
    const name = element("th", price.aboveTokens ? "settings-price-tier" : "", price.aboveTokens ? l10n.t("Over {0} tokens", tokenCount(price.aboveTokens)) : price.name);
    name.scope = "row";
    line.appendChild(name);
    for (const value of price.prices) line.appendChild(element("td", "settings-price-number", priceNumber(value)));
    body.appendChild(line);
  }
  table.append(thead, body);
  const scroll = element("div", "settings-recommend-scroll");
  scroll.appendChild(table);
  const externalNote = l10n.t("{0} rows do not use Claude usage, so they are not in the table.",
    new Intl.ListFormat(uiLocale(), { type: "conjunction" }).format(EXTERNAL_EXECUTORS.map((definition) => definition.displayName)));
  const footnote = element("p", "settings-row-description", prices.reduceRight((rest, price) => price.aboveTokens
    ? l10n.t("{0} uses the lower row's prices when the prompt exceeds {1} tokens. {2}", price.name, tokenCount(price.aboveTokens), rest) : rest, externalNote));
  rosterPricePanel.replaceChildren(heading, scroll, footnote);
}
const addGroup = element("div", "settings-roster-actions");
const roleField = element("div", "settings-role-field");
const roleInput = element("input", "settings-input");
roleInput.id = "setting-new-role";
roleInput.type = "text";
roleInput.disabled = true;
const roleLabel = element("label", "settings-row-label", "Role");
roleLabel.htmlFor = roleInput.id;
roleLabel.id = "setting-new-role-label";
roleInput.setAttribute("aria-labelledby", roleLabel.id);
const addButton = element("button", "settings-segment", l10n.t("Add"));
addButton.id = "setting-add-role";
addButton.type = "button";
addButton.disabled = true;
const defaultsButton = element("button", "settings-segment", l10n.t("Delete added roles"));
defaultsButton.id = "setting-restore-roster";
defaultsButton.type = "button";
defaultsButton.disabled = true;
const roleError = element("p", "settings-row-note");
roleError.id = "setting-role-error";
roleError.setAttribute("role", "alert");
roleInput.setAttribute("aria-describedby", roleError.id);
roleField.append(roleLabel, roleInput);
addGroup.append(roleField, addButton, defaultsButton);
rosterCategory.append(addGroup, roleError);
const policyCard = element("div", "settings-card settings-policy-card");
const policyInput = element("textarea", "settings-input settings-policy");
policyInput.id = "setting-conductor-policy";
policyInput.rows = 8;
policyInput.disabled = true;
const policyLabel = element("label", "settings-row-label", l10n.t("Conductor policy"));
policyLabel.htmlFor = policyInput.id;
const policyDefaultsButton = element("button", "settings-segment", l10n.t("Use the proposed policy"));
policyDefaultsButton.id = "setting-restore-policy";
policyDefaultsButton.type = "button";
policyDefaultsButton.disabled = true;
const policyHeader = element("div", "settings-detection-header");
policyHeader.append(policyLabel, policyDefaultsButton);
const policyHelp = element("p", "settings-row-description", l10n.t("Optional. Free-form rules for the conductor, e.g. always send reviews to an independent agent."));
policyHelp.id = "setting-policy-help";
const policyProposal = element("p", "settings-muted", l10n.t("Proposed by LAISORA; edit freely."));
policyProposal.id = "setting-policy-proposal";
const policyCounter = element("p", "settings-muted");
policyCounter.id = "setting-conductor-policy-counter";
policyCounter.setAttribute("aria-live", "polite");
policyInput.setAttribute("aria-describedby", `${policyHelp.id} ${policyProposal.id} ${policyCounter.id}`);
policyCard.append(policyHeader, policyHelp, policyInput, policyProposal, policyCounter);
renderPolicyCounter("", "");
const instructionDetails = element("details", "settings-instruction-details");
const instructionPreview = element("pre", "settings-instruction-preview");
instructionPreview.id = "setting-conductor-preview";
instructionPreview.tabIndex = 0;
const instructionTokens = element("p", "settings-muted");
instructionTokens.id = "setting-conductor-tokens";
instructionDetails.append(element("summary", "", l10n.t("Review what the conductor receives")), element("p", "settings-muted", l10n.t("Changes apply at the next normal connection start.")), instructionTokens, instructionPreview);
rosterCategory.append(policyCard, instructionDetails);
const externalBlock = element("section", "settings-section settings-environment");
externalBlock.id = "orchestration-environment";
const externalHeading = element("h2", "settings-section-title", l10n.t("Installed CLIs"));
externalHeading.id = "external-clis-heading";
externalBlock.setAttribute("aria-labelledby", externalHeading.id);
const detectionCard = element("div", "settings-card");
const detectionHeader = element("div", "settings-detection-header");
const externalRecheck = element("button", "settings-segment", l10n.t("Re-check"));
externalRecheck.id = "setting-recheck-external";
externalRecheck.type = "button";
externalRecheck.disabled = true;
externalRecheck.addEventListener("click", () => post({ type: "recheckExternalExecutors" }));
detectionHeader.append(externalHeading, externalRecheck);
const detectionControls = Object.values(EXECUTORS).map(({ id: executor }) => {
  const badge = element("span", "settings-detection-badge");
  badge.id = `external-status-${executor}`;
  const autoUpdate = switchButton(`setting-${executor}-auto-update`);
  const switchName = l10n.t("Update {0} automatically", externalExecutorName(executor));
  autoUpdate.title = switchName;
  const text = row(detectionCard, externalExecutorName(executor), "", autoUpdate);
  text.parentElement!.id = `external-detection-${executor}`;
  const nameLine = element("div", "settings-cli-name");
  text.querySelector("label")!.replaceWith(nameLine);
  nameLine.append(element("span", "settings-row-label", externalExecutorName(executor)), badge);
  autoUpdate.removeAttribute("aria-labelledby");
  autoUpdate.setAttribute("aria-label", switchName);
  const modelNote = element("div", "settings-row-description settings-model-list-note");
  text.appendChild(modelNote);
  return { executor, badge, autoUpdate, text, description: text.querySelector<HTMLElement>(".settings-row-description")!, modelNote };
});
const timeoutGroup = element("div", "settings-timeout-control");
timeoutGroup.id = "setting-timeout-group";
const externalTimeout = element("input", "settings-input");
externalTimeout.id = "setting-external-timeout";
externalTimeout.type = "number";
externalTimeout.min = String(EXTERNAL_TIMEOUT_MIN_MINUTES);
externalTimeout.max = String(EXTERNAL_TIMEOUT_MAX_MINUTES);
externalTimeout.step = "any";
externalTimeout.disabled = true;
timeoutGroup.append(externalTimeout, element("span", "", "min"));
const timeoutText = row(detectionCard, l10n.t("Wait limit per run"), l10n.t("External CLIs that exceed this limit are terminated and recorded as timed out."), timeoutGroup, () => externalTimeout);
timeoutText.querySelector("label")!.htmlFor = externalTimeout.id;
externalTimeout.setAttribute("aria-labelledby", timeoutText.querySelector("label")!.id);
externalTimeout.setAttribute("aria-describedby", timeoutText.querySelector(".settings-row-description")!.id);
externalBlock.append(detectionHeader, element("p", "settings-row-description settings-environment-help", l10n.t("CLIs installed on this PC. Conversations use Claude; agent roster rows can also use Antigravity and Codex. With a row's switch on, LAISORA updates that CLI in the background once a conversation is ready and no turn is running (Antigravity and Codex also wait for external runs to finish). Claude Code: native install only, following its own update settings. Codex and Antigravity: only the copy from their own installer.")), detectionCard);
cliCategory.appendChild(externalBlock);
const externalTimeoutField = editedField(externalTimeout, () => {
  const value = Number(externalTimeout.value);
  if (isExternalTimeout(value)) return writeOrchestration("externalTimeoutMinutes", value);
  externalTimeout.reportValidity();
  return "invalid";
});

function settingsProbeReason(reason: string): string {
  if (reason === "timeout") return l10n.t("no response");
  if (reason === "empty-output") return l10n.t("no output");
  if (reason.startsWith("exit:")) return l10n.t("exit code {0}", reason.slice(5));
  return l10n.t("cannot start ({0})", reason.slice("spawn-error:".length));
}
function renderExternal(state: SettingsState): void {
  for (const { executor, badge, description, modelNote } of detectionControls) {
    const detected = state.externalDetection[executor];
    badge.textContent = detected.state === "checking" ? l10n.t("… Checking") : detected.state === "notInstalled" ? l10n.t("– Not installed")
      : detected.state === "failed" ? l10n.t("! Check failed") : l10n.t("✓ Found");
    description.textContent = "";
    if (detected.state === "found" || detected.state === "failed") {
      description.textContent = detected.path;
      if (detected.state === "failed") description.textContent += ` · ${settingsProbeReason(detected.reason)}`;
      else {
        if (detected.version) description.textContent += ` · ${detected.version}`;
        if (detected.versionNote) description.textContent += ` ${l10n.t("(version check failed: {0})", settingsProbeReason(detected.versionNote))}`;
      }
    }
    const list = state.externalModels[executor];
    modelNote.textContent = modelListStatusText(list, detected);
    modelNote.hidden = !modelNote.textContent;
  }
  externalRecheck.disabled = Object.values(EXECUTORS).some(({ id }) => state.externalDetection[id].state === "checking"
    || state.externalModels[id].state === "checking" || state.externalModels[id].state === "ok" && state.externalModels[id].refresh === "checking");
  externalTimeout.disabled = false;
  showEditedField(externalTimeoutField, String(state.externalTimeoutMinutes), state);
}
let pendingOrchestration: number | null = null;
type OrchestrationFocus = { role: string; suffix: string } | { id: string };
let settingsRosterFocus: OrchestrationFocus | undefined;
function orchestrationFocus(): OrchestrationFocus | undefined {
  const active = document.activeElement;
  if (!active?.id || ![rosterCategory, cliCategory].some((category) => category.contains(active))) return undefined;
  const role = active.closest(".settings-role-card")?.getAttribute("aria-label");
  const suffix = /^roster-\d+-(.+)$/.exec(active.id)?.[1];
  return role && suffix ? { role, suffix } : { id: active.id };
}
function orchestrationFocusTarget(focus: OrchestrationFocus, agents: readonly OrchestrationSettingRow[]): HTMLElement | null {
  if ("id" in focus) return document.getElementById(focus.id);
  const index = agents.findIndex((entry) => entry.role === focus.role);
  return index < 0 ? null : document.getElementById(`roster-${index}-${focus.suffix}`);
}
const settingsRosterDrafts = new Map<string, ExecutorRow>();
const rosterFields = new Map<string, EditedField & { whenGone?: (state: SettingsState, text: string) => void }>();
const goneRosterEdits: Array<(state: SettingsState) => void> = [];

function writeOrchestration(setting: "enabled" | "agents" | "conductorPolicy" | "externalTimeoutMinutes", value: unknown): number | undefined {
  if (!current || pendingOrchestration !== null) return undefined;
  const requestId = nextRequestId();
  pendingOrchestration = requestId;
  settingsRosterFocus = orchestrationFocus();
  lockOrchestration();
  post({ type: "setOrchestrationSetting", requestId, setting, value });
  return requestId;
}
function writeRoster(rows: readonly OrchestrationSettingRow[]): number | undefined {
  return writeOrchestration("agents",rows.map((entry) => ({ ...entry, rows: entry.rows.map((rosterRow) => ({ ...rosterRow, efforts: canonicalExecutorEfforts(rosterRow.executor, rosterRow.efforts) })) })));
}
function lockOrchestration(): void {
  if (pendingOrchestration !== null) {
    externalTimeout.disabled = true;
    rosterCategory.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("button, input, textarea, select").forEach((control) => { control.disabled = true; });
  }
}
function settingsHiddenLabel(control: HTMLElement, title: string): HTMLLabelElement {
  const label = element("label", "l-visually-hidden", title);
  label.htmlFor = control.id;
  return label;
}
function renderPolicyCounter(text = policyInput.value, defaultPolicy = current?.conductorPolicyDefault ?? ""): void {
  const count = Array.from(text).length;
  const warning = count > 1500 && count > Array.from(defaultPolicy).length;
  policyCounter.classList.toggle("settings-policy-warning", warning);
  policyCounter.textContent = l10n.t("{0} characters", count)
    + (warning ? " " + l10n.t("Long policies are sent with every conversation start; keep it short.") : "");
}
function renderPolicyDefaults(state: SettingsState): void {
  policyDefaultsButton.disabled = !state.orchestrationEnabled || pendingOrchestration !== null || policyInput.value === state.conductorPolicyDefault;
}
let previewRequest = 0;
function renderInstructionPreview(state: SettingsState): void {
  instructionPreview.textContent = state.conductorPreview?.text ?? "";
  instructionTokens.textContent = l10n.t("≈ {0} tokens", state.conductorPreview?.tokens ?? 0);
}
function requestInstructionPreview(): void {
  previewRequest = nextRequestId();
  post({ type: "previewConductorInstruction", requestId: previewRequest, policy: policyInput.value });
}

function renderOrchestration(state: SettingsState): void {
  renderRecommendedState(state);
  if (pendingOrchestration === state.replyTo) pendingOrchestration = null;
  for (const role of settingsRosterDrafts.keys()) {
    if (!state.orchestrationEnabled || !state.orchestrationAgents.some((entry) => entry.role === role)) settingsRosterDrafts.delete(role);
  }
  orchestrationSwitch.disabled = false;
  orchestrationSwitch.setAttribute("aria-checked", String(state.orchestrationEnabled));
  const focus = settingsRosterFocus ?? orchestrationFocus();
  const focusSelection = selectionOf(document.activeElement);
  const seenRosterFields = new Set<string>();
  rosterRebuilding = true;
  try {
    rosterRows.replaceChildren();
  } finally {
    rosterRebuilding = false;
  }
  rosterCacheNote.hidden = state.orchestrationAgents.length === 0;
  renderRosterPrices(state);
  state.orchestrationAgents.forEach((entry, index) => {
    const card = element("div", "settings-card settings-role-card");
    const controlsDisabled = !state.orchestrationEnabled || !entry.enabled;
    card.classList.toggle("settings-disabled", controlsDisabled);
    card.setAttribute("role", "group");
    card.setAttribute("aria-label", entry.role);
    const update = (patch: Partial<OrchestrationSettingRow>) => writeRoster(state.orchestrationAgents.map((item, i) => i === index ? { ...item, ...patch } : item));
    const header = element("div", "settings-role-header");
    const role = element("span", "settings-mono settings-role-name", entry.role);
    const goldenRule = entry.role === "worker"
      ? l10n.t("Writes and fixes code. Keep both a light and a heavy model so simple work stays cheap and hard work gets done.")
      : entry.role === "explorer"
        ? l10n.t("Reads files to investigate. It never edits, so cheap models are enough.")
        : entry.role === "reviewer"
          ? l10n.t("Judges a finished change or a design. It looks with eyes other than the author's, so use opus, Antigravity or Codex.") : undefined;
    if (goldenRule) {
      role.title = goldenRule;
      const accessibleRule = element("span", "l-visually-hidden", goldenRule);
      accessibleRule.id = `roster-${index}-golden-rule`;
      role.setAttribute("aria-describedby", accessibleRule.id);
      header.appendChild(accessibleRule);
    }
    const remove = element("button", "settings-link", l10n.t("Remove"));
    remove.id = `roster-${index}-remove`;
    remove.type = "button";
    remove.setAttribute("aria-label", l10n.t("Remove {0}", entry.role));
    remove.disabled = controlsDisabled;
    remove.addEventListener("click", () => writeRoster(state.orchestrationAgents.filter((_, i) => i !== index)));
    const enabled = switchButton(`roster-${index}-enabled`);
    enabled.setAttribute("aria-checked", String(entry.enabled));
    enabled.setAttribute("aria-label", l10n.t("Enable {0}", entry.role));
    enabled.disabled = !state.orchestrationEnabled;
    enabled.addEventListener("click", () => update({ enabled: !entry.enabled }));
    header.append(role, remove, enabled);
    const description = element("input", "settings-input settings-role-description");
    description.id = `roster-${index}-description`;
    description.type = "text";
    description.value = entry.description;
    description.disabled = controlsDisabled;
    rosterField(`description:${entry.role}`, description, entry.description, state, seenRosterFields, () => update({ description: description.value }));
    card.append(header, settingsHiddenLabel(description, l10n.t("Description")), description);
    const cacheGroup = element("div", "settings-segmented");
    cacheGroup.id = `roster-${index}-cache-ttl`;
    cacheGroup.setAttribute("role", "radiogroup");
    const cacheTtl = resolveOrchestrationCacheTtl(entry);
    const cacheDisabled = controlsDisabled || !entry.rows.some(usesClaudeUsage);
    const cacheOptions: Array<[NonNullable<OrchestrationSettingRow["cacheTtl"]>, string]> = [
      ["5m", l10n.t("5 min")],
      ["1h", l10n.t("1 hour")],
    ];
    const cacheRadios = cacheOptions.map(([value, text]) => {
      const radio = element("button", "settings-segment", text);
      radio.id = `roster-${index}-cache-ttl-${value}`;
      radio.type = "button";
      radio.setAttribute("role", "radio");
      radio.setAttribute("aria-checked", String(value === cacheTtl));
      radio.tabIndex = value === cacheTtl ? 0 : -1;
      radio.disabled = cacheDisabled;
      radio.addEventListener("click", () => {
        if (!cacheDisabled && pendingOrchestration === null && value !== cacheTtl) update({ cacheTtl: value });
      });
      cacheGroup.appendChild(radio);
      return radio;
    });
    cacheGroup.addEventListener("keydown", (event) => {
      if (cacheDisabled || pendingOrchestration !== null) return;
      handleSegmentedArrow(event, cacheRadios, (radio) => radio.click());
    });
    const cacheText = row(card, l10n.t("Prompt cache"), "", cacheGroup, () => cacheRadios.find((radio) => radio.getAttribute("aria-checked") === "true"));
    cacheText.parentElement!.classList.add("settings-cache-row");
    const cacheLabel = settingsHiddenLabel(cacheGroup, l10n.t("Prompt cache for {0}", entry.role));
    cacheLabel.id = `roster-${index}-cache-label`;
    cacheGroup.setAttribute("aria-labelledby", cacheLabel.id);
    cacheText.appendChild(cacheLabel);
    const wrapper = element("div", "settings-matrix-wrapper");
    wrapper.tabIndex = 0;
    wrapper.setAttribute("role", "group");
    wrapper.setAttribute("aria-label", `${entry.role} Model / Effort`);
    const matrix = element("div", "settings-matrix");
    const draft = settingsRosterDrafts.get(entry.role);
    const visibleRows = draft ? [...entry.rows, draft] : entry.rows;
    visibleRows.forEach((executorRow, rowIndex) => {
      const definition = EXECUTORS[executorRow.executor];
      const rowServed = executorServesRole(entry.role, executorRow.executor);
      const isDraft = rowIndex === entry.rows.length;
      const updateRow = (patch: Partial<ExecutorRow>): number | undefined => {
        if (controlsDisabled || pendingOrchestration !== null) return undefined;
        const nextRow = { ...executorRow, ...patch };
        if (isDraft) {
          if (!nextRow.model) {
            settingsRosterDrafts.set(entry.role, nextRow);
            renderOrchestration(state);
            return undefined;
          }
          settingsRosterDrafts.delete(entry.role);
          return update({ rows: [...entry.rows, nextRow] });
        }
        return update({ rows: entry.rows.map((value, i) => i === rowIndex ? nextRow : value) });
      };
      const modelField = element("div", "settings-model-field");
      const cascade = element("select", "settings-select settings-cascade");
      cascade.id = `roster-${index}-row-${rowIndex}-model`;
      cascade.disabled = controlsDisabled;
      const placeholder = element("option", "", "");
      placeholder.value = "";
      placeholder.disabled = true;
      placeholder.selected = !executorRow.model;
      cascade.appendChild(placeholder);
      for (const candidate of Object.values(EXECUTORS)) {
        const detected = isExternalExecutorId(candidate.id) ? state.externalDetection[candidate.id] : undefined;
        const list = executorModelList(candidate.id, state.externalModels);
        if (detected?.state === "notInstalled" && list?.state !== "ok") continue;
        const group = element("optgroup", "");
        group.label = candidate.displayName;
        group.disabled = detected?.state === "notInstalled";
        const selection = modelSelectionState(candidate.id, list, state.externalDetection[candidate.id]);
        const choices = selection.choices;
        const served = executorServesRole(entry.role, candidate.id);
        const option = (model: string, label: string) => {
          const item = element("option", "", label);
          item.value = `${candidate.id}/${model}`;
          item.disabled = !served || entry.rows.some((value, i) => i !== rowIndex && value.executor === candidate.id && value.model === model);
          group.appendChild(item);
        };
        if (!served) {
          if (candidate.id !== executorRow.executor || !executorRow.model) continue;
          const saved = choices?.find((choice) => choice.model === executorRow.model);
          if (saved) option(saved.model, saved.label ?? saved.model);
        } else if (selection.checking) {
          group.disabled = true;
          option("", l10n.t("checking…"));
          group.firstElementChild?.setAttribute("disabled", "");
        } else if (choices) {
          for (const choice of choices) option(choice.model, choice.label ?? choice.model);
        } else option("", l10n.t("model list unavailable — type a model ID"));
        if (!group.disabled && candidate.id === executorRow.executor && executorRow.model && !choices?.some((choice) => choice.model === executorRow.model)) {
          option(executorRow.model, executorRow.model + l10n.t(" (not in list)"));
        }
        if (served && selection.refreshFailed) {
          const unavailable = element("option", "", l10n.t("List not obtained (use Recheck to try again)"));
          unavailable.value = "";
          unavailable.disabled = true;
          group.appendChild(unavailable);
        }
        if (served || group.childElementCount) cascade.appendChild(group);
      }
      if (executorRow.model && !Array.from(cascade.options).some((option) => option.value === `${executorRow.executor}/${executorRow.model}`)) {
        const saved = element("option", "", `${definition.displayName} — ${executorRow.model}${l10n.t(" (not in list)")}`);
        saved.value = `${executorRow.executor}/${executorRow.model}`;
        saved.disabled = true;
        cascade.appendChild(saved);
      }
      cascade.value = executorRow.model ? `${executorRow.executor}/${executorRow.model}` : "";
      cascade.addEventListener("change", () => {
        const [executor, model] = cascade.value.split("/");
        if (!isExecutorId(executor) || model === undefined) return;
        updateRow({ executor, model, efforts: [] });
      });
      modelField.append(settingsHiddenLabel(cascade, `${entry.role} Model`), cascade);
      const list = executorModelList(executorRow.executor, state.externalModels);
      const workerNoteId = `roster-${index}-row-${rowIndex}-worker-note`;
      if (!rowServed) cascade.setAttribute("aria-describedby", workerNoteId);
      if (rowServed && modelSelectionState(executorRow.executor, list, state.externalDetection[executorRow.executor]).manual) {
        const input = element("input", "settings-input");
        input.id = `roster-${index}-row-${rowIndex}-model-id`;
        input.type = "text";
        input.value = executorRow.model;
        input.disabled = controlsDisabled;
        const savedModel = isDraft ? null : executorRow.model;
        rosterField(`model:${entry.role}:${executorRow.executor}/${savedModel ?? ""}:${isDraft ? "draft" : "row"}`, input, executorRow.model, state, seenRosterFields, () => {
          input.setCustomValidity(modelIdProblem(entry.rows, isDraft ? -1 : rowIndex, executorRow.executor, input.value) ?? "");
          return input.reportValidity() ? updateRow({ model: input.value, efforts: [] }) : "invalid";
        }, (next, text) => commitGoneModelEdit(next, entry.role, executorRow.executor, savedModel, text));
        modelField.append(settingsHiddenLabel(input, `${definition.displayName} Model`), input,
          element("span", "settings-muted", l10n.t("model list unavailable — type a model ID")));
      }
      matrix.appendChild(modelField);
      const supported = rowEfforts(executorRow, state.externalModels);
      if (rowComplete(executorRow, state.externalModels) && supported.length === 0 && executorRow.efforts.length === 0) {
        matrix.appendChild(element("span", "settings-no-effort settings-muted", l10n.t("no effort setting")));
      } else {
        for (let column = 0; column < 6; column++) {
          const effort = definition.efforts[column];
          const saved = executorRow.efforts.includes(effort);
          if (!executorRow.model || !effort || (!supported.includes(effort) && !saved)) { matrix.appendChild(element("span", "settings-effort-slot")); continue; }
          const pressed = saved && rowServed;
          const button = element("button", "settings-segment settings-chip", `${pressed ? "✓ " : ""}${effort}`);
          button.id = `roster-${index}-row-${rowIndex}-${effort}`;
          button.type = "button";
          button.dataset.chip = effort;
          button.dataset.column = String(column + 2);
          button.setAttribute("aria-pressed", String(pressed));
          button.setAttribute("aria-label", `${entry.role} ${definition.displayName} ${cascade.selectedOptions[0]?.textContent ?? executorRow.model} ${effort}`);
          button.disabled = controlsDisabled || !rowServed || !supported.includes(effort);
          if (!rowServed) button.setAttribute("aria-describedby", workerNoteId);
          if (!supported.includes(effort)) {
            button.classList.add("settings-unsupported");
            button.title = l10n.t(" (not supported by this model)");
            button.prepend(element("span", "", "⚠ "));
          }
          button.addEventListener("click", () => updateRow({ efforts: pressed ? executorRow.efforts.filter((value) => value !== effort) : [...executorRow.efforts, effort] }));
          matrix.appendChild(button);
        }
      }
      const removeRow = element("button", "settings-link settings-remove-model", CLOSE_GLYPH);
      removeRow.id = `roster-${index}-row-${rowIndex}-remove`;
      removeRow.type = "button";
      removeRow.setAttribute("aria-label", l10n.t("Remove this row"));
      removeRow.disabled = controlsDisabled;
      removeRow.addEventListener("click", () => {
        if (isDraft) {
          settingsRosterDrafts.delete(entry.role);
          renderOrchestration(state);
        } else update({ rows: entry.rows.filter((_, i) => i !== rowIndex) });
      });
      matrix.appendChild(removeRow);
      if (rowServed && !rowComplete(executorRow, state.externalModels)) matrix.appendChild(element("div", "settings-matrix-caption settings-muted settings-incomplete-note", l10n.t("Select a Model and an Effort to enable this row")));
      if (!rowServed) {
        const workerNote = element("div", "settings-matrix-caption settings-muted settings-worker-note", l10n.t("This executor cannot edit files; use it for explorer or reviewer"));
        workerNote.id = workerNoteId;
        matrix.appendChild(workerNote);
      }
      const unsupported = executorRow.efforts.filter((effort) => !supported.includes(effort));
      if (unsupported.length) matrix.appendChild(element("div", "settings-matrix-caption settings-muted settings-effort-warning", l10n.t("⚠ Unsupported Effort kept in settings and excluded from targets: {0}", unsupported.join(", "))));
    });
    const addRow = element("button", "settings-link settings-add-row", l10n.t("+ Add row"));
    addRow.id = `roster-${index}-add-row`;
    addRow.type = "button";
    addRow.disabled = controlsDisabled || !!draft || visibleRows.length >= ROSTER_ROWS_MAX;
    addRow.addEventListener("click", () => {
      settingsRosterDrafts.set(entry.role, { executor: DEFAULT_EXECUTOR, model: "", efforts: [] });
      renderOrchestration(state);
    });
    matrix.appendChild(addRow);
    wrapper.appendChild(matrix);
    const selectedRole = [{ ...entry, enabled: true }];
    const agentKeys = orchestrationVariants(selectedRole).map((variant) => variant.agentKey);
    const externalKeys = orchestrationExternalTargets(selectedRole, state.externalModels).map((target) => target.target);
    card.appendChild(wrapper);
    if (!controlsDisabled && !agentKeys.length && !externalKeys.length) {
      card.appendChild(element("p", "settings-role-warning settings-muted", l10n.t("No combination selected — this role is not injected")));
    }
    rosterRows.appendChild(card);
  });
  for (const control of [roleInput, addButton, defaultsButton, policyInput]) control.disabled = !state.orchestrationEnabled;
  showEditedField(policyField, state.conductorPolicy, state);
  renderPolicyCounter(policyInput.value, state.conductorPolicyDefault);
  renderPolicyDefaults(state);
  previewRequest = 0;
  renderInstructionPreview(state);
  if (fieldEditOf(policyField).dirty) requestInstructionPreview();
  renderExternal(state);
  lockOrchestration();
  for (const [key, field] of rosterFields) {
    if (seenRosterFields.has(key)) continue;
    rosterFields.delete(key);
    const text = field.control.value;
    const whenGone = field.whenGone;
    if (fieldEditOf(field).dirty && text !== field.written && whenGone) goneRosterEdits.push((next) => whenGone(next, text));
  }
  const focusTarget = focus === undefined ? null : orchestrationFocusTarget(focus, state.orchestrationAgents);
  if (focusTarget !== null) {
    focusTarget.focus();
    if (focusTarget instanceof HTMLInputElement || focusTarget instanceof HTMLTextAreaElement) restoreSelection(focusTarget, focusSelection);
  }
  if (pendingOrchestration === null) settingsRosterFocus = undefined;
  while (pendingOrchestration === null && goneRosterEdits.length > 0) goneRosterEdits.shift()!(state);
}
function rosterField(key: string, control: HTMLInputElement, saved: string, state: SettingsState, seen: Set<string>,
  commit: () => FieldCommit, whenGone?: (state: SettingsState, text: string) => void): void {
  seen.add(key);
  const existing = rosterFields.get(key);
  if (existing === undefined) {
    rosterFields.set(key, Object.assign(editedField(control, commit), { whenGone }));
    return;
  }
  const text = existing.control.value;
  existing.commit = commit;
  existing.whenGone = whenGone;
  bindEditedField(existing, control);
  control.value = text;
  showEditedField(existing, saved, state);
}
function modelIdProblem(rows: readonly ExecutorRow[], rowIndex: number, executor: ExecutorId, model: string): string | undefined {
  if (!isExternalModel(model)) return l10n.t("Use a model ID starting with a letter or digit, followed by letters, digits, dots, underscores, colons or hyphens.");
  if (rows.some((value, i) => i !== rowIndex && value.executor === executor && value.model === model)) return l10n.t("This model already exists.");
  return undefined;
}
function commitGoneModelEdit(next: SettingsState, role: string, executor: ExecutorId, savedModel: string | null, text: string): void {
  const entry = next.orchestrationAgents.find((item) => item.role === role);
  if (entry === undefined) return;
  const rowIndex = savedModel === null ? -1 : entry.rows.findIndex((row) => row.executor === executor && row.model === savedModel);
  if (savedModel === null ? settingsRosterDrafts.get(role)?.executor !== executor : rowIndex < 0) return;
  if (modelIdProblem(entry.rows, rowIndex, executor, text) !== undefined) return;
  const rows = savedModel === null
    ? [...entry.rows, { executor, model: text, efforts: [] }]
    : entry.rows.map((row, i) => i === rowIndex ? { ...row, model: text, efforts: [] } : row);
  if (savedModel === null) settingsRosterDrafts.delete(role);
  writeRoster(next.orchestrationAgents.map((item) => item === entry ? { ...item, rows } : item));
}
orchestrationSwitch.addEventListener("click", () => writeOrchestration("enabled", !current?.orchestrationEnabled));
function addRole(): void {
  if (!current?.orchestrationEnabled || pendingOrchestration !== null) return;
  const role = roleInput.value;
  if (!isRoleName(role)) {
    roleError.textContent = l10n.t("Use a lowercase letter first, then lowercase letters, digits or hyphens.");
    return;
  }
  if (current.orchestrationAgents.some((entry) => entry.role === role)) {
    roleError.textContent = l10n.t("This role already exists.");
    return;
  }
  roleError.textContent = "";
  writeRoster([...current.orchestrationAgents, emptyOrchestrationRole(role)]);
}
addButton.addEventListener("click", addRole);
roleInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); addRole(); }
});
defaultsButton.addEventListener("click", () => { if (current) { const defaults = current.orchestrationDefaults; writeRoster(current.orchestrationAgents.filter((entry) => defaults.some((role) => role.role === entry.role))); } });
policyDefaultsButton.addEventListener("click", () => { if (current) writeOrchestration("conductorPolicy", current.conductorPolicyDefault); });
const policyField = editedField(policyInput, () => writeOrchestration("conductorPolicy", policyInput.value));
policyInput.addEventListener("input", () => { renderPolicyCounter(); if (current) { renderPolicyDefaults(current); requestInstructionPreview(); } });

const footer = element("div", "settings-footer");
const moreLink = element("button", "settings-link", l10n.t("Open other settings in VS Code Settings"));
moreLink.type = "button";
footer.appendChild(moreLink);
generalCategory.appendChild(footer);

let current: SettingsState | null = null;
let requestSerial = 0;
const nextRequestId = (): number => ++requestSerial;
const pending: { autoContinue: number | null; restore: number | null; apiKey: number | null; guard: number | null; memoryBlockProjectType: number | null; todo: number | null; workStage: number | null; editSummary: number | null; remoteControlCard: number | null; improvementMenu: number | null } = { autoContinue: null, restore: null, apiKey: null, guard: null, memoryBlockProjectType: null, todo: null, workStage: null, editSummary: null, remoteControlCard: null, improvementMenu: null };
const pendingAutoUpdate = new Map<ExecutorId, number>();
const pendingFileLink: Record<FileLinkBooleanSetting, number | null> = {
  fileLinkInstruction: null,
  planInstruction: null,
  closingSummary: null,
  chromeIntegration: null,
  mcpElicitation: null,
  writesLostNotice: null,
  revealInExplorer: null,
  allowOutsideWorkspace: null,
  confirmOutsideWorkspace: null,
  openOutsideReadOnly: null,
};

const requestAnchors = new Map<number, HTMLElement>();
const rowErrors = new Map<HTMLElement, HTMLElement>();

function rowTextOf(control: Element | null | undefined): HTMLElement | undefined {
  return control?.closest(".settings-row")?.querySelector<HTMLElement>(":scope > .settings-row-text") ?? undefined;
}

function writeAnchor(message: SettingsPageToHost): HTMLElement | undefined {
  switch (message.type) {
    case "setAccentSetting":
      return (accentCard.contains(document.activeElement) ? rowTextOf(document.activeElement) : undefined)
        ?? accentCard.querySelector<HTMLElement>(".settings-row-text") ?? undefined;
    case "setDisplayName": return displayNameText;
    case "setComposerSendKey": return sendKeyText;
    case "setInitialModel": return initialModelText;
    case "setRestoreTabsOnStartup": return restoreText;
    case "setCliAutoUpdate": return detectionControls.find(({ executor }) => executor === message.executor)?.text;
    case "setEventLimit": return eventLimitText;
    case "setTranscriptRetentionDays": return retentionDaysText;
    case "setGuardEnabled": return guardText;
    case "setMemoryBlockProjectType": return memoryBlockProjectTypeText;
    case "setTodoEnabled": return todoText;
    case "setWorkStageEnabled": return workStageText;
    case "setWorkStageCast": return workStageCast.anchor(message.setting);
    case "setEditSummaryEnabled": return editSummaryText;
    case "setRemoteControlCard": return remoteControlCardText;
    case "setImprovementMenu": return improvementMenuText;
    case "setWelcomeSetting": return welcomeTexts[message.setting];
    case "setHandoffAutoSetting": return handoffAutoTexts[message.setting];
    case "setWaitNotifySetting": return waitNotifyTexts[message.setting];
    case "setApiKeyPolicy": return apiKeyText;
    case "setFileLinkSetting": return message.setting === "openWithSystemApp" ? extensionText : rowTextOf(fileLinkSwitches[message.setting]);
    case "setOrchestrationSetting":
      return message.setting === "externalTimeoutMinutes" ? timeoutText : message.setting === "conductorPolicy" ? policyCard : orchestrationText;
    case "applyRecommendedRoster": return recommendText;
    default: return undefined;
  }
}

function post(message: SettingsPageToHost): void {
  if ("requestId" in message) {
    const anchor = writeAnchor(message);
    if (anchor) requestAnchors.set(message.requestId, anchor);
  }
  vscode.postMessage(message);
}

function settingErrorNote(text: string, action: SettingWriteFailureAction): HTMLElement {
  const note = element("div", "settings-row-note settings-row-error");
  note.setAttribute("role", "alert");
  const mark = element("span", "settings-row-error-mark", "✗");
  mark.setAttribute("aria-hidden", "true");
  const button = element("button", "settings-link settings-row-error-action",
    action === "reloadWindow" ? l10n.t("Reload window") : l10n.t("Open settings.json"));
  button.type = "button";
  button.addEventListener("click", () => post({ type: "settingWriteFailureAction", action }));
  note.append(mark, " ", text, " ", button);
  return note;
}

function renderRowError(anchor: HTMLElement, failure: SettingWriteFailure | undefined): void {
  rowErrors.get(anchor)?.remove();
  rowErrors.delete(anchor);
  if (!failure) return;
  const note = failure.kind === "unregistered"
    ? settingErrorNote(l10n.t("Could not save. Reload the window and try again."), "reloadWindow")
    : settingErrorNote(l10n.t("Could not save: {0}", failure.reason), "openSettingsJson");
  anchor.appendChild(note);
  rowErrors.set(anchor, note);
}

let reloadNeededNote: HTMLElement | undefined;
function renderReloadNeeded(needed: boolean): void {
  if (needed === (reloadNeededNote !== undefined)) return;
  reloadNeededNote?.remove();
  reloadNeededNote = needed
    ? settingErrorNote(l10n.t("VS Code has not loaded LAISORA's new settings yet, so they cannot be saved. Reload the window."), "reloadWindow")
    : undefined;
  if (reloadNeededNote) settingsPageHead.appendChild(reloadNeededNote);
}

function render(state: SettingsState): void {
  current = state;
  const anchor = state.replyTo === undefined ? undefined : requestAnchors.get(state.replyTo);
  if (anchor) {
    requestAnchors.delete(state.replyTo!);
    for (const other of workStageCast.sameSettingRows(anchor)) renderRowError(other, undefined);
    renderRowError(anchor, state.writeFailure);
  }
  renderReloadNeeded(state.reloadNeeded);
  renderInitialModel(state);
  renderDisplayName(state);
  if (pendingEventLimit === state.replyTo) pendingEventLimit = null;
  eventLimitInput.disabled = pendingEventLimit !== null;
  showEditedField(eventLimitField, String(state.eventLimit ?? EVENT_LIMIT_DEFAULT), state);
  if (pendingRetentionDays === state.replyTo) pendingRetentionDays = null;
  retentionDaysInput.disabled = pendingRetentionDays !== null;
  showEditedField(retentionDaysField, state.transcriptRetentionDays === undefined ? "" : String(state.transcriptRetentionDays), state);
  retentionDaysInput.placeholder = transcriptRetentionFallbackText(state.transcriptRetentionFallback);
  renderAccent(state.appearance, state.replyTo);
  if (pending.autoContinue === state.replyTo) pending.autoContinue = null;
  autoContinueSwitch.setAttribute("aria-checked", String(state.autoContinueAtUsageLimit));
  autoContinueSwitch.disabled = pending.autoContinue !== null;
  renderSystemAppExtensions(state);
  renderOrchestration(state);
  if (pending.guard === state.replyTo) pending.guard = null;
  guardSwitch.setAttribute("aria-checked", String(state.guardEnabled));
  guardSwitch.disabled = pending.guard !== null;
  if (pending.memoryBlockProjectType === state.replyTo) pending.memoryBlockProjectType = null;
  memoryBlockProjectTypeSwitch.setAttribute("aria-checked", String(state.memoryBlockProjectType));
  memoryBlockProjectTypeSwitch.disabled = pending.memoryBlockProjectType !== null || !state.guardEnabled;
  if (pending.todo === state.replyTo) pending.todo = null;
  todoSwitch.setAttribute("aria-checked", String(state.todoEnabled));
  todoSwitch.disabled = pending.todo !== null;
  if (workStageNav.button.hidden !== (state.workStage === undefined)) {
    workStageNav.button.hidden = state.workStage === undefined;
    if (workStageNav.button.hidden && !workStageNav.panel.hidden) activateSettingsCategory("general");
  }
  if (requestedSettingsCategory !== null) activateSettingsCategory(workStageNav.button.hidden ? "general" : requestedSettingsCategory);
  if (pending.workStage === state.replyTo) pending.workStage = null;
  workStageSwitch.setAttribute("aria-checked", String(state.workStage?.enabled === true));
  workStageSwitch.disabled = pending.workStage !== null || state.workStage === undefined;
  if (workStageCast.render(state.workStage, state.replyTo) && !workStageNav.panel.hidden) renderSettingsToc();
  if (pending.editSummary === state.replyTo) pending.editSummary = null;
  editSummarySwitch.setAttribute("aria-checked", String(state.editSummaryEnabled));
  editSummarySwitch.disabled = pending.editSummary !== null;
  if (pending.remoteControlCard === state.replyTo) pending.remoteControlCard = null;
  remoteControlCardSwitch.setAttribute("aria-checked", String(state.remoteControlCard));
  remoteControlCardSwitch.disabled = pending.remoteControlCard !== null;
  if (pending.improvementMenu === state.replyTo) pending.improvementMenu = null;
  improvementMenuSwitch.setAttribute("aria-checked", String(state.improvementMenu));
  improvementMenuSwitch.disabled = pending.improvementMenu !== null;
  renderWelcomeSettings(state);
  renderHandoffAuto(state);
  renderWaitNotify(state);
  if (pending.restore === state.replyTo) pending.restore = null;
  if (pending.apiKey === state.replyTo) pending.apiKey = null;
  for (const key of FILE_LINK_BOOLEAN_SETTINGS) {
    if (pendingFileLink[key] === state.replyTo) pendingFileLink[key] = null;
    fileLinkSwitches[key].setAttribute("aria-checked", String(state[key]));
  }
  fileLinkSwitches.fileLinkInstruction.disabled = false;
  fileLinkSwitches.planInstruction.disabled = false;
  fileLinkSwitches.closingSummary.disabled = false;
  fileLinkSwitches.chromeIntegration.disabled = false;
  fileLinkSwitches.mcpElicitation.disabled = false;
  fileLinkSwitches.writesLostNotice.disabled = false;
  fileLinkSwitches.revealInExplorer.disabled = false;
  fileLinkSwitches.allowOutsideWorkspace.disabled = false;
  for (const child of outsideChildren) {
    child.control.disabled = !state.allowOutsideWorkspace;
    child.hint.hidden = state.allowOutsideWorkspace;
    child.control.setAttribute("aria-describedby", state.allowOutsideWorkspace ? child.describedBy : `${child.describedBy} ${child.hint.id}`);
  }
  status.textContent = "";
  status.hidden = true;
  sendKeySelect.querySelector(".settings-option-unknown")?.remove();
  sendKeySelect.value = state.composerSendKey;
  sendKeySelect.disabled = false;
  const focusInGroup = apiKeyGroup.contains(document.activeElement);
  for (const radio of apiKeyRadios) {
    const checked = radio.dataset.value === state.apiKeyPolicy;
    radio.setAttribute("aria-checked", String(checked));
    radio.tabIndex = checked ? 0 : -1;
    radio.disabled = false;
  }
  if (focusInGroup) checkedApiKeyRadio()?.focus();
  restoreSwitch.setAttribute("aria-checked", String(state.restoreTabsOnStartup));
  restoreSwitch.disabled = false;
  for (const { executor, autoUpdate } of detectionControls) {
    if (pendingAutoUpdate.get(executor) === state.replyTo) pendingAutoUpdate.delete(executor);
    autoUpdate.setAttribute("aria-checked", String(state.cliAutoUpdate[executor]));
    autoUpdate.disabled = pendingAutoUpdate.has(executor);
  }
}

sendKeySelect.addEventListener("change", () => {
  post({ type: "setComposerSendKey", requestId: nextRequestId(), sendKey: sendKeySelect.value as ComposerSendKey });
});

function requestApiKeyPolicy(policy: ApiKeyPolicy): void {
  if (current === null || pending.apiKey !== null || policy === current.apiKeyPolicy) return;
  const requestId = nextRequestId();
  pending.apiKey = requestId;
  post({ type: "setApiKeyPolicy", requestId, policy });
}
for (const radio of apiKeyRadios) {
  radio.addEventListener("click", () => requestApiKeyPolicy(radio.dataset.value as ApiKeyPolicy));
}
apiKeyGroup.addEventListener("keydown", (event) => {
  handleSegmentedArrow(event, apiKeyRadios, (radio) => requestApiKeyPolicy(radio.dataset.value as ApiKeyPolicy), () => current !== null && pending.apiKey === null);
});

autoContinueSwitch.addEventListener("click", () => {
  if (current === null || pending.autoContinue !== null) return;
  const requestId = nextRequestId();
  pending.autoContinue = requestId;
  autoContinueSwitch.disabled = true;
  post({ type: "setAutoContinueAtUsageLimit", requestId, enabled: !current.autoContinueAtUsageLimit });
});

restoreSwitch.addEventListener("click", () => {
  if (current === null || pending.restore !== null) return;
  const requestId = nextRequestId();
  pending.restore = requestId;
  post({ type: "setRestoreTabsOnStartup", requestId, enabled: !current.restoreTabsOnStartup });
});
for (const { executor, autoUpdate } of detectionControls) {
  autoUpdate.addEventListener("click", () => {
    if (current === null || pendingAutoUpdate.has(executor)) return;
    const requestId = nextRequestId();
    pendingAutoUpdate.set(executor, requestId);
    autoUpdate.disabled = true;
    post({ type: "setCliAutoUpdate", requestId, executor, enabled: !current.cliAutoUpdate[executor] });
  });
}
guardSwitch.addEventListener("click", () => {
  if (current === null || pending.guard !== null) return;
  const requestId = nextRequestId();
  pending.guard = requestId;
  guardSwitch.disabled = true;
  post({ type: "setGuardEnabled", requestId, enabled: !current.guardEnabled });
});
memoryBlockProjectTypeSwitch.addEventListener("click", () => {
  if (current === null || pending.memoryBlockProjectType !== null) return;
  const requestId = nextRequestId();
  pending.memoryBlockProjectType = requestId;
  memoryBlockProjectTypeSwitch.disabled = true;
  post({ type: "setMemoryBlockProjectType", requestId, enabled: !current.memoryBlockProjectType });
});
todoSwitch.addEventListener("click", () => {
  if (current === null || pending.todo !== null) return;
  const requestId = nextRequestId();
  pending.todo = requestId;
  todoSwitch.disabled = true;
  post({ type: "setTodoEnabled", requestId, enabled: !current.todoEnabled });
});
workStageSwitch.addEventListener("click", () => {
  if (current?.workStage === undefined || pending.workStage !== null) return;
  const requestId = nextRequestId();
  pending.workStage = requestId;
  workStageSwitch.disabled = true;
  post({ type: "setWorkStageEnabled", requestId, enabled: !current.workStage.enabled });
});
editSummarySwitch.addEventListener("click", () => {
  if (current === null || pending.editSummary !== null) return;
  const requestId = nextRequestId();
  pending.editSummary = requestId;
  editSummarySwitch.disabled = true;
  post({ type: "setEditSummaryEnabled", requestId, enabled: !current.editSummaryEnabled });
});
remoteControlCardSwitch.addEventListener("click", () => {
  if (current === null || pending.remoteControlCard !== null) return;
  const requestId = nextRequestId();
  pending.remoteControlCard = requestId;
  remoteControlCardSwitch.disabled = true;
  post({ type: "setRemoteControlCard", requestId, enabled: !current.remoteControlCard });
});
improvementMenuSwitch.addEventListener("click", () => {
  if (current === null || pending.improvementMenu !== null) return;
  const requestId = nextRequestId();
  pending.improvementMenu = requestId;
  improvementMenuSwitch.disabled = true;
  post({ type: "setImprovementMenu", requestId, enabled: !current.improvementMenu });
});
for (const key of FILE_LINK_BOOLEAN_SETTINGS) {
  const control = fileLinkSwitches[key];
  control.addEventListener("click", () => {
    if (current === null || pendingFileLink[key] !== null || control.disabled) return;
    const requestId = nextRequestId();
    pendingFileLink[key] = requestId;
    post({ type: "setFileLinkSetting", requestId, setting: key, enabled: !current[key] });
  });
}
moreLink.addEventListener("click", () => post({ type: "openVsCodeSettings" }));

type MigrationState = Extract<HostToSettingsPage, { type: "migrationState" }>;
type MigrationScanView = NonNullable<MigrationState["scan"]>;
const formatBytes = (bytes: number): string => formatByteCount(bytes, uiLocale());
const exportCard = section(migrationCategory, l10n.t("To a new PC"));
const migrationExportButton = element("button", "settings-segment settings-primary", l10n.t("Export…"));
migrationExportButton.id = "setting-migration-export";
migrationExportButton.type = "button";
migrationExportButton.disabled = true;
const migrationExportText = row(exportCard, l10n.t("Migration ZIP"), l10n.t("Puts what is switched on below into one ZIP at the place you choose. Keep it somewhere safe and use it on the new PC. Login credentials are not included."), migrationExportButton);
const migrationTotal = rowNote(migrationExportText, "settings-row-note settings-migration-number", "");
migrationExportButton.setAttribute("aria-describedby", `${migrationExportButton.getAttribute("aria-describedby")} ${migrationTotal.id}`);
const migrationContents = element("div", "settings-migration-contents");
migrationContents.setAttribute("role", "group");
const migrationContentsTitle = element("h3", "settings-migration-contents-title", l10n.t("What goes into the ZIP"));
migrationContentsTitle.id = "settings-migration-contents-title";
migrationContents.setAttribute("aria-labelledby", migrationContentsTitle.id);
migrationContents.appendChild(migrationContentsTitle);
exportCard.appendChild(migrationContents);
const migrationSwitches = Object.fromEntries(MIGRATION_CATEGORIES.map(category => [category, switchButton(`setting-migration-${category}`)])) as Record<MigrationCategory, HTMLButtonElement>;
const migrationTexts = Object.fromEntries(MIGRATION_CATEGORIES.map(category => [category, row(migrationContents, migrationCategoryTitle(category), "", migrationSwitches[category])])) as Record<MigrationCategory, HTMLElement>;
const migrationKeyNote = rowNote(migrationTexts.claudeEnv, "settings-row-note", "");
migrationKeyNote.hidden = true;
const importCard = section(migrationCategory, l10n.t("From the old PC"));
const migrationImportButton = element("button", "settings-segment settings-primary", l10n.t("Import…"));
migrationImportButton.id = "setting-migration-import";
migrationImportButton.type = "button";
migrationImportButton.disabled = true;
const migrationImportText = row(importCard, l10n.t("ZIP from the old PC"), l10n.t("A new conversation with Claude starts; give it the path of the ZIP file."), migrationImportButton);
type MigrationProgressNote = { readonly box: HTMLElement; readonly track: HTMLElement; readonly bar: HTMLElement; readonly label: HTMLElement };
function migrationProgressNote(text: HTMLElement): MigrationProgressNote {
  const box = element("div", "settings-migration-progress");
  const track = element("div", "settings-progress-track");
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");
  const bar = element("div", "settings-progress-bar");
  track.appendChild(bar);
  const label = element("div", "settings-row-note settings-migration-number");
  box.append(track, label);
  box.hidden = true;
  text.appendChild(box);
  return { box, track, bar, label };
}
const migrationProgressNotes: Record<MigrationOperation, MigrationProgressNote> = { export: migrationProgressNote(migrationExportText), import: migrationProgressNote(migrationImportText) };
const migrationNotices: Record<MigrationOperation, HTMLElement> = { export: rowNote(migrationExportText, "settings-row-note", ""), import: rowNote(migrationImportText, "settings-row-note", "") };
for (const notice of Object.values(migrationNotices)) notice.setAttribute("role", "status");
let migrationScan: MigrationScanView | undefined;
let migrationBusyNow = false;
let migrationImportPending = false;
let migrationProgress: MigrationProgress | undefined;
let migrationProgressTimer: ReturnType<typeof setInterval> | undefined;
const migrationChosen = new Set<MigrationCategory>(MIGRATION_CATEGORIES);
let migrationPendingNotice: HTMLElement | undefined;
function migrationCategoryBytes(scan: MigrationScanView, category: MigrationCategory): number {
  if (category === "todo") return scan.todo?.bytes ?? 0;
  if (category === "claudeEnv") return scan.claudeEnv.bytes;
  if (category === "conversations") return scan.conversations.bytes;
  if (category === "memory") return scan.memory.bytes;
  return 0;
}
function migrationProgressText(view: MigrationProgressView): string {
  const elapsed = formatElapsed(view.elapsedMs);
  switch (view.stage) {
    case "preparing": return view.total !== undefined ? l10n.t("Preparing: {0} / {1} work folders · {2}", view.done ?? 0, view.total, elapsed) : l10n.t("Preparing · {0}", elapsed);
    case "archiving": return view.percent !== undefined ? l10n.t("Compressing: {0}% ({1} / {2} items) · {3}", view.percent, view.done ?? 0, view.total ?? 0, elapsed) : l10n.t("Compressing · {0}", elapsed);
    case "finishing": return l10n.t("Finishing the ZIP · {0}", elapsed);
    case "extracting": return l10n.t("Opening the ZIP: {0} files · {1}", view.done ?? 0, elapsed);
    case "placing": return l10n.t("Placing files · {0}", elapsed);
  }
}
function renderMigrationProgress(): void {
  const shown = migrationBusyNow ? migrationProgress : undefined;
  for (const operation of MIGRATION_OPERATIONS) {
    const note = migrationProgressNotes[operation];
    const progress = shown?.operation === operation ? shown : undefined;
    note.box.hidden = progress === undefined;
    if (!progress) continue;
    const view = migrationProgressView(progress, Date.now());
    const text = migrationProgressText(view);
    note.label.textContent = text;
    note.track.setAttribute("aria-valuetext", text);
    note.track.classList.toggle("indeterminate", view.percent === undefined);
    if (view.percent === undefined) {
      note.track.removeAttribute("aria-valuenow");
      note.bar.style.removeProperty("width");
    } else {
      note.track.setAttribute("aria-valuenow", String(view.percent));
      note.bar.style.width = `${view.percent}%`;
    }
  }
  if (shown && migrationProgressTimer === undefined) migrationProgressTimer = setInterval(renderMigrationProgress, 1000);
  if (!shown && migrationProgressTimer !== undefined) { clearInterval(migrationProgressTimer); migrationProgressTimer = undefined; }
}
function renderMigrationControls(): void {
  const scan = migrationScan;
  for (const category of MIGRATION_CATEGORIES) {
    migrationSwitches[category].setAttribute("aria-checked", String(migrationChosen.has(category)));
    migrationSwitches[category].disabled = migrationBusyNow || scan === undefined || category === "todo" && scan.todo === undefined;
  }
  const total = scan ? MIGRATION_CATEGORIES.filter(category => migrationChosen.has(category)).reduce((sum, category) => sum + migrationCategoryBytes(scan, category), 0) : 0;
  migrationTotal.textContent = scan ? l10n.t("Total before compression: {0}", formatBytes(total)) : l10n.t("Loading…");
  migrationExportButton.disabled = migrationBusyNow || scan === undefined || migrationChosen.size === 0;
  migrationImportButton.disabled = migrationBusyNow || migrationImportPending;
  renderMigrationProgress();
}
function renderMigration(state: MigrationState): void {
  migrationBusyNow = state.busy;
  if (state.notice && migrationPendingNotice === migrationNotices.import) migrationImportPending = false;
  if (!state.busy) migrationProgress = undefined;
  if (state.notice && migrationPendingNotice) {
    migrationPendingNotice.textContent = `${state.notice.ok ? "" : "✗ "}${state.notice.text}`;
    migrationPendingNotice = undefined;
  }
  if (state.scan) {
    const scan = migrationScan = state.scan;
    if (scan.todo === undefined) migrationChosen.delete("todo");
    const describe = (category: MigrationCategory, text: string) => { migrationTexts[category].querySelector(".settings-row-description")!.textContent = text; };
    describe("todo", scan.todo ? l10n.t("The latest ToDo ({0} items) and its images. {1}", scan.todo.items, formatBytes(scan.todo.bytes)) : l10n.t("ToDo is not available in this window."));
    describe("laisoraSettings", l10n.t("{0} values you set in your user settings.", scan.laisoraSettings));
    describe("claudeEnv", l10n.t("CLAUDE.md, rules, hooks, skills, agents, commands, output styles, plugins, settings and keybindings in ~/.claude ({0} files, {1}), and {2} MCP servers from ~/.claude.json. Login credentials and other values of ~/.claude.json are not included.", scan.claudeEnv.files, formatBytes(scan.claudeEnv.bytes), scan.claudeEnv.mcpServers));
    describe("conversations", l10n.t("Conversation records of every work folder in ~/.claude/projects ({0} conversations, {1}).", scan.conversations.sessions, formatBytes(scan.conversations.bytes)));
    describe("memory", l10n.t("Claude's memory of every work folder in ~/.claude/projects ({0} files, {1}).", scan.memory.files, formatBytes(scan.memory.bytes)));
    migrationKeyNote.textContent = [
      ...(scan.claudeEnv.mcpKeyServers.length ? [l10n.t("MCP servers {0} have env, headers, arguments or URLs that look like keys. Keys written there go into the ZIP.", scan.claudeEnv.mcpKeyServers.join(", "))] : []),
      ...(scan.claudeEnv.settingsKeyFiles.length ? [l10n.t("{0} look like keys. Keys written there go into the ZIP.", scan.claudeEnv.settingsKeyFiles.join(", "))] : []),
    ].join(" ");
    migrationKeyNote.hidden = !migrationKeyNote.textContent;
  }
  renderMigrationControls();
}
for (const category of MIGRATION_CATEGORIES) {
  migrationSwitches[category].addEventListener("click", () => {
    if (migrationSwitches[category].disabled) return;
    if (migrationChosen.has(category)) migrationChosen.delete(category); else migrationChosen.add(category);
    renderMigrationControls();
  });
}
migrationExportButton.addEventListener("click", () => {
  if (migrationExportButton.disabled) return;
  migrationNotices.export.textContent = "";
  migrationPendingNotice = migrationNotices.export;
  post({ type: "migrationExport", categories: MIGRATION_CATEGORIES.filter(category => migrationChosen.has(category)) });
});
migrationImportButton.addEventListener("click", () => {
  if (migrationImportButton.disabled) return;
  migrationNotices.import.textContent = "";
  migrationPendingNotice = migrationNotices.import;
  migrationImportPending = true;
  renderMigrationControls();
  post({ type: "migrationImport" });
});
renderMigrationControls();

const REVEAL_TARGETS: Record<SettingsRevealTarget, { category: string; target: () => HTMLElement }> = {
  handoffAuto: { category: "general", target: () => handoffAutoTexts.enabled.closest<HTMLElement>(".settings-row") ?? handoffAutoTexts.enabled },
  orchestration: { category: "roster", target: () => orchestrationCard },
  appearance: { category: "general", target: () => accentCard.closest<HTMLElement>(".settings-section") ?? accentCard },
  todo: { category: "general", target: () => todoText.closest<HTMLElement>(".settings-row") ?? todoText },
};
let pendingReveal: SettingsRevealTarget | undefined;
function revealSetting(target: SettingsRevealTarget): void {
  if (current === null) {
    pendingReveal = target;
    return;
  }
  pendingReveal = undefined;
  const { category, target: place } = REVEAL_TARGETS[target];
  activateSettingsCategory(category);
  requestAnimationFrame(() => place().scrollIntoView({ block: "center" }));
}

function applyHostMessage(message: HostToSettingsPage): void {
  if (message.type === "revealSetting") revealSetting(message.target);
  else if (message.type === "conductorPreview") {
    if (message.requestId !== previewRequest) return;
    instructionPreview.textContent = message.text;
    instructionTokens.textContent = l10n.t("≈ {0} tokens", message.tokens);
  } else if (message.type === "recommendedRoster") renderRecommendation(message.revision, message.changes);
  else if (message.type === "migrationState") renderMigration(message);
  else if (message.type === "migrationProgress") {
    migrationProgress = message.progress;
    renderMigrationProgress();
  }
  else {
    render(message);
    if (pendingReveal !== undefined) revealSetting(pendingReveal);
  }
}
let composingText = false;
const deferredMessages: HostToSettingsPage[] = [];
window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (!isHostToSettingsPage(event.data)) return;
  if (composingText) deferredMessages.push(event.data);
  else applyHostMessage(event.data);
});
document.addEventListener("compositionstart", () => { composingText = true; });
document.addEventListener("compositionend", () => {
  composingText = false;
  setTimeout(() => {
    if (composingText) return;
    for (const message of deferredMessages.splice(0)) applyHostMessage(message);
  }, 0);
});
renderSettingsToc();
post({ type: "settingsPageReady" });
