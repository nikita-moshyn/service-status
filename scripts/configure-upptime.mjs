import { readFile, writeFile } from "node:fs/promises";
import { validate } from "../shared/contract.mjs";
const c = validate(
  "config",
  JSON.parse(await readFile("config/platform.json", "utf8")),
);
// JSON is valid YAML. Upptime's own updater is deliberately not installed.
const result =
  JSON.stringify(
    {
      owner: c.repository.owner,
      repo: c.repository.name,
      "user-agent": c.repository.owner,
      sites: c.monitors
        .filter((x) => x.enabled)
        .map((x) => ({
          name: x.name,
          slug: x.id,
          url: x.url,
          expectedStatusCodes: [x.expectedStatus],
          maxResponseTime: x.timeoutMs,
        })),
      skipDescriptionUpdate: true,
      skipTopicsUpdate: true,
      skipHomepageUpdate: true,
      workflowSchedule: { uptime: "17 4 * * *" },
      "status-website": { name: c.brand.name, baseUrl: new URL(c.brand.publicUrl).pathname.replace(/\/$/, '') },
    },
    null,
    2,
  ) + "\n";
if (process.argv.includes("--check")) {
  if ((await readFile(".upptimerc.yml", "utf8")) !== result)
    throw new Error("Run npm run configure and commit .upptimerc.yml");
} else await writeFile(".upptimerc.yml", result);
