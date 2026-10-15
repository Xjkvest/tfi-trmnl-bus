import json
import sys
import tempfile
import unittest
import zipfile
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from tfi_trmnl_bus import GTFSStaticStore, departures_from_feed, normalize_stop_ids, resolve_stop_inputs


def make_static_zip(path: Path) -> None:
    files = {
        "stops.txt": (
            "stop_id,stop_code,stop_name,stop_desc,stop_lat,stop_lon,zone_id,stop_url,location_type,parent_station\n"
            "STOP_A,100,College Green,,53.344,-6.261,,,,\n"
            "STOP_B,200,Eden Quay,,53.348,-6.256,,,,\n"
        ),
        "routes.txt": (
            "route_id,agency_id,route_short_name,route_long_name,route_desc,route_type,route_url,route_color,route_text_color\n"
            "ROUTE_15,03C,15,Clongriffin - Ballycullen,,3,,,\n"
        ),
        "trips.txt": (
            "route_id,service_id,trip_id,trip_headsign,trip_short_name,direction_id,block_id,shape_id\n"
            "ROUTE_15,1,TRIP_1,Ballycullen Road,,0,,\n"
        ),
        "stop_times.txt": (
            "trip_id,arrival_time,departure_time,stop_id,stop_sequence,stop_headsign,pickup_type,drop_off_type,timepoint\n"
            "TRIP_1,12:10:00,12:10:00,STOP_A,4,Ballycullen Road,0,0,1\n"
        ),
    }
    with zipfile.ZipFile(path, "w") as archive:
        for name, content in files.items():
            archive.writestr(name, content)


class TfiTrmnlBusTests(unittest.TestCase):
    def test_stop_search_scores_name_and_code(self):
        with tempfile.TemporaryDirectory() as tmp:
            zip_path = Path(tmp) / "gtfs.zip"
            make_static_zip(zip_path)
            store = GTFSStaticStore(zip_path)

            by_name = store.search_stops("college")
            by_code = store.search_stops("200")

            self.assertEqual(by_name[0]["id"], "STOP_A")
            self.assertEqual(by_code[0]["id"], "STOP_B")

    def test_departures_from_absolute_gtfsr_times(self):
        with tempfile.TemporaryDirectory() as tmp:
            zip_path = Path(tmp) / "gtfs.zip"
            make_static_zip(zip_path)
            store = GTFSStaticStore(zip_path)
            now = datetime(2026, 7, 1, 12, 0, tzinfo=ZoneInfo("Europe/Dublin")).timestamp()
            feed = {
                "entity": [
                    {
                        "trip_update": {
                            "trip": {"trip_id": "TRIP_1", "route_id": "ROUTE_15", "start_date": "20260701"},
                            "stop_time_update": [
                                {
                                    "stop_id": "STOP_A",
                                    "departure": {"time": int(now + 420), "delay": 60},
                                    "schedule_relationship": "SCHEDULED",
                                }
                            ],
                        }
                    }
                ]
            }

            departures = departures_from_feed(
                feed,
                stop_ids=["STOP_A"],
                store=store,
                limit=5,
                tz_name="Europe/Dublin",
                now_ts=now,
            )

            self.assertEqual(len(departures), 1)
            self.assertEqual(departures[0]["route"], "15")
            self.assertEqual(departures[0]["due"], "7 min")
            self.assertEqual(departures[0]["destination"], "Ballycullen Road")

    def test_departures_fall_back_to_static_stop_times(self):
        with tempfile.TemporaryDirectory() as tmp:
            zip_path = Path(tmp) / "gtfs.zip"
            make_static_zip(zip_path)
            store = GTFSStaticStore(zip_path)
            now = datetime(2026, 7, 1, 11, 58, tzinfo=ZoneInfo("Europe/Dublin")).timestamp()
            feed = {
                "entity": [
                    {
                        "trip_update": {
                            "trip": {"trip_id": "TRIP_1", "route_id": "ROUTE_15", "start_date": "20260701"},
                            "stop_time_update": [
                                {
                                    "stop_id": "STOP_A",
                                    "stop_sequence": "4",
                                    "departure": {"delay": 120},
                                    "schedule_relationship": "SCHEDULED",
                                }
                            ],
                        }
                    }
                ]
            }

            departures = departures_from_feed(
                feed,
                stop_ids=["STOP_A"],
                store=store,
                limit=5,
                tz_name="Europe/Dublin",
                now_ts=now,
            )

            self.assertEqual(departures[0]["time"], "12:12")
            self.assertEqual(departures[0]["status"], "Late +2")

    def test_normalize_stop_ids(self):
        self.assertEqual(
            normalize_stop_ids(["STOP_A,STOP_B", json.dumps(["STOP_C", "STOP_A"])]),
            ["STOP_A", "STOP_B", "STOP_C"],
        )

    def test_resolve_stop_inputs_accepts_codes_and_labels(self):
        with tempfile.TemporaryDirectory() as tmp:
            zip_path = Path(tmp) / "gtfs.zip"
            make_static_zip(zip_path)
            store = GTFSStaticStore(zip_path)

            self.assertEqual(
                resolve_stop_inputs(["100", "Eden Quay (200)", "STOP_A"], store),
                ["STOP_A", "STOP_B"],
            )


if __name__ == "__main__":
    unittest.main()

