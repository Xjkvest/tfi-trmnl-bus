import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const now = Date.UTC(2026, 9, 15, 11, 0);
const metadata = { version: "snapshot-a", generated_at: new Date(now).toISOString(), schedule_stops: 1 };
const directory = await mkdtemp(join(tmpdir(), "tfi-worker-"));
await writeFile(join(directory, "index.mjs"), (await readFile(new URL("../src/index.js", import.meta.url), "utf8")).replace('"./tfi-static.generated.js"', '"./data.mjs"'));
await writeFile(join(directory, "data.mjs"), `
export const STOPS = [{id:"STOP_A",code:"1278",name:"College Green"}];
export const ROUTES = {ROUTE_A:"15"};
export const SERVICE_CALENDARS = {SERVICE_A:["20260101","20261231",127,{}]};
export const FEED_METADATA = ${JSON.stringify(metadata)};
`);
const { default: worker } = await import(pathToFileURL(join(directory, "index.mjs")));
const originalNow = Date.now;
const originalFetch = globalThis.fetch;
const originalWarn = console.warn;
Date.now = () => now;
const warnings = [];
console.warn = (value) => warnings.push(JSON.parse(value));

function environment(tripId = "NEW_TRIP", manifest = metadata) {
  return { TFI_SCHEDULE_ASSETS: { async fetch(request) {
    const path = new URL(request.url || request).pathname;
    if (path === "/feeds/snapshot-a.json") {
      return manifest ? Response.json(manifest) : new Response("Not found", {status: 404});
    }
    if (path === "/schedules/snapshot-a/53544f505f41.json") {
      return Response.json([[tripId,"4",12*3600+600,"City Centre","15","City Centre","SERVICE_A"]]);
    }
    return new Response("Not found", {status: 404});
  } } };
}

async function departures(env, absolute = false) {
  globalThis.fetch = async () => new Response(JSON.stringify({entity:[{trip_update:{
    trip:{trip_id:"NEW_TRIP",route_id:"ROUTE_A",start_date:"20261015"},
    stop_time_update:[{stop_id:"STOP_A",stop_sequence:"4",departure:absolute?{time:now/1000+600}:{delay:120}}],
  }}]}));
  return (await worker.fetch(new Request("https://test/api/departures?stop_1=1278&debug=1", {headers:{"x-nta-api-key":"test-secret"}}), env)).json();
}

try {
  await test("health verifies the deployed asset snapshot manifest", async () => {
    const response = await worker.fetch(new Request("https://test/health"), environment());
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.feed.version, "snapshot-a");
    assert.equal(body.feed.schedules_ready, true);
  });
  await test("missing or mismatched manifests and missing asset bindings make health fail", async () => {
    for (const env of [{}, environment("NEW_TRIP", null), environment("NEW_TRIP", {version:"snapshot-b"})]) {
      const response = await worker.fetch(new Request("https://test/health"), env);
      assert.equal(response.status, 503);
      assert.equal((await response.json()).ok, false);
    }
  });
  await test("a snapshot older than 48 hours makes health fail", async () => {
    Date.now = () => now + 49*3600*1000;
    try {
      const response = await worker.fetch(new Request("https://test/health"), environment());
      assert.equal(response.status, 503);
      assert.equal((await response.json()).feed.stale, true);
    } finally { Date.now = () => now; }
  });
  await test("the matching versioned trip recovers a delay-only update", async () => {
    const payload = await departures(environment());
    assert.equal(payload.debug.schedule_fallback_rows, 1);
    assert.equal(payload.departures[0].time, "12:12");
    assert.equal(payload.feed.version, "snapshot-a");
  });
  await test("changed trip IDs warn even when static timetable rows fill the board", async () => {
    warnings.length = 0;
    const payload = await departures(environment("OLD_TRIP"));
    assert.equal(payload.debug.missing_schedule_rows, 1);
    assert.equal(payload.departures[0].realtime_source, "static_schedule");
    assert.match(payload.message, /static.*out of sync/i);
    assert.ok(warnings.some(w => w.missing_schedule_rows === 1 && w.feed_version === "snapshot-a"));
    assert.ok(!JSON.stringify(warnings).includes("test-secret"));
  });
  await test("absolute updates survive missing schedules", async () => {
    const payload = await departures({}, true);
    assert.equal(payload.departures[0].realtime_source, "absolute_time");
    assert.match(payload.message, /static/i);
  });
  await test("missing assets never fall back to legacy KV schedules", async () => {
    const env = environment();
    const fetchAsset = env.TFI_SCHEDULE_ASSETS.fetch;
    env.TFI_SCHEDULE_ASSETS.fetch = request => new URL(request.url || request).pathname.startsWith("/schedules/")
      ? new Response("Not found", {status:404}) : fetchAsset(request);
    env.TFI_STOP_SCHEDULES = {get:async () => {throw new Error("Legacy KV must not be used");}};
    const payload = await departures(env);
    assert.equal(payload.departures.length, 0);
    assert.equal(payload.debug.missing_schedule_rows, 1);
    assert.match(payload.message, /static/i);
  });
  await test("explicit null event times use the schedule rather than Unix epoch zero", async () => {
    globalThis.fetch = async () => new Response(JSON.stringify({entity:[{trip_update:{trip:{trip_id:"NEW_TRIP",start_date:"20261015"},stop_time_update:[{stop_id:"STOP_A",departure:{time:null,delay:120}}]}}]}));
    const payload = await (await worker.fetch(new Request("https://test/api/departures?stop_1=1278&debug=1",{headers:{"x-nta-api-key":"test"}}),environment())).json();
    assert.equal(payload.debug.schedule_fallback_rows, 1);
  });
} finally {
  Date.now = originalNow;
  globalThis.fetch = originalFetch;
  console.warn = originalWarn;
  await rm(directory, {recursive:true,force:true});
}
