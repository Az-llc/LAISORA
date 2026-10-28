import * as l10n from "@vscode/l10n";
import type { SettingsRevealTarget } from "./protocol";

export const GREETING_SLOTS = ["morning", "noon", "afternoon", "evening", "night", "late"] as const;
export type GreetingSlot = (typeof GREETING_SLOTS)[number];
export const GREETING_SPECIAL_DAYS = ["mondayMorning", "fridayEvening", "catDay", "newYear"] as const;
export type GreetingSpecialDay = (typeof GREETING_SPECIAL_DAYS)[number];

export interface WelcomeGreetings {
  slots: Record<GreetingSlot, readonly string[]>;
  specialDays: Record<GreetingSpecialDay, readonly string[]>;
  anytime: readonly string[];
}

export interface WelcomeNewsItem { kind: "new" | "setting"; text: string; setting?: SettingsRevealTarget }
export interface WelcomeTip { id: string; kind: string; title: string; body: string; setting?: SettingsRevealTarget }
export interface WelcomeUiNames { menuGlyph: string; handoffItem: string; appearanceSection: string; historyButton: string }

export function welcomeNews(): Readonly<Record<string, readonly WelcomeNewsItem[]>> {
  return {
    "1.13.0": [
      { kind: "new", text: l10n.t("Claude's replies get \"Add to ToDo\" and \"Add to ToDo and start a new conversation\" buttons beside Copy."), setting: "todo" },
      { kind: "new", text: l10n.t("ToDo rows can be dragged from anywhere on the row.") },
    ],
    "1.12.0": [
      { kind: "new", text: l10n.t("The ToDo list is on from the start. Claude can add to it and update it, and every window shares it. If you don't need it, you can turn it off in the settings."), setting: "todo" },
      { kind: "new", text: l10n.t("GRAPH shows the work a delegate started as rows folded under that delegate.") },
      { kind: "new", text: l10n.t("Conversations from Claude Desktop continue in their own folder.") },
    ],
    "1.11.0": [
      { kind: "new", text: l10n.t("Turn Remote Control on or off for each conversation from the tab menu or `/rc`.") },
      { kind: "setting", text: l10n.t("Automatic handoff: when a conversation grows large, it moves to a new conversation while it is waiting (turned off at first)."), setting: "handoffAuto" },
    ],
  };
}

export function welcomeTips(ui: WelcomeUiNames): readonly WelcomeTip[] {
  const connecting = l10n.t("Connecting conversations");
  const delegating = l10n.t("Handing work out");
  const viewing = l10n.t("Seeing the work");
  const tidying = l10n.t("Tidying up");
  return [
    { id: "handoff", kind: connecting, title: l10n.t("Hand off when a conversation gets long"), body: l10n.t("\"{1}\" in the tab menu ({0}) starts a new conversation that carries the summary and your messages as they are. The original conversation stays.", ui.menuGlyph, ui.handoffItem) },
    { id: "handoffAuto", kind: connecting, title: l10n.t("Make the handoff automatic"), body: l10n.t("When the context grows large, the conversation moves to a new one by itself once it is free. Another setting moves it before the cache expires."), setting: "handoffAuto" },
    { id: "remoteControl", kind: connecting, title: l10n.t("Continue from another device"), body: l10n.t("Turn Remote Control on with `/rc` to send to the same conversation from claude.ai or your phone.") },
    { id: "resumeClaudeCode", kind: connecting, title: l10n.t("Resume Claude Code conversations too"), body: l10n.t("History ({0}) also lists conversations started in Claude Code or Claude Desktop. Pick one to continue it in LAISORA.", ui.historyButton) },
    { id: "roster", kind: delegating, title: l10n.t("Use a different model for each role"), body: l10n.t("With the agent roster, research, implementation and review each go to the model you chose. Work can also go to Codex or Antigravity."), setting: "orchestration" },
    { id: "workViews", kind: viewing, title: l10n.t("See how the work went"), body: l10n.t("Open SUMMARY, GRAPH, ANALYSIS or LOG from the view switch beside the conversation to see what took how long and what went to whom.") },
    { id: "editDiff", kind: viewing, title: l10n.t("Compare before and after an edit"), body: l10n.t("Click an edited file listed at the end of a reply to open the difference between before and after that turn.") },
    { id: "markdownExport", kind: tidying, title: l10n.t("Keep a conversation as Markdown"), body: l10n.t("From the tab menu ({0}), write the conversation out to a Markdown file.", ui.menuGlyph) },
    { id: "appearance", kind: tidying, title: l10n.t("Change LAISORA's colour and name"), body: l10n.t("Change the accent colour and the display name under \"{0}\" in the settings.", ui.appearanceSection), setting: "appearance" },
  ];
}

