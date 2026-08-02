import { performance } from "node:perf_hooks";
import { createServer } from "vite";

const server = await createServer({
  appType: "custom",
  logLevel: "silent",
  server: { middlewareMode: true },
});

try {
  const { layoutManuscript } = await server.ssrLoadModule(
    "/src/lib/manuscript-layout.ts",
  );
  const cases = [
    {
      characters: 10_000,
      budgetMs: 16,
      label: "diagnostic-heavy",
      seed: "연구  원고  문장입니다. ",
    },
    {
      characters: 50_000,
      budgetMs: 45,
      label: "long manuscript",
      seed: "연구 원고 문장입니다. ",
    },
  ];

  for (const benchmark of cases) {
    const source = benchmark.seed
      .repeat(Math.ceil(benchmark.characters / benchmark.seed.length))
      .slice(0, benchmark.characters);
    for (let index = 0; index < 8; index += 1) {
      layoutManuscript(`${source}가`);
    }

    const samples = [];
    for (let index = 0; index < 25; index += 1) {
      const started = performance.now();
      layoutManuscript(`${source}가`);
      samples.push(performance.now() - started);
    }
    samples.sort((left, right) => left - right);
    const median = samples[Math.floor(samples.length / 2)];
    const p95 = samples[Math.floor(samples.length * 0.95)];
    console.log(
      `${benchmark.label}, ${benchmark.characters.toLocaleString("en-US")} chars: median ${median.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms (budget ${benchmark.budgetMs} ms)`,
    );
    if (median > benchmark.budgetMs) process.exitCode = 1;
  }
} finally {
  await server.close();
}
