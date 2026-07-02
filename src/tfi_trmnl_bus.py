#!/usr/bin/env python3
from __future__ import annotations

import argparse
import csv
import io
import json
import math
import os
import posixpath
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from dataclasses import dataclass
from datetime import datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterable

try:
    from zoneinfo import ZoneInfo
except ImportError:
    ZoneInfo = None


DEFAULT_GTFS_URL = "https://www.transportforireland.ie/transitData/Data/GTFS_Realtime.zip"
DEFAULT_TRIP_UPDATES_URL = "https://api.nationaltransport.ie/gtfsr/v2/TripUpdates?format=json"
DEFAULT_TIME_ZONE = "Europe/Dublin"
DEFAULT_LIMIT = 5
MAX_LIMIT = 10


def get_any(source: dict[str, Any] | None, *keys: str, default: Any = None) -> Any:
    if not isinstance(source, dict):
        return default
    for key in keys:
        if key in source:
            return source[key]
    return default


def parse_int(value: Any, default: int | None = None) -> int | None:
    if value is None or value == "":
        return default
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def parse_gtfs_time(value: str | None) -> int | None:
    if not value:
        return None
    parts = value.split(":")
    if len(parts) != 3:
        return None
    try:
        hours, minutes, seconds = (int(part) for part in parts)
    except ValueError:
        return None
    return hours * 3600 + minutes * 60 + seconds


def csv_rows_from_zip(zip_path: Path, member: str) -> Iterable[dict[str, str]]:
    with zipfile.ZipFile(zip_path) as archive:
        with archive.open(member) as raw:
            text = io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")
            yield from csv.DictReader(text)


@dataclass(frozen=True)
class Stop:
    stop_id: str
    code: str
    name: str
    lat: str
    lon: str

    @property
    def label(self) -> str:
        if self.code and self.code != "0":
            return f"{self.name} ({self.code})"
        return self.name


@dataclass(frozen=True)
class StaticStopTime:
    trip_id: str
    stop_id: str
    stop_sequence: str
    event_seconds: int
    stop_headsign: str


