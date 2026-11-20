/**
 * Regression for #12310: Enter on a model row, then Enter again on the same row
 * after the assignment settles, must not undo the role that was just committed.
 * The committed role chip reads as assigned, so its action flips to unassign,
 * and the repeat Enter used to clear the role (`clearProjectModelRole` writes
 * `null`) and fall the session back to the previous model.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	ModelHubComponent,
	type ModelHubCallbacks,
	type ModelHubRegistry,
	type ModelHubSource,
} from "../src/overlays/model-hub";
import { initTheme } from "../src/theme";
import type { TUI } from "../src/index";

// The hub only reads terminal rows and requests renders.
const tuiStub = { requestRender: () => {}, terminal: { rows: 30 } } as unknown as TUI;

const ENTER = "\r";
const RIGHT = "\x1b[C";
const DOWN = "\x1b[B";
const UP = "\x1b[A";

function model(id: string) {
	return buildModel({
		id,
		name: id,
		api: "ollama-chat",
		provider: "litellm",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 1024,
	});
}

const registryStub: ModelHubRegistry = {
	getError: () => undefined,
	getAvailable: () => [],
	getAll: () => [],
	authStorage: { keys: { source: () => undefined } },
	getDiscoverableProviders: () => [],
	getProviderDiscoveryState: () => undefined,
	find: () => undefined,
	refresh: async () => {},
	refreshProvider: async () => {},
};

/** Project-scoped role storage: `onAssign` / `onUnassign` write it the way the controller does. */
function createHarness(models: ReturnType<typeof model>[]) {
	const projectRoles = new Map<string, string>();
	const assigned: string[] = [];
	const unassigned: string[] = [];
	const source: ModelHubSource = {
		revision: 0,
		disabledProviders: [],
		fallbackChains: {},
		modelRoleStorage: "project",
		cycleOrder: [],
		getProjectModelRole: role => projectRoles.get(role),
		getGlobalModelRole: () => undefined,
		getModelRoleSource: role => (projectRoles.has(role) ? "project" : "default"),
		defaultThinkingLevel: "off",
		modelProviderOrder: [],
		knownRoleIds: ["default"],
		mruOrder: [],
		modelPerf: new Map(),
		getModelRole: role => projectRoles.get(role),
		getRoleInfo: role => ({ name: role, section: "chat", accepts: () => true }),
		defaultRoleChain: () => [],
		resolveRoleValue: (value, pool) => {
			const id = value?.split(":")[0];
			return {
				model: pool.find(candidate => `${candidate.provider}/${candidate.id}` === id),
				explicitThinkingLevel: false,
			};
		},
	};
	const callbacks: ModelHubCallbacks = {
		// The controller's onAssign is async: the write lands after an await, so the hub is pending meanwhile.
		onAssign: async (_model, role, _level, selector) => {
			await Bun.sleep(0);
			assigned.push(`${role}:${selector}`);
			projectRoles.set(role, selector ?? "");
			return true;
		},
		onUnassign: role => {
			unassigned.push(role);
			projectRoles.delete(role);
		},
		onCancel: () => {},
	};
	const hub = new ModelHubComponent(
		tuiStub,
		source,
		registryStub,
		models.map(m => ({ model: m })),
		callbacks,
	);
	return { key: (data: string) => hub.handleInput(data), assigned, unassigned, projectRoles };
}

/** Let the async assign finish and the hub settle. */
async function settle(): Promise<void> {
	await Bun.sleep(0);
	await Bun.sleep(0);
}

beforeAll(async () => {
	await initTheme(false);
});

describe("model hub repeated Enter on a just-committed row (#12310)", () => {
	test("Enter pressed again on the row that was just assigned keeps the role", async () => {
		const opus = model("chat-a");
		const { key, assigned, unassigned, projectRoles } = createHarness([opus]);

		key(RIGHT); // sidebar → rows
		key(ENTER); // open the role strip for the row
		key(ENTER); // assign the default role
		// Enters that land while the assignment is still applying
		key(ENTER);
		key(ENTER);
		await settle();
		// The next Enter lands on the same row after the commit: the strip opens, then its chip is pressed again
		key(ENTER);
		key(ENTER);
		await settle();

		expect(assigned).toEqual(["default:litellm/chat-a"]);
		expect(unassigned).toEqual([]);
		expect(projectRoles.get("default")).toBe("litellm/chat-a");
	});

	test("after the cursor leaves the committed row, its chip unassigns the role", async () => {
		const first = model("chat-a");
		const second = model("chat-b");
		const { key, unassigned, projectRoles } = createHarness([first, second]);

		key(RIGHT);
		key(ENTER);
		key(ENTER); // assign the default role to the first row
		await settle();
		key(DOWN); // the cursor leaves the committed row
		key(UP);
		key(ENTER); // open the strip for the committed row again
		key(ENTER); // deliberately press its assigned chip

		await settle();
		expect(unassigned).toEqual(["default"]);
		expect(projectRoles.has("default")).toBe(false);
	});
});
