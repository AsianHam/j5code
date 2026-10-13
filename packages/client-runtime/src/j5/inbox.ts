import type { HumanInboxResponse, ScopedHumanInboxItem } from "@t3tools/contracts/j5";

import type { J5ReadSource, J5ReadSources } from "./readSources.ts";

export type PresentedHumanInboxItem = ScopedHumanInboxItem & {
  readonly environmentLabel: string;
  readonly connected: boolean;
  /**
   * The item's server is connected and its inbox read is current. Whether this session may
   * answer is the answer command's `permissionAtom`.
   */
  readonly sourceReady: boolean;
};

const urgencyOrder = { blocking: 0, soon: 1, fyi: 2 } as const;

export function mergeHumanInboxSources(input: J5ReadSources<HumanInboxResponse>) {
  const items: Array<PresentedHumanInboxItem> = input.sources.flatMap((source) =>
    (source.data?.items ?? []).map((item) => ({
      ...item,
      environmentId: source.environmentId,
      environmentLabel: source.environmentLabel,
      connected: source.connected,
      sourceReady: source.status === "ready",
    })),
  );
  items.sort(
    (left, right) =>
      urgencyOrder[left.urgency] - urgencyOrder[right.urgency] ||
      left.openedAt.localeCompare(right.openedAt) ||
      left.environmentId.localeCompare(right.environmentId) ||
      left.exchangeId.localeCompare(right.exchangeId),
  );
  return items;
}

export function mergeOpenInboxCounts(
  input: J5ReadSources<{ readonly personId: string; readonly count: number }>,
) {
  const known = input.sources.filter((source) => source.data !== null);
  return {
    count: known.length === 0 ? null : known.reduce((sum, source) => sum + source.data!.count, 0),
    incomplete:
      !input.isReady ||
      input.sources.some((source) => source.status !== "ready" && source.status !== "unsupported"),
  };
}

export function j5SourceNotice(source: J5ReadSource<unknown>): string | null {
  switch (source.status) {
    case "ready":
      return null;
    case "loading":
      return `${source.environmentLabel}: loading…`;
    case "offline":
      return `${source.environmentLabel}: offline${source.data === null ? "" : " — showing saved results"}.`;
    case "unsupported":
      return source.guest === true
        ? "Nothing from a server you are a guest on appears here."
        : `${source.environmentLabel}: this server does not provide this J5 feature.`;
    case "error":
      return `${source.environmentLabel}: ${source.error ?? "could not refresh"}${source.data === null ? "" : " — showing saved results."}`;
  }
}
