export const CHROME_INTEGRATION_SETTING_KEY = "claude.chromeIntegration";

export function chromeIntegrationEnabled(get: (key: typeof CHROME_INTEGRATION_SETTING_KEY) => unknown): boolean {
  return get(CHROME_INTEGRATION_SETTING_KEY) !== false;
}
