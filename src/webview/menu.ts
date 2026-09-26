// 権限モードメニュー（#modemenu）とモデル/effortピッカー（#authpicker）。
//
// メニュー共通キーボード操作の方式: コンテナ自身にDOMフォーカスを置き、内部は仮想カーソル
// （aria-activedescendant）。
// - 項目をfocus()するロービングtabindex方式は不可。models/modelChanged/effortChanged 受信で
//   ピッカーが丸ごと再構築されるため、フォーカスがbodyへ飛ぶ。
// - 逆にコンテナ要素は再構築されない（textContent=""で子だけ消える）ので、ここに
//   フォーカスとリスナを置けば再構築を跨いで生存する。
// - イベントが inputEl を通らないので、Enter送信・Shift+Tabモード巡回・サジェストのcapture
//   ハンドラとの衝突が構造的に起きない。
import * as l10n from "@vscode/l10n";
import {
  INPUT_PLACEHOLDER,
  authEl,
  authPickerEl,
  inputEl,
  modeBtn,
  modeMenuEl,
  usagePanelEl,
  vscode,
} from "./dom";
import { EFFORT_ORDER, MODE_LABELS, MODE_ORDER, activeTab, activeTabId, closeUsagePanel } from "./main";
import type { ComposerSendKey, HostToWebview, ModelInfo } from "../protocol";
import { setSessionMenuExtras, type SessionMenuExtra } from "./session-header";
import type { Tab } from "./tab";

// ---------- 入力欄の送信キー（Host の userSettings が正本。ここは最後に受け取った値の写し） ----------

const INPUT_PLACEHOLDER_SHIFT_ENTER = l10n.t("Type a message (Shift+Enter to send / Enter for a new line)");

let sendKey: ComposerSendKey = "enter";

export function applyUserSettings(msg: Extract<HostToWebview, { type: "userSettings" }>): void {
  sendKey = msg.composerSendKey;
}

export function composerSendKey(): ComposerSendKey {
  return sendKey;
}

export function composerPlaceholder(): string {
  return sendKey === "shiftEnter" ? INPUT_PLACEHOLDER_SHIFT_ENTER : INPUT_PLACEHOLDER;
}

export function sessionMenuSettingsItems(): SessionMenuExtra[] {
  return [
    {
      label: l10n.t("Settings"),
      icon: "⚙",
      run: () => vscode.postMessage({ type: "runHostAction", action: "openSettings" }),
    },
  ];
}

interface MenuKbdState {
  container: HTMLElement; // #authpicker / #modemenu
  // カーソル位置は index ではなく item.dataset.menuKey（同一性キー）で持つ。
  // 「モデル一覧を取得中…」プレースホルダがN個のモデルに置き換わると項目数が変わるため。
  cursorKey: string | null;
  opener: HTMLElement; // Escape/確定/Tab で閉じた後のフォーカス復帰先
}
// 開いているメニューは常に高々1つ（各 open* の冒頭で他を閉じる）
let menuKbd: MenuKbdState | null = null;
let olderMenu: HTMLElement | null = null;
const OLDER_KEY = "models:older";

function closeOlderModels(): void {
  if (!olderMenu || olderMenu.classList.contains("hidden")) return;
  olderMenu.classList.add("hidden");
  authPickerEl.querySelector('[data-older-models]')?.setAttribute("aria-expanded", "false");
  if (menuKbd?.container === olderMenu) {
    menuKbd.container = authPickerEl;
    menuKbd.cursorKey = OLDER_KEY;
    syncMenuCursor(authPickerEl, "ap-item-");
    authPickerEl.focus();
  }
}

