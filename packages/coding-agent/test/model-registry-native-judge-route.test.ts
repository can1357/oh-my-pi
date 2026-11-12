import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	JUDGMENT_API_PATHS,
	type JudgmentApi,
	validateNativeJudgeEndpointRoot,
	validateNativeJudgeProviderId,
} from "@oh-my-pi/pi-ai/judgment/native";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { JSONC, YAML } from "bun";

const PROVIDER = "native-fixture";
const CHAT_ID = "catalog/chat-model";
const TOKEN = "SYNTHETIC_PROVIDER_TOKEN";
const NATIVE_APIS = Object.keys(JUDGMENT_API_PATHS) as JudgmentApi[];
const ROOTS: Record<JudgmentApi, string> = {
	typesafe: "http://127.0.0.1:9123/native",
	"openrouter-decisions": "https://native.invalid/api/alpha",
	"workers-ai-systemone": "https://api.cloudflare.com/client/v4/accounts/<account>/ai/run",
	"openai-decisions": "https://native.invalid/v1",
	"liquid-systemone": "https://native.invalid/liquid",
	"nace-systemone": "https://native.invalid/nace",
};

function fixtureDocument() {
	return {
		unknownRootField: { keep: true },
		providers: {
			[PROVIDER]: {
				baseUrl: "https://chat.invalid/v1",
				api: "openai-completions",
				apiKey: TOKEN,
				headers: { "X-Provider": "kept" },
				models: [
					{ id: CHAT_ID, name: "Chat fixture", supportsTools: true, headers: { "X-Model": "kept" } },
					{ id: "chat-sibling" },
				],
				modelOverrides: { "chat-sibling": { name: "Sibling" } },
			},
		},
	};
}

