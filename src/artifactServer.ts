import { randomBytes } from "node:crypto";
import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import * as l10n from "@vscode/l10n";

export type ArtifactMime = "text/html" | "image/svg+xml";

const ARTIFACT_MAX_COUNT = 100;

interface Artifact {
  content: string;
  mime: ArtifactMime;
  version: number;
}

export class ArtifactServer {
  private readonly artifacts = new Map<string, Artifact>();
  private readonly idsByKey = new Map<string, string>();
  private readonly token = randomBytes(24).toString("hex");
  private server: Server | null = null;
  private startPromise: Promise<number> | null = null;
  private disposed = false;
  private disposePromise: Promise<void> | null = null;

  async register(key: string, content: string, mime: ArtifactMime): Promise<string> {
    if (this.disposed) throw new Error("ArtifactServer is disposed");
    const port = await this.ensureStarted();
    if (this.disposed) throw new Error("ArtifactServer is disposed");

    let id = this.idsByKey.get(key);
    if (!id) {
      if (this.idsByKey.size >= ARTIFACT_MAX_COUNT) {
        const oldestKey = this.idsByKey.keys().next().value as string | undefined;
        if (oldestKey !== undefined) {
          const oldestId = this.idsByKey.get(oldestKey);
          this.idsByKey.delete(oldestKey);
          if (oldestId) this.artifacts.delete(oldestId);
        }
      }
      id = randomBytes(16).toString("hex");
      this.idsByKey.set(key, id);
      this.artifacts.set(id, { content, mime, version: 1 });
    } else {
      const current = this.artifacts.get(id);
      this.artifacts.set(id, {
        content,
        mime,
        version: (current?.version ?? 0) + 1,
      });
    }

    return `http://127.0.0.1:${port}/a/${this.token}/${id}`;
  }

  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.disposed = true;
    this.artifacts.clear();
    this.idsByKey.clear();
    this.disposePromise = this.disposeStartedServer();
    return this.disposePromise;
  }

  private async disposeStartedServer(): Promise<void> {
    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch {}
    }
    const server = this.server;
    this.server = null;
    this.startPromise = null;
    if (!server) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private ensureStarted(): Promise<number> {
    if (this.disposed) return Promise.reject(new Error("ArtifactServer is disposed"));
    if (this.startPromise) return this.startPromise;
    this.startPromise = new Promise<number>((resolve, reject) => {
      const server = createServer((request, response) =>
        this.handleRequestSafely(request, response)
      );
      const onError = (error: Error): void => {
        this.server = null;
        this.startPromise = null;
        reject(error);
      };
      server.once("error", onError);
      server.listen(0, "127.0.0.1", () => {
        server.off("error", onError);
        if (this.disposed) {
          server.closeAllConnections();
          server.close(() => reject(new Error("ArtifactServer is disposed")));
          return;
        }
        server.on("error", () => {});
        const address = server.address() as AddressInfo;
        this.server = server;
        resolve(address.port);
      });
    });
    return this.startPromise;
  }

  private handleRequestSafely(request: IncomingMessage, response: ServerResponse): void {
    try {
      this.handleRequest(request, response);
    } catch {
      try {
        if (response.headersSent) response.destroy();
        else this.notFound(response);
      } catch {
        response.destroy();
      }
    }
  }

  private handleRequest(request: IncomingMessage, response: ServerResponse): void {
    if (request.method !== "GET") {
      this.notFound(response);
      return;
    }

    let pathname: string;
    try {
      pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      this.notFound(response);
      return;
    }
    const parts = pathname.split("/").filter(Boolean);
    if (parts.length < 3 || parts[0] !== "a" || parts[1] !== this.token) {
      this.notFound(response);
      return;
    }

    const id = parts[2];
    const artifact = this.artifacts.get(id);
    if (!artifact) {
      this.notFound(response);
      return;
    }

    if (parts.length === 3) {
      const address = this.server?.address() as AddressInfo;
      this.send(
        response,
        200,
        "text/html; charset=utf-8",
        this.wrapperPage(`http://127.0.0.1:${address.port}${pathname}`, artifact.version)
      );
      return;
    }
    if (parts.length === 4 && parts[3] === "raw") {
      // /raw を直接開いてもラッパーと同じ制約にする。default-src 'none' はフォーム送信と base 差し替えを
      // 止めない（form-action / base-uri は default-src に fallback しない）。ヘッダの sandbox で
      // iframe 無しでも opaque origin に落とす
      this.send(response, 200, `${artifact.mime}; charset=utf-8`, artifact.content, {
        "Content-Security-Policy":
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'; sandbox allow-scripts;",
      });
      return;
    }
    if (parts.length === 4 && parts[3] === "version") {
      this.send(
        response,
        200,
        "application/json; charset=utf-8",
        JSON.stringify({ version: artifact.version })
      );
      return;
    }
    this.notFound(response);
  }

  private send(
    response: ServerResponse,
    status: number,
    contentType: string,
    body: string,
    headers: Record<string, string> = {}
  ): void {
    response.writeHead(status, {
      "Cache-Control": "no-store",
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
      ...headers,
    });
    response.end(body);
  }

  private notFound(response: ServerResponse): void {
    this.send(response, 404, "text/plain; charset=utf-8", "Not Found");
  }

  private wrapperPage(url: string, version: number): string {
    const rawUrl = `${url}/raw`;
    const versionUrl = `${url}/version`;
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; frame-src 'self'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LAISORA Artifact Preview</title>
<style>
  :root { color-scheme: dark; font-family: system-ui, sans-serif; }
  * { box-sizing: border-box; }
  html, body { width: 100%; height: 100%; margin: 0; }
  body { display: flex; flex-direction: column; color: #d4d4d4; background: #1e1e1e; }
  .toolbar { display: flex; align-items: center; gap: 6px; min-height: 42px; padding: 6px 10px; border-bottom: 1px solid #3c3c3c; background: #252526; }
  button, a { border: 1px solid #4b4b4b; border-radius: 4px; padding: 5px 9px; color: #d4d4d4; background: #333; font: inherit; text-decoration: none; cursor: pointer; }
  button:hover, a:hover { background: #3f3f46; }
  button[aria-pressed="true"] { border-color: #007acc; background: #094771; }
  a { margin-left: auto; }
  main { flex: 1; min-height: 0; overflow: auto; padding: 12px; }
  iframe { display: block; height: 100%; min-height: 480px; margin: 0 auto; border: 1px solid #555; background: #fff; }
  body[data-width="mobile"] iframe { width: 375px; max-width: 100%; }
  body[data-width="desktop"] iframe { width: 100%; }
</style>
</head>
<body data-width="mobile">
  <div class="toolbar" role="toolbar" aria-label="${l10n.t("Preview width")}">
    <button id="mobile" type="button" aria-pressed="true">📱 375px</button>
    <button id="desktop" type="button" aria-pressed="false">💻 100%</button>
    <a href="${url}" target="_blank" rel="noopener noreferrer">⧉ ${l10n.t("Open in external browser")}</a>
  </div>
  <main><iframe id="preview" title="${l10n.t("Artifact preview")}" src="${rawUrl}" sandbox="allow-scripts"></iframe></main>
<script>
  const mobile = document.getElementById("mobile");
  const desktop = document.getElementById("desktop");
  const preview = document.getElementById("preview");
  function setWidth(width) {
    document.body.dataset.width = width;
    mobile.setAttribute("aria-pressed", String(width === "mobile"));
    desktop.setAttribute("aria-pressed", String(width === "desktop"));
  }
  mobile.addEventListener("click", () => setWidth("mobile"));
  desktop.addEventListener("click", () => setWidth("desktop"));
  let version = ${version};
  async function poll() {
    try {
      const response = await fetch("${versionUrl}", { cache: "no-store" });
      if (!response.ok) return;
      const next = (await response.json()).version;
      if (version !== undefined && next !== version) preview.src = "${rawUrl}?v=" + next;
      version = next;
    } catch {}
  }
  poll();
  setInterval(poll, 2000);
</script>
</body>
</html>`;
  }
}
