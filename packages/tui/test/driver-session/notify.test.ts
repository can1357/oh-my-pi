import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { setTerminalHeadless } from "@oh-my-pi/pi-utils";
import type { NotifyProtocol } from "../../src/driver/caps/identity";
import * as desktopNotify from "../../src/driver/desktop-notify";
import type { Env } from "../../src/driver/mux/detect";
import { wrapTmuxPassthrough } from "../../src/driver/mux/tmux";
import {
	formatNotification,
	isNotificationSuppressed,
	sendNotification,
	type TerminalNotification,
} from "../../src/driver/notify";
import { notifyTerminal } from "../../src/driver/session";
import { startProcessDriver } from "../../src/testing/process-driver";

const CMUX_SURFACE = "123e4567-e89b-12d3-a456-426614174000";
const TMUX = "/tmp/tmux-1000/default,1234,0";

let previousHeadless = true;

beforeEach(() => {
	previousHeadless = setTerminalHeadless(false);
});

afterEach(() => {
	setTerminalHeadless(previousHeadless);
	vi.restoreAllMocks();
});

/** Send through a recording target; returns the writes. */
function send(
	message: string | TerminalNotification,
	env: Env = {},
	protocol: NotifyProtocol = "osc99",
	rich = false,
): string[] {
	const writes: string[] = [];
	sendNotification(message, { protocol, rich, env, write: data => void writes.push(data) });
	return writes;
}

interface SpawnLog {
	/** The argv of every spawn, in order. */
	readonly argv: string[][];
	readonly unref: () => void;
}

/** Kitty's answer to the driver's OSC 99 capability query, listing title and body payloads. */
function confirmOsc99(probes: string): string {
	const id = /\x1b\]99;i=(omp-probe-\d+):p=\?;\x1b\\/u.exec(probes)?.[1];
	if (!id) throw new Error("no OSC 99 capability query");
	return `\x1b]99;i=${id}:p=?;p=title,body:a=focus,report:s=system,silent:w=1\x1b\\`;
}

/** Record spawns instead of running them. */
function mockSpawn(): SpawnLog {
	const argv: string[][] = [];
	const unref = vi.fn();
	vi.spyOn(Bun, "spawn").mockImplementation((options: unknown) => {
		if (options && typeof options === "object" && "cmd" in options && Array.isArray(options.cmd)) {
			argv.push(options.cmd.map(String));
		}
		return { unref } as never;
	});
	return { argv, unref };
}

