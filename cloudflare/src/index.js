import { ROUTES, SERVICE_CALENDARS, STOPS } from "./tfi-static.generated.js";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 10;
const DEFAULT_TIME_ZONE = "Europe/Dublin";
const TRIP_UPDATES_URL = "https://api.nationaltransport.ie/gtfsr/v2/TripUpdates?format=json";

const STOP_BY_ID = new Map(STOPS.map((stop) => [stop.id, stop]));
const STOP_BY_CODE = new Map();
const PARTS_FORMATTERS = new Map();
for (const stop of STOPS) {
  const code = String(stop.code || "").trim();
  if (code && code !== "0" && !STOP_BY_CODE.has(code)) {
    STOP_BY_CODE.set(code, stop);
  }
}
const SEARCH_INDEX = STOPS.map((stop) => ({
  stop,
  name: stop.name.toLowerCase(),
  code: String(stop.code || "").toLowerCase(),
  id: stop.id.toLowerCase(),
}));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    try {
      if (url.pathname === "/") {
        return jsonResponse({
          name: "TFI TRMNL Bus Departures",
          endpoints: ["/stops", "/api/stops/search", "/api/stops/search-v2", "/api/departures", "/health"],
        });
      }

      if (url.pathname === "/health") {
        return jsonResponse({ ok: true });
      }

      if (url.pathname === "/stops") {
        return htmlResponse(stopFinderHtml());
      }

      if (url.pathname === "/api/stops/search" || url.pathname === "/api/stops/search-v2") {
        const formBody = await parseRequestBody(request);
        return jsonResponse(searchStops(url.searchParams, formBody));
      }

      if (url.pathname === "/api/departures") {
        return jsonResponse(await departuresPayload(request, url.searchParams, env));
      }

      return jsonResponse({ error: "Not found" }, 404);
    } catch (error) {
      console.error(JSON.stringify({ message: "Unhandled request error", error: String(error) }));
      return jsonResponse({ error: "Unexpected plugin error." }, 500);
    }
  },
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-CSRF-Token, x-nta-api-key, x-api-key, subscription-key, Authorization",
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function htmlResponse(markup, status = 200) {
  return new Response(markup, {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "public, max-age=300",
    },
  });
}

async function parseRequestBody(request) {
  if (request.method !== "POST") return {};

  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      const parsed = await request.json();
      return parsed && typeof parsed === "object" ? parsed : {};
    } catch {
      return {};
    }
  }

  if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = await request.formData();
    return Object.fromEntries(form.entries());
  }

  return {};
}

function searchStops(params, body = {}) {
  const query = extractSearchQuery(params, body);
  const explicitLimit = params.has("limit");
  const limit = explicitLimit
    ? clampNumber(params.get("limit"), 25, 1, STOPS.length)
    : query
      ? 50
      : STOPS.length;
  const matches = [];

  for (const entry of SEARCH_INDEX) {
    let score = 10;
    if (query) {
      if (entry.code === query) score = 0;
      else if (entry.code.startsWith(query)) score = 1;
      else if (entry.name.startsWith(query)) score = 2;
      else if (entry.name.includes(query)) score = 3;
      else if (entry.id.includes(query)) score = 4;
      else continue;
    }

    matches.push({ score, stop: entry.stop });
  }

  matches.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    return stopLabel(a.stop).localeCompare(stopLabel(b.stop));
  });

  return matches.slice(0, limit).map(({ stop }) => ({
    id: stop.id,
    name: stopLabel(stop),
  }));
}

function extractSearchQuery(params, body) {
  const candidates = [
    params.get("query"),
    params.get("q"),
    params.get("search"),
    params.get("term"),
    params.get("input"),
    params.get("value"),
    body?.query,
    body?.q,
    body?.search,
    body?.term,
    body?.input,
    body?.value,
    body?.plugin_setting?.query,
    body?.plugin_setting?.q,
    body?.params?.query,
    body?.data?.query,
  ];

  for (const candidate of candidates) {
    if (candidate !== undefined && candidate !== null && String(candidate).trim() !== "") {
      return String(candidate).trim().toLowerCase();
    }
  }
  return "";
}

