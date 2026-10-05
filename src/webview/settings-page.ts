import { createAccentSettings } from "./accent-settings";
import { bindUserLabel, setDisplayName } from "./user-label";
import { DISPLAY_NAME_MAX, displayNameLength, normalizeDisplayName } from "../display-name";
import { normalizeSystemAppExtension } from "../file-link-open-mode";
import { EXECUTORS, DEFAULT_EXECUTOR, canonicalExecutorEfforts, executorModelList, modelSelectionState, isExecutorId, isExternalExecutorId, rowEfforts, rowComplete, type ExecutorRow } from "../orchestration-executors";
import { modelListStatusText } from "../model-display-name";
import { emptyOrchestrationRole, externalExecutorName, isExternalModel, isExternalTimeout, orchestrationVariants, orchestrationExternalTargets } from "../orchestration-roster";
import { type OrchestrationSettingRow } from "../orchestration-roster";
import * as l10n from "@vscode/l10n";
import {
  FILE_LINK_BOOLEAN_SETTINGS,
  normalizeProfileSources,
  PROFILE_SOURCES,
  type ProfileSource,
  isHostToSettingsPage,
  type ApiKeyPolicy,
  type ComposerSendKey,
  type FileLinkBooleanSetting,
  type HostToSettingsPage,
  type SettingsPageToHost,
  type SettingWriteFailure,
} from "../protocol";

declare function acquireVsCodeApi(): { postMessage(message: SettingsPageToHost): void; getState(): { category?: string } | undefined; setState(state: { category: string }): void };

const vscode = acquireVsCodeApi();

type SettingsState = Extract<HostToSettingsPage, { type: "settingsState" }>;

let rowSerial = 0;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function section(root: HTMLElement, title: string): HTMLElement {
  const id = `settings-section-${++rowSerial}`;
  const wrap = element("section", "settings-section");
  wrap.setAttribute("aria-labelledby", id);
  const heading = element("h2", "settings-section-title", title);
  heading.id = id;
  const card = element("div", "settings-card");
  wrap.append(heading, card);
  root.appendChild(wrap);
  return card;
}

function row(card: HTMLElement, label: string, description: string, control: HTMLElement, focusTarget?: () => HTMLElement | undefined): HTMLElement {
  const serial = ++rowSerial;
  const line = element("div", "settings-row");
  const text = element("div", "settings-row-text");
  const name = element("label", "settings-row-label", label);
  name.id = `settings-label-${serial}`;
  if (focusTarget) name.addEventListener("click", () => focusTarget()?.focus());
  else name.htmlFor = control.id;
  const desc = element("div", "settings-row-description", description);
  desc.id = `settings-description-${serial}`;
  text.append(name, desc);
  control.setAttribute("aria-labelledby", name.id);
  control.setAttribute("aria-describedby", desc.id);
  const holder = element("div", "settings-row-control");
  holder.appendChild(control);
  line.append(text, holder);
  card.appendChild(line);
  return text;
}

function rowNote(text: HTMLElement, className: string, note: string): HTMLElement {
  const el = element("div", className, note);
  el.id = `settings-note-${++rowSerial}`;
  text.appendChild(el);
  return el;
}

function switchButton(id: string): HTMLButtonElement {
  const button = element("button", "settings-switch");
  button.id = id;
  button.type = "button";
  button.setAttribute("role", "switch");
  button.disabled = true;
  button.appendChild(element("span", "settings-switch-thumb"));
  return button;
}

