# TRMNL TFI Bus Less Manual Design

Date: 2026-07-01

## Objective

Make the TFI bus TRMNL plugin maintainable from files instead of repeated manual paste work, and fix the departure pipeline so the display can reliably show multiple upcoming buses.

The desired end state is:

- A new GitHub repository is the source of truth.
- TRMNL markup and settings are synced through TRMNLP instead of hand-pasted URLs or snippets.
- The Cloudflare Worker returns the next 5 real departures when NTA provides GTFS-Realtime updates that contain either absolute times or delay-only stop updates.
- Every markup layout renders the correct number of departures for its viewport.

## Current Findings

TRMNL Private Plugin markup editors expect literal Liquid/HTML/CSS contents. Pasting a link to a Liquid file does not import that file as markup.

Polling URLs are data sources only. Polling responses become `IDX_0`, `IDX_1`, and similar variables in Liquid. They are not used to fetch markup.

Shared markup is literal markup prepended to every view. It is appropriate for CSS and `{% template %}` blocks, but it still needs to be present in TRMNL or synced there through a supported tool.

The current view templates are structurally multi-departure:

- Full: 1 hero departure plus up to 4 rows.
- Half horizontal: 1 hero departure plus up to 2 rows.
- Half vertical: up to 5 compact rows.
- Quadrant: up to 2 compact rows.

The Worker can return multiple departures when a feed includes absolute `departure.time` or `arrival.time`. The likely undercounting issue is that NTA GTFS-R stop updates can provide only `arrival.delay` and `departure.delay`. The Python fallback already reconstructs these from static `stop_times.txt`; the Cloudflare Worker does not.

## Proposed Approach

Use a Private Plugin with TRMNLP/GitHub sync, plus a Worker schedule fallback.

This preserves the existing private plugin workflow while making local files the source of truth. It avoids the complexity of a public marketplace install flow, and it avoids relying on TRMNL's editor to fetch remote markup links.

## Repository And Sync Design

Create a new GitHub repository, defaulting to `tfi-trmnl-bus` unless renamed before implementation.

Initialize the local workspace as a Git repository and push it to the new GitHub repo.

Keep the existing Worker and Python service files, but add a TRMNLP-compatible plugin project folder:

```text
trmnl/
  .trmnlp.yml
  src/
    settings.yml
    shared.liquid
    full.liquid
    half_horizontal.liquid
    half_vertical.liquid
    quadrant.liquid
```

The TRMNLP files mirror the current `plugin/` files:

- `plugin/form-fields.yml` becomes or feeds `trmnl/src/settings.yml`.
- `plugin/markup/shared.liquid` becomes `trmnl/src/shared.liquid`.
- Each viewport template maps to its same-named TRMNLP layout file.

GitHub Actions should run:

- `trmnlp lint` on pull requests.
- `trmnlp push --force` on `main`, using a GitHub secret named `TRMNL_API_KEY`.

The repo must not contain API secrets. The NTA key stays a TRMNL private plugin field. The TRMNL API key is a GitHub Actions secret or local TRMNLP login config.

## API Key Instructions

The project needs two different API keys, with different audiences.

### NTA GTFS-R API Key For Plugin Users

Every person installing or forking the plugin should use their own NTA subscription key. This key is entered into the TRMNL private plugin settings field named `nta_api_key`.

User-facing setup instructions should say:

1. Go to `https://developer.nationaltransport.ie/`.
2. Sign up or sign in.
3. Open the APIs section.
4. Subscribe to the GTFS-Realtime API.
5. Wait for the subscription to become active. The NTA OpenAPI description says this can take about 15 minutes after subscribing.
6. Copy the subscription key from the NTA developer portal.
7. Paste it into the TRMNL plugin's `NTA GTFS-R API Key` field.

The Worker sends this key to NTA as the `x-api-key` request header. If a user's TRMNL account does not interpolate custom fields inside polling headers, the fallback setup can pass it as `api_key={{ nta_api_key }}` in the polling URL.

The plugin documentation should also note:

- Do not commit the NTA key to GitHub.
- Do not put the NTA key in Cloudflare Worker source code or Wrangler config.
- Each installer should use their own key so usage and rate limits stay separated.

### TRMNL API Key For Maintainers

The `TRMNL_API_KEY` is only for maintainers who push markup/settings to TRMNL with TRMNLP. Regular plugin users should not need this key to view bus departures.

Maintainer setup instructions should say:

1. Install or run TRMNLP.
2. Authenticate locally with `trmnlp login`, or set `TRMNL_API_KEY` as an environment variable.
3. For GitHub Actions sync, add `TRMNL_API_KEY` as a repository secret.
4. Never commit the TRMNL API key into the repository.

## Worker Data Design

Keep the public Worker endpoint:

```text
https://tfi-trmnl-bus.xanderjake.workers.dev/api/departures
```

