import hashlib
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
GENERATOR = ROOT / "cloudflare/scripts/generate-worker-data.py"
spec = importlib.util.spec_from_file_location("worker_generator", GENERATOR)
generator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(generator)


def make_feed(path, stop_id="STOP_A"):
    with zipfile.ZipFile(path, "w") as archive:
        for name, text in {
            "stops.txt": f"stop_id,stop_code,stop_name\n{stop_id},1278,College Green\n",
            "routes.txt": "route_id,route_short_name\nR,15\n",
            "trips.txt": "route_id,service_id,trip_id,trip_headsign\nR,S,NEW_TRIP,City Centre\n",
            "stop_times.txt": f"trip_id,stop_id,stop_sequence,departure_time\nNEW_TRIP,{stop_id},4,12:10:00\n",
            "calendar.txt": "service_id,start_date,end_date,monday,tuesday,wednesday,thursday,friday,saturday,sunday\nS,20260101,20261231,1,1,1,1,1,1,1\n",
            "calendar_dates.txt": "service_id,date,exception_type\n",
        }.items():
            archive.writestr(name, text)


class WorkerGenerationTests(unittest.TestCase):
    def test_generation_versions_worker_and_assets_from_the_same_zip(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / "gtfs.zip"
            make_feed(archive)
            output, assets = root / "generated.js", root / "assets"
            result = subprocess.run([sys.executable, str(GENERATOR), "--gtfs-zip", str(archive), "--out", str(output), "--assets-dir", str(assets)], capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            exports = dict(line.removeprefix("export const ").removesuffix(";").split(" = ", 1) for line in output.read_text().splitlines())
            metadata = json.loads(exports["FEED_METADATA"])
            version = hashlib.sha256(archive.read_bytes()).hexdigest()
            self.assertEqual(metadata["version"], version)
            self.assertTrue(metadata["generated_at"].endswith("Z"))
            record = json.loads((assets / "schedules" / version / "53544f505f41.json").read_text())[0]
            self.assertEqual(record[0], "NEW_TRIP")
            manifest = json.loads((assets / "feeds" / f"{version}.json").read_text())
            self.assertEqual(manifest["version"], version)
            self.assertEqual(manifest["schedule_stops"], 1)
            self.assertEqual(len(list(assets.rglob("*json"))), 2)

    def test_generation_replaces_old_snapshots_and_encodes_stop_ids_safely(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive, assets = root / "feed.zip", root / "assets"
            make_feed(archive, "../unsafe/stop")
            (assets / "schedules" / "old-version").mkdir(parents=True)
            (assets / "schedules" / "old-version" / "old.json").write_text("[]")
            counts = generator.write_schedule_assets(archive, assets, {"R":"15"}, "new-version")
            self.assertEqual(counts["schedule_stops"], 1)
            self.assertFalse((assets / "schedules" / "old-version").exists())
            filename = "../unsafe/stop".encode().hex() + ".json"
            self.assertTrue((assets / "schedules" / "new-version" / filename).is_file())

    def test_generation_rejects_files_over_the_free_plan_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / "feed.zip"
            make_feed(archive)
            with patch.object(generator, "MAX_ASSET_BYTES", 1, create=True):
                with self.assertRaisesRegex(ValueError, "25 MiB"):
                    generator.write_schedule_assets(archive, root / "assets", {"R":"15"}, "version")

    def test_generation_counts_manifest_toward_the_free_plan_file_limit(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / "feed.zip"
            make_feed(archive)
            with patch.object(generator, "MAX_ASSET_FILES", 1, create=True):
                with self.assertRaisesRegex(ValueError, "20,000"):
                    generator.write_schedule_assets(archive, root / "assets", {"R":"15"}, "version")


if __name__ == "__main__":
    unittest.main()
