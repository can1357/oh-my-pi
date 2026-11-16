import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { terminalMultiplexerEnvKeys } from "@oh-my-pi/pi-natives";
import { ImageProtocol } from "@oh-my-pi/pi-tui/terminal-capabilities";
import { withFakeTmux } from "./helpers/fake-tmux";

// Detection and capability policy are the native profile's (pi-natives
// `tui::profile` tests). These cases pin the process-wide `TERMINAL` snapshot a
// real process resolves from its environment, tmux client queries included.

interface ResolvedTerminal {
	id: string;
	imageProtocol: string | null;
	notifyProtocol: string;
}

/**
 * Build a child-process env for the TERMINAL resolution subprocesses: inherits
 * the runner's environment, strips every terminal-identification marker and
 * image-protocol pin, then applies the caller's overrides. Keeps the suite
 * independent of which terminal it runs inside (full-suite safe).
 */
function subprocessEnv(overrides: Record<string, string | undefined>): Record<string, string | undefined> {
	const env: Record<string, string | undefined> = { ...Bun.env };
	for (const key of [
		"PI_FORCE_IMAGE_PROTOCOL",
		"PASEO_TERMINAL_ID",
		"KITTY_WINDOW_ID",
		"GHOSTTY_RESOURCES_DIR",
		...terminalMultiplexerEnvKeys(),
		"WEZTERM_PANE",
		"ITERM_SESSION_ID",
		"VSCODE_PID",
		"ALACRITTY_WINDOW_ID",
		"LC_TERMINAL",
		"LC_TERMINAL_VERSION",
		"WSL_DISTRO_NAME",
		"WSL_INTEROP",
	]) {
		delete env[key];
	}
	return { ...env, ...overrides };
}

