import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	buildDesktopNotifyCommand,
	type DesktopNotifier,
	hasLinuxDesktopSession,
	resetDesktopNotifierCache,
	resolveDesktopNotifier,
	sendDesktopNotification,
	shouldDeliverDesktopNotification,
} from "@oh-my-pi/pi-tui/desktop-notify";
import * as utils from "@oh-my-pi/pi-utils";

const LINUX_ENV: NodeJS.ProcessEnv = { DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus" };

describe("hasLinuxDesktopSession", () => {
	it("requires linux + a session bus address", () => {
		expect(hasLinuxDesktopSession("linux", LINUX_ENV)).toBe(true);
		expect(hasLinuxDesktopSession("linux", {})).toBe(false);
		expect(hasLinuxDesktopSession("darwin", LINUX_ENV)).toBe(false);
		expect(hasLinuxDesktopSession("win32", LINUX_ENV)).toBe(false);
	});

	it("accepts the systemd user bus socket when the address is not exported", () => {
		const env = { XDG_RUNTIME_DIR: "/run/user/1000" };
		const fileExists = (path: string) => path === "/run/user/1000/bus";

		expect(hasLinuxDesktopSession("linux", env, fileExists)).toBe(true);
		expect(hasLinuxDesktopSession("linux", env, () => false)).toBe(false);
	});
});

describe("shouldDeliverDesktopNotification", () => {
	it("fires for VTE-family fallbacks (base/trueColor/alacritty) on a Linux session", () => {
		for (const id of ["base", "trueColor", "alacritty"] as const) {
			expect(shouldDeliverDesktopNotification(id, true, "linux", LINUX_ENV)).toBe(true);
		}
	});

	it("never fires when the terminal already speaks an in-band notify protocol", () => {
		// notifyProtocolIsBell=false means OSC 9 / OSC 99 already delivered the toast.
		expect(shouldDeliverDesktopNotification("kitty", false, "linux", LINUX_ENV)).toBe(false);
		expect(shouldDeliverDesktopNotification("ghostty", false, "linux", LINUX_ENV)).toBe(false);
		expect(shouldDeliverDesktopNotification("wezterm", false, "linux", LINUX_ENV)).toBe(false);
		expect(shouldDeliverDesktopNotification("iterm2", false, "linux", LINUX_ENV)).toBe(false);
	});

	it("lets Bell-only terminals use D-Bus while true in-band notify protocols skip it", () => {
		expect(shouldDeliverDesktopNotification("vscode", true, "linux", LINUX_ENV)).toBe(true);
		expect(shouldDeliverDesktopNotification("ghostty", false, "linux", LINUX_ENV)).toBe(false);
		expect(shouldDeliverDesktopNotification("kitty", false, "linux", LINUX_ENV)).toBe(false);
	});

	it("respects the PI_NO_DESKTOP_NOTIFY=1 opt-out", () => {
		expect(
			shouldDeliverDesktopNotification("trueColor", true, "linux", {
				...LINUX_ENV,
				PI_NO_DESKTOP_NOTIFY: "1",
			}),
		).toBe(false);
	});

	it("requires a Linux desktop session — silent on macOS / Windows / headless Linux", () => {
		expect(shouldDeliverDesktopNotification("trueColor", true, "darwin", LINUX_ENV)).toBe(false);
		expect(shouldDeliverDesktopNotification("trueColor", true, "win32", LINUX_ENV)).toBe(false);
		expect(shouldDeliverDesktopNotification("trueColor", true, "linux", {})).toBe(false);
	});
});

describe("resolveDesktopNotifier", () => {
	beforeEach(() => {
		resetDesktopNotifierCache();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetDesktopNotifierCache();
	});

	it("prefers notify-send when libnotify is on PATH", () => {
		vi.spyOn(utils, "$which").mockImplementation(name =>
			name === "notify-send" ? "/usr/bin/notify-send" : "/usr/bin/gdbus",
		);
		expect(resolveDesktopNotifier()).toEqual({ kind: "notify-send", path: "/usr/bin/notify-send" });
	});

	it("falls back to gdbus when notify-send is missing", () => {
		vi.spyOn(utils, "$which").mockImplementation(name => (name === "gdbus" ? "/usr/bin/gdbus" : null));
		expect(resolveDesktopNotifier()).toEqual({ kind: "gdbus", path: "/usr/bin/gdbus" });
	});

	it("returns null when neither binary is installed", () => {
		vi.spyOn(utils, "$which").mockReturnValue(null);
		expect(resolveDesktopNotifier()).toBeNull();
	});

	it("caches the resolution so repeat calls do not re-probe PATH", () => {
		const spy = vi.spyOn(utils, "$which").mockReturnValue("/usr/bin/notify-send");
		resolveDesktopNotifier();
		resolveDesktopNotifier();
		resolveDesktopNotifier();
		// One call per probed binary on the first invocation, zero on cache hits.
		expect(spy).toHaveBeenCalledTimes(1);
	});
});

describe("buildDesktopNotifyCommand", () => {
	const notifySend: DesktopNotifier = { kind: "notify-send", path: "/usr/bin/notify-send" };
	const gdbus: DesktopNotifier = { kind: "gdbus", path: "/usr/bin/gdbus" };

	it("encodes string messages as title=app + body=message for notify-send", () => {
		expect(buildDesktopNotifyCommand(notifySend, "ping")).toEqual([
			"/usr/bin/notify-send",
			"--app-name",
			"Oh My Pi",
			"--urgency=normal",
			"--expire-time=5000",
			"Oh My Pi",
			"ping",
		]);
	});

	it("threads structured fields (title, body, urgency) through notify-send positional + flag args", () => {
		expect(
			buildDesktopNotifyCommand(notifySend, {
				title: "Session 12",
				body: "Complete",
				urgency: "critical",
			}),
		).toEqual([
			"/usr/bin/notify-send",
			"--app-name",
			"Oh My Pi",
			"--urgency=critical",
			"--expire-time=5000",
			"Session 12",
			"Complete",
		]);
	});

	it("falls back to the app name when the structured title is blank", () => {
		expect(buildDesktopNotifyCommand(notifySend, { title: "   ", body: "Waiting for input" })).toEqual([
			"/usr/bin/notify-send",
			"--app-name",
			"Oh My Pi",
			"--urgency=normal",
			"--expire-time=5000",
			"Oh My Pi",
			"Waiting for input",
		]);
	});

	it("produces a freedesktop Notify call for gdbus including the urgency hint byte", () => {
		expect(buildDesktopNotifyCommand(gdbus, { title: "Oh My Pi", body: "ping", urgency: "low" })).toEqual([
			"/usr/bin/gdbus",
			"call",
			"--session",
			"--dest",
			"org.freedesktop.Notifications",
			"--object-path",
			"/org/freedesktop/Notifications",
			"--method",
			"org.freedesktop.Notifications.Notify",
			"Oh My Pi",
			"0",
			"",
			"Oh My Pi",
			"ping",
			"[]",
			'{"urgency": <byte 0>}',
			"5000",
		]);
	});
});

describe("sendDesktopNotification", () => {
	beforeEach(() => {
		resetDesktopNotifierCache();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetDesktopNotifierCache();
	});

	it("fires Bun.spawn with the resolved notify-send argv and unref's the child so it never blocks process exit", () => {
		vi.spyOn(utils, "$which").mockImplementation(name => (name === "notify-send" ? "/usr/bin/notify-send" : null));
		const unref = vi.fn();
		const spawn = vi.spyOn(Bun, "spawn").mockImplementation((..._args: unknown[]) => ({ unref }) as never);

		sendDesktopNotification({ title: "Session", body: "Complete" });

		expect(spawn).toHaveBeenCalledTimes(1);
		const opts = spawn.mock.calls[0]?.[0] as unknown as {
			cmd: string[];
			stdin: string;
			stdout: string;
			stderr: string;
		};
		expect(opts.cmd).toEqual([
			"/usr/bin/notify-send",
			"--app-name",
			"Oh My Pi",
			"--urgency=normal",
			"--expire-time=5000",
			"Session",
			"Complete",
		]);
		expect(opts.stdin).toBe("ignore");
		expect(opts.stdout).toBe("ignore");
		expect(opts.stderr).toBe("ignore");
		// `.unref()` is what actually decouples a slow notifier from process exit;
		// without it Bun keeps the event loop pinned to the child even with
		// stdio: "ignore".
		expect(unref).toHaveBeenCalledTimes(1);
	});

	it("is a silent no-op when no notifier binary is installed", () => {
		vi.spyOn(utils, "$which").mockReturnValue(null);
		const spawn = vi.spyOn(Bun, "spawn").mockImplementation((..._args: unknown[]) => ({ unref: vi.fn() }) as never);

		sendDesktopNotification("ping");

		expect(spawn).not.toHaveBeenCalled();
	});

	it("swallows spawn failures so a missing daemon never throws into the renderer", () => {
		vi.spyOn(utils, "$which").mockReturnValue("/usr/bin/notify-send");
		vi.spyOn(Bun, "spawn").mockImplementation(() => {
			throw new Error("ENOENT");
		});

		expect(() => sendDesktopNotification("ping")).not.toThrow();
	});
});
