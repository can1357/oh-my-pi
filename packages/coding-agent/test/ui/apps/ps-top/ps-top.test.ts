import { expect, setSystemTime, test } from "bun:test";
import { staticEnvironment } from "@oh-my-pi/pi-tui/term/paint";
import { CORPUS_NOW } from "@oh-my-pi/pi-tui/testing/corpus";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import type { PsBoard } from "../../../../src/cli/ps-model";
import type { ProcSpec, UnitScope, UnitSnapshot } from "../../../../src/daemon/daemon-types";
import type { PsTopHost } from "../../../../src/modes/view-model/apps/ps-top";
import { PsTop, PsTopModel } from "../../../../src/ui/apps/ps-top";
import { type AppDriver, appSuite, paintAppRows } from "../harness";

setSystemTime(new Date(CORPUS_NOW));

const PROJECT: UnitScope = { kind: "project", dir: "/work/app" } as UnitScope;
const GLOBAL: UnitScope = { kind: "global" } as UnitScope;

function unit(
	key: string,
	scope: UnitScope,
	state: UnitSnapshot["state"] = "running",
	extra: Partial<UnitSnapshot> = {},
) {
	return {
		id: `u-${key}`,
		kind: "proc",
		scope,
		key,
		label: key,
		generation: "g1",
		state,
		pids: state === "running" ? [100] : [],
		createdAt: 0,
		startedAt: CORPUS_NOW - 65_000,
		restartCount: key === "web" ? 2 : 0,
		outputBytes: 0,
		leases: 1,
		policy: { hold: "leases", idleMs: 0, onIdle: "stop", restart: "no", survive: "exec" },
		command: `run ${key} --flag ${"x".repeat(30)}`,
		cwd: "/work/app",
		supervised: true,
		...extra,
	} as UnitSnapshot;
}

interface Opts {
	empty?: boolean;
	failLogs?: boolean;
	failAct?: boolean;
	noDaemon?: boolean;
	rows: number;
}

function board(opts: Opts, all: boolean): PsBoard {
	return {
		daemon: opts.noDaemon ? undefined : { pid: 42, build: "test", startedAt: 0 },
		reports: opts.empty
			? []
			: [
					{
						scope: PROJECT,
						units: [
							unit("api", PROJECT),
							unit("web", PROJECT),
							unit("job", PROJECT, "exited", { exitCode: 143, exitReason: "signal" }),
						],
					},
					all ? { scope: GLOBAL, units: [] } : { scope: GLOBAL, units: [unit("tern", GLOBAL)] },
				],
	} as PsBoard;
}

function host(opts: Opts): PsTopHost {
	return {
		collectBoard: async all => board(opts, all),
		watch: () => () => {},
		act: async current => {
			if (opts.failAct) throw new Error("daemon refused");
			return current;
		},
		describe: async current => {
			const proc = {
				application: "run",
				args: [current.key],
				env: {},
				cwd: "/work/app",
				pty: current.key === "web",
			} as ProcSpec;
			return { unit: current, proc };
		},
		logs: async () => {
			if (opts.failLogs) throw new Error("no logs");
			return { text: "line 1\nline 2 日本語\n", terminalOutput: "", state: "running" };
		},
		close: () => {},
	};
}

test("the process board paints ASCII selection and info shortcuts", () => {
	const env = staticEnvironment(loadThemeSync("dark", { symbolPreset: "ascii" }));
	const opts = { rows: 24 };
	const model = new PsTopModel(host(opts), { all: false, rows: () => opts.rows, onQuit: () => {} });
	model.board.set(board(opts, false));
	try {
		const rows = paintAppRows(() => PsTop({ model }), env, 130);
		expect(rows.find(row => row.includes("all scopes"))).toContain("Up/Down select · Enter info");
	} finally {
		model.dispose();
	}
});

const CASES: Record<string, Opts> = {
	board: { rows: 24 },
	"empty-no-daemon": { empty: true, noDaemon: true, rows: 24 },
	"failures-short-terminal": { failLogs: true, failAct: true, rows: 8 },
};

const settle = async () => {
	for (let i = 0; i < 8; i++) await Bun.sleep(1);
};
const key = (raw: string) => async (d: AppDriver) => {
	d.press(raw);
	await settle();
};
const emit = (event: Record<string, unknown>) => async (d: AppDriver) => {
	d.emit({ key: "", mods: [], ...event } as never);
	await settle();
};

appSuite({
	dir: "apps/ps-top",
	mount(caseName) {
		const opts = CASES[caseName]!;
		const model = new PsTopModel(host(opts), { all: false, rows: () => opts.rows, onQuit: () => {} });
		return {
			view: () => PsTop({ model }),
			steps: {
				"run (first board loaded)": async () => {
					model.run();
					await settle();
				},
				j: key("j"),
				down: key("\x1b[B"),
				k: key("k"),
				"native kill asks": emit({ type: "action", act: "kill" }),
				"native kill cancel": emit({ type: "action", act: "kill-cancel" }),
				"native kill asks again": emit({ type: "action", act: "kill" }),
				"native kill confirm": emit({ type: "action", act: "kill-confirm" }),
				"s stops": key("s"),
				"r restarts": key("r"),
				"x kills": key("x"),
				"native select u-web": emit({ type: "select", item: "u-web" }),
				"a shows all scopes": key("a"),
				"native scope current": emit({ type: "select", item: "current" }),
				"enter opens info": key("\r"),
				"q back to table": key("q"),
				"native activate u-api (info)": emit({ type: "activate", item: "u-api" }),
				"native logs": emit({ type: "action", act: "logs" }),
				"native back": emit({ type: "action", act: "back" }),
				"l opens logs": key("l"),
				"esc back": key("\x1b"),
				"native info": emit({ type: "action", act: "info" }),
				"esc back again": key("\x1b"),
				"native stop": emit({ type: "action", act: "stop" }),
			},
			dispose: () => model.dispose(),
		};
	},
});
