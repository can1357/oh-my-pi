import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
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

let visibleProbe: Promise<boolean> | undefined;

/**
 * Gate for tests that launch a *headful* Chromium (`headless: false`).
 *
 * `chromiumAvailable()` only proves the binary execs: `chrome --version`
 * exits 0 with no display at all, so it cannot gate a headful launch. On a
 * GH-hosted ubuntu runner there is no X server and no xvfb in the workflow,
 * so `puppeteer.launch({ headless: false })` throws "Missing X server or
 * $DISPLAY" and the suite fails rather than skipping. Require a display on
 * Linux; macOS and Windows launch headful without one.
 *
 * Same promise-not-awaited-const shape as `chromiumAvailable()`, for the same
 * temporal-dead-zone reason.
 */
export function visibleBrowserAvailable(): Promise<boolean> {
	visibleProbe ??= (async () => {
		if (!(await chromiumAvailable())) return false;
		if (process.platform !== "linux") return true;
		return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
	})();
	return visibleProbe;
}

let cdpProbe: Promise<boolean> | undefined;

/**
 * Gate for tests that need Chromium to actually **serve CDP**, not merely exec.
 *
 * `chromiumAvailable()` only proves the binary exits 0 on `--version`. On
 * snap-shim hosts the wrapper answers but puppeteer-launched CDP never comes
 * up, and every attach test fails at its `waitForCdp` deadline (#12095). This
 * probe launches the resolved binary headless with
 * `--remote-debugging-port=0` and waits for the `DevTools listening on ws://…`
 * line chrome prints to stderr once the devtools server is up — a real CDP
 * serviceability check — then kills the child and removes the throwaway
 * profile. Linux-only: the shim-wrapper fleet is Linux; other platforms keep
 * the exec-only semantics (and headful gates keep their display check).
 *
 * Same promise-not-awaited-const shape as `chromiumAvailable()`.
 */
export function chromiumCdpAvailable(): Promise<boolean> {
	cdpProbe ??= (async () => {
		if (!(await chromiumAvailable())) return false;
		if (process.platform !== "linux") return true;
		const executable = await ensureChromiumExecutable().catch(() => null);
		if (!executable) return false;
		const profile = await fs.mkdtemp(path.join(os.tmpdir(), "omp-cdp-probe-"));
		const child = Bun.spawn(
			[
				executable,
				"--headless=new",
				"--no-sandbox",
				"--disable-gpu",
				"--disable-dev-shm-usage",
				`--user-data-dir=${profile}`,
				"--remote-debugging-port=0",
				"about:blank",
			],
			{ stdin: "ignore", stdout: "ignore", stderr: "pipe" },
		);
		try {
			const stderrText = new Promise<string>(resolve => {
				const decoder = new TextDecoder();
				let text = "";
				const pump = async () => {
					const reader = child.stderr.getReader();
					for (;;) {
						const { value, done } = await reader.read();
						if (done) break;
						text += decoder.decode(value, { stream: true });
						if (text.includes("DevTools listening")) break;
					}
					resolve(text);
				};
				void pump();
			});
			const served = await Promise.race([
				stderrText.then(text => text.includes("DevTools listening")),
				Bun.sleep(8_000).then(() => false),
			]);
			return served;
		} finally {
			child.kill();
			await Promise.allSettled([child.exited, fs.rm(profile, { recursive: true, force: true })]);
		}
	})();
	return cdpProbe;
}
