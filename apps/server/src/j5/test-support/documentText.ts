import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { DocumentText } from "../../provider/DocumentText.ts";

/** Attachment claims ask for a document's text; J5's tests attach no documents, so none is made. */
export const noDocumentTextLayer = Layer.succeed(
  DocumentText,
  DocumentText.of({
    ensure: Effect.fn("DocumentText.ensure")(function () {
      return Effect.undefined;
    }),
  }),
);