function select<V extends string>(options: Array<[V, string]>): HTMLSelectElement {
  const el = element("select", "settings-select");
  const unknown = element("option", "settings-option-unknown", "");
  unknown.value = "";
  unknown.disabled = true;
  el.appendChild(unknown);
  for (const [value, text] of options) {
    const option = element("option", "", text);
    option.value = value;
    el.appendChild(option);
  }
  el.value = "";
  el.disabled = true;
  return el;
}

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
const settingsCategories = [
  { key: "general", title: l10n.t("General") },
  { key: "files", title: l10n.t("File links") },
  { key: "roster", title: l10n.t("Agent roster") },
].map((category, index) => {
  const button = element("button", "settings-tab");
  button.type = "button";
  button.id = `settings-nav-${category.key}`;
  const number = element("span", "settings-tab-number", String(index + 1).padStart(2, "0"));
  number.setAttribute("aria-hidden", "true");
  button.append(number, element("span", "settings-tab-label", category.title));
  const panel = element("div", "settings-category");
  panel.id = `settings-category-${category.key}`;
  panel.setAttribute("aria-labelledby", button.id);
  button.setAttribute("aria-controls", panel.id);
  settingsNav.appendChild(button);
  settingsContent.appendChild(panel);
  return { ...category, button, panel };
});
function activateSettingsCategory(key: string): void {
  for (const category of settingsCategories) {
    const active = category.key === key;
    category.panel.hidden = !active;
    if (active) category.button.setAttribute("aria-current", "page");
    else category.button.removeAttribute("aria-current");
    if (active) settingsPageTitle.textContent = category.title;
  }
  vscode.setState({ category: key });
  renderSettingsToc();
}
function renderSettingsToc(): void {
  const panel = settingsCategories.find((category) => !category.panel.hidden)?.panel;
  const headings = panel ? Array.from(panel.querySelectorAll<HTMLElement>("h2")) : [];
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
for (const [index, category] of settingsCategories.entries()) {
  category.button.addEventListener("click", () => activateSettingsCategory(category.key));
  category.button.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activateSettingsCategory(category.key);
      return;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
    event.preventDefault();
    settingsCategories[(index + (event.key === "ArrowDown" ? 1 : -1) + settingsCategories.length) % settingsCategories.length].button.focus();
  });
}
const savedSettingsCategory = vscode.getState()?.category;
activateSettingsCategory(settingsCategories.some((category) => category.key === savedSettingsCategory) ? savedSettingsCategory! : "general");
settingsBody.append(settingsContent, settingsToc);
settingsMain.append(settingsPageHead, settingsBody);
settingsShell.append(settingsNav, settingsMain);
root.appendChild(settingsShell);
const [generalCategory, fileCategory, rosterCategory] = settingsCategories.map((category) => category.panel);
const accentCard = section(generalCategory, l10n.t("Appearance"));
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
displayNameRow.appendChild(displayNamePreview());
let pendingDisplayName: number | null = null;
let queuedDisplayName: string | null = null;
let displayNameEdited = false;
function displayNamePreview(): HTMLElement {
  const preview = element("div", "settings-name-preview");
  preview.setAttribute("role", "group");
  const caption = element("div", "l-label settings-preview-caption", l10n.t("Where it appears"));
  caption.id = "setting-display-name-preview";
  preview.setAttribute("aria-labelledby", caption.id);
  const chat = element("div", "settings-preview-chat");
  const turn = (role: "user" | "assistant", text: string): HTMLElement => {
    const block = element("div", `settings-preview-turn ${role}`);
    const label = element("div", "turn-label");
    label.appendChild(role === "user" ? bindUserLabel(element("span", "turn-label-name")) : element("span", "turn-label-name", "Claude"));
    block.append(label, element("div", "settings-preview-message", text));
    return block;
  };
  chat.append(element("div", "l-label settings-preview-place", l10n.t("Chat")),
    turn("user", l10n.t("Add a Mark all done button to the footer.")),
    turn("assistant", l10n.t("Should it also mark todos hidden by the current filter?")));
  const markdown = element("div", "settings-preview-export");
  const markdownHeading = element("span", "settings-preview-md-name");
  const markdownLine = element("pre", "settings-preview-md");
  markdownLine.append(element("span", "settings-preview-md-mark", "## "), markdownHeading);
  markdown.append(element("div", "l-label settings-preview-place", l10n.t("Markdown export")), markdownLine);
  const left = element("div", "settings-preview-left");
  left.append(chat, markdown);
  const youColumn = element("div", "settings-preview-you");
  const youHead = element("div", "settings-preview-you-head");
  youHead.append(bindUserLabel(element("span", "you-label")), element("div", "you-heading", l10n.t("Your decisions, approvals and checks")));
  const card = (kind: string, title: string): HTMLElement => {
    const item = element("div", "settings-preview-card");
    const square = element("span", "you-square");
    square.setAttribute("aria-hidden", "true");
    const body = element("div", "settings-preview-card-body");
    const label = element("div", "ask-label");
    label.append(bindUserLabel(element("span", "ask-label-name")), element("span", "ask-label-kind", ` · ${kind}`));
    body.append(label, element("div", "settings-preview-card-title", title));
    item.append(square, body);
    return item;
  };
  youColumn.append(element("div", "l-label settings-preview-place", l10n.t("YOU column")), youHead,
    card(l10n.t("Decision"), l10n.t("Should it also mark todos hidden by the current filter?")),
    card(l10n.t("Machine check"), l10n.t("Check the footer buttons in the app")));
  const grid = element("div", "settings-preview-grid");
  grid.append(left, youColumn);
  preview.append(caption, grid);
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
function capDisplayNameInput(): void {
  const raw = displayNameInput.value.replace(/[\r\n]+/g, " ");
  const entered = displayNameLength(raw);
  displayNameNotice.textContent = entered > DISPLAY_NAME_MAX ? l10n.t("{0} characters were entered, so the first {1} are used.", entered, DISPLAY_NAME_MAX) : "";
  if (entered > DISPLAY_NAME_MAX) displayNameInput.value = normalizeDisplayName(raw);
  else if (raw !== displayNameInput.value) displayNameInput.value = raw;
}
displayNameInput.addEventListener("input", (event) => {
  displayNameEdited = true;
  if (!(event as InputEvent).isComposing) capDisplayNameInput();
  renderDisplayNameInput();
});
displayNameInput.addEventListener("compositionend", () => {
  capDisplayNameInput();
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
  if (event.key === "Enter" && !event.isComposing) displayNameInput.dispatchEvent(new Event("change"));
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
const learningCard = section(generalCategory, l10n.t("Learning"));
const learningSwitch = switchButton("setting-learning-enabled");
const learningText = row(learningCard, l10n.t("Enable learning"), l10n.t("Turning learning off stops delivery in running conversations. Turning it on applies from the next conversation. Recording and research remain available."), learningSwitch);

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
    : list?.state !== "ok" ? l10n.t("Loading models. This may take a few seconds after starting a conversation.") : "";
  if (!missing && list?.state === "failed") initialModelNote.textContent = modelListStatusText(list, state.externalDetection.claude);
  initialModelNote.hidden = !initialModelNote.textContent;
}
initialModelSelect.addEventListener("change", () => {
  if (pendingInitialModel !== null) return;
  pendingInitialModel = nextRequestId();
  initialModelSelect.disabled = true;
  post({ type: "setInitialModel", requestId: pendingInitialModel, model: initialModelSelect.value });
});

const restoreSwitch = element("button", "settings-switch");
restoreSwitch.id = "setting-restore-tabs";
restoreSwitch.type = "button";
restoreSwitch.setAttribute("role", "switch");
restoreSwitch.disabled = true;
restoreSwitch.appendChild(element("span", "settings-switch-thumb"));
const restoreText = row(
  chatCard,
  l10n.t("Restore tabs on startup"),
  l10n.t("Reopen the conversation tabs that were open when the window was last closed or reloaded. Tabs that never sent a message are not restored."),
  restoreSwitch
);
const autoContinueSwitch = switchButton("setting-auto-continue-usage-limit");
row(chatCard, l10n.t("Resume automatically when the usage limit resets"), l10n.t("When the claude.ai usage limit stops a conversation, continue it automatically after the limit resets. The same setting is used by Claude Code in the terminal."), autoContinueSwitch);

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
    const remove = element("button", "settings-segment", "×");
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
const rosterRows = element("div", "settings-roster-rows");
rosterCategory.appendChild(rosterRows);
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
const addButton = element("button", "settings-segment", l10n.t("Add role"));
addButton.id = "setting-add-role";
addButton.type = "button";
addButton.disabled = true;
const defaultsButton = element("button", "settings-segment", l10n.t("Restore defaults"));
defaultsButton.id = "setting-restore-roster";
defaultsButton.type = "button";
defaultsButton.disabled = true;
const roleError = element("p", "settings-row-note");
roleError.id = "setting-role-error";
roleError.setAttribute("role", "alert");
roleInput.setAttribute("aria-describedby", roleError.id);
roleField.append(roleLabel, roleInput, roleError);
addGroup.append(roleField, addButton, defaultsButton);
rosterCategory.appendChild(addGroup);
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
const researchBlock = element("div", "settings-research");
researchBlock.setAttribute("role", "group");
researchBlock.setAttribute("aria-labelledby", "setting-research-text");
const researchText = element("p", "settings-research-text");
researchText.id = "setting-research-text";
const researchMissing = element("button", "settings-segment", l10n.t("Research"));
researchMissing.id = "setting-research-missing";
researchMissing.type = "button";
researchMissing.addEventListener("click", () => requestResearch(current?.researchTargets ?? []));
const effortProposal = element("button", "settings-segment", l10n.t("Suggest efforts"));
effortProposal.id = "setting-suggest-efforts";
effortProposal.type = "button";
effortProposal.addEventListener("click", () => requestResearch(current?.researchTargets ?? [], "effort"));
const researchActions = element("div", "settings-detection-header");
researchActions.append(researchText, researchMissing, effortProposal);
const researchReason = element("p", "settings-muted");
researchReason.id = "setting-research-reason";
const effortReason = element("p", "settings-muted");
effortReason.id = "setting-effort-reason";
const researchUsage = element("p", "settings-muted", l10n.t("Research opens a new conversation tab and uses model usage there."));
researchUsage.id = "setting-research-usage";
const researchSources = element("div", "settings-research-sources");
researchSources.setAttribute("role", "group");
const researchSourcesLabel = element("span", "settings-muted", l10n.t("Research sources"));
researchSourcesLabel.id = "setting-research-sources-label";
researchSources.setAttribute("aria-labelledby", researchSourcesLabel.id);
const researchSourcesNote = element("p", "settings-muted", l10n.t("At least one source is required, so the last source cannot be turned off."));
researchSourcesNote.id = "setting-research-sources-note";
let pendingSources: number | null = null;
const sourceLabels: Record<ProfileSource, string> = { official: l10n.t("Official material"), artificialAnalysis: "Artificial Analysis" };
const sourceChips = PROFILE_SOURCES.map(source => {
  const chip = element("button", "settings-segment settings-chip");
  chip.id = `setting-research-source-${source}`;
  chip.type = "button";
  chip.dataset.source = source;
  chip.addEventListener("click", () => {
    if (!current || pendingSources !== null) return;
    const sources = normalizeProfileSources(current.profileSources);
    if (sources.length === 1 && sources.includes(source)) return;
    const next = sources.includes(source) ? sources.filter(item => item !== source) : [...sources, source];
    pendingSources = nextRequestId();
    post({ type: "setProfileSources", requestId: pendingSources, sources: next });
    renderProfileResearch(current);
  });
  return chip;
});
researchSources.append(researchSourcesLabel, ...sourceChips);
policyCard.append(policyHeader, policyHelp, policyInput, policyProposal, policyCounter);
renderPolicyCounter();
const instructionDetails = element("details", "settings-instruction-details");
const instructionPreview = element("pre", "settings-instruction-preview");
instructionPreview.id = "setting-conductor-preview";
instructionPreview.tabIndex = 0;
const instructionTokens = element("p", "settings-muted");
instructionTokens.id = "setting-conductor-tokens";
instructionDetails.append(element("summary", "", l10n.t("Review what the conductor receives")), element("p", "settings-muted", l10n.t("This preview omits learned rules that depend on the conversation. Changes apply at the next normal connection start.")), instructionTokens, instructionPreview);
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
function requestResearch(targets: string[], purpose?: "effort"): void {
  if (targets.length) post({ type: "researchModelProfiles", targets, ...(purpose ? { purpose } : {}) });
}
function renderProfileResearch(state: SettingsState): void {
  if (pendingSources === state.replyTo) pendingSources = null;
  const sources = normalizeProfileSources(state.profileSources);
  sourceChips.forEach((chip, index) => {
    const source = PROFILE_SOURCES[index], pressed = sources.includes(source);
    chip.textContent = (pressed ? "✓ " : "") + sourceLabels[source];
    chip.setAttribute("aria-pressed", String(pressed));
    chip.disabled = pendingSources !== null;
    if (pressed && sources.length === 1) {
      chip.setAttribute("aria-disabled", "true");
      chip.setAttribute("aria-describedby", researchSourcesNote.id);
    } else {
      chip.removeAttribute("aria-disabled");
      chip.removeAttribute("aria-describedby");
    }
  });
  researchBlock.setAttribute("aria-labelledby", state.researchText ? researchText.id : researchSourcesLabel.id);
  researchText.textContent = state.researchText ?? "";
  researchMissing.disabled = !!state.researchUnavailable || !(state.researchTargets?.length);
  if (state.researchUnavailable) researchMissing.title = state.researchUnavailable;
  else researchMissing.removeAttribute("title");
  researchMissing.setAttribute("aria-describedby", [researchText.id,
    state.researchUnavailable ? researchReason.id : !researchMissing.disabled ? researchUsage.id : ""].filter(Boolean).join(" "));
  const effortUnavailable = state.researchUnavailable || state.effortUnavailable;
  effortProposal.disabled = researchMissing.disabled || !!effortUnavailable;
  if (effortUnavailable) effortProposal.title = effortUnavailable;
  else effortProposal.removeAttribute("title");
  effortProposal.setAttribute("aria-describedby", [researchMissing.getAttribute("aria-describedby"), state.effortUnavailable ? effortReason.id : ""].filter(Boolean).join(" "));
  effortReason.textContent = state.effortUnavailable ?? "";
  researchReason.textContent = state.researchUnavailable ?? "";
  researchBlock.replaceChildren(...(state.researchText
    ? [researchActions, ...(state.effortUnavailable ? [effortReason] : []), ...(state.researchUnavailable ? [researchReason] : !researchMissing.disabled ? [researchUsage] : [])] : []),
    researchSources, ...(sources.length === 1 ? [researchSourcesNote] : []));
  policyCard.appendChild(researchBlock);
}
const detectionControls = Object.values(EXECUTORS).map(({ id: executor }) => {
  const badge = element("span", "settings-detection-badge");
  badge.id = `external-status-${executor}`;
  const text = row(detectionCard, externalExecutorName(executor), "", badge);
  text.parentElement!.id = `external-detection-${executor}`;
  const modelNote = element("div", "settings-row-description settings-model-list-note");
  text.appendChild(modelNote);
  return { executor, badge, description: text.querySelector<HTMLElement>(".settings-row-description")!, modelNote };
});
const timeoutGroup = element("div", "settings-timeout-control");
timeoutGroup.id = "setting-timeout-group";
const externalTimeout = element("input", "settings-input");
externalTimeout.id = "setting-external-timeout";
externalTimeout.type = "number";
externalTimeout.min = "1";
externalTimeout.max = "120";
externalTimeout.step = "any";
externalTimeout.disabled = true;
timeoutGroup.append(externalTimeout, element("span", "", "min"));
const timeoutText = row(detectionCard, l10n.t("Wait limit per run"), l10n.t("External CLIs that exceed this limit are terminated and recorded as timed out."), timeoutGroup, () => externalTimeout);
timeoutText.querySelector("label")!.htmlFor = externalTimeout.id;
externalTimeout.setAttribute("aria-labelledby", timeoutText.querySelector("label")!.id);
externalTimeout.setAttribute("aria-describedby", timeoutText.querySelector(".settings-row-description")!.id);
externalBlock.append(detectionHeader, element("p", "settings-row-description settings-environment-help", l10n.t("CLIs installed on this PC. Used by the Claude / Antigravity / Codex rows in the agent roster.")), detectionCard);
rosterCategory.appendChild(externalBlock);
externalTimeout.addEventListener("change", () => {
  const value = Number(externalTimeout.value);
  if (isExternalTimeout(value)) writeOrchestration("externalTimeoutMinutes", value);
  else externalTimeout.reportValidity();
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
  renderProfileResearch(state);
  externalTimeout.disabled = false;
  externalTimeout.value = String(state.externalTimeoutMinutes);
}
let pendingOrchestration: number | null = null;
let settingsRosterFocusId: string | undefined;
const settingsRosterDrafts = new Map<string, ExecutorRow>();

function writeOrchestration(setting: "enabled" | "agents" | "conductorPolicy" | "externalTimeoutMinutes", value: unknown): void {
  if (!current || pendingOrchestration !== null) return;
  const requestId = nextRequestId();
  pendingOrchestration = requestId;
  settingsRosterFocusId = rosterCategory.contains(document.activeElement) ? document.activeElement?.id : undefined;
  lockOrchestration();
  post({ type: "setOrchestrationSetting", requestId, setting, value });
}
function writeRoster(rows: readonly OrchestrationSettingRow[]): void {
  writeOrchestration("agents", rows.map((entry) => ({ ...entry, rows: entry.rows.map((rosterRow) => ({ ...rosterRow, efforts: canonicalExecutorEfforts(rosterRow.executor, rosterRow.efforts) })) })));
}
function lockOrchestration(): void {
  if (pendingOrchestration !== null) {
    rosterCategory.querySelectorAll<HTMLButtonElement | HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>("button, input, textarea, select").forEach((control) => { control.disabled = true; });
  }
}
function settingsHiddenLabel(control: HTMLElement, title: string): HTMLLabelElement {
  const label = element("label", "settings-visually-hidden", title);
  label.htmlFor = control.id;
  return label;
}
function renderPolicyCounter(text = policyInput.value): void {
  const count = Array.from(text).length;
  const warning = count > 1500;
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
  if (pendingOrchestration === state.replyTo) pendingOrchestration = null;
  for (const role of settingsRosterDrafts.keys()) {
    if (!state.orchestrationEnabled || !state.orchestrationAgents.some((entry) => entry.role === role)) settingsRosterDrafts.delete(role);
  }
  orchestrationSwitch.disabled = false;
  orchestrationSwitch.setAttribute("aria-checked", String(state.orchestrationEnabled));
  const focusedId = settingsRosterFocusId ?? (rosterCategory.contains(document.activeElement) ? document.activeElement?.id : undefined);
  rosterRows.replaceChildren();
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
          ? l10n.t("Inspects a finished change. It looks with eyes other than the author's, so use opus, Antigravity or Codex.") : undefined;
    if (goldenRule) {
      role.title = goldenRule;
      const accessibleRule = element("span", "settings-visually-hidden", goldenRule);
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
    description.addEventListener("change", () => update({ description: description.value }));
    card.append(header, settingsHiddenLabel(description, l10n.t("Description")), description);
    const wrapper = element("div", "settings-matrix-wrapper");
    wrapper.tabIndex = 0;
    wrapper.setAttribute("role", "group");
    wrapper.setAttribute("aria-label", `${entry.role} Model / Effort`);
    const matrix = element("div", "settings-matrix");
    const draft = settingsRosterDrafts.get(entry.role);
    const visibleRows = draft ? [...entry.rows, draft] : entry.rows;
    visibleRows.forEach((executorRow, rowIndex) => {
      const definition = EXECUTORS[executorRow.executor];
      const isDraft = rowIndex === entry.rows.length;
      const updateRow = (patch: Partial<ExecutorRow>) => {
        if (controlsDisabled || pendingOrchestration !== null) return;
        const nextRow = { ...executorRow, ...patch };
        if (isDraft) {
          if (!nextRow.model) {
            settingsRosterDrafts.set(entry.role, nextRow);
            renderOrchestration(state);
            return;
          }
          settingsRosterDrafts.delete(entry.role);
          update({ rows: [...entry.rows, nextRow] });
        } else update({ rows: entry.rows.map((value, i) => i === rowIndex ? nextRow : value) });
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
        const option = (model: string, label: string) => {
          const item = element("option", "", label);
          item.value = `${candidate.id}/${model}`;
          item.disabled = entry.rows.some((value, i) => i !== rowIndex && value.executor === candidate.id && value.model === model);
          group.appendChild(item);
        };
        if (selection.checking) {
          group.disabled = true;
          option("", l10n.t("checking…"));
          group.firstElementChild?.setAttribute("disabled", "");
        } else if (choices) {
          for (const choice of choices) option(choice.model, choice.label ?? choice.model);
        } else option("", l10n.t("model list unavailable — type a model ID"));
        if (!group.disabled && candidate.id === executorRow.executor && executorRow.model && !choices?.some((choice) => choice.model === executorRow.model)) {
          option(executorRow.model, executorRow.model + l10n.t(" (not in list)"));
        }
        if (selection.refreshFailed) {
          const unavailable = element("option", "", l10n.t("List not obtained (use Recheck to try again)"));
          unavailable.value = "";
          unavailable.disabled = true;
          group.appendChild(unavailable);
        }
        cascade.appendChild(group);
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
      if (modelSelectionState(executorRow.executor, list, state.externalDetection[executorRow.executor]).manual) {
        const input = element("input", "settings-input");
        input.id = `roster-${index}-row-${rowIndex}-model-id`;
        input.type = "text";
        input.value = executorRow.model;
        input.disabled = controlsDisabled;
        input.addEventListener("change", () => {
          input.setCustomValidity(isExternalModel(input.value) ? "" : l10n.t("Use a model ID starting with a letter or digit, followed by letters, digits, dots, underscores, colons or hyphens."));
          if (entry.rows.some((value, i) => i !== rowIndex && value.executor === executorRow.executor && value.model === input.value)) input.setCustomValidity(l10n.t("This model already exists."));
          if (input.reportValidity()) updateRow({ model: input.value, efforts: [] });
        });
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
          const pressed = executorRow.efforts.includes(effort);
          if (!executorRow.model || !effort || (!supported.includes(effort) && !pressed)) { matrix.appendChild(element("span", "settings-effort-slot")); continue; }
          const button = element("button", "settings-segment settings-chip", `${pressed ? "✓ " : ""}${effort}`);
          button.id = `roster-${index}-row-${rowIndex}-${effort}`;
          button.type = "button";
          button.dataset.chip = effort;
          button.dataset.column = String(column + 2);
          button.setAttribute("aria-pressed", String(pressed));
          button.setAttribute("aria-label", `${entry.role} ${definition.displayName} ${cascade.selectedOptions[0]?.textContent ?? executorRow.model} ${effort}`);
          button.disabled = controlsDisabled || !supported.includes(effort);
          if (!supported.includes(effort)) {
            button.classList.add("settings-unsupported");
            button.title = l10n.t(" (not supported by this model)");
            button.prepend(element("span", "", "⚠ "));
          }
          button.addEventListener("click", () => updateRow({ efforts: pressed ? executorRow.efforts.filter((value) => value !== effort) : [...executorRow.efforts, effort] }));
          matrix.appendChild(button);
        }
      }
      const removeRow = element("button", "settings-link settings-remove-model", "×");
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
      if (!rowComplete(executorRow, state.externalModels)) matrix.appendChild(element("div", "settings-matrix-caption settings-muted settings-incomplete-note", l10n.t("Select a Model and an Effort to enable this row")));
      if (entry.role === "worker" && !definition.writable) matrix.appendChild(element("div", "settings-matrix-caption settings-muted settings-worker-note", l10n.t("This executor cannot edit files; use it for explorer or reviewer")));
      const unsupported = executorRow.efforts.filter((effort) => !supported.includes(effort));
      if (unsupported.length) matrix.appendChild(element("div", "settings-matrix-caption settings-muted settings-effort-warning", l10n.t("⚠ Unsupported Effort kept in settings and excluded from targets: {0}", unsupported.join(", "))));
    });
    const addRow = element("button", "settings-link settings-add-row", l10n.t("+ Add row"));
    addRow.id = `roster-${index}-add-row`;
    addRow.type = "button";
    addRow.disabled = controlsDisabled || !!draft || visibleRows.length >= 12;
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
  policyInput.value = state.conductorPolicy;
  renderPolicyCounter(state.conductorPolicy);
  renderPolicyDefaults(state);
  previewRequest = 0;
  renderInstructionPreview(state);
  renderExternal(state);
  lockOrchestration();
  if (focusedId) document.getElementById(focusedId)?.focus();
  if (pendingOrchestration === null) settingsRosterFocusId = undefined;
}
orchestrationSwitch.addEventListener("click", () => writeOrchestration("enabled", !current?.orchestrationEnabled));
function addRole(): void {
  if (!current?.orchestrationEnabled || pendingOrchestration !== null) return;
  const role = roleInput.value;
  if (!/^[a-z][a-z0-9-]*$/.test(role)) {
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
defaultsButton.addEventListener("click", () => { if (current) writeRoster(current.orchestrationDefaults); });
policyDefaultsButton.addEventListener("click", () => { if (current) writeOrchestration("conductorPolicy", current.conductorPolicyDefault); });
policyInput.addEventListener("change", () => writeOrchestration("conductorPolicy", policyInput.value));
policyInput.addEventListener("input", () => { renderPolicyCounter(); if (current) { renderPolicyDefaults(current); requestInstructionPreview(); } });

const footer = element("div", "settings-footer");
const moreLink = element("button", "settings-link", l10n.t("Open other settings in VS Code Settings"));
moreLink.type = "button";
footer.appendChild(moreLink);
generalCategory.appendChild(footer);

let current: SettingsState | null = null;
let requestSerial = 0;
const nextRequestId = (): number => ++requestSerial;
const pending: { autoContinue: number | null; restore: number | null; apiKey: number | null; learning: number | null } = { autoContinue: null, restore: null, apiKey: null, learning: null };
const pendingFileLink: Record<FileLinkBooleanSetting, number | null> = {
  fileLinkInstruction: null,
  planInstruction: null,
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
    case "setLearningEnabled": return learningText;
    case "setApiKeyPolicy": return apiKeyText;
    case "setFileLinkSetting": return message.setting === "openWithSystemApp" ? extensionText : rowTextOf(fileLinkSwitches[message.setting]);
    case "setOrchestrationSetting":
      return message.setting === "externalTimeoutMinutes" ? timeoutText : message.setting === "conductorPolicy" ? policyCard : orchestrationText;
    case "setProfileSources": return policyCard;
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

function renderRowError(anchor: HTMLElement, failure: SettingWriteFailure | undefined): void {
  rowErrors.get(anchor)?.remove();
  rowErrors.delete(anchor);
  if (!failure) return;
  const note = element("div", "settings-row-note settings-row-error");
  note.setAttribute("role", "alert");
  const mark = element("span", "settings-row-error-mark", "✗");
  mark.setAttribute("aria-hidden", "true");
  const unregistered = failure.kind === "unregistered";
  const action = element("button", "settings-link settings-row-error-action",
    unregistered ? l10n.t("Reload window") : l10n.t("Open settings.json"));
  action.type = "button";
  action.addEventListener("click", () => post({ type: "settingWriteFailureAction", action: unregistered ? "reloadWindow" : "openSettingsJson" }));
  note.append(mark, " ", unregistered
    ? l10n.t("Could not save. Reload the window and try again.")
    : l10n.t("Could not save: {0}", failure.reason), " ", action);
  anchor.appendChild(note);
  rowErrors.set(anchor, note);
}

function render(state: SettingsState): void {
  current = state;
  const anchor = state.replyTo === undefined ? undefined : requestAnchors.get(state.replyTo);
  if (anchor) {
    requestAnchors.delete(state.replyTo!);
    renderRowError(anchor, state.writeFailure);
  }
  renderInitialModel(state);
  renderDisplayName(state);
  renderAccent(state.appearance, state.replyTo);
  if (pending.autoContinue === state.replyTo) pending.autoContinue = null;
  autoContinueSwitch.setAttribute("aria-checked", String(state.autoContinueAtUsageLimit));
  autoContinueSwitch.disabled = pending.autoContinue !== null;
  renderSystemAppExtensions(state);
  renderOrchestration(state);
  if (pending.learning === state.replyTo) pending.learning = null;
  learningSwitch.setAttribute("aria-checked", String(state.learningEnabled));
  learningSwitch.disabled = pending.learning !== null;
  if (pending.restore === state.replyTo) pending.restore = null;
  if (pending.apiKey === state.replyTo) pending.apiKey = null;
  for (const key of FILE_LINK_BOOLEAN_SETTINGS) {
    if (pendingFileLink[key] === state.replyTo) pendingFileLink[key] = null;
    fileLinkSwitches[key].setAttribute("aria-checked", String(state[key]));
  }
  fileLinkSwitches.fileLinkInstruction.disabled = false;
  fileLinkSwitches.planInstruction.disabled = false;
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
apiKeyGroup.addEventListener("keydown", (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
  if (step === 0) return;
  e.preventDefault();
  const from = apiKeyRadios.findIndex((r) => r === document.activeElement);
  if (from < 0 || current === null || pending.apiKey !== null) return;
  const target = apiKeyRadios[(from + step + apiKeyRadios.length) % apiKeyRadios.length];
  target.focus();
  requestApiKeyPolicy(target.dataset.value as ApiKeyPolicy);
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
learningSwitch.addEventListener("click", () => {
  if (current === null || pending.learning !== null) return;
  const requestId = nextRequestId();
  pending.learning = requestId;
  learningSwitch.disabled = true;
  post({ type: "setLearningEnabled", requestId, enabled: !current.learningEnabled });
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

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (!isHostToSettingsPage(event.data)) return;
  if (event.data.type === "conductorPreview") {
    if (event.data.requestId !== previewRequest) return;
    instructionPreview.textContent = event.data.text;
    instructionTokens.textContent = l10n.t("≈ {0} tokens", event.data.tokens);
  } else render(event.data);
});
renderSettingsToc();
post({ type: "settingsPageReady" });
