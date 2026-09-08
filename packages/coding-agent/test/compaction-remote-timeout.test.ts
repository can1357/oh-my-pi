import { expect, test } from "bun:test";
import { compact, createFileOps, getCompactionV2PreserveData } from "@oh-my-pi/pi-agent-core/compaction";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveMethodSettings } from "@oh-my-pi/pi-coding-agent/session/compaction-methods";
import { isRecord } from "@oh-my-pi/pi-utils";

// Exercise Bun's native AbortSignal.timeout and HTTP cancellation; fake JS timers do not drive that clock.
test("configured V2 deadline aborts a slow response without replacing native history or caller cancellation", async () => {
	const item = { type: "compaction", encrypted_content: "local-test-history" };
	let requests = 0;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			if (new URL(request.url).pathname !== "/v1/responses") return new Response("no V1", { status: 400 });
			requests++;
			const body = await request.json();
			if (!isRecord(body) || !Array.isArray(body.input)) throw new Error("Expected a Responses input array");
			expect(body.input.at(-1)).toEqual({ type: "compaction_trigger" });
			await Bun.sleep(100);
			return new Response(
				[
					{ type: "response.output_item.done", item },
					{
						type: "response.completed",
						response: { usage: { input_tokens: 12, output_tokens: 1, total_tokens: 13 } },
					},
				]
					.map(event => `data: ${JSON.stringify(event)}\n\n`)
					.join(""),
				{ headers: { "content-type": "text/event-stream" } },
			);
		},
	});
	const model = buildModel({
		id: "gpt-5",
		name: "Local timeout check",
		api: "openai-responses",
		provider: "openai",
		baseUrl: `${server.url}v1`,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 512000,
		maxTokens: 128000,
		remoteCompaction: { enabled: true, v2StreamingEnabled: true },
	});
	const run = (timeoutMs: number, signal?: AbortSignal) =>
		compact(
			{
				firstKeptEntryId: "kept",
				messagesToSummarize: [{ role: "user", content: "local disposable conversation", timestamp: 1 }],
				turnPrefixMessages: [],
				recentMessages: [],
				isSplitTurn: false,
				tokensBefore: 1000,
				fileOps: createFileOps(),
				settings: resolveMethodSettings(
					Settings.isolated({ "compaction.remoteTimeoutMs": timeoutMs }).getGroup("compaction"),
					"remote",
				),
			},
			model,
			"local-test-key",
			undefined,
			signal,
		);
	try {
		await expect(run(10)).rejects.toThrow();
		const result = await run(600000);
		expect(getCompactionV2PreserveData(result.preserveData)?.replacementHistory.at(-1)).toEqual(item);
		const beforeCancel = requests;
		const controller = new AbortController();
		const reason = new Error("user cancelled compaction");
		const timer = setTimeout(() => controller.abort(reason), 30);
		try {
			await expect(run(600000, controller.signal)).rejects.toThrow(reason.message);
			expect(requests - beforeCancel).toBe(1);
		} finally {
			clearTimeout(timer);
		}
	} finally {
		await server.stop(true);
	}
}, 10000);
