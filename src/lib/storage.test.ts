import { describe, expect, it } from "vitest";
import { externalSyncProvider } from "./storage";

describe("storage helpers", () => {
  it("recognizes Dropbox paths across desktop platforms", () => {
    expect(externalSyncProvider("/home/tain/Dropbox/OSDN/3_Write")).toBe(
      "Dropbox",
    );
    expect(
      externalSyncProvider(
        "/Users/tain/Library/CloudStorage/Dropbox/OSDN/3_Write",
      ),
    ).toBe("Dropbox");
    expect(
      externalSyncProvider("C:\\Users\\tain\\Dropbox\\OSDN\\3_Write"),
    ).toBe("Dropbox");
  });

  it("recognizes other common external sync folders", () => {
    expect(
      externalSyncProvider("C:\\Users\\tain\\OneDrive - Company\\draft.md"),
    ).toBe("OneDrive");
    expect(externalSyncProvider("/Volumes/Google Drive/draft.md")).toBe(
      "Google Drive",
    );
    expect(
      externalSyncProvider(
        "/Users/tain/Library/Mobile Documents/com~apple~CloudDocs/draft.md",
      ),
    ).toBe("iCloud");
  });

  it("leaves ordinary local paths unclassified", () => {
    expect(externalSyncProvider("/home/tain/Documents/draft.md")).toBeNull();
  });
});
