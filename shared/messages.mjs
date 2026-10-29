export const messages = {
  en: {
    operational: "Operational",
    unknown: "Health unknown",
    service_unavailable: "Service unavailable",
    service_degraded: "Service degraded",
    scheduled_maintenance: "Scheduled maintenance",
    investigating: "Investigating",
    identified: "Identified",
    monitoring: "Monitoring",
    resolved: "Resolved",
    scheduled: "Scheduled",
    in_progress: "In progress",
    completed: "Completed",
    cancelled: "Cancelled",
  },
  fr: {
    operational: "Opérationnel",
    unknown: "État inconnu",
    service_unavailable: "Service indisponible",
    service_degraded: "Service dégradé",
    scheduled_maintenance: "Maintenance planifiée",
    investigating: "Investigation en cours",
    identified: "Problème identifié",
    monitoring: "Sous surveillance",
    resolved: "Résolu",
    scheduled: "Planifiée",
    in_progress: "En cours",
    completed: "Terminée",
    cancelled: "Annulée",
  },
};
export function generic(code, locale = "en") {
  code =
    { unavailable: "service_unavailable", degraded: "service_degraded" }[
      code
    ] || code;
  const key =
    Object.keys(messages).find(
      (k) => k.toLowerCase() === locale.toLowerCase(),
    ) || locale.split("-")[0].toLowerCase();
  return (messages[key] || messages.en)[code] || messages.en[code] || code;
}
export function explanation(
  translations = {},
  locale = "en",
  code = "investigating",
  englishFallback = false,
) {
  const find = (key) =>
    Object.entries(translations).find(
      ([k, v]) => k.toLowerCase() === key.toLowerCase() && v.trim(),
    )?.[1];
  return (
    find(locale) ||
    find(locale.split("-")[0]) ||
    (englishFallback && find("en")) ||
    generic(code, locale)
  );
}
export function liveAvailability(component, now = Date.now()) {
  if (
    !Number.isFinite(Date.parse(component.lastCheckedAt)) ||
    !Number.isFinite(Date.parse(component.expiresAt))
  )
    return "unknown";
  return !component.expiresAt ||
    now >= Date.parse(component.expiresAt) ||
    !component.lastCheckedAt ||
    Date.parse(component.lastCheckedAt) > now + 30000
    ? "unknown"
    : component.availability;
}

export function nextExpiration(components, now = Date.now()) {
  const deadlines = components
    .map((c) => Date.parse(c.expiresAt))
    .filter((at) => at > now);
  return deadlines.length ? Math.min(...deadlines) : null;
}

// Defensive catalog shape check for the static website. Full JSON Schema
// validation happens before publication; malformed network payloads still get
// an explicit unavailable screen instead of crashing the renderer.
export function validCatalog(data) {
  const text = (value) => typeof value === "string";
  const date = (value) =>
    value === null || (text(value) && Number.isFinite(Date.parse(value)));
  try {
    return (
      data.schemaVersion === "1.0" &&
      text(data.brand.name) &&
      date(data.generatedAt) &&
      Array.isArray(data.languages) &&
      data.languages.length > 0 &&
      data.languages.every(
        (l) => text(l) && Intl.getCanonicalLocales(l).length === 1,
      ) &&
      Array.isArray(data.feeds) &&
      data.feeds.every(
        (f) =>
          text(f.project.id) &&
          text(f.project.name) &&
          Array.isArray(f.components) &&
          f.components.every(
            (c) =>
              text(c.id) &&
              text(c.name) &&
              Array.isArray(c.projectIds) &&
              c.projectIds.every(text) &&
              ["operational", "degraded", "unavailable", "unknown"].includes(
                c.availability,
              ) &&
              date(c.lastCheckedAt) &&
              date(c.expiresAt),
          ) &&
          Array.isArray(f.incidents) &&
          f.incidents.every(
            (i) =>
              text(i.id) &&
              text(i.title) &&
              text(i.phase) &&
              text(i.kind) &&
              date(i.createdAt) &&
              date(i.startsAt) &&
              date(i.endsAt) &&
              date(i.measurementEndedAt) &&
              Array.isArray(i.componentIds) &&
              i.componentIds.every(text) &&
              Array.isArray(i.updates) &&
              i.updates.every(
                (u) =>
                  text(u.id) &&
                  date(u.at) &&
                  text(u.phase) &&
                  u.translations &&
                  Object.values(u.translations).every(text),
              ),
          ),
      )
    );
  } catch {
    return false;
  }
}
