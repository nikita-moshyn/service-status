import { isFresh, validatePlatform, emptyEditorial } from "../shared/contract.mjs";

// No body, URL, response header or exception text is persisted or logged.
export async function probe(monitor, fetcher = fetch, clock = Date.now) {
  const started = clock();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), monitor.timeoutMs);
  let reader;
  try {
    const response = await fetcher(monitor.url, {
      redirect: "manual",
      signal: controller.signal,
      headers: {
        Accept: "text/plain",
        "User-Agent": "service-status-readiness/1",
      },
    });
    if (response.status !== monitor.expectedStatus)
      return {
        checkedAt: new Date(clock()).toISOString(),
        ok: false,
        latencyMs: Math.max(0, clock() - started),
        code: "unexpected_response",
      };
    reader = response.body?.getReader();
    let bytes = 0;
    const chunks = [];
    if (reader)
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.length;
        if (bytes > 8192) {
          controller.abort();
          return {
            checkedAt: new Date(clock()).toISOString(),
            ok: false,
            latencyMs: Math.max(0, clock() - started),
            code: "unexpected_response",
          };
        }
        chunks.push(value);
      }
    const body = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
    const ok = body === monitor.expectedBody;
    return {
      checkedAt: new Date(clock()).toISOString(),
      ok,
      latencyMs: Math.max(0, clock() - started),
      code: ok ? "ok" : "unexpected_response",
    };
  } catch {
    return {
      checkedAt: new Date(clock()).toISOString(),
      ok: false,
      latencyMs: Math.max(0, clock() - started),
      code: controller.signal.aborted ? "timeout" : "network_error",
    };
  } finally {
    clearTimeout(timer);
    try {
      await reader?.cancel();
    } catch {}
  }
}
export function reduceChecks(config, previous, results) {
  validatePlatform(config, emptyEditorial(), previous);
  const state = structuredClone(previous);
  for (const monitor of config.monitors.filter((m) => m.enabled)) {
    const result = results[monitor.id];
    if (!result) continue;
    const old = state.monitors[monitor.id];
    if (old && Date.parse(result.checkedAt) <= Date.parse(old.checkedAt))
      continue;
    const consecutive =
      old &&
      isFresh(
        old.checkedAt,
        Date.parse(result.checkedAt),
        config.freshnessSeconds,
      );
    const failureCount = result.ok
      ? 0
      : (consecutive ? old.failureCount : 0) + 1;
    const successCount = result.ok
      ? (consecutive ? old.successCount : 0) + 1
      : 0;
    const wasBad =
      old && ["degraded", "unavailable"].includes(old.availability);
    state.monitors[monitor.id] = {
      ...result,
      failureCount,
      successCount,
      availability: !result.ok
        ? failureCount >= config.failureThreshold
          ? "unavailable"
          : "degraded"
        : wasBad && successCount < config.recoveryThreshold
          ? "degraded"
          : "operational",
      failureSince:
        result.ok && (!wasBad || successCount >= config.recoveryThreshold)
          ? null
          : old?.failureSince || result.checkedAt,
    };
  }
  const groups = new Map();
  for (const m of config.monitors.filter((m) => m.enabled))
    groups.set(m.groupId, [...(groups.get(m.groupId) || []), m]);
  for (const [groupId, monitors] of groups) {
    if (!monitors.some((m) => results[m.id])) continue;
    const bad = monitors.filter((m) =>
      ["degraded", "unavailable"].includes(state.monitors[m.id]?.availability),
    );
    let incident = state.incidents.find(
      (i) => i.groupId === groupId && !i.endedAt,
    );
    if (bad.length) {
      const at = bad.map((m) => state.monitors[m.id].failureSince).sort()[0];
      const components = [...new Set(bad.flatMap((m) => m.componentIds))];
      if (!incident) {
        incident = {
          id: `auto-${groupId}-${at.replace(/\D/g, "")}`,
          groupId,
          componentIds: components,
          startedAt: at,
          endedAt: null,
          confirmed: false,
        };
        state.incidents.push(incident);
      }
      incident.componentIds = [
        ...new Set([...incident.componentIds, ...components]),
      ];
      incident.confirmed ||= bad.some(
        (m) => state.monitors[m.id].availability === "unavailable",
      );
    } else if (
      incident &&
      monitors.every((m) => {
        const s = state.monitors[m.id];
        return results[m.id]?.ok && s?.successCount >= config.recoveryThreshold;
      })
    )
      incident.endedAt = monitors
        .map((m) => state.monitors[m.id].checkedAt)
        .sort()
        .at(-1);
  }
  validatePlatform(config, emptyEditorial(), state);
  return state;
}