function openOlderModels(parent: HTMLElement, models: ModelInfo[], t: Tab | null): void {
  if (!menuKbd) return;
  applyCursorTo(authPickerEl, "ap-item-", parent, menuItems(authPickerEl));
  if (!olderMenu) {
    olderMenu = document.createElement("div");
    olderMenu.id = "older-model-menu";
    olderMenu.className = "auth-picker auth-submenu hidden";
    olderMenu.setAttribute("role", "menu");
    olderMenu.setAttribute("aria-label", l10n.t("Older versions"));
    olderMenu.tabIndex = -1;
    olderMenu.addEventListener("keydown", onMenuKeydown);
    document.body.appendChild(olderMenu);
  }
  olderMenu.textContent = "";
  const back = document.createElement("div");
  back.className = "mode-menu-item";
  back.setAttribute("role", "menuitem");
  back.dataset.menuKey = "models:back";
  back.textContent = l10n.t("Back to models");
  back.onclick = closeOlderModels;
  olderMenu.appendChild(back);
  for (const model of models) olderMenu.appendChild(buildModelRow(t, model));
  const add = document.createElement("div");
  add.className = "mode-menu-item";
  add.setAttribute("role", "menuitem");
  add.dataset.menuKey = "models:add";
  add.textContent = l10n.t("Add by model ID…");
  add.onclick = () => {
    if (activeTabId) vscode.postMessage({ type: "runHostAction", action: "addClaudeModel", tabId: activeTabId });
    closeAuthPicker();
  };
  olderMenu.appendChild(add);
  olderMenu.classList.remove("hidden");
  parent.setAttribute("aria-expanded", "true");
  parent.setAttribute("aria-controls", olderMenu.id);
  const rect = parent.getBoundingClientRect();
  const viewportWidth = Math.min(window.innerWidth, window.outerWidth || window.innerWidth);
  const width = Math.min(320, viewportWidth - 16);
  olderMenu.style.minWidth = "0";
  olderMenu.style.boxSizing = "border-box";
  olderMenu.style.overflowWrap = "anywhere";
  olderMenu.style.width = `${width}px`;
  const left = rect.right + width + 4 <= viewportWidth - 8 ? rect.right + 4
    : rect.left - width - 4 >= 8 ? rect.left - width - 4 : Math.max(8, viewportWidth - width - 8);
  olderMenu.style.left = `${left}px`;
  olderMenu.style.top = `${Math.max(8, Math.min(rect.top, window.innerHeight - olderMenu.offsetHeight - 8))}px`;
  menuKbd.container = olderMenu;
  menuKbd.cursorKey = models.find((m) => isSelectedRow(t, m))
    ? `model:${models.find((m) => isSelectedRow(t, m))!.id}` : "models:back";
  syncMenuCursor(olderMenu, "older-item-");
  olderMenu.focus();
}
function menuIdPrefix(container: HTMLElement): string {
  if (container === authPickerEl) return "ap-item-";
  return "mm-item-";
}

// カーソル移動の対象となる有効項目。見出し（role なし）と無効項目は除外する。
function menuItems(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>('[role="menuitem"],[role="menuitemcheckbox"]')).filter(
    (el) => el.getAttribute("aria-disabled") !== "true"
  );
}

// カーソルを現在の cursorKey から再解決し、クラス・id・aria を貼り直す。
// メニューを開いた直後と、再構築（renderAuthPicker）の直後に必ず呼ぶ。
export function syncMenuCursor(container: HTMLElement, idPrefix: string): void {
  // キー操作の対象でないメニューにカーソルだけ光らせない
  if (menuKbd?.container !== container) return;
  const items = menuItems(container);
  for (const el of items) {
    el.classList.remove("cursor");
    el.removeAttribute("id");
  }
  if (items.length === 0) {
    container.removeAttribute("aria-activedescendant");
    return;
  }
  // 解決順: cursorKey一致 → .selected（authPickerは2つあるので先頭=モデル側） → 先頭
  // 解決順: cursorKey一致 → 先頭セクションの .selected → 先頭項目。
  // authPicker は .selected が2つ（モデルとeffort）あり、しかも modelOverride が一覧に
  // 無いIDだとモデル欄には .selected が1つも付かない。そこで「どこかの .selected」へ
  // 落とすと effort 欄の選択行（末尾寄り）がカーソルになり、↓が末尾から先頭へ回り込んで
  // 「上は効くのに下が効かない」ように見える。最後は必ず先頭項目に落とす。
  const firstSection = container.querySelector(".auth-picker-section");
  const target =
    (menuKbd?.cursorKey ? items.find((el) => el.dataset.menuKey === menuKbd!.cursorKey) : undefined) ??
    items.find((el) => el.classList.contains("selected") && (!firstSection || firstSection.contains(el))) ??
    items[0];
  applyCursorTo(container, idPrefix, target, items);
}

