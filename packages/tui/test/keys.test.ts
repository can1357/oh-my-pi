import { describe, expect, it } from "bun:test";
import {
	extractPrintableText,
	isWindowsTerminalSession,
	matchesKey,
	matchesRawBackspace,
	parseKey,
	setKittyProtocolActive,
} from "@oh-my-pi/pi-tui/keys";

describe("matchesKey", () => {
	it("matches ctrl+letter sequences", () => {
		setKittyProtocolActive(false);
		const ctrlC = String.fromCharCode(3);
		expect(matchesKey(ctrlC, "ctrl+c")).toBe(true);
	});

	it("matches shifted tab", () => {
		setKittyProtocolActive(false);
		expect(matchesKey("\x1b[Z", "shift+tab")).toBe(true);
	});

	it("matches pageUp legacy sequence with mixed case keyId", () => {
		setKittyProtocolActive(false);
		expect(matchesKey("\x1b[5~", "pageUp")).toBe(true);
	});

	it("matches legacy Alt+letter pairs in enhanced keyboard mixed mode", () => {
		setKittyProtocolActive(true);
		expect(matchesKey("\x1bp", "alt+p")).toBe(true);
		expect(matchesKey("\x1bh", "alt+h")).toBe(true);
		expect(matchesKey("\x1bP", "alt+shift+p")).toBe(true);
		expect(matchesKey("\x1bp", "alt+shift+p")).toBe(false);
		expect(matchesKey("\x1b[1;3A", "alt+up")).toBe(true);
		expect(matchesKey("\x1bp", "alt+up")).toBe(false);
		expect(matchesKey("\x1bn", "alt+down")).toBe(false);
		expect(matchesKey("\x1bb", "alt+left")).toBe(false);
		expect(matchesKey("\x1bf", "alt+right")).toBe(false);
		setKittyProtocolActive(false);
	});

	it("should prefer codepoint for Latin letters even when base layout differs", () => {
		setKittyProtocolActive(true);
		// Dvorak Ctrl+K reports codepoint 'k' (107) and base layout 'v' (118)
		const dvorakCtrlK = "\x1b[107::118;5u";
		expect(matchesKey(dvorakCtrlK, "ctrl+k")).toBe(true);
		expect(matchesKey(dvorakCtrlK, "ctrl+v")).toBe(false);
		setKittyProtocolActive(false);
	});

	it("should prefer codepoint for symbol keys even when base layout differs", () => {
		setKittyProtocolActive(true);
		// Dvorak Ctrl+/ reports codepoint '/' (47) and base layout '[' (91)
		const dvorakCtrlSlash = "\x1b[47::91;5u";
		expect(matchesKey(dvorakCtrlSlash, "ctrl+/")).toBe(true);
		expect(matchesKey(dvorakCtrlSlash, "ctrl+[")).toBe(false);
		setKittyProtocolActive(false);
	});

	it("matches non-Latin shortcuts by their base-layout key", () => {
		setKittyProtocolActive(true);
		try {
			expect(matchesKey("\x1b[1089::99;5u", "ctrl+c")).toBe(true);
			expect(matchesKey("\x1b[1079::112;5u", "ctrl+p")).toBe(true);
			expect(matchesKey("\x1b[1057::99;6u", "ctrl+shift+c")).toBe(true);
		} finally {
			setKittyProtocolActive(false);
		}
	});
	it("ignores Kitty release events while still matching repeats", () => {
		setKittyProtocolActive(true);
		expect(matchesKey("\x1b[127u", "backspace")).toBe(true);
		expect(matchesKey("\x1b[127;1:2u", "backspace")).toBe(true);
		expect(matchesKey("\x1b[127;1:3u", "backspace")).toBe(false);
		setKittyProtocolActive(false);
	});

	it("keeps keypad digits as text with or without NumLock modifier", () => {
		setKittyProtocolActive(true);
		for (const data of ["\x1b[57400u", "\x1b[57400;129u"]) {
			expect(matchesKey(data, "1")).toBe(true);
			expect(matchesKey(data, "end")).toBe(false);
		}
		expect(matchesKey("\x1b[57404u", "5")).toBe(true);
		expect(matchesKey("\x1b[57404u", "clear")).toBe(false);
		setKittyProtocolActive(false);
	});

	it("defers CSI-u/modifyOtherKeys named keys to native normalization", () => {
		// Regression: the keypad text fast path must not short-circuit canonical
		// named keys that decode to a printable codepoint (space, shifted letters).
		setKittyProtocolActive(true);
		expect(matchesKey("\x1b[32u", "space")).toBe(true);
		expect(matchesKey("\x1b[97:65;2u", "shift+a")).toBe(true);
		setKittyProtocolActive(false);
	});

	it("matches keypad operators as their printable symbols", () => {
		setKittyProtocolActive(true);
		expect(matchesKey("\x1b[57410u", "/")).toBe(true);
		expect(matchesKey("\x1b[57413;5u", "ctrl++")).toBe(true);
		setKittyProtocolActive(false);
	});

	it("preserves keypad navigation matches when NumLock is on but modifiers are held", () => {
		setKittyProtocolActive(true);
		expect(matchesKey("\x1b[57400;133u", "ctrl+end")).toBe(true);
		expect(matchesKey("\x1b[57400;133u", "1")).toBe(false);
		setKittyProtocolActive(false);
	});

	it("recognises super+alt+backspace from Ghostty's default Option+Backspace wire (#2064)", () => {
		setKittyProtocolActive(true);
		// Modifier 11 (wire) = 10 (mask) = super(8)|alt(2). Ghostty's keyboard
		// inspector on macOS reports `ESC [127;11u` for Option+Backspace without
		// any user-defined keybind.
		expect(matchesKey("\x1b[127;11u", "super+alt+backspace")).toBe(true);
		expect(matchesKey("\x1b[127;11u", "alt+super+backspace")).toBe(true);
		// Plain alt+backspace must NOT consume this — the modifier truly is super|alt.
		expect(matchesKey("\x1b[127;11u", "alt+backspace")).toBe(false);
		expect(matchesKey("\x1b[127;11u", "backspace")).toBe(false);
		setKittyProtocolActive(false);
	});
});

