import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import * as ai from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { BlockAccumulator, SpeechEnhancer } from "@oh-my-pi/pi-coding-agent/tts/speech-enhancer";

const authStorages: AuthStorage[] = [];
const modelConfigDirs: string[] = [];

async function createRegistry(settings: Settings, models: Model[]): Promise<ModelRegistry> {
	const authStorage = await AuthStorage.create(":memory:");
	authStorages.push(authStorage);
	for (const model of models) {
		authStorage.setRuntimeApiKey(model.provider, model.provider === "local" ? "local-inference" : "test-key");
	}
	const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-speech-enhancer-"));
	modelConfigDirs.push(configDir);
	const registry = new ModelRegistry(authStorage, path.join(configDir, "models.yml"), { settings });
	vi.spyOn(registry, "getAvailable").mockReturnValue(models);
	return registry;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const authStorage of authStorages.splice(0)) authStorage.close();
	for (const configDir of modelConfigDirs.splice(0)) fs.rmSync(configDir, { recursive: true, force: true });
});

describe("SpeechEnhancer rewriting", () => {
	it("uses a reasoning-safe rewrite budget when the catalog disables reasoning", async () => {
		const baseModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!baseModel) throw new Error("Expected bundled Claude Sonnet 4.5 model");
		const model = { ...baseModel, reasoning: false };
		const settings = Settings.isolated({ modelRoles: { tiny: `${model.provider}/${model.id}` } });
		const registry = await createRegistry(settings, [model]);
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "Spoken text" }],
		} as never);

		const rewritten = await new SpeechEnhancer({ settings, registry, sessionId: "session-1" }).rewrite(
			"**Spoken text**",
		);
		const options = completeSimpleMock.mock.calls[0]?.[2] as
			| { disableReasoning?: boolean; maxTokens?: number }
			| undefined;

		expect(rewritten).toBe("Spoken text");
		expect(options).toMatchObject({ disableReasoning: true, maxTokens: 1536 });
	});

	it("selects an available local-inference tiny model", async () => {
		const localModel = getBundledModel("local", "lfm2.5-230m");
		if (!localModel) throw new Error("Expected bundled local tiny model");
		const paidModel = getBundledModel("anthropic", "claude-haiku-4-5");
		if (!paidModel) throw new Error("Expected bundled Claude Haiku 4.5 model");
		const settings = Settings.isolated({ modelRoles: { tiny: `${localModel.provider}/${localModel.id}` } });
		const registry = await createRegistry(settings, [localModel, paidModel]);
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "Local spoken text" }],
		} as never);

		const rewritten = await new SpeechEnhancer({ settings, registry, sessionId: "session-local" }).rewrite(
			"**Local spoken text**",
		);

		expect(rewritten).toBe("Local spoken text");
		expect(completeSimpleMock.mock.calls[0]?.[0]).toBe(localModel);
	});
});

/** Push each delta in order; returns blocks completed by pushes plus the flush tail. */
function feed(...deltas: string[]): { blocks: string[]; tail: string | null } {
	const acc = new BlockAccumulator();
	const blocks = deltas.flatMap(delta => acc.push(delta));
	return { blocks, tail: acc.flush() };
}

describe("BlockAccumulator paragraph splitting", () => {
	it("emits blank-line-delimited paragraphs in order", () => {
		const acc = new BlockAccumulator();
		expect(acc.push("First paragraph.\n\nSecond paragraph.\n\n")).toEqual(["First paragraph.", "Second paragraph."]);
	});

	it("keeps single-newline lines (a multi-line list) in one block", () => {
		const { blocks, tail } = feed("- item one\n- item two\n- item three\n");
		expect(blocks).toEqual([]);
		expect(tail).toBe("- item one\n- item two\n- item three");
	});
});

describe("BlockAccumulator fence atomicity", () => {
	it("a ``` fence with an internal blank line stays one whole block between prose blocks", () => {
		const { blocks } = feed("Intro text.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nOutro text.\n\n");
		expect(blocks).toEqual(["Intro text.", "```ts\nconst a = 1;\n\nconst b = 2;\n```", "Outro text."]);
	});

	it("~~~ fences hold a block together like ``` fences", () => {
		const { blocks } = feed("~~~\nfirst line\n\nsecond line\n~~~\n\nAfter the fence.\n\n");
		expect(blocks).toEqual(["~~~\nfirst line\n\nsecond line\n~~~", "After the fence."]);
	});

	it("a ``` line inside an open ~~~ fence does not close it", () => {
		const { blocks } = feed("~~~\n```\nstill code\n\nstill code too\n~~~\n\nAfter the fence.\n\n");
		expect(blocks).toEqual(["~~~\n```\nstill code\n\nstill code too\n~~~", "After the fence."]);
	});
});

describe("BlockAccumulator delta splitting", () => {
	it("one-character deltas yield the same blocks and flush tail as a single push", () => {
		const input = "Intro text.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nOutro text.\nTrailing partial";
		expect(feed(...input.split(""))).toEqual(feed(input));
	});
});

describe("BlockAccumulator flushPartial", () => {
	it("returns null mid-fence and preserves fence state for the eventual close", () => {
		const acc = new BlockAccumulator();
		expect(acc.push("```ts\nconst x = 1;\nconst y")).toEqual([]);
		expect(acc.flushPartial()).toBeNull();
		expect(acc.push(" = 2;\n```\n\n")).toEqual(["```ts\nconst x = 1;\nconst y = 2;\n```"]);
	});

	it("drains a pending partial line outside a fence, and later pushes continue cleanly", () => {
		const acc = new BlockAccumulator();
		expect(acc.push("Stalled sentence with no newline")).toEqual([]);
		expect(acc.flushPartial()).toBe("Stalled sentence with no newline");
		expect(acc.push("Fresh paragraph after the stall.\n\n")).toEqual(["Fresh paragraph after the stall."]);
		expect(acc.flush()).toBeNull();
	});
});

describe("BlockAccumulator flush", () => {
	it("drops an unterminated fence from its opening line but keeps preceding prose in the same block", () => {
		const acc = new BlockAccumulator();
		expect(acc.push("Prose before the code:\n```ts\nconst broken = ")).toEqual([]);
		expect(acc.flush()).toBe("Prose before the code:");
	});

	it("returns null with no pending content, both fresh and after a drain", () => {
		const acc = new BlockAccumulator();
		expect(acc.flush()).toBeNull();
		acc.push("Some text\n");
		acc.flush();
		expect(acc.flush()).toBeNull();
	});
});
