/** @jsxImportSource @oh-my-pi/pi-tui */
import { signal } from "@oh-my-pi/pi-tui";
import { loadThemeSync } from "@oh-my-pi/pi-tui/theme/loader";
import { type SessionContextUsage, SessionInfo } from "../../../../src/ui/overlays/panels/session-info";
import { panelSuite } from "./harness";

const theme = loadThemeSync("dark");
const kv = (k: string, v: string) => `${theme.fg("dim", `${k}:`)} ${v}`;
const bold = (text: string) => theme.style("strong", text);
const REPORT = [
	kv("ID", "0193-abcd-ef"),
	kv("File", "/home/u/.omp/sessions/2026/very-long-session-file-name-ünïcödé.jsonl"),
	kv("Local", "local://sessions/abc"),
	kv("Note", "something"),
	"a free line",
	"",
	bold("Messages"),
	kv("User", "12"),
	kv("Assistant", "14"),
	kv("Tool Calls", "40"),
	kv("Total", "66"),
	kv("Append-Only", "on"),
	"",
	bold("Tokens"),
	kv("Input", "182,440"),
	kv("Output", "21,000"),
	kv("Total", "203,440"),
	"",
	bold("Cost"),
	kv("Input", "0.4127"),
	kv("Total", "1.20"),
	"",
	bold("Provider"),
	kv("Model", "anthropic/claude"),
	kv("API Mode", "messages"),
	"",
	bold("MCP Servers"),
	kv("github", `${theme.fg("success", "connected")} 12 tools`),
	"broken line without colon",
	kv("linear", "failed"),
].join("\n");
const CONTEXT: SessionContextUsage = { tokens: 41_000, contextWindow: 200_000, percent: 20.5 };

const CASES: Record<string, [rows: number, report: string, context?: SessionContextUsage]> = {
	"full-report-tall": [60, REPORT, CONTEXT],
	"full-report-short": [10, REPORT, CONTEXT],
	"no-context": [8, REPORT],
	plain: [12, "File: /tmp/session.jsonl\nProvider: openai\nTokens: 42"],
	"zero-window-file-w-o-slash-empty": [3, `${kv("File", "memory")}\n\n`, { tokens: 1, contextWindow: 0, percent: 0 }],
	empty: [5, ""],
	"no-lead": [20, `${bold("Tokens")}\n${kv("In", "5")}`, CONTEXT],
};

panelSuite({
	dir: "overlays/session-info",
	mount(caseName) {
		const [rows, report, context] = CASES[caseName]!;
		return {
			view: () => (
				<SessionInfo report={report} theme={theme} context={context} rows={signal(rows)} onClose={() => {}} />
			),
			steps: {
				"close action": d => void d.emit({ type: "action", key: "", act: "close", mods: [] }),
				"ignore tight": () => {},
			},
		};
	},
});
