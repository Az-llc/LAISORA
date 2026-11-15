const JAPANESE_TEXT = /[぀-ヿ㐀-鿿]/;

export function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function markJapanese(node: HTMLElement, text: string): void {
  if (JAPANESE_TEXT.test(text)) node.lang = "ja";
}

export function textElement<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = element(tag, className, text);
  if (text !== undefined) markJapanese(node, text);
  return node;
}
