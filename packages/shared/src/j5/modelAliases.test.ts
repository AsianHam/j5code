import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind } from "@t3tools/contracts";

import { normalizeModelSlug } from "../model.ts";

// J5 (FORK.md case 32): `astra`, `gpt-6` and `6` are explicit Codex aliases for GPT 6 Astra.
describe("J5 model slug aliases", () => {
  it.each(["astra", "gpt-6", "6"])("resolves %s to the Astra execution model", (alias) => {
    expect(normalizeModelSlug(alias, ProviderDriverKind.make("codex"))).toBe("gpt-6-astra");
  });
});
