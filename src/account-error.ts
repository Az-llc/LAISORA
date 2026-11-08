import * as l10n from "@vscode/l10n";
import type { AuthStatus } from "./protocol";

const ACCOUNT_ERROR_REASONS = {
  authentication_failed: "authentication-required",
  oauth_org_not_allowed: "organization-not-allowed",
  account_on_hold: "account-on-hold",
  verification_required: "verification-required",
  billing_error: "billing-error",
} as const;

export type AccountErrorReason = (typeof ACCOUNT_ERROR_REASONS)[keyof typeof ACCOUNT_ERROR_REASONS];

export function accountErrorReason(errorType: unknown): AccountErrorReason | undefined {
  return typeof errorType === "string" && Object.prototype.hasOwnProperty.call(ACCOUNT_ERROR_REASONS, errorType)
    ? ACCOUNT_ERROR_REASONS[errorType as keyof typeof ACCOUNT_ERROR_REASONS]
    : undefined;
}

export function isAccountErrorReason(value: unknown): value is AccountErrorReason {
  return (Object.values(ACCOUNT_ERROR_REASONS) as readonly unknown[]).includes(value);
}

export function accountErrorOfRecord(record: Record<string, unknown>): AccountErrorReason | undefined {
  if (record.type !== "assistant" || record.parent_tool_use_id != null || record.isSidechain === true) return undefined;
  return accountErrorReason(record.error);
}

export type AccountAuthSource = Pick<AuthStatus, "credentialSource" | "billingRealm" | "apiProvider" | "tokenSource"> | null | undefined;

const CLAUDE_AI_PROVIDER = "firstParty";
const STORED_LOGIN_TOKEN_SOURCES: readonly (string | undefined)[] = [undefined, "none"];

export function claudeAiSignInExpired(reason: AccountErrorReason, auth: AccountAuthSource): boolean {
  return reason === "authentication-required" && auth?.credentialSource === "oauth-subscription" && auth.billingRealm === "subscription"
    && auth.apiProvider === CLAUDE_AI_PROVIDER && STORED_LOGIN_TOKEN_SOURCES.includes(auth.tokenSource);
}

function accountErrorCause(reason: AccountErrorReason, claudeAi: boolean): string {
  switch (reason) {
    case "authentication-required": return claudeAi ? l10n.t("The claude.ai sign-in has expired or ended.") : l10n.t("Claude Code could not authenticate.");
    case "organization-not-allowed": return l10n.t("This organization is not allowed.");
    case "account-on-hold": return l10n.t("This account is on hold.");
    case "verification-required": return l10n.t("Account verification is required.");
    case "billing-error": return l10n.t("There is an account billing problem.");
  }
}

function accountErrorStep(reason: AccountErrorReason, claudeAi: boolean): string {
  switch (reason) {
    case "authentication-required": return claudeAi ? l10n.t("Sign in to claude.ai again (claude auth login).") : l10n.t("Check the sign-in or API key Claude Code uses.");
    case "organization-not-allowed": return l10n.t("Check the account Claude Code uses.");
    case "account-on-hold": return l10n.t("Check your account.");
    case "verification-required": return l10n.t("Verify your account.");
    case "billing-error": return l10n.t("Check your subscription or billing settings.");
  }
}

export function accountErrorText(reason: AccountErrorReason, next: "recheck" | "resend", auth: AccountAuthSource): string {
  const claudeAi = claudeAiSignInExpired(reason, auth);
  return l10n.t({
    message: "{0} {1} {2}",
    args: [accountErrorCause(reason, claudeAi), accountErrorStep(reason, claudeAi), next === "recheck" ? l10n.t("Then recheck.") : l10n.t("Then send your message again.")],
    comment: ["Account error: what happened, what to do, what to do after it"],
  });
}
