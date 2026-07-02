# TRMNL TFI Bus Departures

Private TRMNL plugin scaffold for showing the next departures from selected Transport for Ireland stops.

## What It Does

- Serves a searchable stop picker from the official TFI static GTFS ZIP.
- Lets TRMNL poll a small JSON payload for selected stops.
- Fetches NTA GTFS-Realtime TripUpdates with your own subscription key.
- Recovers delay-only GTFS-Realtime updates from static `stop_times.txt` schedules stored in Cloudflare KV.
- Fills sparse real-time feeds with calendar-valid static timetable rows marked `Scheduled`.
- Renders the result with TRMNL Framework 3.1 markup and a shared departure-board design system.

## Run Locally

```sh
python3 src/tfi_trmnl_bus.py --gtfs-zip /tmp/GTFS_Realtime.zip --warm
```

Then check:

```sh
curl 'http://127.0.0.1:8787/api/stops/search?query=college%20green'
curl 'http://127.0.0.1:8787/api/departures?stop_1=1278&limit=10' \
  -H 'x-nta-api-key: YOUR_NTA_KEY'
```

For TRMNL to poll it, deploy the service somewhere public or run it behind a tunnel. The service has no third-party Python dependencies.

## Cloudflare Worker

This repo also includes a deployed Cloudflare Worker version:

```text
https://tfi-trmnl-bus.xanderjake.workers.dev
```

The Worker project lives in `cloudflare/`. It embeds a compact stop and route index generated from the TFI static GTFS ZIP, then calls the live NTA GTFS-Realtime TripUpdates API at request time.

Useful commands:

```sh
cd cloudflare
npm install
npm run generate:data
npm run generate:schedules
npm run upload:schedules
npm test
npm run check
npm run deploy
```

`generate:schedules` creates large KV bulk-upload files under `cloudflare/data/`; they are intentionally ignored by Git. `upload:schedules` writes them to the remote `TFI_STOP_SCHEDULES` KV namespace.

Stop finder:

```text
https://tfi-trmnl-bus.xanderjake.workers.dev/stops
```

Current deployment:

```text
Worker: tfi-trmnl-bus
URL: https://tfi-trmnl-bus.xanderjake.workers.dev
Version ID: 6a0d914f-0df3-4f01-99dc-546688f8d3cd
```

## TRMNL Setup

The source-of-truth TRMNL project is in `trmnl/`:

```text
trmnl/src/settings.yml
trmnl/src/shared.liquid
trmnl/src/full.liquid
trmnl/src/half_horizontal.liquid
trmnl/src/half_vertical.liquid
trmnl/src/quadrant.liquid
```

You can push that project with TRMNLP instead of pasting everything by hand:

```sh
cd trmnl
trmnlp login
trmnlp push
trmnlp pull
```

If your Mac Ruby is older than TRMNLP needs, run it with Docker:

```sh
cd trmnl
docker run --pull always --volume "$PWD:/plugin" --volume "$HOME/.config/trmnlp:/root/.config/trmnlp" -it trmnl/trmnlp bash
```

Then run `trmnlp login`, `trmnlp push`, and `trmnlp pull` inside the container. The `pull` step writes the plugin `id` into `trmnl/src/settings.yml`; after that, the GitHub Action can push updates automatically when the `TRMNL_API_KEY` repository secret is set.

`TRMNL_API_KEY` must be your TRMNL user-level API key from `https://trmnl.com/account`. It starts with `user_` and is used only by `trmnlp` / GitHub Actions to upload the private plugin definition. Do not use your device API key here.

The NTA key is different: each plugin installer pastes their own NTA GTFS-R subscription key into the plugin's `NTA GTFS-R API Key` field.

The GitHub Action intentionally skips uploads until `trmnl/src/settings.yml` has an `id:` value, so it cannot accidentally create duplicate private plugins. To record the id, either:

```sh
cd trmnl
trmnlp login
trmnlp push --force
git add src/settings.yml
git commit -m "Record TRMNL plugin id"
git push
```

Or, if you already created the private plugin in TRMNL:

```sh
cd trmnl
trmnlp list
trmnlp pull --id YOUR_PLUGIN_SETTINGS_ID --force
git add src/settings.yml
git commit -m "Record TRMNL plugin id"
git push
```

Use the plugin settings id shown by `trmnlp list`. The webhook/plugin UUID from a TRMNL webhook URL is not the same id and will make `trmnlp push` fail with `Plugin settings not found`.

