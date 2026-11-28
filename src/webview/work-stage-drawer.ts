import * as l10n from "@vscode/l10n";
import { closeGlyphButton } from "./close-button";
import type { DrawerOccupant, DrawerSlot } from "./drawer-slot";
import { element as el } from "./element";
import { sameStageFacts, sentCommandIds, stageFactsOf, type StageSource } from "./work-stage-facts";
import type { StageFactsPort, StageHandlePort, StageModulePort } from "./work-stage-port";
import { workStageMountCast, type WorkStageCast } from "../work-stage-cast";
import { workStageText } from "./work-stage-strings";
import { nextAskStaleDelay } from "./you-items";

export interface WorkStageDrawerHost {
  source(tabId: string): StageSource | undefined;
  subscribe(tabId: string, listener: () => void): (() => void) | undefined;
  persistOpen(open: boolean): void;
}

interface StageLocation {
  readonly script: string;
  readonly data: string;
  readonly assets: string;
  readonly scriptGlobal: string;
  readonly dataGlobal: string;
}

type StageState = "none" | "loading" | "mounted" | "failed";

function stageLocation(): StageLocation | undefined {
  const data = document.getElementById("app")?.dataset;
  const [scriptGlobal, dataGlobal] = (data?.workStageGlobals ?? "").split(",");
  if (!data?.workStageScript || !data.workStageData || data.workStageAssets === undefined || !scriptGlobal || !dataGlobal) return undefined;
  return { script: data.workStageScript, data: data.workStageData, assets: data.workStageAssets, scriptGlobal, dataGlobal };
}

function addScript(src: string): Promise<HTMLScriptElement> {
  return new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.nonce = (document.getElementById("laisora-main-script") as HTMLScriptElement | null)?.nonce ?? "";
    script.src = src;
    script.onload = () => resolve(script);
    script.onerror = () => {
      script.remove();
      reject(new Error(`could not load ${src}`));
    };
    document.head.append(script);
  });
}

const globalOf = (name: string): unknown => (window as unknown as Record<string, unknown>)[name];

const stageModuleOf = (location: StageLocation): StageModulePort | undefined => {
  const module = globalOf(location.scriptGlobal) as StageModulePort | undefined;
  return typeof module?.mountStage === "function" ? module : undefined;
};

let stageLoad: Promise<{ module: StageModulePort; dataLoaded: boolean }> | null = null;

function loadStage(location: StageLocation): Promise<{ module: StageModulePort; dataLoaded: boolean }> {
  if (stageLoad) return stageLoad;
  const loading = (async () => {
    const dataScript = globalOf(location.dataGlobal) === undefined ? await addScript(location.data).catch(() => undefined) : undefined;
    const dataLoaded = globalOf(location.dataGlobal) !== undefined;
    if (!dataLoaded) dataScript?.remove();
    try {
      let module = stageModuleOf(location);
      if (!module) {
        const script = await addScript(location.script);
        module = stageModuleOf(location);
        if (!module) {
          script.remove();
          throw new Error(`${location.scriptGlobal} is missing`);
        }
      }
      return { module, dataLoaded };
    } catch (error) {
      dataScript?.remove();
      throw error;
    }
  })();
  stageLoad = loading;
  const forget = (): void => { if (stageLoad === loading) stageLoad = null; };
  loading.then((loaded) => { if (!loaded.dataLoaded) forget(); }, forget);
  return loading;
}

export class WorkStageDrawer implements DrawerOccupant {
  readonly button: HTMLButtonElement;
  private drawer: { root: HTMLElement; head: HTMLElement; body: HTMLElement } | null = null;
  private enabled: boolean | undefined;
  private wantOpen: boolean;
  private tabId: string | null = null;
  private visible = false;
  private state: StageState = "none";
  private handle: StageHandlePort | null = null;
  private mountToken = 0;
  private revision = 0;
  private lastSent: StageFactsPort | null = null;
  private unsubscribe: (() => void) | undefined;
  private staleTimer: ReturnType<typeof setTimeout> | undefined;
  private cast: WorkStageCast | undefined;

  constructor(private readonly host: WorkStageDrawerHost, private readonly slot: DrawerSlot, savedOpen: boolean) {
    this.wantOpen = savedOpen;
    this.button = el("button", "work-stage-btn");
    this.button.type = "button";
    this.button.id = "workstagebtn";
    this.button.hidden = true;
    this.button.setAttribute("aria-haspopup", "dialog");
    this.button.setAttribute("aria-expanded", "false");
    this.button.setAttribute("aria-controls", "workstagedrawer");
    this.button.setAttribute("aria-label", l10n.t("Work stage"));
    const icon = el("span", "l-icon l-icon-room");
    icon.setAttribute("aria-hidden", "true");
    this.button.append(icon);
    this.button.addEventListener("click", () => this.toggle());
    this.syncButton();
  }

  get root(): HTMLElement {
    return this.ensureDrawer().root;
  }

  get isOpen(): boolean {
    return this.shown();
  }

  configure(enabled: boolean, cast: WorkStageCast | undefined): void {
    const recast = JSON.stringify(cast) !== JSON.stringify(this.cast);
    this.cast = cast;
    const remount = recast && this.state !== "none";
    if (remount) this.disposeStage();
    if (this.enabled !== enabled) {
      this.enabled = enabled;
      if (!enabled && this.wantOpen) this.setWant(false);
    } else if (!remount) return;
    this.sync(false);
  }

  setActiveTab(tabId: string | null): void {
    const changed = this.tabId !== tabId;
    this.tabId = tabId;
    if (changed) this.sync(false);
    else if (this.state === "mounted") this.watchTab();
  }

