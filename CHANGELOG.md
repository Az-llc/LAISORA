# Changelog

## 1.13.0

- **ToDo from a reply.** Claude's replies get "Add to ToDo" and "Add to ToDo and start a new
  conversation" beside Copy. Claude makes the reply's topic one ToDo item with a work memo, places
  it by the usual rules and says where it went. The buttons follow the ToDo switch.
- ToDo rows drag from anywhere on the row with a mouse.
- ToDo counts: group chips count open items only, and done counts include items under a parent
  marked done, so open plus done equals all items.
- An empty PC gets a one-time ToDo tutorial item.
- A tool call interrupted while it ran counts as a run, not a failure.
- Claude Code started by LAISORA sends no telemetry when VS Code telemetry is off.
- Claude Agent SDK 0.3.312 (Claude Code CLI 2.1.312).

## 1.12.0

- **Welcome.** An empty new conversation shows a greeting, what is new in this version until you
  close it, and a rotating tip. Hide the news or the tips with `laisora.welcome.showNews` and
  `laisora.welcome.showTips`.
- **ToDo is out of beta** and on by default. Turn it off with `laisora.todo.enabled`.
- **GRAPH** shows the work a delegate started as folded rows under that delegate. Pressing a step
  row folds it; pressing a member row again opens the Inspector. Delegates whose launch is missing
  from the record are listed together, and LOG, GRAPH, ROLES and ANALYSIS count the same delegates,
  calls and failures.
- A conversation whose working folder no longer exists is not started and says so. Conversations
  from Claude Desktop continue in their own folder and are listed under Claude Code in History.
- SUMMARY, ANALYSIS, PLAN and GRAPH show processing time only, measured the same way on every
  screen. ANALYSIS splits time by role.
- The transcript retention setting shows the days that apply when it is empty, and applies only to
  launches that read your Claude settings.
- Claude Agent SDK 0.3.311 (Claude Code CLI 2.1.311).

## 1.11.0

- **Remote Control per tab.** Turn Remote Control on or off from the tab menu, or with
  `/remote-control` (alias `/rc`). A card in the chat shows the claude.ai link and the connection
  state, and messages sent from claude.ai appear in the tab as they arrive. Hide the card with
  `laisora.remoteControl.showCard`. `laisora.claude.remoteControlAtStartup` now really turns
  Remote Control on at launch.
- **Automatic handoff (off by default).** An idle tab can hand off to a new conversation when its
  context reaches a share of the auto-compact amount (`laisora.handoff.auto.percent`) or a token
  count, and shortly before a 1-hour prompt cache expires. Before handing off, Claude is asked to
  finish the step in progress and record its state.
- **History tabs** sort conversations by where they were started: Claude desktop conversations
  count as Claude Code, and a Claude Code conversation continued in LAISORA stays in the Claude
  Code tab.
- **PLAN** counts the steps of every plan in the conversation and no longer says all steps are
  done while an earlier plan still has open steps.
- LOG, GRAPH, PLAN, ANALYSIS and the status line show the same numbers for the same quantity.
- A reopened conversation shows an approval card that was interrupted as withdrawn.
- A conversation handoff left behind by a crash is cleaned up at the next start.
- Claude Agent SDK 0.3.309 (Claude Code CLI 2.1.309).

## 1.10.0

- **Faster reopening.** A restored or reopened conversation starts Claude before its history is
  drawn, reads its record once, and no longer reads the conversations it was handed off from, so
  you can send sooner. LOG, SUMMARY and ANALYSIS cover the current conversation since the handoff.
- **Learning retired.** LAISORA's learning ledger and its tools are gone, and the old learning
  data is removed once. The placement guard stays and can be turned off with
  `laisora.guard.enabled`.
- **ANALYSIS.** The comparison with your usual values is removed.
- **ToDo.** Card answers in a linked conversation are added to the item's decisions. The drawer no
  longer covers the composer, and one malformed entry no longer drops a whole list.
- **Permission denials** appear in LOG only; a call that ran is never shown as denied.
- A restored tab shows its real title as soon as it is known; a handoff card names the conversation
  it continues.
- Time breakdown: waiting for a reply after a call left open no longer counts as tool execution.
- Export writes messages not yet recorded at their place, and image-only messages as an attachment.
- Late shutdown no longer logs "Channel has been closed".
- Claude Agent SDK 0.3.306 (Claude Code CLI 2.1.306).

