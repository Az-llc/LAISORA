export const FILE_LINK_TARGET_MAX_LEN = 4096;

export interface FileLinkTarget {
  target: string;
  resource: string;
  kind: "path" | "file-uri";
  line?: number;
  column?: number;
}

function positiveSafeInteger(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function hasUriScheme(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
}

export function isWindowsDevicePath(value: string): boolean {
  return /^\\\\[.?][\\/]/.test(value);
}

export function isWindowsUncPath(value: string): boolean {
  return /^\\\\[^\\]/.test(value) && !isWindowsDevicePath(value);
}

// Windows reads any two leading separators in either direction as a UNC share or device namespace (\\server, //server, /\server, \\.\, \\?\).
export function isNetworkOrDevicePath(value: string): boolean {
  return /^[\\/]{2}/.test(value);
}

export interface FileLinkPlatform {
  // The platform of the Extension Host that resolves and opens the file, never the webview's.
  windows: boolean;
}

// Win32 maps these names to devices in every directory, with any extension and ignoring trailing spaces/dots
// (C:\work\con.txt and C:con are the console). Opening one can block the Extension Host on device I/O.
export function hasWindowsReservedDeviceName(value: string): boolean {
  return value
    .split(/[\\/]/)
    .some((segment) =>
      /^(?:CON|PRN|AUX|NUL|COM[0-9¹²³]|LPT[0-9¹²³]|CONIN\$|CONOUT\$)$/i.test(
        segment.replace(/^[A-Za-z]:/, "").split(".")[0].replace(/ +$/, "")
      )
    );
}

// C:foo is relative to the current directory of drive C, which the Host does not control.
export function isWindowsDriveRelativePath(value: string): boolean {
  return /^[A-Za-z]:(?![\\/])/.test(value);
}

// NTFS reads name:stream as an alternate data stream. Only the drive colon (C:) is a path character.
export function hasNonDriveColon(value: string): boolean {
  return value.indexOf(":", /^[A-Za-z]:/.test(value) ? 2 : 0) !== -1;
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function hasNegativeColonLocation(value: string): boolean {
  return /:-\d+(?::-?\d+)?$|:\d+:-\d+$/.test(value);
}

export function parseFileLinkTarget(target: string, platform: FileLinkPlatform): FileLinkTarget | null {
  // R-CNV-12: model output is untrusted; only the documented file-target grammar crosses into Host resolution.
  if (
    target.length === 0 ||
    target.length > FILE_LINK_TARGET_MAX_LEN ||
    target.trim() !== target ||
    hasControlCharacter(target)
  ) {
    return null;
  }

  let resource = target;
  let line: number | undefined;
  let column: number | undefined;

  const hashLocation = resource.match(/#L(\d+)(?:C(\d+))?$/);
  if (hashLocation) {
    line = positiveSafeInteger(hashLocation[1]);
    column = positiveSafeInteger(hashLocation[2]);
    if (line === undefined || (hashLocation[2] !== undefined && column === undefined)) return null;
    resource = resource.slice(0, -hashLocation[0].length);
    if (
      resource.includes("#") ||
      /:\d+(?::\d+)?$/.test(resource) ||
      hasNegativeColonLocation(resource)
    ) {
      return null;
    }
  } else {
    if (resource.includes("#") || hasNegativeColonLocation(resource)) return null;
    const colonLocation = resource.match(/:(\d+)(?::(\d+))?$/);
    if (colonLocation) {
      line = positiveSafeInteger(colonLocation[1]);
      column = positiveSafeInteger(colonLocation[2]);
      if (line === undefined || (colonLocation[2] !== undefined && column === undefined)) return null;
      resource = resource.slice(0, -colonLocation[0].length);
    }
  }

  if (resource.length === 0) return null;

  if (/^file:/i.test(resource)) {
    // R-CNV-12: a file URI with an authority (file://host/, including localhost) or a path that starts with two separators names a network share or device.
    if (!/^file:(?:\/\/\/|\/)(?![\\/]|%5C|%2F)/i.test(resource)) return null;
    try {
      const url = new URL(resource);
      const decodedPath = decodeURIComponent(url.pathname);
      if (
        url.protocol !== "file:" ||
        url.hostname.length > 0 ||
        url.search.length > 0 ||
        url.hash.length > 0 ||
        isNetworkOrDevicePath(decodedPath) ||
        hasControlCharacter(decodedPath) ||
        (platform.windows &&
          (isWindowsDriveRelativePath(decodedPath.slice(1)) ||
            hasWindowsReservedDeviceName(decodedPath) ||
            hasNonDriveColon(decodedPath.slice(1))))
      ) {
        return null;
      }
    } catch {
      return null;
    }
    return {
      target,
      resource,
      kind: "file-uri",
      ...(line === undefined ? {} : { line }),
      ...(column === undefined ? {} : { column }),
    };
  }

  let decodedResource: string;
  try {
    decodedResource = decodeURIComponent(resource);
  } catch {
    return null;
  }
  // R-CNV-12: UNC shares and device paths never become links, whatever the outside-workspace settings say. On a Windows
  // Host, drive-relative paths, reserved device names and alternate data streams do not either.
  if (
    hasControlCharacter(decodedResource) ||
    isNetworkOrDevicePath(decodedResource) ||
    decodedResource.startsWith("\\") ||
    (platform.windows &&
      (isWindowsDriveRelativePath(decodedResource) ||
        hasWindowsReservedDeviceName(decodedResource) ||
        hasNonDriveColon(decodedResource)))
  ) {
    return null;
  }

  const windowsAbsolute = /^[A-Za-z]:[\\/]/.test(decodedResource);
  if (!windowsAbsolute && hasUriScheme(decodedResource)) return null;
  if (decodedResource === "." || decodedResource === "..") return null;

  return {
    target,
    resource: decodedResource,
    kind: "path",
    ...(line === undefined ? {} : { line }),
    ...(column === undefined ? {} : { column }),
  };
}
