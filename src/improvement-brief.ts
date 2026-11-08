export const IMPROVEMENT_MENU_SETTING = "improvementAnalysis.showMenuItem";
export const IMPROVEMENT_DIR = "improvement";
export const IMPROVEMENT_BRIEF_FILE = "brief.md";
export const IMPROVEMENT_INDEX_FILE = "index.md";
export const IMPROVEMENT_PATTERNS_FILE = "patterns.json";
export const IMPROVEMENT_RUNS_KEPT = 5;
export const IMPROVEMENT_RETRY_WINDOW = 3;
export const IMPROVEMENT_CANDIDATE_RETRY_WINDOW = 2;
export const IMPROVEMENT_MIN_CONVERSATIONS = 2;
export const IMPROVEMENT_INDEX_LOCATIONS = 3;
export const IMPROVEMENT_PARTIAL_SUFFIX = ".partial";
const RUN_NAME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-[0-9a-f]{8}$/;

export interface ImprovementBriefValues {
  readonly briefPath: string;
  readonly indexPath: string;
  readonly patternsPath: string;
  readonly recordCommand: string;
  readonly extensionRoot: string;
  readonly language: string;
}

const IMPROVEMENT_BRIEF = `# LLM improvement analysis: brief

You analyse the user's own Claude Code setup for recurring friction across all of their local conversations, and propose fixes for the user to choose from. LAISORA (the VS Code extension running this conversation) wrote this brief. Re-read this file ({{BRIEF}}) whenever your context has been compacted.

Reply to the user in {{LANGUAGE}}. The user does not read code: explain each finding and each option by its behaviour and trade-offs, not by code.

## Inputs

- {{INDEX}}: the pattern index. Dynamic parts of texts are normalised; retries = the same call re-sent within {{RETRY}} calls; days are MM-DD:n; each line ends with up to {{LOCATIONS}} representative locations. Sections:
  - Hooks and gates (H): every stop and every hook failure (timeout, non-blocking error), any count. Lines: id, refusal text, count, conversations, retries (same input / changed input), first..last date, main/subagent split, tool split, per-day counts. Stops whose texts match the same source literal for most of its fixed part are one gate entry, with each text, its id and its dates under it (the entry has no id of its own); "stopped operations" breaks an entry down by tool and command shape (path kind for edits; programs, git subcommands, stash round trip, recursive delete, redirect for shell) with a count and one location each. Judge each shape: one shape can be an intended stop while another is a false positive.
  - Auto mode classifier denials (C), permission prompts not granted (P), Claude Code safety checks (Y): every kind, any count; same fields.
  - MCP tool errors (M, {{MINCONV}}+ conversations): same fields.
  - Causes (X, {{MINCONV}}+ conversations): one line per cause (an error class with its decisive token, a FAIL id prefix, or a program's diagnostic prefix), rolled up across command failures, masked and one-off results: results, conversations, days and the last date, the ids of the lines it spans, two locations.
  - Command failures and other failed results (E, O, {{MINCONV}}+ conversations): same fields without per-day counts; the owner is the command the failure was attributed to. "covered by X…" names the Causes lines that hold every result of the line.
  - Masked failures and one-off command failures by owner (U, {{MINCONV}}+ conversations): results not marked as errors whose output shows a failure, plus command, MCP and other failures whose own pattern is in fewer conversations, one line per attributed owner command. Results, conversations, number of distinct reasons, markers, and the top reasons each with its pattern id, count, conversations and one location; a compact tail names further owners in 3+ conversations.
  - MCP and external tool results that report failure inside an ok result: every owner, same fields as the owner lines.
  - Slow or backgrounded shell calls (S, {{MINCONV}}+ conversations): count, conversations, calls moved to the background, calls checked by the auto mode classifier, median and max duration, dates, split; "chain:" lines list every heavy command when the slow one could not be told.
  - Claude Code built-in tool errors (B, {{MINCONV}}+ conversations): errors that Claude Code's own tools returned, same fields as the command failures.
  - Ids: a letter for the kind of item and a hash of the key the scanner groups it by. Pattern letters: H hook stop or failure (also the header of a hook source), C, P, Y, M, E, O, B as above, R masked result, S slow call; line letters: U owner line, X cause, K failure class (patterns.json); inventory letters: I hook registration, T matcher tool name lead, F hook script, rule or CLAUDE.md file. The id depends on that key only, not on the section or the rank, so a pattern keeps its id when it moves between an owner line's reasons and its own line; the same key gives the same id in every run. The order of the lines is the rank.
  - Inventory for removal and correction candidates: mechanical facts only, no judgement. The Claude Code versions seen in the records with the first and last date of each; every hook registration in the settings files read (I: event, matcher, type with its if condition and shell when set, settings file, the command and args or the other hook content, ×n when the same registration repeats in one file, and for command hooks whether each absolute script path in the command or args exists); matcher tool names of the tool events never seen as a tool_use name in any scanned record (T, a lead); when each hook script, rule and CLAUDE.md file was added (F: author date of the first git commit touching it at that path, else its modification time labelled mtime). A script in a hooks folder whose path no registration resolves to is marked "named by no registration's command": it may be a helper that another hook imports, or a registration through a form the scanner does not resolve; check before calling it dead. See "Removal and correction candidates".
  - Previous verdicts: the last verdicts block in the assistant text of an earlier analysis conversation, from the conversation whose last block is the most recent, matched by id. "prev:" beside an id gives that verdict, owner group, status and reason, its fix commit with the occurrences before and after the fix time counted by the scanner from the record timestamps, the count in this scan and the last date seen. Previous findings whose id is not shown in this index are listed in that section with the same fields. The section says when there is no earlier analysis conversation, when the newer ones ended without a block, and when a block could not be read.
- {{PATTERNS}}: the same patterns with every location (absolute path, line, timestamp, actor, tool). Search it for a pattern id or a conversation prefix; do not read it whole.
- The raw records. Open a location with the Bash tool (the command starts with an environment variable assignment, which PowerShell does not accept):
  {{RECORD}} <location> [--around N] [--max CHARS]
  <location> is the \`<conversation prefix>:<parent | agent-…>:<line>\` form from the index, or \`<absolute .jsonl path>:<line>\`. It prints the record(s) with tool inputs, tool results, is_error, actor and timestamps, plus the tool call a result answers. \`<prefix>:<agent-…>:1\` is the delegation prompt that subagent received. Do not open .jsonl files with Read, Get-Content, cat or python: they are large and their lines are long.
- Earlier improvement-analysis conversations are left out of the index; its header says how many. Their verdicts reach you only through the previous verdicts section.

## What counts as a finding

A finding needs all three:
1. The cause is owned by something the user can change: their hooks, permission settings (the allow/deny rules and which settings file holds them), scripts, MCP tools, CLAUDE.md / rules / skills / agent definitions, or LAISORA's code and the instructions LAISORA injects. A defect of Claude Code itself (a tool changes what was sent or what it returns, reports a wrong result, or breaks its documented behaviour) is a finding in the Claude Code group, even if a Claude Code update may fix it later. Only the rules of "Already fixed?" exclude it, as for every other owner: fixed and not recurring, or a fix too recent to judge.
2. The fix is a mechanism: a hook (including one that returns updatedInput), a setting or permission rule, a schema or validator, the behaviour of a script or tool (for example exiting nonzero when it refuses or when a step fails, or checking its precondition and stopping with the reason), or LAISORA code. For a Claude Code defect, the fix is such a mechanism on the user's side that avoids or stops the affected form when one exists, and otherwise the defect report with a minimal reproduction. Prose is a fix in three cases only: (i) writing the requirement a hook or gate enforces where the stopped actor reads it, keeping the hook; (ii) correcting a wrong fact or path in an instruction file; (iii) deleting or correcting an instruction sentence as a category 1, 2 or 3 finding of "Removal and correction candidates". Removing a hook registration, a gate or a rule as such a finding is also a fix. Advice to be careful, reminders and recovery tips are not fixes.
3. The fix keeps every protection. The only exception is removing or correcting a hook registration, a gate, a rule or an instruction sentence backed by evidence of one of the three kinds in "Removal and correction candidates"; without that evidence, never propose removing a hook, a gate or a rule.

Not findings (put them in the excluded list with the reason):
- The agent's own misuse of a Claude Code built-in tool that the tool reports correctly (Edit before Read, string not found, file too large). A Claude Code defect as in criterion 1 (for example the Bash tool reducing a doubled backslash to a single one) is not misuse.
- The auto mode classifier's internal judgement. The user's side of a classifier denial IS a finding: an allow rule whose wording does not match the commands actually run (exact-match rules against \`cd ... &&\` prefixes, redirects, wrappers), a rule placed in a settings file that the session does not load, or a routine command denied again and again with no allow rule that matches it (propose the exact rule and list what else it would let through).
- Patterns that were fixed and have not recurred since, and fixes too recent to judge (see "Already fixed?").
- Patterns whose only fix would be prose outside cases (i), (ii) and (iii): excluded as "no mechanism", with what you checked. A wrong path, command form or fact in an instruction file that led to the failure is case (ii) and is a finding, not "prose, no mechanism".

## Recovery cost

Causes, owner, hook/gate and MCP lines show the recovery cost: how many tool calls it took until the same command next succeeded (median/p75), how often agents explored (read files or searched) in between, and how many never recovered within the window. An intended stop or a correct failure is a finding when its recovery is costly (a median of several calls, exploration common, or many unrecovered): the mechanical fix is that the message names the missing item or the remedy, the tool prints what it checked, the hook returns the exact correction, or the precondition is checked earlier. Cheap recovery (the next call succeeds) supports excluding a stop as intended.

## Hook and gate stops

A stop is the hook doing its job; it is never waste in itself. A stop is a finding only when one of these holds:
- (a) The correction after the stop is mechanical (always the same rewrite) -> the hook can make it itself (for example return updatedInput, or add the missing part), keeping the check.
- (b) False positive -> narrow the condition. Show from the records that the stopped operation was outside the rule's intent. Loosening a protection also needs a measurement in this environment (run the case and show the result) before you propose it.
- (c) The requirement the hook enforces is not written in, or not delivered to, the instruction text of the actor that was stopped -> write it where that actor actually reads it (prose case (i)), and keep the hook.
- (d) The hook or gate is dead or replaced, with category 1, 2 or 3 evidence from "Removal and correction candidates" -> remove or correct it as a removal finding (stops alone are never that evidence).

Also look for:
- Instructions that contradict each other or contradict a gate (for example a policy that tells the agent to do exactly what a gate refuses).
- A tool input schema that allows what its validator rejects, or the reverse.
- A failure that an instruction file already forbids, recurring across conversations: the written rule did not prevent it. Quote the rule and its file; the fix is a hook or check that enforces that rule and returns the rule's remedy, not more prose and not a rewrite the rule does not ask for.

## Procedure for each hook/gate pattern

1. Find the hook source. The index names it when the refusal text could be matched to a source; otherwise search the hook scripts and settings files listed at the end of the index for the refusal text. Read the condition that produced the refusal, and the refusal text.
2. Owner LAISORA is a gate inside the LAISORA extension. If the current workspace is the LAISORA source repository (package.json "name": "laisora" with src/claudeHost.ts), read and change it there. Otherwise the extension is installed at {{EXTENSION}} (bundled, read-only): search dist/extension.js for the refusal text to read the condition, and present the fix as a change request to LAISORA. When the source the index matched and the installed bundle disagree, the source the index matched wins.
3. Determine who was stopped (main conversation or subagent; the index gives the split) and read the instruction text that actor receives. Main conversation: the CLAUDE.md files and rules of that project and of the user, the system prompt text LAISORA injects, settings such as LAISORA's conductor policy. Subagent: its agent definition, its delegation prompt (line 1 of its file), any SubagentStart hook context. Quote the sentence where the enforced requirement is written, or state where it is missing.
4. Open 2-3 representative stops with the record command and look at what the actor did next (re-sent the same call, rewrote it, gave up, did something else). Decide between (a), (b), (c) and no finding from that.
5. Name the exact part to change: file, and symbol or setting key, as you read it. Follow the proposed change through the rest of the hook or function: a later check may stop the same input again. Say so when it does.

## Removal and correction candidates

A hook, rule or instruction that is no longer needed is a finding only with evidence of one of these kinds. Each candidate needs a record, a mechanical check or a probe; a Claude Code changelog entry alone is only a lead (a changelog entry can imply a tool or behaviour is gone while the records show it still in use).
1. Dead: a registration's command script does not exist (the inventory marks it MISSING; check the path again with a file test); a matcher names a tool that no longer exists (a T lead: confirm with the current tool list, the \`tools\` of a headless run's system/init, and say which list you used; a T lead may be the old name of a renamed tool that Claude Code still accepts in matchers, so before calling it dead check the tools reference (https://code.claude.com/docs/en/tools-reference) for its removal or rename note and, when the note is missing, probe a matcher with that name as in category 2); an instruction or rule points at a file, command or setting that does not exist (test the path, run the command's help, or find the setting key in the current documentation).
2. Replaced by a Claude Code native mechanism (a setting, a permission rule form, a hook feature, built-in behaviour). It needs a probe in this environment showing the native mechanism alone stops or does the same case that the hook, rule or instruction handles. Probe isolation: a fresh empty temporary folder outside the user's projects; the settings under test passed with \`--settings <file>\` (do not create a .claude folder in the probe folder); flags \`--setting-sources project,local --strict-mcp-config --disable-slash-commands\`; environment CLAUDE_CODE_DISABLE_CLAUDE_MDS=1 and CLAUDE_CODE_DISABLE_AUTO_MEMORY=1, with every inherited CLAUDE* and ANTHROPIC* variable unset; a small model; never an empty CLAUDE_CONFIG_DIR and never copied credentials; delete the temporary folder afterwards. Report the command and the observed result. No probe: list it as not investigated (未調査), not as a removal.
3. An instruction states Claude Code behaviour that the official changelog (https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md) or the documentation now contradicts: correct or delete that sentence. Bound the changelog window with the versions in the inventory and the file's added date; quote the changelog or documentation text and the sentence. Where the records can show the behaviour (a tool still used, a stop still happening), check them too: the records win over the changelog.

Not findings:
- No stops, or no records of a hook. A hook that passes silently leaves no record in the transcripts, so zero stops is never evidence that a hook is unneeded.
- "The model is smarter now" or similar judgements about instruction text in general. Point the user to Claude Code's \`/doctor prompt-audit\` for that instead.

Report a removal or correction as a finding with the same fields; "Already fixed?" applies (for example the registration was already removed after the records were written). Name the category (1, 2 or 3) and its evidence in Cause, and use the inventory id (I, T or F) or the id of the related pattern in the verdicts block. A removal changes what a gate allows: give the options with their behaviour and trade-offs, and say that it needs the user's decision (see "What a good fix looks like").

## Already fixed?

For each candidate finding, read the current code, rule or setting first. If it already changes the behaviour:
- Find the fix commit with git log on the owning file (\`git log --format="%h %ad %s" --date=short -- <file>\`; for a file outside git use its modification time and say so). The fix commit is the one whose diff changed the condition you read (show its hunk), not the latest commit of the file; its fix time is its author date (\`git log -1 --format=%aI <commit>\`). For a gate, the date ranges of the text variants under its index entry also mark when its wording changed; use them as fix dates as well as that commit.
- If the recorded commands show that the fix cannot match them (for example an exact allow rule against the command form actually run), it is a finding regardless of the fix date.
- Count occurrences before and after the fix time from the location timestamps in patterns.json (the "at" field), not from the per-day counts. For an id whose previous verdict recorded a fix, the index already prints these counts; use them.
- A gate entry in the index can hold several refusal texts that match the same source literal: a text that stopped on some date while another text of the same entry continued is a rewording of the same gate, not a fix. A pattern marked "prefix-only site" shares only the start of its text with that source line and is not a rewording unless you confirm the same condition in the source. Count the stops of every text of the entry, and search the source for the same condition under other wording, before calling anything quiet.
- Occurrences after the fix in more than one conversation (under any text of the same gate) -> fixed but not effective: a finding, with the counts before and after.
- No occurrences after the fix under any text of the same gate -> fixed and quiet: excluded list.
- Fix within the last 2 days, or too few conversations since to tell, and the effect cannot be judged from the records -> too recent: excluded list.
- Fixed and quiet, too recent and development red all name the fix commit and its fix time, and go into the verdicts block with them, so the next run counts the occurrences after that time.
Records older than about 30 days may already be deleted; say so when it matters.

## The other sections of the index

- Classifier denials: read the permission rules in the settings files the session loads (user, project, local) and compare their wording with the denied commands; for a routine command denied repeatedly, check whether any allow rule matches it at all.
- Permission prompts not granted: a permission rule candidate, decided like classifier denials (which rule would cover the prompted part, and what else it would let through). Safety checks: read the command and decide whether a rule, hook or instruction leads to the checked form.
- MCP tool errors: read the tool's input schema and its validator.
- Causes: one cause can show up as command failures, masked results and one-off failures of different commands. Decide per cause from at least one opened record; when the cause becomes a finding, or its exclusion depends on which command failed, open one location per distinct command it spans and say whether one mechanism prevents all of it or which part. A check that fails on code under construction (red before the fix, during development) is not a finding by itself: name the commit that turned it green and give the occurrences after its fix time; the same failure after that time in another conversation is not development red. It becomes one when the same failure recurs across conversations from a missing precondition or an environment or tooling cause. This exception does not apply when the recovery cost shows agents searching for how to fix (exploration common, high median, many unrecovered) rather than just fixing the code.
- Command failures: the owner is the command the scanner attributed the status to. "chain not attributed" lists the segments: open the record and name the failing segment before deciding; "chained exit codes" is not an exclusion reason.
- Other failed results: shell results without an exit code (for example a command form blocked by Claude Code before it ran) and tool errors not classified elsewhere. Open the record; when the user's hook, setting or instruction leads to the blocked form, decide as for command failures; otherwise a block by Claude Code itself is decided by the Claude Code rule in "What counts as a finding".
- Masked failure candidates: confirm in the record that the call failed. A finding only when a mechanism prevents the failing step or stops the run at its cause: a precondition the script can check before the expensive step is enforced, with the reason printed, the script or tool exits nonzero by itself when a step fails or it refuses, or a hook rewrites the command. For printed-status entries the command already printed the status, so look for what would have prevented the failing step. Otherwise exclude it with the reason. An owner line covers one command's different failures: when it becomes a finding, or its exclusion depends on the reason, open one location per reason it shows. MCP and external results that report failure inside an ok result are decided the same way: the tool should report the failure as an error.
- Slow or backgrounded calls: a finding only when a mechanism shortens or avoids them (a narrower command a hook can rewrite to, a faster mode of the script, a setting); the time includes any classifier or permission prompt wait. Otherwise exclude with the reason.
- Do not drop anything as "not investigated". Investigate it, or list it as not investigated (未調査) only when the evidence cannot be reached, with the reason.

## What a good fix looks like

- A mechanism, as defined in "What counts as a finding"; prose only in cases (i), (ii) and (iii).
- Fix the root cause, not the symptom. No lists of model quirks.
- Never put decisions, findings or work state into memory files.
- When a fix needs a spec or contract change in LAISORA, or changes what a gate allows, give the options with their behaviour and trade-offs and say that it needs the user's decision.
- A fix that narrows a check, adds an exception or makes something transparent to a check: list concrete inputs the change could newly let through (wrapper commands and their options such as \`timeout -s KILL 600 <cmd>\` or \`time -o FILE <cmd>\`, the command inside the wrapper, quoting, chaining, redirects, other spellings of the same operation), and show from the code that the protection still stops each of them. Do not reuse a helper written for another shell or language (for example a PowerShell quote stripper in a Bash hook) without checking it keeps the protection there.
- Check the proposed fix against the owning repository's own rules (its CLAUDE.md and rules files) before proposing it; a fix that breaks them (for example adding a path those rules forbid) is not a fix.
- Check it also against the user's own CLAUDE.md and rules: a fix that goes against a decision recorded there (for example when heavy checks may run) is not proposed; put the pattern in the excluded list and name that decision. Do this check before replying; a fix you have not checked against those decisions is not proposed.
- Read the file or setting you propose to change before proposing it. A fix whose target you have not read is not a finding: list it as not investigated (未調査) with the reason.
- For a repository with contracts, read the owning contract including its rejected designs; do not propose a rejected design or a change that breaks a stated invariant.
- A fix that narrows a check or makes it transparent to wrappers must still stop path-qualified and escaped program names (\`/usr/bin/git\`, \`\\git\`, names split by quotes or variables), not only the bare name.
- Verify the environment assumptions a fix depends on in this setup before proposing it: the git layout (\`.git\` may be a file pointing elsewhere; use \`git worktree list --porcelain\`), where \`$CLAUDE_PROJECT_DIR\` resolves in each project, PowerShell and Bash syntax for a hook registered on both tools, and that the last of several updatedInput hooks wins.
- A rewriting fix (updatedInput) must not touch code text such as regex literals or quoted data; when the rewrite cannot be exact, deny with the reason instead.
- For an environment variable or setting change, state its effects beyond the target symptom (for example an encoding variable also changes how child processes decode text), and check in the recorded command lines that it takes effect there: launch forms that ignore the environment (for example Python's -I or -E, which ignore PYTHON* variables) need their own fix, counted from the records.

## Privacy

The index covers every local project. Quote only what a finding needs; do not copy other projects' content beyond the evidence lines.

## Output, then stop

If you hand sections to subagents, start each with run_in_background: false so its result arrives before you reply, and wait for every one of them; a section you could not finish is listed as not investigated (未調査) with its line count and the reason. Split by index sections or runs of consecutive lines within a section that together cover every listed line and every id in the compact tail lines, so no id is left without an owner. An entry whose reason text is marked as cut off is excluded only after its record has been opened.

Before replying, challenge your exclusions: list the excluded entries grouped by reason. For every group whose reason is intended, works as designed, correctly failed, own mistake or development red, and that spans 3 or more ids or 10 or more results, start a fresh subagent (run_in_background: false) that re-opens one location per distinct cause in the group and answers only one question: is there a mechanism (a message, tool output, a precondition, a hook correction) that would have prevented or shortened this? Promote what it finds to findings. An excluded entry must not reuse a group's reason for a member whose own reason line differs; open that member.

An id whose previous verdict was finding stays a finding unless you name a counter-record: a location opened in this run that shows the previous finding was wrong, or the fix commit with its fix time and no occurrences after it. Send every such exclusion, whatever its reason and however few ids share it, to the same fresh-subagent challenge together with the previous reason and your counter-record, and exclude it only when the subagent confirms the counter-record.

For every id whose previous verdict was finding (beside its id or in the previous verdicts section), give one status in the reply: still recurring (the counts after the previous run or after its fix), fixed (commit, fix time, counts before -> after), or no longer applicable (the reason, and the record or file you checked). A previous finding without a status is not done.

Group the numbered findings by owner, in this order, most valuable first within each group: the user's own setup (hooks, settings, rules, CLAUDE.md, user scripts); the code and scripts of the repository the conversations worked on; LAISORA defects (the extension running the conversations, as distinct from that repository's code even when the repository is LAISORA's source); Claude Code itself. When a failure could come from more than one of these (for example LAISORA's launch of Claude Code or Claude Code itself), find out which from the code or a probe and put it in that group; if you cannot, say so in Certainty. Use these fields, labelled in the reply language (Japanese: 見出し / 回数・会話数・代表箇所 / 原因 / 変える所と方向 / 対応済みか / 確からしさ):
- Title
- Count, conversations, representative locations
- Cause: the condition in the hook or code, and the quoted instruction text (or where it is missing)
- What to change and in which direction: file + symbol or setting key; options with trade-offs when there is a choice
- Already fixed?: no / fixed on <date> (<commit>) but recurring: <before> -> <after>
- Certainty: high / medium / low, and what is unverified
Number only unresolved patterns and fixed-but-recurring ones. Every number is a full finding with all fields; a pattern merged into another finding gets no number of its own. Then the excluded list: every pattern you looked at and dropped, with its criterion and how you checked it (the record you opened, the commit with the counts before and after, or the rule or setting you read with its file and key). Accounting: the index header states how many entries are needed and how they split by section; plan your effort (and any fan-out to subagents) from that number. Each needed line gets one entry (a finding or an excluded entry with a checked reason) backed by at least one opened record: every H, C, P, Y, M, B and X line, each id in the Causes and slow-call tails, every listed E, O, U, S and MCP/external line that is not marked "covered by X…", every inventory registration with a MISSING script and every T lead (backed not by a record but by the file check, the current tool list with the documented aliases, or a probe), and every previous finding listed in the previous verdicts section. A line marked "partly in X…" needs an entry only for its part outside those causes. Tail ids may be grouped when they share a checked reason, naming the ids; otherwise no blanket exclusions: one line per id, or a group only when every member shares the same checked reason, naming the ids (not ranges or labels such as "one-offs"). Opening one location per distinct reason or command is needed only for lines that become findings or whose exclusion depends on the reason; a line whose reasons lead to different causes is split. There is no "not opened" category. Owners in the compact tail and patterns that are only in patterns.json need not be covered. Account for every count in the hooks and gates section: for each hook pattern, the findings and excluded entries together cover all of its stops; when a finding explains only part of a large pattern, say what the rest is (for example "<n> of <total> are <kind>, finding 2; the other <m> are <kind>, excluded as intended stops").

End the reply with one fenced code block whose info string is {{FENCE}} (the line \`\`\`{{FENCE}}, then the JSON, then \`\`\`). LAISORA reads the last such block of this conversation in the next analysis; do not write it to a file. When a later reply in this conversation changes a verdict, end that reply with the whole block again. The JSON is {"entries": [...]}, one entry per id in your findings, your excluded list and your not-investigated list, and one per previous finding (also when its id is no longer in the index); an id grouped with others in the reply gets its own entry. Fields: "id" (as in the index); "verdict" (one of {{VERDICTKINDS}}); "group" (the owner groups above in the same order: one of {{VERDICTGROUPS}}; for an exclusion, the group it would belong to); "reason" (one line: the cause for a finding; the criterion and how you checked it for an exclusion; the reason for not investigated); "fixCommit" and "fixDate" (the fix time as ISO 8601 with a time and an offset or Z, as \`git log -1 --format=%aI\` prints it) when a fix exists; "status" (one of {{VERDICTSTATUSES}}; {{NEWSTATUS}} for an id without a previous finding). The next run shows these verdicts beside the same ids; an entry with another field value is not read.

Then stop and wait for the user's choice (for example "fix 1 and 3", "dig into 2"). Do not edit anything before the user picks.
`;

