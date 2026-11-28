import * as l10n from "@vscode/l10n";
import { CLOSE_GLYPH } from "./close-button";
import { isComposingKey } from "./composing";
import { element } from "./element";
import { handleSegmentedArrow } from "./segmented-keys";
import { capNameInput } from "./settings-rows";
import { normalizeDisplayName } from "../display-name";
import type { WorkStageSettings } from "../protocol";
import { WORK_STAGE_CAST_RESTS, type WorkStageCast, type WorkStageCastRest, type WorkStageCastSetting, type WorkStageChoice } from "../work-stage-cast";

interface SettingsControls {
  row(card: HTMLElement, label: string, description: string, control: HTMLElement, focusTarget?: () => HTMLElement | undefined): HTMLElement;
  rowNote(text: HTMLElement, className: string, note: string): HTMLElement;
  section(root: HTMLElement, title: string): HTMLElement;
}

export interface WorkStageCastSettings {
  render(state: WorkStageSettings | undefined, replyTo: number | undefined): boolean;
  anchor(setting: WorkStageCastSetting): HTMLElement | undefined;
  sameSettingRows(anchor: HTMLElement): HTMLElement[];
}

type FocusWanted = { id: string; control: "earlier" | "remove" } | "choice" | null;

export function characterLabel(cast: WorkStageCast, character: WorkStageChoice): string {
  const name = cast.names[character.id];
  return name === undefined || name === character.name ? character.name : l10n.t("{0} ({1})", name, character.name);
}

export function movedEarlier(list: readonly string[], index: number): string[] {
  if (index <= 0 || index >= list.length) return [...list];
  const next = [...list];
  [next[index - 1], next[index]] = [next[index], next[index - 1]];
  return next;
}

export function focusAfterRemove(list: readonly string[], index: number): FocusWanted {
  const next = list[index + 1] ?? list[index - 1];
  return next === undefined ? "choice" : { id: next, control: "remove" };
}

export function namesWith(names: Readonly<Record<string, string>>, character: WorkStageChoice, typed: string): Record<string, string> {
  const name = normalizeDisplayName(typed);
  const next = { ...names };
  if (name === "" || name === character.name) delete next[character.id];
  else next[character.id] = name;
  return next;
}

