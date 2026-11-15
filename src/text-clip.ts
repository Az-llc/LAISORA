export function surrogateSafeEnd(text: string, at: number): number {
  if (at <= 0) return 0;
  if (at >= text.length) return text.length;
  const code = text.charCodeAt(at - 1);
  return code >= 0xd800 && code <= 0xdbff ? at - 1 : at;
}

export function clipText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, surrogateSafeEnd(text, max))}…` : text;
}
