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

export function resolveSettingGroup<T extends object>(keys: { readonly [K in keyof T]: ConfigurationKey }, isValue: (setting: unknown, value: unknown) => boolean, read: (key: string) => unknown): T {
  const out: Record<string, unknown> = {};
  for (const [name, key] of Object.entries(keys) as [string, ConfigurationKey][]) {
    const value = read(key);
    out[name] = isValue(name, value) ? value : configurationDefault(key);
  }
  return out as T;
}

const CONFIGURATION_KEYS = Object.keys(properties).map((key) => key.slice("laisora.".length)) as ConfigurationKey[];

export function isPortableSetting(property: { readonly scope?: string }): boolean {
  return property.scope !== "machine" && property.scope !== "machine-overridable";
}

export const PORTABLE_CONFIGURATION_KEYS: readonly string[] = CONFIGURATION_KEYS.filter((key) => isPortableSetting(properties[`laisora.${key}`] as { scope?: string }));

export type ConfigurationInspect = (key: string) => { defaultValue?: unknown } | undefined;

export function configurationRegistered(inspect: ConfigurationInspect, key: string): boolean {
  return inspect(key)?.defaultValue !== undefined;
}

export function windowMissesContributedSettings(inspect: ConfigurationInspect): boolean {
  return CONFIGURATION_KEYS.some((key) => !configurationRegistered(inspect, key));
}
