import { contributes } from "../package.json";

const properties = contributes.configuration.properties;
type ConfigurationKey = keyof typeof properties extends `laisora.${infer Key}` ? Key : never;

export function configurationDefault<T>(key: ConfigurationKey): T {
  return properties[`laisora.${key}`].default as T;
}

export function configurationBound(key: ConfigurationKey, bound: "minimum" | "maximum"): number | undefined {
  const value = (properties[`laisora.${key}`] as Record<string, unknown> | undefined)?.[bound];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

const CONFIGURATION_KEYS = Object.keys(properties).map((key) => key.slice("laisora.".length)) as ConfigurationKey[];

export type ConfigurationInspect = (key: string) => { defaultValue?: unknown } | undefined;

export function configurationRegistered(inspect: ConfigurationInspect, key: string): boolean {
  return inspect(key)?.defaultValue !== undefined;
}

export function windowMissesContributedSettings(inspect: ConfigurationInspect): boolean {
  return CONFIGURATION_KEYS.some((key) => !configurationRegistered(inspect, key));
}