async function departuresPayload(request, params, env = {}) {
  const apiKey = getApiKey(request, params);
  const stopIds = resolveStopInputs(normalizeStopIds([
    ...params.getAll("stops"),
    ...params.getAll("stop_ids"),
    params.get("stop_1"),
    params.get("stop_2"),
    params.get("stop_3"),
    params.get("stop_4"),
    params.get("stop_5"),
  ]));
  const limit = clampNumber(params.get("limit") || params.get("departure_count"), DEFAULT_LIMIT, 1, MAX_LIMIT);
  const timeZone = validTimeZone(params.get("time_zone") || params.get("tz") || DEFAULT_TIME_ZONE);
  const debug = ["1", "true", "yes"].includes(normalizeFormValue(params.get("debug")).toLowerCase());
  const now = Date.now();
  const generatedAt = new Date(now);
  const selectedStops = stopIds.map((id) => {
    const stop = STOP_BY_ID.get(id);
    return {
      id,
      name: stop?.name || id,
      code: stop?.code || "",
    };
  });

  const payload = {
    title: "Next Bus",
    generated_at: formatTime(generatedAt, timeZone),
    date: formatDate(generatedAt, timeZone),
    stops: selectedStops,
    stops_label: stopsLabel(selectedStops),
    departures: [],
    message: "",
    error: "",
  };

  if (stopIds.length === 0) {
    payload.error = "Choose at least one stop.";
    return payload;
  }

  if (!apiKey) {
    payload.error = "Missing NTA API key.";
    return payload;
  }

  if (isUnresolvedTemplate(apiKey)) {
    payload.error = "NTA API key was not substituted by TRMNL. Save the plugin settings and force refresh.";
    return payload;
  }

  if (apiKey.startsWith("user_")) {
    payload.error = "The TRMNL user API key was entered as the NTA key. Paste your NTA GTFS-R subscription key instead.";
    return payload;
  }

  const schedulesPromise = loadStopSchedules(env, stopIds);
  const response = await fetch(TRIP_UPDATES_URL, {
    headers: {
      Accept: "application/json",
      "x-api-key": apiKey,
    },
  });

  if (!response.ok) {
    const body = await boundedText(response, 300);
    payload.error = `NTA API returned HTTP ${response.status}: ${body}`;
    return payload;
  }

  const feed = await response.json();
  const schedules = await schedulesPromise;
  const serviceCalendars = configuredServiceCalendars(env);
  const timestamp = Number(feed?.header?.timestamp);
  if (Number.isFinite(timestamp) && timestamp > 0) {
    payload.source_time = formatTime(new Date(timestamp * 1000), timeZone);
  }

  const debugStats = {
    selected_updates: 0,
    absolute_time_rows: 0,
    schedule_fallback_rows: 0,
    missing_schedule_rows: 0,
    realtime_rows: 0,
    static_schedule_candidates: 0,
    static_schedule_rows: 0,
    schedule_stops_loaded: schedules.size,
  };
  payload.departures = extractDepartures(feed, stopIds, limit, timeZone, now, schedules, serviceCalendars, debugStats);
  if (debug) {
    payload.debug = debugStats;
  }
  if (payload.departures.length === 0) {
    payload.message = "No upcoming departures.";
  }
  return payload;
}

