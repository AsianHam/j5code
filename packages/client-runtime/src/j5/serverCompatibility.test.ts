import {
  EnvironmentId,
  type ExecutionEnvironmentDescriptor,
  type ServerConfig,
} from "@t3tools/contracts";
import { J5_LEDGER_CAPABILITIES } from "@t3tools/contracts/j5";
import { describe, expect, it } from "vite-plus/test";

import { j5LedgerSupported } from "./readSources.ts";
import { j5ServerCompatibilityError } from "./serverCompatibility.ts";

const descriptor = (
  capabilities: ExecutionEnvironmentDescriptor["capabilities"],
): ExecutionEnvironmentDescriptor => ({
  environmentId: EnvironmentId.make("environment-remote"),
  label: "Build Mac",
  platform: { os: "darwin", arch: "arm64" },
  serverVersion: "9.0.0",
  capabilities,
});

describe("J5 server compatibility", () => {
  it("connects to a J5 server whose ledger is keyed by project", () => {
    expect(
      j5ServerCompatibilityError(descriptor({ repositoryIdentity: true, j5ProjectLedger: true })),
    ).toBeNull();
  });

  it("connects to a server reporting exactly what a project-keyed J5 server reports", () => {
    expect(
      j5ServerCompatibilityError(
        descriptor({ repositoryIdentity: true, ...J5_LEDGER_CAPABILITIES }),
      ),
    ).toBeNull();
  });

  it("tells the person to update a J5 server from before the ledger was re-keyed, naming it", () => {
    const error = j5ServerCompatibilityError(
      descriptor({ repositoryIdentity: true, j5Squadrons: true }),
    );
    expect(error).toMatchObject({ reason: "unsupported" });
    expect(error?.message).toBe(
      "This client requires a newer server. Update the server on Build Mac to connect.",
    );
  });

  it("connects to a server with no J5 ledger at all, whose J5 views read as unsupported", () => {
    const plain = descriptor({ repositoryIdentity: true });
    expect(j5ServerCompatibilityError(plain)).toBeNull();
    expect(j5LedgerSupported({ environment: plain } as ServerConfig)).toBe(false);
    expect(
      j5LedgerSupported({
        environment: descriptor({ repositoryIdentity: true, ...J5_LEDGER_CAPABILITIES }),
      } as ServerConfig),
    ).toBe(true);
    // Until the config arrives nothing is known, and no view is called unsupported.
    expect(j5LedgerSupported(null)).toBeUndefined();
  });
});