Preserve supported stop inputs:

- Plain stop code, such as `1278`.
- Full GTFS stop ID, such as `8220DB001278`.
- Old label format, such as `College Green (1278)`.

Add a static schedule lookup for delay-only GTFS-R updates.

Preferred storage: Cloudflare KV with one compact JSON value per stop ID.

Reasoning:

- The full static `stop_times.txt` data is too large to embed in the Worker bundle.
- The Worker only needs schedule rows for the selected stops, at most 5 per request.
- KV values keyed by stop ID are simple and cheap to read.
- Static GTFS schedule data changes infrequently, so eventual consistency is acceptable.

Generation flow:

1. Read the TFI static GTFS ZIP.
2. Generate existing compact stop and route bundle for fast search.
3. Generate compact per-stop schedule JSON keyed by stop ID.
4. Upload schedule JSON to Cloudflare KV.

KV value shape:

```json
{
  "stop_id": "8220DB001278",
  "by_trip": {
    "TRIP_ID": {
      "event_seconds": 43800,
      "stop_sequence": "12",
      "headsign": "Ballycullen Road"
    }
  },
  "by_sequence": {
    "TRIP_ID|12": {
      "event_seconds": 43800,
      "headsign": "Ballycullen Road"
    }
  }
}
```

Runtime extraction:

1. Fetch NTA TripUpdates with the user's key.
2. For selected stops, accept stop updates with absolute `departure.time` or `arrival.time`.
3. If absolute time is missing, read delay from departure or arrival.
4. Use `trip_id`, `stop_id`, and optionally `stop_sequence` to look up the scheduled time from KV.
5. Combine `trip.start_date`, scheduled seconds, and delay to produce the event timestamp.
6. Sort all recovered and absolute-time departures by timestamp.
7. Return up to the requested limit, capped at 5 for the plugin.

The Worker should also include a lightweight debug response field or debug endpoint during development:

- selected stop IDs
- matched stop updates
- departures with absolute time
- departures recovered from schedule
- dropped updates with no usable time or schedule row

This makes future "only one bus" reports diagnosable without guessing.

## Markup Data Contract

The Worker response remains an object:

```json
{
  "title": "Next Bus",
  "generated_at": "22:17",
  "date": "01 Jul",
  "stops": [],
  "stops_label": "College Green",
  "departures": [],
  "message": "",
  "error": ""
}
```

Each departure remains:

```json
{
  "time": "22:31",
  "due": "8 min",
  "route": "15",
  "destination": "Ballycullen Road",
  "stop": "College Green",
  "stop_code": "1278",
  "status": "On time",
  "delay_seconds": 0
}
```

Markup should continue to read `IDX_0.departures`, with fallback to top-level `departures` for local previews. Each layout should show as many rows as the viewport can safely hold:

- Full: 5.
- Half vertical: 5 compact rows.
- Half horizontal: 3.
- Quadrant: 2.

If fewer departures are returned, the markup should show the actual count rather than implying hidden rows.

## Error Handling

If no stops are configured, return `error: "Choose at least one stop."`

If the NTA key is missing, return `error: "Missing NTA API key."`

If NTA returns an HTTP error, return a short `error` message with status and bounded body text.

If schedule fallback is unavailable or misses a trip, skip only that update and count it in diagnostics. Do not fail the whole screen if other departures are usable.

If no upcoming departures remain after extraction, return `message: "No upcoming departures."`

## Testing

Worker tests should cover:

- Stop code, GTFS ID, and label stop input resolution.
- Multiple absolute-time departures render into the response.
- Delay-only GTFS-R stop updates are recovered from static schedule lookup.
- Canceled trips, skipped stops, and old departures are ignored.
- Limit is capped correctly.

Plugin tests/checks should cover:

- TRMNLP lint passes.
- Each layout references the same data contract.
- Full and half-vertical layouts can render 5 departures in preview data.

Deployment checks should cover:

- `npm --prefix cloudflare run check`
- Worker deploy.
- Live `/api/stops/search-v2` count still returns 10,200 stops.
- Live `/api/departures?stop_1=1278&limit=5` resolves the stop code.
- TRMNLP push works after `TRMNL_API_KEY` is configured.

## Scope Boundaries

This design does not implement the public TRMNL marketplace install flow.

This design does not put the user's NTA API key in GitHub or Cloudflare.

This design does not require publishing a public Recipe before the plugin is useful.

This design keeps the stop finder page as a helper for choosing stop codes.

## Open Decisions For Implementation

Before implementation starts, confirm:

- GitHub repository name and visibility.
- Whether to create a brand new TRMNL private plugin through TRMNLP or clone/sync the existing plugin by ID.
- Whether the user will provide/set `TRMNL_API_KEY` as a GitHub Actions secret, or prefers local-only `trmnlp push` first.
