import * as l10n from "@vscode/l10n";
import { activeTab } from "./main";
import {
  findBarEl,
  findCloseBtn,
  findCountEl,
  findInputEl,
  findNextBtn,
  findPrevBtn,
  inputEl,
} from "./dom";

let currentMarks: HTMLElement[] = [];
let currentIndex = -1;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;

export function isFindBarOpen(): boolean {
  return !findBarEl.classList.contains("hidden");
}

export function clearHighlights(): void {
  const parents = new Set<Node>();
  for (const mark of currentMarks) {
    const parent = mark.parentNode;
    if (parent) {
      parents.add(parent);
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      mark.remove();
    }
  }
  for (const parent of parents) {
    parent.normalize();
  }
  currentMarks = [];
  currentIndex = -1;
}

// 過去を読み込んでいる間の件数は母集合の途中。確定値に見せると「2 回しか出てこない」と結論される（R-26）
function countSuffix(): string {
  const state = activeTab()?.convHistoryLoadState() ?? null;
  if (state === "loading") return l10n.t(" (loading history)");
  if (state === "failed") return l10n.t(" (history loading failed; partial count)");
  return "";
}

function updateCount(current: number, total: number): void {
  findCountEl.textContent = `${current} / ${total}${countSuffix()}`;
}

// 読み込み状態が変わったときに件数の注記だけ描き直す（検索はやり直さない）
export function refreshFindCount(): void {
  if (!isFindBarOpen()) return;
  updateCount(currentMarks.length === 0 ? 0 : currentIndex + 1, currentMarks.length);
}

// anchor="end": 先頭へ prepend された後の再検索。現在位置を末尾からの距離で保ち、スクロールも動かさない
export function runSearch(query: string, preserveIndex = false, anchor: "start" | "end" = "start"): void {
  if (debounceTimer !== undefined) {
    clearTimeout(debounceTimer);
    debounceTimer = undefined;
  }
  const previousIndex = currentIndex;
  const previousTotal = currentMarks.length;
  clearHighlights();
  const q = query.trim();
  if (!q) {
    updateCount(0, 0);
    findInputEl.classList.remove("no-match");
    findInputEl.style.borderColor = "";
    return;
  }

  const convEl = activeTab()?.convEl ?? (document.querySelector(".panel-conv.active") || document.querySelector(".panel-conv")) as HTMLElement | null;
  if (!convEl) {
    updateCount(0, 0);
    return;
  }

  const lowerQuery = q.toLowerCase();
  const walker = document.createTreeWalker(convEl, NodeFilter.SHOW_TEXT, {
    acceptNode(node: Node): number {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName.toLowerCase();
      if (tag === "script" || tag === "style" || tag === "textarea" || tag === "input") {
        return NodeFilter.FILTER_REJECT;
      }
      if (
        parent.closest(".find-bar") ||
        parent.closest(".assistant-seg.streaming .seg-tail") ||
        Boolean(parent.closest(".seg-tail")?.closest(".streaming"))
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const textNodes: Text[] = [];
  let n = walker.nextNode();
  while (n) {
    textNodes.push(n as Text);
    n = walker.nextNode();
  }

  for (const node of textNodes) {
    const text = node.nodeValue || "";
    if (!text) continue;
    const lower = text.toLowerCase();
    let matchIdx = lower.indexOf(lowerQuery);
    if (matchIdx === -1) continue;

    const frag = document.createDocumentFragment();
    let lastIdx = 0;
    while (matchIdx !== -1) {
      if (matchIdx > lastIdx) {
        frag.appendChild(document.createTextNode(text.slice(lastIdx, matchIdx)));
      }
      const mark = document.createElement("mark");
      mark.className = "find-match";
      mark.textContent = text.slice(matchIdx, matchIdx + q.length);
      frag.appendChild(mark);
      currentMarks.push(mark);
      lastIdx = matchIdx + q.length;
      matchIdx = lower.indexOf(lowerQuery, lastIdx);
    }
    if (lastIdx < text.length) {
      frag.appendChild(document.createTextNode(text.slice(lastIdx)));
    }
    node.parentNode?.replaceChild(frag, node);
  }

  const total = currentMarks.length;
  if (total > 0) {
    findInputEl.classList.remove("no-match");
    findInputEl.style.borderColor = "";
    let target = 0;
    if (preserveIndex && previousIndex >= 0) {
      const shifted = anchor === "end" ? previousIndex + (total - previousTotal) : previousIndex;
      if (shifted >= 0 && shifted < total) target = shifted;
    }
    currentIndex = target;
    currentMarks[currentIndex].classList.add("find-match-current");
    if (!(preserveIndex && anchor === "end")) currentMarks[currentIndex].scrollIntoView({ block: "center" });
    updateCount(currentIndex + 1, total);
  } else {
    findInputEl.classList.add("no-match");
    findInputEl.style.borderColor = "var(--vscode-inputValidation-warningBorder)";
    currentIndex = -1;
    updateCount(0, 0);
  }
}

export function openFindBar(): void {
  findBarEl.classList.remove("hidden");
  let prefill = "";
  if (inputEl.selectionStart !== null && inputEl.selectionEnd !== null && inputEl.selectionStart !== inputEl.selectionEnd) {
    prefill = inputEl.value.slice(inputEl.selectionStart, inputEl.selectionEnd).trim();
  }
  if (!prefill) {
    const sel = window.getSelection()?.toString().trim();
    if (sel) prefill = sel;
  }
  if (prefill) {
    findInputEl.value = prefill;
  }
  findInputEl.focus();
  findInputEl.select();
  runSearch(findInputEl.value);
}

export function closeFindBar(restoreFocus = true): void {
  if (findBarEl.classList.contains("hidden") && currentMarks.length === 0) return;
  findBarEl.classList.add("hidden");
  clearHighlights();
  findInputEl.classList.remove("no-match");
  findInputEl.style.borderColor = "";
  findCountEl.textContent = "0 / 0";
  if (restoreFocus) {
    inputEl.focus();
  }
}

export function findNext(dir: 1 | -1): void {
  if (currentMarks.length === 0) return;
  currentMarks[currentIndex].classList.remove("find-match-current");
  currentIndex = (currentIndex + dir + currentMarks.length) % currentMarks.length;
  currentMarks[currentIndex].classList.add("find-match-current");
  currentMarks[currentIndex].scrollIntoView({ block: "center" });
  updateCount(currentIndex + 1, currentMarks.length);
}

export function refreshFind(anchor: "start" | "end" = "start"): void {
  if (!isFindBarOpen()) return;
  // 入力のデバウンス待ちを取り消さない。取り消すと途中の入力値で確定検索が走り、
  // 待ちが明けたときの検索が prepend 分も数えるので後回しで足りる（M-4。CH-U32d）
  if (debounceTimer !== undefined) return;
  runSearch(findInputEl.value, true, anchor);
}

export function initFindBar(): void {
  findInputEl.addEventListener("input", () => {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      runSearch(findInputEl.value);
    }, 60);
  });

  findInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
        runSearch(findInputEl.value);
      }
      findNext(e.shiftKey ? -1 : 1);
    } else if (e.key === "Escape") {
      e.preventDefault();
      closeFindBar();
    }
  });

  findPrevBtn.addEventListener("click", () => {
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
      runSearch(findInputEl.value);
    }
    findNext(-1);
  });
  findNextBtn.addEventListener("click", () => {
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
      runSearch(findInputEl.value);
    }
    findNext(1);
  });
  findCloseBtn.addEventListener("click", () => closeFindBar());
}