describe("parseKey", () => {
	it("parses legacy Alt+letter pairs in enhanced keyboard mixed mode", () => {
		setKittyProtocolActive(true);
		expect(parseKey("\x1bp")).toBe("alt+p");
		expect(parseKey("\x1bh")).toBe("alt+h");
		expect(parseKey("\x1bP")).toBe("alt+shift+p");
		expect(parseKey("\x1b[1;3A")).toBe("alt+up");
		setKittyProtocolActive(false);
	});

	it("should prefer codepoint for Latin letters when base layout differs", () => {
		setKittyProtocolActive(true);
		const dvorakCtrlK = "\x1b[107::118;5u";
		expect(parseKey(dvorakCtrlK)).toBe("ctrl+k");
		setKittyProtocolActive(false);
	});

	it("ignores Kitty release events while still parsing repeats", () => {
		setKittyProtocolActive(true);
		expect(parseKey("\x1b[127u")).toBe("backspace");
		expect(parseKey("\x1b[127;1:2u")).toBe("backspace");
		expect(parseKey("\x1b[127;1:3u")).toBeUndefined();
		setKittyProtocolActive(false);
	});

	it("should prefer codepoint for symbol keys when base layout differs", () => {
		setKittyProtocolActive(true);
		const dvorakCtrlSlash = "\x1b[47::91;5u";
		expect(parseKey(dvorakCtrlSlash)).toBe("ctrl+/");
		setKittyProtocolActive(false);
	});

	it("parses keypad digits as digits with or without NumLock modifier", () => {
		setKittyProtocolActive(true);
		expect(parseKey("\x1b[57400u")).toBe("1");
		expect(parseKey("\x1b[57400;129u")).toBe("1");
		expect(parseKey("\x1b[57404u")).toBe("5");
		setKittyProtocolActive(false);
	});

	it("normalizes CSI-u/modifyOtherKeys named keys instead of returning raw printables", () => {
		// Regression: space/backspace encoded via CSI-u or modifyOtherKeys must
		// resolve to their canonical identifiers, not literal " "/DEL bytes.
		setKittyProtocolActive(true);
		expect(parseKey("\x1b[32u")).toBe("space");
		expect(parseKey("\x1b[27;1;32~")).toBe("space");
		expect(parseKey("\x1b[27;1;127~")).toBe("backspace");
		setKittyProtocolActive(false);
	});

	it("parses keypad operators as printable keys", () => {
		setKittyProtocolActive(true);
		expect(parseKey("\x1b[57410u")).toBe("/");
		expect(parseKey("\x1b[57413;5u")).toBe("ctrl++");
		setKittyProtocolActive(false);
	});

	it("parses modified NumLock keypad navigation keys consistently", () => {
		setKittyProtocolActive(true);
		expect(parseKey("\x1b[57400;133u")).toBe("ctrl+end");
		setKittyProtocolActive(false);
	});

	it("ignores Kitty sequences with unsupported modifiers", () => {
		setKittyProtocolActive(true);
		// Hyper (16) and meta (32) bits aren't surfaced because nothing binds them.
		expect(parseKey("\x1b[99;17u")).toBeUndefined(); // hyper-only
		expect(parseKey("\x1b[99;33u")).toBeUndefined(); // meta-only
		setKittyProtocolActive(false);
	});
});

