import * as l10n from "@vscode/l10n";
import { renderMarkdownInto } from "./markdown";

// ---------- 承認カードの可読表示 ----------

// ラベル付きの1項目（値はテキスト or 整形済みブロック）
function approvalField(label: string, value: string, mono = false): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = "approval-field";
  const l = document.createElement("div");
  l.className = "approval-field-label";
  l.textContent = label;
  const v = document.createElement(mono ? "pre" : "div");
  v.className = mono ? "approval-pre" : "approval-field-value";
  v.textContent = value;
  wrap.append(l, v);
  return wrap;
}

function approvalLead(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "approval-lead";
  el.textContent = text;
  return el;
}

// 承認要求の「何を求められているか」を人が読める形に組み立てる。
// inputJson は context を含まない純粋な入力JSON（ホストが付与）。無い/壊れている場合は
// inputSummary か汎用文にフォールバックし、原データは呼び出し側の details に残る。
export function buildApprovalBody(toolName: string, inputJson?: string, inputSummary?: string): HTMLElement[] {
  let obj: Record<string, unknown> | null = null;
  if (inputJson) {
    try {
      const parsed: unknown = JSON.parse(inputJson);
      if (typeof parsed === "object" && parsed !== null) obj = parsed as Record<string, unknown>;
    } catch {
      obj = null;
    }
  }
  const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null);
  const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n)}${l10n.t("… (truncated)")}` : s);
  if (!obj) {
    return [approvalLead(inputSummary ? `${toolName}: ${inputSummary}` : l10n.t("Allow {0} to run?", toolName))];
  }
  const out: HTMLElement[] = [];
  switch (toolName) {
    case "ExitPlanMode": {
      out.push(approvalLead(l10n.t("Review the implementation plan. Approving will exit plan mode and begin implementation.")));
      const plan = str(obj.plan);
      if (plan) {
        const box = document.createElement("div");
        box.className = "approval-plan";
        renderMarkdownInto(box, plan);
        out.push(box);
      }
      break;
    }
    case "Bash": {
      out.push(approvalLead(l10n.t("The following command will be executed in the shell.")));
      const desc = str(obj.description);
      if (desc) out.push(approvalField(l10n.t("Purpose"), desc));
      const cmd = str(obj.command);
      if (cmd) out.push(approvalField(l10n.t("Command"), clip(cmd, 2000), true));
      break;
    }
    case "Write": {
      out.push(approvalLead(l10n.t("Will write a file (an existing file will be overwritten).")));
      const fp = str(obj.file_path);
      if (fp) out.push(approvalField(l10n.t("File"), fp));
      // 空文字は「ファイルを空にする」という重要な操作なので、値の有無ではなくキーの
      // 存在で判定して必ず出す
      if (typeof obj.content === "string") {
        out.push(approvalField(l10n.t("Content"), clip(obj.content, 1500) || l10n.t("(Empty — the file will be emptied)"), true));
      }
      break;
    }
    case "Edit":
    case "NotebookEdit": {
      out.push(approvalLead(l10n.t("Will replace part of a file.")));
      const fp = str(obj.file_path);
      if (fp) out.push(approvalField(l10n.t("File"), fp));
      const newKey = typeof obj.new_string === "string" ? "new_string" : "new_source";
      if (typeof obj.old_string === "string") {
        out.push(approvalField(l10n.t("Before"), clip(obj.old_string, 800) || l10n.t("(Empty)"), true));
      }
      if (typeof obj[newKey] === "string") {
        // 空文字＝削除。欄ごと消すと「何が起きるか」が伝わらない
        out.push(approvalField(l10n.t("After"), clip(obj[newKey] as string, 800) || l10n.t("(Empty — delete)"), true));
      }
      if (obj.replace_all === true) out.push(approvalField(l10n.t("Scope"), l10n.t("Replace all matching occurrences")));
      break;
    }
    case "Read": {
      out.push(approvalLead(l10n.t("Will read a file.")));
      const fp = str(obj.file_path);
      if (fp) out.push(approvalField(l10n.t("File"), fp));
      break;
    }
    case "Grep":
    case "Glob": {
      out.push(approvalLead(l10n.t("Will search files.")));
      const pattern = str(obj.pattern);
      if (pattern) out.push(approvalField(l10n.t("Pattern"), pattern, true));
      const path = str(obj.path);
      if (path) out.push(approvalField(l10n.t("Target"), path));
      break;
    }
    case "WebFetch":
    case "WebSearch": {
      out.push(approvalLead(l10n.t("Will access the external network.")));
      const url = str(obj.url) ?? str(obj.query);
      if (url) out.push(approvalField(str(obj.url) ? "URL" : l10n.t("Search query"), url));
      const prompt = str(obj.prompt);
      if (prompt) out.push(approvalField(l10n.t("Fetch purpose"), clip(prompt, 500)));
      break;
    }
    case "Agent":
    case "Task": {
      out.push(approvalLead(l10n.t("Will launch a subagent.")));
      const type = str(obj.subagent_type);
      if (type) out.push(approvalField(l10n.t("Type"), type));
      const desc = str(obj.description);
      if (desc) out.push(approvalField(l10n.t("Task"), desc));
      const prompt = str(obj.prompt);
      if (prompt) out.push(approvalField(l10n.t("Instructions"), clip(prompt, 1500), true));
      break;
    }
    default: {
      out.push(approvalLead(inputSummary ? `${toolName}: ${inputSummary}` : l10n.t("Allow {0} to run?", toolName)));
      // 未知ツールは主要フィールドを総当たりで並べる。ただし
      // - 件数上限（MCPツール等で数百キー来てもDOMが膨らまない）
      // - 資格情報らしきキーは伏せる（原データ側は折りたたみで保護されているのに、
      //   既定表示だけ無防備になるのを防ぐ）
      // - 非文字列は欠落させず存在だけ示す
      const SECRET_RE = /(key|token|secret|password|passwd|credential|auth)/i;
      let shown = 0;
      const entries = Object.entries(obj);
      for (const [k, v] of entries) {
        if (shown >= 20) break;
        shown++;
        if (SECRET_RE.test(k)) {
          out.push(approvalField(k, l10n.t("(Masked — see raw data)")));
        } else if (typeof v === "string") {
          out.push(approvalField(k, clip(v, 600) || l10n.t("(Empty)"), v.includes("\n")));
        } else if (typeof v === "number" || typeof v === "boolean" || v === null) {
          out.push(approvalField(k, String(v)));
        } else {
          out.push(approvalField(k, l10n.t("({0} — see raw data)", Array.isArray(v) ? l10n.t("array") : l10n.t("object"))));
        }
      }
      if (entries.length > shown) {
        out.push(approvalField("…", l10n.t("{0} more items (see raw data)", entries.length - shown)));
      }
      break;
    }
  }
  return out;
}
