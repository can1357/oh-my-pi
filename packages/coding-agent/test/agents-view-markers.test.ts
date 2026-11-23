import { afterEach, describe, expect, it } from "bun:test";
import {
	AGENT_INSTANCE_ENV,
	applyViewerEnv,
	filterHostedEnv,
	hostedRestartEnv,
} from "@oh-my-pi/pi-coding-agent/agents-view/host";
import {
	DetachMarkerMatcher,
	encodeAttachMarker,
	encodeDetachMarker,
	newAttachToken,
	parseAttachPayload,
	type ViewerIdentity,
	viewerIdentityFromEnv,
} from "@oh-my-pi/pi-coding-agent/agents-view/markers";
import { OMP_ATTACH_APC_PREFIX } from "@oh-my-pi/pi-tui/terminal";
import {
	classifyTerminalMultiplexer,
	isInsideTerminalMultiplexer,
	setViewerTerminalMultiplexer,
	terminalMultiplexerSessions,
} from "@oh-my-pi/pi-tui/terminal-multiplexer";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const token = newAttachToken();
const otherToken = newAttachToken();

/** Feed `chunks` through one matcher; the concatenated pass-through text and whether it detached. */
function scan(chunks: Uint8Array[]): { text: string; detached: boolean } {
	const matcher = new DetachMarkerMatcher(token);
	let text = "";
	let detached = false;
	for (const chunk of chunks) {
		const result = matcher.feed(chunk);
		text += decoder.decode(result.output, { stream: true });
		detached ||= result.detached;
	}
	return { text, detached };
}

function splits(bytes: Uint8Array): Uint8Array[][] {
	const result: Uint8Array[][] = [];
	for (let cut = 0; cut <= bytes.length; cut++) result.push([bytes.subarray(0, cut), bytes.subarray(cut)]);
	return result;
}

describe("detach marker matcher", () => {
	const before = "frame \x1b[?1049l\x1b]0;title\x07 tail ünï";
	const stream = encoder.encode(`${before}${encodeDetachMarker(token)}output after detach`);

	it("strips the marker and drops later output wherever the stream is split", () => {
		for (const chunks of splits(stream)) expect(scan(chunks)).toEqual({ text: before, detached: true });
	});

	it("finds a marker delivered one byte at a time", () => {
		const bytes = Array.from(stream, byte => Uint8Array.of(byte));
		expect(scan(bytes)).toEqual({ text: before, detached: true });
	});

	it("passes another session's detach marker through as ordinary output", () => {
		const foreign = `a${encodeDetachMarker(otherToken)}b`;
		for (const chunks of splits(encoder.encode(foreign))) {
			expect(scan(chunks)).toEqual({ text: foreign, detached: false });
		}
	});

	it("releases a held marker prefix that turns out to be ordinary output", () => {
		// `ESC ] 7799` without the rest: another OSC, which must reach the viewer intact.
		const lookalike = encoder.encode("a\x1b]7799;other\x07b\x1b]77");
		for (const [head, tail] of splits(lookalike)) {
			const result = scan([head, tail, encoder.encode("x")]);
			expect(result).toEqual({ text: "a\x1b]7799;other\x07b\x1b]77x", detached: false });
		}
	});
});

describe("attach marker", () => {
	const viewer: ViewerIdentity = {
		env: { TERM: "xterm-ghostty", TERM_PROGRAM: "ghostty", LC_TERMINAL: "iTerm2", LC_TERMINAL_VERSION: "3.5.0" },
		multiplexer: "tmux",
		cols: 132,
		rows: 41,
	};

	it("round-trips the viewer identity through an APC free of control bytes", () => {
		const marker = encodeAttachMarker(token, viewer);
		expect(marker.startsWith(OMP_ATTACH_APC_PREFIX)).toBe(true);
		expect(marker.endsWith("\x1b\\")).toBe(true);
		const payload = marker.slice(OMP_ATTACH_APC_PREFIX.length, -2);
		expect(payload).not.toMatch(/[\x00-\x1f\x7f]/);
		expect(parseAttachPayload(payload, token)).toEqual(viewer);
	});

	it("ignores a marker carrying another token, or none", () => {
		const payload = encodeAttachMarker(otherToken, viewer).slice(OMP_ATTACH_APC_PREFIX.length, -2);
		expect(parseAttachPayload(payload, token)).toBeUndefined();
		const body = payload.slice(payload.indexOf(";") + 1);
		expect(parseAttachPayload(body, token)).toBeUndefined();
		expect(parseAttachPayload(`;${body}`, token)).toBeUndefined();
	});

	it("rejects payloads without a usable size and drops unknown or unusable identity variables", () => {
		const encode = (value: unknown) => `${token};${Buffer.from(JSON.stringify(value)).toString("base64")}`;
		expect(parseAttachPayload(`${token};not base64!`, token)).toBeUndefined();
		expect(parseAttachPayload(encode({ env: {}, cols: 0, rows: 24 }), token)).toBeUndefined();
		expect(parseAttachPayload(encode({ env: {}, cols: 80 }), token)).toBeUndefined();
		expect(
			parseAttachPayload(
				encode({
					env: { TERM: "evil\x1b]0;x\x07", TERM_PROGRAM: 7, PATH: "/evil", COLORTERM: "truecolor" },
					multiplexer: "Bad Mux!",
					cols: 80,
					rows: 24,
				}),
				token,
			),
		).toEqual({ env: { COLORTERM: "truecolor" }, cols: 80, rows: 24 });
	});

	it("captures only identity variables and the classified multiplexer of the viewer", () => {
		const identity = viewerIdentityFromEnv(
			{ TERM: "tmux-256color", TMUX: "/tmp/tmux-501/default,1,0", LC_TERMINAL: "iTerm2", PATH: "/usr/bin" },
			100,
			30,
		);
		expect(identity).toEqual({
			env: { TERM: "tmux-256color", LC_TERMINAL: "iTerm2" },
			multiplexer: "tmux",
			cols: 100,
			rows: 30,
		});
	});
});