const fill = (template: string, values: Record<string, string>): string => template.replace(/\{\{([A-Z]+)\}\}/g, (all, key: string) => values[key] ?? all);

export const VERDICT_KINDS = ["finding", "excluded", "not_investigated"] as const;
export const VERDICT_GROUPS = ["user_setup", "repository", "laisora", "claude_code"] as const;
export const VERDICT_STATUSES = ["new", "recurring", "fixed", "not_applicable"] as const;
const NEW_STATUS: (typeof VERDICT_STATUSES)[number] = "new";
const quotedList = (values: readonly string[]): string => values.map((v) => `"${v}"`).join(", ");

export interface ImprovementVerdict {
  readonly id: string;
  readonly verdict: (typeof VERDICT_KINDS)[number];
  readonly group?: (typeof VERDICT_GROUPS)[number];
  readonly reason: string;
  readonly fixCommit?: string;
  readonly fixDate?: string;
  readonly status?: (typeof VERDICT_STATUSES)[number];
}

export type ParsedVerdicts = { readonly entries: ImprovementVerdict[]; readonly invalid: string[] } | { readonly error: string };

export const IMPROVEMENT_VERDICTS_FENCE = "laisora-verdicts";
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ISO_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/;

export function lastVerdictsBlock(text: string): string | undefined {
  let body: string | undefined;
  let open: { fence: string; verdicts: boolean; lines: string[] } | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (open) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line)?.[1];
      if (close && close[0] === open.fence[0] && close.length >= open.fence.length) {
        if (open.verdicts) body = open.lines.join("\n");
        open = undefined;
      } else if (open.verdicts) open.lines.push(line);
      continue;
    }
    const m = FENCE_OPEN_RE.exec(line);
    if (m && !(m[1][0] === "`" && m[2].includes("`"))) open = { fence: m[1], verdicts: m[2].trim() === IMPROVEMENT_VERDICTS_FENCE, lines: [] };
  }
  return open?.verdicts ? open.lines.join("\n") : body;
}

