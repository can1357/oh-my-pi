import { describe, expect, it, spyOn } from "bun:test";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	chromiumExecutableProbeForTest,
	resolveSharedBrowserLaunchSpec,
	stealthIgnoreDefaultArgsForTest,
	systemChromiumCandidatesForTest,
} from "@oh-my-pi/pi-coding-agent/tools/browser/launch";
import { $which, TempDir } from "@oh-my-pi/pi-utils";
import { computeExecutablePath, detectBrowserPlatform } from "@oh-my-pi/pi-utils/browsers";
import { APP_NAME } from "@oh-my-pi/pi-utils/dirs";
import { PUPPETEER_REVISIONS } from "puppeteer-core/internal/revisions.js";

const EXECUTABLE_PROBE = path.resolve(import.meta.dir, "../fixtures/browser-executable-probe.ts");

const AUTOMATION_FLAG = "--enable-automation";

const EDGE_EXECUTABLE_PATHS = [
	"C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
	"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
	"/usr/bin/microsoft-edge-stable",
] as const;

const CHROME_EXECUTABLE_PATHS = [
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/chromium",
] as const;

describe("browser launch stealth defaults", () => {
	it("keeps Puppeteer's automation default for Microsoft Edge executables", () => {
		for (const executablePath of EDGE_EXECUTABLE_PATHS) {
			const ignoreDefaultArgs = stealthIgnoreDefaultArgsForTest(executablePath);

			expect(ignoreDefaultArgs).not.toContain(AUTOMATION_FLAG);
			expect(ignoreDefaultArgs).toContain("--disable-extensions");
		}
	});

	it("continues filtering Puppeteer's automation default for Chrome and Chromium executables", () => {
		for (const executablePath of CHROME_EXECUTABLE_PATHS) {
			const ignoreDefaultArgs = stealthIgnoreDefaultArgsForTest(executablePath);

			expect(ignoreDefaultArgs).toContain(AUTOMATION_FLAG);
		}
	});
});

