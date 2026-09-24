import { createAccentSettings } from "./accent-settings";
import { normalizeSystemAppExtension } from "../file-link-open-mode";
import { EXECUTORS, DEFAULT_EXECUTOR, canonicalExecutorEfforts, executorModelList, isExecutorId, isExternalExecutorId, rowEfforts, rowComplete, type ExecutorRow } from "../orchestration-executors";
import { conductorInstruction, estimateTokens, emptyOrchestrationRole, externalExecutorName, isExternalModel, isExternalTimeout, orchestrationVariants, orchestrationExternalTargets } from "../orchestration-roster";
import { type OrchestrationSettingRow } from "../orchestration-roster";
import * as l10n from "@vscode/l10n";
import {
  FILE_LINK_BOOLEAN_SETTINGS,
  isHostToSettingsPage,
  type ApiKeyPolicy,
  type ComposerSendKey,
  type FileLinkBooleanSetting,
  type HostToSettingsPage,
  type SettingsPageToHost,
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

// focusTarget を渡さない control は <label for> で結ぶので、id を持つ select / button に限る
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

// 実効値が届くまでは空の選択肢を選んだまま無効にする（既定値を現在値として名乗らない。R-DSP-01）
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
const settingsCategories = [
  { key: "general", title: l10n.t("General") },
  { key: "files", title: l10n.t("File links") },
  { key: "roster", title: l10n.t("Agent roster") },
].map((category) => {
  const button = element("button", "settings-segment settings-nav-button", category.title);
  button.type = "button";
  button.id = `settings-nav-${category.key}`;
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
  }
  vscode.setState({ category: key });
}
for (const [index, category] of settingsCategories.entries()) {
  category.button.addEventListener("click", () => activateSettingsCategory(category.key));
  category.button.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      activateSettingsCategory(category.key);
      return;
    }
    if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return; // R-ORC-20
    event.preventDefault();
    settingsCategories[(index + (event.key === "ArrowDown" ? 1 : -1) + settingsCategories.length) % settingsCategories.length].button.focus();
  });
}
const savedSettingsCategory = vscode.getState()?.category;
activateSettingsCategory(settingsCategories.some((category) => category.key === savedSettingsCategory) ? savedSettingsCategory! : "general");
settingsShell.append(settingsNav, settingsContent);
root.appendChild(settingsShell);
const [generalCategory, fileCategory, rosterCategory] = settingsCategories.map((category) => category.panel);
const accentCard = section(generalCategory, l10n.t("Appearance"));
const renderAccent = createAccentSettings(accentCard, (setting, value) => {
  const requestId = nextRequestId();
  vscode.postMessage({ type: "setAccentSetting", requestId, setting, value });
  return requestId;
}, { row, rowNote, select });
const chatCard = section(generalCategory, l10n.t("Chat"));
const learningCard = section(generalCategory, l10n.t("Learning"));
const learningSwitch = switchButton("setting-learning-enabled");
row(learningCard, l10n.t("Enable learning"), l10n.t("Changes apply from the next session. Running conversations will not change."), learningSwitch);

const sendKeySelect = select<ComposerSendKey>([
  ["enter", "Enter"],
  ["shiftEnter", "Shift+Enter"],
]);
sendKeySelect.id = "setting-composer-send-key";
row(chatCard, l10n.t("Send shortcut"), l10n.t("Key that sends the message box contents. The other combination inserts a new line."), sendKeySelect);

