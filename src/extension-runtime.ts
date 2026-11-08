export function withExtensionNodeRuntime<T extends Record<string, string | undefined>>(env: T): T & { ELECTRON_RUN_AS_NODE: "1" } {
  return { ...env, ELECTRON_RUN_AS_NODE: "1" };
}

export function extensionNodeLaunch<T extends Record<string, string | undefined>>(entry: string, args: readonly string[], env: T) {
  return { executable: process.execPath, args: [entry, ...args], env: withExtensionNodeRuntime(env) };
}
