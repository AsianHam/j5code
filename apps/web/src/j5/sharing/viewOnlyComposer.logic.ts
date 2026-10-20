const NOTHING: { readonly placeholder?: string } = {};
const VIEW_ONLY = { placeholder: "You can read this thread, but not send anything to it." };

/**
 * What replaces the composer's placeholder: the view-only cue for a person who is not an Owner
 * and cannot write to the thread, which is a Viewer of it; nothing for everyone else, an Owner
 * whose device was paired without "Operate tasks" among them, so that upstream's own text
 * stands. Both answers keep their identity between renders.
 */
export const viewOnlyComposerProps = (input: {
  readonly personNotOwner: boolean;
  readonly canOperateThread: boolean;
}) => (input.personNotOwner && !input.canOperateThread ? VIEW_ONLY : NOTHING);