describe("notification formatting", () => {
	it("keeps string notification formatting backward-compatible", () => {
		expect(formatNotification("hello", "osc99", false)).toBe("\x1b]99;;hello\x1b\\");
		expect(formatNotification("hello", "osc9", false)).toBe("\x1b]9;hello\x1b\\");
		expect(formatNotification("hello", "bell", false)).toBe("\x07");
	});

	it("falls back to a single OSC 99 line until rich support is confirmed", () => {
		expect(formatNotification({ title: "Session", body: "Complete" }, "osc99", false)).toBe(
			"\x1b]99;;Session: Complete\x1b\\",
		);
	});

	it("formats structured Kitty OSC 99 title and body chunks", () => {
		const out = formatNotification(
			{
				title: "Session",
				body: "Complete",
				id: "complete-1",
				type: "completion",
				urgency: "normal",
				iconName: "info",
				sound: "info",
				actions: "focus",
				expiresMs: 5000,
			},
			"osc99",
			true,
		);
		expect(out).toBe(
			"\x1b]99;i=complete-1:f=b21w:a=focus:u=1:t=Y29tcGxldGlvbg==:n=aW5mbw==:s=aW5mbw==:w=5000:d=0;Session\x1b\\" +
				"\x1b]99;i=complete-1:p=body;Complete\x1b\\",
		);
	});

	it("base64-encodes unsafe OSC 99 payload controls", () => {
		expect(formatNotification({ title: "Line 1\nLine 2", id: "unsafe" }, "osc99", true)).toBe(
			"\x1b]99;i=unsafe:f=b21w:e=1;TGluZSAxCkxpbmUgMg==\x1b\\",
		);
	});

	it("generates OSC 99 ids that differ between notifications and between processes", () => {
		// Kitty tracks ids per terminal process, so two omp processes in one kitty
		// instance must never reuse each other's ids.
		const script = `
			import { formatNotification } from "${new URL("../../src/driver/notify.ts", import.meta.url).pathname}";
			for (let i = 0; i < 2; i++) console.log(formatNotification({ title: "omp", body: "Complete" }, "osc99", true));
		`;
		const idsFromProcess = () => {
			const result = Bun.spawnSync([process.execPath, "-e", script], { cwd: import.meta.dir });
			expect(result.exitCode).toBe(0);
			return [...result.stdout.toString().matchAll(/\x1b\]99;i=([^:;]+):f=/gu)].map(m => m[1]);
		};
		const first = idsFromProcess();
		const second = idsFromProcess();
		expect(first).toHaveLength(2);
		expect(second).toHaveLength(2);
		expect(new Set([...first, ...second]).size).toBe(4);
	});

	it("wraps an OSC payload in tmux's DCS passthrough envelope with doubled ESCs", () => {
		expect(wrapTmuxPassthrough("\x1b]99;;Hello\x1b\\")).toBe("\x1bPtmux;\x1b\x1b]99;;Hello\x1b\x1b\\\x1b\\");
	});
});

describe("notification suppression", () => {
	it("honors PI_NOTIFICATIONS=off|0|false", () => {
		for (const value of ["off", "0", "false"]) {
			expect(isNotificationSuppressed({ PI_NOTIFICATIONS: value })).toBe(true);
			expect(send("ping", { PI_NOTIFICATIONS: value })).toEqual([]);
		}
		expect(isNotificationSuppressed({ PI_NOTIFICATIONS: "on" })).toBe(false);
		expect(isNotificationSuppressed({})).toBe(false);
	});

	it("sends nothing while the terminal is headless", () => {
		setTerminalHeadless(true);
		expect(send("ping")).toEqual([]);
	});
});

