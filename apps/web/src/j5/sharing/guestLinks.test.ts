import type { EnvironmentId } from "@t3tools/contracts";
import { AtomRegistry } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { canShareWithGuestAtom } from "../../components/chat/guestShareAvailability";

const ENVIRONMENT_ID = "environment-1" as EnvironmentId;

// A server that would offer guest links: the person may create them and the beta is on.
vi.mock("../../state/server", async () => {
  const { Atom } = await import("effect/reactivity");
  return { serverEnvironment: { createGuestShare: { permissionAtom: () => Atom.make(true) } } };
});
vi.mock("../../state/presentation", async () => {
  const { Atom } = await import("effect/reactivity");
  return {
    environmentPresentations: {
      serverConfigsAtom: Atom.make(
        new Map([["environment-1", { settings: { guestSharingEnabled: true } }]]),
      ),
    },
  };
});

describe("upstream's Share with guest in J5 (decision 12)", () => {
  it("is never offered, even where the server would allow it", () => {
    const registry = AtomRegistry.make();
    expect(registry.get(canShareWithGuestAtom(ENVIRONMENT_ID))).toBe(false);
  });
});
