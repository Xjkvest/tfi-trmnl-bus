import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
GENERATOR = ROOT / "cloudflare/scripts/generate-worker-data.py"


class WorkerGenerationTests(unittest.TestCase):
    def test_generation_versions_worker_and_kv_from_the_same_zip(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            archive = root / "gtfs.zip"
            with zipfile.ZipFile(archive, "w") as z:
                for name, text in {
                    "stops.txt": "stop_id,stop_code,stop_name\nSTOP_A,1278,College Green\n",
                    "routes.txt": "route_id,route_short_name\nR,15\n",
                    "trips.txt": "route_id,service_id,trip_id,trip_headsign\nR,S,NEW_TRIP,City Centre\n",
                    "stop_times.txt": "trip_id,stop_id,stop_sequence,departure_time\nNEW_TRIP,STOP_A,4,12:10:00\n",
                    "calendar.txt": "service_id,start_date,end_date,monday,tuesday,wednesday,thursday,friday,saturday,sunday\nS,20260101,20261231,1,1,1,1,1,1,1\n",
                    "calendar_dates.txt": "service_id,date,exception_type\n",
                }.items():
                    z.writestr(name, text)
            output = root / "generated.js"
            schedules = root / "schedules"
            subprocess.run([sys.executable, str(GENERATOR), "--gtfs-zip", str(archive), "--out", str(output), "--kv-out-dir", str(schedules)], check=True, capture_output=True)
            exports = dict(line.removeprefix("export const ").removesuffix(";").split(" = ", 1) for line in output.read_text().splitlines())
            self.assertIn("FEED_METADATA", exports)
            metadata = json.loads(exports["FEED_METADATA"])
            version = hashlib.sha256(archive.read_bytes()).hexdigest()
            self.assertEqual(metadata["version"], version)
            self.assertTrue(metadata["generated_at"].endswith("Z"))
            chunks = list(schedules.glob("tfi-stop-schedules-*.json"))
            entries = [entry for chunk in chunks for entry in json.loads(chunk.read_text())]
            self.assertEqual(entries[0]["key"], f"schedule:{version}:STOP_A")
            self.assertEqual(entries[0]["expiration_ttl"], 7 * 24 * 3600)
            self.assertEqual(json.loads(entries[0]["value"])[0][0], "NEW_TRIP")
            manifest = json.loads((schedules / "tfi-feed-manifest.json").read_text())
            self.assertEqual(manifest[0]["key"], f"feed:{version}")
            self.assertEqual(manifest[0]["expiration_ttl"], 7 * 24 * 3600)
            self.assertEqual(json.loads(manifest[0]["value"])["version"], version)
            self.assertEqual(json.loads(manifest[0]["value"])["schedule_stops"], 1)


if __name__ == "__main__":
    unittest.main()