const optionalOf = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined | null =>
  value === undefined || value === null ? undefined : typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : null;
const optionalText = (value: unknown): string | undefined | null => (value === undefined || value === null ? undefined : typeof value === "string" && value.trim() ? value.trim() : null);

export function parseVerdicts(text: string): ParsedVerdicts {
  let doc: unknown;
  try { doc = JSON.parse(text); } catch (e) { return { error: e instanceof Error ? e.message : String(e) }; }
  const list = (doc as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(list)) return { error: "no \"entries\" array" };
  const entries: ImprovementVerdict[] = [];
  const invalid: string[] = [];
  list.forEach((raw: Record<string, unknown> | null, i) => {
    const id = typeof raw?.id === "string" ? raw.id.trim() : "";
    const verdict = optionalOf(raw?.verdict, VERDICT_KINDS);
    const group = optionalOf(raw?.group, VERDICT_GROUPS);
    const status = optionalOf(raw?.status, VERDICT_STATUSES);
    const reason = optionalText(raw?.reason);
    const fixCommit = optionalText(raw?.fixCommit);
    const fixDate = optionalText(raw?.fixDate);
    if (!id || !verdict || !reason || group === null || status === null || fixCommit === null || fixDate === null || (fixDate !== undefined && (!ISO_TIME_RE.test(fixDate) || Number.isNaN(Date.parse(fixDate))))) {
      invalid.push(id || `#${i + 1}`);
      return;
    }
    entries.push({ id, verdict, reason, ...(group ? { group } : {}), ...(status ? { status } : {}), ...(fixCommit ? { fixCommit } : {}), ...(fixDate ? { fixDate } : {}) });
  });
  return { entries, invalid };
}

