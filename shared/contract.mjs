import Ajv from "ajv/dist/2020.js";
import formats from "ajv-formats";
import configSchema from "./schemas/config.schema.json" with { type: "json" };
import editorialSchema from "./schemas/editorial.schema.json" with { type: "json" };
import measurementsSchema from "./schemas/measurements.schema.json" with { type: "json" };
import feedSchema from "./schemas/feed.schema.json" with { type: "json" };

const ajv = new Ajv({ allErrors: true, strict: true });
formats(ajv);
const validators = Object.fromEntries(
  Object.entries({
    config: configSchema,
    editorial: editorialSchema,
    measurements: measurementsSchema,
    feed: feedSchema,
  }).map(([k, v]) => [k, ajv.compile(v)]),
);
export function validate(kind, value) {
  if (!validators[kind]?.(value))
    throw new Error(
      `Invalid ${kind}: ${ajv.errorsText(validators[kind]?.errors)}`,
    );
  return value;
}
function unique(values, label) {
  if (new Set(values).size !== values.length)
    throw new Error(`Duplicate ${label}`);
}
export function validatePlatform(config, editorial, measurements) {
  validate("config", config);
  validate("editorial", editorial);
  validate("measurements", measurements);
  let languages;
  try {
    languages = config.languages.map((l) => Intl.getCanonicalLocales(l)[0]);
  } catch {
    throw new Error("Invalid language tag");
  }
  unique(languages, "canonical language tags");
  for (const key of ["projects", "components", "monitors"])
    unique(
      config[key].map((x) => x.id),
      key,
    );
  unique(
    editorial.incidents.map((x) => x.id),
    "incident IDs",
  );
  unique(
    measurements.incidents.map((x) => x.id),
    "automatic IDs",
  );
  const projects = new Set(config.projects.map((x) => x.id));
  const components = new Set(config.components.map((x) => x.id));
  const reference = (values, set) => {
    if (values.some((x) => !set.has(x)))
      throw new Error("Unknown referenced ID");
  };
  config.components.forEach((x) => reference(x.projectIds, projects));
  config.monitors.forEach((x) => {
    reference(x.componentIds, components);
    if (new TextEncoder().encode(x.expectedBody).length > 8192)
      throw new Error("Expected readiness body exceeds 8 KiB");
    const u = new URL(x.url);
    if (u.username || u.password || u.hash || u.search)
      throw new Error(
        "Readiness URLs cannot contain credentials, query strings or fragments",
      );
    if (
      x.enabled &&
      (u.hostname.endsWith(".invalid") ||
        u.hostname === "localhost" ||
        /^[\d.:]+$/.test(u.hostname))
    )
      throw new Error("Enabled monitors require a public DNS hostname");
  });
  for (const x of editorial.incidents) {
    if (
      [x.createdAt, x.startsAt, x.endsAt, ...x.updates.map((u) => u.at)].some(
        (at) => at !== null && !Number.isFinite(Date.parse(at)),
      )
    )
      throw new Error("Invalid incident timestamp");
    if (
      measurements.incidents.some((a) => a.id === x.id) &&
      x.kind !== "incident"
    )
      throw new Error("An automatic incident cannot become maintenance");
    reference(x.componentIds, components);
    unique(
      x.updates.map((u) => u.id),
      "update IDs",
    );
    if (
      x.kind === "maintenance" &&
      (!x.startsAt ||
        !x.endsAt ||
        Date.parse(x.startsAt) >= Date.parse(x.endsAt))
    )
      throw new Error("Maintenance requires an ordered time window");
    if (
      x.kind === "incident" &&
      ["scheduled", "in_progress", "completed", "cancelled"].includes(x.phase)
    )
      throw new Error("Invalid incident phase");
    if (
      x.kind === "maintenance" &&
      !["scheduled", "in_progress", "completed", "cancelled"].includes(x.phase)
    )
      throw new Error("Invalid maintenance phase");
    if (x.updates.length && x.updates.at(-1).phase !== x.phase)
      throw new Error("Latest update must match current phase");
    let last = Date.parse(x.createdAt);
    for (const u of x.updates) {
      if (Date.parse(u.at) < last)
        throw new Error("Updates must be chronological");
      last = Date.parse(u.at);
      for (const lang of Object.keys(u.translations))
        if (!config.languages.includes(lang))
          throw new Error("Language is not configured");
    }
  }
  measurements.incidents.forEach((x) => reference(x.componentIds, components));
  return config;
}
export const emptyEditorial = () => ({ schemaVersion: "1.0", incidents: [] });
export const emptyMeasurements = () => ({
  schemaVersion: "1.0",
  monitors: {},
  incidents: [],
});
export const rank = { operational: 0, unknown: 1, degraded: 2, unavailable: 3 };
export const worst = (values) =>
  values.length
    ? values.reduce((a, b) => (rank[b] > rank[a] ? b : a), "operational")
    : "unknown";
