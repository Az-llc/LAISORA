# Changelog

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
