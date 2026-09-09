// Subprocess probe for the timer-lifecycle test in ../ptree-timeout.test.ts:
// resolves one quick command under a long ptree timeout, then must exit on its
// own — if attachTimeout left its timer pending, this process would be held
// for the full timeout instead.
import { exec } from "../../src/ptree";

const result = await exec([process.execPath, "-e", "console.log('ok')"], { timeout: 10_000 });
if (result.stdout.trim() !== "ok" || !result.ok) process.exit(3);
console.log("probe-done");