const restoreSwitch = element("button", "settings-switch");
restoreSwitch.id = "setting-restore-tabs";
restoreSwitch.type = "button";
restoreSwitch.setAttribute("role", "switch");
restoreSwitch.disabled = true;
restoreSwitch.appendChild(element("span", "settings-switch-thumb"));
row(
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
row(
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
row(fileLinkCard, l10n.t("Open with the default app"), l10n.t("Open these file extensions with the default app only inside the workspace and conversation folder."), extensionControl, () => extensionInput);
let pendingExtensions: number | null = null;
function writeSystemAppExtensions(value: string[]): void {
  if (current === null || pendingExtensions !== null) return;
  pendingExtensions = nextRequestId();
  vscode.postMessage({ type: "setFileLinkSetting", requestId: pendingExtensions, setting: "openWithSystemApp", value });
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
const orchestrationNote = row(orchestrationCard, l10n.t("Enable the agent roster"), l10n.t("Changes apply from the next session. The roster of running conversations will not change."), orchestrationSwitch)
  .querySelector<HTMLElement>(".settings-row-description")!;
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
policyCard.append(policyHeader, policyHelp, policyInput, policyProposal, policyCounter);
renderPolicyCounter();
const instructionDetails = element("details", "settings-instruction-details");
const instructionPreview = element("pre", "settings-instruction-preview");
instructionPreview.id = "setting-conductor-preview";
instructionPreview.tabIndex = 0;
const instructionTokens = element("p", "settings-muted");
instructionTokens.id = "setting-conductor-tokens";
instructionDetails.append(element("summary", "", l10n.t("Review what the conductor receives")), instructionTokens, instructionPreview);
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
externalRecheck.addEventListener("click", () => vscode.postMessage({ type: "recheckExternalExecutors" }));
detectionHeader.append(externalHeading, externalRecheck);
const detectionControls = Object.values(EXECUTORS).map(({ id: executor }) => {
  const badge = element("span", "settings-detection-badge");
  badge.id = `external-status-${executor}`;
  const text = row(detectionCard, externalExecutorName(executor), "", badge);
  text.parentElement!.id = `external-detection-${executor}`;
  return { executor, badge, description: text.querySelector<HTMLElement>(".settings-row-description")! };
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
  if (isExternalTimeout(value)) writeOrchestration("externalTimeoutMinutes", value); // R-ORC-11
  else externalTimeout.reportValidity();
});

function settingsProbeReason(reason: string): string {
  if (reason === "timeout") return l10n.t("no response");
  if (reason === "empty-output") return l10n.t("no output");
  if (reason.startsWith("exit:")) return l10n.t("exit code {0}", reason.slice(5));
  return l10n.t("cannot start ({0})", reason.slice("spawn-error:".length));
}
function renderExternal(state: SettingsState): void {
  for (const { executor, badge, description } of detectionControls) {
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
  }
  externalRecheck.disabled = Object.values(EXECUTORS).some(({ id }) => state.externalDetection[id].state === "checking");
  externalTimeout.disabled = false;
  externalTimeout.value = String(state.externalTimeoutMinutes);
}
let pendingOrchestration: number | null = null;
let settingsRosterFocusId: string | undefined;
const settingsRosterDrafts = new Map<string, ExecutorRow>();

function writeOrchestration(setting: "enabled" | "agents" | "conductorPolicy" | "externalTimeoutMinutes", value: unknown): void {
  if (!current || pendingOrchestration !== null) return; // R-ORC-20
  const requestId = nextRequestId();
  pendingOrchestration = requestId;
  settingsRosterFocusId = rosterCategory.contains(document.activeElement) ? document.activeElement?.id : undefined;
  lockOrchestration();
  vscode.postMessage({ type: "setOrchestrationSetting", requestId, setting, value });
}
function writeRoster(rows: readonly OrchestrationSettingRow[]): void {
  writeOrchestration("agents", rows.map((entry) => ({ ...entry, rows: entry.rows.map((rosterRow) => ({ ...rosterRow, efforts: canonicalExecutorEfforts(rosterRow.executor, rosterRow.efforts) })) })));
}
function lockOrchestration(): void {
  if (pendingOrchestration !== null) { // R-ORC-20
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
function renderInstructionPreview(state: SettingsState): void {
  const roster = state.orchestrationAgents.filter((entry) => entry.enabled);
  instructionPreview.textContent = state.orchestrationEnabled
    ? conductorInstruction(roster, policyInput.value, orchestrationExternalTargets(roster, state.externalModels))
    : l10n.t("The agent roster is disabled, so no instruction is added.");
  instructionTokens.textContent = l10n.t("≈ {0} tokens", estimateTokens(instructionPreview.textContent));
}
function renderOrchestration(state: SettingsState): void {
  if (pendingOrchestration === state.replyTo) pendingOrchestration = null;
  for (const role of settingsRosterDrafts.keys()) {
    if (!state.orchestrationEnabled || !state.orchestrationAgents.some((entry) => entry.role === role)) settingsRosterDrafts.delete(role); // R-ORC-20
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
        if (controlsDisabled || pendingOrchestration !== null) return; // R-ORC-20
        const nextRow = { ...executorRow, ...patch };
        if (isDraft) {
          if (!nextRow.model) { // R-ORC-20
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
        if (detected?.state === "notInstalled") continue; // R-ORC-20
        const group = element("optgroup", "");
        group.label = candidate.displayName;
        const list = executorModelList(candidate.id, state.externalModels);
        const choices = candidate.models(list);
        const option = (model: string, label: string) => {
          const item = element("option", "", label);
          item.value = `${candidate.id}/${model}`;
          item.disabled = entry.rows.some((value, i) => i !== rowIndex && value.executor === candidate.id && value.model === model); // R-ORC-20
          group.appendChild(item);
        };
        if (candidate.kind === "external" && (detected?.state === "checking" || list?.state === "checking")) { // R-ORC-25
          group.disabled = true;
          option("", l10n.t("checking…"));
          group.firstElementChild?.setAttribute("disabled", "");
        } else if (choices) {
          for (const choice of choices) option(choice.model, choice.label ?? choice.model);
        } else option("", l10n.t("model list unavailable — type a model ID"));
        if (!group.disabled && candidate.id === executorRow.executor && executorRow.model && !choices?.some((choice) => choice.model === executorRow.model)) {
          option(executorRow.model, executorRow.model + l10n.t(" (not in list)")); // R-ORC-20
        }
        cascade.appendChild(group);
      }
      if (executorRow.model && !Array.from(cascade.options).some((option) => option.value === `${executorRow.executor}/${executorRow.model}`)) { // R-ORC-20
        const saved = element("option", "", `${definition.displayName} — ${executorRow.model}${l10n.t(" (not in list)")}`);
        saved.value = `${executorRow.executor}/${executorRow.model}`;
        saved.disabled = true;
        cascade.appendChild(saved);
      }
      cascade.value = executorRow.model ? `${executorRow.executor}/${executorRow.model}` : "";
      cascade.addEventListener("change", () => {
        const [executor, model] = cascade.value.split("/");
        if (!isExecutorId(executor) || model === undefined) return; // R-ORC-20
        updateRow({ executor, model, efforts: [] });
      });
      modelField.append(settingsHiddenLabel(cascade, `${entry.role} Model`), cascade);
      const list = executorModelList(executorRow.executor, state.externalModels);
      if (isExternalExecutorId(executorRow.executor) && (!definition.models(list) || state.externalDetection[executorRow.executor].state === "notInstalled")) {
        const input = element("input", "settings-input");
        input.id = `roster-${index}-row-${rowIndex}-model-id`;
        input.type = "text";
        input.value = executorRow.model;
        input.disabled = controlsDisabled;
        input.addEventListener("change", () => {
          input.setCustomValidity(isExternalModel(input.value) ? "" : l10n.t("Use a model ID starting with a letter or digit, followed by letters, digits, dots, underscores, colons or hyphens."));
          if (entry.rows.some((value, i) => i !== rowIndex && value.executor === executorRow.executor && value.model === input.value)) input.setCustomValidity(l10n.t("This model already exists.")); // R-ORC-20
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
          if (!executorRow.model || !effort || (!supported.includes(effort) && !pressed)) { matrix.appendChild(element("span", "settings-effort-slot")); continue; } // R-ORC-20
          const button = element("button", "settings-segment settings-chip", `${pressed ? "✓ " : ""}${effort}`);
          button.id = `roster-${index}-row-${rowIndex}-${effort}`;
          button.type = "button";
          button.dataset.chip = effort;
          button.dataset.column = String(column + 2);
          button.setAttribute("aria-pressed", String(pressed));
          button.setAttribute("aria-label", `${entry.role} ${definition.displayName} ${executorRow.model} ${effort}`);
          button.disabled = controlsDisabled || !supported.includes(effort); // R-ORC-12
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
      if (!rowComplete(executorRow, state.externalModels)) matrix.appendChild(element("div", "settings-matrix-caption settings-muted settings-incomplete-note", l10n.t("Select a Model and an Effort to enable this row"))); // R-ORC-20
      if (entry.role === "worker" && !definition.writable) matrix.appendChild(element("div", "settings-matrix-caption settings-muted settings-worker-note", l10n.t("This executor cannot edit files; use it for explorer or reviewer"))); // R-ORC-26
      const unsupported = executorRow.efforts.filter((effort) => !supported.includes(effort));
      if (unsupported.length) matrix.appendChild(element("div", "settings-matrix-caption settings-muted settings-effort-warning", l10n.t("⚠ Unsupported Effort kept in settings and excluded from targets: {0}", unsupported.join(", ")))); // R-ORC-12
    });
    const addRow = element("button", "settings-link settings-add-row", l10n.t("+ Add row"));
    addRow.id = `roster-${index}-add-row`;
    addRow.type = "button";
    addRow.disabled = controlsDisabled || !!draft || visibleRows.length >= 12; // R-ORC-20
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
    if (!controlsDisabled && !agentKeys.length && !externalKeys.length) { // R-ORC-20
      card.appendChild(element("p", "settings-role-warning settings-muted", l10n.t("No combination selected — this role is not injected")));
    }
    rosterRows.appendChild(card);
  });
  for (const control of [roleInput, addButton, defaultsButton, policyInput]) control.disabled = !state.orchestrationEnabled;
  policyInput.value = state.conductorPolicy;
  renderPolicyCounter(state.conductorPolicy);
  renderPolicyDefaults(state);
  renderInstructionPreview(state);
  renderExternal(state);
  lockOrchestration();
  if (focusedId) document.getElementById(focusedId)?.focus();
  if (pendingOrchestration === null) settingsRosterFocusId = undefined;
}
orchestrationSwitch.addEventListener("click", () => writeOrchestration("enabled", !current?.orchestrationEnabled));
function addRole(): void {
  if (!current?.orchestrationEnabled || pendingOrchestration !== null) return; // R-ORC-20
  const role = roleInput.value;
  if (!/^[a-z][a-z0-9-]*$/.test(role)) { // R-ORC-20
    roleError.textContent = l10n.t("Use a lowercase letter first, then lowercase letters, digits or hyphens.");
    return;
  }
  if (current.orchestrationAgents.some((entry) => entry.role === role)) { // R-ORC-20
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
policyInput.addEventListener("input", () => { renderPolicyCounter(); if (current) { renderPolicyDefaults(current); renderInstructionPreview(current); } });

const footer = element("div", "settings-footer");
const moreLink = element("button", "settings-link", l10n.t("Open other settings in VS Code Settings"));
moreLink.type = "button";
footer.appendChild(moreLink);
generalCategory.appendChild(footer);

let current: SettingsState | null = null;
let requestSerial = 0;
const nextRequestId = (): number => ++requestSerial;
// 自分の要求への返送（replyTo が一致。失敗時の返送を含む）が届くまで、同じ操作の再押下を捨てる。current は返送でしか
// 変わらないため、捨てないと 2 回目も 1 回目と同じ値を送り、戻したい意図が失われる。構成変更の通知や別の要求への返送では
// 解かない（それらは自分の書込みの完了を意味しない）（R-DSP-01）
const pending: { autoContinue: number | null; restore: number | null; apiKey: number | null; learning: number | null } = { autoContinue: null, restore: null, apiKey: null, learning: null };
const pendingFileLink: Record<FileLinkBooleanSetting, number | null> = {
  fileLinkInstruction: null,
  planInstruction: null,
  revealInExplorer: null,
  allowOutsideWorkspace: null,
  confirmOutsideWorkspace: null,
  openOutsideReadOnly: null,
};

function render(state: SettingsState): void {
  current = state;
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
  // 子の値は親がオフの間も Host の値のまま見せる（押せないだけ）。有効化は親の実効値の返送でだけ行う
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
  vscode.postMessage({ type: "setComposerSendKey", requestId: nextRequestId(), sendKey: sendKeySelect.value as ComposerSendKey });
});

// aria-checked は Host が返した値でだけ変える
function requestApiKeyPolicy(policy: ApiKeyPolicy): void {
  if (current === null || pending.apiKey !== null || policy === current.apiKeyPolicy) return;
  const requestId = nextRequestId();
  pending.apiKey = requestId;
  vscode.postMessage({ type: "setApiKeyPolicy", requestId, policy });
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
  vscode.postMessage({ type: "setAutoContinueAtUsageLimit", requestId, enabled: !current.autoContinueAtUsageLimit });
});

restoreSwitch.addEventListener("click", () => {
  if (current === null || pending.restore !== null) return;
  const requestId = nextRequestId();
  pending.restore = requestId;
  vscode.postMessage({ type: "setRestoreTabsOnStartup", requestId, enabled: !current.restoreTabsOnStartup });
});
learningSwitch.addEventListener("click", () => {
  if (current === null || pending.learning !== null) return;
  const requestId = nextRequestId();
  pending.learning = requestId;
  learningSwitch.disabled = true;
  vscode.postMessage({ type: "setLearningEnabled", requestId, enabled: !current.learningEnabled });
});
for (const key of FILE_LINK_BOOLEAN_SETTINGS) {
  const control = fileLinkSwitches[key];
  control.addEventListener("click", () => {
    if (current === null || pendingFileLink[key] !== null || control.disabled) return;
    const requestId = nextRequestId();
    pendingFileLink[key] = requestId;
    vscode.postMessage({ type: "setFileLinkSetting", requestId, setting: key, enabled: !current[key] });
  });
}
moreLink.addEventListener("click", () => vscode.postMessage({ type: "openVsCodeSettings" }));

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (isHostToSettingsPage(event.data)) render(event.data);
});
vscode.postMessage({ type: "settingsPageReady" });
