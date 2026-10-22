<p><img src="media/laisora-wordmark.png" alt="LAISORA" width="360"></p>

English | [日本語](README.ja.md)

An AI agent runs command after command and rewrites code. Watching the log does not necessarily tell you what it is doing or why. I have found myself in that position more and more often.

I wanted the everyday view to focus on the conversation: what I want to achieve and how to move forward. When I need the details, I can ask the agent to explain or open the execution log. LAISORA is a VS Code extension for Claude Code built around that way of working.

Commands and file operations appear in LOG, so your instructions and the agent's replies are easier to follow in CHAT. The two screenshots below are the same conversation: first CHAT with PLAN and YOU beside it, then LOG, where each of your requests is a numbered group of the tool calls it led to.

<img src="media/screenshots/conversation.png" alt="CHAT with a decision card the agent asked for (options, pros and cons, and a recommendation), YOU with resolved items folded into one line, and PLAN with its goal and completed steps folded into one line" width="734">

<img src="media/screenshots/execution-log.png" alt="LOG for the same conversation, with each request as a numbered group: the latest is open, and earlier ones are folded to their last tool call" width="734">

## Turn work logs into improvements for the next task

The finished result does not always reveal where the agent struggled or repeated itself along the way, and reading a long log yourself is not easy.

LAISORA can ask an LLM to analyze a work log and suggest improvements to the workflow, instructions, and settings. Follow a suggestion back to the records behind it, then start a new conversation to act on the ones you agree with. Analysis uses the model selected for the conversation, so newer models also improve the review of your work.

<img src="media/screenshots/llm-analysis.png" alt="ANALYSIS on the LLM Analysis tab, with a saved analysis and its first finding, the improvement area, and links to the records behind it" width="734">

## What you can do

### Run several conversations side by side

Each conversation is a tab that keeps its own draft, view, and scroll position. A tab stays lit while its subagents are still running, even after the main reply has finished. Open past sessions from the history list and resume them in the folder where they were started. Rows in the history list can be renamed or hidden; hiding keeps the session's record, and **Show hidden** brings it back. By default, LAISORA reopens the tabs that were open when the window was last closed or reloaded.

### Read the reply without the noise

Every conversation has five views: **CHAT**, **SUMMARY**, **GRAPH**, **ANALYSIS**, and **LOG**.

CHAT shows what the model says to you, along with approval requests, failures, and relevant notices. Tool activity goes to LOG, so a long run of commands does not break a reply into pieces. Each reply has a footer with a copy button and its time, and you can copy your own messages too. At the end of a reply, LAISORA can list the files Claude edited in that turn with the lines added and removed; click a file to compare it before and after the turn.

### See what the agent is actually doing

**PLAN** beside CHAT shows the goal the agent declared, its steps and their status, who is working on each, elapsed time, and tokens. It stays for the whole goal, across messages, and completed steps fold into one line you can expand. Without declared steps, it shows the work observed now. In a narrow window, a one-line bar under the title opens PLAN and YOU as a drawer.

The other views let you look more closely:

- **SUMMARY** — the key figures from GRAPH and ANALYSIS, PLAN and YOU side by side, and earlier requests with their steps, time, and tokens.
- **GRAPH** — a timeline of the main agent, its subagents, and background tasks. Each request is a block split by the steps of the plan. A map of the whole session lets you narrow the time window, and waiting for subagents is shown separately from tool execution. Open a subagent to read the full instruction it was given.
- **ANALYSIS** — time by model and in tools, time and tokens by delegated role, failures by kind, and each plan step's figures. Script analysis lists failure classifications and convention violations; optional LLM analysis shows findings that link back to their evidence.
- **LOG** — tool calls grouped by request, with input and output previews, duration, and marks for failures. Only the latest request is open; a folded request still shows its last tool call.

When session records are incomplete, the views say so instead of showing partial numbers as complete.

The screenshots below show SUMMARY, GRAPH, and the instruction given to a subagent opened from GRAPH.

<img src="media/screenshots/summary.png" alt="SUMMARY with the GRAPH figures (elapsed and processing time, parallelism, time in generation, tools and subagents, time per work block) and the ANALYSIS figures at the top, and PLAN and YOU below" width="734">

<img src="media/screenshots/graph.png" alt="GRAPH with a map of the whole session and the legend at the top, and each request as a block on an elapsed-time axis with its plan steps below it" width="734">

<img src="media/screenshots/subagent-instruction.png" alt="A subagent opened from GRAPH, with its Instruction tab showing the full instruction the main agent gave it" width="734">

### Stay in control while it runs

**YOU** collects approvals, decisions, and checks on your machine, each linking back to where it was asked in CHAT. Resolved items fold into one line, and a decision or check you no longer need can be dismissed. Decisions appear as cards with options, pros and cons, a recommendation, and the default if you do not answer. By default, LAISORA asks Claude to keep its plan up to date and to present decisions and checks this way.

Approve or deny tool requests in CHAT. Send additional instructions during a turn, interrupt, search within the conversation (Ctrl+F), and choose the model, reasoning effort, and permission mode beside the message box. The model chip shows the effort Claude Code actually applies. Enter sends and Shift+Enter inserts a new line; swap them with `laisora.composer.sendKey` or on the settings page.

