import * as l10n from "@vscode/l10n";
import {
  elicitationDraftOf,
  elicitationMarkedRequired,
  elicitationMaxItems,
  elicitationMaxLength,
  localDateTimeToRfc3339,
  rfc3339ToLocalDateTime,
  validateElicitationContent,
  type ElicitationField,
  type ElicitationIssueKind,
  type ElicitationSpec,
  type ElicitationStringFormat,
  type ElicitationValue,
} from "../elicitation";
import { approvalField, approvalLead } from "./approval";

export type ElicitationDecision = { behavior: "allow"; content?: Record<string, ElicitationValue> } | { behavior: "deny" };

const offsetEastAt = (epochMs: number): number => -new Date(epochMs).getTimezoneOffset();

function issueText(field: ElicitationField, kind: ElicitationIssueKind): string {
  switch (kind) {
    case "required":
      return field.kind === "choice" || field.kind === "choices" ? l10n.t("Choose an option.") : l10n.t("Enter a value.");
    case "type":
      return field.kind === "number" ? (field.integer ? l10n.t("Enter a whole number.") : l10n.t("Enter a number.")) : l10n.t("Enter a valid value.");
    case "format":
      if (field.kind !== "text") return l10n.t("Enter a valid value.");
      switch (field.format) {
        case "email": return l10n.t("Enter an email address.");
        case "uri": return l10n.t("Enter a URL.");
        case "date": return l10n.t("Enter a date.");
        default: return l10n.t("Enter a date and time.");
      }
    case "length":
      if (field.kind !== "text") return l10n.t("Enter a valid value.");
      return field.minLength !== undefined
        ? l10n.t("Enter {0} to {1} characters.", field.minLength, elicitationMaxLength(field))
        : l10n.t("Enter at most {0} characters.", elicitationMaxLength(field));
    case "range":
      if (field.kind !== "number") return l10n.t("Enter a valid value.");
      if (field.minimum !== undefined && field.maximum !== undefined) return l10n.t("Enter a number from {0} to {1}.", field.minimum, field.maximum);
      return field.minimum !== undefined ? l10n.t("Enter {0} or more.", field.minimum) : l10n.t("Enter {0} or less.", field.maximum ?? 0);
    case "option":
      return l10n.t("Choose one of the options.");
    case "count":
      if (field.kind !== "choices") return l10n.t("Enter a valid value.");
      return field.minItems !== undefined
        ? l10n.t("Choose {0} to {1}.", field.minItems, elicitationMaxItems(field))
        : l10n.t("Choose at most {0}.", elicitationMaxItems(field));
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const TEXT_INPUT_TYPES: Record<ElicitationStringFormat, string> = { email: "email", uri: "url", date: "date", "date-time": "datetime-local" };

interface FieldView {
  field: ElicitationField;
  root: HTMLElement;
  focus: HTMLElement;
  controls: HTMLElement[];
  error: HTMLElement;
}

function fieldView(field: ElicitationField, id: string, draft: Record<string, ElicitationValue | undefined>, changed: () => void): FieldView {
  const root = el("div", `elicit-field elicit-${field.kind}`);
  const labelText = field.title ?? field.name;
  const descId = `${id}-desc`;
  const errId = `${id}-err`;
  const error = el("div", "elicit-error");
  error.id = errId;
  error.setAttribute("aria-live", "polite");
  const description = field.description !== undefined ? el("div", "elicit-desc", field.description) : undefined;
  if (description) description.id = descId;
  const describedBy = [description ? descId : "", errId].filter(Boolean).join(" ");
  const label = el(field.kind === "choices" ? "legend" : "label", "elicit-label", labelText);
  const marked = elicitationMarkedRequired(field);
  if (marked) {
    const mark = el("span", "elicit-required", "*");
    mark.title = l10n.t("Required");
    mark.setAttribute("aria-hidden", "true");
    label.append(mark);
  }
  const wire = (control: HTMLElement): HTMLElement => {
    control.id = id;
    control.setAttribute("aria-describedby", describedBy);
    if (marked) control.setAttribute("aria-required", "true");
    (label as HTMLLabelElement).htmlFor = id;
    return control;
  };
  switch (field.kind) {
    case "boolean": {
      const box = wire(el("input", "elicit-check")) as HTMLInputElement;
      box.type = "checkbox";
      box.checked = draft[field.name] === true;
      box.addEventListener("change", () => { draft[field.name] = box.checked; changed(); });
      const line = el("div", "elicit-check-line");
      line.append(box, label);
      root.append(line, ...(description ? [description] : []), error);
      return { field, root, focus: box, controls: [box], error };
    }
    case "choice": {
      const select = wire(el("select", "elicit-input")) as HTMLSelectElement;
      const current = typeof draft[field.name] === "string" ? (draft[field.name] as string) : "";
      if (!field.required || current === "") select.append(new Option(l10n.t("(Not selected)"), ""));
      for (const option of field.options) select.append(new Option(option.label, option.value));
      select.value = current;
      select.addEventListener("change", () => { draft[field.name] = select.value; changed(); });
      root.append(label, ...(description ? [description] : []), select, error);
      return { field, root, focus: select, controls: [select], error };
    }
    case "choices": {
      const set = el("fieldset", "elicit-choices");
      set.setAttribute("aria-describedby", describedBy);
      const picked = new Set(Array.isArray(draft[field.name]) ? (draft[field.name] as string[]) : []);
      const boxes = field.options.map((option, index) => {
        const box = el("input", "elicit-check");
        box.type = "checkbox";
        box.id = `${id}-${index}`;
        box.checked = picked.has(option.value);
        box.addEventListener("change", () => {
          if (box.checked) picked.add(option.value);
          else picked.delete(option.value);
          draft[field.name] = field.options.map((o) => o.value).filter((v) => picked.has(v));
          changed();
        });
        const optionLabel = el("label", "elicit-option", option.label);
        optionLabel.htmlFor = box.id;
        const line = el("div", "elicit-check-line");
        line.append(box, optionLabel);
        return { box, line };
      });
      set.append(label, ...boxes.map((b) => b.line));
      root.append(set, ...(description ? [description] : []), error);
      return { field, root, focus: boxes[0]?.box ?? set, controls: boxes.map((b) => b.box), error };
    }
    default: {
      const input = wire(el("input", "elicit-input")) as HTMLInputElement;
      const dateTime = field.kind === "text" && field.format === "date-time";
      input.type = field.kind === "text" && field.format !== undefined ? TEXT_INPUT_TYPES[field.format] : "text";
      if (field.kind === "number") input.inputMode = field.integer ? "numeric" : "decimal";
      if (dateTime) input.step = "1";
      const value = draft[field.name];
      input.value = typeof value !== "string" ? "" : dateTime ? rfc3339ToLocalDateTime(value, offsetEastAt) ?? "" : value;
      if (dateTime && input.value === "") draft[field.name] = "";
      input.addEventListener("input", () => {
        draft[field.name] = !dateTime || input.value === ""
          ? input.value
          : localDateTimeToRfc3339(input.value, offsetEastAt(new Date(input.value).getTime())) ?? input.value;
        changed();
      });
      root.append(label, ...(description ? [description] : []), input, error);
      return { field, root, focus: input, controls: [input], error };
    }
  }
}

export function enableElicitationOpen(card: HTMLElement): void {
  const decline = card.querySelector<HTMLButtonElement>("button[data-elicitation-decline]");
  const open = card.querySelector<HTMLButtonElement>("button[data-elicitation-open]");
  if (open !== null && decline !== null && !decline.disabled) open.disabled = false;
}

export function buildElicitationCard(
  spec: ElicitationSpec,
  rawInputJson: string,
  idPrefix: string,
  decide: (decision: ElicitationDecision) => void
): { body: HTMLElement[]; actions: HTMLElement } {
  const body: HTMLElement[] = [];
  if (spec.title !== undefined) body.push(el("div", "elicit-title", spec.title));
  if (spec.description !== undefined) body.push(el("div", "elicit-desc", spec.description));
  const lead = approvalLead(spec.message);
  lead.classList.add("elicit-message");
  body.push(lead, approvalField(l10n.t("Server"), spec.server));
  const actions = el("div", "approval-actions");
  const decline = el("button", "danger", l10n.t("Decline"));
  decline.type = "button";
  decline.dataset.elicitationDecline = "";
  decline.onclick = () => decide({ behavior: "deny" });

  if (spec.mode === "url") {
    if (spec.urlHost !== undefined) body.push(approvalField(l10n.t("Site"), spec.urlHost));
    if (spec.url !== undefined) body.push(approvalField("URL", spec.url, true));
    if (spec.urlHost !== undefined) {
      const open = el("button", "primary", l10n.t("Open"));
      open.type = "button";
      open.dataset.elicitationOpen = "";
      open.onclick = () => {
        open.disabled = true;
        decide({ behavior: "allow" });
      };
      actions.append(open);
    } else {
      body.push(el("div", "elicit-note", l10n.t("LAISORA opens only http and https links, so this one can't be opened here.")));
    }
  } else if (spec.fields === undefined) {
    body.push(el("div", "elicit-note", l10n.t("This form can't be shown here. Decline it, or check the raw data.")));
  } else {
    const fields = spec.fields;
    const draft = elicitationDraftOf(fields);
    let attempted = false;
    const views: FieldView[] = [];
    const showIssues = (): boolean => {
      const { issues } = validateElicitationContent(fields, draft);
      const byField = new Map(issues.map((issue) => [issue.field, issue.kind]));
      for (const view of views) {
        const kind = byField.get(view.field.name);
        view.error.textContent = kind === undefined ? "" : issueText(view.field, kind);
        for (const control of view.controls) control.setAttribute("aria-invalid", kind === undefined ? "false" : "true");
      }
      return issues.length === 0;
    };
    const form = el("div", "elicit-form");
    fields.forEach((field, index) => {
      const view = fieldView(field, `${idPrefix}-f${index}`, draft, () => { if (attempted) showIssues(); });
      views.push(view);
      form.append(view.root);
    });
    if (fields.length > 0) body.push(form);
    const send = el("button", "primary", l10n.t("Send"));
    send.type = "button";
    send.onclick = () => {
      attempted = true;
      if (!showIssues()) {
        views.find((view) => view.error.textContent !== "")?.focus.focus();
        return;
      }
      send.disabled = true;
      decide({ behavior: "allow", content: validateElicitationContent(fields, draft).content });
    };
    actions.append(send);
  }
  actions.append(decline);
  const raw = document.createElement("details");
  const rawSummary = document.createElement("summary");
  rawSummary.textContent = l10n.t("Show raw data (JSON)");
  const pre = document.createElement("pre");
  pre.textContent = rawInputJson;
  raw.append(rawSummary, pre);
  body.push(raw);
  return { body, actions };
}