describe("shared browser launch", () => {
	const withExecutable = async <T>(executablePath: string, run: () => Promise<T>): Promise<T> => {
		const previousExecutable = process.env.PUPPETEER_EXECUTABLE_PATH;
		process.env.PUPPETEER_EXECUTABLE_PATH = executablePath;
		try {
			return await run();
		} finally {
			if (previousExecutable === undefined) delete process.env.PUPPETEER_EXECUTABLE_PATH;
			else process.env.PUPPETEER_EXECUTABLE_PATH = previousExecutable;
		}
	};
	// snapd keys `$SNAP_USER_COMMON` on the account's passwd home, which can differ from `HOME`.
	const passwdHome = $which("getent")
		? Bun.spawnSync(["getent", "passwd", String(process.getuid?.() ?? "")], { stderr: "ignore" })
				.stdout.toString()
				.trim()
				.split(":")[5]
		: undefined;
	const accountHome = passwdHome || os.homedir();

	it("suppresses the broker-owned blank startup window", async () => {
		const launch = await withExecutable("/test/chrome", () =>
			resolveSharedBrowserLaunchSpec({ headless: true, userDataDir: "/test/profile" }),
		);

		expect(launch?.args).toContain("--no-startup-window");
	});

	it("places a Snap-confined Chromium's profile under the snap's revision-independent common dir", async () => {
		const profile = "/home/test/.omp/run/daemons/abc/omp.browser.headless.profile";
		for (const [executablePath, expected] of [
			["/snap/bin/chromium", path.join(accountHome, "snap/chromium/common/omp", profile)],
			["/var/lib/snapd/snap/bin/chromium", path.join(accountHome, "snap/chromium/common/omp", profile)],
			["/usr/bin/chromium", profile],
		] as const) {
			const launch = await withExecutable(executablePath, () =>
				resolveSharedBrowserLaunchSpec({ headless: true, userDataDir: profile }),
			);

			expect(launch?.userDataDir).toBe(expected);
			expect(launch?.args).toContain(`--user-data-dir=${expected}`);
		}
	});

	it.skipIf(process.platform !== "linux" || !passwdHome)(
		"keys the Snap profile on the account home, not an overridden HOME",
		async () => {
			const previousHome = process.env.HOME;
			const overriddenHome = path.join(os.tmpdir(), "omp-isolated", ".omp-home");
			process.env.HOME = overriddenHome;
			try {
				const profile = "/home/test/.omp/run/daemons/abc/omp.browser.headless.profile";
				const launch = await withExecutable("/snap/bin/chromium", () =>
					resolveSharedBrowserLaunchSpec({ headless: true, userDataDir: profile }),
				);
				expect(launch?.userDataDir).toBe(path.join(accountHome, "snap/chromium/common/omp", profile));
				expect(launch?.userDataDir.startsWith(overriddenHome)).toBe(false);
			} finally {
				if (previousHome === undefined) delete process.env.HOME;
				else process.env.HOME = previousHome;
			}
		},
	);

	it("uses snapd's active alias owner instead of the launcher filename", async () => {
		const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
			Response.json({
				type: "sync",
				result: {
					chromium: {
						chrome: { command: "chromium.chromium", status: "manual" },
						chromium: { command: "chromium.chromium", status: "auto" },
					},
				},
			}),
		);
		try {
			const profile = "/home/test/.omp/run/daemons/abc/omp.browser.headless.profile";
			const launch = await withExecutable("/snap/bin/chrome", () =>
				resolveSharedBrowserLaunchSpec({ headless: true, userDataDir: profile }),
			);
			const expected = path.join(accountHome, "snap/chromium/common/omp", profile);
			expect(launch?.userDataDir).toBe(expected);
			expect(launch?.args).toContain(`--user-data-dir=${expected}`);
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it.skipIf(process.platform !== "linux")(
		"recognizes Ubuntu's Chromium transition wrapper and Snap aliases",
		async () => {
			const dir = TempDir.createSync("@snap-chromium-wrapper-");
			try {
				const wrapper = path.join(dir.path(), "chromium-browser");
				const alias = path.join(dir.path(), "chromium-alias");
				const snapRun = path.join(dir.path(), "chromium-snap-run");
				const regular = path.join(dir.path(), "chromium");
				const profile = path.join(dir.path(), ".omp/run/daemons/project/omp.browser.headless.profile");
				await Bun.write(
					wrapper,
					'#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Chromium 154"; exit 0; fi\nif ! [ -x /snap/bin/chromium ]; then exit 1; fi\nexec /snap/bin/chromium "$@"\n',
				);
				await Bun.write(snapRun, '#!/bin/sh\nexec snap run chromium "$@"\n');
				await Bun.write(regular, '#!/bin/sh\n# exec /snap/bin/chromium "$@"\nexec /usr/bin/chromium "$@"\n');
				fs.chmodSync(wrapper, 0o755);
				fs.symlinkSync("chromium-browser", alias);
				expect(await chromiumExecutableProbeForTest(wrapper)).toBe(true);
				for (const executablePath of [wrapper, alias, snapRun]) {
					const spec = await withExecutable(executablePath, () =>
						resolveSharedBrowserLaunchSpec({ headless: true, userDataDir: profile }),
					);
					const expected = path.join(accountHome, "snap/chromium/common/omp", profile);
					expect(spec?.userDataDir).toBe(expected);
					expect(spec?.args).toContain(`--user-data-dir=${expected}`);
				}
				const native = await withExecutable(regular, () =>
					resolveSharedBrowserLaunchSpec({ headless: true, userDataDir: profile }),
				);
				expect(native?.userDataDir).toBe(profile);
				expect(native?.args).toContain(`--user-data-dir=${profile}`);
			} finally {
				await dir.remove();
			}
		},
	);
});

const UNGOOGLED_CHROMIUM_FLATPAK_ID = "io.github.ungoogled_software.ungoogled_chromium";

describe("system Chromium candidates", () => {
	const linuxCandidates = (which: (name: string) => string | undefined = () => undefined) =>
		systemChromiumCandidatesForTest("linux", "/home/test", which);

	it("offers Ungoogled Chromium executables on Linux", () => {
		const candidates = linuxCandidates();

		expect(candidates).toContain("/usr/bin/ungoogled-chromium");
		expect(candidates).toContain("/usr/bin/ungoogled-chromium-browser");
		expect(candidates).toContain(`/var/lib/flatpak/exports/bin/${UNGOOGLED_CHROMIUM_FLATPAK_ID}`);
		expect(candidates).toContain(
			path.join("/home/test", ".local/share/flatpak/exports/bin", UNGOOGLED_CHROMIUM_FLATPAK_ID),
		);
	});

	it("keeps the previously supported Linux executables", () => {
		const candidates = linuxCandidates();

		for (const executablePath of [
			"/usr/bin/google-chrome-stable",
			"/usr/bin/google-chrome",
			"/usr/bin/chromium",
			"/usr/bin/chromium-browser",
			"/snap/bin/chromium",
			"/var/lib/flatpak/exports/bin/com.google.Chrome",
			"/var/lib/flatpak/exports/bin/org.chromium.Chromium",
		]) {
			expect(candidates).toContain(executablePath);
		}
	});

	it("ranks PATH-resolved Ungoogled Chromium below stock builds", () => {
		const ungoogledPath = "/custom/bin/ungoogled-chromium";
		const candidates = linuxCandidates(name => (name === "ungoogled-chromium" ? ungoogledPath : undefined));
		const ungoogled = candidates.indexOf(ungoogledPath);

		for (const executablePath of [
			"/usr/bin/google-chrome-stable",
			"/usr/bin/chromium",
			"/snap/bin/chromium",
			"/var/lib/flatpak/exports/bin/org.chromium.Chromium",
		]) {
			expect(ungoogled).toBeGreaterThan(candidates.indexOf(executablePath));
		}
	});

	it("does not add Ungoogled Chromium candidates on macOS or Windows", () => {
		for (const platform of ["darwin", "win32"] as const) {
			const candidates = systemChromiumCandidatesForTest(platform, "/home/test", () => "/custom/ungoogled");
			expect(candidates.some(candidate => candidate.toLowerCase().includes("ungoogled"))).toBeFalse();
		}
	});
});

describe("browser executable selection", () => {
	it.skipIf(process.platform !== "linux")(
		"rejects executable wrappers that are not Chromium-family browsers",
		async () => {
			const tempDir = TempDir.createSync("@browser-probe-");
			try {
				const wrapper = path.join(tempDir.path(), "google-chrome");
				const chromium = path.join(tempDir.path(), "chromium");
				const nonExecutable = path.join(tempDir.path(), "not-executable");
				await Bun.write(wrapper, "#!/bin/sh\necho browser bridge\n");
				await Bun.write(chromium, "#!/bin/sh\necho Chromium 123.0\n");
				await Bun.write(nonExecutable, "#!/bin/sh\necho Chromium 123.0\n");
				fs.chmodSync(wrapper, 0o755);
				fs.chmodSync(chromium, 0o755);
				fs.chmodSync(nonExecutable, 0o644);

				await expect(chromiumExecutableProbeForTest(wrapper)).resolves.toBe(false);
				await expect(chromiumExecutableProbeForTest(chromium)).resolves.toBe(true);
				await expect(chromiumExecutableProbeForTest(nonExecutable)).resolves.toBe(false);
			} finally {
				await tempDir.remove();
			}
		},
	);

	it.skipIf(process.platform !== "linux")("rejects wrappers that hang during the version probe", async () => {
		const tempDir = TempDir.createSync("@browser-probe-hanging-");
		try {
			const hangingWrapper = path.join(tempDir.path(), "google-chrome");
			await Bun.write(hangingWrapper, "#!/bin/sh\nsleep 60\n");
			fs.chmodSync(hangingWrapper, 0o755);

			const startedAt = performance.now();
			await expect(chromiumExecutableProbeForTest(hangingWrapper)).resolves.toBe(false);
			expect(performance.now() - startedAt).toBeLessThan(5000);
		} finally {
			await tempDir.remove();
		}
	});

	it("does not launch the candidate to probe its version off Linux (#8445)", async () => {
		for (const platform of ["win32", "darwin"] as const) {
			const tempDir = TempDir.createSync(`@browser-probe-${platform}-`);
			try {
				const marker = path.join(tempDir.path(), "gui-launched");
				const fakeChrome = path.join(tempDir.path(), "chrome.exe");
				// A GUI browser handoff: executing it has a side effect (this marker)
				// but prints nothing a console version probe would accept.
				await Bun.write(fakeChrome, `#!/bin/sh\ntouch "${marker}"\necho "activating existing window"\n`);
				fs.chmodSync(fakeChrome, 0o755);

				const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
				Object.defineProperty(process, "platform", { value: platform, configurable: true });
				try {
					await expect(chromiumExecutableProbeForTest(fakeChrome)).resolves.toBe(true);
				} finally {
					if (platformDescriptor) Object.defineProperty(process, "platform", platformDescriptor);
				}

				expect(fs.existsSync(marker)).toBe(false);
			} finally {
				await tempDir.remove();
			}
		}
	});

	it("honors PUPPETEER_EXECUTABLE_PATH before a detected Windows system Chrome", async () => {
		const tempDir = TempDir.createSync("@browser-executable-");
		try {
			const override = path.join(tempDir.path(), "chrome-headless-shell.exe");
			const systemChrome = path.join(tempDir.path(), "Google\\Chrome\\Application\\chrome.exe");
			await Bun.write(override, "override");
			await Bun.write(systemChrome, "system");

			const result = Bun.spawnSync([process.execPath, EXECUTABLE_PROBE], {
				env: {
					...process.env,
					OMP_BROWSER_PROBE_PLATFORM: "win32",
					ProgramFiles: tempDir.path(),
					"ProgramFiles(x86)": path.join(tempDir.path(), "missing-x86"),
					LOCALAPPDATA: path.join(tempDir.path(), "missing-local"),
					PUPPETEER_EXECUTABLE_PATH: override,
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const stderr = new TextDecoder().decode(result.stderr);

			expect(result.exitCode, stderr).toBe(0);
			expect(new TextDecoder().decode(result.stdout)).toBe(override);
		} finally {
			await tempDir.remove();
		}
	});

	// The child pins its puppeteer cache via XDG_CACHE_HOME, which the dirs
	// resolver honors only on Linux/macOS hosts; on Windows it would resolve the
	// real user cache and attempt a network download.
	it.skipIf(process.platform === "win32")(
		"prefers Chrome for Testing over a detected system Chrome on macOS (#8673)",
		async () => {
			const tempDir = TempDir.createSync("@browser-macos-cft-");
			try {
				const home = path.join(tempDir.path(), "home");
				const xdgCache = path.join(tempDir.path(), "cache");
				// resolveIf() (packages/utils/src/dirs.ts) only redirects to an XDG
				// root when its `<XDG>/omp` dir already exists, so create them to pin
				// the child's puppeteer cache to this isolated location.
				for (const xdg of [xdgCache, path.join(tempDir.path(), "data"), path.join(tempDir.path(), "state")]) {
					fs.mkdirSync(path.join(xdg, APP_NAME), { recursive: true });
				}
				const env = {
					...process.env,
					HOME: home,
					XDG_CACHE_HOME: xdgCache,
					XDG_DATA_HOME: path.join(tempDir.path(), "data"),
					XDG_STATE_HOME: path.join(tempDir.path(), "state"),
					OMP_BROWSER_PROBE_PLATFORM: "darwin",
					PUPPETEER_EXECUTABLE_PATH: "",
				};

				// System Google Chrome bundle (com.google.Chrome) — the LaunchServices
				// hijacker the fix must avoid selecting.
				const systemChrome = path.join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
				await Bun.write(systemChrome, "#!/bin/sh\necho 'Google Chrome 151'\n");
				fs.chmodSync(systemChrome, 0o755);

				// Seed the isolated Chrome for Testing binary in the child's cache so the
				// probe resolves it without a network download. getPuppeteerDir() resolves
				// to `<XDG_CACHE_HOME>/omp/puppeteer` given the dirs created above.
				const cacheDir = path.join(xdgCache, APP_NAME, "puppeteer");
				const platform = detectBrowserPlatform();
				if (!platform) throw new Error("unsupported host platform for Chrome-for-Testing selection test");
				const buildId = PUPPETEER_REVISIONS.chrome;
				const chromeForTesting = computeExecutablePath({ buildId, cacheDir, platform });
				await Bun.write(chromeForTesting, "#!/bin/sh\necho 'Chrome for Testing'\n");
				fs.chmodSync(chromeForTesting, 0o755);

				const result = Bun.spawnSync([process.execPath, EXECUTABLE_PROBE], { env, stdout: "pipe", stderr: "pipe" });
				const stderr = new TextDecoder().decode(result.stderr);

				expect(result.exitCode, stderr).toBe(0);
				const selected = new TextDecoder().decode(result.stdout);
				expect(selected).toBe(chromeForTesting);
				expect(selected).not.toBe(systemChrome);
			} finally {
				await tempDir.remove();
			}
		},
	);
});
