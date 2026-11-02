import { describe, expect, it } from "vite-plus/test";

import { isLegalDocumentUrl } from "./legal-document-url";

describe("isLegalDocumentUrl", () => {
  it.each(["https://j5.codes/legal", "https://j5.codes/privacy-policy/"])(
    "allows J5's legal pages: %s",
    (url) => {
      expect(isLegalDocumentUrl(url)).toBe(true);
    },
  );

  it.each([
    "https://example.com/legal",
    "javascript:alert(1)",
    "https://t3.codes/legal",
    "https://j5.codes/terms-of-service",
    "https://j5.codes/security-policy",
  ])("rejects a URL outside the legal-document allowlist: %s", (url) => {
    expect(isLegalDocumentUrl(url)).toBe(false);
  });
});
