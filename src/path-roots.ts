import { homedir } from "node:os";
import { setHomeDirectory } from "./path-redaction";

export function registerHomePathRoot(): void {
  setHomeDirectory(homedir());
}
