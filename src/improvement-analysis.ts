import * as vscode from "vscode";
import * as l10n from "@vscode/l10n";
import { fork, type ForkOptions } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFile, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { claudeConfigDir } from "./claude-env";
import { sendLaisoraInput } from "./conversation-lifecycle";
import { extensionContext, output } from "./host-context";
import type { ImprovementScanMessage, ImprovementScanSummary } from "./improvement-cli";
import {
  IMPROVEMENT_BRIEF_FILE, IMPROVEMENT_DIR, IMPROVEMENT_INDEX_FILE, IMPROVEMENT_PATTERNS_FILE, IMPROVEMENT_PARTIAL_SUFFIX, IMPROVEMENT_SCAN_TIMEOUT_MS, IMPROVEMENT_TOOL_FILE,
  improvementFirstMessage, improvementRecordCommand, improvementRunName, improvementRunsToDelete, languageName, renderImprovementBrief,
} from "./improvement-brief";
import type { Session } from "./session";
import { normalizeTitleValue } from "./session-display-title";
import { displayTitleFromSummary } from "./session-list";
import { openNewConversationTab, type SessionStore } from "./store-surfaces";

const BUNDLED_TOOL = ["dist", IMPROVEMENT_TOOL_FILE] as const;
const TAB_CLOSED_POLL_MS = 1000;

let runningTab: string | undefined;
const runOfTab = new Map<string, string>();

class ScanCancelled extends Error {}

function scanEnv(): NodeJS.ProcessEnv {
  const keep = ["SystemRoot", "SYSTEMROOT", "USERPROFILE", "HOME", "TEMP", "TMP", "LOCALAPPDATA", "APPDATA", "HOMEDRIVE", "HOMEPATH"];
  const env: NodeJS.ProcessEnv = { ELECTRON_RUN_AS_NODE: "1" };
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return env;
}

function runScan(context: vscode.ExtensionContext, outDir: string, cancelled: () => boolean): Promise<{ summary: ImprovementScanSummary; mismatches: readonly unknown[] }> {
  const ext = context.extensionUri.fsPath;
  const args = ["scan", "--out", outDir, "--config-dir", claudeConfigDir(),
    "--laisora-source", join(ext, "dist", "extension.js"), "--laisora-source", join(ext, "l10n", "bundle.l10n.ja.json")];
  return new Promise((resolve, reject) => {
    const options: ForkOptions & { windowsHide: boolean } = { execPath: process.execPath, execArgv: [], env: scanEnv(), windowsHide: true, stdio: ["ignore", "ignore", "pipe", "ipc"] };
    const child = fork(join(ext, ...BUNDLED_TOOL), args, options);
    let stderr = "";
    let settled = false;
    let disposedByHost = false;
    const subscription = { dispose: () => { disposedByHost = true; finish(new ScanCancelled()); } };
    const finish = (error: Error | undefined, value?: { summary: ImprovementScanSummary; mismatches: readonly unknown[] }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearInterval(poll);
      const at = disposedByHost ? -1 : context.subscriptions.indexOf(subscription);
      if (at >= 0) context.subscriptions.splice(at, 1);
      if (child.exitCode === null && child.signalCode === null) child.kill();
      if (error) reject(error); else resolve(value!);
    };
    context.subscriptions.push(subscription);
    const timer = setTimeout(() => finish(new Error(l10n.t("the scan did not finish within {0} minutes", IMPROVEMENT_SCAN_TIMEOUT_MS / 60000))), IMPROVEMENT_SCAN_TIMEOUT_MS);
    const poll = setInterval(() => { if (cancelled()) finish(new ScanCancelled()); }, TAB_CLOSED_POLL_MS);
    child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(-2000); });
    child.on("message", (m: ImprovementScanMessage) => {
      if (m?.type === "done") finish(undefined, { summary: m.summary, mismatches: m.mismatches });
      else if (m?.type === "failed") finish(new Error(m.error));
    });
    child.on("error", (e) => finish(e));
    child.on("close", (code, signal) => finish(new Error(l10n.t("the scanner stopped without a result ({0})", String(signal ?? code)) + (stderr ? `: ${stderr.trim()}` : ""))));
  });
}

