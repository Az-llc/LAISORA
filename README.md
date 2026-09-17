<p><img src="media/laisora-wordmark.png" alt="LAISORA" width="360"></p>

English | [日本語](README.ja.md)

An AI agent runs command after command and rewrites code. Watching the log does not necessarily tell you what it is doing or why. I have found myself in that position more and more often.

I wanted the everyday view to focus on the conversation: what I want to achieve and how to move forward. When I need the details, I can ask the agent to explain or open the execution log. LAISORA is a VS Code extension built around that way of working.

Commands and file operations appear in a separate Status view, making your instructions and the agent's replies easier to follow in Conversation. The two screenshots below are the same turn: first the Conversation view, then the Status view with the commands it ran, the files it read and edited, the tests, and the subagent.

<img src="media/screenshots/conversation.png" alt="The Conversation view shows the agent's summary with file links; the linked file is open in the editor beside it" width="734">

<img src="media/screenshots/execution-log.png" alt="The Status view's execution log for that turn, with the subagent card expanded to show the report it sent back to the main agent" width="734">

## Turn work logs into improvements for the next task

The finished result does not always reveal where the agent struggled or repeated itself along the way. Reading through a long log yourself is not easy either.

LAISORA uses an LLM to analyze work logs and suggest improvements to the workflow, instructions, and settings. Follow a suggestion back to the records behind it, then start a new conversation to act on the improvements you agree with.

**Bring advances in LLMs into everyday use.**

Analysis uses the model selected for the conversation, so the capabilities of newer models can also support reviewing the work and suggesting improvements.

<img src="media/screenshots/llm-analysis.png" alt="LLM analysis findings with links to the records they are based on" width="734">

## What you can do

### Run several conversations side by side

Each conversation is a tab (20 by default; `laisora.tabLimit`). Tabs keep their own draft, view selection, and scroll position, and a tab stays lit while its subagents or background commands are still running, even after the main reply has finished. Open past sessions from the history list and resume them in the folder where the conversation was started, even if commands changed directory along the way. By default, LAISORA reopens the tabs that were open when the window was last closed or reloaded; turn off `laisora.restoreTabsOnStartup` to start with a single new tab (also available on the LAISORA settings page, which you open from **Settings** in the ☰ menu of a conversation or with **LAISORA: Open Settings**).

### Read the reply without the noise

Every tab has two views: **Conversation** and **Status**.

The Conversation view primarily shows what the model says to you, along with approval requests, failures, and relevant system notices. Tool activity — shell commands (Bash, PowerShell), file reads and edits, searches, subagents, TODO lists — is routed to the Status view instead, so a long run of commands does not break a reply into pieces. When a turn that used tools finishes, the Conversation view shows a short "✓ Work completed · N tools · elapsed" chip that jumps to the matching place in the execution log.

### See what the agent is actually doing

The Status view has four sub-tabs:

- **Summary** — the request blocks in the session, subagents and background commands that are still running, and the time split into model generation, tool execution, waiting for your answer to a question, and waiting for your next message.
- **Graph** — a timeline of the main agent, its subagents, and background tasks, with a zoomable time window. Open a subagent to read the full instruction it was given.
- **Analysis** — script-based statistics and findings (failure rate, failure loops, subagent ratio, turn duration) compared against your own past sessions, and optional LLM analysis whose findings link back to their evidence.
- **Execution log** — tool calls with the available input and output previews, duration, and marks for failures and convention violations.

Some information may be unavailable when session records are incomplete; the views say so instead of showing partial numbers as complete.

The two screenshots below show the graph, then the instruction given to a subagent opened from it.

<img src="media/screenshots/graph.png" alt="The Graph sub-tab: a timeline of the main agent and its subagent" width="734">

<img src="media/screenshots/subagent-instruction.png" alt="A subagent opened from the graph, with its Instruction tab showing the full instruction the main agent gave it" width="734">

### Stay in control while it runs

Approve or deny each tool request from the Conversation view. If you are looking at the Status view when an approval arrives, the Conversation tab is highlighted so you do not miss it. Send additional instructions during a turn, interrupt, search within the conversation (Ctrl+F), and choose the model, reasoning effort, and permission mode from the controls beside the message box. Enter sends and Shift+Enter inserts a new line; swap them with `laisora.composer.sendKey` or on the LAISORA settings page.

### Carry long work forward

Hand off a conversation to a new session using a summary and captured user messages, while preserving the original. Export a conversation to Markdown. Open supported Markdown file links at a specified location in the editor, within the workspace or session directory boundary. Files VS Code cannot show as text, such as images, open in their default editor. When LAISORA is open in an editor tab, the linked file is also selected in Explorer (`laisora.fileLinks.revealInExplorer`); links clicked in the side bar leave the side bar showing the conversation. By default LAISORA asks Claude to write local files as such links (`laisora.claude.fileLinkInstruction`; takes effect when a conversation is started or resumed, not in a running one, because changing the system prompt mid-conversation would make the next reply resend the whole conversation). To open links to files outside the workspace, turn on `laisora.fileLinks.allowOutsideWorkspace` (user setting); such files open after a confirmation and in a read-only editor unless you turn off `laisora.fileLinks.confirmOutsideWorkspace` or `laisora.fileLinks.openOutsideReadOnly`. Network shares (UNC paths) and device paths are always refused and never become links. These settings are also on the LAISORA settings page.

