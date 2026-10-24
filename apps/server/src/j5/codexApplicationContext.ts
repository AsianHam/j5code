/**
 * Codex carries application instructions in `turn/start.additionalContext` and truncates the
 * middle of any entry past about 1,000 tokens, which it estimates at 4 bytes each. A persona's
 * instructions can be longer than that, so the text is spread over numbered keys (`key`,
 * `key_2`, ...), split between lines.
 */
const CODEX_CONTEXT_ENTRY_MAX_BYTES = 3_600;

export function codexApplicationContext(
  key: string,
  text: string | undefined,
): Record<string, { readonly kind: "application"; readonly value: string }> {
  const entries: Record<string, { readonly kind: "application"; readonly value: string }> = {};
  let value = "";
  const push = () => {
    if (value.trim() === "") return;
    const index = Object.keys(entries).length;
    entries[index === 0 ? key : `${key}_${index + 1}`] = { kind: "application", value };
    value = "";
  };
  for (const line of (text ?? "").trim().split("\n")) {
    if (Buffer.byteLength(`${value}\n${line}`) > CODEX_CONTEXT_ENTRY_MAX_BYTES) push();
    value = value === "" ? line : `${value}\n${line}`;
  }
  push();
  return entries;
}