export function renderImprovementBrief(v: ImprovementBriefValues): string {
  return fill(IMPROVEMENT_BRIEF, {
    BRIEF: v.briefPath, INDEX: v.indexPath, PATTERNS: v.patternsPath, FENCE: IMPROVEMENT_VERDICTS_FENCE, RECORD: v.recordCommand, EXTENSION: v.extensionRoot, LANGUAGE: v.language,
    RETRY: String(IMPROVEMENT_RETRY_WINDOW), MINCONV: String(IMPROVEMENT_MIN_CONVERSATIONS), LOCATIONS: String(IMPROVEMENT_INDEX_LOCATIONS),
    VERDICTKINDS: quotedList(VERDICT_KINDS), VERDICTGROUPS: quotedList(VERDICT_GROUPS), VERDICTSTATUSES: quotedList(VERDICT_STATUSES), NEWSTATUS: `"${NEW_STATUS}"`,
  });
}

export function improvementFirstMessage(v: Pick<ImprovementBriefValues, "briefPath" | "indexPath" | "language">): string {
  return `Read ${v.briefPath} and follow it, then read ${v.indexPath}.\nReply in ${v.language}.`;
}

export function isImprovementFirstMessage(text: string): boolean {
  const m = /^Read (.+) and follow it, then read (.+)\.\r?\nReply in [^\n]+\.\s*$/.exec(text.trim());
  return !!m && m[1].endsWith(IMPROVEMENT_BRIEF_FILE) && m[2].endsWith(IMPROVEMENT_INDEX_FILE);
}

