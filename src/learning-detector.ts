import { classifyFailure, type FailureSignature } from "./learning-signature";

export const DETECTOR_VERSION = 1;
export interface DetectorFixture { tool: string; text: string; input: unknown; cls: string; group: string }
export const DETECTOR_REGRESSION_FIXTURES: readonly DetectorFixture[] = Object.freeze([
  { tool: "Edit", text: "File has not been read yet. Read it first before writing to it", input: {}, cls: "edit_not_read", group: "counted" },
  { tool: "Edit", text: "String to replace not found in file", input: {}, cls: "edit_mismatch", group: "counted" },
  { tool: "Bash", text: "HTTP 429 Too Many Requests", input: { command: "curl example.test" }, cls: "rate", group: "transient" },
  { tool: "Bash", text: "ModuleNotFoundError", input: { command: "python task.py" }, cls: "module_not_found", group: "counted" },
]);
export type Detector = (tool: string, text: string, input: unknown) => FailureSignature;
export class LearningDetector {
  private passing: { version: number; detect: Detector };
  rejected?: number;
  constructor(baseline: Detector = classifyFailure, version = DETECTOR_VERSION) {
    if (!this.passes(baseline)) throw new Error("learning detector baseline failed regression");
    this.passing = { version, detect: baseline };
  }
  private passes(detect: Detector): boolean {
    try { return DETECTOR_REGRESSION_FIXTURES.every(fixture => {
      const result = detect(fixture.tool, fixture.text, fixture.input);
      return result.cls === fixture.cls && result.group === fixture.group;
    }); } catch { return false; }
  }
  adopt(version: number, detect: Detector): boolean {
    if (!this.passes(detect)) { this.rejected = version; return false; }
    this.passing = { version, detect }; this.rejected = undefined; return true;
  }
  get version(): number { return this.passing.version; }
  classify(tool: string, text: string, input: unknown): FailureSignature { return this.passing.detect(tool, text, input); }
}
