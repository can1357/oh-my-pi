import { spyOn } from "bun:test";
import * as os from "node:os";
import {
	ensureChromiumExecutable,
	ensureSignInChromiumExecutable,
} from "@oh-my-pi/pi-coding-agent/tools/browser/launch";

// Launch policy reads `process.platform`; Chrome-for-Testing platform detection reads `os.platform()`, which Bun does
// not derive from the `process.platform` override. Pin both so the child resolves the emulated host's paths.
const platform = process.env.OMP_BROWSER_PROBE_PLATFORM;
if (platform === "darwin" || platform === "win32") {
	Object.defineProperty(process, "platform", { value: platform });
	spyOn(os, "platform").mockReturnValue(platform);
} else if (platform) {
	throw new Error(`Unsupported OMP_BROWSER_PROBE_PLATFORM: ${platform}`);
}

const executable =
	process.env.OMP_BROWSER_PROBE_PURPOSE === "sign-in"
		? await ensureSignInChromiumExecutable()
		: await ensureChromiumExecutable();
process.stdout.write(executable ?? "");
