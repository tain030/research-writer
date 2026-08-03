import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkReleaseVersion,
  readCargoLockVersion,
  readCargoPackageVersion,
  requireStableVersion,
  setCargoLockVersion,
  setCargoPackageVersion,
  setReleaseVersion,
} from "./release-version.mjs";

async function makeReleaseFixture(version = "0.1.3") {
  const root = await mkdtemp(path.join(tmpdir(), "research-writer-version-"));
  const tauriDir = path.join(root, "src-tauri");
  await mkdir(tauriDir);
  await Promise.all([
    writeFile(
      path.join(root, "package.json"),
      `${JSON.stringify({ name: "research-writer", version }, null, 2)}\n`,
    ),
    writeFile(
      path.join(tauriDir, "Cargo.toml"),
      `[package]\nname = "research-writer"\nversion = "${version}"\n`,
    ),
    writeFile(
      path.join(tauriDir, "Cargo.lock"),
      `[[package]]\nname = "research-writer"\nversion = "${version}"\n`,
    ),
  ]);
  return root;
}

describe("release version", () => {
  it("accepts stable semantic versions", () => {
    expect(requireStableVersion("0.1.4")).toBe("0.1.4");
    expect(requireStableVersion("12.0.31")).toBe("12.0.31");
  });

  it.each(["v0.1.4", "0.1", "01.2.3", "1.2.3-beta.1", ""])(
    "rejects unsupported version %s",
    (version) => {
      expect(() => requireStableVersion(version)).toThrow(
        "안정 버전은 0.1.4처럼",
      );
    },
  );

  it("changes only the Cargo package version", () => {
    const manifest = `[package]
name = "research-writer"
version = "0.1.3"

[dependencies]
example = { version = "0.1.3" }
`;
    const updated = setCargoPackageVersion(manifest, "0.1.4");

    expect(readCargoPackageVersion(updated)).toBe("0.1.4");
    expect(updated).toContain('example = { version = "0.1.3" }');
  });

  it("changes only the root package entry in Cargo.lock", () => {
    const lock = `[[package]]
name = "dependency"
version = "0.1.3"

[[package]]
name = "research-writer"
version = "0.1.3"
dependencies = []
`;
    const updated = setCargoLockVersion(lock, "0.1.4");

    expect(readCargoLockVersion(updated)).toBe("0.1.4");
    expect(updated).toContain('name = "dependency"\nversion = "0.1.3"');
  });

  it("updates and verifies every release version source", async () => {
    const root = await makeReleaseFixture();
    try {
      await expect(setReleaseVersion(root, "0.1.4")).resolves.toBe("0.1.4");
      await expect(checkReleaseVersion(root, "0.1.4")).resolves.toBe("0.1.4");
      const packageJson = JSON.parse(
        await readFile(path.join(root, "package.json"), "utf8"),
      );
      expect(packageJson).toHaveProperty("version", "0.1.4");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reports source files that do not match the release version", async () => {
    const root = await makeReleaseFixture();
    try {
      await expect(checkReleaseVersion(root, "0.1.4")).rejects.toThrow(
        "package.json: 0.1.3",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