// カーソルを「要素そのもの」へ適用する。キーで引き直さないのが要点。
// 移動のたびに cursorKey で引き直すと、引き直しに失敗（キー未設定・重複）したとき .selected へフォールバックし、
// 既定行が選択されている状態ではカーソルが既定行へ戻り続ける。引き直しはDOM再構築後の復元にだけ使い、
// 通常の移動では要素を直接指す。
function applyCursorTo(
  container: HTMLElement,
  idPrefix: string,
  target: HTMLElement,
  items: HTMLElement[]
): void {
  for (const el of items) {
    el.classList.remove("cursor");
    el.removeAttribute("id");
  }
  const idx = items.indexOf(target);
  target.classList.add("cursor");
  target.id = `${idPrefix}${idx}`;
  container.setAttribute("aria-activedescendant", target.id);
  if (menuKbd) {
    // 再構築後の復元用にキーを控える。重複や未設定なら位置ベースの一意キーを振る
    const key = target.dataset.menuKey;
    const dup = key ? items.filter((el) => el.dataset.menuKey === key).length > 1 : false;
    if (!key || dup) target.dataset.menuKey = `idx:${idx}`;
    menuKbd.cursorKey = target.dataset.menuKey ?? `idx:${idx}`;
  }
  target.scrollIntoView({ block: "nearest" });
}

// カーソルを移動する。delta は ±N（循環）または "home" / "end"。
function moveMenuCursor(delta: number | "home" | "end"): void {
  if (!menuKbd) return;
  const items = menuItems(menuKbd.container);
  if (items.length === 0) return;
  const cur = items.findIndex((el) => el.classList.contains("cursor"));
  let next: number;
  if (delta === "home") next = 0;
  else if (delta === "end") next = items.length - 1;
  else if (cur === -1) next = delta > 0 ? 0 : items.length - 1;
  else next = (cur + delta + items.length) % items.length;
  // キーで引き直さず、移動先の要素へ直接カーソルを移す（引き直しの失敗で既定行へ
  // 張り付く不具合を構造的に排除する）
  applyCursorTo(menuKbd.container, menuIdPrefix(menuKbd.container), items[next], items);
}

// 現在開いているメニューを閉じる（close 側で menuKbd は null になる）
function closeCurrentMenu(): void {
  if (!menuKbd) return;
  if (menuKbd.container === authPickerEl || menuKbd.container === olderMenu) {
    closeAuthPicker();
  } else {
    closeModeMenu();
  }
}

// メニューを開いた経路に応じたフォーカス復帰先を決める。
// チップ（button）から開いたならそのチップ、それ以外（/model 入力など）は入力欄。
function menuOpener(chip: HTMLElement): HTMLElement {
  return document.activeElement === chip ? chip : inputEl;
}

function onMenuKeydown(e: KeyboardEvent): void {
  if (!menuKbd || menuKbd.container.classList.contains("hidden")) return;
  if (e.isComposing) return; // IME変換確定のEnterを決定として拾わない
  // 修飾キー付きはグローバルショートカット（Ctrl+Tab等）に譲る。ここで拾って
  // R-SES-01: stopPropagation するとメニュー表示中だけタブ切替が死ぬ
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  switch (e.key) {
    case "ArrowDown":
      e.preventDefault();
      moveMenuCursor(1);
      break;
    case "ArrowUp":
      e.preventDefault();
      moveMenuCursor(-1);
      break;
    case "Home":
      e.preventDefault();
      moveMenuCursor("home");
      break;
    case "End":
      e.preventDefault();
      moveMenuCursor("end");
      break;
    case "Enter":
    case " ": {
      e.preventDefault();
      const el = menuKbd.container.querySelector<HTMLElement>(".cursor");
      const opener = menuKbd.opener;
      if (el?.dataset.olderModels || el?.dataset.menuKey === "models:back") {
        el.click();
        break;
      }
      // effort 行は段階送りで既に適用済みなので、Enter は確定＝閉じるだけにする
      // （click させると意図せずもう1段進んでしまう）
      if (el?.dataset.effortRow) {
        closeCurrentMenu();
        opener.focus();
        break;
      }
      // 既存の onclick をそのまま起動する（送信・close・effort変更通知を全部持っているため、
      // dataset から postMessage を再構成すると notifyEffort が黙って落ちる）。
      // click() は同期的に close を走らせ menuKbd を null にするので opener は先に退避する。
      el?.click();
      opener.focus();
      break;
    }
    case "Escape": {
      e.preventDefault();
      e.stopPropagation(); // documentのEscapeハンドラとの二重処理を防ぐ
      if (menuKbd.container === olderMenu) { closeOlderModels(); break; }
      const opener = menuKbd.opener;
      closeCurrentMenu();
      opener.focus();
      break;
    }
    case "ArrowRight":
    case "ArrowLeft": {
      if (e.key === "ArrowLeft" && menuKbd.container === olderMenu) {
        e.preventDefault(); closeOlderModels(); break;
      }
      const parent = menuKbd.container.querySelector<HTMLElement>(".cursor[data-older-models]");
      if (e.key === "ArrowRight" && parent) { e.preventDefault(); parent.click(); break; }
      // effort 行の上では左右で段階を送る（拡張と同じ選択方式）
      const onEffortRow = menuKbd.container.querySelector<HTMLElement>(".cursor[data-effort-row]");
      if (onEffortRow) {
        e.preventDefault();
        stepEffort(e.key === "ArrowRight" ? 1 : -1);
        break;
      }
      break;
    }
    case "Tab": {
      e.preventDefault();
      e.stopPropagation(); // Shift+Tab がモード巡回（inputEl のハンドラ）へ抜けないようにする
      // effort 行の上なら段階送り、それ以外は候補送り（拡張の操作感に合わせる）
      const onEffort = menuKbd.container.querySelector<HTMLElement>(".cursor[data-effort-row]");
      if (onEffort) stepEffort(e.shiftKey ? -1 : 1);
      else moveMenuCursor(e.shiftKey ? -1 : 1);
      break;
    }
  }
}

