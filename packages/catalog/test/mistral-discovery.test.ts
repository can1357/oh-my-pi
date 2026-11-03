import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resolveProviderModels } from "@oh-my-pi/pi-catalog/model-manager";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { mistralModelManagerOptions } from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { FetchImpl } from "@oh-my-pi/pi-catalog/types";

/** A `/v1/models` row as Mistral reports it: the canonical id in `name`, the other ids in `aliases`. */
function mistralRow(id: string, name: string, ids: string[]) {
	return {
		id,
		object: "model",
		name,
		aliases: ids.filter(alias => alias !== id),
		max_context_length: 262144,
		capabilities: { completion_chat: true, function_calling: true, reasoning: true, vision: true },
	};
}

const MEDIUM_IDS = [
	"mistral-medium-latest",
	"mistral-medium-2604",
	"mistral-vibe-cli-latest",
	"mistral-vibe-cli-with-tools",
];
const SMALL_IDS = ["mistral-small-2603", "mistral-small-latest", "mistral-vibe-cli-fast"];

let tempDir: string | undefined;

afterEach(async () => {
	if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
	tempDir = undefined;
});

async function discover(rows: unknown[]) {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-mistral-"));
	const fetchMock = (async () =>
		new Response(JSON.stringify({ object: "list", data: rows }), {
			status: 200,
			headers: { "Content-Type": "application/json" },
		})) as unknown as FetchImpl;
	const { models } = await resolveProviderModels(
		{
			...mistralModelManagerOptions({ apiKey: "mistral-key", fetch: fetchMock }),
			cacheDbPath: path.join(tempDir, "models.db"),
		},
		"online",
	);
	return models;
}

function contract(id: string, models: ReturnType<typeof getBundledModels>) {
	const model = models.find(candidate => candidate.id === id);
	return (
		model && {
			reasoning: model.reasoning,
			input: model.input,
			contextWindow: model.contextWindow,
			maxTokens: model.maxTokens,
			cost: model.cost,
			efforts: model.thinking?.efforts,
		}
	);
}

describe("Mistral discovery", () => {
	test("an alias id reuses the bundled row of the model it aliases and keeps its own id", async () => {
		const models = await discover([
			mistralRow("mistral-vibe-cli-latest", "mistral-medium-latest", MEDIUM_IDS),
			mistralRow("mistral-vibe-cli-fast", "mistral-small-2603", SMALL_IDS),
		]);
		const bundled = getBundledModels("mistral");

		expect(contract("mistral-vibe-cli-latest", models)).toEqual(contract("mistral-medium-latest", bundled));
		expect(contract("mistral-vibe-cli-fast", models)).toEqual(contract("mistral-small-2603", bundled));
		expect(contract("mistral-vibe-cli-latest", models)?.reasoning).toBe(true);
		expect(contract("mistral-vibe-cli-latest", models)?.input).toEqual(["text", "image"]);
	});

	test("an id whose aliases have no bundled row keeps the bare discovery defaults", async () => {
		const models = await discover([
			mistralRow("acme-chat-1", "acme-chat-latest", ["acme-chat-latest", "acme-chat-1"]),
		]);

		expect(contract("acme-chat-1", models)).toEqual({
			reasoning: false,
			input: ["text"],
			contextWindow: null,
			maxTokens: null,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			efforts: undefined,
		});
	});
});
