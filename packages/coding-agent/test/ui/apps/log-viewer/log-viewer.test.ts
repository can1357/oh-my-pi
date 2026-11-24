import { LogViewer, LogViewerModel } from "../../../../src/ui/apps/log-viewer";
import { type AppDriver, type AppScreen, appSuite } from "../harness";
import { click, mouse } from "../raw-sse/mouse";

process.env.TZ = "UTC";

const LOG_START = Date.parse("2026-01-01T12:00:00Z");
const LEVELS = ["info", "warn", "error", "debug"];
const logEntry = (i: number, offsetMin: number) =>
	JSON.stringify({
		timestamp: new Date(LOG_START + offsetMin * 60_000).toISOString(),
		level: LEVELS[i % 4],
		pid: i % 5 === 0 ? 1111 : 4242,
		message: i % 3 === 0 ? `request ${i} 日本語 ${"long ".repeat(30)}` : `message ${i}`,
		fields: { i, nested: { ok: i % 2 === 0 } },
	});
const logLines = (n: number) => Array.from({ length: n }, (_, i) => logEntry(i, i - Math.floor(n / 2)));
const OLDER_LOGS = Array.from({ length: 7 }, (_, i) => logEntry(100 + i, -500 + i));

/** Let pending loads finish (the capture waited two timer ticks per key). */
const settle = async () => {
	for (let i = 0; i < 4; i++) await Bun.sleep(1);
};
const keys =
	(...raw: string[]) =>
	async (d: AppDriver) => {
		for (const r of raw) {
			d.press(r);
			await settle();
		}
	};
const emit = (event: Record<string, unknown>) => async (d: AppDriver) => {
	d.emit({ key: "", mods: [], ...event } as never);
	await settle();
};

const CASES: Record<string, { n: number; older?: boolean; failCopy?: boolean; failOlder?: boolean }> = {
	"recent-logs-with-older-history": { n: 12, older: true },
	empty: { n: 0 },
	"copy-and-load-failures": { n: 5, older: true, failCopy: true, failOlder: true },
};

const screen: AppScreen = {
	dir: "apps/log-viewer",
	mount(caseName) {
		const opts = CASES[caseName]!;
		let olderLeft = opts.older ? 2 : 0;
		const model = new LogViewerModel({
			logs: logLines(opts.n).join("\n"),
			terminalRows: 24,
			processStartMs: LOG_START,
			processPid: 4242,
			onExit: () => {},
			deps: {
				copyToClipboard: () => {
					if (opts.failCopy) throw new Error("no clipboard");
				},
				hasOlderLogs: () => olderLeft > 0,
				loadOlderLogs: async () => {
					if (opts.failOlder) throw new Error("disk gone");
					olderLeft--;
					return OLDER_LOGS.join("\n");
				},
			},
		});
		return {
			view: () => LogViewer({ model }),
			steps: {
				down: keys("\x1b[B"),
				up: keys("\x1b[A"),
				"right expands": keys("\x1b[C"),
				"shift+up extends selection": keys("\x1b[1;2A"),
				"shift+down": keys("\x1b[1;2B"),
				"left collapses": keys("\x1b[D"),
				"ctrl+a selects all": keys("\x01"),
				"ctrl+c copies": keys("\x03"),
				"ctrl+p toggles pid filter": keys("\x10"),
				"page up": keys("\x1b[5~"),
				home: keys("\x1b[H"),
				"ctrl+o loads older": keys("\x0f"),
				"up twice onto older": keys("\x1b[A", "\x1b[A"),
				enter: keys("\r"),
				end: keys("\x1b[F"),
				"page down": keys("\x1b[6~"),
				"filter r": keys("r"),
				"filter re": keys("e"),
				"filter req": keys("q"),
				"filter no match": keys("z", "z"),
				"backspace twice": keys("\x7f", "\x7f"),
				"wheel up": d => mouse(d, "\x1b[<64;10;8M"),
				"click row": d => mouse(d, ...click(5, 4)),
				"click row again": d => mouse(d, ...click(5, 4)),
				"native select l2": emit({ type: "select", item: "l2" }),
				"native activate l3": emit({ type: "activate", item: "l3" }),
				"native action all": emit({ type: "action", act: "all" }),
				"native action pid": emit({ type: "action", act: "pid" }),
				"native action older": emit({ type: "action", act: "older" }),
				"native action copy": emit({ type: "action", act: "copy" }),
				"native activate older row": emit({ type: "activate", item: "older" }),
			},
		};
	},
};

appSuite(screen);
