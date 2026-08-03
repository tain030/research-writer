import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { collectReleaseArtifacts } from "./collect-release-artifacts.mjs";

async function withTemporaryDirectories(run) {
  const root = await mkdtemp(path.join(tmpdir(), "research-writer-artifacts-"));
  const source = path.join(root, "source");
  const destination = path.join(root, "release");
  await mkdir(source);
  try {
    await run({ source, destination });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("release artifact collection", () => {
  it("normalizes Linux package names and keeps the AppImage executable", async () => {
    await withTemporaryDirectories(async ({ source, destination }) => {
      await Promise.all([
        writeFile(path.join(source, "research-writer_0.7.0_amd64.deb"), "deb"),
        writeFile(
          path.join(source, "research-writer_0.7.0_x86_64.AppImage"),
          "appimage",
        ),
      ]);

      await collectReleaseArtifacts("linux-x64", source, destination);

      await expect(
        readFile(path.join(destination, "research-writer_amd64.deb"), "utf8"),
      ).resolves.toBe("deb");
      const appImage = path.join(
        destination,
        "research-writer_x86_64.AppImage",
      );
      await expect(readFile(appImage, "utf8")).resolves.toBe("appimage");
      expect((await stat(appImage)).mode & 0o111).not.toBe(0);
    });
  });

  it("keeps Windows setup and portable executables distinct", async () => {
    await withTemporaryDirectories(async ({ source, destination }) => {
      await Promise.all([
        writeFile(path.join(source, "research-writer_0.7.0_x64_setup.exe"), "setup"),
        writeFile(
          path.join(source, "research-writer_0.7.0_x64_portable.exe"),
          "portable",
        ),
      ]);

      await collectReleaseArtifacts("windows-x64", source, destination);

      await expect(
        readFile(
          path.join(destination, "Research-Writer_Windows_x64_Setup.exe"),
          "utf8",
        ),
      ).resolves.toBe("setup");
      await expect(
        readFile(
          path.join(destination, "Research-Writer_Windows_x64_Portable.exe"),
          "utf8",
        ),
      ).resolves.toBe("portable");
    });
  });

  it("rejects ambiguous outputs instead of publishing the wrong file", async () => {
    await withTemporaryDirectories(async ({ source, destination }) => {
      await Promise.all([
        writeFile(path.join(source, "first.deb"), "one"),
        writeFile(path.join(source, "second.deb"), "two"),
        writeFile(path.join(source, "writer.AppImage"), "appimage"),
      ]);

      await expect(
        collectReleaseArtifacts("linux-x64", source, destination),
      ).rejects.toThrow("파일이 2개입니다");
    });
  });
});