  refresh(tabId: string | null): void {
    if (tabId !== null && tabId === this.tabId) this.push();
  }

  release(): void {
    this.setWant(false);
    this.sync(false);
  }

  minHeight(): number {
    if (!this.drawer) return 0;
    return this.drawer.head.getBoundingClientRect().height + (Number.parseFloat(getComputedStyle(this.drawer.body).minHeight) || 0);
  }

  private toggle(): void {
    if (this.tabId === null || this.enabled !== true) return;
    const open = !this.shown();
    this.setWant(open);
    this.sync(open);
    if (!open) this.button.focus();
  }

  private setWant(open: boolean): void {
    this.wantOpen = open;
    this.host.persistOpen(open);
  }

  private shown(): boolean {
    return this.wantOpen && this.enabled === true && this.tabId !== null;
  }

  private syncButton(): void {
    this.button.hidden = this.enabled !== true;
    this.button.disabled = this.tabId === null;
    this.button.title = this.tabId === null ? l10n.t("The work stage opens in a conversation tab.") : l10n.t("Work stage");
    this.button.setAttribute("aria-expanded", this.shown() ? "true" : "false");
  }

  private ensureDrawer(): { root: HTMLElement; head: HTMLElement; body: HTMLElement } {
    if (this.drawer) return this.drawer;
    const title = l10n.t("Work stage");
    const root = el("aside", "work-stage-drawer");
    root.id = "workstagedrawer";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", title);
    root.hidden = true;
    root.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
      event.preventDefault();
      event.stopPropagation();
      this.close();
    });
    const head = el("header", "work-stage-drawer-head");
    const heading = el("h2", "work-stage-drawer-title", title);
    heading.append(" ", el("span", "work-stage-beta", l10n.t("Beta")));
    const close = closeGlyphButton(el("button", "work-stage-drawer-close"), l10n.t("Close the drawer (Esc)"));
    close.type = "button";
    close.setAttribute("aria-keyshortcuts", "Escape");
    close.addEventListener("click", () => this.close());
    head.append(heading, close);
    const body = el("div", "work-stage-drawer-body");
    root.append(head, body);
    document.getElementById("app")!.append(root);
    this.drawer = { root, head, body };
    return this.drawer;
  }

  private close(): void {
    this.setWant(false);
    this.sync(false);
    this.button.focus();
  }

  private sync(focus: boolean): void {
    this.syncButton();
    if (!this.shown()) {
      this.visible = false;
      if (this.drawer) this.drawer.root.hidden = true;
      this.slot.close(this);
      this.disposeStage();
      return;
    }
    const opening = !this.visible;
    this.visible = true;
    const drawer = this.ensureDrawer();
    drawer.root.hidden = false;
    this.slot.open(this, this.tabId);
    if (this.state === "mounted") this.watchTab();
    else if (this.state === "none" || (this.state === "failed" && opening)) void this.mount();
    if (focus) queueMicrotask(() => drawer.root.querySelector<HTMLElement>("button, [tabindex]:not([tabindex='-1'])")?.focus());
  }

  private async mount(): Promise<void> {
    const token = ++this.mountToken;
    this.state = "loading";
    const drawer = this.ensureDrawer();
    const location = stageLocation();
    try {
      if (!location) throw new Error("the work stage is not in this build");
      const { module } = await loadStage(location);
      if (token !== this.mountToken) return;
      drawer.body.replaceChildren();
      this.handle = module.mountStage(drawer.body, {
        manifest: globalOf(location.dataGlobal) ?? { chars: {} },
        assetsBase: location.assets,
        locale: document.documentElement.lang,
        text: workStageText(),
        ...(this.cast ? workStageMountCast(this.cast) : {}),
      });
      this.state = "mounted";
      this.watchTab();
    } catch {
      if (token === this.mountToken) this.fail();
    }
  }

  private fail(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    clearTimeout(this.staleTimer);
    this.staleTimer = undefined;
    try { this.handle?.dispose(); } catch { }
    this.handle = null;
    this.lastSent = null;
    this.state = "failed";
    this.ensureDrawer().body.replaceChildren(el("p", "work-stage-error", l10n.t("The work stage could not be loaded.")));
  }

  private watchTab(): void {
    this.unsubscribe?.();
    this.unsubscribe = this.tabId === null ? undefined : this.host.subscribe(this.tabId, () => this.push());
    this.push();
  }

  private disposeStage(): void {
    this.mountToken += 1;
    this.state = "none";
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    clearTimeout(this.staleTimer);
    this.staleTimer = undefined;
    this.handle?.dispose();
    this.handle = null;
    this.lastSent = null;
    this.drawer?.body.replaceChildren();
  }

  private push(): void {
    if (!this.handle || this.tabId === null) return;
    try {
      const source = this.host.source(this.tabId);
      if (!source) return;
      const nowMs = Date.now();
      clearTimeout(this.staleTimer);
      const staleDelay = nextAskStaleDelay(source.youItems, nowMs);
      this.staleTimer = staleDelay === null ? undefined : setTimeout(() => this.push(), staleDelay);
      const facts = stageFactsOf({ ...source, tabId: this.tabId, revision: this.revision + 1, nowMs, shownCommandIds: sentCommandIds(this.lastSent, this.tabId) });
      if (this.lastSent && sameStageFacts(this.lastSent, facts)) return;
      this.revision = facts.revision;
      this.lastSent = facts;
      this.handle.setFacts(facts);
    } catch {
      this.fail();
    }
  }
}
