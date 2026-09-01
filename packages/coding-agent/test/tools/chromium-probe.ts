import * as fs from "node:fs/promises";
import { ensureChromiumExecutable } from "@oh-my-pi/pi-coding-agent/tools/browser/launch";

/**
 * Whether the Chromium puppeteer resolves can actually execute on this host.
 * CI runners without Chrome's system libraries (libnspr4 & co.) hold the
 * downloaded binary but cannot exec it — probe with --version and skip
 * instead of failing.
 */
async function chromiumCanLaunch(): Promise<boolean> {
	try {
		const executable = await ensureChromiumExecutable();
		if (!executable) return false;
		// Only Linux runs the exec probe. Elsewhere the resolved candidate is a
		// GUI application path, and running it is the hazard
		// `isChromiumExecutable()` already refuses for the same reason (#8445): a
		// GUI `chrome.exe --version` prints nothing to a detached stdout and does
		// not exit, so this spawnSync never returns and every importing suite
		// hangs during module evaluation. Check the file instead, so a stale
		// PUPPETEER_EXECUTABLE_PATH — which `ensureChromiumExecutable()` hands
		// back unvalidated — still skips the suites rather than failing them at
		// launch.
		if (process.platform !== "linux") return (await fs.stat(executable)).isFile();
		const probe = Bun.spawnSync([executable, "--version"], { stdout: "ignore", stderr: "ignore" });
		return probe.exitCode === 0;
	} catch {
		return false;
	}
}

let probe: Promise<boolean> | undefined;

/**
 * Gate for tests that launch a real Chromium:
 *
 *     const CHROMIUM_AVAILABLE = await chromiumAvailable();
 *     describe.skipIf(!CHROMIUM_AVAILABLE)(…);
 *
 * The result is a promise rather than an awaited `export const`. A module whose
 * exports are initialized by top-level await hands the test runner a binding
 * that is still in its temporal dead zone when a second test file in the same
 * process imports it, and that file dies during registration with "Cannot
 * access 'CHROMIUM_AVAILABLE' before initialization". Awaiting in the importer
 * makes the wait part of that file's own evaluation, which the runner does
 * sequence. The probe runs once per process.
 */
export function chromiumAvailable(): Promise<boolean> {
	probe ??= chromiumCanLaunch();
	return probe;
}

/**
 * Whether this host can present a browser window at all.
 *
 * Mirrors `hasDisplay()` in `src/utils/clipboard.ts`: on Linux a GUI process
 * needs an X11 or Wayland server, and headless CI runners have neither. Every
 * other platform runs its tests from a desktop session.
 */
function hasDisplay(): boolean {
	return process.platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
}

let headfulProbe: Promise<boolean> | undefined;

/**
 * Gate for tests that launch Chromium *headful* (`headless: false`).
 *
 * `chromiumAvailable()` is necessary but not sufficient here: its probe is
 * `chrome --version`, which needs no display and so still reports `true` on a
 * display-less runner. A headful suite gated on it therefore clears the skip
 * and then dies inside Puppeteer with "Missing X server to start the headful
 * browser. Either set headless to true or use xvfb-run to run your Puppeteer
 * script." (`BrowserLauncher.js:160`), which reads as a product failure rather
 * than the environment gap it is. Headful needs a working binary *and* a
 * display, so require both.
 */
export function headfulChromiumAvailable(): Promise<boolean> {
	headfulProbe ??= hasDisplay() ? chromiumAvailable() : Promise.resolve(false);
	return headfulProbe;
}
