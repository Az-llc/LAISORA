import { todoOverlayTop } from "./todo-edit";

export interface DrawerSlotPlace {
  rail(tabId: string): HTMLElement | null;
  railElement(tabId: string): HTMLElement | null;
  readonly composer: HTMLElement;
}

export interface DrawerOccupant {
  readonly root: HTMLElement;
  release(): void;
  minHeight(): number;
}

export class DrawerSlot {
  private occupant: DrawerOccupant | null = null;
  private tabId: string | null = null;
  private hiddenRail: HTMLElement | null = null;
  private watching = false;
  private watchedRail: HTMLElement | null = null;
  readonly relayout = (): void => { if (this.occupant) this.place(this.occupant, this.tabId); };
  private readonly resized = new ResizeObserver(this.relayout);

  constructor(private readonly where: DrawerSlotPlace) {}

  open(occupant: DrawerOccupant, tabId: string | null): void {
    const previous = this.occupant;
    this.occupant = occupant;
    if (previous && previous !== occupant) previous.release();
    this.place(occupant, tabId);
  }

  close(occupant: DrawerOccupant): void {
    if (this.occupant !== occupant) return;
    this.occupant = null;
    this.tabId = null;
    this.showRail(null);
    this.watch(false);
  }

  place(occupant: DrawerOccupant, tabId: string | null): void {
    if (this.occupant !== occupant) return;
    this.tabId = tabId;
    const railElement = tabId === null ? null : this.where.railElement(tabId);
    if (!this.watching || railElement !== this.watchedRail) this.watch(true, railElement);
    this.layout(occupant);
  }

  private watch(on: boolean, railElement: HTMLElement | null = null): void {
    this.resized.disconnect();
    window.removeEventListener("resize", this.relayout);
    this.watching = on;
    this.watchedRail = on ? railElement : null;
    if (!on) return;
    window.addEventListener("resize", this.relayout);
    this.resized.observe(this.where.composer);
    if (railElement) this.resized.observe(railElement);
  }

  private layout(occupant: DrawerOccupant): void {
    const root = occupant.root;
    const rail = this.tabId !== null ? this.where.rail(this.tabId) : null;
    this.showRail(rail);
    root.classList.toggle("in-rail", rail !== null);
    const composer = this.where.composer;
    const composerTop = composer.getClientRects().length === 0 ? window.innerHeight : composer.getBoundingClientRect().top;
    root.style.bottom = `${Math.max(window.innerHeight - composerTop, 0)}px`;
    const overlayTop = todoOverlayTop();
    if (!rail) {
      for (const prop of ["left", "width"]) root.style.removeProperty(prop);
      root.style.top = `${overlayTop}px`;
      return;
    }
    const rect = rail.getBoundingClientRect();
    root.style.left = `${rect.left}px`;
    root.style.top = `${Math.max(overlayTop, Math.min(rect.top, composerTop - occupant.minHeight()))}px`;
    root.style.width = `${rect.width}px`;
    rail.style.visibility = "hidden";
    this.hiddenRail = rail;
  }

  private showRail(keep: HTMLElement | null): void {
    if (this.hiddenRail && this.hiddenRail !== keep) {
      this.hiddenRail.style.visibility = "";
      this.hiddenRail = null;
    }
  }
}