function extractDepartures(feed, stopIds, limit, timeZone, nowMs, schedules = new Map(), serviceCalendars = SERVICE_CALENDARS, debugStats = {}) {
  const selected = new Set(stopIds);
  const rows = [];

  for (const entity of feed?.entity || feed?.entities || []) {
    const tripUpdate = entity.trip_update || entity.tripUpdate || {};
    const trip = tripUpdate.trip || {};
    if (String(trip.schedule_relationship || trip.scheduleRelationship || "").toUpperCase() === "CANCELED") {
      continue;
    }

    const updates = tripUpdate.stop_time_update || tripUpdate.stopTimeUpdate || entity.stop_time_update || entity.stopTimeUpdate || [];
    const routeId = trip.route_id || trip.routeId || "";
    const tripId = trip.trip_id || trip.tripId || "";

    for (const update of updates) {
      const stopId = update.stop_id || update.stopId || "";
      if (!selected.has(stopId)) continue;

      const relationship = String(update.schedule_relationship || update.scheduleRelationship || "").toUpperCase();
      if (relationship === "SKIPPED" || relationship === "NO_DATA") continue;

      const departure = update.departure || update.departureTime || {};
      const arrival = update.arrival || update.arrivalTime || {};
      const delaySeconds = numberOrNull(departure.delay) ?? numberOrNull(arrival.delay) ?? 0;
      let epochSeconds = numberOrNull(departure.time) ?? numberOrNull(arrival.time);
      let scheduleMatch = null;
      let realtimeSource = "absolute_time";
      debugStats.selected_updates = (debugStats.selected_updates || 0) + 1;

      if (epochSeconds === null) {
        scheduleMatch = scheduledDepartureForUpdate(
          trip,
          update,
          schedules.get(stopId),
          delaySeconds,
          timeZone,
          nowMs,
        );

        if (!scheduleMatch) {
          debugStats.missing_schedule_rows = (debugStats.missing_schedule_rows || 0) + 1;
          continue;
        }

        epochSeconds = scheduleMatch.epoch;
        realtimeSource = "schedule_delay";
        debugStats.schedule_fallback_rows = (debugStats.schedule_fallback_rows || 0) + 1;
      } else {
        debugStats.absolute_time_rows = (debugStats.absolute_time_rows || 0) + 1;
      }

      const eventMs = epochSeconds * 1000;
      if (eventMs < nowMs - 60_000) continue;

      const stop = STOP_BY_ID.get(stopId);
      const due = dueLabel(eventMs - nowMs);
      const eventDate = new Date(eventMs);
      const destination =
        update.stop_headsign ||
        update.stopHeadsign ||
        trip.headsign ||
        scheduleMatch?.headsign ||
        scheduleMatch?.tripHeadsign ||
        "";

      rows.push({
        epoch: epochSeconds,
        time: formatTime(eventDate, timeZone),
        due: due.label,
        due_minutes: due.minutes,
        route: ROUTES[routeId] || scheduleMatch?.route || routeId || "Bus",
        destination,
        trip_id: tripId,
        stop: stop?.name || stopId,
        stop_code: stop?.code || "",
        stop_id: stopId,
        status: delayStatus(delaySeconds),
        delay_seconds: delaySeconds,
        realtime_source: realtimeSource,
      });
    }
  }

  rows.sort((a, b) => a.epoch - b.epoch || String(a.route).localeCompare(String(b.route)));
  debugStats.realtime_rows = rows.length;

  const existingKeys = new Set(rows.map(departureKey));
  const scheduleFill = staticScheduleDepartures(stopIds, limit, timeZone, nowMs, schedules, serviceCalendars, existingKeys);
  debugStats.static_schedule_candidates = scheduleFill.candidates;
  debugStats.static_schedule_rows = scheduleFill.rows.length;

  return balancedDepartures([...rows, ...scheduleFill.rows], stopIds, limit);
}

function balancedDepartures(rows, stopIds, limit) {
  const selectedRows = [];
  const selectedKeys = new Set();

  for (const stopId of stopIds) {
    const firstForStop = rows.find((row) => row.stop_id === stopId);
    if (!firstForStop) continue;

    const key = departureKey(firstForStop);
    if (!selectedKeys.has(key)) {
      selectedRows.push(firstForStop);
      selectedKeys.add(key);
    }

    if (selectedRows.length >= limit) break;
  }

  for (const row of rows) {
    if (selectedRows.length >= limit) break;

    const key = departureKey(row);
    if (!selectedKeys.has(key)) {
      selectedRows.push(row);
      selectedKeys.add(key);
    }
  }

  return selectedRows.sort((a, b) => a.epoch - b.epoch || String(a.route).localeCompare(String(b.route)));
}

function departureKey(row) {
  if (row.trip_id) {
    return `${row.stop_id}:trip:${row.trip_id}`;
  }
  return `${row.stop_id}:${row.route}:${row.epoch}:${row.destination}`;
}