// ---------- 権限モードセレクタ ----------

export function closeModeMenu(): void {
  // 閉じる時点でフォーカスがメニュー内にあるならopenerへ戻す。これが無いと
  // マウスで項目/外側をクリックして閉じた際にフォーカスがbodyへ落ちる
  if (menuKbd?.container === modeMenuEl && modeMenuEl.contains(document.activeElement)) {
    menuKbd.opener.focus();
  }
  modeMenuEl.classList.add("hidden");
  modeMenuEl.textContent = "";
  modeMenuEl.removeAttribute("aria-activedescendant");
  modeBtn.setAttribute("aria-expanded", "false");
  if (menuKbd?.container === modeMenuEl) menuKbd = null;
}

function openModeMenu(): void {
  closeAuthPicker();
  closeUsagePanel();
  const t = activeTab();
  modeMenuEl.textContent = "";
  for (const mode of MODE_ORDER) {
    const item = document.createElement("div");
    item.className = "mode-menu-item";
    if (mode === "bypassPermissions") item.classList.add("mode-danger");
    if (t?.permissionMode === mode) item.classList.add("selected");
    item.setAttribute("role", "menuitem");
    item.dataset.menuKey = mode;
    item.textContent = MODE_LABELS[mode];
    item.onclick = () => {
      if (activeTabId) vscode.postMessage({ type: "setMode", tabId: activeTabId, mode });
      closeModeMenu();
    };
    modeMenuEl.appendChild(item);
  }
  menuKbd = { container: modeMenuEl, cursorKey: null, opener: menuOpener(modeBtn) };
  // .hidden(display:none) の間は focus 不能なので、必ず解除してから focus する
  modeMenuEl.classList.remove("hidden");
  modeBtn.setAttribute("aria-expanded", "true");
  syncMenuCursor(modeMenuEl, "mm-item-");
  modeMenuEl.focus();
}

// ---------- 統合ピッカー（モデル / effort。#auth チップクリックで開く） ----------

export function closeAuthPicker(): void {
  closeOlderModels();
  const isKbdAuth = menuKbd?.container === authPickerEl;
  if (isKbdAuth && authPickerEl.contains(document.activeElement)) menuKbd!.opener.focus();
  authPickerEl.classList.add("hidden");
  authPickerEl.textContent = "";
  authPickerEl.removeAttribute("aria-activedescendant");
  authEl.setAttribute("aria-expanded", "false");
  if (isKbdAuth) menuKbd = null;
}