describe("multiplexer notification routing", () => {
	it("routes a real cmux surface notification exactly once with explicit argv fields", () => {
		const unref = vi.fn();
		const spawn = vi.spyOn(Bun, "spawn").mockImplementation((..._args: unknown[]) => ({ unref }) as never);

		const writes = send({ title: "--title=spoof", body: "--surface other" }, { CMUX_SURFACE_ID: CMUX_SURFACE });

		expect(spawn).toHaveBeenCalledTimes(1);
		expect(spawn).toHaveBeenCalledWith({
			cmd: ["cmux", "notify", "--surface", CMUX_SURFACE, "--title", "--title=spoof", "--body", "--surface other"],
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		expect(unref).toHaveBeenCalledTimes(1);
		expect(writes).toEqual([]);
	});

	it("routes a Herdr pane notification through the CLI instead of a swallowed OSC", () => {
		const unref = vi.fn();
		const spawn = vi.spyOn(Bun, "spawn").mockImplementation((..._args: unknown[]) => ({ unref }) as never);

		const writes = send(
			{ title: "session", body: "Waiting for input", type: "ask" },
			{ HERDR_ENV: "1", HERDR_PANE_ID: "w6:p1" },
		);

		expect(spawn).toHaveBeenCalledTimes(1);
		expect(spawn).toHaveBeenCalledWith({
			cmd: ["herdr", "notification", "show", "session", "--body", "Waiting for input", "--sound", "request"],
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		expect(unref).toHaveBeenCalledTimes(1);
		expect(writes).toEqual([]);
	});

	it("routes through the CLI when a launcher dropped HERDR_ENV but kept the pane id", () => {
		const { argv } = mockSpawn();
		expect(send({ title: "session", body: "Waiting", type: "ask" }, { HERDR_PANE_ID: "w6:p1" })).toEqual([]);
		expect(argv).toHaveLength(1);
	});

	it("rings done for a settled turn, request for an error, and stays silent otherwise", () => {
		const { argv } = mockSpawn();
		const env = { HERDR_ENV: "1", HERDR_PANE_ID: "w6:p1" };

		send({ title: "session", body: "Complete", type: "completion" }, env);
		send({ title: "session", body: "Stopped with error", type: "error" }, env);
		send({ title: "session", body: "Reminder", type: "info" }, env);

		const sounds = argv.map(cmd => cmd[cmd.indexOf("--sound") + 1]);
		expect(sounds).toEqual(["done", "request", "none"]);
	});

	it("never hands Herdr a title it would read as a help request", () => {
		const { argv } = mockSpawn();
		const env = { HERDR_ENV: "1", HERDR_PANE_ID: "w6:p1" };

		send({ title: "--help", body: "Complete", type: "completion" }, env);
		send({ title: "-x session", body: "Complete", type: "completion" }, env);

		expect(argv.map(cmd => cmd[3])).toEqual(["omp", "-x session"]);
	});

	it("keeps the OSC fallback when the Herdr pane id is absent", () => {
		const { argv } = mockSpawn();
		expect(send("no pane", { HERDR_ENV: "1" })).toEqual(["\x1b]99;;no pane\x1b\\"]);
		expect(argv).toEqual([]);
	});

	it("falls through an incomplete Herdr session to a concrete cmux surface", () => {
		const { argv } = mockSpawn();
		expect(send("ping", { HERDR_ENV: "1", CMUX_SURFACE_ID: CMUX_SURFACE })).toEqual([]);
		expect(argv.map(cmd => cmd[0])).toEqual(["cmux"]);
	});

	it("routes to the Herdr pane, not the cmux surface it was launched inside", () => {
		const { argv } = mockSpawn();
		const env = {
			HERDR_ENV: "1",
			HERDR_PANE_ID: "w6:p1",
			CMUX_SURFACE_ID: CMUX_SURFACE,
			CMUX_SOCKET_PATH: "/tmp/cmux.sock",
		};
		expect(send({ title: "session", body: "Waiting", type: "ask" }, env)).toEqual([]);
		expect(argv.map(cmd => cmd[0])).toEqual(["herdr"]);
	});

	// Delivery tries the innermost pane notifier, then the containing surface,
	// then in-band rewrites (tmux before Zellij), then the terminal fallback.
	it.each([
		["a Herdr pane over tmux", { HERDR_PANE_ID: "w6:p1", TMUX }, "herdr", []],
		["a cmux surface over tmux", { CMUX_SURFACE_ID: CMUX_SURFACE, TMUX }, "cmux", []],
		["a cmux surface over Zellij", { CMUX_SURFACE_ID: CMUX_SURFACE, ZELLIJ: "0" }, "cmux", []],
		[
			"an incomplete Herdr session over tmux",
			{ HERDR_ENV: "1", TMUX },
			undefined,
			["\x1bPtmux;\x1b\x1b]99;;ping\x1b\x1b\\\x1b\\\x07"],
		],
		[
			"tmux and Zellij together",
			{ TMUX, ZELLIJ: "0" },
			undefined,
			["\x1bPtmux;\x1b\x1b]99;;ping\x1b\x1b\\\x1b\\\x07"],
		],
	] as const)("routes a notification inside %s to the innermost notifier", (_label, env, binary, expected) => {
		const { argv } = mockSpawn();
		expect(send("ping", env)).toEqual([...expected]);
		expect(argv.map(cmd => cmd[0])).toEqual(binary === undefined ? [] : [binary]);
	});

	it("keeps the OSC fallback when the herdr binary is missing", () => {
		const spawn = vi.spyOn(Bun, "spawn").mockImplementation(() => {
			throw new Error("spawn herdr ENOENT");
		});
		expect(send("no binary", { HERDR_ENV: "1", HERDR_PANE_ID: "w6:p1" })).toEqual(["\x1b]99;;no binary\x1b\\"]);
		expect(spawn).toHaveBeenCalledTimes(1);
	});

	it("keeps the existing OSC fallback for cmux workspace or socket state without a surface", () => {
		const { argv } = mockSpawn();
		expect(send("workspace", { CMUX_WORKSPACE_ID: "workspace:1" })).toEqual(["\x1b]99;;workspace\x1b\\"]);
		expect(send("socket", { CMUX_SOCKET_PATH: "/tmp/cmux.sock" })).toEqual(["\x1b]99;;socket\x1b\\"]);
		expect(argv).toEqual([]);
	});

	it("rejects option-like cmux surface values and retains the existing fallback", () => {
		const { argv } = mockSpawn();
		expect(send("ping", { CMUX_SURFACE_ID: "--help" })).toEqual(["\x1b]99;;ping\x1b\\"]);
		expect(argv).toEqual([]);
	});

	it("falls back to the terminal protocol when cmux cannot be spawned", () => {
		vi.spyOn(Bun, "spawn").mockImplementation(() => {
			throw new Error("ENOENT");
		});
		expect(send("ping", { CMUX_SURFACE_ID: CMUX_SURFACE })).toEqual(["\x1b]99;;ping\x1b\\"]);
	});

	it("unrefs a lingering cmux child so notification delivery cannot pin process exit", () => {
		const { unref } = mockSpawn();
		send("ping", { CMUX_SURFACE_ID: CMUX_SURFACE });
		expect(unref).toHaveBeenCalledTimes(1);
	});

	it("under tmux, OSC-protocol notifications wrap for passthrough and append BEL in one write", () => {
		expect(send("ping", { TMUX })).toEqual(["\x1bPtmux;\x1b\x1b]99;;ping\x1b\x1b\\\x1b\\\x07"]);
	});

	it("under tmux, Bell-protocol notifications stay a plain BEL (no DCS wrap)", () => {
		expect(send("ping", { TMUX }, "bell")).toEqual(["\x07"]);
	});

	it("under Zellij, OSC-protocol notifications append a plain BEL (no DCS wrap)", () => {
		expect(send("ping", { ZELLIJ: "0" })).toEqual(["\x1b]99;;ping\x1b\\\x07"]);
	});

	it("under Zellij, Bell-protocol notifications stay a single plain BEL", () => {
		expect(send("ping", { ZELLIJ: "0" }, "bell")).toEqual(["\x07"]);
	});

	it("outside multiplexers, OSC-protocol notifications write the raw OSC unchanged", () => {
		expect(send("ping")).toEqual(["\x1b]99;;ping\x1b\\"]);
	});
});

describe("D-Bus fallback", () => {
	it("Bell-protocol notifications also fan out to D-Bus when the gate is open", () => {
		vi.spyOn(desktopNotify, "shouldDeliverDesktopNotification").mockReturnValue(true);
		const dbus = vi.spyOn(desktopNotify, "sendDesktopNotification").mockImplementation(() => {});

		// BEL still reaches the terminal for tmux monitor-bell / X11 urgency / audible bell.
		expect(send({ title: "Session", body: "Complete" }, {}, "bell")).toEqual(["\x07"]);
		expect(dbus).toHaveBeenCalledTimes(1);
		expect(dbus).toHaveBeenCalledWith({ title: "Session", body: "Complete" });
	});

	it("skips the D-Bus dispatch when the gate forbids it", () => {
		vi.spyOn(desktopNotify, "shouldDeliverDesktopNotification").mockReturnValue(false);
		const dbus = vi.spyOn(desktopNotify, "sendDesktopNotification").mockImplementation(() => {});
		send("ping", {}, "bell");
		expect(dbus).not.toHaveBeenCalled();
	});

	it("never reaches D-Bus when the terminal already speaks an in-band notify protocol", () => {
		vi.spyOn(desktopNotify, "shouldDeliverDesktopNotification").mockReturnValue(true);
		const dbus = vi.spyOn(desktopNotify, "sendDesktopNotification").mockImplementation(() => {});
		send("ping", {}, "osc99");
		send("ping", {}, "osc9");
		expect(dbus).not.toHaveBeenCalled();
	});
});

describe("OSC 99 capability probe", () => {
	it("queries and confirms OSC 99 support before rich notifications", async () => {
		const term = await startProcessDriver({ env: { KITTY_WINDOW_ID: "1" } });
		try {
			const query = term.output.join("").match(/\x1b\]99;i=(omp-probe-\d+):p=\?;\x1b\\/u);
			expect(query).not.toBeNull();
			expect(term.driver.identity.richNotifications).toBe(false);
		} finally {
			await term.driver.stop();
		}

		// The answer arrives ahead of the batch's DA1 sentinel.
		const answered = await startProcessDriver({ env: { KITTY_WINDOW_ID: "1" } }, confirmOsc99);
		try {
			expect(answered.driver.identity.richNotifications).toBe(true);
		} finally {
			await answered.driver.stop();
		}
		expect(answered.driver.identity.richNotifications).toBe(false);
	});

	it("marks OSC 99 unsupported when the DA1 sentinel wins", async () => {
		const term = await startProcessDriver({ env: { KITTY_WINDOW_ID: "1" } });
		try {
			// The batch's DA1 already settled the query; a late answer must not confirm it.
			term.feed(confirmOsc99(term.output.join("")));
			expect(term.driver.identity.richNotifications).toBe(false);
		} finally {
			await term.driver.stop();
		}
	});

	it("never probes under tmux (the reply cannot route back to the pane)", async () => {
		const term = await startProcessDriver({ env: { KITTY_WINDOW_ID: "1", TMUX } });
		try {
			expect(term.output.join("")).not.toContain("]99;i=omp-probe-");
		} finally {
			await term.driver.stop();
		}
	});

	it("never probes terminals without OSC 99", async () => {
		const term = await startProcessDriver({ env: { TERM_PROGRAM: "ghostty" } });
		try {
			expect(term.output.join("")).not.toContain("]99;");
			expect(term.driver.identity.notify).toBe("osc9");
		} finally {
			await term.driver.stop();
		}
	});
});

describe("notifyTerminal", () => {
	it("sends structured OSC 99 through the running driver once rich support is confirmed", async () => {
		const term = await startProcessDriver({ env: { KITTY_WINDOW_ID: "1" } }, confirmOsc99);
		try {
			term.output.length = 0;
			notifyTerminal({ title: "Session", body: "Complete", id: "n1" });
			expect(term.output).toEqual(["\x1b]99;i=n1:f=b21w:d=0;Session\x1b\\\x1b]99;i=n1:p=body;Complete\x1b\\"]);
		} finally {
			await term.driver.stop();
		}
	});

	// While a driver owns stdout a notification written around it could split a
	// frame's escape sequence; every write site takes the driver's path.
	it.each([
		["direct", {}, "\x1b]9;ping\x1b\\"],
		["tmux", { TMUX }, "\x1b[?2004h\x1bPtmux;\x1b\x1b]9;ping\x1b\x1b\\\x1b\\\x07"],
		["Zellij", { ZELLIJ: "0" }, "\x1b]9;ping\x1b\\\x07"],
	] as const)(
		"routes a %s notification through the running driver, never straight to stdout",
		async (_host, env, sequence) => {
			const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
			const term = await startProcessDriver({ env: { TERM_PROGRAM: "ghostty", ...env } });
			try {
				term.output.length = 0;
				notifyTerminal("ping");
				expect(term.output).toEqual([sequence]);
				expect(stdout).not.toHaveBeenCalled();
			} finally {
				await term.driver.stop();
			}
		},
	);
});
