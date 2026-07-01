#!/usr/bin/env python3
"""Generate compact static GTFS data for the Cloudflare Worker."""

from __future__ import annotations

import argparse
import csv
import io
import json
import zipfile
from collections import defaultdict
from pathlib import Path

MAX_BULK_ENTRIES = 2_000
MAX_BULK_BYTES = 85_000_000


def rows_from_zip(zip_path: Path, member: str):
    with zipfile.ZipFile(zip_path) as archive:
        with archive.open(member) as raw:
            text = io.TextIOWrapper(raw, encoding="utf-8-sig", newline="")
            yield from csv.DictReader(text)


def gtfs_time_to_seconds(value: str) -> int | None:
    if not value:
        return None

    parts = str(value).split(":")
    if len(parts) != 3:
        return None

    try:
        hours, minutes, seconds = (int(part) for part in parts)
    except ValueError:
        return None

    return hours * 3600 + minutes * 60 + seconds


def write_schedule_chunks(zip_path: Path, out_dir: Path, prefix: str) -> None:
    schedules: dict[str, list[list[str | int]]] = defaultdict(list)
    row_count = 0

    for row in rows_from_zip(zip_path, "stop_times.txt"):
        stop_id = row.get("stop_id", "")
        trip_id = row.get("trip_id", "")
        if not stop_id or not trip_id:
            continue

        event_seconds = gtfs_time_to_seconds(row.get("departure_time", ""))
        if event_seconds is None:
            event_seconds = gtfs_time_to_seconds(row.get("arrival_time", ""))
        if event_seconds is None:
            continue

        schedules[stop_id].append(
            [
                trip_id,
                row.get("stop_sequence", ""),
                event_seconds,
                row.get("stop_headsign", ""),
            ]
        )
        row_count += 1

    out_dir.mkdir(parents=True, exist_ok=True)
    for stale in out_dir.glob(f"{prefix}-*.json"):
        stale.unlink()

    chunk: list[dict[str, str]] = []
    chunk_bytes = 2
    chunk_index = 1

    def flush() -> None:
        nonlocal chunk, chunk_bytes, chunk_index
        if not chunk:
            return
        path = out_dir / f"{prefix}-{chunk_index:04d}.json"
        path.write_text(json.dumps(chunk, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        print(f"Wrote {path} with {len(chunk)} schedule keys.")
        chunk = []
        chunk_bytes = 2
        chunk_index += 1

    for stop_id in sorted(schedules):
        value = json.dumps(schedules[stop_id], ensure_ascii=False, separators=(",", ":"))
        entry = {"key": f"schedule:{stop_id}", "value": value}
        entry_bytes = len(json.dumps(entry, ensure_ascii=False, separators=(",", ":")).encode("utf-8")) + 1

        if chunk and (len(chunk) >= MAX_BULK_ENTRIES or chunk_bytes + entry_bytes > MAX_BULK_BYTES):
            flush()

        chunk.append(entry)
        chunk_bytes += entry_bytes

    flush()
    print(f"Prepared {len(schedules)} stop schedule keys from {row_count} stop_time rows.")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--gtfs-zip", default="/tmp/GTFS_Realtime.zip")
    parser.add_argument("--out", default="cloudflare/src/tfi-static.generated.js")
    parser.add_argument("--kv-out-dir", default="")
    parser.add_argument("--kv-chunk-prefix", default="tfi-stop-schedules")
    args = parser.parse_args()

    zip_path = Path(args.gtfs_zip)
    out_path = Path(args.out)

    stops = [
        {
            "id": row.get("stop_id", ""),
            "code": row.get("stop_code", ""),
            "name": row.get("stop_name", ""),
        }
        for row in rows_from_zip(zip_path, "stops.txt")
        if row.get("stop_id") and row.get("stop_name")
    ]
    routes = {
        row.get("route_id", ""): row.get("route_short_name") or row.get("route_long_name") or row.get("route_id", "")
        for row in rows_from_zip(zip_path, "routes.txt")
        if row.get("route_id")
    }

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(
        "// Generated from the official TFI static GTFS ZIP. Do not edit by hand.\n"
        f"export const STOPS = {json.dumps(stops, ensure_ascii=False, separators=(',', ':'))};\n"
        f"export const ROUTES = {json.dumps(routes, ensure_ascii=False, separators=(',', ':'))};\n",
        encoding="utf-8",
    )
    print(f"Wrote {out_path} with {len(stops)} stops and {len(routes)} routes.")

    if args.kv_out_dir:
        write_schedule_chunks(zip_path, Path(args.kv_out_dir), args.kv_chunk_prefix)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
