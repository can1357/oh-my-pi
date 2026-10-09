import { describe, expect, it } from "bun:test";
import { type ReflectMemory, synthesizeReflection } from "@oh-my-pi/pi-mnemopi";
import type { MnemopiLlmCompleteOptions, MnemopiLlmCompletion } from "@oh-my-pi/pi-mnemopi/core/runtime-options";

const memories: ReflectMemory[] = [
	{ id: "memory-a", content: "The user prefers tea.", timestamp: "2026-09-01", kind: "preference" },
	{ id: "memory-b", content: "The user previously preferred coffee.", timestamp: "2025-01-01", kind: "preference" },
];

interface ReflectionInput {
	query: string;
	memories: ReflectMemory[];
}

describe("memory reflection", () => {
	it("reports unique source citations in answer order and removes invented ids", async () => {
		const result = await synthesizeReflection(
			() => "Previously coffee [memory-b]; now tea [memory-a]. Tea [memory-a]. Unknown [memory-missing].",
			"What does the user drink?",
			memories,
		);
		expect(result).toEqual({
			text: "Previously coffee [memory-b]; now tea [memory-a]. Tea [memory-a]. Unknown.",
			citedIds: ["memory-b", "memory-a"],
			synthesized: true,
		});
	});

	it("rejects an unsupported ownership claim after its fabricated citation is removed", async () => {
		expect(
			await synthesizeReflection(() => "Alice owns the checklist [memory-missing].", "Who owns the checklist?", [
				{ id: "memory-a", content: "Mina owns the checklist" },
			]),
		).toBeNull();
	});

	it("allows fallback when every citation in grouped and separate references is invalid", async () => {
		expect(
			await synthesizeReflection(
				() => "Alice owns it [memory-missing, memory-invented]. Bob approves it [memory-other].",
				"Who owns the checklist?",
				memories,
			),
		).toBeNull();
	});

	it("rejects uncertainty with attempted citations when none validate", async () => {
		expect(
			await synthesizeReflection(() => "Not enough information [memory-missing].", "Where?", memories),
		).toBeNull();
	});

	it("allows fallback for factual assertions with no citations", async () => {
		expect(
			await synthesizeReflection(() => "Alice owns the checklist.", "Who owns the checklist?", memories),
		).toBeNull();
	});

	it("accepts an explicit uncited English unknown answer without inventing source ids", async () => {
		expect(await synthesizeReflection(() => "I don't know", "Where?", memories)).toEqual({
			text: "I don't know",
			citedIds: [],
			synthesized: true,
		});
	});

	it("accepts an explicit uncited Turkish lack-of-information answer", async () => {
		expect(await synthesizeReflection(() => "bu konuda bilgi yok", "Nerede?", memories)).toEqual({
			text: "bu konuda bilgi yok",
			citedIds: [],
			synthesized: true,
		});
	});

	it("normalizes curly apostrophes, whitespace and case only for uncertainty recognition", async () => {
		expect(await synthesizeReflection(() => " \nI \t DON’T KNOW?\n ", "Where?", memories)).toEqual({
			text: "I \t DON’T KNOW?",
			citedIds: [],
			synthesized: true,
		});
	});

	it("recognizes Turkish uppercase dotted I in an uncertainty answer", async () => {
		expect(await synthesizeReflection(() => "BU KONUDA BİLGİ YOK!", "Nerede?", memories)).toEqual({
			text: "BU KONUDA BİLGİ YOK!",
			citedIds: [],
			synthesized: true,
		});
	});

	it("rejects unsupported claims appended to English or Turkish uncertainty", async () => {
		expect(
			await synthesizeReflection(() => "I don't know. Alice owns the checklist.", "Who owns it?", memories),
		).toBeNull();
		expect(await synthesizeReflection(() => "Bu konuda bilgi yok, sahibi Alice.", "Kimin?", memories)).toBeNull();
	});

	it("preserves Markdown links, checkboxes, numbered references and array indexing", async () => {
		const prose =
			"Use [docs](https://example.com), [memory-a](https://example.com/id), [ ], [x], [1], arr[0] and [ordinary text].";
		const result = await synthesizeReflection(
			() => `${prose} Tea [memory-a]. Unknown [memory-missing].`,
			"What?",
			memories,
		);
		expect(result).toEqual({
			text: `${prose} Tea [memory-a]. Unknown.`,
			citedIds: ["memory-a"],
			synthesized: true,
		});
	});

	it("recognizes comma-separated and semicolon-separated citations without dropping sources", async () => {
		const result = await synthesizeReflection(
			() => "Tea [memory-b, memory-a]. History [memory-a; memory-b].",
			"What?",
			memories,
		);
		expect(result).toEqual({
			text: "Tea [memory-b, memory-a]. History [memory-a; memory-b].",
			citedIds: ["memory-b", "memory-a"],
			synthesized: true,
		});
	});

	it("removes only invented 16-hex ids from mixed citations and cleans stranded spacing", async () => {
		const first = "1234567890abcdef";
		const second = "abcdef1234567890";
		const missing = "deadbeefdeadbeef";
		const result = await synthesizeReflection(
			() =>
				`One [${first}, ${missing}, ${second}]; two [${missing}; ${second}]; unknown [${missing}], next [${missing}] word.`,
			"What?",
			[
				{ id: first, content: "One." },
				{ id: second, content: "Two." },
			],
		);
		expect(result).toEqual({
			text: `One [${first}, ${second}]; two [${second}]; unknown, next word.`,
			citedIds: [first, second],
			synthesized: true,
		});
	});

	it("recognizes invented UUID-shaped citations without stripping bracketed prose", async () => {
		const id = "12345678-1234-1234-1234-123456789abc";
		const missing = "abcdefab-abcd-abcd-abcd-abcdefabcdef";
		const result = await synthesizeReflection(() => `Fact [${id}; ${missing}]. [additional context]`, "What?", [
			{ id, content: "Fact." },
		]);
		expect(result).toEqual({
			text: `Fact [${id}]. [additional context]`,
			citedIds: [id],
			synthesized: true,
		});
	});

	it("allows the caller's fallback when no completion is supplied", async () => {
		expect(await synthesizeReflection(undefined, "What?", memories)).toBeNull();
		expect(await synthesizeReflection(null, "What?", memories)).toBeNull();
	});

	it("does not call the LLM when no memories were recalled", async () => {
		let calls = 0;
		const complete: MnemopiLlmCompletion = () => {
			calls++;
			return "An unsupported answer.";
		};
		expect(await synthesizeReflection(complete, "What?", [])).toBeNull();
		expect(calls).toBe(0);
	});

	it("allows the caller's fallback on null or whitespace-only completions", async () => {
		expect(await synthesizeReflection(() => null, "What?", memories)).toBeNull();
		expect(await synthesizeReflection(() => " \n\t ", "What?", memories)).toBeNull();
	});

	it("allows the caller's fallback when all output was fabricated citations", async () => {
		expect(await synthesizeReflection(() => "[memory-missing]", "What?", memories)).toBeNull();
	});

	it("allows the caller's fallback on synchronous and asynchronous provider errors", async () => {
		expect(
			await synthesizeReflection(
				() => {
					throw new Error("Provider unavailable");
				},
				"What?",
				memories,
			),
		).toBeNull();
		expect(
			await synthesizeReflection(() => Promise.reject(new Error("Provider rejected")), "What?", memories),
		).toBeNull();
	});

	it("routes the bounded input through the memory-reflect task and requested output limit", async () => {
		let capturedPrompt = "";
		let capturedOptions: MnemopiLlmCompleteOptions | undefined;
		const result = await synthesizeReflection(
			(prompt, options) => {
				capturedPrompt = prompt;
				capturedOptions = options;
				return options?.task?.kind === "memory-reflect" ? "Tea [memory-a]." : null;
			},
			"What does the user drink?",
			memories,
			{ maxTokens: 321 },
		);
		expect(result?.citedIds).toEqual(["memory-a"]);
		expect(capturedOptions?.task).toEqual({ kind: "memory-reflect", input: capturedPrompt });
		expect(capturedOptions?.maxTokens).toBe(321);
	});

	it("keeps the highest-ranked memory and metadata within the budget even with JSON escaping", async () => {
		const oversized = { ...memories[0]!, content: 'Tea "please"\n'.repeat(2000) };
		const inputs: string[] = [];
		const complete: MnemopiLlmCompletion = prompt => {
			inputs.push(prompt);
			return "Tea [memory-a]; coffee [memory-b].";
		};
		const result = await synthesizeReflection(complete, "What?", [oversized, memories[1]!]);
		await synthesizeReflection(complete, "What?", [oversized, memories[1]!]);
		expect(inputs[1]).toBe(inputs[0]);
		expect(inputs[0]!.length).toBeLessThanOrEqual(12_000);
		const input = JSON.parse(inputs[0]!) as ReflectionInput;
		expect(input.query).toBe("What?");
		expect(input.memories).toHaveLength(1);
		const first = input.memories[0]!;
		expect(first.id).toBe("memory-a");
		expect(first.timestamp).toBe("2026-09-01");
		expect(first.kind).toBe("preference");
		expect(first.content.length).toBeGreaterThan(0);
		expect(first.content.length).toBeLessThan(oversized.content.length);
		expect(oversized.content.startsWith(first.content)).toBe(true);
		expect(result?.citedIds).toEqual(["memory-a"]);
		expect(result?.text).not.toContain("[memory-b]");
	});

	it("bounds escaped questions without displacing all recalled evidence", async () => {
		let input = "";
		await synthesizeReflection(
			prompt => {
				input = prompt;
				return "Tea [memory-a].";
			},
			"\u0000".repeat(20_000),
			memories,
		);
		expect(input.length).toBeLessThanOrEqual(12_000);
		const parsed = JSON.parse(input) as ReflectionInput;
		expect(parsed.memories.map(memory => memory.id)).toEqual(["memory-a", "memory-b"]);
		expect(parsed.query.length).toBeLessThan(20_000);
	});

	it("propagates cancellation before starting rather than returning a fallback", async () => {
		const controller = new AbortController();
		const reason = new Error("Cancelled by user");
		controller.abort(reason);
		let calls = 0;
		const result = synthesizeReflection(
			() => {
				calls++;
				return "Tea [memory-a].";
			},
			"What?",
			memories,
			{ signal: controller.signal },
		);
		await expect(result).rejects.toBe(reason);
		expect(calls).toBe(0);
	});

	it("propagates cancellation while a completion is pending", async () => {
		const controller = new AbortController();
		const pending = Promise.withResolvers<string | null>();
		let completionSignal: AbortSignal | undefined;
		const result = synthesizeReflection(
			(_prompt, options) => {
				completionSignal = options?.signal;
				completionSignal?.addEventListener("abort", () => pending.reject(completionSignal?.reason), { once: true });
				return pending.promise;
			},
			"What?",
			memories,
			{ signal: controller.signal },
		);
		const reason = new Error("Cancelled during completion");
		controller.abort(reason);
		await expect(result).rejects.toBe(reason);
		expect(completionSignal).toBe(controller.signal);
	});
});
