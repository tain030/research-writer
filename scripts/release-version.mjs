import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const STABLE_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function requireStableVersion(value) {
  if (!STABLE_SEMVER.test(value ?? "")) {
    throw new Error(
      `안정 버전은 0.1.4처럼 숫자 세 부분으로 입력해야 합니다: ${value ?? ""}`,
    );
  }
  return value;
}

function replaceExactlyOnce(contents, pattern, replacement, label) {
  const globalFlags = pattern.flags.includes("g")
    ? pattern.flags
    : `${pattern.flags}g`;
  const matches = contents.match(new RegExp(pattern.source, globalFlags));
  if (matches?.length !== 1) {
    throw new Error(`${label} 버전 항목을 정확히 하나 찾지 못했습니다.`);
  }
  return contents.replace(pattern, replacement);
}

export function readCargoPackageVersion(contents) {
  const packageSection = contents.match(
    /^\[package\][ \t]*\r?$([\s\S]*?)(?=^\[|(?![\s\S]))/m,
  )?.[1];
  const version = packageSection?.match(
    /^version = "([^"]+)"[ \t]*\r?$/m,
  )?.[1];
  if (!version) {
    throw new Error("Cargo.toml의 [package] 버전을 찾지 못했습니다.");
  }
  return version;
}

export function setCargoPackageVersion(contents, version) {
  requireStableVersion(version);
  const packageEnd = contents.search(/^\[(?!package\])/m);
  const boundary = packageEnd === -1 ? contents.length : packageEnd;
  const packageSection = contents.slice(0, boundary);
  const remainder = contents.slice(boundary);
  return (
    replaceExactlyOnce(
      packageSection,
      /^version = "[^"]+"[ \t]*\r?$/m,
      `version = "${version}"`,
      "Cargo.toml [package]",
    ) + remainder
  );
}

export function readCargoLockVersion(contents) {
  const match = contents.match(
    /^\[\[package\]\][ \t]*\r?\nname = "research-writer"[ \t]*\r?\nversion = "([^"]+)"[ \t]*\r?$/m,
  );
  if (!match) {
    throw new Error("Cargo.lock의 research-writer 패키지를 찾지 못했습니다.");
  }
  return match[1];
}

export function setCargoLockVersion(contents, version) {
  requireStableVersion(version);
  return replaceExactlyOnce(
    contents,
    /^(\[\[package\]\][ \t]*\r?\nname = "research-writer"[ \t]*\r?\nversion = ")[^"]+("[ \t]*\r?$)/m,
    `$1${version}$2`,
    "Cargo.lock research-writer",
  );
}

function repositoryPaths(root) {
  return {
    packageJson: path.join(root, "package.json"),
    cargoToml: path.join(root, "src-tauri", "Cargo.toml"),
    cargoLock: path.join(root, "src-tauri", "Cargo.lock"),
  };
}

async function readReleaseFiles(root) {
  const paths = repositoryPaths(root);
  const [packageText, cargoToml, cargoLock] = await Promise.all([
    readFile(paths.packageJson, "utf8"),
    readFile(paths.cargoToml, "utf8"),
    readFile(paths.cargoLock, "utf8"),
  ]);
  return {
    paths,
    packageText,
    packageJson: JSON.parse(packageText),
    cargoToml,
    cargoLock,
  };
}

export async function checkReleaseVersion(root, expectedVersion) {
  const version = requireStableVersion(expectedVersion);
  const files = await readReleaseFiles(root);
  const observed = {
    "package.json": files.packageJson.version,
    "Cargo.toml": readCargoPackageVersion(files.cargoToml),
    "Cargo.lock": readCargoLockVersion(files.cargoLock),
  };
  const mismatches = Object.entries(observed)
    .filter(([, current]) => current !== version)
    .map(([file, current]) => `${file}: ${current ?? "없음"}`);

  if (mismatches.length > 0) {
    throw new Error(
      `릴리스 버전 ${version}과 일치하지 않습니다.\n${mismatches.join("\n")}`,
    );
  }
  return version;
}

export async function setReleaseVersion(root, requestedVersion) {
  const version = requireStableVersion(requestedVersion);
  const files = await readReleaseFiles(root);

  files.packageJson.version = version;

  await Promise.all([
    writeFile(
      files.paths.packageJson,
      `${JSON.stringify(files.packageJson, null, 2)}\n`,
    ),
    writeFile(
      files.paths.cargoToml,
      setCargoPackageVersion(files.cargoToml, version),
    ),
    writeFile(
      files.paths.cargoLock,
      setCargoLockVersion(files.cargoLock, version),
    ),
  ]);

  await checkReleaseVersion(root, version);
  return version;
}

async function main() {
  const [command, requestedVersion] = process.argv.slice(2);
  if (!["check", "set"].includes(command) || !requestedVersion) {
    throw new Error(
      "사용법: pnpm release:version <버전> 또는 pnpm release:check <버전>",
    );
  }

  const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
  const version =
    command === "set"
      ? await setReleaseVersion(repositoryRoot, requestedVersion)
      : await checkReleaseVersion(repositoryRoot, requestedVersion);
  process.stdout.write(
    `릴리스 버전 ${version} ${command === "set" ? "설정" : "확인"} 완료\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