## Supported SDKs

| SDK | Status |
| --- | --- |
| Claude Agent SDK | Supported through a local Claude Code installation. |
| Codex SDK | Planned. Not available in the current version. |

## Requirements

- VS Code 1.90 or later, running in a local, trusted window.

Windows is the tested platform. macOS and Linux have not been verified. WSL, Remote SSH, Dev Containers, and virtual workspaces are not supported.

## Install and open

Install the supplied `.vsix` file using **Extensions: Install from VSIX…** in the VS Code command palette, then reload the window. Open LAISORA from the activity bar or run **LAISORA: Open** from the command palette.

Before starting a conversation, open a project folder or set the default working directory.

The main interface supports English and Japanese; some diagnostic messages remain in Japanese. The README language links above let you choose the documentation language.

## LAISORA settings

The send shortcut, tab restore, API key handling, and file links are on the LAISORA settings page (**Settings** in the ☰ menu of a conversation, or **LAISORA: Open Settings**). For other settings, such as the tab limit, default working directory, and work-log analysis, search for `laisora.*` in VS Code Settings. Extension preferences and UI state are saved in VS Code.

## SDK-specific setup and behavior

### Claude Agent SDK

#### Setup and authentication

- Claude Code installed and signed in with your own account. By default LAISORA passes the environment through: if `ANTHROPIC_API_KEY` is set, Claude Code uses it and usage is billed to the API rather than your subscription, and LAISORA posts a notice in the conversation; set `laisora.claude.apiKeyPolicy` to `subscriptionOnly` (user setting, also switchable on the LAISORA settings page) to remove the key from the launched child process and use the signed-in subscription. Other inherited Claude Code or Anthropic environment variables and settings can affect authentication and the endpoint.
- Node.js if your Claude Code installation uses a JavaScript entry point. It is not required by the extension when it resolves a native Claude executable.

If Claude Code cannot be found, set `laisora.claude.executablePath` in your user settings to the executable or JavaScript entry point. This setting cannot be supplied by a workspace.

#### Settings and permissions

Choose a model and effort level from the conversation view. Model selections are saved in the shared `~/.claude/settings.json` and affect subsequent Claude Code sessions. Effort is saved per supported model, including 1M-context variants such as Opus 1M, so new sessions start with it; `max` and selections without a known settings key remain session-only.

The effort display distinguishes runtime-reported, requested, and configured values. The applied value follows Claude Code's setting precedence and model capabilities.

Permission mode changes in LAISORA do not rewrite Claude Code's shared default permission mode. The extension saves the selected mode except for `bypassPermissions`, which is not saved for future sessions. Choosing that mode allows file edits and commands without the usual permission prompts.

#### Long conversations and intervention

Start a manual handoff when the conversation is idle. LAISORA preserves the original session and opens a continuation using a summary and user messages captured since the previous handoff. Older context is carried through existing summaries and handoff records. Handoff uses model capacity. A summary can omit or misinterpret details, so check important requirements when continuing.

You can send an additional instruction while a turn is running. Delivery depends on the Claude Code execution boundary; it does not guarantee an immediate change in behavior.

Live Guardrail detects patterns such as repeated failures and records them in Output. Automatic intervention defaults to warnings; settings can allow reports to be sent to the running agent. It does not automatically interrupt execution, detect stagnation while a tool is running, or monitor all background processes.

#### History, data transmission, and model use

LAISORA reads Claude Code's local session records to show history and work logs, and saves extension state and analysis results locally. Analysis results are stored as one local file per run in LAISORA's VS Code extension storage and can include generated findings and evidence labels. Chat, LLM analysis, summaries, and handoff send the content needed for the operation through Claude Code and use your account's available capacity. Displaying work-log statistics does not invoke an LLM.

LLM findings are model interpretations. Passing citation and numeric checks does not establish that the overall judgment is correct. You can inspect the evidence behind a finding.

Your Claude Code settings, hooks, and configured tools can affect execution and external connections. Review them as you would when using Claude Code directly. Logs and saved diagnostics can contain conversation content; review them before sharing.

#### Troubleshooting

- **Cannot start a conversation:** run `claude` in a terminal and check that it starts and is signed in. Then inspect **View → Output → LAISORA** for details.
- **No working directory:** open a folder or set `laisora.defaultCwd`. Resuming a session uses the folder where it was started; moving a project may require restoring that path or starting a new conversation.
- **Usage limit or analysis failure:** check the reported error and your Claude account availability. A failed analysis is not a clean bill of health for the session.
- **An instruction did not take effect immediately:** inspect the continuing conversation before resending it. Delivery and the model's response are separate steps.

## How LAISORA came about

LAISORA itself is developed through conversations with Claude Code, Codex, and Antigravity. It grew out of a challenge I encountered during development: being unable to keep up with the AI's work logs.

## License

[MIT](LICENSE).
