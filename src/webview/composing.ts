export function isComposingKey(e: KeyboardEvent | InputEvent): boolean {
  return e.isComposing || ("keyCode" in e && e.keyCode === 229);
}
