import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

const ENDPOINT = "http://config-currency.invalid/v1";
const MODELS_URL = `${ENDPOINT}/models`;
const TRANSIENT = "x-transient-secret";

/**
 * What a discovery already in flight is allowed to see of a models.yml reload
 * that lands while it runs. Three cases a reviewer found and reproduced: a
 * per-model overlay added after the request started must not reach its rows
 * (it is in neither currency test, so the result is published either way);
 * writing the same two models in the other order must not look like a
 * configuration change at all; and a reload that really does change which
 * APIs the provider endpoint covers must still stop the request, because
 * refusing a discovery whose configuration moved under it is what these
 * checks are for.
 *
 * Each case holds the provider's `apiKey` command rather than a header.
 * `#peekApiKeyForProvider` is awaited early in `#discoverProviderModels`,
 * before the request is assembled, so the hold spans the whole window a
 * reload can disturb; a held header blocks later, inside the fetch, past the
 * point where the suppression happens, and sees neither outcome.
 */
describe("a configured discovery keeps the configuration it started under", () => {
	let tempDir: string;
	let modelsPath: string;
	let authStorage: AuthStorage;
	let held: HeldCommand;
	let sent: string[];
	let registry: ModelRegistry;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-config-currency-"));
		modelsPath = path.join(tempDir, "models.yml");
		held = heldCommand(tempDir, "fake-probe-key");
		authStorage = await AuthStorage.create(path.join(tempDir, "agent.db"));
		sent = [];
		registry = new ModelRegistry(authStorage, modelsPath, {
			cacheDbPath: path.join(tempDir, "models.db"),
			fetch: async input => {
				const url = String(input);
				if (url !== MODELS_URL) throw new Error(`offline: ${url}`);
				sent.push(url);
				return Response.json({ data: [{ id: "listed-model", type: "model" }] });
			},
		});
	});

	afterEach(() => {
		held.release();
		authStorage.close();
		if (tempDir && fs.existsSync(tempDir)) removeSyncWithRetries(tempDir);
	});

	/** Hold the provider's key command, apply `change`, release, and let the discovery finish. */
	async function reloadDuringDiscovery(change: () => void): Promise<void> {
		const inFlight = registry.refreshProvider("probe", "online");
		await held.started();
		change();
		// Any refresh reloads a changed models.yml; "unused" is not configured.
		await registry.refreshProvider("unused", "offline");
		held.release();
		await inFlight;
	}

	/** models.yml for `probe`, whose key is the held command, plus `extra` under the provider. */
	const probeConfig = (extra = "") =>
		`providers:\n  probe:\n    baseUrl: ${ENDPOINT}\n    api: openai-completions\n` +
		`    apiKey: "${held.command}"\n    discovery:\n      type: openai-models-list\n${extra}`;

	/** `probeConfig` with a per-model header overlay on `listed-model`. */
	const overlayConfig = (value: string) =>
		probeConfig(`    modelOverrides:\n      listed-model:\n        headers:\n          ${TRANSIENT}: ${value}\n`);

	/** The header chain a request for `listed-model` would actually carry. */
	async function wireHeaders(): Promise<Record<string, string> | undefined> {
		const model = registry.find("probe", "listed-model");
		if (!model) throw new Error("the discovered model was not published");
		return await registry.resolveModelHeaders(model);
	}

	test("a per-model override deleted while the discovery runs stops reaching its rows and its cache", async () => {
		fs.writeFileSync(modelsPath, overlayConfig("fake-removed-secret"));
		// The row is fetched while the overlay exists and arrives after it is gone.
		await reloadDuringDiscovery(() => writeWithNewMtime(modelsPath, probeConfig()));
		expect(sent).toEqual([MODELS_URL]);
		// Nothing composes a header away again, so a row that kept the overlay
		// here would send a secret the operator deleted.
		expect((await wireHeaders())?.[TRANSIENT]).toBeUndefined();

		// And after a reload, when the row is rebuilt from the model cache rather
		// than from the result the discovery just returned.
		await registry.refreshProvider("unused", "offline");
		expect((await wireHeaders())?.[TRANSIENT]).toBeUndefined();
	});

	test("a per-model override added while the discovery runs reaches it, because the configuration holds it", async () => {
		fs.writeFileSync(modelsPath, probeConfig());
		await reloadDuringDiscovery(() => writeWithNewMtime(modelsPath, overlayConfig("fake-added-secret")));
		expect(sent).toEqual([MODELS_URL]);
		// The other direction of the same rule: overlays are live configuration,
		// so the row carries the one the configuration holds now, not the one it
		// was discovered under. A row frozen at discovery time would miss it.
		expect((await wireHeaders())?.[TRANSIENT]).toBe("fake-added-secret");

		// Delete it again: the row must lose it, from the cache path too.
		writeWithNewMtime(modelsPath, probeConfig());
		await registry.refreshProvider("unused", "offline");
		expect((await wireHeaders())?.[TRANSIENT]).toBeUndefined();
	});

	// The two directions of the same comparison. `baseUrlApis` is a set written
	// as an array and read only through `.includes`, so its order is spelling;
	// which APIs are in it is not. A fix that canonicalises the order must not
	// also stop noticing membership.
	const openai = "      - id: first\n        api: openai-completions\n";
	const anthropic = "      - id: second\n        api: anthropic-messages\n";

	test("writing the same two models in the other order does not refuse the discovery", async () => {
		fs.writeFileSync(modelsPath, probeConfig(`    models:\n${openai}${anthropic}`));
		// Same endpoint, credential, headers and set of APIs; only the order of
		// two entries differs, and route resolution asks `.includes`.
		await reloadDuringDiscovery(() =>
			writeWithNewMtime(modelsPath, probeConfig(`    models:\n${anthropic}${openai}`)),
		);
		expect(sent).toEqual([MODELS_URL]);
		expect(registry.find("probe", "listed-model")).toBeDefined();
	});

	test("changing which APIs the provider endpoint covers still refuses the discovery", async () => {
		fs.writeFileSync(modelsPath, probeConfig(`    models:\n${openai}${anthropic}`));
		// Not a reordering: the second entry's api changes, so the set of APIs
		// the provider baseUrl covers changes with it. The request was assembled
		// under the old configuration and must not leave.
		await reloadDuringDiscovery(() =>
			writeWithNewMtime(
				modelsPath,
				probeConfig(`    models:\n${openai}      - id: second\n        api: openai-responses\n`),
			),
		);
		expect(sent).toEqual([]);
		expect(registry.find("probe", "listed-model")).toBeUndefined();
	});

	// The same two directions for the provider routing allowlist. `only` is a
	// set — the catalog's `OpenRouterRouting` distinguishes it from `order`,
	// the preference sequence — so writing its members the other way round
	// sends the same request, while adding or removing one does not, and
	// reversing `order` does not either.
	const routing = (first: string, second: string, order = "") =>
		probeConfig(`    compat:\n      openRouterRouting:\n        only: [${first}, ${second}]\n${order}`);

	test("writing a routing allowlist's members in the other order does not refuse the discovery", async () => {
		fs.writeFileSync(modelsPath, routing("anthropic", "openai"));
		await reloadDuringDiscovery(() => writeWithNewMtime(modelsPath, routing("openai", "anthropic")));
		expect(sent).toEqual([MODELS_URL]);
		expect(registry.find("probe", "listed-model")).toBeDefined();
	});

	test("changing a routing allowlist's members still refuses the discovery", async () => {
		fs.writeFileSync(modelsPath, routing("anthropic", "openai"));
		await reloadDuringDiscovery(() => writeWithNewMtime(modelsPath, routing("anthropic", "bedrock")));
		expect(sent).toEqual([]);
		expect(registry.find("probe", "listed-model")).toBeUndefined();
	});

	test("reversing the routing preference order still refuses the discovery", async () => {
		const forwards = "        order: [anthropic, openai]\n";
		const backwards = "        order: [openai, anthropic]\n";
		fs.writeFileSync(modelsPath, routing("anthropic", "openai", forwards));
		// `order` is a sequence the provider follows, so reversing it is a
		// different request even though the same providers appear in it.
		await reloadDuringDiscovery(() => writeWithNewMtime(modelsPath, routing("anthropic", "openai", backwards)));
		expect(sent).toEqual([]);
		expect(registry.find("probe", "listed-model")).toBeUndefined();
	});

	// And for the header record, where the two directions are the two kinds of
	// reordering: two different field names, and two spellings of one name.
	test("reordering two differently named headers does not refuse the discovery", async () => {
		const headers = (first: string, second: string) => probeConfig(`    headers:\n      ${first}\n      ${second}\n`);
		fs.writeFileSync(modelsPath, headers("x-one: first", "x-two: second"));
		await reloadDuringDiscovery(() => writeWithNewMtime(modelsPath, headers("x-two: second", "x-one: first")));
		expect(sent).toEqual([MODELS_URL]);
		expect(registry.find("probe", "listed-model")).toBeDefined();
	});

	test("reordering two spellings of one header name still refuses the discovery", async () => {
		const headers = (first: string, second: string) => probeConfig(`    headers:\n      ${first}\n      ${second}\n`);
		// HTTP field names are case-insensitive and two declarations of one name
		// are combined in declaration order, so this swap changes the value that
		// is sent from `first, second` to `second, first`.
		fs.writeFileSync(modelsPath, headers("x-route: first", "X-Route: second"));
		await reloadDuringDiscovery(() => writeWithNewMtime(modelsPath, headers("X-Route: second", "x-route: first")));
		expect(sent).toEqual([]);
		expect(registry.find("probe", "listed-model")).toBeUndefined();
	});
});

interface HeldCommand {
	command: string;
	started(): Promise<void>;
	release(): void;
}

/** A `!command` config value that prints `output` only once released. */
function heldCommand(dir: string, output: string): HeldCommand {
	const marker = path.join(dir, "held.started");
	const gate = path.join(dir, "held.gate");
	return {
		command: `!sh -c 'touch ${marker}; while [ ! -f ${gate} ]; do sleep 0.02; done; echo ${output}'`,
		started: async () => {
			// The key command runs in a child process; its marker file is the only
			// signal that it started, so there is no promise or event to await.
			const deadline = Date.now() + 20_000;
			while (!fs.existsSync(marker) && Date.now() < deadline) await Bun.sleep(10);
			if (!fs.existsSync(marker)) throw new Error("the held key command never started");
		},
		release: () => fs.writeFileSync(gate, ""),
	};
}

/** Rewrite a file with a modification time the registry's reload check cannot miss. */
function writeWithNewMtime(file: string, content: string) {
	const previous = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
	fs.writeFileSync(file, content);
	const next = new Date(Math.max(Date.now(), previous + 2000));
	fs.utimesSync(file, next, next);
}
