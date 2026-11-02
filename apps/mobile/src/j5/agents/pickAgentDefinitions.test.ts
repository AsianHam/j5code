import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { isForegroundHandoffActive } from "../../lib/foreground-handoff";
import { pickAgentDefinitions } from "./pickAgentDefinitions";

const pickers = vi.hoisted(() => {
  class File {
    static pickFileAsync = vi.fn();
    readonly size = 2;
    constructor(readonly name: string) {}
    async text() {
      return "{}";
    }
  }
  class Directory {
    static pickDirectoryAsync = vi.fn();
    constructor(
      readonly name: string,
      readonly uri: string,
      readonly children: Array<File | Directory>,
    ) {}
    list() {
      return this.children;
    }
  }
  return { File, Directory };
});
vi.mock("expo-file-system", () => pickers);
const documents = vi.hoisted(() => ({ getDocumentAsync: vi.fn() }));
vi.mock("expo-document-picker", () => documents);

beforeEach(() => {
  vi.resetAllMocks();
});

describe("native agent definition selection", () => {
  it("collects nested agent.yaml files under the selected directory", async () => {
    pickers.Directory.pickDirectoryAsync.mockImplementation(async () => {
      expect(isForegroundHandoffActive()).toBe(true);
      return new pickers.Directory("team", "root", [
        new pickers.File("README.md"),
        new pickers.Directory("scout", "root/scout", [new pickers.File("agent.yaml")]),
        new pickers.Directory("builder", "root/builder", [new pickers.File("agent.yaml")]),
      ]);
    });
    const files = await pickAgentDefinitions("folder");
    expect(files?.map(({ name }) => name).sort()).toEqual([
      "team/builder/agent.yaml",
      "team/scout/agent.yaml",
    ]);
    expect(isForegroundHandoffActive()).toBe(false);
    expect(documents.getDocumentAsync).not.toHaveBeenCalled();
  });

  it("reads only the single chosen file", async () => {
    documents.getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ name: "agent.yaml", size: 2, uri: "file:///cache/agent.yaml" }],
    });
    expect(await pickAgentDefinitions("agent")).toEqual([{ name: "agent.yaml", content: "{}" }]);
    expect(pickers.Directory.pickDirectoryAsync).not.toHaveBeenCalled();
    expect(isForegroundHandoffActive()).toBe(false);
  });

  it("names a chosen Android document by its file name, not the id in its URI", async () => {
    // A Downloads pick's URI is content://…/document/msf%3A28; only the picker knows the name.
    pickers.File.pickFileAsync.mockResolvedValue({
      canceled: false,
      result: new pickers.File("msf%3A28"),
    });
    documents.getDocumentAsync.mockResolvedValue({
      canceled: false,
      assets: [{ name: "scout.yaml", size: 2, uri: "file:///cache/DocumentPicker/msf%3A28" }],
    });
    expect(await pickAgentDefinitions("agent")).toEqual([{ name: "scout.yaml", content: "{}" }]);
  });

  it("treats native picker cancellation as no selection and ends the handoff", async () => {
    for (const code of ["ERR_FILE_PICKING_CANCELLED", "ERR_PICKER_CANCELLED"]) {
      pickers.Directory.pickDirectoryAsync.mockRejectedValue(
        Object.assign(new Error("Cancelled"), { code }),
      );
      expect(await pickAgentDefinitions("folder")).toBeNull();
      expect(isForegroundHandoffActive()).toBe(false);
    }
    documents.getDocumentAsync.mockResolvedValue({ canceled: true, assets: null });
    expect(await pickAgentDefinitions("agent")).toBeNull();
    expect(isForegroundHandoffActive()).toBe(false);
  });

  it("reports access failures instead of importing a partial selection", async () => {
    pickers.Directory.pickDirectoryAsync.mockRejectedValue(new Error("Access denied"));
    await expect(pickAgentDefinitions("folder")).rejects.toThrow("Access denied");
    expect(isForegroundHandoffActive()).toBe(false);
  });
});
