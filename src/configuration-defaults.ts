import { contributes } from "../package.json";

const properties = contributes.configuration.properties;
type ConfigurationKey = keyof typeof properties extends `laisora.${infer Key}` ? Key : never;

export function configurationDefault<T>(key: ConfigurationKey): T {
  return properties[`laisora.${key}`].default as T;
}
