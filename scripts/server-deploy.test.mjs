import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execute = promisify(execFile);
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const canonicalLine =
  'CANONICAL_FETCH_URL="https://github.com/tain030/research-writer.git"';

function quoteDouble(value) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

async function run(command, args, options = {}) {
  return execute(command, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    ...options,
  });
}

async function git(cwd, args, environment) {
  return run("git", args, { cwd, env: environment });
}

async function expectFailure(promise, message) {
  try {
    await promise;
  } catch (error) {
    expect(`${error.stdout ?? ""}${error.stderr ?? ""}`).toContain(message);
    return error;
  }
  throw new Error("명령이 실패해야 하지만 성공했습니다.");
}

async function configureIdentity(cwd, environment) {
  await git(cwd, ["config", "user.name", "Research Writer Test"], environment);
  await git(
    cwd,
    ["config", "user.email", "research-writer-test@example.invalid"],
    environment,
  );
}

async function makeFixture() {
  const root = await mkdtemp(path.join(tmpdir(), "research-writer-deploy-"));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const seed = path.join(root, "seed");
  const remote = path.join(root, "remote.git");
  const developer = path.join(root, "developer");
  const server = path.join(root, "server");
  await Promise.all([mkdir(home), mkdir(bin), mkdir(seed)]);

  const environment = {
    ...process.env,
    HOME: home,
    GIT_CONFIG_GLOBAL: path.join(root, "empty-gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    PATH: `${bin}:${process.env.PATH}`,
    DEPLOY_HOST: "test@server",
    DEPLOY_ROOT: server,
    DEPLOY_BRANCH: "main",
  };
  await writeFile(environment.GIT_CONFIG_GLOBAL, "");

  await Promise.all([
    writeFile(path.join(bin, "docker"), "#!/bin/sh\nexit 0\n"),
    writeFile(
      path.join(bin, "ssh"),
      '#!/bin/sh\nshift\nexec sh -c "$1"\n',
    ),
  ]);
  await Promise.all([chmod(path.join(bin, "docker"), 0o755), chmod(path.join(bin, "ssh"), 0o755)]);

  await git(root, ["init", "--bare", remote], environment);
  await git(
    root,
    ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"],
    environment,
  );
  await git(seed, ["init", "-b", "main"], environment);
  await configureIdentity(seed, environment);
  await Promise.all([
    mkdir(path.join(seed, "_deploy")),
    mkdir(path.join(seed, "scripts")),
  ]);

  const [configureSource, deploySource] = await Promise.all([
    readFile(path.join(repositoryRoot, "_deploy/configure-checkout.sh"), "utf8"),
    readFile(path.join(repositoryRoot, "_deploy/deploy-to-server.sh"), "utf8"),
  ]);
  const fixtureCanonical = `CANONICAL_FETCH_URL="${quoteDouble(remote)}"`;
  await Promise.all([
    writeFile(
      path.join(seed, "_deploy/configure-checkout.sh"),
      configureSource.replace(canonicalLine, fixtureCanonical),
    ),
    writeFile(
      path.join(seed, "_deploy/deploy-to-server.sh"),
      deploySource.replace(canonicalLine, fixtureCanonical),
    ),
    writeFile(
      path.join(seed, "scripts/test-linux-container.sh"),
      "#!/bin/sh\nset -eu\nexit 0\n",
    ),
    writeFile(path.join(seed, "README.md"), "initial\n"),
  ]);
  await Promise.all([
    chmod(path.join(seed, "_deploy/configure-checkout.sh"), 0o755),
    chmod(path.join(seed, "_deploy/deploy-to-server.sh"), 0o755),
    chmod(path.join(seed, "scripts/test-linux-container.sh"), 0o755),
  ]);
  await git(seed, ["add", "-A"], environment);
  await git(seed, ["commit", "-m", "initial"], environment);
  await git(seed, ["remote", "add", "origin", remote], environment);
  await git(seed, ["push", "-u", "origin", "main"], environment);
  await git(root, ["clone", remote, developer], environment);
  await git(root, ["clone", remote, server], environment);
  await Promise.all([
    configureIdentity(developer, environment),
    configureIdentity(server, environment),
  ]);

  async function configure() {
    await run("sh", ["_deploy/configure-checkout.sh", "developer"], {
      cwd: developer,
      env: environment,
    });
    await run("sh", ["_deploy/configure-checkout.sh", "server"], {
      cwd: server,
      env: environment,
    });
  }

  async function commitAndPush(files, message) {
    for (const [name, content] of Object.entries(files)) {
      await writeFile(path.join(developer, name), content);
    }
    await git(developer, ["add", "-A"], environment);
    await git(developer, ["commit", "-m", message], environment);
    await git(developer, ["push", "origin", "main"], environment);
    return (await git(developer, ["rev-parse", "HEAD"], environment)).stdout.trim();
  }

  return {
    root,
    home,
    developer,
    server,
    remote,
    environment,
    configure,
    commitAndPush,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function deploy(fixture, ...arguments_) {
  return run("sh", ["_deploy/deploy-to-server.sh", ...arguments_], {
    cwd: fixture.developer,
    env: fixture.environment,
  });
}

describe("controlled server validation mirror", () => {
  it("configures a writable developer checkout and a push-disabled server checkout", async () => {
    const fixture = await makeFixture();
    try {
      await fixture.configure();
      await expect(
        git(
          fixture.developer,
          ["config", "--local", "--get", "researchwriter.role"],
          fixture.environment,
        ).then(({ stdout }) => stdout.trim()),
      ).resolves.toBe("developer");
      await expect(
        git(
          fixture.server,
          ["config", "--local", "--get", "researchwriter.role"],
          fixture.environment,
        ).then(({ stdout }) => stdout.trim()),
      ).resolves.toBe("server");
      await expect(
        git(
          fixture.server,
          ["remote", "get-url", "--push", "origin"],
          fixture.environment,
        ).then(({ stdout }) => stdout.trim()),
      ).resolves.toBe("disabled://read-only-server");
      await expect(
        git(fixture.server, ["remote", "get-url", "origin"], fixture.environment).then(
          ({ stdout }) => stdout.trim(),
        ),
      ).resolves.toBe(fixture.remote);
    } finally {
      await fixture.cleanup();
    }
  });

  it("keeps dry-run read-only and fast-forwards only after full validation", async () => {
    const fixture = await makeFixture();
    try {
      await fixture.configure();
      const oldCommit = (
        await git(fixture.server, ["rev-parse", "HEAD"], fixture.environment)
      ).stdout.trim();
      const targetCommit = await fixture.commitAndPush(
        { "README.md": "validated update\n" },
        "validated update",
      );

      const check = await deploy(fixture, "--dry-run");
      expect(check.stdout).toContain("서버 동기화 사전점검 완료");
      await expect(
        git(fixture.server, ["rev-parse", "HEAD"], fixture.environment).then(
          ({ stdout }) => stdout.trim(),
        ),
      ).resolves.toBe(oldCommit);

      const result = await deploy(fixture);
      expect(result.stdout).toContain("서버 검증 미러 동기화 완료");
      await expect(
        git(fixture.server, ["rev-parse", "HEAD"], fixture.environment).then(
          ({ stdout }) => stdout.trim(),
        ),
      ).resolves.toBe(targetCommit);
      await expect(
        git(
          fixture.server,
          ["status", "--porcelain=v1", "--untracked-files=all"],
          fixture.environment,
        ).then(({ stdout }) => stdout),
      ).resolves.toBe("");
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects unsafe states and rolls back a failed server validation", async () => {
    const fixture = await makeFixture();
    try {
      await fixture.configure();

      await writeFile(path.join(fixture.developer, "uncommitted.txt"), "dirty\n");
      await expectFailure(deploy(fixture, "--dry-run"), "노트북 작업 트리에");
      await rm(path.join(fixture.developer, "uncommitted.txt"));

      await writeFile(path.join(fixture.developer, "README.md"), "not pushed\n");
      await git(fixture.developer, ["add", "README.md"], fixture.environment);
      await git(fixture.developer, ["commit", "-m", "not pushed"], fixture.environment);
      await expectFailure(deploy(fixture, "--dry-run"), "먼저 push하세요");
      await git(fixture.developer, ["push", "origin", "main"], fixture.environment);

      await writeFile(path.join(fixture.server, "server-dirty.txt"), "dirty\n");
      await expectFailure(deploy(fixture, "--dry-run"), "서버 작업 트리에");
      await rm(path.join(fixture.server, "server-dirty.txt"));

      await deploy(fixture);
      const safeCommit = (
        await git(fixture.server, ["rev-parse", "HEAD"], fixture.environment)
      ).stdout.trim();
      await fixture.commitAndPush(
        {
          "README.md": "must roll back\n",
          "scripts/test-linux-container.sh": "#!/bin/sh\nset -eu\nexit 19\n",
        },
        "failing validation",
      );
      await expectFailure(deploy(fixture), "검증 실패");
      await expect(
        git(fixture.server, ["rev-parse", "HEAD"], fixture.environment).then(
          ({ stdout }) => stdout.trim(),
        ),
      ).resolves.toBe(safeCommit);
      await expect(
        git(
          fixture.server,
          ["status", "--porcelain=v1", "--untracked-files=all"],
          fixture.environment,
        ).then(({ stdout }) => stdout),
      ).resolves.toBe("");
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a divergent server branch", async () => {
    const fixture = await makeFixture();
    try {
      await fixture.configure();
      await writeFile(path.join(fixture.server, "server-only.txt"), "diverged\n");
      await git(fixture.server, ["add", "server-only.txt"], fixture.environment);
      await git(fixture.server, ["commit", "-m", "server divergence"], fixture.environment);
      await fixture.commitAndPush(
        { "README.md": "different origin history\n" },
        "origin update",
      );
      await expectFailure(deploy(fixture, "--dry-run"), "fast-forward할 수 없습니다");
    } finally {
      await fixture.cleanup();
    }
  });

  it("rejects a concurrent deployment lock", async () => {
    const fixture = await makeFixture();
    let lockProcess;
    try {
      await fixture.configure();
      const stateDirectory = path.join(
        fixture.home,
        ".local/state/research-writer",
      );
      await mkdir(stateDirectory, { recursive: true });
      const lockPath = path.join(stateDirectory, "deploy.lock");
      lockProcess = execFile("flock", [lockPath, "sleep", "10"], {
        env: fixture.environment,
      });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await expectFailure(deploy(fixture, "--dry-run"), "이미 실행 중입니다");
    } finally {
      lockProcess?.kill("SIGTERM");
      await fixture.cleanup();
    }
  });
});
