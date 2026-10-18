import { ORCHESTRATION_PROTOCOL_HEADER } from "@t3tools/contracts";

import { J5_BRANDING } from "../../../scripts/lib/j5-branding.ts";

export const browserApiCorsAllowedMethods = ["GET", "POST", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "dpop",
  ORCHESTRATION_PROTOCOL_HEADER,
] as const;

export const DESKTOP_RENDERER_ORIGINS = [
  `${J5_BRANDING.desktop.productionScheme}://app`,
  `${J5_BRANDING.desktop.developmentScheme}://app`,
] as const;