function staticScheduleDepartures(stopIds, limit, timeZone, nowMs, schedules, serviceCalendars, existingKeys) {
  const rows = [];
  let candidates = 0;
  const today = ymdInTimeZone(new Date(nowMs), timeZone);
  const serviceDates = [addYmdDays(today, -1), today, addYmdDays(today, 1)];
  const horizonMs = nowMs + 18 * 60 * 60 * 1000;

  for (const stopId of stopIds) {
    const schedule = schedules.get(stopId);
    if (!schedule) continue;

    for (const record of schedule.records) {
      if (!record.route || !record.serviceId) {
        continue;
      }

      for (const serviceDate of serviceDates) {
        if (!serviceActiveOnDate(record.serviceId, serviceDate, serviceCalendars)) continue;

        const epoch = epochFromLocalYmdSeconds(serviceDate, record.seconds, 0, timeZone);
        if (epoch === null) continue;

        const eventMs = epoch * 1000;
        if (eventMs < nowMs - 60_000 || eventMs > horizonMs) continue;

        const stop = STOP_BY_ID.get(stopId);
        const due = dueLabel(eventMs - nowMs);
        const destination = record.headsign || record.tripHeadsign || "";
        const row = {
          epoch,
          time: formatTime(new Date(eventMs), timeZone),
          due: due.label,
          due_minutes: due.minutes,
          route: record.route,
          destination,
          trip_id: record.tripId,
          stop: stop?.name || stopId,
          stop_code: stop?.code || "",
          stop_id: stopId,
          status: "Scheduled",
          delay_seconds: 0,
          realtime_source: "static_schedule",
        };
        const key = departureKey(row);
        candidates += 1;
        if (existingKeys.has(key)) continue;

        existingKeys.add(key);
        rows.push(row);
      }
    }
  }

  rows.sort((a, b) => a.epoch - b.epoch || String(a.route).localeCompare(String(b.route)));
  return { candidates, rows: rows.slice(0, Math.max(limit * 3, limit)) };
}

async function loadStopSchedules(env, stopIds) {
  const binding = env?.TFI_STOP_SCHEDULES;
  if (!binding || typeof binding.get !== "function") {
    return new Map();
  }

  const schedules = new Map();
  await Promise.all(
    stopIds.map(async (stopId) => {
      try {
        const text = await binding.get(`schedule:${stopId}`);
        if (!text) return;

        const rows = JSON.parse(text);
        const schedule = buildStopScheduleIndex(rows);
        if (schedule.records.length > 0) {
          schedules.set(stopId, schedule);
        }
      } catch (error) {
        console.error(JSON.stringify({ message: "Failed to load stop schedule", stopId, error: String(error) }));
      }
    }),
  );

  return schedules;
}

function buildStopScheduleIndex(rows) {
  const byTrip = new Map();
  const byTripAndSequence = new Map();
  const records = [];

  for (const row of Array.isArray(rows) ? rows : []) {
    const tripId = String(row?.[0] || "");
    const stopSequence = String(row?.[1] || "");
    const seconds = numberOrNull(row?.[2]);
    const headsign = String(row?.[3] || "");
    const route = String(row?.[4] || "");
    const tripHeadsign = String(row?.[5] || "");
    const serviceId = String(row?.[6] || "");
    if (!tripId || seconds === null) continue;

    const record = { tripId, stopSequence, seconds, headsign, route, tripHeadsign, serviceId };
    records.push(record);
    if (!byTrip.has(tripId)) {
      byTrip.set(tripId, []);
    }
    byTrip.get(tripId).push(record);

    if (stopSequence) {
      byTripAndSequence.set(`${tripId}:${stopSequence}`, record);
    }
  }

  return { records, byTrip, byTripAndSequence };
}

