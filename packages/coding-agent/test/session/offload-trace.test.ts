import { describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@pk-nerdsaver-ai/pi-agent-core";
import { ArtifactManager } from "../../src/session/artifacts";
import {
	buildOffloadTraceCanvas,
	getPreservedOffloadTrace,
	type OffloadTraceCanvas,
	renderOffloadTraceCanvasMarkdown,
} from "../../src/session/offload-trace";
import { summaryWithPreservedOffloadTrace } from "../../src/session/session-context";

function canvasWithRefs(): OffloadTraceCanvas {
	return {
		version: 1,
		nodes: [
			{
				id: "summary",
				kind: "summary",
				title: "Summary",
				summary: "compact summary",
				status: "unresolved",
				createdAt: "2026-01-01T00:00:00.000Z",
			},
			{
				id: "raw",
				kind: "artifact",
				title: "Raw evidence",
				summary: "raw summary",
				status: "resolved",
				artifactId: "7",
				createdAt: "2026-01-01T00:00:00.000Z",
			},
			{
				id: "wiki",
				kind: "wiki",
				title: "Wiki fact",
				summary: "wiki summary",
				status: "resolved",
				wikigraphNodeId: "abc",
				createdAt: "2026-01-01T00:00:00.000Z",
			},
		],
		edges: [
			{ from: "summary", to: "raw", kind: "references" },
			{ from: "summary", to: "wiki", kind: "references" },
		],
		tokensSavedEstimate: 123,
	};
}

describe("offload trace renderer", () => {
	it("renders deterministic bounded Mermaid markdown with drill-down refs", () => {
		const first = renderOffloadTraceCanvasMarkdown(canvasWithRefs(), { maxCanvasChars: 2000, maxNodes: 24 });
		const second = renderOffloadTraceCanvasMarkdown(canvasWithRefs(), { maxCanvasChars: 2000, maxNodes: 24 });

		expect(first).toBe(second);
		expect(first).toContain("```mermaid");
		expect(first).toContain("artifact://7");
		expect(first).toContain("wikigraph://node/abc");
		expect(first.length).toBeLessThanOrEqual(2000);
	});

	it("omits extra nodes after maxNodes", () => {
		const markdown = renderOffloadTraceCanvasMarkdown(canvasWithRefs(), { maxCanvasChars: 2000, maxNodes: 2 });

		expect(markdown).toContain("artifact://7");
		expect(markdown).not.toContain("wikigraph://node/abc");
		expect(markdown).toContain("additional trace nodes omitted");
	});

	it("ignores unknown preserved trace versions", () => {
		const preserved: Record<string, unknown> = { offloadTrace: { ...canvasWithRefs(), version: 999 } };

		expect(getPreservedOffloadTrace(preserved)).toBeUndefined();
	});

	it("saves long raw evidence as offload artifact", async () => {
		const dir = await mkdtemp(join(tmpdir(), "omp-offload-trace-"));
		try {
			const manager = new ArtifactManager(dir);
			const longText = "x".repeat(128);
			const message: AgentMessage = {
				role: "user",
				content: longText,
				timestamp: Date.now(),
			};
			const canvas = await buildOffloadTraceCanvas({
				messagesToSummarize: [message],
				summary: "summary",
				settings: { enabled: true, maxCanvasChars: 2000, maxNodes: 24, rawArtifactMinChars: 10 },
				artifactManager: manager,
				createdAt: "2026-01-01T00:00:00.000Z",
			});

			expect(canvas?.nodes[1]?.artifactId).toBe("0");
			expect(await Bun.file(join(dir, "0.offload.log")).text()).toBe(longText);
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});

describe("offload trace rehydration", () => {
	const summary = "Summary of work done.";

	it("appends preserved trace to compaction summary", () => {
		const result = summaryWithPreservedOffloadTrace(summary, { offloadTrace: canvasWithRefs() });
		expect(result).toContain(summary);
		expect(result).toContain("## Trace");
		expect(result).toContain("artifact://7");
	});

	it("leaves summary unchanged when trace version is unknown", () => {
		const result = summaryWithPreservedOffloadTrace(summary, {
			offloadTrace: { ...canvasWithRefs(), version: 999 },
		});
		expect(result).toBe(summary);
	});

	it("leaves summary unchanged when no preserved trace", () => {
		expect(summaryWithPreservedOffloadTrace(summary, undefined)).toBe(summary);
		expect(summaryWithPreservedOffloadTrace(summary, { other: "data" })).toBe(summary);
	});

	it("does not duplicate trace section already present in summary", () => {
		const result = summaryWithPreservedOffloadTrace(`${summary}\n\n## Trace`, {
			offloadTrace: canvasWithRefs(),
		});
		expect(result).toBe(`${summary}\n\n## Trace`);
	});
});

describe("offload trace builder failure safety", () => {
	const throwingManager: { save(content: string, toolType: string): Promise<string> } = {
		save() {
			throw new Error("disk full");
		},
	};

	it("degrades to unresolved node when artifact save throws", async () => {
		const message: AgentMessage = {
			role: "user",
			content: "x".repeat(128),
			timestamp: Date.now(),
		};
		const canvas = await buildOffloadTraceCanvas({
			messagesToSummarize: [message],
			summary: "summary",
			settings: { enabled: true, maxCanvasChars: 2000, maxNodes: 24, rawArtifactMinChars: 10 },
			artifactManager: throwingManager,
		});

		expect(canvas).toBeDefined();
		expect(canvas?.nodes[1]?.status).toBe("unresolved");
		expect(canvas?.nodes[1]?.artifactId).toBeUndefined();
	});

	it("returns undefined when disabled even with evidence", async () => {
		const message: AgentMessage = {
			role: "user",
			content: "x".repeat(128),
			timestamp: Date.now(),
		};
		const canvas = await buildOffloadTraceCanvas({
			messagesToSummarize: [message],
			summary: "summary",
			settings: { enabled: false, maxCanvasChars: 2000, maxNodes: 24, rawArtifactMinChars: 10 },
		});

		expect(canvas).toBeUndefined();
	});
});