export function createWorkStageCastSettings(category: HTMLElement, card: HTMLElement, write: (setting: WorkStageCastSetting, value: unknown) => number, { row, rowNote, section }: SettingsControls): WorkStageCastSettings {
  let pending: number | null = null;
  let namesRequest: number | null = null;
  let namesSent: Record<string, string> | null = null;
  let nameAnchor: HTMLElement | undefined;
  let state: WorkStageSettings | undefined;
  let builtFor = "";
  let drawnFor = "";
  let shownFor: boolean | undefined;
  let focusWanted: FocusWanted = null;
  let restoreFocus: HTMLElement | undefined;

  const room = element("select", "settings-select");
  room.id = "setting-work-stage-room";
  const roomText = row(card, l10n.t("Room"),
    l10n.t("The room the work stage shows. Default leaves it to the work stage."), room);
  room.addEventListener("change", () => {
    if (state === undefined || pending !== null) return;
    pending = write("room", room.value);
    drawControls();
  });

  const conductor = element("select", "settings-select");
  conductor.id = "setting-work-stage-conductor";
  const conductorText = row(card, l10n.t("Conductor character"),
    l10n.t("The character that hands out the work and receives the letters. Default leaves it to the work stage."), conductor);
  conductor.addEventListener("change", () => {
    if (state === undefined || pending !== null) return;
    pending = write("conductor", conductor.value);
    drawControls();
  });

  const favouriteControl = element("div", "settings-extension-control");
  favouriteControl.id = "setting-work-stage-favourites";
  favouriteControl.setAttribute("role", "group");
  const favouriteChips = element("div", "settings-extension-chips");
  favouriteChips.setAttribute("role", "list");
  const favouriteChoice = element("select", "settings-select");
  favouriteChoice.id = "setting-work-stage-favourite-choice";
  favouriteChoice.setAttribute("aria-label", l10n.t("Character to add"));
  const favouriteAdd = element("button", "settings-segment", l10n.t("Add"));
  favouriteAdd.id = "setting-work-stage-favourite-add";
  favouriteAdd.type = "button";
  favouriteControl.append(favouriteChips, favouriteChoice, favouriteAdd);
  const favouritesText = row(card, l10n.t("Favourite workers"),
    l10n.t("New workers get these characters first, in this order, then the other characters. The conductor's character never becomes a worker, even when it is listed here."),
    favouriteControl, () => favouriteChoice);
  const writeFavourites = (next: string[], focus: FocusWanted): void => {
    if (state === undefined || pending !== null) return;
    focusWanted = focus;
    pending = write("favourites", next);
    drawControls();
  };
  favouriteAdd.addEventListener("click", () => {
    if (state && favouriteChoice.value) writeFavourites([...state.cast.favourites, favouriteChoice.value], "choice");
  });

  const restGroup = element("div", "settings-segmented");
  restGroup.id = "setting-work-stage-rest";
  restGroup.setAttribute("role", "radiogroup");
  const restLabels: Record<WorkStageCastRest, string> = { random: l10n.t("At random"), order: l10n.t("In the work stage's order") };
  const restRadios = WORK_STAGE_CAST_RESTS.map((value) => {
    const radio = element("button", "settings-segment", restLabels[value]);
    radio.id = `setting-work-stage-rest-${value}`;
    radio.type = "button";
    radio.setAttribute("role", "radio");
    radio.dataset.value = value;
    radio.addEventListener("click", () => {
      if (state === undefined || pending !== null || state.cast.rest === value) return;
      pending = write("rest", value);
      drawControls();
    });
    restGroup.appendChild(radio);
    return radio;
  });
  restGroup.addEventListener("keydown", (event) => handleSegmentedArrow(event, restRadios, (radio) => radio.click(), () => pending === null));
  const restText = row(card, l10n.t("Other characters"),
    l10n.t("How new workers get the other characters once the favourite workers are in use."), restGroup,
    () => restRadios.find((radio) => radio.getAttribute("aria-checked") === "true") ?? restRadios[0]);

  const namesCard = section(category, l10n.t("Character names"));
  const nameInputs = new Map<string, { input: HTMLInputElement; text: HTMLElement; character: WorkStageChoice }>();
  const savedNames = (): Readonly<Record<string, string>> => namesSent ?? state?.cast.names ?? {};
  const edited = new Set<HTMLInputElement>();
  let namesInput: HTMLInputElement | null = null;

  const writeName = (character: WorkStageChoice, input: HTMLInputElement, text: HTMLElement): void => {
    if (state === undefined) return;
    const base = savedNames();
    const next = namesWith(base, character, input.value);
    input.value = next[character.id] ?? "";
    if (JSON.stringify(next) === JSON.stringify(base)) return;
    namesSent = next;
    nameAnchor = text;
    namesInput = input;
    namesRequest = write("names", next);
  };

  const buildNames = (characters: readonly WorkStageChoice[]): void => {
    namesCard.replaceChildren();
    nameInputs.clear();
    for (const character of characters) {
      const field = element("div", "settings-name-field");
      const input = element("input", "settings-input settings-name-input");
      input.id = `setting-work-stage-name-${nameInputs.size}`;
      input.type = "text";
      input.placeholder = character.name;
      input.spellcheck = false;
      input.autocomplete = "off";
      field.appendChild(input);
      const text = row(namesCard, character.name, l10n.t("Leave empty to use this name."), field, () => input);
      text.querySelector("label")!.htmlFor = input.id;
      const notice = rowNote(text, "settings-row-note", "");
      notice.setAttribute("role", "status");
      notice.setAttribute("aria-live", "polite");
      input.setAttribute("aria-labelledby", field.getAttribute("aria-labelledby")!);
      input.setAttribute("aria-describedby", `${field.getAttribute("aria-describedby")} ${notice.id}`);
      field.removeAttribute("aria-labelledby");
      field.removeAttribute("aria-describedby");
      input.addEventListener("input", (event) => {
        edited.add(input);
        if (!isComposingKey(event as InputEvent)) capNameInput(input, notice);
      });
      input.addEventListener("compositionend", () => capNameInput(input, notice));
      input.addEventListener("change", () => {
        edited.delete(input);
        writeName(character, input, text);
      });
      input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !isComposingKey(event)) input.dispatchEvent(new Event("change"));
      });
      nameInputs.set(character.id, { input, text, character });
    }
  };

  const optionFor = (cast: WorkStageCast, character: WorkStageChoice): HTMLOptionElement => {
    const option = element("option", "", characterLabel(cast, character));
    option.value = character.id;
    return option;
  };

  function drawControls(): void {
    const busy = state === undefined || pending !== null;
    const key = JSON.stringify([state?.characters ?? [], state?.rooms ?? [], state?.cast ?? null, busy]);
    if (key === drawnFor) return;
    drawnFor = key;
    const characters = state?.characters ?? [];
    const cast: WorkStageCast = state?.cast ?? { favourites: [], names: {} };
    if (busy) restoreFocus = [room, conductor, ...restRadios].find((control) => control === document.activeElement) ?? restoreFocus;

    const roomDefault = element("option", "", l10n.t("Default"));
    roomDefault.value = "";
    room.replaceChildren(roomDefault, ...(state?.rooms ?? []).map((choice) => {
      const option = element("option", "", choice.name);
      option.value = choice.id;
      return option;
    }));
    room.value = cast.room ?? "";
    room.disabled = busy;

    const fallback = element("option", "", l10n.t("Default"));
    fallback.value = "";
    conductor.replaceChildren(fallback, ...characters.map((character) => optionFor(cast, character)));
    conductor.value = cast.conductor ?? "";
    conductor.disabled = busy;

    const byId = new Map(characters.map((character) => [character.id, character]));
    const favourites = cast.favourites.filter((id) => byId.has(id));
    let focusTarget: HTMLElement | undefined;
    favouriteChips.replaceChildren(...favourites.map((id, index) => {
      const label = characterLabel(cast, byId.get(id)!);
      const chip = element("span", "settings-extension-chip", label);
      chip.setAttribute("role", "listitem");
      if (index > 0) {
        const earlier = element("button", "settings-segment", "←");
        earlier.type = "button";
        earlier.setAttribute("aria-label", l10n.t("Move {0} earlier", label));
        earlier.title = l10n.t("Move {0} earlier", label);
        earlier.disabled = busy;
        earlier.addEventListener("click", () => writeFavourites(movedEarlier(favourites, index), { id, control: index > 1 ? "earlier" : "remove" }));
        chip.appendChild(earlier);
        if (focusWanted !== null && focusWanted !== "choice" && focusWanted.id === id && focusWanted.control === "earlier") focusTarget = earlier;
      }
      const remove = element("button", "settings-segment", CLOSE_GLYPH);
      remove.type = "button";
      remove.setAttribute("aria-label", l10n.t("Remove {0}", label));
      remove.title = l10n.t("Remove {0}", label);
      remove.disabled = busy;
      remove.addEventListener("click", () => writeFavourites(favourites.filter((item) => item !== id), focusAfterRemove(favourites, index)));
      chip.appendChild(remove);
      if (focusWanted !== null && focusWanted !== "choice" && focusWanted.id === id && focusWanted.control === "remove") focusTarget = remove;
      return chip;
    }));
    favouriteChips.hidden = favourites.length === 0;
    const choices = characters.filter((character) => !favourites.includes(character.id));
    const chosen = favouriteChoice.value;
    favouriteChoice.replaceChildren(...choices.map((character) => optionFor(cast, character)));
    if (choices.some((character) => character.id === chosen)) favouriteChoice.value = chosen;
    favouriteChoice.disabled = favouriteAdd.disabled = busy || choices.length === 0;
    if (focusWanted === "choice") focusTarget = favouriteChoice.disabled ? favouriteChips.querySelector<HTMLButtonElement>(":scope > :last-child > button:last-child") ?? undefined : favouriteChoice;

    for (const radio of restRadios) {
      const checked = cast.rest === radio.dataset.value;
      radio.setAttribute("aria-checked", String(checked));
      radio.tabIndex = checked || (cast.rest === undefined && radio === restRadios[0]) ? 0 : -1;
      radio.disabled = busy;
    }

    if (state === undefined || (conductorText.parentElement!.hidden && roomText.parentElement!.hidden)) {
      focusWanted = null;
      restoreFocus = undefined;
      return;
    }
    if (busy) return;
    const target = focusWanted !== null ? focusTarget ?? favouriteChoice : restoreFocus;
    focusWanted = null;
    restoreFocus = undefined;
    const focusFree = document.activeElement === null || document.activeElement === document.body;
    if (target && focusFree && !(target as HTMLButtonElement).disabled && !target.closest("[hidden]")) target.focus();
  }

  function drawNames(replied: HTMLInputElement | null): void {
    const names = savedNames();
    for (const { input, character } of nameInputs.values()) {
      input.disabled = state === undefined;
      const showSaved = input === replied ? !edited.has(input) : document.activeElement !== input;
      if (showSaved) input.value = names[character.id] ?? "";
    }
  }

  return {
    render(next, replyTo) {
      state = next;
      if (pending !== null && pending === replyTo) pending = null;
      const replied = namesRequest !== null && namesRequest === replyTo ? namesInput : null;
      if (replied) {
        namesRequest = null;
        namesSent = null;
        namesInput = null;
      }
      const key = JSON.stringify(next?.characters ?? []);
      if (key !== builtFor) {
        builtFor = key;
        buildNames(next?.characters ?? []);
      }
      const shown = (next?.characters.length ?? 0) > 0;
      for (const text of [conductorText, favouritesText, restText]) text.parentElement!.hidden = !shown;
      namesCard.parentElement!.hidden = !shown;
      const roomShown = (next?.rooms.length ?? 0) > 1;
      roomText.parentElement!.hidden = !roomShown;
      drawControls();
      drawNames(replied);
      const changed = shownFor !== (shown || roomShown);
      shownFor = shown || roomShown;
      return changed;
    },
    anchor(setting) {
      if (setting === "room") return roomText;
      if (setting === "conductor") return conductorText;
      if (setting === "favourites") return favouritesText;
      if (setting === "rest") return restText;
      return nameAnchor;
    },
    sameSettingRows(anchor) {
      const rows = [...nameInputs.values()].map(({ text }) => text);
      return rows.includes(anchor) ? rows.filter((text) => text !== anchor) : [];
    },
  };
}