export function isFresh(checkedAt, now, seconds) {
  const age = now - Date.parse(checkedAt);
  return Number.isFinite(age) && age >= -30000 && age < seconds * 1000;
}
export function componentHealth(component, config, measurements, now) {
  const monitors = config.monitors.filter(
    (m) => m.enabled && m.componentIds.includes(component.id),
  );
  const checks = monitors.map((m) => measurements.monitors[m.id]);
  const availability = worst(
    checks.map((s) =>
      s && isFresh(s.checkedAt, now, config.freshnessSeconds)
        ? s.availability
        : "unknown",
    ),
  );
  const checked =
    checks.every(Boolean) && checks.length
      ? Math.min(...checks.map((s) => Date.parse(s.checkedAt)))
      : null;
  return {
    ...component,
    availability,
    messageCode: {
      operational: "operational",
      unknown: "unknown",
      degraded: "service_degraded",
      unavailable: "service_unavailable",
    }[availability],
    lastCheckedAt: checked === null ? null : new Date(checked).toISOString(),
    expiresAt:
      checked === null
        ? null
        : new Date(checked + config.freshnessSeconds * 1000).toISOString(),
    monitorIds: monitors.map((m) => m.id),
  };
}
export function publicIncidents(config, editorial, measurements, now) {
  const records = new Map(
    editorial.incidents.map((x) => [x.id, structuredClone(x)]),
  );
  for (const automatic of measurements.incidents) {
    let record = records.get(automatic.id);
    if (!record)
      record = {
        id: automatic.id,
        kind: "incident",
        title: "Service availability interruption",
        componentIds: automatic.componentIds,
        phase: automatic.endedAt ? "resolved" : "investigating",
        createdAt: automatic.startedAt,
        startsAt: null,
        endsAt: null,
        updates: [],
      };
    record.componentIds = [
      ...new Set([...record.componentIds, ...automatic.componentIds]),
    ];
    records.set(automatic.id, {
      ...record,
      measurementActive: !automatic.endedAt,
      measurementEndedAt: automatic.endedAt,
      confirmed: automatic.confirmed,
    });
  }
  return [...records.values()]
    .map((x) => ({
      ...x,
      measurementActive: x.measurementActive ?? false,
      measurementEndedAt: x.measurementEndedAt ?? null,
      confirmed: x.confirmed ?? false,
      messageCode:
        x.kind === "maintenance"
          ? "scheduled_maintenance"
          : x.measurementActive
            ? x.confirmed ? "service_unavailable" : "service_degraded"
            : ["monitoring", "resolved"].includes(x.phase)
              ? x.phase
              : "investigating",
      url: `${config.brand.publicUrl.replace(/\/$/, "")}/#incident-${x.id}`,
    }))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export function makeFeeds(
  config,
  editorial,
  measurements,
  now = Date.now(),
  sourceRevision = "local",
) {
  validatePlatform(config, editorial, measurements);
  const components = config.components.map((c) =>
    componentHealth(c, config, measurements, now),
  );
  const incidents = publicIncidents(config, editorial, measurements, now);
  return config.projects.map((project) => {
    const own = components.filter((c) => c.projectIds.includes(project.id));
    const componentIds = new Set(own.map((c) => c.id));
    const relevant = incidents.filter((i) =>
      i.componentIds.some((id) => componentIds.has(id)),
    );
    const expiry =
      own.every((c) => c.expiresAt) && own.length
        ? new Date(
            Math.min(...own.map((c) => Date.parse(c.expiresAt))),
          ).toISOString()
        : null;
    const feed = {
      schemaVersion: "1.0",
      project,
      availability: worst(own.map((c) => c.availability)),
      components: own,
      incidents: relevant,
      activeIncidents: relevant.filter(
        (i) =>
          i.kind === "incident" &&
          (i.measurementActive || i.phase !== "resolved"),
      ),
      maintenance: relevant.filter(
        (i) =>
          i.kind === "maintenance" &&
          !["completed", "cancelled"].includes(i.phase) &&
          Date.parse(i.endsAt) > now,
      ),
      generatedAt: new Date(now).toISOString(),
      expiresAt: expiry,
      freshnessSeconds: config.freshnessSeconds,
      statusUrl: `${config.brand.publicUrl.replace(/\/$/, "")}/?project=${project.id}`,
      sourceRevision,
    };
    validate("feed", feed);
    return feed;
  });
}
