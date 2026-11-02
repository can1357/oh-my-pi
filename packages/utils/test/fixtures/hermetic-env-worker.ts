// Started by hermetic-env-probe.ts with `new Worker(url)` and no options; reports the names it sees
// and the names a child it starts with `Bun.spawn` (no `env`, outside any project dir) sees.
import * as os from "node:os";

declare const self: Worker;
const child = Bun.spawn([process.execPath, "-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"], {
	cwd: os.tmpdir(),
	stdout: "pipe",
});
const [childText] = await Promise.all([new Response(child.stdout).text(), child.exited]);
self.postMessage({ worker: Object.keys(process.env), workerChild: JSON.parse(childText) as string[] });
