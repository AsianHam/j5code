/**
 * The spinner of a refresh the person asked for: on from their pull until every read has settled,
 * whatever those reads answer. A re-read nobody asked for, such as the one after an answer or on
 * the server's inbox signal, doesn't come through here, so it never shows the spinner.
 */
export function createPullRefresh(input: {
  readonly read: () => Promise<unknown>;
  readonly onChange: (refreshing: boolean) => void;
}): () => Promise<void> {
  let running = false;
  return async () => {
    if (running) return;
    running = true;
    input.onChange(true);
    try {
      await input.read();
    } catch {
      // Each server's own failure shows as its source notice.
    } finally {
      running = false;
      input.onChange(false);
    }
  };
}
