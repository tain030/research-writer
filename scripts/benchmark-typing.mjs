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
  const { projectManuscriptEdit } = await server.ssrLoadModule(
    "/src/lib/manuscript-projection.ts",
  );
  const cases = [
    {
      characters: 10_000,
      budgetMs: 80,
      label: "background canonical layout",
      seed: "연구  원고  문장입니다. ",
    },
    {
      characters: 50_000,
      budgetMs: 200,
      label: "background long layout",
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
      `${benchmark.label}, ${benchmark.characters.toLocaleString("en-US")} chars: median ${median.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms (worker p95 budget ${benchmark.budgetMs} ms)`,
    );
    if (p95 > benchmark.budgetMs) process.exitCode = 1;
  }

  const projectionSource = "연구 원고 문장입니다. "
    .repeat(6_000)
    .slice(0, 100_000);
  const projectionLayout = layoutManuscript(projectionSource);
  const projectionSamples = [];
  for (let index = 0; index < 50; index += 1) {
    const next = `${projectionSource}${index % 2 ? "한" : " "}`;
    const started = performance.now();
    projectManuscriptEdit(
      projectionLayout,
      projectionSource,
      next,
      next.length,
    );
    projectionSamples.push(performance.now() - started);
  }
  projectionSamples.sort((left, right) => left - right);
  const projectionMedian = projectionSamples[Math.floor(projectionSamples.length / 2)];
  const projectionP95 = projectionSamples[Math.floor(projectionSamples.length * 0.95)];
  console.log(
    `immediate projection, 100,000 chars: median ${projectionMedian.toFixed(2)} ms, p95 ${projectionP95.toFixed(2)} ms (p95 budget 16 ms)`,
  );
  if (projectionP95 > 16) process.exitCode = 1;
} finally {
  await server.close();
}
