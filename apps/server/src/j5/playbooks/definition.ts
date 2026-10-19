// @effect-diagnostics nodeBuiltinImport:off - synchronous hashing for edit digests.
import * as NodeCrypto from "node:crypto";
import { PlaybookDefinition, PlaybookError, PLAYBOOK_MAX_BYTES } from "@t3tools/contracts/j5";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { parseDocument } from "yaml";

const isPlaybookError = Schema.is(PlaybookError);
const decodeDefinition = Schema.decodeUnknownEffect(PlaybookDefinition);

export const playbookError = (
  code: string,
  message: string,
  availableStepIds: ReadonlyArray<string> = [],
) => new PlaybookError({ code, message, availableStepIds });
export const storageError = (error: unknown) =>
  isPlaybookError(error)
    ? error
    : playbookError("operation_failed", error instanceof Error ? error.message : String(error));

/** The digest j5_playbook_read reports and an edit through j5_playbook_save must match. */
export const playbookDigest = (text: string) =>
  NodeCrypto.createHash("sha256").update(text).digest("hex");

/** Validate the original YAML without serializing it, preserving comments and byte limits. */
export const decodePlaybookDocument = Effect.fn("decodePlaybookDocument")(
  function* (text: string) {
    if (new TextEncoder().encode(text).length > PLAYBOOK_MAX_BYTES)
      return yield* playbookError("invalid_definition", "Use a YAML file no larger than 256 KiB.");
    const { document, raw } = yield* Effect.try(() => {
      const document = parseDocument(text, { version: "1.2", uniqueKeys: true });
      const issue = document.errors[0] ?? document.warnings[0];
      if (issue) throw issue;
      return { document, raw: document.toJS({ maxAliasCount: 0 }) as unknown };
    });
    const definition = yield* decodeDefinition(raw);
    const ids = definition.steps.map((step) => step.id);
    if (new Set(ids).size !== ids.length)
      return yield* playbookError(
        "invalid_definition",
        "Every playbook step must have a unique stable ID.",
        ids,
      );
    return { definition, document, text };
  },
  Effect.mapError((error) =>
    isPlaybookError(error) ? error : playbookError("invalid_definition", String(error)),
  ),
);
