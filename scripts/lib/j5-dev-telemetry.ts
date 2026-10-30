/**
 * Where an opted-in dev server sends usage events: "J5 Code Dev", so development and agent test
 * runs are not counted as real use (released builds report to "J5 Code"). A PostHog project
 * token only accepts events, which is why both are in the source.
 */
export const J5_DEV_POSTHOG_KEY = "phc_wsX4hEiHn5j5njkeFEunQvCMPmLuCQtVkFSUn8gewr6H";

/** The dev project, unless the developer's shell or `.env` already names a project. */
export const j5DevPostHogKey = (env: NodeJS.ProcessEnv): string =>
  env.T3CODE_POSTHOG_KEY?.trim() || J5_DEV_POSTHOG_KEY;
