import type { FileLinkPlatform } from "./file-link-target";

export const HOST_FILE_LINK_PLATFORM: FileLinkPlatform = { windows: process.platform === "win32" };
