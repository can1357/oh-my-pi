import { describe, expect, it } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { createRoot } from "@oh-my-pi/pi-tui";
import { paintNode } from "@oh-my-pi/pi-tui/term/paint";
import { plainRows } from "@oh-my-pi/pi-tui/testing/cells";
import { corpusEnvironment } from "@oh-my-pi/pi-tui/testing/corpus";
import {
	arbitrateMentions,
	AgentsMentionSource,
	MATCH_TIER,
	McpMentionSource,
	SshMentionSource,
	type MentionItem,
	type MentionQuery,
	type MentionSource,
	type MentionSourceMeta,
	type MentionSourceResult,
	parseMentionQuery,
	UnifiedMentionEngine,
} from "../../src/autocomplete/mentions";
import { createPromptActionAutocompleteProvider } from "../../src/autocomplete/prompt-actions";
import { KeybindingsManager } from "../../src/config/keybindings/keybindings";
import type { MeshPeer } from "../../src/irc/mesh-protocol";
import type { AgentRef } from "../../src/registry/agent-registry";
import { Composer } from "../../src/ui/composer/composer";
import { key, sendKey } from "../ui/composer/harness";

function fakeItem(
	category: MentionItem["category"],
	id: string,
	label: string,
	tier: MentionItem["tier"],
	extra?: Partial<MentionItem>,
): MentionItem {
	return {
		category,
		tier,
		value: id,
		insertText: id,
		appendSpace: true,
		label,
		pickerItem: { id: `${category}:${id}`, label },
		...extra,
	};
}

describe("parseMentionQuery", () => {
	it("routes @, ^, and #<N> into unified mention queries with proper syntax locks", () => {
		const bareAt = parseMentionQuery("ask @");
		expect(bareAt).toMatchObject({
			trigger: "@",
			prefix: "@",
			query: "",
		});
		expect(bareAt?.syntaxLock).toBeUndefined();
		expect(parseMentionQuery("ask ^opus:h")).toMatchObject({
			trigger: "^",
			prefix: "^opus:h",
			query: "opus",
			syntaxLock: "models",
			modelEffortSuffix: "h",
		});
		expect(parseMentionQuery("see #3164")).toMatchObject({
			trigger: "#",
			prefix: "#3164",
			query: "3164",
			syntaxLock: "forge",
		});
		expect(parseMentionQuery("see pr #42")).toMatchObject({
			trigger: "#",
			prefix: "pr #42",
			query: "42",
			syntaxLock: "forge",
			subKind: "pr",
		});
	});

	it("handles explicit namespaces, line ranges, hex SHAs, and provider-vs-directory slash disambiguation", () => {
		expect(parseMentionQuery("@peer:auth")).toMatchObject({
			syntaxLock: "agents",
			subKind: "peer",
			query: "auth",
		});
		expect(parseMentionQuery("@branch:feat/x")).toMatchObject({
			syntaxLock: "vcs",
			subKind: "branch",
			query: "feat/x",
		});
		expect(parseMentionQuery("@session:auth")).toMatchObject({
			syntaxLock: "sessions",
			query: "auth",
		});
		expect(parseMentionQuery("@chat:debug")).toMatchObject({
			syntaxLock: "sessions",
			query: "debug",
		});
		expect(parseMentionQuery("@diff:")).toMatchObject({ syntaxLock: "vcs", subKind: "diff", query: "" });
		expect(parseMentionQuery("@mcp:notes")).toMatchObject({ syntaxLock: "mcp", query: "notes" });
		expect(parseMentionQuery("@ssh:prod")).toMatchObject({ syntaxLock: "ssh", query: "prod" });
		// One-letter canonical tokens: `s` is SSH, sessions moved to `h`, and PRs/issues split.
		expect(parseMentionQuery("@s:prod")).toMatchObject({ syntaxLock: "ssh", query: "prod" });
		expect(parseMentionQuery("@h:auth")).toMatchObject({ syntaxLock: "sessions", query: "auth" });
		expect(parseMentionQuery("@r:notes")).toMatchObject({ syntaxLock: "mcp", query: "notes" });
		expect(parseMentionQuery("@p:12")).toMatchObject({ syntaxLock: "forge", subKind: "pr", query: "12" });
		expect(parseMentionQuery("@i:")).toMatchObject({ syntaxLock: "forge", subKind: "issue", query: "" });
		expect(parseMentionQuery("@#99")).toMatchObject({
			syntaxLock: "forge",
			query: "99",
		});
		expect(parseMentionQuery("@composer.tsx:42-80")).toMatchObject({
			syntaxLock: "files",
			query: "composer.tsx",
			fileLineSuffix: ":42-80",
		});
		expect(parseMentionQuery("@a1b2c3d")).toMatchObject({
			syntaxLock: "vcs",
			query: "a1b2c3d",
		});

		const hints = {
			isKnownProvider: (head: string) => head === "anthropic",
			isKnownDir: (head: string) => head === "src",
		};
		expect(parseMentionQuery("@anthropic/opus", hints)?.syntaxLock).toBe("models");
		expect(parseMentionQuery("@src/ui", hints)?.syntaxLock).toBe("files");
		expect(parseMentionQuery("@feat/auth", hints)?.syntaxLock).toBeUndefined();
	});

	it("ignores embedded email addresses and plain prose", () => {
		expect(parseMentionQuery("user@example.com")).toBeNull();
		expect(parseMentionQuery("just typing prose")).toBeNull();
	});
});

