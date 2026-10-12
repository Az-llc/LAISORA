import { createHash, randomUUID } from "node:crypto";
import { mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ORCHESTRATION_PLUGIN_NAME, orchestrationAgents, type OrchestrationAgentDefinition, type OrchestrationRow, type ExternalModels } from "./orchestration-roster";

const MANIFEST = join(".claude-plugin", "plugin.json");

export function orchestrationPluginDirectoryOf(globalStoragePath: string | undefined): string | undefined {
  return globalStoragePath ? join(globalStoragePath, "orchestration", "agent-plugin") : undefined;
}

function yamlString(value: string): string {
  return JSON.stringify(value).replace(/[\u007f-\u009f\u2028\u2029\ufeff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

function agentFileName(name: string): string {
  const digest = createHash("sha256").update(name).digest("hex").slice(0, 8);
  return `${name.toLowerCase().replace(/[^a-z0-9._-]/g, "_")}-${digest}.md`;
}

function agentMarkdown(agent: OrchestrationAgentDefinition): string {
  return [
    "---",
    `name: ${yamlString(agent.name)}`,
    `description: ${yamlString(agent.description)}`,
    `model: ${yamlString(agent.model)}`,
    ...(agent.effort === undefined ? [] : [`effort: ${yamlString(agent.effort)}`]),
    ...(agent.experimental ? ["experimental:", `  cacheTtl: ${yamlString(agent.experimental.cacheTtl)}`] : []),
    "---",
    agent.prompt,
    "",
  ].join("\n");
}

export function orchestrationPluginFiles(roster: readonly OrchestrationRow[], models?: ExternalModels): ReadonlyArray<readonly [string, string]> {
  const manifest = `${JSON.stringify({ name: ORCHESTRATION_PLUGIN_NAME, version: "1.0.0", description: "LAISORA orchestration agents" })}\n`;
  return [[MANIFEST, manifest], ...Object.values(orchestrationAgents(roster, models))
    .map((agent) => [join("agents", agentFileName(agent.name)), agentMarkdown(agent)] as const)];
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

export async function prepareOrchestrationPlugin(root: string, roster: readonly OrchestrationRow[], models?: ExternalModels): Promise<string> {
  const files = orchestrationPluginFiles(roster, models);
  const digest = createHash("sha256").update(JSON.stringify(files)).digest("hex").slice(0, 32);
  const target = join(root, digest);
  if (await exists(join(target, MANIFEST))) return target;
  await mkdir(root, { recursive: true });
  const temporary = join(root, `${digest}.${randomUUID()}.tmp`);
  for (const [file, content] of files) {
    await mkdir(dirname(join(temporary, file)), { recursive: true });
    await writeFile(join(temporary, file), content, { encoding: "utf8", flag: "wx" });
  }
  try {
    await rename(temporary, target);
    return target;
  } catch {
    if (!(await exists(join(target, MANIFEST)))) return temporary;
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
    return target;
  }
}