export function welcomeGreetings(): WelcomeGreetings {
  return {
    slots: {
      morning: [
        l10n.t("Good morning. What shall we get done today?"),
        l10n.t("Good morning. The cat is still asleep."),
        l10n.t("Let's start once the coffee is ready ☕"),
        l10n.t("The rooster is already at work 🐓"),
        l10n.t("Hard things first, while it is morning. You will be sleepy by noon."),
        l10n.t("Good morning. Yesterday's TODO is waiting for you."),
        l10n.t("The cat is asking for breakfast. I am asking for work."),
      ],
      noon: [
        l10n.t("It is lunchtime. There is still time after you eat."),
        l10n.t("Let's pick up where the morning left off."),
        l10n.t("Just one thing before lunch 🍙"),
        l10n.t("The cat is looking for a sunny spot for a nap."),
        l10n.t("The code will not run away during lunch."),
      ],
      afternoon: [
        l10n.t("Let's keep going this afternoon."),
        l10n.t("It is the sleepy hour. The cat is already asleep."),
        l10n.t("One task before snack time 🍪"),
        l10n.t("A capybara came late to the afternoon meeting ♨"),
        l10n.t("The sloth says there is no need to hurry 🦥"),
        l10n.t("3 p.m. Top up your focus with some tea."),
      ],
      evening: [
        l10n.t("It is evening. Anything you want finished today?"),
        l10n.t("One more push before the sun sets."),
        l10n.t("The crows are heading home. We will keep at it a little longer."),
        l10n.t("Time for the cats' evening races 🐈"),
        l10n.t("Let's get today's work ready to hand over to tomorrow's you."),
      ],
      night: [
        l10n.t("Good evening. What shall we make?"),
        l10n.t("Nights are productive. In moderation."),
        l10n.t("The owl is clocking in 🦉"),
        l10n.t("The cat has started its night patrol."),
        l10n.t("Have you had dinner?"),
        l10n.t("Code written at night is somehow full of confidence."),
      ],
      late: [
        l10n.t("Thank you for working this late."),
        l10n.t("Even the cat is asleep. Let's keep it short."),
        l10n.t("Look again in the morning at code written late at night."),
        l10n.t("Only the owl librarian is awake 🦉"),
        l10n.t("Koalas sleep 20 hours a day, they say 🐨"),
        l10n.t("I believe you when you say this is the last one before bed."),
        l10n.t("A warm drink to keep you company tonight."),
      ],
    },
    specialDays: {
      mondayMorning: [
        l10n.t("It is Monday. Let's start with something light."),
        l10n.t("Monday morning. The cat is still in weekend mode."),
        l10n.t("The start of the week. Where did we leave off last week?"),
      ],
      fridayEvening: [
        l10n.t("Friday evening. Commit before you go home."),
        l10n.t("A big change on a Friday evening is a problem for Monday's you."),
        l10n.t("It is Friday. The cat has already started the weekend."),
      ],
      catDay: [
        l10n.t("Today is Cat Day. Meow."),
        l10n.t("February 22. The cats look a little proud."),
        l10n.t("It is Cat Day, so the cat is the boss 🐈"),
      ],
      newYear: [
        l10n.t("Happy New Year. Let's make things together again this year."),
        l10n.t("Happy New Year. Let's write the first line of the year."),
      ],
    },
    anytime: [
      l10n.t("Where shall we start?"),
      l10n.t("The hamster is warming up for the wheel 🐹"),
      l10n.t("The penguins are lined up, waiting for your instructions 🐧"),
      l10n.t("The ant parade is waiting for the signal to go 🐜"),
      l10n.t("The fairies have their tools ready and are waiting."),
      l10n.t("The cat got off the keyboard for you."),
      l10n.t("The bear gave up hibernating and is looking this way 🐻"),
      l10n.t("The sea otter brought one more stone for cracking shells 🦦"),
    ],
  };
}
