import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { heapStats } from "bun:jsc";
import { Settings } from "../src/config/settings";
import { AssistantMessageComponent } from "../src/modes/components/assistant-message";
import { initTheme } from "../src/modes/theme/theme";

const steps = Number(process.argv[2] ?? 500);
if (!Number.isSafeInteger(steps) || steps <= 0) throw new Error("Expected a positive publication count");
await initTheme(false);
await Settings.init({ inMemory: true });

function stream(count: number): AssistantMessageComponent {
	const component = new AssistantMessageComponent();
	const message: AssistantMessage = {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "benchmark",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
	};
	let thinking = "";
	for (let step = 0; step < count; step++) {
		thinking += `Paragraph ${step}: consider **correctness**, memory use, and terminal replay before selecting an implementation.\n\n`;
		component.updateContent(
			{ ...message, content: [{ type: "thinking", thinking: `${thinking}Pending paragraph` }] },
			{ transient: true },
		);
		component.render(100);
	}
	return component;
}

stream(20);
Bun.gc(true);
const before = heapStats().heapSize;
const started = performance.now();
const cpuStarted = process.cpuUsage();
const component = stream(steps);
const elapsedMs = performance.now() - started;
const cpu = process.cpuUsage(cpuStarted);
const cpuMs = (cpu.user + cpu.system) / 1000;
Bun.gc(true);
const retainedBytes = heapStats().heapSize - before;
const publications = component.getTranscriptStableRows().length;
const identityBytes = component.getTranscriptStableRows().reduce((total, row) => total + row.key.length * 2, 0);
const replayStarted = performance.now();
const replayRows = component.renderTranscriptStableRows(publications, 50).length;
const replayMs = performance.now() - replayStarted;
console.log(
	JSON.stringify({ steps, publications, retainedBytes, identityBytes, elapsedMs, cpuMs, replayRows, replayMs }),
);
