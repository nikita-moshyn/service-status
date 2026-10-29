import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  makeFeeds,
  emptyEditorial,
  emptyMeasurements,
  validatePlatform,
} from "../shared/contract.mjs";
import { explanation, liveAvailability, generic } from "../shared/messages.mjs";
import { probe, reduceChecks as reduceMeasurements } from "../lib/monitor.mjs";
import { publishLocal } from "../scripts/build.mjs";
const config = JSON.parse(
  await readFile(new URL("./fixtures/platform.json", import.meta.url)),
);
// Editorial fixture arguments below explicitly establish the independent
// human-authored data used when feeds are built; monitoring never receives it.
const reduceChecks = (config, _editorial, previous, results) => reduceMeasurements(config, previous, results);
const epoch = Date.parse("2026-10-29T12:00:00Z");
function enabled() {
  const c = structuredClone(config);
  c.monitors.forEach((m) => {
    m.enabled = true;
    m.url = "https://readiness.example.org/ready";
  });
  return c;
}
function results(c, ok, tick) {
  return Object.fromEntries(
    c.monitors.map((m) => [
      m.id,
      {
        checkedAt: new Date(epoch + tick * 300000).toISOString(),
        ok,
        latencyMs: 30,
        code: ok ? "ok" : "unexpected_response",
      },
    ]),
  );
}
test("bounded exact readiness rejects redirects, HTML, extra newline and large bodies", async () => {
  const m = config.monitors[0];
  for (const [status, body, ok] of [
    [200, "ready", true],
    [301, "ready", false],
    [200, "<html>ready</html>", false],
    [200, "ready\n", false],
    [200, "a".repeat(9000), false],
  ]) {
    const output = await probe(m, async (_url, options) => {
      assert.equal(options.redirect, "manual");
      return new Response(body, { status });
    });
    assert.equal(output.ok, ok);
    assert.equal("body" in output, false);
  }
});
test("timeouts and network errors have safe stable codes", async () => {
  const m = { ...config.monitors[0], timeoutMs: 15 };
  const timeout = await probe(
    m,
    async (_, { signal }) =>
      new Promise((resolve, reject) =>
        signal.addEventListener("abort", () =>
          reject(Error("private diagnostic")),
        ),
      ),
  );
  assert.equal(timeout.code, "timeout");
  const network = await probe(m, async () => {
    throw Error("sensitive internal host");
  });
  assert.equal(network.code, "network_error");
  assert.ok(!JSON.stringify(network).includes("sensitive"));
});
test("repeated failures confirm once; duplicate checks do not multiply incidents; recovery needs two successes", () => {
  const c = enabled(),
    e = emptyEditorial();
  let m = emptyMeasurements();
  m = reduceChecks(c, e, m, results(c, false, 0));
  assert.equal(m.incidents.length, 3);
  assert.equal(m.incidents[0].confirmed, false);
  assert.equal(makeFeeds(c,e,m,epoch)[0].activeIncidents[0].messageCode, 'service_degraded');
  assert.equal(m.monitors[c.monitors[0].id].availability, "degraded");
  m = reduceChecks(c, e, m, results(c, false, 1));
  assert.equal(m.incidents[0].confirmed, true);
  assert.equal(m.monitors[c.monitors[0].id].availability, "unavailable");
  const saved = structuredClone(m);
  m = reduceChecks(c, e, m, results(c, false, 1));
  assert.deepEqual(m, saved);
  m = reduceChecks(c, e, m, results(c, true, 2));
  assert.equal(m.incidents[0].endedAt, null);
  m = reduceChecks(c, e, m, results(c, true, 3));
  assert.ok(m.incidents.every((i) => i.endedAt));
  m = reduceChecks(c, e, m, results(c, false, 4));
  assert.equal(m.incidents.length, 6);
  assert.notEqual(m.incidents[0].id, m.incidents[3].id);
});
test("one-check outages are retained in history", () => {
  const c = enabled(),
    e = emptyEditorial();
  let m = reduceChecks(c, e, emptyMeasurements(), results(c, false, 0));
  m = reduceChecks(c, e, m, results(c, true, 1));
  m = reduceChecks(c, e, m, results(c, true, 2));
  assert.equal(m.incidents.length, 3);
  assert.ok(m.incidents.every((i) => i.endedAt && !i.confirmed));
  const feed = makeFeeds(c, e, m, epoch + 600000)[0];
  assert.ok(feed.incidents.length);
  assert.equal(feed.activeIncidents.length, 0);
});
test("shared infrastructure creates one stable incident across projects", () => {
  const c = enabled();
  c.monitors.forEach((m) => {
    m.groupId = "shared-infrastructure";
  });
  const m = reduceChecks(
    c,
    emptyEditorial(),
    emptyMeasurements(),
    results(c, false, 0),
  );
  assert.equal(m.incidents.length, 1);
  assert.equal(m.incidents[0].componentIds.length, 3);
  const feeds = makeFeeds(c, emptyEditorial(), m, epoch);
  assert.equal(feeds[0].activeIncidents[0].id, feeds[1].activeIncidents[0].id);
});
test("editorial resolved cannot override unhealthy measurement, and human history is untouched", () => {
  const c = enabled();
  const m = reduceChecks(
    c,
    emptyEditorial(),
    emptyMeasurements(),
    results(c, false, 0),
  );
  const a = m.incidents[0],
    e = {
      schemaVersion: "1.0",
      incidents: [
        {
          id: a.id,
          kind: "incident",
          title: "Public explanation",
          phase: "resolved",
          componentIds: a.componentIds,
          createdAt: a.startedAt,
          startsAt: null,
          endsAt: null,
          updates: [
            {
              id: "u-1",
              at: a.startedAt,
              phase: "resolved",
              translations: { fr: "Accès rétabli." },
            },
          ],
        },
      ],
    };
  const snapshot = structuredClone(e);
  const next = reduceChecks(c, e, m, results(c, false, 1));
  assert.deepEqual(e, snapshot);
  const f = makeFeeds(c, e, next, epoch + 300000)[0];
  assert.equal(f.availability, "unavailable");
  assert.equal(f.activeIncidents[0].phase, "resolved");
  assert.equal(f.activeIncidents[0].measurementActive, true);
});
test("publication never advances check times; missing and expired measurements become unknown", () => {
  const c = enabled(),
    e = emptyEditorial(),
    m = reduceChecks(c, e, emptyMeasurements(), results(c, true, 0));
  const fresh = makeFeeds(c, e, m, epoch + 60000)[0],
    expired = makeFeeds(c, e, m, epoch + 900001)[0];
  assert.equal(fresh.availability, "operational");
  assert.equal(expired.availability, "unknown");
  assert.equal(
    expired.components[0].lastCheckedAt,
    fresh.components[0].lastCheckedAt,
  );
  assert.equal(
    liveAvailability(fresh.components[0], epoch + 900001),
    "unknown",
  );
  assert.equal(
    makeFeeds(c, e, emptyMeasurements(), epoch)[0].availability,
    "unknown",
  );
});
test("language fallback is exact, base, localized generic; public page can opt into English", () => {
  const t = {
    "fr-CA": "Au Canada",
    fr: "En français",
    en: "English explanation",
  };
  assert.equal(explanation(t, "fr-CA"), "Au Canada");
  assert.equal(explanation(t, "fr-BE"), "En français");
  assert.equal(
    explanation({ en: "English" }, "fr", "service_unavailable"),
    "Service indisponible",
  );
  assert.equal(
    explanation({ en: "English" }, "fr", "investigating", true),
    "English",
  );
  for (const code of [
    "service_unavailable",
    "service_degraded",
    "scheduled_maintenance",
    "investigating",
    "monitoring",
    "resolved",
  ])
    assert.notEqual(generic(code, "fr"), code);
});
test("bad references, malformed paths, unknown fields, and invalid maintenance fail validation", () => {
  const c = enabled();
  c.projects[0].id = "../outside";
  assert.throws(() =>
    makeFeeds(c, emptyEditorial(), emptyMeasurements(), epoch),
  );
  const d = enabled();
  d.monitors[0].url = "https://host.example/?secret=x";
  assert.throws(() =>
    validatePlatform(d, emptyEditorial(), emptyMeasurements()),
  );
  const e = emptyEditorial();
  e.privateNotes = "not allowed";
  assert.throws(() => makeFeeds(config, e, emptyMeasurements()));
});
test("failed generation retains the last valid output", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "status-build-test-"));
  try {
    for (const dir of ["config", "data", "dist"])
      await mkdir(path.join(root, dir));
    await writeFile(
      path.join(root, "config/platform.json"),
      JSON.stringify(config),
    );
    await writeFile(
      path.join(root, "data/editorial.json"),
      '{"schemaVersion":"broken"}',
    );
    await writeFile(
      path.join(root, "data/measurements.json"),
      JSON.stringify(emptyMeasurements()),
    );
    await writeFile(path.join(root, "dist/status.json"), "last valid feed");
    await assert.rejects(publishLocal({ root, revision: "test" }));
    assert.equal(
      await readFile(path.join(root, "dist/status.json"), "utf8"),
      "last valid feed",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("only trusted triggers can publish; pull-request validation has no secrets or write permission", async () => {
  const workflow = await readFile(
    new URL("../.github/workflows/pipeline.yml", import.meta.url),
    "utf8",
  );
  for (const trigger of [
    "pull_request_target:",
    "issues:",
    "issue_comment:",
    "pull_request:",
  ])
    assert.ok(!workflow.includes(trigger));
  assert.ok(workflow.includes("ref: main"));
  assert.ok(workflow.includes("group: status-pipeline"));
  const ci = await readFile(
    new URL("../.github/workflows/ci.yml", import.meta.url),
    "utf8",
  );
  assert.ok(!ci.includes("secrets."));
  assert.ok(!ci.includes(": write"));
});
test("direct GitHub editorial changes cannot reclassify an active automatic outage", () => {
  const c = enabled(),
    e = emptyEditorial();
  const m = reduceChecks(c, e, emptyMeasurements(), results(c, false, 0));
  e.incidents.push({
    id: m.incidents[0].id,
    kind: "maintenance",
    title: "Invalid overlay",
    phase: "completed",
    componentIds: m.incidents[0].componentIds,
    createdAt: new Date(epoch).toISOString(),
    startsAt: new Date(epoch).toISOString(),
    endsAt: new Date(epoch + 10000).toISOString(),
    updates: [],
  });
  assert.throws(() => makeFeeds(c, e, m, epoch), /cannot become maintenance/);
});

import { nextExpiration, validCatalog } from "../shared/messages.mjs";
test("expiry deadlines and malformed static catalogs fail conservatively", () => {
  const c = enabled(),
    e = emptyEditorial(),
    m = reduceChecks(c, e, emptyMeasurements(), results(c, true, 0));
  const feeds = makeFeeds(c, e, m, epoch);
  const catalog = {
    schemaVersion: "1.0",
    brand: c.brand,
    languages: c.languages,
    generatedAt: new Date(epoch).toISOString(),
    feeds,
  };
  assert.equal(validCatalog(catalog), true);
  assert.equal(
    nextExpiration(
      feeds.flatMap((f) => f.components),
      epoch,
    ),
    epoch + 900000,
  );
  assert.equal(
    nextExpiration(
      feeds.flatMap((f) => f.components),
      epoch + 900001,
    ),
    null,
  );
  assert.equal(
    liveAvailability(
      { ...feeds[0].components[0], expiresAt: "invalid" },
      epoch,
    ),
    "unknown",
  );
  assert.equal(
    validCatalog({
      schemaVersion: "1.0",
      feeds: [{ components: [], incidents: null }],
    }),
    false,
  );
  const invalid = structuredClone(catalog);
  invalid.languages = ["en-12"];
  assert.equal(validCatalog(invalid), false);
});

import { execFileSync } from "node:child_process";
test("a concurrent editorial commit does not discard a measured short outage", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "status-git-race-"));
  const git = (...args) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        ...args,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  try {
    const remote = path.join(root, "remote.git"),
      monitor = path.join(root, "monitor"),
      admin = path.join(root, "admin");
    git("init", "--bare", "--initial-branch=main", remote);
    git("init", "--initial-branch=main", monitor);
    await mkdir(path.join(monitor, "data"));
    await writeFile(
      path.join(monitor, "data/measurements.json"),
      JSON.stringify(emptyMeasurements()),
    );
    await writeFile(
      path.join(monitor, "data/editorial.json"),
      JSON.stringify(emptyEditorial()),
    );
    git("-C", monitor, "add", "data");
    git("-C", monitor, "commit", "-m", "Initialize fixture");
    git("-C", monitor, "remote", "add", "origin", remote);
    git("-C", monitor, "push", "-u", "origin", "main");
    git("clone", remote, admin);
    const measured = reduceChecks(
      enabled(),
      emptyEditorial(),
      emptyMeasurements(),
      results(enabled(), false, 0),
    );
    await writeFile(
      path.join(monitor, "data/measurements.json"),
      JSON.stringify(measured),
    );
    git("-C", monitor, "add", "data/measurements.json");
    git("-C", monitor, "commit", "-m", "Actual failed sample");
    const editorial = emptyEditorial();
    editorial.incidents = [
      {
        id: "manual-fixture",
        kind: "incident",
        title: "Public update",
        componentIds: ["example-api"],
        phase: "investigating",
        createdAt: new Date(epoch).toISOString(),
        startsAt: null,
        endsAt: null,
        updates: [],
      },
    ];
    await writeFile(
      path.join(admin, "data/editorial.json"),
      JSON.stringify(editorial),
    );
    git("-C", admin, "add", "data/editorial.json");
    git("-C", admin, "commit", "-m", "Concurrent editorial update");
    git("-C", admin, "push", "origin", "main");
    assert.throws(() => git("-C", monitor, "push", "origin", "HEAD:main"));
    git("-C", monitor, "pull", "--rebase", "origin", "main");
    git("-C", monitor, "push", "origin", "HEAD:main");
    const persisted = JSON.parse(
      git("--git-dir=" + remote, "show", "main:data/measurements.json"),
    );
    assert.equal(
      persisted.incidents[0].startedAt,
      new Date(epoch).toISOString(),
    );
    assert.equal(persisted.incidents.length, 3);
    assert.equal(
      JSON.parse(git("--git-dir=" + remote, "show", "main:data/editorial.json"))
        .incidents[0].id,
      "manual-fixture",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('malformed public explanations do not stop independent measurement persistence',async()=>{
 const root=await mkdtemp(path.join(os.tmpdir(),'status-editorial-isolation-'));
 try{
  await mkdir(path.join(root,'config'));await mkdir(path.join(root,'data'));
  await writeFile(path.join(root,'config/platform.json'),JSON.stringify(config));
  await writeFile(path.join(root,'data/measurements.json'),JSON.stringify(emptyMeasurements()));
  await writeFile(path.join(root,'data/editorial.json'),'MALFORMED PUBLIC EDIT');
  execFileSync(process.execPath,[new URL('../scripts/monitor.mjs',import.meta.url).pathname],{cwd:root,stdio:'ignore'});
  assert.deepEqual(JSON.parse(await readFile(path.join(root,'data/measurements.json'),'utf8')),emptyMeasurements());
  assert.equal(await readFile(path.join(root,'data/editorial.json'),'utf8'),'MALFORMED PUBLIC EDIT');
 }finally{await rm(root,{recursive:true,force:true});}
});
