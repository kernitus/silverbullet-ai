import {
  createLiteralSearch,
  type LiteralOptions,
} from "../src/literal-search.ts";

// Synthetic notes only. Reads resolve asynchronously without simulated network
// delay: timings measure local CPU and scheduling, read counts show syscall cost.
const count = 10_000;
const notes = new Map<string, { text: string; lastModified: number }>();
let corpusBytes = 0;
for (let i = 0; i < count; i++) {
  const page = `${i % 10 === 0 ? "Private" : "Team"}/${String(i).padStart(5, "0")}`;
  const text = Array.from({ length: 8 + (i % 48) }, (_, line) =>
    line === 0
      ? `common needle [x] page ${i}${i >= 9500 ? " late-match" : ""}`
      : `Line ${line}: project record ${i}, deterministic background detail and punctuation: []().`,
  ).join("\n");
  corpusBytes += new TextEncoder().encode(text).byteLength;
  notes.set(page, { text, lastModified: 1 });
}
let reads = 0;
const listPages = async () =>
  [...notes].map(([name, note]) => ({ name, lastModified: note.lastModified }));
const readPage = async (page: string) => {
  reads++;
  return notes.get(page)!.text;
};
Bun.gc(true);
const beforeHeap = process.memoryUsage().heapUsed;
const engine = createLiteralSearch({ listPages, readPage });
const prepareMs = 0; // No separate text index or content cache is constructed.

async function baseline(args: LiteralOptions, offset: number) {
  const pages = (await listPages())
    .filter((p) => args.acceptsPage(p.name))
    .sort((a, b) => a.name.localeCompare(b.name));
  let skipped = 0;
  let matches = 0;
  for (const page of pages) {
    const lines = (await readPage(page.name)).split(/\r?\n/);
    for (const line of lines) {
      if (!line.toLowerCase().includes(args.query.toLowerCase())) continue;
      if (skipped++ < offset) continue;
      if (matches === args.limit) return { matches, more: true };
      matches++;
    }
  }
  return { matches, more: false };
}
const percentile = (values: number[], p: number) =>
  values.toSorted((a, b) => a - b)[
    Math.min(values.length - 1, Math.ceil(values.length * p) - 1)
  ];
const summary = (values: number[]) => ({
  medianMs: +percentile(values, 0.5).toFixed(3),
  p95Ms: +percentile(values, 0.95).toFixed(3),
});
const rows: unknown[] = [];
for (const scope of ["Team", "all"]) {
  for (const query of ["common needle", "late-match", "absent-query"]) {
    const args: LiteralOptions = {
      query,
      limit: 20,
      caseSensitive: false,
      surroundingLines: 0,
      scopeKey: scope,
      acceptsPage: (name) => scope === "all" || name.startsWith("Team/"),
    };
    // One unrecorded warm-up, then ten runs. Each run starts a fresh query.
    for (const selected of [false, true]) {
      const firstTimes: number[] = [],
        laterTimes: number[] = [];
      let firstReads = 0,
        laterReads = 0,
        firstSamples = 0,
        laterSamples = 0;
      let coldMs = 0;
      for (let iteration = -1; iteration < 10; iteration++) {
        let cursor: string | undefined;
        let offset = 0;
        for (let page = 0; page < 5; page++) {
          reads = 0;
          const start = performance.now();
          let more: boolean;
          if (selected) {
            const result = await engine.search({ ...args, cursor });
            more = result.nextCursor !== null;
            cursor = result.nextCursor ?? undefined;
          } else {
            const result = await baseline(args, offset);
            more = result.more;
            offset += result.matches;
          }
          const elapsed = performance.now() - start;
          if (iteration === -1 && page === 0) coldMs = elapsed;
          if (iteration >= 0) {
            if (page === 0) {
              firstTimes.push(elapsed);
              firstReads += reads;
              firstSamples++;
            } else {
              laterTimes.push(elapsed);
              laterReads += reads;
              laterSamples++;
            }
          }
          if (!more) break;
        }
      }
      rows.push({
        scope,
        query,
        implementation: selected ? "continuation" : "baseline offset",
        coldFirstMs: +coldMs.toFixed(3),
        first: { ...summary(firstTimes), meanReads: firstReads / firstSamples },
        later: laterSamples
          ? { ...summary(laterTimes), meanReads: laterReads / laterSamples }
          : null,
      });
    }
  }
}
const updateStart = performance.now();
notes.get("Team/00001")!.lastModified++;
engine.invalidate("Team/00001");
const updateMs = performance.now() - updateStart;
Bun.gc(true);
console.log(
  JSON.stringify(
    {
      environment: {
        bun: Bun.version,
        platform: process.platform,
        arch: process.arch,
      },
      corpus: { notes: count, bytes: corpusBytes, minLines: 8, maxLines: 55 },
      methodology:
        "One cold run and ten measured runs per query and scope; five result pages where available. In-memory asynchronous reads, no network latency. CPU timings include deliberate cancellation yields. No search index is built.",
      indexPreparationMs: prepareMs,
      updateMs: +updateMs.toFixed(3),
      retained: engine.stats(),
      postGcHeapDeltaBytes: process.memoryUsage().heapUsed - beforeHeap,
      memoryNote:
        "retainedBytes estimates cursor serialisable metadata only; post-GC heap delta also includes runtime caches and measurement overhead. Corpus storage is excluded from beforeHeap.",
      rows,
    },
    null,
    2,
  ),
);
