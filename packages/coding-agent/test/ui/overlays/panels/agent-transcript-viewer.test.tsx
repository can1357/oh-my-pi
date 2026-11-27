/** @jsxImportSource @oh-my-pi/pi-tui */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentTranscriptViewer } from "../../../../src/ui/overlays/panels/agent-transcript-viewer";
import {
	AgentTranscriptViewerModel,
	type ViewerAgentRef,
	type ViewerProgress,
} from "../../../../src/ui/overlays/panels/agent-transcript-viewer-model";
import { type Driver, type Mounted, panelSuite } from "./harness";

process.env.TZ = "UTC";

const TS = new Date(0).toISOString();
const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const user = (id: string, content: string) =>
	JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp: TS,
		message: { role: "user", content, timestamp: 0 },
	});
const assistant = (id: string, text: string) =>
	JSON.stringify({
		type: "message",
		id,
		parentId: null,
		timestamp: TS,
		message: {
			role: "assistant",
			content: [{ type: "text", text }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "gpt-5.5",
			usage,
			stopReason: "stop",
			timestamp: 1,
		},
	});

const transcript = {
	stat: (file: string) => fs.statSync(file),
	readFrom: async (file: string, offset: number) =>
		(await fs.promises.readFile(file)).subarray(offset).toString("utf-8"),
	parseEntries: (text: string) =>
		text
			.split("\n")
			.filter(Boolean)
			.map(line => JSON.parse(line))
			.filter((entry: { type: string }) => entry.type === "message" || entry.type === "model_change"),
};

// The recording opened its transcripts after their directory was removed: the local files are missing.
const missing = path.join(os.tmpdir(), `atv-missing-${process.pid}`, "long.jsonl");

interface Fixture {
	ref: (ViewerAgentRef & { status: ViewerAgentRef["status"] }) | undefined;
	progress: ViewerProgress | undefined;
	remote?: boolean;
	lifecycle?: boolean;
}

const progress = { contextTokens: 50_000, contextWindow: 200_000, durationMs: 65_000, toolCount: 7, cost: 0.4321 };
const FIXTURES: Record<string, () => Fixture> = {
	"local-long": () => ({
		ref: { kind: "task", status: "running", parentId: "Main", sessionFile: missing },
		progress: { ...progress },
		lifecycle: true,
	}),
	"advisor-read-only-empty": () => ({
		ref: { kind: "advisor", status: "parked", sessionFile: missing },
		progress: undefined,
	}),
	"missing-file-no-ref": () => ({ ref: undefined, progress: undefined }),
	remote: () => ({ ref: { kind: "task", status: "aborted" }, progress: { ...progress }, remote: true }),
};

function mount(fixture: Fixture): Mounted {
	let reads = 0;
	const model = new AgentTranscriptViewerModel({
		agentId: "Main/worker",
		transcript,
		registry: { get: () => fixture.ref },
		observers: { getSession: () => (fixture.progress ? { progress: fixture.progress } : undefined) },
		lifecycle: fixture.lifecycle
			? () => ({
					ensureLive: async () => {
						throw new Error("cannot revive: 日本語 failure\nsecond line");
					},
				})
			: undefined,
		remote: fixture.remote
			? {
					chat: () => {},
					kill: () => {},
					revive: () => {},
					readTranscript: async () =>
						reads++ === 0
							? { text: `${user("r0", "remote hello")}\n${assistant("r1", "remote reply")}\n`, newSize: 10 }
							: { text: "", newSize: 10, error: "host transcript read failed" },
				}
			: undefined,
		terminalRows: () => 24,
		expandKeys: ["ctrl+o"],
		hubKeys: ["ctrl+s"],
		onClose: () => {},
		onHubClose: () => {},
		// The recording saw no poll between its stages.
		pollMs: 3_600_000,
	});
	const poll = (change: () => void) => () => {
		change();
		model.poll();
	};
	const type = (keys: string[]) => async (driver: Driver) => {
		for (const key of keys) driver.press(key);
		await Bun.sleep(5);
	};
	return {
		view: () => <AgentTranscriptViewer model={model} />,
		ready: Bun.sleep(1),
		focus: driver => driver.find("editor") ?? driver.root,
		steps: {
			"status idle": poll(() => (fixture.ref!.status = "idle")),
			"progress no window": poll(
				() => (fixture.progress = { contextTokens: 900, durationMs: 0, toolCount: 0, cost: 0 }),
			),
			"progress empty": poll(() => (fixture.progress = { durationMs: 0, toolCount: 0, cost: 0 })),
			"type + submit": type(fixture.remote ? ["q", "\r"] : ["y", "o", "\r"]),
			"native close (draft empty)": driver => void driver.emit({ type: "action", key: "", act: "close", mods: [] }),
			"remote loaded": () => Bun.sleep(5),
			"poll error": () => Bun.sleep(5),
		},
		dispose: () => model.dispose(),
	};
}

panelSuite({
	dir: "overlays/agent-transcript-viewer",
	mount(caseName) {
		const fixture = FIXTURES[caseName];
		if (!fixture) throw new Error(`unknown case ${caseName}`);
		return mount(fixture());
	},
});