// effort の段階を示すドット列。現在段だけを塗り、各ドットは直接その段へ飛ぶ
function buildEffortDots(level: number): HTMLElement {
  const wrap = document.createElement("span");
  wrap.className = "effort-dots";
  for (let i = 1; i <= EFFORT_ORDER.length; i++) {
    const value = EFFORT_ORDER[i - 1];
    const dot = document.createElement("span");
    dot.className = i === level ? "effort-dot on" : "effort-dot";
    dot.dataset.effortLevel = value;
    dot.title = value;
    dot.setAttribute("role", "presentation");
    dot.onclick = (ev) => {
      ev.stopPropagation();
      setEffortLevel(value);
    };
    wrap.appendChild(dot);
  }
  return wrap;
}

// effort 行の中身（ラベル＋段階ドット）を描く。
function renderEffortRow(row: HTMLElement, level: string | null, source?: "configured" | "default"): void {
  row.textContent = "";
  const name = document.createElement("span");
  name.className = "effort-name";
  const shown = level === null ? "-"
    : source === "configured" ? l10n.t("{0} (configured)", level)
      : source === "default" ? l10n.t("{0} (default)", level) : level;
  name.textContent = l10n.t("Effort ({0})", shown);
  const idx = level ? EFFORT_ORDER.indexOf(level as (typeof EFFORT_ORDER)[number]) + 1 : 0;
  row.append(name, buildEffortDots(idx));
}

// 観測値、明示指定値、起動時に取得した設定値、CLI の既定値、CLI の適用値の順で表示する。
function currentEffort(t: Tab | null): string | null {
  if (t?.auth?.effort !== undefined) return t.auth.effort;
  return t?.effortOverride ?? t?.configEffort ?? t?.defaultEffort ?? t?.appliedEffort ?? null;
}

// effort をその段へ直接設定する（ドットのクリック）。送りと同じ即時反映経路を通る
function setEffortLevel(level: string): void {
  const t = activeTab();
  if (!t || !activeTabId) return;
  vscode.postMessage({ type: "setEffort", tabId: activeTabId, effort: level });
}

// effort の段階を dir 方向へ送る。low → medium → … → max → low と巡回する。
// 「既定」は段階に含めない（ユーザー要望: 既定の選択肢は不要）。
// 変更は即時適用（settings.json へ保存され、行の表示もその場で更新される）。
function stepEffort(dir: 1 | -1): void {
  const t = activeTab();
  if (!t || !activeTabId) return;
  const scale: string[] = [...EFFORT_ORDER];
  const cur = currentEffort(t);
  const i = cur ? scale.indexOf(cur) : -1;
  // 現在値が段階に無い（未設定・未知の値）ときは、送り方向に応じて端から始める
  const next = i < 0 ? (dir > 0 ? scale[0] : scale[scale.length - 1]) : scale[(i + dir + scale.length) % scale.length];
  vscode.postMessage({ type: "setEffort", tabId: activeTabId, effort: next });
}

// ピッカーの表示範囲。"effort" は /effort から開いたときで、effort 欄だけを出す
// （モデルは変えずに effort だけ変えたい、というユーザー要望）。
let authPickerMode: "all" | "effort" = "all";

// modelOverride: undefined = 未選択（実測 auth.model / 設定値に一致する行）、null = 明示的な既定（id "default" の行）
function isSelectedRow(t: Tab | null, model: ModelInfo): boolean {
  const override = t?.modelOverride;
  if (override === undefined) return (t?.auth?.model ?? t?.configModel) === model.id;
  if (override === null) return model.id === "default";
  return override === model.id;
}

function buildModelRow(
  t: Tab | null,
  model: ModelInfo,
  overrideLabel?: string,
  extraClass?: string
): HTMLElement {
  const item = document.createElement("div");
  item.className = extraClass ? `mode-menu-item ${extraClass}` : "mode-menu-item";
  if (isSelectedRow(t, model)) item.classList.add("selected");

  item.setAttribute("role", "menuitem");
  item.dataset.menuKey = `model:${model.id}`;

  const label = document.createElement("span");
  label.textContent = overrideLabel ?? model.label;
  item.appendChild(label);

  item.title = overrideLabel ?? model.label;

  item.onclick = () => {
    if (activeTabId) {
      // R-CMD-02
      vscode.postMessage({
        type: "setModel",
        tabId: activeTabId,
        model: model.id === "default" ? null : model.id,
      });
    }
    closeAuthPicker();
    // 確認文はここで出さない。Host が適用・保存を終えた結果を modelChanged.notice で返し、
    // 要求元タブの会話へ出す（effort と同じ経路。選択直後に「保存しました」を出すと SDK 失敗・
    // 保存失敗と矛盾する。R-DSP-01）
  };
  return item;
}

