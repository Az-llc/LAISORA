import { normalizeDisplayName } from "./display-name";

export const WORK_STAGE_CAST_RESTS = ["random", "order"] as const;
export type WorkStageCastRest = (typeof WORK_STAGE_CAST_RESTS)[number];

export const WORK_STAGE_CAST_SETTINGS = ["conductor", "favourites", "rest", "names"] as const;
export type WorkStageCastSetting = (typeof WORK_STAGE_CAST_SETTINGS)[number];

export interface WorkStageCast {
  readonly conductor?: string;
  readonly favourites: readonly string[];
  readonly rest?: WorkStageCastRest;
  readonly names: Readonly<Record<string, string>>;
}

export interface WorkStageCharacter {
  readonly id: string;
  readonly name: string;
}

export interface WorkStageMountCast {
  conductorChar?: string;
  castFavourites: string[];
  castRest?: WorkStageCastRest;
  names: Record<string, string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isStringList = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const isStringRecord = (value: unknown): value is Record<string, string> => isRecord(value) && Object.values(value).every((item) => typeof item === "string");

export const isWorkStageCastRest = (value: unknown): value is WorkStageCastRest => (WORK_STAGE_CAST_RESTS as readonly unknown[]).includes(value);

export function workStageCharactersOf(manifest: unknown): WorkStageCharacter[] {
  const chars = isRecord(manifest) && isRecord(manifest.chars) ? manifest.chars : {};
  return Object.entries(chars).flatMap(([id, entry]) => {
    if (id === "" || !isRecord(entry)) return [];
    const name = normalizeDisplayName(entry.name);
    return [{ id, name: name || id }];
  });
}

type CastValues = { conductor: string; favourites: string[]; rest: WorkStageCastRest; names: Record<string, string> };

function castValueOf<S extends WorkStageCastSetting>(setting: S, value: unknown, known: ReadonlySet<string>): CastValues[S] | undefined;
function castValueOf(setting: WorkStageCastSetting, value: unknown, known: ReadonlySet<string>): CastValues[WorkStageCastSetting] | undefined {
  switch (setting) {
    case "conductor": return typeof value === "string" && known.has(value) ? value : undefined;
    case "favourites": return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === "string" && known.has(id)))] : undefined;
    case "rest": return isWorkStageCastRest(value) ? value : undefined;
    case "names":
      return isRecord(value)
        ? Object.fromEntries(Object.entries(value).flatMap(([id, name]) => {
          const kept = normalizeDisplayName(name);
          return known.has(id) && kept ? [[id, kept]] : [];
        }))
        : undefined;
  }
}

const knownIds = (characters: readonly WorkStageCharacter[]): ReadonlySet<string> => new Set(characters.map((character) => character.id));

export function workStageCastOf(read: (setting: WorkStageCastSetting) => unknown, characters: readonly WorkStageCharacter[], readDefault: (setting: WorkStageCastSetting) => unknown = () => undefined): WorkStageCast {
  const known = knownIds(characters);
  const valueOf = <S extends WorkStageCastSetting>(setting: S): CastValues[S] | undefined =>
    castValueOf(setting, read(setting), known) ?? castValueOf(setting, readDefault(setting), known);
  const conductor = valueOf("conductor");
  const rest = valueOf("rest");
  return {
    ...(conductor === undefined ? {} : { conductor }),
    favourites: valueOf("favourites") ?? [],
    ...(rest === undefined ? {} : { rest }),
    names: valueOf("names") ?? {},
  };
}

export function workStageCastWrite(setting: WorkStageCastSetting, value: unknown, characters: readonly WorkStageCharacter[]): { value: unknown } | undefined {
  if (setting === "conductor" && value === "") return { value: undefined };
  const kept = castValueOf(setting, value, knownIds(characters));
  if (kept === undefined || JSON.stringify(kept) !== JSON.stringify(value)) return undefined;
  const empty = typeof kept === "object" && Object.keys(kept).length === 0;
  return { value: empty ? undefined : kept };
}

export function isWorkStageCast(value: unknown): value is WorkStageCast {
  if (!isRecord(value) || !Object.keys(value).every((key) => (WORK_STAGE_CAST_SETTINGS as readonly string[]).includes(key))) return false;
  return (value.conductor === undefined || typeof value.conductor === "string")
    && isStringList(value.favourites)
    && (value.rest === undefined || isWorkStageCastRest(value.rest))
    && isStringRecord(value.names);
}

export function isWorkStageCharacter(value: unknown): value is WorkStageCharacter {
  return isRecord(value) && Object.keys(value).every((key) => key === "id" || key === "name") && typeof value.id === "string" && typeof value.name === "string";
}

export function isWorkStageCastSettingValue(setting: unknown, value: unknown): boolean {
  switch (setting) {
    case "conductor":
    case "rest": return typeof value === "string";
    case "favourites": return isStringList(value);
    case "names": return isStringRecord(value);
    default: return false;
  }
}

export function workStageMountCast(cast: WorkStageCast): WorkStageMountCast {
  return {
    ...(cast.conductor === undefined ? {} : { conductorChar: cast.conductor }),
    castFavourites: [...cast.favourites],
    ...(cast.rest === undefined ? {} : { castRest: cast.rest }),
    names: { ...cast.names },
  };
}