When the claude.ai usage limit stops a conversation, LAISORA can resume it automatically after the limit resets. This is the same setting Claude Code uses in the terminal, so changing it on the LAISORA settings page changes it there too.

### Choose who the agent can delegate to

With agent orchestration turned on, the agent roster on the LAISORA settings page lets you set worker, explorer, and reviewer roles, with a model and effort for each. Codex and Antigravity can be used as external executors when their CLIs are installed. Roster changes apply from the next session.

### Keep instruction files and memory current

LAISORA tells Claude where knowledge belongs, refuses notes about specific models in CLAUDE.md, rules, and auto memory, keeps subagents from changing instruction, settings, and hook files, and checks memory writes. You can turn this off to let Claude Code write these files as it normally does.

### Carry long work forward

Hand off an idle conversation to a new session that starts from a summary and the user messages captured since the previous handoff, while the original is preserved. The continuation starts with its summary card and carries recorded decisions forward. You can also export a conversation to Markdown.

Follow file links in replies to a location in the editor. Within the workspace and the conversation folder, Office documents, PDFs, and other file types you choose open in their default app, and folder links open in the file manager. Files outside the workspace and the conversation folder open only if you allow it in user settings, and then after confirmation in a read-only editor by default. Network shares (UNC paths) and device paths are always refused.

### More

- A ToDo list kept on this PC and shared by all windows, which Claude can add to and update (Beta, off by default).
- Your own name in place of YOU, and an accent color.
- Background updates, while no turn is running, of a natively installed Claude Code, the standalone Codex CLI, and the Antigravity CLI installed by its own installer.

## Requirements

- Claude Code installed and signed in with your own account. If your Claude Code uses a JavaScript entry point, Node.js is also required.
- VS Code in a local, trusted window. WSL, Remote SSH, Dev Containers, untrusted workspaces, and virtual workspaces are not supported.

Windows is the tested platform. macOS and Linux have not been verified yet.

## Install and open

Install **LAISORA** from the Extensions view in VS Code (Visual Studio Marketplace). Open it from the LAISORA icon in the activity bar or run **LAISORA: Open** from the command palette.

The interface is available in English and Japanese; some diagnostic messages remain in Japanese.

## Settings

The LAISORA settings page opens from **Settings** in the ☰ menu of a conversation or with **LAISORA: Open Settings**. Every LAISORA setting is also listed in VS Code Settings under `laisora.*`, with its description. The automatic resume after a usage limit is Claude Code's own setting, so it is not among them.

## Claude Code behavior

### Authentication and API keys

By default LAISORA passes the environment through: if `ANTHROPIC_API_KEY` is set, Claude Code uses it and usage is billed to the API rather than your subscription, and LAISORA tells you so in the conversation. Set `laisora.claude.apiKeyPolicy` to `subscriptionOnly` (user setting, also on the settings page) to remove the key from the launched Claude Code process and use your signed-in subscription. Other inherited Claude Code or Anthropic environment variables and settings can affect authentication and the endpoint.

If Claude Code cannot be found, set `laisora.claude.executablePath` in your user settings. A workspace cannot supply this setting.

### Model, effort, and permission mode

The model you choose is saved in the shared `~/.claude/settings.json` and affects later Claude Code sessions. Effort is saved per model so new sessions start with it; `max`, and models without a known settings key, stay session-only.

Changing the permission mode in LAISORA does not rewrite Claude Code's shared default. LAISORA remembers the mode you chose, except `bypassPermissions`, which is never carried into future sessions. That mode allows file edits and commands without the usual permission prompts.

### Handoff and additional instructions

Handoff uses model capacity, and a summary can omit or misread details, so check important requirements when you continue. An instruction sent during a turn is delivered at Claude Code's next execution boundary; it does not guarantee an immediate change in behavior.

### History, data, and model use

LAISORA reads Claude Code's local session records to show history and work logs, and saves its state and analysis results locally in its VS Code extension storage. Chat, LLM analysis, summaries, and handoff send the content they need through Claude Code and use your account's capacity. Work-log figures are computed locally without calling a model.

LLM findings are model interpretations. Passing citation and numeric checks does not make the overall judgment correct; inspect the evidence behind a finding.

Your Claude Code settings, hooks, and configured tools affect execution and external connections, as they do when you use Claude Code directly. Logs and saved diagnostics can contain conversation content; review them before sharing.

### Troubleshooting

- **Cannot start a conversation:** run `claude` in a terminal and check that it starts and is signed in. Then see **View → Output → LAISORA**.
- **No working directory:** open a folder or set `laisora.defaultCwd`. A session resumes in the folder where it was started; if the project has moved, restore that path or start a new conversation.
- **Usage limit or analysis failure:** check the reported error and your Claude account. A failed analysis is not a clean bill of health for the session.
- **An instruction did not take effect immediately:** read the continuing conversation before resending it. Delivery and the model's response are separate steps.

## How LAISORA came about

LAISORA itself is developed through conversations with Claude Code, Codex, and Antigravity. It grew out of a challenge I met during development: being unable to keep up with the AI's work logs.

## License

[MIT](LICENSE).
