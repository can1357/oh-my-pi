/**
 * `omp models --json` is a machine-readable output contract: rumen and other
 * schedulers rank models by capability from it. These tests drive the listing
 * command itself and parse the bytes it writes to stdout, so they fail if the
 * `--json` path stops carrying the catalog metrics — not just if a helper
 * copies a field.
 */

import { describe, expect, it, spyOn } from "bun:test";
import { AuthStorage, type Api, type Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { runModelsListing } from "@oh-my-pi/pi-coding-agent/cli/models-cli";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";

interface ListedModel {
	provider: string;
	id: string;
	int: number | null;
	tps: number | null;
}

function bundled(provider: "anthropic", id: string): Model<Api> {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected bundled model ${provider}/${id}`);
	return model;
}

/** Run `omp models --json` over an exact model set and parse what it printed. */
async function listAsJson(models: Model<Api>[]): Promise<ListedModel[]> {
	const authStorage = await AuthStorage.create(":memory:");
	try {
		const modelRegistry = new ModelRegistry(authStorage);
		// The registry's own discovery is not under test; the listing's JSON
		// rendering is, so the available set is pinned.
		spyOn(modelRegistry, "getAvailable").mockReturnValue(models);

		const captured: string[] = [];
		const originalWrite = process.stdout.write.bind(process.stdout);
		process.stdout.write = ((chunk: string | Uint8Array) => {
			captured.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
			return true;
		}) as typeof process.stdout.write;
		try {
			await runModelsListing({
				modelRegistry,
				cwd: process.cwd(),
				action: "ls",
				json: true,
				disableExtensionDiscovery: true,
			});
		} finally {
			process.stdout.write = originalWrite;
		}

		const payload = JSON.parse(captured.join("")) as { models: ListedModel[] };
		return payload.models;
	} finally {
		authStorage.close();
	}
}

describe("omp models --json catalog metrics", () => {
	it("prints the catalog intelligence score and output speed the model browser shows", async () => {
		const model = bundled("anthropic", "claude-fable-5");
		// Guard: an unscored fixture would let the assertions below pass vacuously.
		expect(model.int).toBeGreaterThan(0);
		expect(model.tps).toBeGreaterThan(0);

		const [listed] = await listAsJson([model]);
		expect(listed).toMatchObject({
			provider: model.provider,
			id: model.id,
			int: model.int,
			tps: model.tps,
		});
	});

	it("prints null for an unscored model instead of omitting the keys", async () => {
		const scored = bundled("anthropic", "claude-fable-5");
		const unscored = { ...scored, id: "unscored-fixture", int: undefined, tps: undefined } as Model<Api>;

		const listed = await listAsJson([scored, unscored]);
		const row = listed.find(entry => entry.id === "unscored-fixture");
		// An absent key and a zero score are different facts to a consumer that
		// reads `int` as a number, so the keys must be present and null.
		expect(row).toHaveProperty("int", null);
		expect(row).toHaveProperty("tps", null);
		// Same listing, other row scored: the null is the model's own fact, not
		// the whole `--json` path dropping the fields.
		expect(listed.find(entry => entry.id === scored.id)?.int).toBe(scored.int as number);
	});

	it("prints a zero output speed as unmeasured, matching the model browser", async () => {
		const model = { ...bundled("anthropic", "claude-fable-5"), tps: 0 } as Model<Api>;
		const [listed] = await listAsJson([model]);
		expect(listed?.tps).toBeNull();
		// The score survives: zero speed disqualifies `tps` alone.
		expect(listed?.int).toBe(model.int as number);
	});
});