class GTFSStaticStore:
    def __init__(self, zip_path: Path, zip_url: str = DEFAULT_GTFS_URL) -> None:
        self.zip_path = zip_path
        self.zip_url = zip_url
        self._stops: list[Stop] | None = None
        self._stops_by_id: dict[str, Stop] | None = None
        self._stops_by_code: dict[str, Stop] | None = None
        self._routes_by_id: dict[str, dict[str, str]] | None = None
        self._trips_by_id: dict[str, dict[str, str]] | None = None
        self._loaded_stop_time_stop_ids: set[str] = set()
        self._stop_times_by_trip_stop: dict[tuple[str, str], StaticStopTime] = {}
        self._stop_times_by_trip_sequence: dict[tuple[str, str], StaticStopTime] = {}

    def ensure_zip(self) -> None:
        if self.zip_path.exists() and self.zip_path.stat().st_size > 0:
            return
        self.zip_path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self.zip_path.with_suffix(".tmp")
        print(f"Downloading static GTFS data from {self.zip_url}", file=sys.stderr)
        with urllib.request.urlopen(self.zip_url, timeout=120) as response:
            with tmp_path.open("wb") as output:
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    output.write(chunk)
        tmp_path.replace(self.zip_path)

    def stops(self) -> list[Stop]:
        if self._stops is not None:
            return self._stops
        self.ensure_zip()
        stops: list[Stop] = []
        for row in csv_rows_from_zip(self.zip_path, "stops.txt"):
            stops.append(
                Stop(
                    stop_id=row.get("stop_id", ""),
                    code=row.get("stop_code", ""),
                    name=row.get("stop_name", ""),
                    lat=row.get("stop_lat", ""),
                    lon=row.get("stop_lon", ""),
                )
            )
        self._stops = stops
        self._stops_by_id = {stop.stop_id: stop for stop in stops}
        self._stops_by_code = {}
        for stop in stops:
            if stop.code and stop.code != "0":
                self._stops_by_code.setdefault(stop.code, stop)
        return stops

    def stop_by_id(self, stop_id: str) -> Stop | None:
        if self._stops_by_id is None:
            self.stops()
        return self._stops_by_id.get(stop_id) if self._stops_by_id else None

    def stop_by_code(self, code: str) -> Stop | None:
        if self._stops_by_code is None:
            self.stops()
        return self._stops_by_code.get(code) if self._stops_by_code else None

    def routes_by_id(self) -> dict[str, dict[str, str]]:
        if self._routes_by_id is not None:
            return self._routes_by_id
        self.ensure_zip()
        self._routes_by_id = {
            row.get("route_id", ""): row
            for row in csv_rows_from_zip(self.zip_path, "routes.txt")
            if row.get("route_id")
        }
        return self._routes_by_id

    def trips_by_id(self) -> dict[str, dict[str, str]]:
        if self._trips_by_id is not None:
            return self._trips_by_id
        self.ensure_zip()
        self._trips_by_id = {
            row.get("trip_id", ""): row
            for row in csv_rows_from_zip(self.zip_path, "trips.txt")
            if row.get("trip_id")
        }
        return self._trips_by_id

    def route_label(self, route_id: str | None, trip_id: str | None = None) -> str:
        if not route_id and trip_id:
            trip = self.trips_by_id().get(trip_id, {})
            route_id = trip.get("route_id")
        if not route_id:
            return ""
        route = self.routes_by_id().get(route_id, {})
        return route.get("route_short_name") or route.get("route_long_name") or route_id

    def trip_headsign(self, trip_id: str | None) -> str:
        if not trip_id:
            return ""
        return self.trips_by_id().get(trip_id, {}).get("trip_headsign", "")

    def search_stops(self, query: str, limit: int = 25) -> list[dict[str, str]]:
        query = (query or "").strip().lower()
        stops = self.stops()
        scored: list[tuple[int, str, Stop]] = []

        for stop in stops:
            name = stop.name.lower()
            code = stop.code.lower()
            stop_id = stop.stop_id.lower()
            if not query:
                score = 10
            elif query == code:
                score = 0
            elif code.startswith(query):
                score = 1
            elif name.startswith(query):
                score = 2
            elif query in name:
                score = 3
            elif query in stop_id:
                score = 4
            else:
                continue

            sort_key = f"{stop.name} {stop.code} {stop.stop_id}"
            scored.append((score, sort_key, stop))

        scored.sort(key=lambda item: (item[0], item[1]))
        return [
            {"id": stop.stop_id, "name": stop.label}
            for _, _, stop in scored[:limit]
        ]

    def load_stop_times_for_stops(self, stop_ids: set[str]) -> None:
        missing = stop_ids - self._loaded_stop_time_stop_ids
        if not missing:
            return

        self.ensure_zip()
        for row in csv_rows_from_zip(self.zip_path, "stop_times.txt"):
            stop_id = row.get("stop_id", "")
            if stop_id not in missing:
                continue
            event_seconds = parse_gtfs_time(row.get("departure_time")) or parse_gtfs_time(row.get("arrival_time"))
            if event_seconds is None:
                continue
            item = StaticStopTime(
                trip_id=row.get("trip_id", ""),
                stop_id=stop_id,
                stop_sequence=row.get("stop_sequence", ""),
                event_seconds=event_seconds,
                stop_headsign=row.get("stop_headsign", ""),
            )
            self._stop_times_by_trip_stop[(item.trip_id, item.stop_id)] = item
            self._stop_times_by_trip_sequence[(item.trip_id, item.stop_sequence)] = item

        self._loaded_stop_time_stop_ids.update(missing)

    def scheduled_epoch(
        self,
        *,
        trip_id: str,
        stop_id: str,
        stop_sequence: str,
        start_date: str,
        delay_seconds: int,
        tz_name: str,
    ) -> tuple[int | None, str]:
        if not trip_id or not stop_id:
            return None, ""
        self.load_stop_times_for_stops({stop_id})
        item = self._stop_times_by_trip_stop.get((trip_id, stop_id))
        if item is None and stop_sequence:
            item = self._stop_times_by_trip_sequence.get((trip_id, stop_sequence))
        if item is None:
            return None, ""

        try:
            tz = ZoneInfo(tz_name) if ZoneInfo else None
        except Exception:
            tz = ZoneInfo(DEFAULT_TIME_ZONE) if ZoneInfo else None

        if start_date and len(start_date) == 8:
            base = datetime(
                int(start_date[0:4]),
                int(start_date[4:6]),
                int(start_date[6:8]),
                tzinfo=tz,
            )
        else:
            base = datetime.now(tz).replace(hour=0, minute=0, second=0, microsecond=0)

        event = base + timedelta(seconds=item.event_seconds + delay_seconds)
        return int(event.timestamp()), item.stop_headsign


