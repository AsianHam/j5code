import { createNativeStackScreen } from "@react-navigation/native-stack";

import { ThreadArtifactScreen, ThreadArtifactsScreen } from "./ThreadArtifactsScreen";

/** J5's artifact screens, beside upstream's thread file routes (FORK.md "Route registration"). */
export const j5ThreadArtifactRoutes = <Options extends object>(
  threadLinkingPrefix: string,
  options: Options,
) => ({
  ThreadArtifacts: createNativeStackScreen({
    screen: ThreadArtifactsScreen,
    linking: `${threadLinkingPrefix}/artifacts`,
    options,
  }),
  ThreadArtifact: createNativeStackScreen({
    screen: ThreadArtifactScreen,
    linking: `${threadLinkingPrefix}/artifacts/:path*`,
    options,
  }),
});