/** The `TERMINAL` snapshot a fresh process resolves under `env`. */
async function resolveTerminal(env: Record<string, string | undefined>): Promise<ResolvedTerminal> {
	const proc = Bun.spawn({
		cmd: [
			process.execPath,
			"--eval",
			`import { TERMINAL } from "@oh-my-pi/pi-tui/terminal-capabilities";
console.log(JSON.stringify({ id: TERMINAL.id, imageProtocol: TERMINAL.imageProtocol, notifyProtocol: TERMINAL.notifyProtocol }));`,
		],
		env,
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	expect(stderr).toBe("");
	expect(exitCode).toBe(0);
	return JSON.parse(stdout) as ResolvedTerminal;
}

describe("iTerm2 over SSH", () => {
	it("resolves the process-wide terminal id and image protocol from the forwarded LC_TERMINAL", async () => {
		// #12419: TERM_PROGRAM/TERM_PROGRAM_VERSION are stripped by the SSH hop
		// too, so they must not leak in from the runner's own terminal.
		const resolved = await resolveTerminal(
			subprocessEnv({
				TERM: "xterm-256color",
				COLORTERM: "truecolor",
				TERM_PROGRAM: "",
				TERM_PROGRAM_VERSION: undefined,
				LC_TERMINAL: "iTerm2",
				LC_TERMINAL_VERSION: "3.6.11",
				SSH_CONNECTION: "client 1 server 22",
			}),
		);
		expect(resolved).toMatchObject({ id: "iterm2", imageProtocol: ImageProtocol.Iterm2 });
	});
});

describe("tmux client terminal resolution", () => {
	const CLIENT_QUERY = "display-message -p #{client_termtype}\t#{client_termname}";
	// Kitty graphics inside tmux also require pane passthrough; these tests
	// exercise identity resolution, so the fake tmux forwards it.
	const PASSTHROUGH_QUERY = "show-options -Apqv allow-passthrough";

	function resolveInsideFakeTmux(clientReport: string, replyDelayMs?: number): Promise<ResolvedTerminal> {
		return withFakeTmux(
			{ [CLIENT_QUERY]: clientReport, [PASSTHROUGH_QUERY]: "on" },
			binDir =>
				resolveTerminal(
					subprocessEnv({
						PI_TEST_RUNTIME: undefined,
						BUN_ENV: undefined,
						NODE_ENV: undefined,
						TERM: "tmux-256color",
						TERM_PROGRAM: "tmux",
						TERM_PROGRAM_VERSION: "3.6b",
						COLORTERM: "truecolor",
						TMUX: "/tmp/tmux-1000/default,4242,0",
						TMUX_PANE: undefined,
						SSH_CONNECTION: "client 1 server 22",
						PATH: `${binDir}${path.delimiter}${Bun.env.PATH ?? ""}`,
					}),
				),
			{ replyDelayMs },
		);
	}

	it.skipIf(process.platform === "win32")("uses the attached client's terminal profile", async () => {
		const resolved = await resolveInsideFakeTmux("WezTerm 20260905-175422-0f4b5596\ttmux-256color");
		expect(resolved).toMatchObject({ id: "wezterm", notifyProtocol: "osc9" });
	});

	it.skipIf(process.platform === "win32")("keeps the client profile when the probe is slower than 500ms", async () => {
		// A loaded machine can push one `tmux display-message` round trip past
		// 500ms (fork/exec of the tmux client alone can exceed it on a saturated
		// box), and a lost race is indistinguishable from "not tmux": the session
		// then silently falls back to the true-color profile for its whole life.
		const resolved = await resolveInsideFakeTmux("WezTerm 20260905-175422-0f4b5596\ttmux-256color", 600);
		expect(resolved).toMatchObject({ id: "wezterm", notifyProtocol: "osc9" });
	});

	// The pane TERM no longer implies Kitty, so a Kitty client must be named by
	// tmux. Its terminal-type reply can name something else entirely (a nested
	// tmux answers `tmux 3.4`, and tmux < 3.4 records nothing); the client's
	// TERM still identifies the emulator. Report captured from tmux 3.4.
	it.skipIf(process.platform === "win32")(
		"falls back to the client's TERM when the terminal type is unknown",
		async () => {
			const resolved = await resolveInsideFakeTmux("tmux 3.4\txterm-kitty");
			expect(resolved).toMatchObject({ id: "kitty", imageProtocol: ImageProtocol.Kitty });
		},
	);

	it.skipIf(process.platform === "win32")("recognizes a Rex client from tmux client_termname", async () => {
		const resolved = await resolveInsideFakeTmux("tmux 3.4\txterm-rex");
		expect(resolved).toMatchObject({ id: "rex", imageProtocol: ImageProtocol.Kitty });
	});
});

describe("tmux image protocol selection", () => {
	// tmux 3.3+ drops `\x1bPtmux;` envelopes unless `allow-passthrough` is on,
	// so a Kitty client identity alone must not select Kitty graphics.
	for (const [name, socket, passthrough, expected] of [
		["keeps a known Kitty client when tmux forwards passthrough", "5101", "on", ImageProtocol.Kitty],
		["drops a known Kitty client when tmux blocks passthrough", "5102", "off", null],
		["keeps a known Kitty client on tmux without the passthrough option", "5103", "", ImageProtocol.Kitty],
	] as const) {
		it.skipIf(process.platform === "win32")(name, async () => {
			const replies = { "show-options -Apqv -t %7 allow-passthrough": passthrough };
			await withFakeTmux(replies, async binDir => {
				const resolved = await resolveTerminal(
					subprocessEnv({
						GHOSTTY_RESOURCES_DIR: "/usr/share/ghostty",
						PATH: `${binDir}${path.delimiter}${Bun.env.PATH ?? ""}`,
						TMUX: `/tmp/tmux-1000/default,${socket},0`,
						TMUX_PANE: "%7",
						TERM: "tmux-256color",
					}),
				);
				expect(resolved).toMatchObject({ id: "ghostty", imageProtocol: expected });
			});
		});
	}
});

describe("process-wide image protocol", () => {
	it("resolves Warp from TERM_PROGRAM, without Kitty graphics on Windows", async () => {
		const resolved = await resolveTerminal(subprocessEnv({ TERM_PROGRAM: "WarpTerminal", COLORTERM: "truecolor" }));
		expect(resolved.id).toBe("warp");
		expect(resolved.imageProtocol).toBe(process.platform === "win32" ? null : ImageProtocol.Kitty);
	});

	it("resolves otty's Kitty graphics from TERM_PROGRAM=otty", async () => {
		const resolved = await resolveTerminal(
			subprocessEnv({
				TERM_PROGRAM: "otty",
				TERM_PROGRAM_VERSION: "1.5.1",
				TERM: "xterm-256color",
				COLORTERM: "truecolor",
			}),
		);
		expect(resolved).toMatchObject({ id: "otty", imageProtocol: ImageProtocol.Kitty });
	});

	it("drops Kitty graphics when Paseo hosts the terminal", async () => {
		// Paseo's xterm.js renderer implements neither Kitty graphics nor
		// Unicode placeholders (getpaseo/paseo#3850).
		const resolved = await resolveTerminal(subprocessEnv({ TERM_PROGRAM: "kitty", PASEO_TERMINAL_ID: "term-1" }));
		expect(resolved).toMatchObject({ id: "kitty", imageProtocol: null });
	});

	it("keeps Kitty graphics for a real kitty without PASEO_TERMINAL_ID", async () => {
		const resolved = await resolveTerminal(subprocessEnv({ TERM_PROGRAM: "kitty" }));
		expect(resolved).toMatchObject({ id: "kitty", imageProtocol: ImageProtocol.Kitty });
	});
});