export function renderAuthPicker(): void {
  const t = activeTab();
  const reopenOlder = olderMenu !== null && !olderMenu.classList.contains("hidden");
  const olderCursor = reopenOlder ? menuKbd?.cursorKey : null;
  authPickerEl.textContent = "";

  const modelSection = document.createElement("div");
  modelSection.className = "auth-picker-section";
  const modelHeading = document.createElement("div");
  modelHeading.className = "auth-picker-heading";
  modelHeading.textContent = l10n.t("Model");
  modelSection.appendChild(modelHeading);

  const allModels = t?.models ?? [];

  if (allModels.length === 0) {
    const loading = document.createElement("div");
    loading.className = "mode-menu-item auth-picker-loading";
    // menuItems() の除外条件（role=menuitem かつ aria-disabled!=true）に合わせる。
    // role を付けることで読み上げ対象になり、aria-disabled で選択対象からは外れる
    loading.setAttribute("role", "menuitem");
    loading.setAttribute("aria-disabled", "true");
    loading.textContent = l10n.t("Fetching model list…");
    modelSection.appendChild(loading);
  } else {
    const groups = { current: allModels.filter((m) => !m.olderVersion), older: allModels.filter((m) => m.olderVersion) };
    for (const model of groups.current) {
      const row = buildModelRow(t, model);
      modelSection.appendChild(row);
    }
    {
      const parent = document.createElement("div");
      parent.className = "mode-menu-item auth-picker-parent";
      parent.dataset.menuKey = OLDER_KEY;
      parent.dataset.olderModels = "1";
      parent.setAttribute("role", "menuitem");
      parent.setAttribute("aria-haspopup", "menu");
      parent.setAttribute("aria-expanded", "false");
      if (groups.older.some((m) => isSelectedRow(t, m))) parent.classList.add("selected");
      const label = document.createElement("span");
      label.textContent = l10n.t("Older versions");
      const arrow = document.createElement("span");
      arrow.textContent = "›";
      arrow.style.marginLeft = "auto";
      arrow.setAttribute("aria-hidden", "true");
      parent.append(label, arrow);
      parent.onclick = () => openOlderModels(parent, groups.older, t);
      parent.onmouseenter = () => { if (menuKbd?.container === authPickerEl) parent.click(); };
      modelSection.appendChild(parent);
    }
  }

  const effortSection = document.createElement("div");
  effortSection.className = "auth-picker-section";
  const effortHeading = document.createElement("div");
  effortHeading.className = "auth-picker-heading";
  effortHeading.textContent = "effort"; // 見出しは固定。現在値の表示は renderEffortRow が担う
  effortSection.appendChild(effortHeading);

  // effort は「1行 + 段階ドット」にする（Claude Code 拡張と同じ選択方式）。
  // 一覧から選ぶのではなく、この行の上で左右キー（または Tab）で段階を送る。
  const effortRow = document.createElement("div");
  effortRow.className = "mode-menu-item effort-item";
  effortRow.setAttribute("role", "menuitem");
  effortRow.dataset.menuKey = "effort:row";
  effortRow.dataset.effortRow = "1";
  renderEffortRow(effortRow, currentEffort(t),
    t?.auth?.effort !== undefined || t?.effortOverride ? undefined
      : t?.configEffort !== undefined ? "configured"
        : t?.defaultEffort !== undefined ? "default" : undefined);
  // クリックでも段階を送れるようにする（マウス操作でも同じ方式で統一）
  effortRow.onclick = () => stepEffort(1);
  effortSection.appendChild(effortRow);

  // /effort から開いたときは effort 欄だけを出す（モデルを変えずに effort だけ変えたい）
  if (reopenOlder && (authPickerMode === "effort" || !modelSection.querySelector("[data-older-models]"))) closeOlderModels();
  if (authPickerMode === "effort") {
    authPickerEl.append(effortSection);
    return;
  }
  authPickerEl.append(modelSection, effortSection);
  if (reopenOlder && authPickerMode === "all") {
    authPickerEl.querySelector<HTMLElement>("[data-older-models]")?.click();
    if (menuKbd?.container === olderMenu && olderCursor) {
      menuKbd.cursorKey = olderCursor;
      syncMenuCursor(olderMenu!, "older-item-");
    }
  }

}