def event_time_and_delay(update: dict[str, Any]) -> tuple[int | None, int]:
    departure = get_any(update, "departure", "departureTime", default={})
    arrival = get_any(update, "arrival", "arrivalTime", default={})

    event_time = parse_int(get_any(departure, "time"), None)
    if event_time is None:
        event_time = parse_int(get_any(arrival, "time"), None)

    delay = parse_int(get_any(departure, "delay"), None)
    if delay is None:
        delay = parse_int(get_any(arrival, "delay"), 0) or 0
    return event_time, delay


def format_status(delay_seconds: int) -> str:
    if delay_seconds >= 60:
        return f"Late +{round(delay_seconds / 60)}"
    if delay_seconds <= -60:
        return f"Early {abs(round(delay_seconds / 60))}"
    return "On time"


def format_due(delta_seconds: float) -> tuple[int, str]:
    minutes = math.ceil(delta_seconds / 60)
    if minutes <= 0:
        return 0, "Due"
    return minutes, f"{minutes} min"


def normalize_stop_ids(values: Iterable[str | None]) -> list[str]:
    stop_ids: list[str] = []

    def add_stop_id(candidate: str) -> None:
        candidate = candidate.strip()
        if candidate and candidate not in stop_ids:
            stop_ids.append(candidate)

    for value in values:
        if not value:
            continue
        text = urllib.parse.unquote_plus(str(value)).strip()
        if not text:
            continue
        if text.startswith("[") and text.endswith("]"):
            try:
                parsed = json.loads(text)
                if isinstance(parsed, list):
                    for item in normalize_stop_ids(str(item) for item in parsed):
                        add_stop_id(item)
                    continue
            except json.JSONDecodeError:
                pass
        for part in text.split(","):
            add_stop_id(part)
    return stop_ids


def resolve_stop_inputs(values: Iterable[str | None], store: GTFSStaticStore) -> list[str]:
    stop_ids: list[str] = []

    def add_stop_id(candidate: str) -> None:
        if candidate and candidate not in stop_ids:
            stop_ids.append(candidate)

    for raw in normalize_stop_ids(values):
        stop = store.stop_by_id(raw)
        if stop:
            add_stop_id(stop.stop_id)
            continue

        code = raw
        if code.endswith(")") and "(" in code:
            code = code.rsplit("(", 1)[1].removesuffix(")").strip()
        code = code.removeprefix("#").strip()

        stop = store.stop_by_code(code)
        if stop:
            add_stop_id(stop.stop_id)
            continue

        add_stop_id(raw)

    return stop_ids


def departures_from_feed(
    feed: dict[str, Any],
    *,
    stop_ids: list[str],
    store: GTFSStaticStore,
    limit: int,
    tz_name: str,
    now_ts: float | None = None,
) -> list[dict[str, Any]]:
    now_ts = time.time() if now_ts is None else now_ts
    selected = set(stop_ids)
    departures: list[dict[str, Any]] = []

    for entity in get_any(feed, "entity", "entities", default=[]) or []:
        trip_update = get_any(entity, "trip_update", "tripUpdate", default={}) or {}
        trip = get_any(trip_update, "trip", default={}) or {}
        stop_updates = (
            get_any(trip_update, "stop_time_update", "stopTimeUpdate", default=None)
            or get_any(entity, "stop_time_update", "stopTimeUpdate", default=[])
            or []
        )

        trip_id = get_any(trip, "trip_id", "tripId", default="")
        route_id = get_any(trip, "route_id", "routeId", default="")
        start_date = get_any(trip, "start_date", "startDate", default="")
        trip_relationship = get_any(trip, "schedule_relationship", "scheduleRelationship", default="")
        if str(trip_relationship).upper() == "CANCELED":
            continue

        for update in stop_updates:
            stop_id = get_any(update, "stop_id", "stopId", default="")
            if stop_id not in selected:
                continue

            relationship = get_any(update, "schedule_relationship", "scheduleRelationship", default="")
            if str(relationship).upper() in {"SKIPPED", "NO_DATA"}:
                continue

            event_epoch, delay = event_time_and_delay(update)
            static_headsign = ""
            if event_epoch is None:
                event_epoch, static_headsign = store.scheduled_epoch(
                    trip_id=trip_id,
                    stop_id=stop_id,
                    stop_sequence=str(get_any(update, "stop_sequence", "stopSequence", default="")),
                    start_date=start_date,
                    delay_seconds=delay,
                    tz_name=tz_name,
                )
            if event_epoch is None or event_epoch < now_ts - 60:
                continue

            try:
                tz = ZoneInfo(tz_name) if ZoneInfo else None
            except Exception:
                tz = ZoneInfo(DEFAULT_TIME_ZONE) if ZoneInfo else None

            stop = store.stop_by_id(stop_id)
            delta = event_epoch - now_ts
            due_minutes, due_label = format_due(delta)
            destination = (
                get_any(update, "stop_headsign", "stopHeadsign", default="")
                or static_headsign
                or store.trip_headsign(trip_id)
            )
            local_time = datetime.fromtimestamp(event_epoch, tz=tz)

            departures.append(
                {
                    "epoch": event_epoch,
                    "time": local_time.strftime("%H:%M"),
                    "due": due_label,
                    "due_minutes": due_minutes,
                    "route": store.route_label(route_id, trip_id) or "Bus",
                    "destination": destination or "Unknown",
                    "stop": stop.name if stop else stop_id,
                    "stop_code": stop.code if stop else "",
                    "stop_id": stop_id,
                    "status": format_status(delay),
                    "delay_seconds": delay,
                }
            )

    departures.sort(key=lambda item: (item["epoch"], item["route"], item["stop"]))
    return departures[:limit]