## 1.9.1

- **Handoff.** The conversation a handoff opens no longer shows the file-edit cards of the
  conversation it continues.
- **Permission mode.** The mode in the footer follows the mode Claude Code reports, for example
  after a model switch leaves auto mode or a plan approval leaves plan mode, and only modes you
  chose are saved as the next default.
- ANALYSIS no longer counts some reply tokens twice, and time spent in nested agents is attributed
  to the agent that started them.

## 1.9.0

- **Tabs.** Tabs keep their width and scroll instead of sliding under the controls, and a list of
  all tabs opens from the tab bar. A rebuilt tab keeps its place in the tab order.
- **Learning on by default.** `laisora.learning.enabled` now defaults to on.
- **Reopened conversations.** A reopened conversation starts Claude when it opens, shows its
  recorded team before the first send, and draws its history the same way as a live conversation,
  with each turn labelled by its own model.
- **ToDo.** Start / Continue sits beside the menu in the item detail, items saved without times now
  open their detail, and a detail that cannot load offers Retry instead of loading forever.
- **Git reads.** LAISORA's own git reads no longer run programs configured by the repository they
  read.
- Chat keeps following the bottom when content grows; narrow SUMMARY and tab layouts fit without
  clipping.
- Claude Agent SDK 0.3.304 (Claude Code CLI 2.1.304).

## 1.8.1

- **Project memory.** Claude can again save ongoing work state as project-type auto memory, which
  LAISORA used to refuse in every project. Turn on `laisora.memory.blockProjectType` (off by
  default) to refuse it as before.
- **Learning off.** With `laisora.learning.enabled` off, notes that name models or efforts are no
  longer refused in memory, CLAUDE.md or rules, and Claude is no longer pointed to a learning ledger
  that is not running.
- **Settings page.** The settings page warns when it opens in a window that has not registered
  LAISORA's settings.

## 1.8.0

- **ToDo (beta).** `laisora.todo.enabled` (off by default) adds a fixed ToDo tab shared by all
  windows on this PC. Claude adds and organizes tasks from the conversation, each turn's changes
  show as one card you can revert, and open decisions show under the task they belong to.
- **Tasks and conversations.** Start or continue a task in its own conversation, split a child task
  into a child conversation with a handoff brief, and open a conversation's ToDo drawer with
  Ctrl+Alt+T.
- **Edit summary.** At the end of each turn a card lists the edited files with lines added and
  removed; press a file to open that turn's diff read-only. Turn it off with
  `laisora.editSummary.enabled` (on by default).
- **Code blocks.** Copy, preview and full view are always visible in the code block header.
- **Titles.** A conversation title chosen in LAISORA is kept after a restart.
- Claude Agent SDK 0.3.303 (Claude Code CLI 2.1.303).

## 1.7.0

- **Clearer decision cards.** Claude is asked to state the facts behind a decision, the concrete
  effect of each option and how the options compare. A card can carry folded details, and "Other"
  lets you answer in your own words.
- **Decision quality check (beta).** `laisora.claude.askQualityCheck` (off by default) hides a
  decision whose reason or option effects only repeat its title or labels, and asks Claude to
  rewrite it.
- **Code blocks.** Code blocks show as cards with a language label, wrap long lines by default, and
  fold long blocks with a reader that shows the whole block.
- **Copy links.** Links in the chat have a copy button; file links copy the full resolved path.
- **Times.** Events without their own time are stamped when they arrive, and a sent message starts
  at the time it was sent. An automatic denial shows the reason given by the check that denied it.
- **YOU list.** A newer item of the same kind replaces the older one after you reply, and a
  checklist closes when every item is ticked or you send the next message.
- Claude Agent SDK 0.3.299 (Claude Code CLI 2.1.299).

## 1.6.1

- **Paste text with Ctrl+Shift+V.** In the message box, Ctrl+V still attaches images, and
  Ctrl+Shift+V pastes only the clipboard text (cells copied from a spreadsheet arrive as text).
  It works in both the editor panel and the sidebar view.
- **PLAN agent rows fold.** Each step's agents fold into one line with the count and how many are
  working or failed; press it to open or close that step's agents. The open state survives
  re-renders.
