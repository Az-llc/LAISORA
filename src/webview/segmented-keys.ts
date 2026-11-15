export function handleSegmentedArrow(event: KeyboardEvent, radios: HTMLButtonElement[], activate: (radio: HTMLButtonElement) => void, canNavigate: () => boolean = () => true): void {
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
  if (step === 0) return;
  event.preventDefault();
  const from = radios.findIndex((radio) => radio === document.activeElement);
  if (from < 0 || !canNavigate()) return;
  const target = radios[(from + step + radios.length) % radios.length];
  target.focus();
  activate(target);
}
