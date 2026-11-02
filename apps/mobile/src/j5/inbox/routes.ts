import { createNativeStackScreen } from "@react-navigation/native-stack";

import { InboxScreen } from "./InboxScreen";

/** J5's Inbox screen, beside upstream's root routes (FORK.md "Route registration"). */
export const j5InboxRoutes = <Options extends object>(options: Options) => ({
  Inbox: createNativeStackScreen({
    screen: InboxScreen,
    linking: "inbox",
    options,
  }),
});
