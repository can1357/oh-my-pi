import { describe, expect, it } from "bun:test";
import { embeddingFailureNotifier, MNEMOPI_NOTICE_SOURCE } from "@oh-my-pi/pi-coding-agent/mnemopi/embedding-notice";

// Every recall and background embed can fail the same way; the user must see the cause once,
// not once per request, and a new failure mode must still surface.
describe("embeddingFailureNotifier", () => {
	it("warns once per endpoint, model, and status", () => {
		const notices: Array<[string, string, string | undefined]> = [];
		const notify = embeddingFailureNotifier({
			emitNotice: (level, message, source) => notices.push([level, message, source]),
		});
		const unauthorized = {
			baseUrl: "https://embeddings.example.com/v1",
			model: "Qwen/Qwen3-Embedding-8B",
			status: 401,
			message: "The credential is invalid\n\tor expired.",
		};
		notify(unauthorized);
		notify(unauthorized);
		const timeout = { ...unauthorized, status: undefined, message: "The operation timed out." };
		notify(timeout);
		notify(timeout);
		notify({ ...unauthorized, status: undefined, message: "the response did not carry one embedding per input" });

		expect(notices).toEqual([
			[
				"warning",
				"Memory embeddings failed (HTTP 401 from https://embeddings.example.com/v1, model Qwen/Qwen3-Embedding-8B); recall falls back to keyword search: The credential is invalid or expired.",
				MNEMOPI_NOTICE_SOURCE,
			],
			[
				"warning",
				"Memory embeddings failed (https://embeddings.example.com/v1, model Qwen/Qwen3-Embedding-8B); recall falls back to keyword search: The operation timed out.",
				MNEMOPI_NOTICE_SOURCE,
			],
			[
				"warning",
				"Memory embeddings failed (https://embeddings.example.com/v1, model Qwen/Qwen3-Embedding-8B); recall falls back to keyword search: the response did not carry one embedding per input",
				MNEMOPI_NOTICE_SOURCE,
			],
		]);
	});

	// The notice reaches the TUI, stderr, and JSON-mode stdout, so credentials must not ride along.
	it("redacts URL credentials and secrets the provider echoes", () => {
		const messages: string[] = [];
		const notify = embeddingFailureNotifier({ emitNotice: (_level, message) => messages.push(message) });
		notify({
			baseUrl: "https://alice:hunter2@embeddings.example.com/v1?api_key=sk-live-1234567890ab",
			model: "nv-embedqa-e5-v5",
			status: 401,
			message: "Incorrect API key provided: sk-proj-abcdef1234567890",
		});
		expect(messages).toHaveLength(1);
		expect(messages[0]).toContain("embeddings.example.com/v1");
		for (const secret of ["alice", "hunter2", "sk-live-1234567890ab", "sk-proj-abcdef1234567890"]) {
			expect(messages[0]).not.toContain(secret);
		}
	});

	// Print mode writes notices straight to stderr, so configured text must not carry terminal controls.
	it("strips control sequences from the endpoint and model", () => {
		const messages: string[] = [];
		const notify = embeddingFailureNotifier({ emitNotice: (_level, message) => messages.push(message) });
		notify({
			baseUrl: "https://embeddings.example.com/v1\u001b[2J",
			model: "test\u001b[2Jmodel\nWarning: forged",
			status: 400,
			message: "bad request",
		});
		expect(messages).toHaveLength(1);
		expect(messages[0]).not.toContain("\u001b");
		expect(messages[0]).not.toContain("\n");
	});
});