function scheduledDepartureForUpdate(trip, update, schedule, delaySeconds, timeZone, nowMs) {
  if (!schedule) return null;

  const tripId = String(trip.trip_id || trip.tripId || "");
  const startDate = String(trip.start_date || trip.startDate || "");
  if (!tripId || !/^\d{8}$/.test(startDate)) return null;

  const stopSequence = String(update.stop_sequence || update.stopSequence || "");
  const exact = stopSequence ? schedule.byTripAndSequence.get(`${tripId}:${stopSequence}`) : null;
  const candidates = exact ? [exact] : schedule.byTrip.get(tripId) || [];
  const scored = [];

  for (const record of candidates) {
    const epoch = epochFromLocalYmdSeconds(startDate, record.seconds, delaySeconds, timeZone);
    if (epoch === null) continue;
    scored.push({ ...record, epoch });
  }

  if (scored.length === 0) return null;

  scored.sort((a, b) => a.epoch - b.epoch);
  return scored.find((row) => row.epoch * 1000 >= nowMs - 60_000) || scored[0];
}

function epochFromLocalYmdSeconds(startDate, seconds, delaySeconds, timeZone) {
  const year = Number(startDate.slice(0, 4));
  const month = Number(startDate.slice(4, 6));
  const day = Number(startDate.slice(6, 8));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;

  const targetAsUtc = new Date(Date.UTC(year, month - 1, day, 0, 0, 0) + (seconds + delaySeconds) * 1000);
  const target = {
    year: targetAsUtc.getUTCFullYear(),
    month: targetAsUtc.getUTCMonth() + 1,
    day: targetAsUtc.getUTCDate(),
    hour: targetAsUtc.getUTCHours(),
    minute: targetAsUtc.getUTCMinutes(),
    second: targetAsUtc.getUTCSeconds(),
  };

  const targetMs = pseudoUtcMs(target);
  let guessMs = targetMs;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = partsInTimeZone(new Date(guessMs), timeZone);
    const diff = targetMs - pseudoUtcMs(actual);
    if (diff === 0) {
      return Math.floor(guessMs / 1000);
    }
    guessMs += diff;
  }

  return Math.floor(guessMs / 1000);
}

function partsInTimeZone(date, timeZone) {
  const formatter = partsFormatter(timeZone);
  const parts = {};
  for (const part of formatter.formatToParts(date)) {
    if (part.type !== "literal") {
      parts[part.type] = Number(part.value);
    }
  }

  return {
    year: parts.year,
    month: parts.month,
    day: parts.day,
    hour: parts.hour,
    minute: parts.minute,
    second: parts.second,
  };
}

function partsFormatter(timeZone) {
  if (!PARTS_FORMATTERS.has(timeZone)) {
    PARTS_FORMATTERS.set(
      timeZone,
      new Intl.DateTimeFormat("en-IE", {
        timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hourCycle: "h23",
      }),
    );
  }

  return PARTS_FORMATTERS.get(timeZone);
}

function pseudoUtcMs(parts) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

function configuredServiceCalendars(env = {}) {
  const override = env?.TFI_SERVICE_CALENDARS;
  if (!override) return SERVICE_CALENDARS;
  if (typeof override === "object") return override;

  try {
    const parsed = JSON.parse(String(override));
    return parsed && typeof parsed === "object" ? parsed : SERVICE_CALENDARS;
  } catch {
    return SERVICE_CALENDARS;
  }
}

function serviceActiveOnDate(serviceId, ymd, serviceCalendars = SERVICE_CALENDARS) {
  const calendar = serviceCalendars?.[serviceId];
  if (!Array.isArray(calendar)) return false;

  const exception = calendar[3]?.[ymd];
  if (exception === 1 || exception === "1") return true;
  if (exception === 2 || exception === "2") return false;

  const startDate = String(calendar[0] || "");
  const endDate = String(calendar[1] || "");
  if (startDate && ymd < startDate) return false;
  if (endDate && ymd > endDate) return false;

  const mask = Number(calendar[2] || 0);
  const weekdayIndex = weekdayIndexFromYmd(ymd);
  return Number.isFinite(weekdayIndex) && (mask & (1 << weekdayIndex)) !== 0;
}

function ymdInTimeZone(date, timeZone) {
  const parts = partsInTimeZone(date, timeZone);
  return formatYmd(parts.year, parts.month, parts.day);
}

function addYmdDays(ymd, days) {
  const year = Number(ymd.slice(0, 4));
  const month = Number(ymd.slice(4, 6));
  const day = Number(ymd.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day + days));
  return formatYmd(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate());
}