export const IMPROVEMENT_TOOL_FILE = "improvement.mjs";

const bashQuoted = (value: string): string => `'${value.replace(/(?<=[^\\/:])[\\/]+$/, "").replace(/'/g, "'\\''")}'`;

export function improvementRecordCommand(runtimePath: string, toolPath: string, configDir: string): string {
  return `ELECTRON_RUN_AS_NODE=1 ${bashQuoted(runtimePath)} ${bashQuoted(toolPath)} record --config-dir ${bashQuoted(configDir)}`;
}

export function improvementRunName(at: Date, suffix: string): string {
  return `${at.toISOString().replace(/\.\d+Z$/, "").replace(/:/g, "-")}-${suffix}`;
}

export const IMPROVEMENT_SCAN_TIMEOUT_MS = 10 * 60 * 1000;
export const IMPROVEMENT_PARTIAL_STALE_MS = 6 * IMPROVEMENT_SCAN_TIMEOUT_MS;
export const IMPROVEMENT_RUN_MIN_AGE_MS = 14 * 24 * 60 * 60 * 1000;

function runTime(name: string): number {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})/.exec(name);
  return m ? Date.parse(`${m[1]}T${m[2]}:${m[3]}:${m[4]}Z`) : NaN;
}

export function improvementRunsToDelete(names: readonly string[], inUse: ReadonlySet<string>, now: number): string[] {
  const runs = names.filter((n) => RUN_NAME_RE.test(n)).sort().reverse();
  const newest = new Set(runs.slice(0, IMPROVEMENT_RUNS_KEPT));
  const old = runs.filter((n) => !newest.has(n) && !inUse.has(n) && now - runTime(n) > IMPROVEMENT_RUN_MIN_AGE_MS);
  const partials = names.filter((n) => n.endsWith(IMPROVEMENT_PARTIAL_SUFFIX) && RUN_NAME_RE.test(n.slice(0, -IMPROVEMENT_PARTIAL_SUFFIX.length)) && now - runTime(n) > IMPROVEMENT_PARTIAL_STALE_MS);
  return [...old, ...partials];
}

export function languageName(tag: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}
