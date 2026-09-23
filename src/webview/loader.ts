// dom.ts から値 import される。import を足さず、トップレベルで DOM に触れない（dom.ts の評価順の保証が崩れる）。
const SVG_NS = "http://www.w3.org/2000/svg";

export function createLoader(size: 12 | 16 = 16): SVGSVGElement {
  const element = <K extends keyof SVGElementTagNameMap>(name: K): SVGElementTagNameMap[K] => document.createElementNS(SVG_NS, name);
  const svg = element("svg");
  svg.setAttribute("class", "loader");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  const group = element("g");
  group.setAttribute("class", "loader-group");
  for (const name of ["a", "b", "c", "d"]) {
    const rect = element("rect");
    for (const [key, value] of Object.entries({ class: `loader-${name}`, x: "1", y: "1", width: "8", height: "8", rx: "1", fill: "currentColor" })) rect.setAttribute(key, value);
    group.append(rect);
  }
  svg.append(group);
  return svg;
}
