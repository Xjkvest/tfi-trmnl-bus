import { readFile, readdir } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

// npm adds the project's locked Wrangler installation to PATH.
const directory = resolve(process.argv[2] || "data/schedules");
const workerData = process.argv[3] ? pathToFileURL(resolve(process.argv[3])) : new URL("../src/tfi-static.generated.js", import.meta.url);

try {
  const { FEED_METADATA } = await import(workerData);
  const manifestPath = join(directory, "tfi-feed-manifest.json");
  const manifestEntries = JSON.parse(await readFile(manifestPath, "utf8"));
  const manifest = JSON.parse(manifestEntries[0]?.value || "null");
  const version = manifest?.version;
  if (!version || version !== FEED_METADATA?.version || manifestEntries.length !== 1 || manifestEntries[0].key !== `feed:${version}` || !Number.isInteger(manifest.schedule_stops) || manifest.schedule_stops < 1) {
    throw new Error("Manifest and Worker data do not describe the same generated snapshot. Run generate:schedules.");
  }
  const chunks = (await readdir(directory)).filter(name => /^tfi-stop-schedules-\d+\.json$/.test(name)).sort();
  if (chunks.length === 0) throw new Error("No schedule chunks found. Run generate:schedules.");
  const keys = new Set();
  for (const chunk of chunks) {
    const entries = JSON.parse(await readFile(join(directory, chunk), "utf8"));
    if (!Array.isArray(entries) || entries.length === 0) throw new Error(`Empty schedule chunk: ${chunk}`);
    for (const entry of entries) {
      if (!entry.key?.startsWith(`schedule:${version}:`) || typeof entry.value !== "string" || keys.has(entry.key)) {
        throw new Error(`Invalid, duplicate, or mixed snapshot key in ${chunk}`);
      }
      keys.add(entry.key);
    }
  }
  if (keys.size !== manifest.schedule_stops) throw new Error("Schedule chunks are incomplete; manifest count does not match.");
  // Publish readiness last. A failed chunk must never mark a snapshot ready.
  for (const path of [...chunks.map(name => join(directory, name)), manifestPath]) {
    const result = spawnSync("wrangler", ["kv", "bulk", "put", path, "--binding", "TFI_STOP_SCHEDULES", "--remote"], {stdio:"inherit"});
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Schedule upload failed: ${path}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
