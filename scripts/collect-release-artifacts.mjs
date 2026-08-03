import { chmod, copyFile, mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const releaseKinds = {
  "linux-x64": [
    { matches: (name) => name.endsWith(".deb"), output: "research-writer_amd64.deb" },
    {
      matches: (name) => name.endsWith(".AppImage"),
      output: "research-writer_x86_64.AppImage",
      executable: true,
    },
  ],
  "macos-arm64": [
    {
      matches: (name) => name.endsWith(".dmg"),
      output: "Research-Writer_macOS_arm64.dmg",
    },
    {
      matches: (name) => name.endsWith(".zip"),
      output: "Research-Writer_macOS_arm64.zip",
    },
  ],
  "macos-x64": [
    {
      matches: (name) => name.endsWith(".dmg"),
      output: "Research-Writer_macOS_x64.dmg",
    },
    {
      matches: (name) => name.endsWith(".zip"),
      output: "Research-Writer_macOS_x64.zip",
    },
  ],
  "windows-x64": [
    {
      matches: (name) => /_setup\.exe$/i.test(name),
      output: "Research-Writer_Windows_x64_Setup.exe",
    },
    {
      matches: (name) => /_portable\.exe$/i.test(name),
      output: "Research-Writer_Windows_x64_Portable.exe",
    },
  ],
};

export async function collectReleaseArtifacts(kind, source, destination) {
  const specifications = releaseKinds[kind];
  if (!specifications) throw new Error(`지원하지 않는 릴리스 종류입니다: ${kind}`);

  const entries = (await readdir(source, { withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name);
  await mkdir(destination, { recursive: true });

  const outputs = [];
  for (const specification of specifications) {
    const matches = entries.filter(specification.matches);
    if (matches.length !== 1) {
      throw new Error(
        `${kind}: ${specification.output}에 대응하는 파일이 ${matches.length}개입니다.`,
      );
    }
    const target = path.join(destination, specification.output);
    await copyFile(path.join(source, matches[0]), target);
    if (specification.executable) await chmod(target, 0o755);
    outputs.push(target);
  }
  return outputs;
}

async function main() {
  const [kind, source = "dist", destination] = process.argv.slice(2);
  if (!kind || !destination) {
    throw new Error(
      "사용법: node scripts/collect-release-artifacts.mjs <종류> <입력 폴더> <출력 폴더>",
    );
  }
  const outputs = await collectReleaseArtifacts(kind, source, destination);
  process.stdout.write(`${outputs.join("\n")}\n`);
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
