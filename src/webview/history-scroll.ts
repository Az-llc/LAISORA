// Preserve the physical pixel phase of existing text while older content is
// inserted above it. scrollHeight rounds away fractional line heights.
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
      const quantum = 1; // scrollTop uses CSS pixels, independently of display density.
      const oldPadding = parseFloat(content.style.paddingTop) || 0;
      // A bounded, subpixel leading space makes the inserted height an exact
      // scroll step. It never changes message text or accumulates per page.
      const nextPadding = ((oldPadding - delta) % quantum + quantum) % quantum;
      content.style.paddingTop = `${nextPadding}px`;
      port.scrollTop = beforeScroll + delta + nextPadding - oldPadding;
      // Introducing leading padding can also stop a child's margin collapse.
      // Measure that layout change rather than assuming padding is the only delta.
      port.scrollTop += anchor.getBoundingClientRect().top - top;
    }
    return result;
  } finally {
    port.style.overflowAnchor = previous;
  }
}
