import { assert, describe, it } from "@effect/vitest";

import { codexApplicationContext } from "./codexApplicationContext.ts";

describe("codexApplicationContext", () => {
  it("spreads long persona instructions over numbered keys that each fit Codex's entry cap", () => {
    const instructions = Array.from(
      { length: 200 },
      (_, index) => `${index + 1}. Review each change against the brief before reporting it.`,
    ).join("\n");
    const entries = codexApplicationContext("j5_agent_persona", instructions);
    const keys = Object.keys(entries);

    assert.isAbove(keys.length, 1);
    assert.deepEqual(
      keys,
      keys.map((_, index) => (index === 0 ? "j5_agent_persona" : `j5_agent_persona_${index + 1}`)),
    );
    for (const entry of Object.values(entries)) {
      assert.equal(entry.kind, "application");
      assert.isAtMost(Buffer.byteLength(entry.value), 3_600);
    }
    assert.equal(
      Object.values(entries)
        .map((entry) => entry.value)
        .join("\n"),
      instructions,
    );
  });

  it("keeps short text in the one given key and sends nothing for no text", () => {
    assert.deepEqual(codexApplicationContext("j5_agent_persona", "  Builder instructions\n"), {
      j5_agent_persona: { kind: "application", value: "Builder instructions" },
    });
    assert.deepEqual(codexApplicationContext("j5_agent_persona", undefined), {});
    assert.deepEqual(codexApplicationContext("j5_agent_persona", "  \n"), {});
  });
});