export function openAuthPicker(opener?: HTMLElement, focusSection: "model" | "effort" = "model"): void {
  closeOlderModels();
  closeModeMenu();
  closeUsagePanel();
  // /effort 起点なら effort 欄だけの表示にする
  authPickerMode = focusSection === "effort" ? "effort" : "all";
  // 開いた直後のカーソルは必ずモデル欄に置く。
  // cursorKey を空にすると syncMenuCursor が「最初の .selected」へ落ちるが、
  // modelOverride が一覧に無いIDだとモデル欄に .selected が付かず、effort欄の選択行
  // （末尾寄り）がカーソルになる。その状態だと ↓ が末尾から先頭へ回り込むため
  // 「上は効くのに下が効かない」ように見える。開始位置を明示して回避する。
  const t0 = activeTab();
  const wanted =
    focusSection === "effort"
      ? t0?.effortOverride
        ? `effort:${t0.effortOverride}`
        : "effort:default"
      : t0?.modelOverride
        ? `model:${t0.modelOverride}`
        : "model:default";
  menuKbd = { container: authPickerEl, cursorKey: wanted, opener: opener ?? menuOpener(authEl) };
  renderAuthPicker();
  // .hidden(display:none) の間は focus 不能なので、必ず解除してから focus する
  authPickerEl.classList.remove("hidden");
  authEl.setAttribute("aria-expanded", "true");
  syncMenuCursor(authPickerEl, "ap-item-");
  authPickerEl.focus();
}

// リスナ登録は main.ts 末尾の init 呼び出し列からのみ行う（登録順の権威はそこ1箇所）。
// 文の並びがリスナの登録順なので、入れ替えてはならない。
// この本体に「呼び出し時にモジュールレベルの let を読む文」を足さないこと。initの安全性は
// 関数宣言の巻き上げと、登録時にletを読まないことに依存している（TDZ）。
export function initMenu(): void {
  setSessionMenuExtras(sessionMenuSettingsItems);
  // リスナ登録は initMenu() の1回だけ（open* の中で登録すると再構築のたび多重登録になる）
  modeMenuEl.addEventListener("keydown", onMenuKeydown);
  authPickerEl.addEventListener("keydown", onMenuKeydown);
  // Shift+Tab でモード巡回（Claude Code 本体と同じショートカット）
  inputEl.addEventListener("keydown", (e) => {
    if (e.key === "Tab" && e.shiftKey && !e.isComposing) {
      e.preventDefault();
      const t = activeTab();
      if (!t || !activeTabId) return;
      const next = MODE_ORDER[(MODE_ORDER.indexOf(t.permissionMode) + 1) % MODE_ORDER.length];
      vscode.postMessage({ type: "setMode", tabId: activeTabId, mode: next });
    }
  });

  modeBtn.onclick = (e) => {
    e.stopPropagation();
    if (modeMenuEl.classList.contains("hidden")) openModeMenu();
    else closeModeMenu();
  };
  document.addEventListener("click", (e) => {
    if (!modeMenuEl.classList.contains("hidden") && e.target !== modeBtn && !modeMenuEl.contains(e.target as Node)) {
      closeModeMenu();
    }
  });

  authEl.onclick = (e) => {
    e.stopPropagation();
    if (authPickerEl.classList.contains("hidden")) openAuthPicker();
    else closeAuthPicker();
  };
  document.addEventListener("click", (e) => {
    if (
      !authPickerEl.classList.contains("hidden") &&
      e.target !== authEl &&
      !olderMenu?.contains(e.target as Node) &&
      !authPickerEl.contains(e.target as Node)
    ) {
      closeAuthPicker();
    }
  });

  // 保険のEscape（コンテナ側で捕まえられない状況用。フォーカス復帰はコンテナ側の責務）
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!authPickerEl.classList.contains("hidden")) {
      e.preventDefault();
      closeAuthPicker();
    } else if (!modeMenuEl.classList.contains("hidden")) {
      e.preventDefault();
      closeModeMenu();
    } else if (!usagePanelEl.classList.contains("hidden")) {
      // /usage でキーボードから開けるので、キーボードで閉じられる必要がある
      e.preventDefault();
      closeUsagePanel();
    }
  });
}