describe("ModelRegistry native judge routes", () => {
	let dir: string;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		dir = path.join(os.tmpdir(), `pi-native-route-${Snowflake.next()}`);
		fs.mkdirSync(dir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(dir, "auth.db"));
	});

	afterEach(() => {
		authStorage.close();
		removeSyncWithRetries(dir);
	});

	function write(file: string, document: unknown): string {
		const target = path.join(dir, file);
		fs.writeFileSync(
			target,
			file.endsWith(".yml") ? YAML.stringify(document, null, 2) : JSON.stringify(document, null, 2),
		);
		return target;
	}

	// The tests wrote these files; they only need indexing, not validation.
	const read = (file: string) => {
		const content = fs.readFileSync(file, "utf8");
		return (file.endsWith(".yml") ? YAML.parse(content) : JSONC.parse(content)) as {
			providers: Record<
				string,
				{ models: Array<{ id: string; [key: string]: unknown }>; modelOverrides?: Record<string, unknown> }
			>;
		};
	};

	const registryAt = (file: string, options?: { ignoreLocalModelConfig?: boolean }) =>
		new ModelRegistry(authStorage, file, options);

	test("validates provider namespaces and endpoint roots", () => {
		expect(validateNativeJudgeProviderId(" my-judge_2 ")).toBe("my-judge_2");
		for (const bad of ["My-Judge", "1judge", "judge--x", "judge/x", "constructor", "default"]) {
			expect(() => validateNativeJudgeProviderId(bad)).toThrow();
		}
		expect(() => validateNativeJudgeProviderId("openrouter", ["OpenRouter"])).toThrow(/capitalization/);
		for (const api of NATIVE_APIS) {
			expect(validateNativeJudgeEndpointRoot(api, ` ${ROOTS[api]}/ `)).toBe(ROOTS[api]);
			expect(() =>
				validateNativeJudgeEndpointRoot(
					api,
					`${ROOTS[api]}${JUDGMENT_API_PATHS[api].replace("{model}", "@cf/x/y")}`,
				),
			).toThrow();
			for (const bad of [
				"native.invalid/v1",
				"ftp://native.invalid",
				"https://user:pw@native.invalid",
				"https://native.invalid/v1?x=1",
				"https://native.invalid/v1#x",
			]) {
				expect(() => validateNativeJudgeEndpointRoot(api, bad)).toThrow();
			}
		}
		expect(() => validateNativeJudgeEndpointRoot("typesafe", "https://native.invalid/<account>")).toThrow(
			/templated/,
		);
	});

	for (const file of ["models.yml", "models.json"]) {
		test(`edits an exact chat model into a native judge and preserves the rest of ${file}`, async () => {
			const modelsPath = write(file, fixtureDocument());
			const registry = registryAt(modelsPath);
			const chat = registry.find(PROVIDER, CHAT_ID)!;
			expect(chat.api).toBe("openai-completions");

			const saved = await registry.saveNativeJudgeRoute(chat, "typesafe", `${ROOTS.typesafe}/`);
			expect(saved).toMatchObject({
				provider: PROVIDER,
				id: CHAT_ID,
				api: "typesafe",
				baseUrl: ROOTS.typesafe,
				kind: "judge",
			});

			const expected = fixtureDocument();
			Object.assign(expected.providers[PROVIDER].models[0], { api: "typesafe", baseUrl: ROOTS.typesafe });
			expect(read(modelsPath)).toEqual(expected);

			const fresh = registryAt(modelsPath);
			expect(fresh.find(PROVIDER, CHAT_ID)).toMatchObject({
				api: "typesafe",
				baseUrl: ROOTS.typesafe,
				kind: "judge",
			});
			expect(fresh.find(PROVIDER, "chat-sibling")).toMatchObject({ api: "openai-completions", name: "Sibling" });
		});
	}

	test("retargets a model override that would otherwise undo the route", async () => {
		const document = fixtureDocument();
		Object.assign(document.providers[PROVIDER].modelOverrides, {
			[CHAT_ID]: { api: "openai-responses", kind: "chat", name: "Overridden" },
		});
		const modelsPath = write("models.yml", document);
		const registry = registryAt(modelsPath);

		const saved = await registry.saveNativeJudgeRoute(
			registry.find(PROVIDER, CHAT_ID)!,
			"openai-decisions",
			ROOTS["openai-decisions"],
		);
		expect(saved).toMatchObject({ api: "openai-decisions", kind: "judge", name: "Overridden" });
		expect(read(modelsPath).providers[PROVIDER].modelOverrides?.[CHAT_ID]).toEqual({
			api: "openai-decisions",
			name: "Overridden",
		});
	});

	test("declares a bundled model's route without a provider-wide baseUrl or key, keeping its wire id", async () => {
		const modelsPath = path.join(dir, "models.yml");
		await authStorage.credentials.upsert("openai", { type: "api_key", key: TOKEN });
		const registry = registryAt(modelsPath);
		const bundled = registry.find("openai", "gpt-5.6-luna-pro")!;
		expect(bundled.requestModelId).toBe("gpt-5.6-luna");

		const saved = await registry.saveNativeJudgeRoute(bundled, "openai-decisions", ROOTS["openai-decisions"]);
		expect(saved).toMatchObject({
			id: bundled.id,
			requestModelId: "gpt-5.6-luna",
			api: "openai-decisions",
			kind: "judge",
			name: bundled.name,
		});
		expect(read(modelsPath)).toEqual({
			providers: {
				openai: { models: [{ id: bundled.id, api: "openai-decisions", baseUrl: ROOTS["openai-decisions"] }] },
			},
		});
		const fresh = registryAt(modelsPath);
		expect(fresh.getError()).toBeUndefined();
		expect(fresh.getAvailable("all")).toContainEqual(
			expect.objectContaining({ provider: "openai", id: bundled.id, api: "openai-decisions" }),
		);
	});

	for (const api of NATIVE_APIS) {
		test(`creates an uncataloged ${api} judge in a new provider namespace`, async () => {
			const modelsPath = write("models.yml", fixtureDocument());
			const registry = registryAt(modelsPath);
			const id = "@cf/nested/judge-1";

			const saved = await registry.createNativeJudgeRoute({ provider: "new-judge", id, api, baseUrl: ROOTS[api] });
			expect(saved).toMatchObject({ provider: "new-judge", id, api, baseUrl: ROOTS[api], kind: "judge" });
			const document = read(modelsPath);
			expect(document.providers["new-judge"]).toEqual({ models: [{ id, api, baseUrl: ROOTS[api] }] });
			expect(document.providers[PROVIDER]).toEqual(fixtureDocument().providers[PROVIDER]);

			// No key: declared but unavailable; a stored credential makes it available.
			expect(
				registryAt(modelsPath)
					.getAvailable("all")
					.some(model => model.provider === "new-judge"),
			).toBe(false);
			await authStorage.credentials.upsert("new-judge", { type: "api_key", key: TOKEN });
			const fresh = registryAt(modelsPath);
			expect(fresh.getError()).toBeUndefined();
			expect(fresh.getAvailable("all")).toContainEqual(expect.objectContaining({ provider: "new-judge", id, api }));
			expect(fs.readFileSync(modelsPath, "utf8")).not.toContain(
				`apiKey: ${TOKEN}\n    models:\n      - id: "${id}"`,
			);
		});
	}

	test("re-creating the same route reloads without writing; a different route conflicts", async () => {
		const modelsPath = write("models.yml", fixtureDocument());
		const registry = registryAt(modelsPath);
		const draft = { provider: "new-judge", id: "judge", api: "typesafe" as const, baseUrl: ROOTS.typesafe };
		await registry.createNativeJudgeRoute(draft);
		const before = fs.statSync(modelsPath).mtimeMs;
		const content = fs.readFileSync(modelsPath, "utf8");

		await expect(registry.createNativeJudgeRoute(draft)).resolves.toMatchObject({ api: "typesafe" });
		expect(fs.statSync(modelsPath).mtimeMs).toBe(before);
		await expect(registry.createNativeJudgeRoute({ ...draft, baseUrl: "https://other.invalid" })).rejects.toThrow(
			/already declared/,
		);
		await expect(registry.createNativeJudgeRoute({ ...draft, provider: PROVIDER, id: CHAT_ID })).rejects.toThrow(
			/already declared/,
		);
		await expect(
			registry.createNativeJudgeRoute({ ...draft, provider: "openai", id: "gpt-5.6-luna" }),
		).rejects.toThrow(/already in the catalog/);
		expect(fs.readFileSync(modelsPath, "utf8")).toBe(content);
	});

	test("rejects invalid drafts and edits without touching the file", async () => {
		const modelsPath = write("models.yml", fixtureDocument());
		const content = fs.readFileSync(modelsPath, "utf8");
		const registry = registryAt(modelsPath);
		const draft = { provider: "new-judge", id: "judge", api: "typesafe" as const, baseUrl: ROOTS.typesafe };
		for (const bad of [
			{ provider: "OpenRouter" },
			{ provider: "Native-Fixture" },
			{ id: " " },
			{ id: "a//b" },
			{ id: "../judge" },
			{ id: "judge?x" },
			{ api: "openai-completions" as JudgmentApi },
			{ baseUrl: `${ROOTS.typesafe}/v1/systemone` },
		]) {
			await expect(registry.createNativeJudgeRoute({ ...draft, ...bad })).rejects.toThrow();
		}
		const chat = registry.find(PROVIDER, CHAT_ID)!;
		await expect(registry.saveNativeJudgeRoute(chat, "typesafe", "https://x.invalid?key=1")).rejects.toThrow();
		await expect(
			registry.saveNativeJudgeRoute({ ...chat, id: "missing" }, "typesafe", ROOTS.typesafe),
		).rejects.toThrow(/no longer in the catalog/);
		expect(fs.readFileSync(modelsPath, "utf8")).toBe(content);
	});

	test("refuses duplicate declarations, invalid files, and gateway mode without writing", async () => {
		const duplicate = fixtureDocument();
		duplicate.providers[PROVIDER].models.push({ id: CHAT_ID });
		const duplicatePath = write("models.yml", duplicate);
		const registry = registryAt(duplicatePath);
		const chat = registry.find(PROVIDER, CHAT_ID)!;
		const content = fs.readFileSync(duplicatePath, "utf8");
		await expect(registry.saveNativeJudgeRoute(chat, "typesafe", ROOTS.typesafe)).rejects.toThrow(/duplicate/);
		expect(fs.readFileSync(duplicatePath, "utf8")).toBe(content);

		const broken = `providers:\n  ${PROVIDER}:\n    apiKey: ${TOKEN}\n    models: [unterminated\n`;
		fs.writeFileSync(duplicatePath, broken);
		const failure = await registry
			.saveNativeJudgeRoute(chat, "typesafe", ROOTS.typesafe)
			.catch((error: Error) => error);
		expect(failure).toBeInstanceOf(Error);
		expect((failure as Error).message).not.toContain(TOKEN);
		expect(fs.readFileSync(duplicatePath, "utf8")).toBe(broken);

		const gatewayPath = write("models.json", fixtureDocument());
		const gateway = registryAt(gatewayPath, { ignoreLocalModelConfig: true });
		await expect(
			gateway.createNativeJudgeRoute({
				provider: "new-judge",
				id: "judge",
				api: "typesafe",
				baseUrl: ROOTS.typesafe,
			}),
		).rejects.toThrow(/gateway mode/);
		expect(read(gatewayPath)).toEqual(fixtureDocument());
	});

	test("writes through a symlinked models.yml to its target", async () => {
		const target = write("real-models.yml", fixtureDocument());
		const link = path.join(dir, "models.yml");
		fs.symlinkSync(target, link);
		const registry = registryAt(link);

		await registry.saveNativeJudgeRoute(registry.find(PROVIDER, CHAT_ID)!, "typesafe", ROOTS.typesafe);
		expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
		expect(read(target).providers[PROVIDER].models[0]).toMatchObject({ api: "typesafe", baseUrl: ROOTS.typesafe });
	});

	test("concurrent writes keep each other's rows", async () => {
		const modelsPath = write("models.yml", fixtureDocument());
		const registry = registryAt(modelsPath);
		await Promise.all(
			["a", "b", "c"].map(id =>
				registry.createNativeJudgeRoute({ provider: "new-judge", id, api: "typesafe", baseUrl: ROOTS.typesafe }),
			),
		);
		expect(
			read(modelsPath)
				.providers["new-judge"].models.map(model => model.id)
				.sort(),
		).toEqual(["a", "b", "c"]);
	});
});