describe("arbitrateMentions (Intent Arbiter & Anti-Noise Budgeting)", () => {
	const metas: MentionSourceMeta[] = [
		{ id: "files", label: "Files" },
		{ id: "models", label: "Models" },
		{ id: "agents", label: "Agents" },
		{ id: "sessions", label: "Sessions" },
		{ id: "vcs", label: "Git" },
		{ id: "forge", label: "GitHub" },
	];

	it("lists only the available @category: shortcuts on bare @", () => {
		const query: MentionQuery = { trigger: "@", prefix: "@", query: "", rawBody: "" };
		const results: MentionSourceResult[] = [
			{
				category: "files",
				items: Array.from({ length: 50 }, (_, i) => fakeItem("files", `@f${i}.ts`, `f${i}.ts`, MATCH_TIER.Medium)),
				bestTier: MATCH_TIER.Medium,
				total: 50,
				available: true,
			},
			{
				category: "models",
				items: Array.from({ length: 20 }, (_, i) => fakeItem("models", `^m/${i}`, `Model ${i}`, MATCH_TIER.Medium)),
				bestTier: MATCH_TIER.Medium,
				total: 20,
				available: true,
			},
			{
				category: "agents",
				items: Array.from({ length: 10 }, (_, i) =>
					fakeItem("agents", `agent://a${i}`, `Agent ${i}`, MATCH_TIER.Medium),
				),
				bestTier: MATCH_TIER.Medium,
				total: 10,
				available: true,
			},
			{
				category: "sessions",
				items: [fakeItem("sessions", "session://abc", "Auth debug", MATCH_TIER.Medium)],
				bestTier: MATCH_TIER.Medium,
				total: 1,
				available: true,
			},
			{
				category: "vcs",
				items: [],
				bestTier: MATCH_TIER.None,
				total: 0,
				available: false,
			},
		];

		const out = arbitrateMentions(query, results, metas);
		expect(out.items.map(i => i.insertText)).toEqual(["@f:", "@m:", "@a:", "@h:"]);
		expect(out.items.every(i => i.isNamespaceShortcut === true && i.appendSpace === false)).toBe(true);
	});

	it("suppresses weak cross-category noise and auto-focuses a clear winner", () => {
		const query: MentionQuery = { trigger: "@", prefix: "@opus", query: "opus", rawBody: "opus" };
		const results: MentionSourceResult[] = [
			{
				category: "models",
				items: [
					fakeItem("models", "^anthropic/claude-opus-4-6", "Claude Opus 4.6", MATCH_TIER.Strong),
					fakeItem("models", "^anthropic/claude-opus-4-5", "Claude Opus 4.5", MATCH_TIER.Strong),
				],
				bestTier: MATCH_TIER.Strong,
				total: 2,
				available: true,
			},
			{
				category: "files",
				items: [fakeItem("files", "@src/policy/utils/state.ts", "state.ts", MATCH_TIER.Weak)],
				bestTier: MATCH_TIER.Weak,
				total: 1,
				available: true,
			},
		];

		const out = arbitrateMentions(query, results, metas);
		expect(out.items.map(i => i.category)).toEqual(["models", "models"]);
		expect(out.palette.lockedScope).toBe("models");
	});

	it("keeps Files on top when tied with another strong category", () => {
		const query: MentionQuery = { trigger: "@", prefix: "@main", query: "main", rawBody: "main" };
		const results: MentionSourceResult[] = [
			{
				category: "vcs",
				items: [fakeItem("vcs", "git://branch/main", "main", MATCH_TIER.Exact)],
				bestTier: MATCH_TIER.Exact,
				total: 1,
				available: true,
			},
			{
				category: "files",
				items: [fakeItem("files", "@src/main.ts", "main.ts", MATCH_TIER.Exact)],
				bestTier: MATCH_TIER.Exact,
				total: 1,
				available: true,
			},
		];

		const out = arbitrateMentions(query, results, metas);
		expect(out.items[0]!.category).toBe("files");
		expect(new Set(out.items.map(i => i.category))).toEqual(new Set(["files", "vcs"]));
		expect(out.palette.lockedScope).toBeUndefined();
	});
});