describe("Raw 0x08 backspace disambiguation", () => {
	const envKeys = [
		"WT_SESSION",
		"SSH_CONNECTION",
		"SSH_CLIENT",
		"SSH_TTY",
		"PI_TUI_RAW_BACKSPACE_IS_CTRL",
		"TMUX",
		"STY",
		"ZELLIJ",
		"HERDR_ENV",
		"HERDR_PANE_ID",
		"HERDR_TAB_ID",
		"HERDR_WORKSPACE_ID",
		"TERM",
		"CMUX_WORKSPACE_ID",
		"CMUX_SURFACE_ID",
		"CMUX_REMOTE_TRANSPORT",
	] as const;
	function withEnv(overrides: Partial<Record<(typeof envKeys)[number], string>>, run: () => void): void {
		const saved: Record<string, string | undefined> = {};
		for (const key of envKeys) {
			saved[key] = process.env[key];
			delete process.env[key];
		}
		for (const key in overrides) process.env[key] = overrides[key as (typeof envKeys)[number]];
		try {
			run();
		} finally {
			for (const key of envKeys) {
				const value = saved[key];
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
		}
	}

	it("maps raw 0x08 to ctrl+backspace only in a genuine Windows Terminal session", () => {
		// Windows Terminal sends 0x08 for Ctrl+Backspace; the native parser reports
		// plain `backspace` because it cannot see the environment.
		withEnv({ WT_SESSION: "1" }, () => {
			expect(isWindowsTerminalSession()).toBe(true);
			expect(matchesRawBackspace("\x08", 4)).toBe(true);
			expect(matchesRawBackspace("\x08", 0)).toBe(false);
			expect(parseKey("\x08")).toBe("ctrl+backspace");
			expect(matchesKey("\x08", "ctrl+backspace")).toBe(true);
			expect(matchesKey("\x08", "backspace")).toBe(false);
		});
		// Outside Windows Terminal 0x08 stays plain backspace.
		withEnv({}, () => {
			expect(isWindowsTerminalSession()).toBe(false);
			expect(matchesRawBackspace("\x08", 0)).toBe(true);
			expect(matchesRawBackspace("\x08", 4)).toBe(false);
			expect(parseKey("\x08")).toBe("backspace");
			expect(matchesKey("\x08", "backspace")).toBe(true);
			expect(matchesKey("\x08", "ctrl+backspace")).toBe(false);
		});
	});

	it("does not apply the heuristic when WT_SESSION is forwarded over SSH", () => {
		withEnv({ WT_SESSION: "1", SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22" }, () => {
			expect(isWindowsTerminalSession()).toBe(false);
			expect(parseKey("\x08")).toBe("backspace");
		});
	});

	it("does not apply the heuristic inside a multiplexer that inherited WT_SESSION", () => {
		// tmux/screen/Zellij inherit WT_SESSION from the launching shell but emit
		// raw 0x08 for plain Backspace themselves, so the automatic heuristic
		// must stay off there (#6784 review).
		const multiplexers: Array<Partial<Record<(typeof envKeys)[number], string>>> = [
			{ WT_SESSION: "1", TMUX: "/tmp/tmux-1000/default,1,0" },
			{ WT_SESSION: "1", STY: "1234.pts-0" },
			{ WT_SESSION: "1", ZELLIJ: "0" },
			{ WT_SESSION: "1", TERM: "tmux-256color" },
			{ WT_SESSION: "1", TERM: "screen-256color" },
		];
		for (const env of multiplexers) {
			withEnv(env, () => {
				expect(matchesRawBackspace("\x08", 0)).toBe(true);
				expect(matchesRawBackspace("\x08", 4)).toBe(false);
				expect(parseKey("\x08")).toBe("backspace");
			});
		}
		// The explicit opt-in still wins inside a multiplexer.
		withEnv({ WT_SESSION: "1", TMUX: "/tmp/tmux-1000/default,1,0", PI_TUI_RAW_BACKSPACE_IS_CTRL: "1" }, () => {
			expect(matchesRawBackspace("\x08", 4)).toBe(true);
			expect(matchesRawBackspace("\x08", 0)).toBe(false);
			expect(parseKey("\x08")).toBe("ctrl+backspace");
		});
	});

	it("supports an explicit opt-in when remote/container sessions lose terminal identity", () => {
		withEnv(
			{
				PI_TUI_RAW_BACKSPACE_IS_CTRL: "1",
				SSH_CONNECTION: "1.2.3.4 5 6.7.8.9 22",
			},
			() => {
				expect(isWindowsTerminalSession()).toBe(false);
				expect(matchesRawBackspace("\x08", 4)).toBe(true);
				expect(matchesRawBackspace("\x08", 0)).toBe(false);
				expect(parseKey("\x08")).toBe("ctrl+backspace");
				expect(matchesKey("\x08", "ctrl+backspace")).toBe(true);
			},
		);
	});

	it("leaves 0x7f as plain backspace regardless of Windows Terminal or opt-in", () => {
		withEnv({ WT_SESSION: "1", PI_TUI_RAW_BACKSPACE_IS_CTRL: "1" }, () => {
			expect(matchesRawBackspace("\x7f", 0)).toBe(true);
			expect(matchesRawBackspace("\x7f", 4)).toBe(false);
			expect(parseKey("\x7f")).toBe("backspace");
			expect(matchesKey("\x7f", "backspace")).toBe(true);
			expect(matchesKey("\x7f", "ctrl+backspace")).toBe(false);
		});
	});
});

describe("extractPrintableText", () => {
	it("extracts keypad digits from Kitty CSI-u sequences", () => {
		expect(extractPrintableText("\x1b[57407u")).toBe("8");
		expect(extractPrintableText("\x1b[57407;129u")).toBe("8");
		expect(extractPrintableText("\x1b[57404u")).toBe("5");
	});

	it("extracts keypad operators from Kitty CSI-u sequences", () => {
		expect(extractPrintableText("\x1b[57410u")).toBe("/");
		expect(extractPrintableText("\x1b[57413u")).toBe("+");
	});

	it("does not treat modified NumLock keypad navigation keys as text", () => {
		expect(extractPrintableText("\x1b[57400;133u")).toBeUndefined();
	});

	it("does not extract DEL from modifyOtherKeys sequences as text", () => {
		expect(extractPrintableText("\x1b[27;1;127~")).toBeUndefined();
	});

	it("ignores unsupported modifiers on Kitty CSI-u text", () => {
		expect(extractPrintableText("\x1b[99;9u")).toBeUndefined();
		expect(extractPrintableText("\x1b[97;9;229u")).toBeUndefined();
	});

	it("preserves Kitty CSI-u text-field decoding for supported modifiers", () => {
		expect(extractPrintableText("\x1b[97;1;229u")).toBe("å");
	});
});
