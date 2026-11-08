import * as vscode from "vscode";
import * as l10n from "@vscode/l10n";
import { resolveHandoffRuntime } from "./claudeHost";
import { sdkCliLaunch } from "./claudeCliResolver";
import { configuredClaudeExecutablePath, existingFolderOrHome, getLaisoraConfiguration } from "./claude-settings";
import { normalizeApiKeyPolicy } from "./protocol";
import type { Session } from "./session";

export const CLAUDE_SIGN_IN_ARGS = ["auth", "login"] as const;

export async function openSignInTerminal(s: Session | undefined): Promise<void> {
  const cfg = getLaisoraConfiguration();
  const runtime = await (s?.conversation?.launchRuntime()
    ?? resolveHandoffRuntime(configuredClaudeExecutablePath(cfg), normalizeApiKeyPolicy(cfg.get<string>("claude.apiKeyPolicy"))));
  const launch = sdkCliLaunch(runtime.claudeExecutablePath, CLAUDE_SIGN_IN_ARGS, runtime.env);
  if (launch === undefined) {
    throw new Error(l10n.t("Could not open the sign-in terminal: Node.js (node) was not found on PATH, and this Claude Code is a script that needs it."));
  }
  const terminal = vscode.window.createTerminal({
    name: l10n.t("Claude Code sign-in"),
    shellPath: launch.command,
    shellArgs: launch.args,
    env: launch.env,
    strictEnv: true,
    isTransient: true,
    cwd: existingFolderOrHome(s?.cwd || undefined),
  });
  terminal.show();
}
