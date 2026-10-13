const NOTHING: { readonly placeholder?: string } = {};
const VIEW_ONLY = { placeholder: "You can read this thread, but not send anything to it." };

/**
 * What replaces the composer's placeholder: the view-only cue for a guest whose level on the
 * thread is View, and nothing for everyone else, a member without "Operate tasks" among them,
 * so that upstream's own text stands. Both answers keep their identity between renders.
 */
export const viewOnlyComposerProps = (input: {
  readonly isGuest: boolean;
  readonly canOperateThread: boolean;
}) => (input.isGuest && !input.canOperateThread ? VIEW_ONLY : NOTHING);
