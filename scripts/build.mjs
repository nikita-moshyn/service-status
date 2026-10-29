import { readFile, writeFile, mkdir, rm, rename, cp } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { build } from "vite";
import { makeFeeds } from "../shared/contract.mjs";
export async function publishLocal({
  root = process.cwd(),
  now = Date.now(),
  revision,
} = {}) {
  const read = async (p) => JSON.parse(await readFile(`${root}/${p}`, "utf8"));
  const c = await read("config/platform.json");
  const e = await read("data/editorial.json");
  const m = await read("data/measurements.json");
  if (!revision) {
    try {
      revision = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      revision = "local";
    }
  }
  // Validate all projects before touching the last successful output.
  const feeds = makeFeeds(c, e, m, now, revision);
  const staging = `${root}/.dist-next`;
  await rm(staging, { recursive: true, force: true });
  await build({
    configFile: false,
    root: `${root}/web`,
    base: "./",
    build: { outDir: staging, emptyOutDir: true },
  });
  await mkdir(`${staging}/v1`, { recursive: true });
  for (const f of feeds) {
    const dir = `${staging}/v1/projects/${f.project.id}`;
    await mkdir(dir, { recursive: true });
    await writeFile(`${dir}/status.json`, JSON.stringify(f));
  }
  await writeFile(
    `${staging}/v1/index.json`,
    JSON.stringify({
      schemaVersion: "1.0",
      brand: c.brand,
      languages: c.languages,
      generatedAt: new Date(now).toISOString(),
      feeds,
    }),
  );
  await cp(
    `${root}/shared/schemas/feed.schema.json`,
    `${staging}/v1/schema.json`,
  );
  await writeFile(`${staging}/.nojekyll`, "");
  await rm(`${root}/.dist-last`, { recursive: true, force: true });
  let backedUp = false;
  try {
    await rename(`${root}/dist`, `${root}/.dist-last`);
    backedUp = true;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  try {
    await rename(staging, `${root}/dist`);
  } catch (error) {
    if (backedUp) await rename(`${root}/.dist-last`, `${root}/dist`);
    throw error;
  }
  await rm(`${root}/.dist-last`, { recursive: true, force: true });
  console.log(`Validated and built ${feeds.length} project feeds`);
}
if (process.argv[1]?.endsWith("/scripts/build.mjs")) await publishLocal();
