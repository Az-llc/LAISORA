import {
  ALLOWED_IMAGE_MEDIA_TYPES,
  IMAGE_MAX_BASE64_LEN,
  IMAGE_MAX_COUNT,
  type ImageAttachment,
  type PendingAttachmentInfo,
} from "./protocol";

export type AttachRejection = "unsupported-media-type" | "oversize" | "slots-full";

export type AttachOutcome = { ok: true; id: string } | { ok: false; reason: AttachRejection };

interface Slot {
  id: string;
  mediaType: ImageAttachment["mediaType"];
  data: string;
}

export class PendingAttachmentStore {
  private readonly byTab = new Map<string, Slot[]>();
  private seq = 0;

  attach(tabId: string, mediaType: string, data: string): AttachOutcome {
    if (!ALLOWED_IMAGE_MEDIA_TYPES.includes(mediaType as ImageAttachment["mediaType"])) {
      return { ok: false, reason: "unsupported-media-type" };
    }
    if (typeof data !== "string" || data.length === 0 || data.length > IMAGE_MAX_BASE64_LEN) {
      return { ok: false, reason: "oversize" };
    }
    const slots = this.byTab.get(tabId) ?? [];
    if (slots.length >= IMAGE_MAX_COUNT) return { ok: false, reason: "slots-full" };
    const id = `att-${++this.seq}`;
    slots.push({ id, mediaType: mediaType as ImageAttachment["mediaType"], data });
    this.byTab.set(tabId, slots);
    return { ok: true, id };
  }

  infos(tabId: string): PendingAttachmentInfo[] {
    return (this.byTab.get(tabId) ?? []).map((s) => ({ id: s.id, mediaType: s.mediaType, data: s.data }));
  }

  count(tabId: string): number {
    return (this.byTab.get(tabId) ?? []).length;
  }

  remove(tabId: string, attachmentId: string): boolean {
    const slots = this.byTab.get(tabId);
    if (!slots) return false;
    const at = slots.findIndex((s) => s.id === attachmentId);
    if (at < 0) return false;
    slots.splice(at, 1);
    if (slots.length === 0) this.byTab.delete(tabId);
    return true;
  }

  take(tabId: string): ImageAttachment[] | undefined {
    const slots = this.byTab.get(tabId);
    if (!slots || slots.length === 0) return undefined;
    this.byTab.delete(tabId);
    return slots.map((s) => ({ mediaType: s.mediaType, data: s.data }));
  }

  release(tabId: string): void {
    this.byTab.delete(tabId);
  }

  sweep(liveTabIds: ReadonlySet<string>): string[] {
    const dropped: string[] = [];
    for (const tabId of [...this.byTab.keys()]) {
      if (liveTabIds.has(tabId)) continue;
      this.byTab.delete(tabId);
      dropped.push(tabId);
    }
    return dropped;
  }

  tabIdsWithAttachments(): string[] {
    return [...this.byTab.keys()];
  }
}

export const pendingAttachments = new PendingAttachmentStore();