def fetch_trip_updates(api_key: str, url: str = DEFAULT_TRIP_UPDATES_URL) -> dict[str, Any]:
    request = urllib.request.Request(url, headers={"x-api-key": api_key, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            charset = response.headers.get_content_charset() or "utf-8"
            return json.loads(response.read().decode(charset))
    except urllib.error.HTTPError as error:
        body = error.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"NTA API returned HTTP {error.code}: {body[:300]}") from error
    except urllib.error.URLError as error:
        raise RuntimeError(f"NTA API request failed: {error}") from error


def build_payload(
    *,
    store: GTFSStaticStore,
    api_key: str,
    stop_ids: list[str],
    limit: int,
    tz_name: str,
    trip_updates_url: str,
) -> dict[str, Any]:
    generated_at = datetime.now(ZoneInfo(tz_name) if ZoneInfo else None)
    stops = [
        {
            "id": stop_id,
            "name": (store.stop_by_id(stop_id).name if store.stop_by_id(stop_id) else stop_id),
            "code": (store.stop_by_id(stop_id).code if store.stop_by_id(stop_id) else ""),
        }
        for stop_id in stop_ids
    ]

    payload: dict[str, Any] = {
        "title": "Next Bus",
        "generated_at": generated_at.strftime("%H:%M"),
        "date": generated_at.strftime("%d %b"),
        "stops": stops,
        "stops_label": ", ".join(stop["name"] for stop in stops[:2]) + (" +" + str(len(stops) - 2) if len(stops) > 2 else ""),
        "departures": [],
        "message": "",
        "error": "",
    }

    if not stop_ids:
        payload["error"] = "Choose at least one stop."
        return payload
    if not api_key:
        payload["error"] = "Missing NTA API key."
        return payload

    try:
        feed = fetch_trip_updates(api_key, trip_updates_url)
        header = get_any(feed, "header", default={}) or {}
        source_timestamp = parse_int(get_any(header, "timestamp"), None)
        if source_timestamp:
            payload["source_time"] = datetime.fromtimestamp(source_timestamp, tz=generated_at.tzinfo).strftime("%H:%M")
        payload["departures"] = departures_from_feed(
            feed,
            stop_ids=stop_ids,
            store=store,
            limit=limit,
            tz_name=tz_name,
        )
    except Exception as exc:
        payload["error"] = str(exc)
        return payload

    if not payload["departures"]:
        payload["message"] = "No upcoming departures."
    return payload


def parse_request_body(handler: BaseHTTPRequestHandler) -> dict[str, Any]:
    length = parse_int(handler.headers.get("Content-Length"), 0) or 0
    if length <= 0:
        return {}
    raw = handler.rfile.read(length)
    content_type = handler.headers.get("Content-Type", "")
    if "application/json" in content_type:
        try:
            parsed = json.loads(raw.decode("utf-8"))
            return parsed if isinstance(parsed, dict) else {}
        except json.JSONDecodeError:
            return {}
    if "application/x-www-form-urlencoded" in content_type:
        parsed_qs = urllib.parse.parse_qs(raw.decode("utf-8"), keep_blank_values=True)
        return {key: values[-1] if values else "" for key, values in parsed_qs.items()}
    return {}


class BusPluginHandler(BaseHTTPRequestHandler):
    store: GTFSStaticStore
    trip_updates_url: str

    def log_message(self, format: str, *args: Any) -> None:
        print(f"{self.address_string()} - {format % args}", file=sys.stderr)

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_cors_headers()
        self.end_headers()

    def do_GET(self) -> None:
        self.route_request()

    def do_POST(self) -> None:
        self.route_request()

    def route_request(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = posixpath.normpath(parsed.path)
        query = urllib.parse.parse_qs(parsed.query, keep_blank_values=True)

        if path == "/":
            self.send_json(
                {
                    "name": "TFI TRMNL Bus Departures",
                    "endpoints": ["/api/stops/search", "/api/departures", "/health"],
                }
            )
            return
        if path == "/health":
            self.send_json({"ok": True})
            return
        if path == "/api/stops/search":
            body = parse_request_body(self) if self.command == "POST" else {}
            search = (
                body.get("query")
                or body.get("q")
                or (query.get("query") or query.get("q") or [""])[-1]
                or ""
            )
            limit = min(parse_int((query.get("limit") or ["25"])[-1], 25) or 25, 50)
            self.send_json(self.store.search_stops(str(search), limit=limit))
            return
        if path == "/api/departures":
            self.send_json(self.departures_response(query))
            return
        self.send_json({"error": "Not found"}, status=404)

    def departures_response(self, query: dict[str, list[str]]) -> dict[str, Any]:
        header_key = (
            self.headers.get("x-nta-api-key")
            or self.headers.get("x-api-key")
            or self.headers.get("authorization", "").removeprefix("Bearer ").strip()
        )
        api_key = (
            header_key
            or (query.get("api_key") or query.get("nta_api_key") or query.get("subscription-key") or [""])[-1]
        )
        stop_values: list[str | None] = []
        stop_values.extend(query.get("stops", []))
        stop_values.extend(query.get("stop_ids", []))
        for index in range(1, 6):
            stop_values.extend(query.get(f"stop_{index}", []))
        stop_ids = resolve_stop_inputs(stop_values, self.store)

        limit = parse_int((query.get("limit") or query.get("departure_count") or [str(DEFAULT_LIMIT)])[-1], DEFAULT_LIMIT)
        limit = max(1, min(limit or DEFAULT_LIMIT, MAX_LIMIT))
        tz_name = (query.get("time_zone") or query.get("tz") or [DEFAULT_TIME_ZONE])[-1] or DEFAULT_TIME_ZONE

        return build_payload(
            store=self.store,
            api_key=api_key,
            stop_ids=stop_ids,
            limit=limit,
            tz_name=tz_name,
            trip_updates_url=self.trip_updates_url,
        )

    def send_cors_headers(self) -> None:
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-CSRF-Token, x-nta-api-key, x-api-key, Authorization")

    def send_json(self, payload: Any, status: int = 200) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_cors_headers()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def make_handler(store: GTFSStaticStore, trip_updates_url: str) -> type[BusPluginHandler]:
    class ConfiguredBusPluginHandler(BusPluginHandler):
        pass

    ConfiguredBusPluginHandler.store = store
    ConfiguredBusPluginHandler.trip_updates_url = trip_updates_url
    return ConfiguredBusPluginHandler


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="TRMNL polling service for TFI GTFS-R bus departures.")
    parser.add_argument("--host", default=os.getenv("HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.getenv("PORT", "8787")))
    parser.add_argument(
        "--gtfs-zip",
        default=os.getenv("GTFS_ZIP_PATH", str(Path(".cache") / "GTFS_Realtime.zip")),
        help="Path to the static TFI GTFS ZIP. Downloaded if missing.",
    )
    parser.add_argument("--gtfs-url", default=os.getenv("GTFS_ZIP_URL", DEFAULT_GTFS_URL))
    parser.add_argument("--trip-updates-url", default=os.getenv("TRIP_UPDATES_URL", DEFAULT_TRIP_UPDATES_URL))
    parser.add_argument("--warm", action="store_true", help="Download/load stops at startup.")
    args = parser.parse_args(argv)

    store = GTFSStaticStore(Path(args.gtfs_zip), args.gtfs_url)
    if args.warm:
        store.stops()

    server = ThreadingHTTPServer((args.host, args.port), make_handler(store, args.trip_updates_url))
    print(f"Serving TRMNL bus plugin on http://{args.host}:{args.port}", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down.", file=sys.stderr)
        server.server_close()
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
