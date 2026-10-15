import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = new URL("./upload-schedules.mjs", import.meta.url);
const directory = await mkdtemp(join(tmpdir(), "tfi-upload-"));
const data = join(directory, "data");
const bin = join(directory, "bin");
await mkdir(data);
await mkdir(bin);
const log = join(directory, "calls");
await writeFile(join(bin,"wrangler"), '#!/bin/sh\necho "$4" >> "$UPLOAD_TEST_LOG"\ncase "$4" in *0002*) if [ "$UPLOAD_TEST_FAIL" = 1 ]; then exit 1; fi;; esac\n', {mode:0o755});
const manifest = [{key:"feed:test-version",value:JSON.stringify({version:"test-version",schedule_stops:2})}];
const workerData = join(directory,"generated.mjs");
await writeFile(workerData,'export const FEED_METADATA = {version:"test-version"};');
await writeFile(join(data,"tfi-feed-manifest.json"),JSON.stringify(manifest));
for (const number of [1,2]) await writeFile(join(data,`tfi-stop-schedules-000${number}.json`),JSON.stringify([{key:`schedule:test-version:STOP_${number}`,value:"[]"}]));
const run = (fail = false) => spawnSync(process.execPath,[script.pathname, data, workerData],{encoding:"utf8",env:{...process.env,PATH:`${bin}:${process.env.PATH}`,UPLOAD_TEST_LOG:log,UPLOAD_TEST_FAIL:fail?"1":"0"}});
try {
  await test("upload publishes the manifest only after all schedule chunks succeed", async () => {
    const result = run();
    assert.equal(result.status,0,result.stderr);
    assert.deepEqual((await readFile(log,"utf8")).trim().split("\n").map(p=>p.split("/").at(-1)),["tfi-stop-schedules-0001.json","tfi-stop-schedules-0002.json","tfi-feed-manifest.json"]);
  });
  await test("an upload failure aborts before publishing the manifest", async () => {
    await rm(log,{force:true});
    const result = run(true);
    assert.notEqual(result.status,0);
    assert.ok(!(await readFile(log,"utf8")).includes("tfi-feed-manifest"));
  });
  await test("mixed snapshot files fail preflight without any remote writes", async () => {
    await rm(log,{force:true});
    await writeFile(join(data,"tfi-stop-schedules-0002.json"),JSON.stringify([{key:"schedule:other-version:STOP_2",value:"[]"}]));
    const result = run();
    assert.notEqual(result.status,0);
    await assert.rejects(readFile(log));
  });
} finally { await rm(directory,{recursive:true,force:true}); }
