export const MARKS = {
  foldClosed: "▸",
  foldOpen: "▾",
  disclosure: "›",
  submenu: "›",
  submenuTriangle: "▸",
  openPanel: "▸",
  go: "›",
  goTriangle: "▸",
  pathSeparator: "›",
  previous: "‹",
  next: "›",
  back: "‹",
  before: "◂",
  after: "▸",
  start: "▶",
  dropdown: "▾",
} as const;

export const foldGlyph = (open: boolean): string => open ? MARKS.foldOpen : MARKS.foldClosed;

export const FOLD_MARK_SLOT_PX = 19;

export const markProperty = (name: string): string => `--mark-${name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

export function foldMark(owner: Document): HTMLSpanElement {
  const mark = owner.createElement("span");
  mark.className = "fold-mark";
  mark.setAttribute("aria-hidden", "true");
  return mark;
}

export function installMarkProperties(root: HTMLElement): void {
  for (const [name, glyph] of Object.entries(MARKS)) root.style.setProperty(markProperty(name), JSON.stringify(glyph));
}
