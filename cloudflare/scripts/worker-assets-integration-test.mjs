import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { unstable_dev } from "wrangler";

// Exercise the real Wrangler asset binding, without NTA or Cloudflare credentials.
const directory = await mkdtemp(join(tmpdir(), "tfi-assets-"));
const version = "integration-snapshot";
const metadata = { version, generated_at: new Date().toISOString(), schedule_stops: 1 };
const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/Dublin", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
}).formatToParts(new Date()).map(part => [part.type, part.value]));
const serviceDate = `${parts.year}${parts.month}${parts.day}`;
const seconds = Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second) + 600;
const upstream = createServer((_request, response) => {
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify({ entity: [{ trip_update: {
    trip: { trip_id: "INTEGRATION_TRIP", start_date: serviceDate },
    stop_time_update: [{ stop_id: "STOP_A", stop_sequence: "4", departure: { delay: 120 } }],
  } }] }));
});
await new Promise((resolve, reject) => {
  upstream.once("error", reject);
  upstream.listen(0, "127.0.0.1", resolve);
});
await mkdir(join(directory, "assets", "feeds"), { recursive: true });
await writeFile(join(directory, "assets", "feeds", `${version}.json`), JSON.stringify(metadata));
await mkdir(join(directory, "assets", "schedules", version), { recursive: true });
await writeFile(join(directory, "assets", "schedules", version, "53544f505f41.json"), JSON.stringify([
  ["INTEGRATION_TRIP", "4", seconds, "City Centre", "15", "City Centre", ""],
]));
const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
await writeFile(join(directory, "index.js"), source.replace(
  "https://api.nationaltransport.ie/gtfsr/v2/TripUpdates?format=json",
  `http://127.0.0.1:${upstream.address().port}/feed`,
));
await writeFile(join(directory, "tfi-static.generated.js"), `
export const STOPS = [{id:"STOP_A",code:"1278",name:"College Green"}];
export const ROUTES = {};
export const SERVICE_CALENDARS = {};
export const FEED_METADATA = ${JSON.stringify(metadata)};
`);
const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
config.name = "tfi-assets-integration";
config.main = "index.js";
config.assets.directory = "./assets";
delete config.$schema;
await writeFile(join(directory, "wrangler.json"), JSON.stringify(config));
let server;
try {
  server = await unstable_dev(join(directory, "index.js"), {
    config: join(directory, "wrangler.json"),
    local: true,
    persist: false,
    logLevel: "error",
    experimental: { disableExperimentalWarning: true },
  });
  const response = await server.fetch("/health");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.feed.version, version);
  assert.equal(body.feed.schedules_ready, true);
  const search = await (await server.fetch("/api/stops/search?query=1278")).json();
  assert.equal(search[0].id, "STOP_A");
  const payload = await (await server.fetch("/api/departures?stop_1=1278&debug=1", {
    headers: { "x-nta-api-key": "integration-test" },
  })).json();
  assert.equal(payload.debug.schedule_fallback_rows, 1);
  assert.equal(payload.departures[0].realtime_source, "schedule_delay");
  assert.equal(payload.departures[0].destination, "City Centre");
  // Asset URLs stay behind the Worker router rather than taking over API routes.
  assert.equal((await server.fetch(`/feeds/${version}.json`)).status, 404);
  console.log("Wrangler Static Assets integration passed.");
} finally {
  await server?.stop();
  await new Promise(resolve => upstream.close(resolve));
  await rm(directory, { recursive: true, force: true });
}
