/**
 * The credential `oauth.modifyModels` is handed is a copy, never the credential pool's record.
 *
 * The projection reads the stored credential with `authStorage.credentials.getOAuth`, which
 * returns the pool's own entry. Handed that object, an author's getter or assignment on it is read
 * later by every other subsystem that asks the pool for the credential — key resolution, usage
 * attribution, persistence — outside the session's admission and after it has gone. A session's
 * hook is handed a copy; a host registration still receives the pool's record, as it always has.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as path from "node:path";
import { ModelRegistry, type ProviderConfigInput } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { extensionCallbackScope } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";

const PROVIDER = "model-modifier-credential-copy";
const SOURCE = "model-modifier-credential-copy-source";

let dir: TempDir;
let auth: AuthStorage;
let registry: ModelRegistry;
let runtime: ExtensionRuntime;
let release: () => void;

beforeEach(async () => {
	dir = TempDir.createSync("@model-modifier-credential-copy-");
	auth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
	registry = new ModelRegistry(auth, path.join(dir.path(), "models.json"));
	runtime = new ExtensionRuntime();
	release = runtime.beginSession();
	await auth.credentials.set(PROVIDER, {
		type: "oauth",
		access: "stored-access",
		refresh: "stored-refresh",
		expires: Date.now() + 3_600_000,
		orgId: "org-a",
		region: "eu-old",
	});
});

afterEach(() => {
	release();
	registry.clearSourceRegistrations(SOURCE);
	auth.close();
	dir.removeSync();
});

type ModifyModels = NonNullable<NonNullable<ProviderConfigInput["oauth"]>["modifyModels"]>;

function config(modifyModels: ModifyModels): ProviderConfigInput {
	return {
		api: "openai-completions",
		baseUrl: "https://example.invalid",
		models: [
			{
				id: "model-modifier-credential-copy-model",
				name: "Model modifier credential copy",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 10_000,
				maxTokens: 100,
			},
		],
		oauth: {
			name: "Model modifier credential copy",
			login: async () => ({ access: "a", refresh: "r", expires: Date.now() + 3_600_000 }),
			modifyModels,
		},
	};
}

test("changing the credential modifyModels is handed changes nothing the pool holds", () => {
	const reads: boolean[] = [];
	let projected = false;
	registry.registerProvider(
		PROVIDER,
		config((models, credentials) => {
			projected = true;
			Object.defineProperty(credentials, "orgId", {
				configurable: true,
				enumerable: true,
				get() {
					const inside = extensionCallbackScope.getStore() === runtime;
					reads.push(inside);
					return inside ? "authored-org" : "substitute-org";
				},
			});
			credentials.region = "us-swapped";
			return models;
		}),
		SOURCE,
		runtime,
	);

	// What any other subsystem sees when it asks the pool for the credential.
	const pooled = auth.credentials.getOAuth(PROVIDER);
	const pooledOrg = pooled?.orgId;

	expect(projected).toBe(true);
	expect(reads.filter(inside => !inside)).toEqual([]);
	expect(pooled && Object.getOwnPropertyDescriptor(pooled, "orgId")).toMatchObject({ value: "org-a" });
	expect({ orgId: pooledOrg, region: pooled?.region }).toEqual({ orgId: "org-a", region: "eu-old" });
});

test("a host registration's modifyModels is still handed the pool's record", () => {
	const handed: unknown[] = [];
	registry.registerProvider(
		PROVIDER,
		config((models, credentials) => {
			handed.push(credentials);
			return models;
		}),
		SOURCE,
	);

	expect(handed.length).toBeGreaterThan(0);
	expect(handed[0]).toBe(auth.credentials.getOAuth(PROVIDER));
});
