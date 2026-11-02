import { describe, expect, it, vi } from "vite-plus/test";

import { sendAfterReconnect } from "./sendAfterReconnect";

const notConnected = Object.assign(new Error("openclaw is not connected."), {
  _tag: "EnvironmentRpcUnavailableError",
});

describe("sendAfterReconnect", () => {
  it("sends again only after the environment reconnects when the first send never left", async () => {
    const order: string[] = [];
    const send = vi
      .fn<() => Promise<string>>()
      .mockImplementationOnce(async () => {
        order.push("send");
        throw notConnected;
      })
      .mockImplementationOnce(async () => {
        order.push("send");
        return "imported";
      });
    const waitForReconnect = vi.fn(async () => {
      order.push("reconnected");
      return true;
    });

    await expect(sendAfterReconnect({ send, waitForReconnect })).resolves.toBe("imported");
    expect(order).toEqual(["send", "reconnected", "send"]);
  });

  it("fails visibly, without sending again, when the environment does not come back", async () => {
    const send = vi.fn<() => Promise<string>>().mockRejectedValue(notConnected);

    await expect(sendAfterReconnect({ send, waitForReconnect: async () => false })).rejects.toThrow(
      "didn't reconnect in time",
    );
    expect(send).toHaveBeenCalledOnce();
  });

  it("does not wait or resend after a failure the server returned", async () => {
    const refused = new Error("Persona id already exists.");
    const send = vi.fn<() => Promise<string>>().mockRejectedValue(refused);
    const waitForReconnect = vi.fn(async () => true);

    await expect(sendAfterReconnect({ send, waitForReconnect })).rejects.toBe(refused);
    expect(waitForReconnect).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledOnce();
  });
});
