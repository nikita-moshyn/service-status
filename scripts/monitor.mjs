import { readFile, writeFile, rename } from "node:fs/promises";
import { probe, reduceChecks } from "../lib/monitor.mjs";
import { validatePlatform, emptyEditorial } from "../shared/contract.mjs";
const read = async (p) => JSON.parse(await readFile(p, "utf8"));
const config = await read("config/platform.json");
const previous = await read("data/measurements.json");
validatePlatform(config, emptyEditorial(), previous);
const results = {};
// Batches bound outbound concurrency and worst-case runtime (100 monitors / 8 * 10s).
const enabled = config.monitors.filter((m) => m.enabled);
for (let start = 0; start < enabled.length; start += 8)
  await Promise.all(
    enabled.slice(start, start + 8).map(async (m) => {
      results[m.id] = await probe(m);
    }),
  );
const next = reduceChecks(config, previous, results);
await writeFile(
  "data/measurements.json.tmp",
  JSON.stringify(next, null, 2) + "\n",
);
await rename("data/measurements.json.tmp", "data/measurements.json");
console.log(`Checked ${enabled.length} configured readiness endpoints`);