function weekdayIndexFromYmd(ymd) {
  const year = Number(ymd.slice(0, 4));
  const month = Number(ymd.slice(4, 6));
  const day = Number(ymd.slice(6, 8));
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;

  const utcDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return (utcDay + 6) % 7;
}

function formatYmd(year, month, day) {
  return `${String(year).padStart(4, "0")}${String(month).padStart(2, "0")}${String(day).padStart(2, "0")}`;
}

async function boundedText(response, maxChars) {
  const text = await response.text();
  return text.slice(0, maxChars);
}

function getApiKey(request, params) {
  const auth = request.headers.get("authorization") || "";
  const candidates = [
    request.headers.get("x-nta-api-key") ||
      request.headers.get("x-api-key") ||
      request.headers.get("subscription-key") ||
      auth.replace(/^Bearer\s+/i, "").trim(),
    params.get("subscription-key"),
    params.get("subscription_key"),
    params.get("api_key"),
    params.get("nta_api_key"),
  ]
    .map(normalizeApiKey)
    .filter(Boolean);

  return candidates.find((value) => !isUnresolvedTemplate(value)) || candidates[0] || "";
}

function normalizeApiKey(value) {
  let text = stripWrappingQuotes(normalizeFormValue(value));
  text = text.replace(/^Bearer\s+/i, "").trim();
  text = stripWrappingQuotes(normalizeFormValue(text));

  const assignment = text.match(/^(?:x-nta-api-key|x-api-key|subscription-key|subscription_key|api_key|nta_api_key)\s*[:=]\s*(.+)$/i);
  if (assignment) {
    text = assignment[1].trim();
  }

  return stripWrappingQuotes(normalizeFormValue(text));
}

function isUnresolvedTemplate(value) {
  return String(value || "").includes("{{") || String(value || "").includes("}}");
}

function normalizeFormValue(value) {
  return String(value ?? "").trim().replace(/^#+/, "").trim();
}

function stripWrappingQuotes(value) {
  return String(value || "").replace(/^["']|["']$/g, "").trim();
}

function normalizeStopIds(values) {
  const stopIds = [];
  for (const value of values) {
    if (!value) continue;
    const text = normalizeFormValue(value);
    if (!text) continue;

    if (text.startsWith("[") && text.endsWith("]")) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed)) {
          for (const nested of normalizeStopIds(parsed)) {
            addUnique(stopIds, nested);
          }
          continue;
        }
      } catch {
        // Fall through to comma parsing.
      }
    }

    for (const part of text.split(",")) {
      addUnique(stopIds, normalizeFormValue(part));
    }
  }
  return stopIds;
}

function resolveStopInputs(values) {
  const stopIds = [];

  for (const value of values) {
    const raw = normalizeFormValue(value);
    if (!raw) continue;

    const stopById = STOP_BY_ID.get(raw);
    if (stopById) {
      addUnique(stopIds, stopById.id);
      continue;
    }

    const labelCode = raw.match(/\(([^)]+)\)\s*$/)?.[1];
    const normalizedCode = normalizeFormValue(labelCode || raw);
    const stopByCode = STOP_BY_CODE.get(normalizedCode);
    if (stopByCode) {
      addUnique(stopIds, stopByCode.id);
      continue;
    }

    addUnique(stopIds, raw);
  }

  return stopIds;
}

function addUnique(values, value) {
  if (value && !values.includes(value)) {
    values.push(value);
  }
}

function stopLabel(stop) {
  return stop.code && stop.code !== "0" ? `${stop.name} (${stop.code})` : stop.name;
}

function stopsLabel(stops) {
  const names = stops.slice(0, 2).map((stop) => stop.name).join(", ");
  return stops.length > 2 ? `${names} +${stops.length - 2}` : names;
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number.parseInt(normalizeFormValue(value), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(parsed, max));
}