describe("AgentsMentionSource (local & foreign mesh subagents)", () => {
	it("surfaces both local subagents and foreign mesh peers synchronously with local running ranked first", () => {
		const localRefs: AgentRef[] = [
			{
				id: "Scout",
				generation: 1,
				displayName: "Scout",
				kind: "sub",
				status: "running",
				session: null,
				sessionFile: null,
				createdAt: 100,
				lastActivity: 500,
				activity: "scanning surface/kinds",
			},
			{
				id: "HiddenAdvisor",
				generation: 2,
				displayName: "Advisor",
				kind: "advisor",
				status: "idle",
				session: null,
				sessionFile: null,
				createdAt: 100,
				lastActivity: 400,
			},
		];
		const peers: MeshPeer[] = [
			{
				pid: 4812,
				project: "/work/app",
				title: "COMMIT: Very long session title that would truncate away subagent names",
				sessionFile: null,
				status: "idle",
				agents: [
					{ id: "WorkerA", status: "running", sessionFile: "/tmp/worker-a.jsonl" },
					{ id: "ParkedOld", status: "parked", sessionFile: "/tmp/parked.jsonl" },
				],
			},
		];

		const source = new AgentsMentionSource({
			registry: () => ({ list: () => localRefs }),
			peers: () => peers,
		});

		// Unlocked `@` omits parked agents and leads foreign subagents with their own `sub.id` (no clones).
		const all = source.querySync({ trigger: "@", prefix: "@", query: "", rawBody: "" });
		expect(all.available).toBe(true);
		expect(all.items.map(i => i.insertText)).toEqual(["agent://Scout", "agent://4812/WorkerA", "agent://4812"]);
		expect(all.items[1]!.label).toBe("WorkerA");
		expect(all.items[1]!.pickerItem.badges?.some(b => b.text === "peer")).toBe(true);

		// Explicit `@peer:` includes parked peers too.
		const peersOnly = source.querySync({
			trigger: "@",
			prefix: "@peer:",
			query: "",
			rawBody: "peer:",
			syntaxLock: "agents",
			subKind: "peer",
		});
		expect(peersOnly.items.map(i => i.insertText)).toEqual([
			"agent://4812/WorkerA",
			"agent://4812",
			"agent://4812/ParkedOld",
		]);
	});
});

