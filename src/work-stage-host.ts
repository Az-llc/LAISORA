import * as fs from "node:fs";
import * as path from "node:path";
import { workStageCharactersOf, workStageRoomsOf, type WorkStageCastSetting, type WorkStageChoices } from "./work-stage-cast";
import { assets, data, dataGlobal, pictureDir, pictureSuffix, script, scriptGlobal } from "./work-stage-packet.json";

export const WORK_STAGE_SETTINGS = "workStage";
export const WORK_STAGE_ENABLED_SETTING = `${WORK_STAGE_SETTINGS}.enabled`;
export const workStageCastSettingKey = <S extends WorkStageCastSetting>(setting: S): `${typeof WORK_STAGE_SETTINGS}.${S}` => `${WORK_STAGE_SETTINGS}.${setting}`;

export interface WorkStagePacket {
  readonly script: string;
  readonly data: string;
  readonly assets: string;
  readonly pictureDir: string;
  readonly pictureSuffix: string;
  readonly scriptGlobal: string;
  readonly dataGlobal: string;
}

export const WORK_STAGE_PACKET: WorkStagePacket = { script, data, assets, pictureDir, pictureSuffix, scriptGlobal, dataGlobal };

export interface WorkStageWebview {
  readonly imgSrcExtra: readonly string[];
  readonly dataAttributes: Readonly<Record<string, string>>;
}

const posixDir = (relativePath: string): string => relativePath.slice(0, Math.max(0, relativePath.lastIndexOf("/")));

function hasPicture(dir: string, suffix: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return false;
  }
  return entries.some(entry => entry.isFile() ? entry.name.endsWith(suffix) : entry.isDirectory() && hasPicture(path.join(dir, entry.name), suffix));
}

export function workStagePresence(extensionPath: string, packet: WorkStagePacket = WORK_STAGE_PACKET): boolean {
  const file = (relativePath: string): string => path.join(extensionPath, ...relativePath.split("/"));
  return fs.existsSync(file(packet.script)) && fs.existsSync(file(packet.data)) && hasPicture(file(packet.pictureDir), packet.pictureSuffix);
}

// work-stage/stage-build.mjs#main writes the data file as one assignment of a JSON object to the data global.
export function manifestOfStageData(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end < start) return undefined;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return undefined;
  }
}

const NO_CHOICES: WorkStageChoices = { characters: [], rooms: [] };

export function readWorkStageChoices(extensionPath: string, language: string, packet: WorkStagePacket = WORK_STAGE_PACKET): WorkStageChoices {
  try {
    const manifest = manifestOfStageData(fs.readFileSync(path.join(extensionPath, ...packet.data.split("/")), "utf8"));
    return { characters: workStageCharactersOf(manifest), rooms: workStageRoomsOf(manifest, language) };
  } catch {
    return NO_CHOICES;
  }
}

let present = false;
let choices: WorkStageChoices = NO_CHOICES;

export function noteWorkStagePresence(extensionPath: string, language: string): boolean {
  present = workStagePresence(extensionPath);
  choices = present ? readWorkStageChoices(extensionPath, language) : NO_CHOICES;
  return present;
}

export function workStagePresent(): boolean {
  return present;
}

export function workStageChoices(): WorkStageChoices {
  return choices;
}

export function workStageRoots(presence: boolean, packet: WorkStagePacket): string[] {
  return presence ? [...new Set([posixDir(packet.script), posixDir(packet.data), packet.assets])] : [];
}

export function workStageWebview(presence: boolean, packet: WorkStagePacket, toUri: (relativePath: string) => string, cspSource: string): WorkStageWebview {
  if (!presence) return { imgSrcExtra: [], dataAttributes: {} };
  const assetsUri = toUri(packet.assets);
  return {
    imgSrcExtra: [cspSource],
    dataAttributes: {
      "data-work-stage-script": toUri(packet.script),
      "data-work-stage-data": toUri(packet.data),
      "data-work-stage-assets": assetsUri.endsWith("/") ? assetsUri : `${assetsUri}/`,
      "data-work-stage-globals": `${packet.scriptGlobal},${packet.dataGlobal}`,
    },
  };
}