function numberOrNull(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function dueLabel(deltaMs) {
  const minutes = Math.ceil(deltaMs / 60_000);
  if (minutes <= 0) return { minutes: 0, label: "Due" };
  if (minutes > 99) return { minutes, label: "99+ min" };
  return { minutes, label: `${minutes} min` };
}

function delayStatus(delaySeconds) {
  if (delaySeconds >= 60) return `Late +${Math.round(delaySeconds / 60)}`;
  if (delaySeconds <= -60) return `Early ${Math.abs(Math.round(delaySeconds / 60))}`;
  return "On time";
}

function validTimeZone(value) {
  const timeZone = normalizeFormValue(value || DEFAULT_TIME_ZONE) || DEFAULT_TIME_ZONE;
  try {
    new Intl.DateTimeFormat("en-IE", { timeZone }).format(new Date());
    return timeZone;
  } catch {
    return DEFAULT_TIME_ZONE;
  }
}

function formatTime(date, timeZone) {
  return new Intl.DateTimeFormat("en-IE", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}

function formatDate(date, timeZone) {
  return new Intl.DateTimeFormat("en-IE", {
    timeZone,
    day: "2-digit",
    month: "short",
  }).format(date);
}

function stopFinderHtml() {
  const stopCount = STOPS.length.toLocaleString("en-IE");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>TFI Stop Finder</title>
  <style>
    :root {
      color-scheme: dark;
      --ink: #f2f0e8;
      --muted: #a8a497;
      --line: #3b382f;
      --panel: #171612;
      --panel-soft: #211f18;
      --paper: #0b0b09;
      --accent: #f7c744;
      --go: #9bcf72;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background:
        linear-gradient(90deg, rgba(255,255,255,.025) 1px, transparent 1px) 0 0 / 12px 12px,
        linear-gradient(180deg, #10100d 0%, #080806 100%);
      color: var(--ink);
      font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
    }
    main {
      width: min(1040px, calc(100% - 32px));
      margin: 0 auto;
      padding: 38px 0 52px;
    }
    header {
      display: grid;
      gap: 12px;
      margin-bottom: 24px;
      border-bottom: 1px solid var(--line);
      padding-bottom: 20px;
    }
    .kicker {
      color: var(--accent);
      font-size: 12px;
      letter-spacing: .16em;
      text-transform: uppercase;
    }
    h1 {
      margin: 0;
      font-size: clamp(34px, 8vw, 78px);
      line-height: .92;
      letter-spacing: 0;
      text-transform: uppercase;
    }
    .intro {
      max-width: 720px;
      margin: 0;
      color: var(--muted);
      font: 16px/1.55 ui-sans-serif, system-ui, sans-serif;
    }
    .search-panel {
      position: sticky;
      top: 0;
      z-index: 2;
      display: grid;
      gap: 10px;
      padding: 16px 0;
      background: linear-gradient(180deg, #10100d 72%, rgba(16,16,13,0));
    }
    label {
      color: var(--muted);
      font-size: 12px;
      letter-spacing: .12em;
      text-transform: uppercase;
    }
    input {
      width: 100%;
      min-height: 58px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      color: var(--ink);
      padding: 0 16px;
      font: 21px/1.2 ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
      outline: 0;
    }
    input:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px rgba(247,199,68,.16);
    }
    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px 18px;
      color: var(--muted);
      font-size: 13px;
    }
    .board {
      overflow: hidden;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
      box-shadow: 0 18px 50px rgba(0,0,0,.28);
    }
    .row {
      width: 100%;
      display: grid;
      grid-template-columns: 112px minmax(0, 1fr) auto;
      gap: 18px;
      align-items: center;
      min-height: 58px;
      border: 0;
      border-bottom: 1px solid var(--line);
      background: linear-gradient(180deg, var(--panel-soft), var(--panel));
      color: var(--ink);
      padding: 0 16px;
      text-align: left;
      cursor: pointer;
      font: inherit;
    }
    .row:hover,
    .row:focus {
      background: #2a281f;
      outline: 0;
    }
    .row:last-child { border-bottom: 0; }
    .code {
      color: var(--accent);
      font-size: 24px;
      font-weight: 800;
    }
    .name {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 17px;
    }
    .copy {
      color: var(--go);
      font-size: 12px;
      letter-spacing: .08em;
      text-transform: uppercase;
    }
    .empty {
      padding: 36px 18px;
      color: var(--muted);
      text-align: center;
      font: 16px/1.45 ui-sans-serif, system-ui, sans-serif;
    }
    .hint {
      margin-top: 18px;
      color: var(--muted);
      font: 14px/1.55 ui-sans-serif, system-ui, sans-serif;
    }
    @media (max-width: 620px) {
      main {
        width: min(100% - 22px, 1040px);
        padding-top: 24px;
      }
      .row {
        grid-template-columns: 82px minmax(0, 1fr);
        gap: 10px;
        padding: 10px 12px;
      }
      .copy {
        grid-column: 2;
      }
      .code {
        font-size: 20px;
      }
      .name {
        font-size: 15px;
      }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="kicker">Transport for Ireland</div>
      <h1>Stop Finder</h1>
      <p class="intro">Search the full stop list, click a result, then paste the copied stop code into your TRMNL plugin settings. Codes are shorter and more reliable than the GTFS IDs.</p>
    </header>
    <section class="search-panel">
      <label for="search">Stop name, stop code, or GTFS stop ID</label>
      <input id="search" type="search" placeholder="Try College Green, Heuston, or 1278" autocomplete="off" autofocus>
      <div class="meta">
        <span id="count">Loading stops...</span>
        <span id="copied" aria-live="polite"></span>
      </div>
    </section>
    <section class="board" id="results" aria-label="Matching stops">
      <div class="empty">Loading ${stopCount} stops...</div>
    </section>
    <p class="hint">Tip: paste only the yellow stop code into TRMNL. The Worker also accepts full GTFS stop IDs if you already have one saved.</p>
  </main>
  <script>
    const search = document.getElementById("search");
    const results = document.getElementById("results");
    const count = document.getElementById("count");
    const copied = document.getElementById("copied");
    let stops = [];

    function codeFromName(name) {
      const match = String(name || "").match(/\\(([^)]+)\\)\\s*$/);
      return match ? match[1] : "";
    }

    function baseName(name) {
      return String(name || "").replace(/\\s*\\([^)]+\\)\\s*$/, "");
    }

    function render() {
      const query = search.value.trim().toLowerCase();
      const matches = query
        ? stops.filter(function (stop) { return stop.haystack.indexOf(query) !== -1; })
        : stops.slice(0, 40);
      const visible = matches.slice(0, 80);

      count.textContent = matches.length.toLocaleString("en-IE") + " matches";
      if (!visible.length) {
        results.innerHTML = '<div class="empty">No matching stops. Try a stop code or a shorter street name.</div>';
        return;
      }

      results.replaceChildren(...visible.map(function (stop) {
        const row = document.createElement("button");
        row.className = "row";
        row.type = "button";
        row.dataset.code = stop.code || stop.id;
        row.innerHTML =
          '<span class="code">' + escapeHtml(stop.code || "ID") + '</span>' +
          '<span class="name">' + escapeHtml(stop.name) + '</span>' +
          '<span class="copy">Copy code</span>';
        row.addEventListener("click", function () { copyStop(row.dataset.code, stop.name); });
        return row;
      }));
    }

    function escapeHtml(value) {
      return String(value).replace(/[&<>"']/g, function (char) {
        return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char];
      });
    }

    async function copyStop(code, name) {
      await navigator.clipboard.writeText(code);
      copied.textContent = "Copied " + code + " - " + baseName(name);
      window.setTimeout(function () { copied.textContent = ""; }, 2600);
    }

    async function loadStops() {
      const response = await fetch("/api/stops/search-v2");
      const payload = await response.json();
      stops = payload.map(function (stop) {
        const code = codeFromName(stop.name);
        const cleanName = baseName(stop.name);
        return {
          id: stop.id,
          code,
          name: cleanName,
          haystack: [cleanName, code, stop.id].join(" ").toLowerCase(),
        };
      });
      render();
    }

    search.addEventListener("input", render);
    loadStops().catch(function () {
      results.innerHTML = '<div class="empty">Could not load the stop list. Refresh and try again.</div>';
      count.textContent = "Stop list unavailable";
    });
  </script>
</body>
</html>`;
}