describe("McpMentionSource & SshMentionSource", () => {
	it("lists concrete MCP resources (not templates) and loads unloaded catalogs in the async pass", async () => {
		const catalogs = new Map<string, { resources: { uri: string; name: string }[]; templates: never[] }>([
			["notes", { resources: [{ uri: "test://notes/today", name: "Today" }], templates: [] }],
		]);
		const ensured: string[] = [];
		const manager = {
			getConnectedServers: () => ["notes", "ibkr"],
			getServerResources: (name: string) => catalogs.get(name),
			ensureServerResources: async (name: string) => {
				ensured.push(name);
				catalogs.set(name, {
					resources: [{ uri: "ibkr://portfolio/positions", name: "Positions" }],
					templates: [],
				});
			},
		};
		const source = new McpMentionSource({ manager: () => manager as never });
		const q = parseMentionQuery("@mcp:")!;

		const sync = source.querySync(q);
		expect(sync.items.map(i => i.insertText)).toEqual(["mcp://test://notes/today"]);
		expect(sync.loading).toBe(true);

		const final = await source.queryAsync(q, new AbortController().signal, () => {});
		expect(ensured).toEqual(["ibkr"]);
		expect(final!.items.map(i => i.insertText)).toEqual([
			"mcp://test://notes/today",
			"mcp://ibkr://portfolio/positions",
		]);

		// Unlocked `@`: only strong label/uri matches surface, never fuzzy noise.
		expect(source.querySync(parseMentionQuery("@pos")!).items.map(i => i.label)).toEqual(["Positions"]);
		expect(source.querySync(parseMentionQuery("@tsn")!).items).toEqual([]);
	});

	it("ranks configured SSH hosts and inserts ssh://<host>/", async () => {
		const source = new SshMentionSource({
			getCwd: () => "/repo",
			loadHosts: async () =>
				[
					{ name: "prod-db", host: "10.0.0.5", username: "deploy" },
					{ name: "staging", host: "staging.example.com" },
				] as never,
		});
		const q = parseMentionQuery("@ssh:")!;
		const cold = source.querySync(q);
		expect(cold.loading).toBe(true);
		const loaded = await source.queryAsync(q, new AbortController().signal, () => {});
		expect(loaded!.items.map(i => i.insertText)).toEqual(["ssh://prod-db/", "ssh://staging/"]);
		expect(loaded!.items[0]!.description).toBe("deploy@10.0.0.5");

		const unlocked = source.querySync(parseMentionQuery("@stag")!);
		expect(unlocked.items.map(i => i.label)).toEqual(["staging"]);
	});
});

