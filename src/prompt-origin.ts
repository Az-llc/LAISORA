import { OWN_INPUT_MEMORY_MAX } from "./claude-normalizer";

export interface OwnPrompt { readonly uuid: string; readonly text: string; readonly typed?: true }

const promptKey = (text: string): string => text.replace(/\r\n?/g, "\n").trim();

export function noteOwnPrompt(pending: readonly OwnPrompt[], uuid: string, text: string, typed = false): OwnPrompt[] {
  return [...pending, { uuid, text: promptKey(text), ...(typed ? { typed: true as const } : {}) }].slice(-OWN_INPUT_MEMORY_MAX);
}

export function forgetOwnPrompt(pending: readonly OwnPrompt[], uuid: string): OwnPrompt[] {
  return pending.some((entry) => entry.uuid === uuid) ? pending.filter((entry) => entry.uuid !== uuid) : [...pending];
}

export function classifyPrompt(pending: readonly OwnPrompt[], prompt: string): { readonly own: boolean; readonly typed: boolean; readonly pending: OwnPrompt[] } {
  const key = promptKey(prompt);
  const at = pending.findIndex((entry) => entry.text === key);
  return at < 0 ? { own: false, typed: false, pending: [...pending] }
    : { own: true, typed: pending[at].typed === true, pending: [...pending.slice(0, at), ...pending.slice(at + 1)] };
}
