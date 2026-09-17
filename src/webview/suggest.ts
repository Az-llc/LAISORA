// 入力サジェスト（/コマンド・@ファイル）。
import * as l10n from "@vscode/l10n";
import { inputEl, suggestEl, vscode } from "./dom";
import { activeTab, persistState } from "./main";

type SuggestKind = "command" | "file";
interface SuggestState {
  kind: SuggestKind;
  // トリガー文字（/ or @）の textarea 内インデックス
  triggerIndex: number;
  items: string[];
  descriptions: Map<string, string>;
  selected: number;
}

let suggestState: SuggestState | null = null;
let fileQuerySeq = 0;
let fileQueryTimer: ReturnType<typeof setTimeout> | null = null;
let latestFileReqId = -1;

export function closeSuggest(): void {
  suggestState = null;
  suggestEl.classList.add("hidden");
  suggestEl.textContent = "";
  if (fileQueryTimer) {
    clearTimeout(fileQueryTimer);
    fileQueryTimer = null;
  }
}

function renderSuggest(): void {
  suggestEl.textContent = "";
  if (!suggestState || suggestState.items.length === 0) {
    suggestEl.classList.add("hidden");
    return;
  }
  suggestState.items.forEach((item, idx) => {
    const row = document.createElement("div");
    row.className = "suggest-item";
    if (idx === suggestState!.selected) row.classList.add("active");
    row.setAttribute("role", "option");
    const nameEl = document.createElement("span");
    nameEl.className = "suggest-name";
    nameEl.textContent = item;
    row.appendChild(nameEl);
    const desc = suggestState!.descriptions.get(item);
    if (desc) {
      const descEl = document.createElement("span");
      descEl.className = "suggest-desc";
      descEl.textContent = desc;
      row.title = desc; // 幅不足で省略されても全文が見える
      row.appendChild(descEl);
    }
    row.onclick = () => {
      commitSuggest(idx);
    };
    suggestEl.appendChild(row);
  });
  suggestEl.classList.remove("hidden");
  suggestEl.querySelector(".suggest-item.active")?.scrollIntoView({ block: "nearest" });
}

function commitSuggest(idx: number): void {
  if (!suggestState) return;
  // caret移動（矢印/Home/End/クリック）でtriggerIndexが陳腐化していないか確認。
  // ズレていれば（例: "/rev" 入力後にHomeでcaretが先頭へ戻った状態でEnter）何もせず閉じる。
  const curCaret = inputEl.selectionStart ?? inputEl.value.length;
  const expectedChar = suggestState.kind === "command" ? "/" : "@";
  if (curCaret < suggestState.triggerIndex) {
    closeSuggest();
    return;
  }
  const span = inputEl.value.slice(suggestState.triggerIndex, curCaret);
  if (!span.startsWith(expectedChar) || span.slice(1).includes(" ") || span.includes("\n")) {
    closeSuggest();
    return;
  }
  const item = suggestState.items[idx];
  if (item === undefined) return;
  const before = inputEl.value.slice(0, suggestState.triggerIndex);
  const after = inputEl.value.slice(inputEl.selectionStart ?? inputEl.value.length);
  const replacement = suggestState.kind === "command" ? `/${item} ` : `@${item} `;
  const newValue = before + replacement + after;
  inputEl.value = newValue;
  const caret = before.length + replacement.length;
  inputEl.setSelectionRange(caret, caret);
  closeSuggest();
  persistState();
  inputEl.focus();
}

// ファイル選択ダイアログで選ばれたパスを入力欄へ入れる。@ 補完の確定と同じ差し込み方を
// 通すので、ダイアログ経由と手打ち補完で入力欄の文字列が食い違わない
export function insertFilePaths(paths: readonly string[]): void {
  if (paths.length === 0) return;
  const caret = inputEl.selectionStart ?? inputEl.value.length;
  const before = inputEl.value.slice(0, caret);
  const after = inputEl.value.slice(caret);
  const replacement = paths.map((path) => `@${path} `).join("");
  inputEl.value = before + replacement + after;
  const next = before.length + replacement.length;
  inputEl.setSelectionRange(next, next);
  closeSuggest();
  persistState();
  inputEl.focus();
}

function updateCommandSuggest(triggerIndex: number, query: string): void {
  const t = activeTab();
  const commands = t?.commands ?? [];
  const filtered = commands.filter(
    (command) => command.name.startsWith(query) || command.aliases?.some((alias) => alias.startsWith(query))
  );
  if (filtered.length === 0) {
    closeSuggest();
    return;
  }
  const descriptions = new Map<string, string>();
  for (const command of filtered) {
    const alias = !command.name.startsWith(query) && command.aliases?.find((value) => value.startsWith(query));
    descriptions.set(command.name, alias ? l10n.t("{0} (alias: /{1})", command.description, alias) : command.description);
  }
  suggestState = {
    kind: "command",
    triggerIndex,
    items: filtered.map((c) => c.name),
    descriptions,
    selected: 0,
  };
  renderSuggest();
}