describe("viewer environment replacement", () => {
	it("replaces identity variables, deletes stale ones and multiplexer sockets, keeps the rest", () => {
		const env: NodeJS.ProcessEnv = {
			PATH: "/usr/bin",
			TERM: "xterm-kitty",
			KITTY_WINDOW_ID: "3",
			TERM_PROGRAM: "WezTerm",
			LC_TERMINAL: "iTerm2",
			TMUX: "/tmp/tmux-501/default,1,0",
			ZELLIJ: "0",
		};
		applyViewerEnv(env, { env: { TERM: "xterm-256color", LC_TERMINAL: "iTerm2" }, cols: 80, rows: 24 });
		expect(env).toEqual({ PATH: "/usr/bin", TERM: "xterm-256color", LC_TERMINAL: "iTerm2" });
	});

	it("never writes multiplexer markers or a substitute TERM for a multiplexer viewer", () => {
		const env: NodeJS.ProcessEnv = { TMUX: "/tmp/tmux-501/default,1,0" };
		applyViewerEnv(env, { env: { TERM: "screen-256color" }, multiplexer: "tmux", cols: 80, rows: 24 });
		expect(env).toEqual({ TERM: "screen-256color" });
	});
});

describe("viewer multiplexer identity", () => {
	afterEach(() => setViewerTerminalMultiplexer(undefined));

	it("classifies the process environment as the viewer's multiplexer without its session markers", () => {
		setViewerTerminalMultiplexer("zellij");
		expect(classifyTerminalMultiplexer(Bun.env)).toBe("zellij");
		expect(isInsideTerminalMultiplexer()).toBe(true);
		// A tmux viewer whose TERM names screen is still tmux.
		setViewerTerminalMultiplexer("tmux");
		expect(classifyTerminalMultiplexer(Bun.env)).toBe("tmux");
	});

	it("answers for a direct viewer and leaves explicit environments alone", () => {
		setViewerTerminalMultiplexer(null);
		expect(terminalMultiplexerSessions(Bun.env)).toEqual([]);
		expect(classifyTerminalMultiplexer({ ZELLIJ: "0" })).toBe("zellij");
		setViewerTerminalMultiplexer("not-a-multiplexer");
		expect(terminalMultiplexerSessions(Bun.env)).toEqual([]);
	});
});

describe("hosted restart environment", () => {
	it("hands the verified unit key to the relaunched process and keeps the rest", () => {
		const key = "agent-00000000-0000-4000-8000-000000000000";
		expect(hostedRestartEnv({ PATH: "/usr/bin", UNSET: undefined }, key)).toEqual({
			PATH: "/usr/bin",
			[AGENT_INSTANCE_ENV]: key,
		});
	});

	it("adds nothing for a foreground process", () => {
		expect(hostedRestartEnv({ PATH: "/usr/bin", [AGENT_INSTANCE_ENV]: undefined }, undefined)).toEqual({
			PATH: "/usr/bin",
		});
	});
});

describe("hosted environment filter", () => {
	it("drops terminal, multiplexer and remote-login bound variables and keeps the rest", () => {
		const env = filterHostedEnv({
			PATH: "/usr/bin",
			HOME: "/home/u",
			TERM: "xterm-256color",
			LANG: "en_US.UTF-8",
			ANTHROPIC_API_KEY: "sk-test",
			OMP_PROFILE: "work",
			SSH_AUTH_SOCK: "/tmp/agent",
			SSH_CONNECTION: "1 2 3 4",
			TMUX: "/tmp/tmux,1,0",
			TMUX_PANE: "%1",
			STY: "123.pts",
			ZELLIJ: "0",
			WINDOWID: "42",
			TERM_SESSION_ID: "w0t0p0",
			ITERM_SESSION_ID: "w0t0p0:abc",
			KITTY_WINDOW_ID: "1",
			KITTY_PID: "99",
			VSCODE_IPC_HOOK_CLI: "/tmp/vscode.sock",
			WT_SESSION: "guid",
			[AGENT_INSTANCE_ENV]: "agent-stale",
			UNSET: undefined,
		});
		expect(env).toEqual({
			PATH: "/usr/bin",
			HOME: "/home/u",
			TERM: "xterm-256color",
			LANG: "en_US.UTF-8",
			ANTHROPIC_API_KEY: "sk-test",
			OMP_PROFILE: "work",
		});
	});
});