- **Completed steps stay completed.** The conductor can no longer mark a step done while one of its
  agents is still running, or resume an agent on a step that is already done without reopening the
  step first.

## 1.6.0

- **Work follows the PLAN.** GRAPH, ANALYSIS and SUMMARY now split a conversation by the steps of
  its PLAN: each step gets its own row with the conductor's work, delegations, time, tokens and
  cache hits, and work outside any step goes to one "Unplanned work" row. Resumed delegations show
  inside the step they continue, finished PLANs fold together, and stopped agents show as stopped.
- **CLI updates in the background.** A new CLI tab in settings shows the Claude Code, Codex and
  Antigravity CLIs. LAISORA updates them while nothing is running, at startup and every 30 minutes;
  each can be turned off (`laisora.claude.autoUpdate`, `laisora.codex.autoUpdate`,
  `laisora.antigravity.autoUpdate`), and Claude Code's own update settings still apply.
- **Roster and prompt cache.** Each role can use a 5-minute or 1-hour prompt cache, the settings
  show the official prices for the Claude models in use, and a roster suggestion can be applied
  with one button. Delegation effort follows the CLI's default effort.
- **Delegates cannot change instructions.** Subagents and external runs can no longer change
  instruction, settings, hook or memory files; external runs report such changes instead.
- **Learning ledger.** Rules are generated only for explained failure classes, observations cite the
  runs they are about, and the conductor can correct a delivered line. Model research and its
  setting (`laisora.learning.profileSources`) are removed. Old learning stores are no longer
  deleted at startup (they are still not read).
- **Safety refusals.** When a refusal switches to a fallback model, the original model is always
  restored and the safety category is shown; the
  `laisora.claude.restoreModelAfterRefusalFallback` setting is removed.
- **Longer chat history.** `laisora.history.eventLimit` sets how many events a conversation keeps.
  The chat keeps its reading position when the panel width changes.
- Claude Agent SDK 0.3.296 (Claude Code CLI 2.1.296).

## 1.5.0

- **Faster startup.** Restored tabs, the conversation view and the CLI start no longer wait while
  the learning ledger is re-read in full for every lookup; with a large ledger this used to hold
  the window for tens of seconds.
- **Learning history starts over.** The learning ledger moves to a new, more compact file
  (`ledger-v3.jsonl`) with a verified checkpoint, so it opens without re-reading every record.
  Earlier learning records (`ledger.jsonl`) are not carried over and are deleted at startup;
  conversation links, proposals and the machine key are kept.
- **Model list appears at once.** A new tab shows the model list Claude Code returned last time and
  replaces it when the current list arrives. A model chosen while only the remembered list is
  shown applies to the tab but is not written to settings.json.
- **History list opens faster.** It reads session details only for the entries a page shows.

## 1.4.1

- **Initial model now also applies to resumed conversations.** Tabs restored at startup, sessions
  reopened from history, crash restarts and handoff targets start on the initial model (a model
  chosen in the tab still comes first). Previously they started on whatever model Claude Code's
  settings named, which could silently switch an Opus conversation to Sonnet. If Claude runs a
  different model than the one LAISORA asked for, the tab now says so.
