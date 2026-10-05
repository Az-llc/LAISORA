export function prependPreservingView<T>(port: HTMLElement, content: HTMLElement, insert: () => T): T {
  const anchor = content.lastElementChild;
  const previous = port.style.overflowAnchor;
  port.style.overflowAnchor = "none";
  try {
    const top = anchor?.getBoundingClientRect().top;
    const beforeScroll = port.scrollTop;
    const result = insert();
    if (anchor?.isConnected && top !== undefined) {
      const delta = anchor.getBoundingClientRect().top - top;
      const quantum = 1;
      const oldPadding = parseFloat(content.style.paddingTop) || 0;
      const nextPadding = ((oldPadding - delta) % quantum + quantum) % quantum;
      content.style.paddingTop = `${nextPadding}px`;
      port.scrollTop = beforeScroll + delta + nextPadding - oldPadding;
      port.scrollTop += anchor.getBoundingClientRect().top - top;
    }
    return result;
  } finally {
    port.style.overflowAnchor = previous;
  }
}
