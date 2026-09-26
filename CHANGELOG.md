# Changelog

## 1.2.0

- **ANALYSIS redesigned.** A compact grid opens the page: TIME (the main agent's time per model
  and in tools), ROLES (delegated runs grouped by role with time and tokens; press a role to list
  each run with executor, model and effort) and ERR (failures against tool runs, most frequent
  kinds first). LLM findings read as short articles with the suggested fix beside them. Script
  analysis is split into FAIL, RULE and LEARN sections and says so when a section is empty.
- **Learning ledger: reusable findings only.** The ledger now holds findings about LLM models and
  how to orchestrate and verify their work, not project knowledge; findings declared as
  project-specific are refused and the agent is pointed to the project's own CLAUDE.md, rules or
  docs. Learned rules apply to every project on this PC, and a rule is adopted automatically only
  after it recurs in two different projects. Rules adopted earlier from a single project return to
  candidates.
- **Model characteristics.** Settings > Conductor policy can research the models chosen in your
  roster (official docs and, optionally, Artificial Analysis) and passes their strengths, effort
  behaviour and caveats to the conductor. Model lists are remembered and refreshed in the
  background; Claude models keep the CLI's order.
- **PLAN.** Completed steps fold into one counted line wherever they are. A delegate resumed after
  its step finished adds a new step instead of reopening the old one, and renaming a step updates
  it in place. Steps from before a handoff are no longer shown. In a narrow window the plan bar
  shows a spinner while work is running.
- **YOU.** Resolved items fold into one counted line in SUMMARY and CHAT. Decision cards offer
  "Other", which puts the question into the message box for your own answer. Dismissed items and
  checked steps survive a window reload.
- **Stuck-loop warning measures lost time.** The warning now also fires when the same failure
  repeats and has cost five minutes or more, not only on a count of attempts.
- **Session name: Suggest** now renames the session directly.
- Closing the last tab opens a new empty one.
- Fixes: a message sent while a reply is still streaming no longer splits that reply in two, so a
  decision block in it stays intact and appears in YOU; file links written after the assistant
  changes directory in its shell now open, because
  the instruction names the conversation folder that relative links are resolved against;
  Markdown tables stay readable in narrow panels; copy buttons under messages no longer vanish
  when the pointer moves onto them, and message and reply footers share one layout (time, then
  copy); a restored reply keeps its decision blocks intact; ROLES shows delegated runs from other
  executors again after a reload; a resumed conversation no longer stays "resuming" after a reset.
- Agent SDK 0.3.281 (bundled Claude Code CLI 2.1.281).

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