async function pruneRuns(root: string, st: SessionStore): Promise<void> {
  const names = await readdir(root).catch(() => [] as string[]);
  const inUse = new Set<string>();
  for (const [tabId, run] of runOfTab) {
    const s = st.sessions.get(tabId);
    if (s && !s.closed) inUse.add(run); else runOfTab.delete(tabId);
  }
  for (const name of improvementRunsToDelete(names, inUse, Date.now())) {
    await rm(join(root, name), { recursive: true, force: true }).catch((e) => output.appendLine(`[improvement] could not delete ${name}: ${String(e)}`));
  }
}

function openAnalysisTab(st: SessionStore): Session | undefined {
  const title = l10n.t("LLM improvement analysis");
  return openNewConversationTab(st, (s) => {
    s.title = displayTitleFromSummary(title, s.tabId);
    s.autoTitled = true;
    const chosen = normalizeTitleValue(title);
    s.unpersistedChosenTitle = chosen === null ? null : { title: chosen, failedAttempts: 0 };
  });
}

export async function startImprovementAnalysis(st: SessionStore): Promise<void> {
  const context = extensionContext;
  if (!context) return;
  if (runningTab !== undefined) {
    st.post({ type: "activateTab", tabId: runningTab });
    void vscode.window.showInformationMessage(l10n.t("LAISORA: An LLM improvement analysis is already scanning. Wait for it to finish."));
    return;
  }
  const session = openAnalysisTab(st);
  if (!session) return;
  runningTab = session.tabId;
  session.awaitingLaisoraInput = true;
  const notice = (text: string): void => { if (!session.closed) st.post({ type: "tabNotice", tabId: session.tabId, text }); };
  notice(l10n.t("Scanning all local Claude Code conversations for recurring failures. Claude starts the analysis when the scan finishes."));
  const root = join(context.globalStorageUri.fsPath, IMPROVEMENT_DIR);
  const name = improvementRunName(new Date(), randomBytes(4).toString("hex"));
  const partial = join(root, `${name}${IMPROVEMENT_PARTIAL_SUFFIX}`);
  const run = join(root, name);
  let scanned = false;
  try {
    await mkdir(partial, { recursive: true });
    const { summary, mismatches } = await runScan(context, partial, () => session.closed);
    output.appendLine(`[improvement] scan ${JSON.stringify(summary)}${mismatches.length ? ` self-check mismatches ${JSON.stringify(mismatches).slice(0, 2000)}` : ""}`);
    await copyFile(join(context.extensionUri.fsPath, ...BUNDLED_TOOL), join(partial, IMPROVEMENT_TOOL_FILE));
    const language = languageName(vscode.env.language);
    const paths = { briefPath: join(run, IMPROVEMENT_BRIEF_FILE), indexPath: join(run, IMPROVEMENT_INDEX_FILE), patternsPath: join(run, IMPROVEMENT_PATTERNS_FILE) };
    const recordCommand = improvementRecordCommand(process.execPath, join(run, IMPROVEMENT_TOOL_FILE), claudeConfigDir());
    await writeFile(join(partial, IMPROVEMENT_BRIEF_FILE), renderImprovementBrief({ ...paths, recordCommand, extensionRoot: context.extensionUri.fsPath, language }), "utf8");
    await rename(partial, run);
    scanned = true;
    runOfTab.set(session.tabId, name);
    await pruneRuns(root, st);
    if (session.closed) return;
    const sent = await sendLaisoraInput(session, { kind: "improvement" }, improvementFirstMessage({ ...paths, language }));
    if (!sent) notice(l10n.t("The scan finished, but the conversation could not be started. The results are in {0}.", run));
  } catch (e) {
    if (e instanceof ScanCancelled) output.appendLine("[improvement] scan cancelled");
    else {
      output.appendLine(`[improvement] failed: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
      const reason = e instanceof Error ? e.message.split("\n")[0] : String(e);
      notice(scanned
        ? l10n.t("The scan finished, but the conversation could not be started. The results are in {0}.", run)
        : l10n.t("The LLM improvement analysis could not scan the conversations: {0}", reason));
    }
    if (!scanned) await rm(partial, { recursive: true, force: true }).catch(() => undefined);
  } finally {
    session.awaitingLaisoraInput = false;
    runningTab = undefined;
  }
}
