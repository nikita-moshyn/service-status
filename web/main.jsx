import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  explanation,
  generic,
  liveAvailability,
  nextExpiration,
  validCatalog,
} from "../shared/messages.mjs";
import "./style.css";
const severity = { operational: 0, unknown: 1, degraded: 2, unavailable: 3 };
const worst = (xs) =>
  xs.length
    ? xs.reduce((a, b) => (severity[b] > severity[a] ? b : a), "operational")
    : "unknown";
const time = (value, locale) =>
  value
    ? new Intl.DateTimeFormat(locale, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(value))
    : "—";
function App() {
  const [data, setData] = useState(null),
    [error, setError] = useState(false),
    [now, setNow] = useState(Date.now()),
    [project, setProject] = useState(
      new URLSearchParams(location.search).get("project") || "",
    ),
    [locale, setLocale] = useState("en");
  const [component, setComponent] = useState("");
  async function load() {
    try {
      const r = await fetch("./v1/index.json", { cache: "no-cache" });
      if (!r.ok) throw Error();
      const d = await r.json();
      if (!validCatalog(d)) throw Error();
      setData(d);
      setLocale((old) =>
        d.languages.includes(old) ? old : d.languages[0] || "en",
      );
      setError(false);
    } catch {
      setError(true);
    }
  }
  useEffect(() => {
    load();
    const timer = setInterval(() => {
      setNow(Date.now());
      load();
    }, 60000);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);
  useEffect(() => {
    const updateClock = () => setNow(Date.now());
    const at = nextExpiration(data?.feeds.flatMap((f) => f.components) || []);
    const timer = at
      ? setTimeout(updateClock, Math.max(1, at - Date.now() + 5))
      : null;
    addEventListener("focus", updateClock);
    document.addEventListener("visibilitychange", updateClock);
    return () => {
      clearTimeout(timer);
      removeEventListener("focus", updateClock);
      document.removeEventListener("visibilitychange", updateClock);
    };
  }, [data, now]);
  if (!data)
    return (
      <main className="public-main">
        <h1>Service status</h1>
        <p role="status">
          {error
            ? "Status data is unavailable. Health is unknown."
            : "Loading service status…"}
        </p>
        {error && <button onClick={load}>Try again</button>}
      </main>
    );
  const feeds = data.feeds.filter((f) => !project || f.project.id === project);
  const components = [
    ...new Map(
      feeds.flatMap((f) => f.components).map((c) => [c.id, c]),
    ).values(),
  ].filter((c) => !component || component === c.id);
  const incidents = [
    ...new Map(
      feeds.flatMap((f) => f.incidents).map((i) => [i.id, i]),
    ).values(),
  ].filter((i) => !component || i.componentIds.includes(component));
  const active = incidents.filter(
    (i) =>
      i.kind === "incident" && (i.measurementActive || i.phase !== "resolved"),
  );
  const maintenance = incidents.filter(
    (i) =>
      i.kind === "maintenance" &&
      !["completed", "cancelled"].includes(i.phase) &&
      Date.parse(i.endsAt) > now,
  );
  const health = error
    ? "unknown"
    : worst(components.map((c) => liveAvailability(c, now)));
  const english = !locale.toLowerCase().startsWith("fr");
  const t = (en, fr) => (english ? en : fr);
  function incident(i) {
    return (
      <article key={i.id} id={`incident-${i.id}`} className="incident">
        <div className="row">
          <h3>{i.title}</h3>
          <span className="tag">{generic(i.phase, locale)}</span>
        </div>
        <p className="muted">
          {i.componentIds
            .map((id) => components.find((c) => c.id === id)?.name || id)
            .join(" · ")}{" "}
          · {time(i.createdAt, locale)}
        </p>
        {i.measurementActive && (
          <p className="warning">
            {t(
              "Measured disruption remains active.",
              "La perturbation mesurée reste active.",
            )}
          </p>
        )}
        {i.kind === "maintenance" && (
          <p>
            {time(i.startsAt, locale)} — {time(i.endsAt, locale)}
          </p>
        )}
        {!i.updates.length && <p>{generic(i.messageCode, locale)}</p>}
        {[...i.updates].reverse().map((u) => (
          <div className="update" key={u.id}>
            <div className="muted">
              {time(u.at, locale)} · {generic(u.phase, locale)}
            </div>
            <p className="prose">
              {explanation(u.translations, locale, i.messageCode, true)}
            </p>
          </div>
        ))}
        {i.measurementEndedAt && (
          <p className="muted">
            {t("Measured recovery", "Rétablissement mesuré")} ·{" "}
            {time(i.measurementEndedAt, locale)}
          </p>
        )}
        <a href={`#incident-${i.id}`}>
          {t("Incident link", "Lien de l’incident")}
        </a>
      </article>
    );
  }
  return (
    <>
      <a className="skip" href="#content">
        {t("Skip to content", "Aller au contenu")}
      </a>
      <header className="public-header">
        <a className="brand" href="./">
          <span className="mark" aria-hidden="true">
            ss<span>_</span>
          </span>
          {data.brand.name}
        </a>
        <label>
          {t("Language", "Langue")}
          <select value={locale} onChange={(e) => setLocale(e.target.value)}>
            {data.languages.map((l) => (
              <option key={l}>{l}</option>
            ))}
          </select>
        </label>
      </header>
      <main id="content" className="public-main">
        <div className="status-heading">
          <div>
            <h1>{t("Current service health", "État actuel des services")}</h1>
            <p className="muted">
              {t(
                "Measured availability across our services.",
                "Disponibilité mesurée de nos services.",
              )}
            </p>
          </div>
          <span className={`health ${health}`}>{generic(health, locale)}</span>
        </div>
        {(error ||
          components.some((c) => liveAvailability(c, now) === "unknown")) && (
          <p className="notice" role="status">
            {error
              ? t(
                  "The latest feed could not be retrieved. Health is unknown until refreshed.",
                  "Le dernier flux est indisponible. L’état reste inconnu jusqu’à son actualisation.",
                )
              : t(
                  "Some checks are missing or expired. Their health is unknown.",
                  "Certaines vérifications sont absentes ou périmées. Leur état est inconnu.",
                )}
          </p>
        )}
        <div className="filters">
          <label>
            {t("Project", "Projet")}
            <select
              value={project}
              onChange={(e) => {
                setProject(e.target.value);
                setComponent("");
                const u = new URL(location);
                u.searchParams.set("project", e.target.value);
                history.replaceState(null, "", u);
              }}
            >
              <option value="">{t("All projects", "Tous les projets")}</option>
              {data.feeds.map((f) => (
                <option key={f.project.id} value={f.project.id}>
                  {f.project.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("Component", "Composant")}
            <select
              value={component}
              onChange={(e) => setComponent(e.target.value)}
            >
              <option value="">
                {t("All components", "Tous les composants")}
              </option>
              {[
                ...new Map(
                  feeds.flatMap((f) => f.components).map((c) => [c.id, c]),
                ).values(),
              ].map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name} · {c.id}
                </option>
              ))}
            </select>
          </label>
        </div>
        <section aria-labelledby="components">
          <h2 id="components">{t("Components", "Composants")}</h2>
          {!components.length && (
            <p className="muted">
              {t(
                "No components match this view.",
                "Aucun composant ne correspond à cette vue.",
              )}
            </p>
          )}
          {components.map((c) => (
            <div className="component" key={c.id}>
              <div>
                <strong>{c.name}</strong>
                <div className="muted">
                  {feeds
                    .filter((f) => c.projectIds.includes(f.project.id))
                    .map((f) => f.project.name)
                    .join(" / ")}
                </div>
              </div>
              <div className="check">
                <span
                  className={`health ${error ? "unknown" : liveAvailability(c, now)}`}
                >
                  {generic(
                    error ? "unknown" : liveAvailability(c, now),
                    locale,
                  )}
                </span>
                <small>
                  {t("Last check", "Dernière vérification")}{" "}
                  {time(c.lastCheckedAt, locale)}
                </small>
              </div>
            </div>
          ))}
        </section>
        <section>
          <h2>
            {t("Active incidents", "Incidents en cours")}{" "}
            <span className="count">{active.length}</span>
          </h2>
          {active.length ? (
            active.map(incident)
          ) : (
            <p className="empty">
              {t(
                "No active incidents have been published.",
                "Aucun incident en cours n’a été publié.",
              )}
            </p>
          )}
        </section>
        <section>
          <h2>{t("Scheduled maintenance", "Maintenance planifiée")}</h2>
          {maintenance.length ? (
            maintenance.map(incident)
          ) : (
            <p className="empty">
              {t("No upcoming maintenance.", "Aucune maintenance à venir.")}
            </p>
          )}
        </section>
        <section>
          <h2>{t("Incident history", "Historique des incidents")}</h2>
          {incidents
            .filter((i) => !active.includes(i) && !maintenance.includes(i))
            .map(incident)}
          {!incidents.length && (
            <p className="empty">
              {t("No recorded incidents.", "Aucun incident enregistré.")}
            </p>
          )}
        </section>
        <footer>
          <p>
            {t("Feed generated", "Flux généré")}{" "}
            {time(data.generatedAt, locale)}.{" "}
            {t(
              "Generation does not imply a new health check.",
              "La génération du flux ne constitue pas une nouvelle vérification.",
            )}
          </p>
          {feeds.map((f) => (
            <a
              key={f.project.id}
              href={`./v1/projects/${f.project.id}/status.json`}
            >
              {f.project.name} JSON
            </a>
          ))}
        </footer>
      </main>
    </>
  );
}
createRoot(document.getElementById("root")).render(<App />);
