# Changelog

## 1.1.1

- **Works without an open folder.** With no folder open and no `laisora.defaultCwd`, a new
  conversation failed with "The working directory could not be determined" and the model list
  stayed empty. It now starts in your home folder, like the official Claude Code extension.
- **Several decisions in one reply.** Choosing an option no longer replaces the whole message box.
  Each choice adds its own line (`question → A: option`); choosing again in the same question
  replaces only that line, and what you were typing is kept.
- **Resume after the usage limit.** When the claude.ai usage limit stops a conversation, LAISORA
  continues it automatically after the limit resets, with a line showing when and a Cancel
  button. The switch is in Settings > General and is shared with Claude Code in the terminal.
- **Session name: Rename or Suggest.** The title's pencil and the ☰ menu offer Rename and Suggest.
  Suggest drafts a name from the conversation for you to confirm with Enter.
- **Accent colour.** Settings > General > Appearance: follow the theme, blue, orange, pink, green
  or a custom colour, each with separate values for light and dark themes. Buttons and keyboard
  focus keep the theme's colours.
- **Summaries run on haiku,** like name suggestions — faster and cheaper than the conversation's
  model.
- Fixes: the saved-results list in ANALYSIS is readable in dark themes; subagent reports in LOG no
  longer start with the CLI's hand-back preamble; the stuck-loop warning no longer counts usage-limit
  stops or failures that were retried successfully.

## 1.1.0

- **Five views in one vertical navigation.** CHAT, SUMMARY, GRAPH, ANALYSIS and LOG sit on a
  narrow rail beside the conversation. The composer stays available in every view.
- **PLAN beside the conversation.** When the agent works in steps, the plan appears in a column
  next to the chat: the goal it declared, each step with its status, who is working on it,
  elapsed time and tokens. It stays for the whole goal, not just the latest message, and
  completed steps fold away. In a narrow window a one-line bar under the title opens it as a
  drawer.
- **YOU: what is waiting on you.** Approvals, decisions and checks on your machine are collected
  in one list next to PLAN, each linking back to where it was asked. Decisions the agent asks in
  the reply are shown as a card with the options, their pros and cons, the recommendation and
  what happens if you do not answer.
- **SUMMARY rebuilt.** PLAN and YOU side by side, earlier requests with their step count, time
  and tokens, and the agents that were observed.
- **Agent roster.** A settings page for the roles the main agent can delegate to (worker,
  explorer, reviewer), with model and effort per row, and optional external executors (Codex,
  Antigravity) when their CLIs are installed. Changes apply from the next session.
- **Learning ledger (off by default).** When enabled, the main agent can record what it learned —
  model-specific or general — and the active rules are passed to the next sessions. Records stay
  on your machine; text with absolute paths or credentials is refused.
- **Replies.** Every reply ends with a copy button and its time; your own messages can be copied
  too. Replies no longer jump while they stream, and a reply that was not drawn is recovered.
- **File links.** Office documents, PDFs and other files you choose open in their default app,
  and folder links open in the file manager.
- **Handoff.** A handed-off conversation starts from its summary card and carries the recorded
  decisions forward.
- **Effort.** The model chip shows the effort the CLI actually applies.
- A new, quieter loading indicator.

## 1.0.0

First public release.

LAISORA is a VS Code extension for working with AI coding agents through the conversation
rather than the log. Commands and file operations move to a separate Status view, so the
Conversation view keeps your instructions and the agent's replies readable.

- **Conversation and Status as two views.** Read the reply without the tool noise; open the
  execution log when you need the detail.
- **Several conversations side by side.** Each tab runs its own session, with its own model,
  effort and permission mode.
- **A timeline of the agent and its subagents.** The Graph sub-tab shows what ran when, and a
  subagent opened from it shows the instruction it was given and the report it sent back.
- **Work-log analysis.** An LLM reads the execution log and suggests improvements to your
  workflow, instructions and settings, with links back to the records each finding is based on.
  Analysis uses the model selected for the conversation.
- **Control while it runs.** Steer a running turn, stop it, and answer permission requests
  from the conversation.
- **Carry long work forward.** Hand off a conversation to a new session using a summary and
  your own messages, keeping the original intact. Export a conversation to Markdown.

Requires a local Claude Code installation. See the README for supported SDKs and requirements.