- **Settings page shows why a save failed,** directly under the setting, with a button to reload
  the window (when the window still uses the previous version's settings after an update) or to
  open settings.json. The control returns to the value that is actually saved.

- **Learning ledger v2.** The ledger now holds model-specific usage knowledge: each line names the
  model, role and effort it applies to, and is labelled as a recurring failure, public source,
  provisional observation or measurement. The conductor records what it saw with new observe,
  propose and public tools, and the knowledge reaches delegates as one "Model usage knowledge"
  section. This corrects the 1.2.0 statement: candidates are not delivered until adopted, and new
  general findings are no longer accepted. Old learning records, including general records, are
  deleted once at startup.
- **Work segmented by PLAN steps.** GRAPH, SUMMARY and ANALYSIS split the work by the steps of the
  plan, with per-step time, waits and tokens.
- **Subagent wait.** Waiting for subagents and external delegates is its own category on GRAPH,
  SUMMARY, ANALYSIS and STEPS, and no longer counts as tool execution. Background external runs
  are counted like background subagents.
- **Design unified.** The inspector, history list, handoff card and SUMMARY colours follow the same
  layout and theme colours as GRAPH and ANALYSIS. Inspector tabs move with the arrow keys.
- **History list: rename and hide.** Each row can be renamed (same as renaming the tab) or hidden
  from the list; hiding keeps the record.
- **Display name.** `laisora.appearance.displayName` replaces "YOU" in the conversation, the YOU
  column, decision cards and Markdown export. The settings page is redesigned.
- **YOU and PLAN stay visible** for the whole conversation, and showing or hiding PLAN keeps your
  reading position.
- **Usage panel shows current values.** Opening the panel fetches plan usage again instead of
  showing an outdated cached value.
- **Initial model (opt-in).** `laisora.claude.initialModel` sets the model for new conversations.
- **Conversation stays responsive during external runs.** You can talk to the conductor while an
  external delegate works, and stopping waits for its processes to end.
- Handoff: context size is measured at capture and after resume, the card shows it, and the
  unsupported automatic re-compaction is stopped.
- Text written between tool calls appears in CHAT and history as its own segment.
- Status line shows the usage-limit wait; the PLAN loader spins only while work runs; the
  pending-decision count appears once per view.
- One model-name resolver for the chip, turn labels, dividers, fallback notices and settings.
- Conversations start with ultracode off; LAISORA does not support it.
- Fixes: sends made while a resumed conversation prepares its history are kept; withdrawn
  approvals are no longer shown as denials; specific tool refusal reasons are kept; learning
  observations are accepted when the conductor model has a context suffix such as `[1m]`.
- Fixes: resuming a very long session no longer stalls while its time views are rebuilt; renaming
  a session no longer marks its LLM analysis as out of date; a delegated run is kept when the
  learning ledger cannot be written, and the conversation is then reported as incompletely
  observed instead of undercounted; an internal error while preparing a delegated task is
  reported as such instead of as an over-long prompt.
- Learning safeguards fail closed: a write is treated as protected, and a project-specific claim
  is refused, when the files needed to decide cannot be read.
- Agent SDK 0.3.289 (bundled Claude Code CLI 2.1.289).

## 1.3.0

- **GRAPH redesigned.** The axis is elapsed time. Hidden waits are cut from both the axis and the
  total, and reply waits start hidden. A 15-minute grid replaces the break marks and fold bands,
  and a coverage line appears only where records are really missing.
- **LOG redesigned.** Each request is a numbered, foldable group with its duration. Only the
  latest request is open, and a folded request still shows its last tool row. Failures are marked
  by a glyph, and findings appear as a line under the row they concern.
- **SUMMARY HUD.** The top of SUMMARY is now a compact HUD with two groups. GRAPH covers elapsed
  and processing time, parallelism, a per-request strip and reply wait. ANALYSIS covers
  improvement candidates and their state. The old start line, time buckets, bars and cards are
  gone.
- **Status line shows what is really happening:** generating, delegates running, or a decision
  waiting for you. It and NOW also say what a tool call is doing, taken from the call's own input.
- Loading indicators in the status line, history slot and PLAN bar sit at the right end, so the
  text is truncated first. The PLAN bar loader lines up with the running text beside it.
- **Refusal fallback.** When a refusal switches the conversation to a fallback model, the
  conversation says so and the model chip warns while it is in effect. When that turn ends, the
  model you chose is restored for that conversation only; settings.json is not changed. To
  confirm in YOU with a restore button instead, turn off
  `laisora.claude.restoreModelAfterRefusalFallback`.
- **Delegated runs resume after usage limits.** If a delegate stops on the usage limit while the
  main conversation is idle, a resume is scheduled.
- **Settings: Suggest efforts.** A new button next to Research opens a conversation that proposes
  an effort for each roster row. Only the rows you approve are changed, and the diff is shown.
- **Model characteristics.** Research opens in its own conversation tab and can be run again at
  any time. The research block lists each roster model with the date it was last retrieved. The
  characteristics now cover only effort behaviour and caveats.
- The per-row analysis button in the history list is removed.
- Fixes: a decision block value that starts with `#` or another literal character is now read
  correctly; a reply that was still arriving when the next turn started keeps its late text;
  `media/tokens.css` was missing from the 1.1.1 and 1.2.0 packages and is now included.
- Agent SDK 0.3.284 (bundled Claude Code CLI 2.1.284).

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