Manual setup still works:

1. In TRMNL, create a Private Plugin.
2. Choose `Polling` as the strategy.
3. Set Polling URL to:

```text
https://tfi-trmnl-bus.xanderjake.workers.dev/api/departures?subscription-key={{ nta_api_key | url_encode }}&stop_1={{ stop_1 }}&stop_2={{ stop_2 }}&stop_3={{ stop_3 }}&stop_4={{ stop_4 }}&stop_5={{ stop_5 }}&limit=10&time_zone={{ time_zone }}
```

4. Set Polling Headers to:

```text
Leave this blank.
```

5. Paste `plugin/form-fields.yml` into the custom fields editor.
6. Paste `plugin/markup/shared.liquid` into the Shared markup tab.
7. Paste each viewport template into its matching tab:

```text
Full: plugin/markup/full.liquid
Half Horizontal: plugin/markup/half_horizontal.liquid
Half Vertical: plugin/markup/half_vertical.liquid
Quadrant: plugin/markup/quadrant.liquid
```

8. Open the stop finder, search for your stops, click each result to copy the yellow stop code, paste the codes into the Stop fields, then force refresh the plugin.

TRMNL markup fields need the literal Liquid/HTML/CSS contents. Do not paste a GitHub or Worker URL into the markup tabs; URLs belong in the Polling URL field only.

The Stop fields intentionally use plain text now. TRMNL's `xhrSelectSearch` field is documented to send search text as `query`, but in practice the private-plugin settings dropdown can behave like a tiny static list. Plain text fields plus the Worker-hosted stop finder avoid that UI limit while keeping the plugin polling URL the same.

The board is stop-first: each row shows the route, stop name, optional destination/headsign, stop code, status, departure time, and due label. The plugin fetches up to ten departures automatically; full-screen layouts show up to six rows, half-vertical shows up to five, half-horizontal shows three, and quadrant shows two.

Paste only the NTA subscription key into the plugin field. The Worker also tolerates common copied formats such as `subscription-key=KEY`, `x-api-key: KEY`, quoted keys, or TRMNL debug values displayed with a leading `##`, but the plain key is best. This plugin uses the polling URL for the key because some private-plugin instances leave header placeholders unsubstituted.

If TRMNL's debug view shows a parsed URL with leading `##` markers, do not use that debug URL as a browser test URL. Browser-opened URLs treat `#` as a fragment marker. Use Force Refresh in TRMNL, or percent-encode the markers as `%23%23` when manually testing the Worker.

Do not paste the TRMNL user API key here. TRMNL keys often start with `user_`; the plugin needs the NTA developer portal subscription key.

## NTA API Key

Each installer needs their own NTA subscription key:

1. Open `https://developer.nationaltransport.ie/`.
2. Sign in or create an account.
3. Subscribe to the NTA GTFS-Realtime / GTFSR API product.
4. Copy the subscription key from your developer profile.
5. Wait a few minutes if the key is brand new, then paste it into the TRMNL plugin's `NTA GTFS-R API Key` field.

## NTA Data

The attached `gtfsr.json` is the NTA OpenAPI description. It confirms:

- Base URL: `https://api.nationaltransport.ie/gtfsr`
- TripUpdates path: `/v2/TripUpdates?format=json`
- Auth: `x-api-key` header or `subscription-key` query parameter
- Static GTFS ZIP: `https://www.transportforireland.ie/transitData/Data/GTFS_Realtime.zip`

The live feed needs a subscription key from the NTA developer portal.

## Deployment Notes

Useful environment variables:

```sh
PORT=8787
HOST=0.0.0.0
GTFS_ZIP_PATH=.cache/GTFS_Realtime.zip
GTFS_ZIP_URL=https://www.transportforireland.ie/transitData/Data/GTFS_Realtime.zip
TRIP_UPDATES_URL=https://api.nationaltransport.ie/gtfsr/v2/TripUpdates?format=json
```

The first run downloads the static GTFS ZIP if `GTFS_ZIP_PATH` does not exist. It is about 91 MB as of July 1, 2026.

## Sources Checked

- TRMNL Framework 3.1 structure, layout, title bar, item, table, flex, grid, overflow, and gap docs.
- TRMNL Private Plugin, Polling, Liquid, and custom form field docs.
- NTA GTFS-R OpenAPI attachment plus current static GTFS ZIP.
