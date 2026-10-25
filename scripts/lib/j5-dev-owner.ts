/**
 * The name a dev server gives its home's first owner, if they have none yet
 * (`apps/server/src/j5/sharing/devOwnerName.ts`), so agents testing other
 * features are not asked who they are on every fresh home.
 */
export const J5_DEV_OWNER_NAME = "Dev owner";

/**
 * The dev owner's name, unless the shell or `.env` gives one. A blank one is
 * kept: it leaves the first owner unnamed, for testing the naming question.
 */
export const j5DevOwnerName = (env: NodeJS.ProcessEnv): string =>
  env.J5CODE_DEV_OWNER_NAME ?? J5_DEV_OWNER_NAME;
