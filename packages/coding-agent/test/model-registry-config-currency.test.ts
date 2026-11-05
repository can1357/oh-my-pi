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
	/** The header lines each discovery request actually carried, `name: value`, in order. */
	let wire: string[][];
	let registry: ModelRegistry;

	beforeEach(async () => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-test-config-currency-"));
		modelsPath = path.join(tempDir, "models.yml");
		held = heldCommand(tempDir, "fake-probe-key");
		authStorage = await AuthStorage.create(path.join(tempDir, "agent.db"));
		sent = [];
		wire = [];
		registry = new ModelRegistry(authStorage, modelsPath, {
			cacheDbPath: path.join(tempDir, "models.db"),
			fetch: async (input, init) => {
				const url = String(input);
				if (url !== MODELS_URL) throw new Error(`offline: ${url}`);
				sent.push(url);
				wire.push([...new Headers(init?.headers)].map(([name, value]) => `${name}: ${value}`));
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

	// The header rule stated against the bytes rather than against itself: two
	// declarations are the same configuration if and only if they send the same
	// request. Each case is two tests — what the wire does, then what the
	// currency check does about it — because a test that asserts the identity
	// function's own output is what let an earlier shape of this rule through.
	const headerConfig = (...lines: string[]) =>
		probeConfig(`    headers:\n${lines.map(line => `      ${line}\n`).join("")}`);

	/** The header lines one discovery under `config` really sends. */
	async function headersSentUnder(config: string): Promise<string[]> {
		writeWithNewMtime(modelsPath, config);
		await registry.refreshProvider("probe", "online");
		const request = wire.at(-1);
		if (!request) throw new Error("the discovery sent no request");
		return request;
	}

	test("two cases of one header name, and two orders of one name's declarations, on the wire", async () => {
		held.release();
		// Case alone changes nothing: field names are case-insensitive, and
		// neither spelling is the one discovery overwrites.
		expect(await headersSentUnder(headerConfig("X-Route: same-route"))).toEqual(
			await headersSentUnder(headerConfig("x-route: same-route")),
		);
		// Two declarations of one field combine in declaration order, so their
		// order is the value that gets sent.
		expect(await headersSentUnder(headerConfig("x-route: first", "X-Route: second"))).not.toEqual(
			await headersSentUnder(headerConfig("X-Route: second", "x-route: first")),
		);
	});

	test("renaming a header to another case does not refuse the discovery", async () => {
		fs.writeFileSync(modelsPath, headerConfig("X-Route: same-route"));
		await reloadDuringDiscovery(() => writeWithNewMtime(modelsPath, headerConfig("x-route: same-route")));
		expect(sent).toEqual([MODELS_URL]);
		expect(registry.find("probe", "listed-model")).toBeDefined();
	});

	test("reordering two spellings of one header name refuses the discovery", async () => {
		fs.writeFileSync(modelsPath, headerConfig("x-route: first", "X-Route: second"));
		await reloadDuringDiscovery(() =>
			writeWithNewMtime(modelsPath, headerConfig("X-Route: second", "x-route: first")),
		);
		expect(sent).toEqual([]);
		expect(registry.find("probe", "listed-model")).toBeUndefined();
	});

	test("reordering two differently named headers refuses the discovery", async () => {
		// `resolveConfigHeaders` resolves values sequentially, awaiting each
		// before starting the next, and a value may be a `!command`, so a later
		// declaration can observe an earlier one's effect and the order is part
		// of the request. Round 5 promised that a reorder-only reload keeps the
		// discovery; that promise is withdrawn. For two purely static headers
		// this is coarser than the wire and costs one extra discovery, which is
		// the safe direction: the alternative sends a header resolved under a
		// configuration that no longer exists.
		fs.writeFileSync(modelsPath, headerConfig("x-one: first", "x-two: second"));
		await reloadDuringDiscovery(() => writeWithNewMtime(modelsPath, headerConfig("x-two: second", "x-one: first")));
		expect(sent).toEqual([]);
		expect(registry.find("probe", "listed-model")).toBeUndefined();
	});

	test("reordering a list inside the opaque request body still refuses the discovery", async () => {
		// `extraBody` is copied into the request body verbatim, so a member of it
		// called `only` is an ordered payload, not a routing allowlist, however
		// much its name looks like one. Normalising by member name wherever it
		// appears would call these two bodies the same request.
		const body = (first: string, second: string) =>
			probeConfig(
				`    compat:\n      extraBody:\n        openRouterRouting:\n          only: [${first}, ${second}]\n`,
			);
		fs.writeFileSync(modelsPath, body("first", "second"));
		await reloadDuringDiscovery(() => writeWithNewMtime(modelsPath, body("second", "first")));
		expect(sent).toEqual([]);
		expect(registry.find("probe", "listed-model")).toBeUndefined();
	});

	// A declaration named exactly `Authorization` is left out of the identity
	// altogether, which looks like an oversight and is not: discovery assembles
	// its bearer as `{ ...configured, Authorization: ... }`, so that one
	// property is overwritten and can never reach the wire, whatever it holds.
	// A configured `authorization` survives beside the generated one and is
	// combined with it, so it stays.
	const auth = (name: string, value: string) => probeConfig(`    headers:\n      ${name}: ${value}\n`);

	test("an exact Authorization declaration never reaches the wire, and the lowercase one does", async () => {
		held.release();
		const overwritten = await headersSentUnder(auth("Authorization", "Bearer manual-config"));
		const generatedOnly = await headersSentUnder(probeConfig());
		expect(overwritten).toEqual(generatedOnly);
		expect(await headersSentUnder(auth("authorization", "Bearer manual-config"))).not.toEqual(generatedOnly);
	});

	test("changing the value of an exact Authorization declaration does not refuse the discovery", async () => {
		// It sends nothing either way, so it cannot be a configuration change.
		fs.writeFileSync(modelsPath, auth("Authorization", "Bearer manual-config"));
		await reloadDuringDiscovery(() => writeWithNewMtime(modelsPath, auth("Authorization", "Bearer something-else")));
		expect(sent).toEqual([MODELS_URL]);
		expect(registry.find("probe", "listed-model")).toBeDefined();
	});

	test("respelling a configured Authorization header refuses the discovery", async () => {
		// The exact-case one is dropped and the lowercase one is not, so these
		// two configurations send different credentials.
		fs.writeFileSync(modelsPath, auth("Authorization", "Bearer manual-config"));
		await reloadDuringDiscovery(() => writeWithNewMtime(modelsPath, auth("authorization", "Bearer manual-config")));
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
