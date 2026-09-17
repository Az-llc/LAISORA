import * as l10n from "@vscode/l10n";
import {
  FILE_LINK_SETTINGS,
  isHostToSettingsPage,
  type ApiKeyPolicy,
  type ComposerSendKey,
  type FileLinkSetting,
  type HostToSettingsPage,
  type SettingsPageToHost,
} from "../protocol";

declare function acquireVsCodeApi(): { postMessage(message: SettingsPageToHost): void };

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
const title = element("h1", "settings-title", l10n.t("General"));
const status = element("p", "settings-status", l10n.t("Loading…"));
status.setAttribute("role", "status");
root.append(title, status);

const chatCard = section(root, l10n.t("Chat"));

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
  section(root, l10n.t("Authentication")),
  l10n.t("API key"),
  l10n.t("Inherit uses ANTHROPIC_API_KEY if it is set (billed to the API); Subscription only uses your signed-in subscription. Applies to conversations started afterwards."),
  apiKeyGroup,
  checkedApiKeyRadio
);

const fileLinkCard = section(root, l10n.t("File links"));
const fileLinkSwitches: Record<FileLinkSetting, HTMLButtonElement> = {
  fileLinkInstruction: switchButton("setting-file-link-instruction"),
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

const footer = element("div", "settings-footer");
const moreLink = element("button", "settings-link", l10n.t("Open other settings in VS Code Settings"));
moreLink.type = "button";
footer.appendChild(moreLink);
root.appendChild(footer);

let current: SettingsState | null = null;
let requestSerial = 0;
const nextRequestId = (): number => ++requestSerial;
// 自分の要求への返送（replyTo が一致。失敗時の返送を含む）が届くまで、同じ操作の再押下を捨てる。current は返送でしか
// 変わらないため、捨てないと 2 回目も 1 回目と同じ値を送り、戻したい意図が失われる。構成変更の通知や別の要求への返送では
// 解かない（それらは自分の書込みの完了を意味しない）（R-DSP-01）
const pending: { restore: number | null; apiKey: number | null } = { restore: null, apiKey: null };
const pendingFileLink: Record<FileLinkSetting, number | null> = {
  fileLinkInstruction: null,
  revealInExplorer: null,
  allowOutsideWorkspace: null,
  confirmOutsideWorkspace: null,
  openOutsideReadOnly: null,
};

function render(state: SettingsState): void {
  current = state;
  if (pending.restore === state.replyTo) pending.restore = null;
  if (pending.apiKey === state.replyTo) pending.apiKey = null;
  for (const key of FILE_LINK_SETTINGS) {
    if (pendingFileLink[key] === state.replyTo) pendingFileLink[key] = null;
    fileLinkSwitches[key].setAttribute("aria-checked", String(state[key]));
  }
  fileLinkSwitches.fileLinkInstruction.disabled = false;
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

restoreSwitch.addEventListener("click", () => {
  if (current === null || pending.restore !== null) return;
  const requestId = nextRequestId();
  pending.restore = requestId;
  vscode.postMessage({ type: "setRestoreTabsOnStartup", requestId, enabled: !current.restoreTabsOnStartup });
});
for (const key of FILE_LINK_SETTINGS) {
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