function updateFileSuggest(triggerIndex: number, query: string): void {
  suggestState = {
    kind: "file",
    triggerIndex,
    items: [],
    descriptions: new Map(),
    selected: 0,
  };
  if (fileQueryTimer) clearTimeout(fileQueryTimer);
  fileQueryTimer = setTimeout(() => {
    const reqId = ++fileQuerySeq;
    latestFileReqId = reqId;
    vscode.postMessage({ type: "queryFiles", reqId, query });
  }, 150);
}

export function handleFilesResponse(reqId: number, paths: string[]): void {
  if (reqId !== latestFileReqId) return; // 古い応答は破棄
  if (!suggestState || suggestState.kind !== "file") return;
  suggestState.items = paths;
  suggestState.selected = 0;
  renderSuggest();
}

// トリガー検出: "/" は行頭、または直前が空白かつクエリ1文字以上で行途中でも発火。
// "@" は行頭 or 直前が空白なら行途中でも（クエリ0文字から）発火。
function detectTrigger(): { kind: SuggestKind; triggerIndex: number; query: string } | null {
  const caret = inputEl.selectionStart ?? inputEl.value.length;
  const value = inputEl.value;
  const lineStart = value.lastIndexOf("\n", caret - 1) + 1;
  const beforeCaret = value.slice(lineStart, caret);
  const slash = beforeCaret.lastIndexOf("/");
  if (slash !== -1) {
    const prevChar = slash === 0 ? "" : beforeCaret[slash - 1];
    const query = beforeCaret.slice(slash + 1);
    // クエリが空の場合は誤爆防止のため行頭のみ発火。行途中は1文字以上入力されてから発火。
    const queryOk = slash === 0 ? true : query.length > 0;
    if ((slash === 0 || /\s/.test(prevChar)) && !query.includes(" ") && queryOk) {
      return { kind: "command", triggerIndex: lineStart + slash, query };
    }
  }
  const at = beforeCaret.lastIndexOf("@");
  if (at !== -1) {
    const prevChar = at === 0 ? "" : beforeCaret[at - 1];
    const query = beforeCaret.slice(at + 1);
    if ((at === 0 || /\s/.test(prevChar)) && !query.includes(" ")) {
      return { kind: "file", triggerIndex: lineStart + at, query };
    }
  }
  return null;
}

function refreshSuggest(): void {
  const trig = detectTrigger();
  if (!trig) {
    closeSuggest();
    return;
  }
  if (trig.kind === "command") updateCommandSuggest(trig.triggerIndex, trig.query);
  else updateFileSuggest(trig.triggerIndex, trig.query);
}

// リスナ登録は main.ts 末尾の init 呼び出し列からのみ行う（登録順の権威はそこ1箇所）。
// この本体に「呼び出し時にモジュールレベルの let を読む文」を足さないこと（TDZ）。
export function initSuggest(): void {
  inputEl.addEventListener("input", (e) => {
    if ((e as InputEvent).isComposing) return;
    refreshSuggest();
  });

  // caret移動（クリック/矢印キー/Home/End）でもトリガー判定を再評価し、
  // caretがトリガー範囲外に出た場合はサジェストを閉じる（陳腐化した triggerIndex での誤コミット防止）。
  inputEl.addEventListener("click", () => {
    refreshSuggest();
  });
  inputEl.addEventListener("keyup", (e) => {
    if (e.isComposing) return;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight" || e.key === "Home" || e.key === "End") {
      refreshSuggest();
    }
  });

  // キャプチャフェーズで登録し、既存の Enter=送信ハンドラより先に処理する
  inputEl.addEventListener(
    "keydown",
    (e) => {
      if (!suggestState || suggestEl.classList.contains("hidden")) return;
      if (e.isComposing) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (suggestState.items.length > 0) {
          suggestState.selected = (suggestState.selected + 1) % suggestState.items.length;
          renderSuggest();
        }
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (suggestState.items.length > 0) {
          suggestState.selected = (suggestState.selected - 1 + suggestState.items.length) % suggestState.items.length;
          renderSuggest();
        }
      } else if (e.key === "Enter" || e.key === "Tab") {
        if (suggestState.items.length > 0) {
          e.preventDefault();
          e.stopImmediatePropagation();
          commitSuggest(suggestState.selected);
        } else {
          closeSuggest();
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeSuggest();
      }
    },
    true
  );
}