describe("UnifiedMentionEngine async streaming & composer integration", () => {
	it("returns Tier 0 sync results immediately while slow async source streams later", async () => {
		const { promise: slowPromise, resolve: resolveSlow } = Promise.withResolvers<MentionSourceResult>();

		const fastSource: MentionSource = {
			id: "models",
			label: "Models",
			querySync: () => ({
				category: "models",
				items: [
					fakeItem("models", "^anthropic/claude-opus-4-6", "Claude Opus 4.6", MATCH_TIER.Strong, {
						modelEffort: {
							selector: "anthropic/claude-opus-4-6",
							displayName: "Claude Opus 4.6",
							supported: [Effort.Low, Effort.Medium, Effort.High, Effort.Max],
							selected: "auto",
							provider: "anthropic",
						},
					}),
				],
				bestTier: MATCH_TIER.Strong,
				total: 1,
				available: true,
			}),
		};
		const slowSource: MentionSource = {
			id: "files",
			label: "Files",
			querySync: () => ({
				category: "files",
				items: [],
				bestTier: MATCH_TIER.None,
				total: 0,
				loading: true,
				available: true,
			}),
			queryAsync: async () => slowPromise,
		};

		const engine = new UnifiedMentionEngine({
			getBasePath: () => process.cwd(),
			sources: [fastSource, slowSource],
		});

		const syncSnap = engine.querySync(["@op"], 0, 3);
		expect(syncSnap).not.toBeNull();
		expect(syncSnap!.items[0]!.insertText).toBe("^anthropic/claude-opus-4-6");
		expect(syncSnap!.hasAsyncPending).toBe(true);
		expect(syncSnap!.mention.loading).toBe(true);

		const partials: number[] = [];
		const asyncTask = engine.queryAsync(["@op"], 0, 3, undefined, snap => {
			partials.push(snap.items.length);
		});
		resolveSlow({
			category: "files",
			items: [fakeItem("files", "@src/op.ts", "op.ts", MATCH_TIER.Exact)],
			bestTier: MATCH_TIER.Exact,
			total: 1,
			loading: false,
			available: true,
		});
		const final = await asyncTask;
		expect(final).not.toBeNull();
		expect(final!.items.map(i => i.category)).toContain("files");
		expect(final!.mention.loading).toBe(false);
		expect(partials.length).toBeGreaterThanOrEqual(1);
	});

	it("supports the bare-@ category strip and Shift+Left/Right effort stepping in Composer", () => {
		const modelSource: MentionSource = {
			id: "models",
			label: "Models",
			querySync: () => ({
				category: "models",
				items: [
					fakeItem("models", "^anthropic/claude-opus-4-6", "Claude Opus 4.6", MATCH_TIER.Exact, {
						modelEffort: {
							selector: "anthropic/claude-opus-4-6",
							displayName: "Claude Opus 4.6",
							supported: [Effort.Low, Effort.High, Effort.Max],
							selected: "auto",
							provider: "anthropic",
						},
					}),
				],
				bestTier: MATCH_TIER.Exact,
				total: 1,
				available: true,
			}),
		};
		const fileSource: MentionSource = {
			id: "files",
			label: "Files",
			querySync: () => ({
				category: "files",
				items: [fakeItem("files", "@src/index.ts", "index.ts", MATCH_TIER.Exact)],
				bestTier: MATCH_TIER.Exact,
				total: 1,
				available: true,
			}),
		};

		const engine = new UnifiedMentionEngine({
			getBasePath: () => process.cwd(),
			sources: [fileSource, modelSource],
		});
		const provider = createPromptActionAutocompleteProvider({
			commands: [],
			basePath: process.cwd(),
			unifiedMentions: engine,
			keybindings: KeybindingsManager.inMemory(),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});

		createRoot(() => {
			const composer = new Composer({ autocomplete: provider });
			const env = corpusEnvironment("dark");
			paintNode(env, composer.node, 80);

			// Type `@` → a strip of the categories alone, the lit one's token and description below.
			sendKey(composer.node, composer.field, key("@"));
			expect(composer.completing()).toBe(true);

			const popupRows = plainRows(paintNode(env, composer.node, 80).rows)
				.slice(2)
				.join("\n");
			expect(popupRows).not.toContain("index.ts");
			expect(popupRows).toMatch(/Files.*Models/);
			expect(popupRows).toContain("@f:  Tag a file or directory");
			expect(popupRows).not.toContain("──");

			// Tab lights the next category in place; typing then enters it.
			composer.handleDraftKey({ id: "tab", kind: "press", raw: "\t" });
			expect(composer.text()).toBe("@");
			expect(plainRows(paintNode(env, composer.node, 80).rows).join("\n")).toContain("@m:  Tag a model");
			sendKey(composer.node, composer.field, key("c"));
			expect(composer.text()).toBe("@m:c");
			expect(composer.completing()).toBe(true);

			// Default model mention does NOT force a thinking suffix or show a Thinking bar.
			const modelPainted = plainRows(paintNode(env, composer.node, 80).rows).join("\n");
			expect(modelPainted).toContain("Claude Opus 4.6");
			expect(modelPainted).not.toContain("Thinking:");

			// Opting into an explicit thinking level via Shift+Right reveals the Thinking bar.
			composer.handleDraftKey({ id: "shift+right", kind: "press", raw: "" });
			composer.handleDraftKey({ id: "shift+right", kind: "press", raw: "" });
			const effortPainted = plainRows(paintNode(env, composer.node, 80).rows).join("\n");
			expect(effortPainted).toContain("Thinking:");
			composer.handleDraftKey({ id: "tab", kind: "press", raw: "\t" });
			expect(composer.text()).toBe("^anthropic/claude-opus-4-6:high ");

			// Typing right after `@` without cycling stays a plain search: Files lead; Tab inserts `@src/index.ts `.
			sendKey(composer.node, composer.field, key("@"));
			sendKey(composer.node, composer.field, key("i"));
			expect(composer.completing()).toBe(true);
			composer.handleDraftKey({ id: "tab", kind: "press", raw: "\t" });
			expect(composer.text()).toBe("^anthropic/claude-opus-4-6:high @src/index.ts ");
		});
	});
});
