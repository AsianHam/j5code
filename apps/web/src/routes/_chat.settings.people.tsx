import { createFileRoute } from "@tanstack/react-router";

import { PeoplePage } from "../j5/sharing/PeoplePage";

export const Route = createFileRoute("/_chat/settings/people")({ component: PeoplePage });
