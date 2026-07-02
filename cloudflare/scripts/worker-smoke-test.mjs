import assert from "node:assert/strict";
import worker from "../src/index.js";

const searchResponse = await worker.fetch(new Request("https://worker.example/api/stops/search?query=1278"), {});
assert.equal(searchResponse.status, 200);

const searchRows = await searchResponse.json();
assert.ok(searchRows.length > 0, "expected stop search to find stop code 1278");

const secondSearchResponse = await worker.fetch(new Request("https://worker.example/api/stops/search?query=297"), {});
assert.equal(secondSearchResponse.status, 200);

const secondSearchRows = await secondSearchResponse.json();
assert.ok(secondSearchRows.length > 0, "expected stop search to find stop code 297");

const stop = searchRows[0];
const secondStop = secondSearchRows[0];
const tripId = "TEST_TRIP_1";
const routeId = "TEST_ROUTE";
const startDate = "20260701";
const scheduledSeconds = 12 * 3600 + 10 * 60;
const originalFetch = globalThis.fetch;
const originalNow = Date.now;

try {
  Date.now = () => Date.UTC(2026, 6, 1, 10, 58, 0);
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        header: { timestamp: Math.floor(Date.now() / 1000) },
        entity: [
          {
            trip_update: {
              trip: {
                trip_id: tripId,
                route_id: routeId,
                start_date: startDate,
              },
              stop_time_update: [
                {
                  stop_id: stop.id,
                  stop_sequence: "4",
                  departure: { delay: 120 },
                  schedule_relationship: "SCHEDULED",
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  const env = {
    TFI_STOP_SCHEDULES: {
      async get(key) {
        assert.equal(key, `schedule:${stop.id}`);
        return JSON.stringify([[tripId, "4", scheduledSeconds, "Ballycullen Road"]]);
      },
    },
  };

  const response = await worker.fetch(
    new Request(`https://worker.example/api/departures?stop_1=1278&limit=5&debug=1`, {
      headers: { "x-nta-api-key": "test-key" },
    }),
    env,
  );
  assert.equal(response.status, 200);

  const payload = await response.json();
  assert.equal(payload.error, "");
  assert.equal(payload.departures.length, 1);
  assert.equal(payload.departures[0].time, "12:12");
  assert.equal(payload.departures[0].status, "Late +2");
  assert.equal(payload.departures[0].destination, "Ballycullen Road");
  assert.equal(payload.departures[0].realtime_source, "schedule_delay");
  assert.equal(payload.debug.schedule_fallback_rows, 1);
  assert.equal(payload.debug.schedule_stops_loaded, 1);

  const wrappedKeyResponse = await worker.fetch(
    new Request(`https://worker.example/api/departures?stop_1=1278&subscription-key=subscription-key%3Dwrapped-test-key`),
    env,
  );
  assert.equal(wrappedKeyResponse.status, 200);
  const wrappedKeyPayload = await wrappedKeyResponse.json();
  assert.equal(wrappedKeyPayload.error, "");

  const unresolvedKeyResponse = await worker.fetch(
    new Request(`https://worker.example/api/departures?stop_1=1278`, {
      headers: { "x-nta-api-key": "##{{ nta_api_key }}" },
    }),
    {},
  );
  assert.equal(unresolvedKeyResponse.status, 200);
  const unresolvedKeyPayload = await unresolvedKeyResponse.json();
  assert.match(unresolvedKeyPayload.error, /not substituted/);

  const trmnlUserKeyResponse = await worker.fetch(
    new Request(`https://worker.example/api/departures?stop_1=1278&subscription-key=user_wrong_key`),
    {},
  );
  assert.equal(trmnlUserKeyResponse.status, 200);
  const trmnlUserKeyPayload = await trmnlUserKeyResponse.json();
  assert.match(trmnlUserKeyPayload.error, /TRMNL user API key/);

  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({
        header: { timestamp: Math.floor(Date.now() / 1000) },
        entity: [
          {
            trip_update: {
              trip: {
                trip_id: "BUSY_TRIP_1",
                route_id: "ROUTE_BUSY",
                start_date: startDate,
              },
              stop_time_update: [
                {
                  stop_id: stop.id,
                  departure: { time: Math.floor(Date.now() / 1000) + 60, delay: 0 },
                  schedule_relationship: "SCHEDULED",
                },
              ],
            },
          },
          {
            trip_update: {
              trip: {
                trip_id: "BUSY_TRIP_2",
                route_id: "ROUTE_BUSY",
                start_date: startDate,
              },
              stop_time_update: [
                {
                  stop_id: stop.id,
                  departure: { time: Math.floor(Date.now() / 1000) + 120, delay: 0 },
                  schedule_relationship: "SCHEDULED",
                },
              ],
            },
          },
          {
            trip_update: {
              trip: {
                trip_id: "SECOND_STOP_TRIP",
                route_id: "ROUTE_SECOND",
                start_date: startDate,
              },
              stop_time_update: [
                {
                  stop_id: secondStop.id,
                  departure: { time: Math.floor(Date.now() / 1000) + 300, delay: 0 },
                  schedule_relationship: "SCHEDULED",
                },
              ],
            },
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  const balancedResponse = await worker.fetch(
    new Request(`https://worker.example/api/departures?stop_1=1278&stop_2=297&limit=2`, {
      headers: { "x-nta-api-key": "test-key" },
    }),
    {},
  );
  assert.equal(balancedResponse.status, 200);

  const balancedPayload = await balancedResponse.json();
  assert.deepEqual(
    balancedPayload.departures.map((departure) => departure.stop_id),
    [stop.id, secondStop.id],
  );
} finally {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
}

console.log("Worker smoke test passed.");
