import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as path from "node:path";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { createRoot, setNativeRenderingForTest, type UiNode } from "@oh-my-pi/pi-tui";
import { bubbleEvent } from "@oh-my-pi/pi-tui/dispatch";
import { paintNode } from "@oh-my-pi/pi-tui/term/paint";
import { plainRows } from "@oh-my-pi/pi-tui/testing/cells";
import { corpusEnvironment } from "@oh-my-pi/pi-tui/testing/corpus";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";
import {
	arbitrateMentions,
	AgentsMentionSource,
	MATCH_TIER,
	McpMentionSource,
	SessionsMentionSource,
	SshMentionSource,
	type MentionItem,
	type MentionMesh,
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
import * as sessionIndex from "../../src/session/session-index";
import * as sessionPaths from "../../src/session/session-paths";
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

it("warms indexed sessions without hiding the unindexed sessions on the first query", async () => {
	const temp = TempDir.createSync("@pi-session-mentions-");
	const cwd = temp.path();
	const indexed = "01900000-0000-7000-8000-000000000001";
	const unindexed = "01900000-0000-7000-8000-000000000002";
	const sessionDir = spyOn(sessionPaths, "sessionDirForCwd").mockReturnValue(cwd);
	const titles = spyOn(sessionIndex, "listSessionTitles").mockReturnValue(new Map([[indexed, "Indexed session"]]));
	const recordTitles = spyOn(sessionIndex, "recordSessionTitles").mockImplementation(() => {});
	try {
		for (const [id, title] of [
			[indexed, "Indexed session"],
			[unindexed, "Unindexed session"],
		]) {
			const timestamp = "2026-06-27T00:00:00.000Z";
			await Bun.write(
				path.join(cwd, `2026-06-27T00-00-00-000Z_${id}.jsonl`),
				`${JSON.stringify({ type: "session", id, cwd, title, timestamp })}\n`,
			);
		}
		const query = parseMentionQuery("@ses:");
		if (!query) throw new Error("Expected a session mention query");
		const source = new SessionsMentionSource({ getCwd: () => cwd });
		await source.warm();
		expect(source.querySync(query).items.map(item => item.insertText)).toEqual([`session://${indexed}`]);
		const refined = await source.queryAsync(query, new AbortController().signal, () => {});
		expect(refined?.items.map(item => item.insertText).sort()).toEqual([
			`session://${indexed}`,
			`session://${unindexed}`,
		]);
	} finally {
		recordTitles.mockRestore();
		titles.mockRestore();
		sessionDir.mockRestore();
		await temp.remove();
	}
});

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
		const agents = parseMentionQuery("@p2p:auth");
		expect(agents).toMatchObject({ syntaxLock: "agents", query: "auth" });
		expect(agents?.subKind).toBeUndefined();
		expect(parseMentionQuery("@m:opus:high")).toMatchObject({
			syntaxLock: "models",
			query: "opus",
			modelEffortSuffix: "high",
		});
		expect(parseMentionQuery("@ses:auth")).toMatchObject({ syntaxLock: "sessions", query: "auth" });
		expect(parseMentionQuery("@git:main")).toMatchObject({ syntaxLock: "vcs", query: "main" });
		expect(parseMentionQuery("@git:branch:feat/x")).toMatchObject({
			syntaxLock: "vcs",
			subKind: "branch",
			query: "feat/x",
		});
		expect(parseMentionQuery("@git:diff:")).toMatchObject({ syntaxLock: "vcs", subKind: "diff", query: "" });
		expect(parseMentionQuery("@mcp:notes")).toMatchObject({ syntaxLock: "mcp", query: "notes" });
		expect(parseMentionQuery("@ssh:prod")).toMatchObject({ syntaxLock: "ssh", query: "prod" });
		expect(parseMentionQuery("@pr:12")).toMatchObject({ syntaxLock: "forge", subKind: "pr", query: "12" });
		expect(parseMentionQuery("@iss:")).toMatchObject({ syntaxLock: "forge", subKind: "issue", query: "" });
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

	it("locks to files by path syntax, not by the removed files token", () => {
		expect(parseMentionQuery("@f:")?.syntaxLock).toBeUndefined();
		expect(parseMentionQuery("@./x")).toMatchObject({ syntaxLock: "files", query: "./x" });
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
		{ id: "mcp", label: "MCP" },
		{ id: "ssh", label: "SSH" },
	];

	it("lists what Files predicts on a bare @ without locking it, beside every registered scope", () => {
		const query: MentionQuery = { trigger: "@", prefix: "@", query: "", rawBody: "" };
		const results: MentionSourceResult[] = [
			{
				category: "files",
				items: Array.from({ length: 50 }, (_, i) => fakeItem("files", `@f${i}.ts`, `f${i}.ts`, MATCH_TIER.Medium)),
				bestTier: MATCH_TIER.Medium,
				total: 150,
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
		// Files alone, as deep as a locked scope lists, though nothing locks the mention to it.
		expect(out.items.map(i => i.insertText)).toEqual(Array.from({ length: 20 }, (_, i) => `@f${i}.ts`));
		expect(out.palette.scope).toBeUndefined();
		expect(out.palette.lockedScope).toBeUndefined();
		// The scope bar Tern draws: ids, labels and icons in Tab order, a count only for 1..99 matches.
		expect(out.palette.scopes).toEqual([
			{ id: "files", label: "Files", icon: "file" },
			{ id: "models", label: "Models", icon: "cpu", count: 20 },
			{ id: "agents", label: "Agents", icon: "users", count: 10 },
			{ id: "sessions", label: "Sessions", icon: "message", count: 1 },
			{ id: "git", label: "Git", icon: "git-branch" },
			{ id: "pr", label: "PRs", icon: "pr" },
			{ id: "issue", label: "Issues", icon: "info" },
			{ id: "mcp", label: "MCP", icon: "mcp" },
			{ id: "ssh", label: "SSH", icon: "host" },
		]);
	});

	it("reports the scope a mention's syntax names and what is typed after the scope token", () => {
		const palette = (text: string, sources = metas) => {
			const { scope, typed } = arbitrateMentions(parseMentionQuery(text)!, [], sources).palette;
			return { scope, typed };
		};
		expect(palette("@m:opus:high")).toEqual({ scope: "models", typed: "opus:high" });
		expect(palette("@iss:")).toEqual({ scope: "issue", typed: "" });
		expect(palette("@git:branch:feat")).toEqual({ scope: "git", typed: "branch:feat" });
		expect(palette("@./src")).toEqual({ scope: "files", typed: "./src" });
		expect(palette("^opus:h")).toEqual({ scope: "models", typed: "opus:h" });
		// A reference that names neither kind lights pull requests.
		expect(palette("see #3164")).toEqual({ scope: "pr", typed: "3164" });
		expect(palette("see issue #42")).toEqual({ scope: "issue", typed: "42" });
		// A category without a registered source has no scope to light.
		expect(palette("^opus", [{ id: "files", label: "Files" }])).toEqual({ scope: undefined, typed: "opus" });

		// Pull requests and issues share a source: either is counted only while the query narrows to it.
		const forge: MentionSourceResult = {
			category: "forge",
			items: [fakeItem("forge", "pr://7", "#7", MATCH_TIER.Medium)],
			bestTier: MATCH_TIER.Medium,
			total: 7,
			available: true,
		};
		const counted = (text: string) =>
			arbitrateMentions(parseMentionQuery(text)!, [forge], metas)
				.palette.scopes.filter(scope => scope.count !== undefined)
				.map(scope => `${scope.id}:${scope.count}`);
		expect(counted("@pr:")).toEqual(["pr:7"]);
		expect(counted("@fix")).toEqual([]);
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
		// The winner takes the list over; the mention is still in no scope.
		expect(out.palette.scope).toBeUndefined();
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
		{ pid: 7001, project: "/work/stencil", title: "MENT", sessionFile: null, status: "running", agents: [] },
	];
	const mesh: MentionMesh = {
		project: "/work/app",
		peers: options => (options?.allProjects ? peers : peers.filter(peer => peer.project === "/work/app")),
	};

	const source = new AgentsMentionSource({
		registry: () => ({ list: () => localRefs }),
		mesh: () => mesh,
	});

	it("surfaces local subagents and same-folder mesh peers synchronously for plain @", () => {
		// Unlocked `@` omits parked agents and other projects, and leads foreign subagents with their own `sub.id` (no clones).
		const all = source.querySync({ trigger: "@", prefix: "@", query: "", rawBody: "" });
		expect(all.available).toBe(true);
		expect(all.items.map(i => i.insertText)).toEqual(["agent://Scout", "agent://4812/WorkerA", "agent://4812"]);
		expect(all.items[1]!.label).toBe("WorkerA");
		expect(all.items[1]!.pickerItem.badges?.some(b => b.text === "peer")).toBe(true);
	});

	it("includes other projects in @p2p: and ranks same-folder peers first", () => {
		const locked = source.querySync(parseMentionQuery("@p2p:")!);
		expect(locked.items.map(i => i.insertText)).toEqual([
			"agent://Scout",
			"agent://4812/WorkerA",
			"agent://4812",
			"agent://4812/ParkedOld",
			"agent://7001",
			"agent://all",
		]);
		expect(locked.items.find(i => i.insertText === "agent://7001")?.pickerItem.facts?.right).toBe(
			"stencil · pid 7001",
		);
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
});

describe("mention scope bar in Composer", () => {
	afterEach(() => {
		setNativeRenderingForTest(false);
	});

	function findPicker(node: UiNode): UiNode<"picker"> | undefined {
		if (node.kind === "picker") return node as UiNode<"picker">;
		for (const child of node.children()) {
			const hit = findPicker(child);
			if (hit) return hit;
		}
		return undefined;
	}

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
	const agentSource: MentionSource = {
		id: "agents",
		label: "Agents",
		querySync: () => ({ category: "agents", items: [], bestTier: MATCH_TIER.None, total: 0, available: false }),
	};

	/** A composer over `sources`: by default one file, one model with thinking levels, and Agents listing nothing. */
	function mentionComposer(sources: readonly MentionSource[] = [fileSource, modelSource, agentSource]) {
		const provider = createPromptActionAutocompleteProvider({
			commands: [],
			basePath: process.cwd(),
			unifiedMentions: new UnifiedMentionEngine({ getBasePath: () => process.cwd(), sources }),
			keybindings: KeybindingsManager.inMemory(),
			copyCurrentLine: () => {},
			copyPrompt: () => {},
			undo: () => {},
			moveCursorToMessageEnd: () => {},
			moveCursorToMessageStart: () => {},
			moveCursorToLineStart: () => {},
			moveCursorToLineEnd: () => {},
		});
		const composer = new Composer({ autocomplete: provider });
		const env = corpusEnvironment("dark");
		paintNode(env, composer.node, 80);
		/** The props of the picker the native terminal draws; undefined while the popup is closed. */
		const picker = (): TspPickerProps | undefined => findPicker(composer.node)?.props();
		return {
			composer,
			picker,
			type(text: string): void {
				for (const char of text) sendKey(composer.node, composer.field, key(char));
			},
			tab: () => composer.handleDraftKey({ id: "tab", kind: "press", raw: "\t" }),
			shiftTab: () => composer.handleDraftKey({ id: "shift+tab", kind: "press", raw: "\x1b[Z" }),
			backspace: () => sendKey(composer.node, composer.field, key("\x7f")),
			/** A click on the empty state's Clear search. */
			clear: () => bubbleEvent([findPicker(composer.node)!], { type: "action", key: "", act: "clear", mods: [] }),
			/** A click on a scope button of the bar. */
			click: (scope: string) =>
				bubbleEvent([findPicker(composer.node)!], {
					type: "action",
					key: "",
					act: "scope",
					value: scope,
					mods: [],
				}),
			/** The rows painted under the field: the scope strip, then the list. */
			popup: (width = 80) => plainRows(paintNode(env, composer.node, width).rows).slice(2),
			/** The draft, and the scope the open popup reports (`closed` without one). */
			state: () => ({ text: composer.text(), scope: composer.completing() ? picker()?.scope : "closed" }),
		};
	}

	it("predicts files on a bare @, searches every category once typed, and Tab then completes the row", () => {
		createRoot(() => {
			const ui = mentionComposer();
			ui.type("@");
			const bare = ui.popup();
			// The strip names every scope; under it Files' predictions alone.
			expect(bare[0]).toContain("Files");
			expect(bare[0]).toContain("Models");
			expect(bare[0]).toContain("Agents");
			expect(bare.slice(1).join("\n")).toContain("index.ts");
			expect(bare.join("\n")).not.toContain("Claude Opus 4.6");
			// Too narrow for its labels, the strip keeps a line of glyphs over the same list.
			const narrow = ui.popup(24);
			expect(narrow[0]).not.toContain("Files");
			expect(narrow[0]?.trim()).not.toBe("");
			expect(narrow.slice(1).join("\n")).toContain("index.ts");

			ui.type("i");
			const typed = ui.popup().join("\n");
			expect(typed).toContain("index.ts");
			expect(typed).toContain("Claude Opus 4.6");
			ui.tab();
			expect(ui.composer.text()).toBe("@src/index.ts ");
		});
	});

	it("walks the scopes with Tab and Shift+Tab while nothing is typed, one undo step each", () => {
		createRoot(() => {
			const ui = mentionComposer();
			ui.type("@");
			expect(ui.state()).toEqual({ text: "@", scope: undefined });
			// Files has no token: the `@` itself is pinned to it.
			ui.tab();
			expect(ui.state()).toEqual({ text: "@", scope: "files" });
			ui.tab();
			expect(ui.state()).toEqual({ text: "@m:", scope: "models" });
			// A scope that lists nothing stays open, so Tab walks on from it.
			ui.tab();
			expect(ui.state()).toEqual({ text: "@p2p:", scope: "agents" });
			expect(ui.popup().join("\n")).toContain("No matching mentions");
			ui.tab();
			expect(ui.state()).toEqual({ text: "@", scope: "files" });
			// Back from the first scope is the last one.
			ui.shiftTab();
			expect(ui.state()).toEqual({ text: "@p2p:", scope: "agents" });
			ui.shiftTab();
			expect(ui.state()).toEqual({ text: "@m:", scope: "models" });
			ui.composer.undo();
			expect(ui.composer.text()).toBe("@p2p:");

			// From no scope, Shift+Tab enters the last.
			ui.composer.setText("");
			ui.type("@");
			ui.shiftTab();
			expect(ui.state()).toEqual({ text: "@p2p:", scope: "agents" });
		});
	});

	it("completes with Tab inside a scope once something is typed, stepping thinking effort first", () => {
		createRoot(() => {
			const ui = mentionComposer();
			ui.type("@");
			ui.tab();
			ui.tab();
			ui.type("c");
			expect(ui.composer.text()).toBe("@m:c");

			// Default model mention does NOT force a thinking suffix or show a Thinking bar.
			const modelPainted = ui.popup().join("\n");
			expect(modelPainted).toContain("Claude Opus 4.6");
			expect(modelPainted).not.toContain("Thinking:");

			// Opting into an explicit thinking level via Shift+Right reveals the Thinking bar.
			ui.composer.handleDraftKey({ id: "shift+right", kind: "press", raw: "" });
			ui.composer.handleDraftKey({ id: "shift+right", kind: "press", raw: "" });
			expect(ui.popup().join("\n")).toContain("Thinking:");
			ui.tab();
			expect(ui.composer.text()).toBe("^anthropic/claude-opus-4-6:high ");
		});
	});

	it("drops the scope on Backspace when nothing is typed after it, keeping the popup open", () => {
		createRoot(() => {
			const ui = mentionComposer();
			ui.type("@");
			ui.tab();
			ui.tab();
			ui.type("c");
			// With a query, Backspace deletes a character as anywhere.
			ui.backspace();
			expect(ui.state()).toEqual({ text: "@m:", scope: "models" });
			ui.backspace();
			expect(ui.state()).toEqual({ text: "@", scope: undefined });
			// The files lock has no token to delete: one press clears it, the next deletes the `@`.
			ui.tab();
			expect(ui.state()).toEqual({ text: "@", scope: "files" });
			ui.backspace();
			expect(ui.state()).toEqual({ text: "@", scope: undefined });
			ui.backspace();
			expect(ui.state()).toEqual({ text: "", scope: "closed" });
		});
	});

	it("enters a scope on its bar button keeping the typed query, and leaves the active one", () => {
		createRoot(() => {
			const ui = mentionComposer();
			ui.type("@op");
			ui.click("models");
			expect(ui.state()).toEqual({ text: "@m:op", scope: "models" });
			ui.click("models");
			expect(ui.state()).toEqual({ text: "@op", scope: undefined });
			// Files pins the token as typed, and its list is files alone.
			ui.click("files");
			expect(ui.state()).toEqual({ text: "@op", scope: "files" });
			expect(ui.popup().join("\n")).not.toContain("Claude Opus 4.6");
			ui.click("models");
			expect(ui.state()).toEqual({ text: "@m:op", scope: "models" });
		});
	});

	it("keeps a scope whose rows are still loading open without calling it empty", async () => {
		const { promise: hosts, resolve: resolveHosts } = Promise.withResolvers<MentionSourceResult>();
		const sshSource: MentionSource = {
			id: "ssh",
			label: "SSH",
			querySync: () => ({
				category: "ssh",
				items: [],
				bestTier: MATCH_TIER.None,
				total: 0,
				loading: true,
				available: true,
			}),
			queryAsync: () => hosts,
		};
		const ui = createRoot(() => mentionComposer([fileSource, sshSource]));
		ui.type("@");
		ui.tab();
		ui.tab();
		expect(ui.state()).toEqual({ text: "@ssh:", scope: "ssh" });
		expect(ui.picker()?.state).toBe("loading");
		expect(ui.popup().join("\n")).not.toContain("No matching mentions");

		resolveHosts({
			category: "ssh",
			items: [fakeItem("ssh", "ssh://prod/", "prod", MATCH_TIER.Medium)],
			bestTier: MATCH_TIER.Medium,
			total: 1,
			available: true,
		});
		// The rows reach the popup over promise hops alone: yield to those, no clock involved.
		for (let i = 0; i < 100 && ui.picker()?.state === "loading"; i++) await Promise.resolve();
		expect(ui.picker()?.state).toBeUndefined();
		expect(ui.popup().join("\n")).toContain("prod");
	});

	it("tells the native picker the scopes, the active scope and the query in every state", () => {
		createRoot(() => {
			const ui = mentionComposer();
			const bar = () => {
				const { layout, search, scope, query, placeholder } = ui.picker() ?? {};
				return { layout, search, scope, query, placeholder };
			};
			ui.type("@");
			expect(bar()).toEqual({ layout: "rows", search: "bar", scope: undefined, query: "", placeholder: "Search" });
			expect(ui.picker()?.scopes).toEqual([
				{ id: "files", label: "Files", icon: "file", count: 1 },
				{ id: "models", label: "Models", icon: "cpu", count: 1 },
				{ id: "agents", label: "Agents", icon: "users" },
			]);
			ui.type("i");
			expect(bar()).toMatchObject({ scope: undefined, query: "i", placeholder: "Search" });
			ui.backspace();
			ui.tab();
			ui.tab();
			expect(bar()).toMatchObject({ scope: "models", query: "", placeholder: "Models" });
			ui.type("c");
			expect(bar()).toMatchObject({ scope: "models", query: "c", placeholder: "Models" });

			// `^` only reports its category: Tab completes even before anything is typed.
			ui.composer.setText("");
			ui.type("^");
			expect(bar()).toEqual({ layout: "rows", search: "bar", scope: "models", query: "", placeholder: "Models" });
			ui.tab();
			expect(ui.composer.text()).toBe("^anthropic/claude-opus-4-6 ");
		});
	});

	it("tells the native picker which range of the draft its query is typed as", () => {
		createRoot(() => {
			const ui = mentionComposer();
			const typedAs = () => {
				const { anchor, query } = ui.picker() ?? {};
				return { anchor, query };
			};
			// A bare `@`: an empty range right after it, where the caret is.
			ui.type("look at @");
			expect(typedAs()).toEqual({ anchor: { caret: "line/input", query: [9, 9] }, query: "" });
			ui.type("fo");
			expect(typedAs()).toEqual({ anchor: { caret: "line/input", query: [9, 11] }, query: "fo" });
			ui.backspace();
			expect(typedAs()).toEqual({ anchor: { caret: "line/input", query: [9, 10] }, query: "f" });

			// A scope's token is typed text too: the range covers it, the query is what follows it.
			ui.composer.setText("");
			ui.type("look at @m:op");
			expect(typedAs()).toEqual({ anchor: { caret: "line/input", query: [9, 13] }, query: "op" });

			// Tab into Files leaves the `@` alone; into Models writes its token, with nothing typed yet.
			ui.composer.setText("");
			ui.type("@");
			ui.tab();
			expect(typedAs()).toEqual({ anchor: { caret: "line/input", query: [1, 1] }, query: "" });
			ui.tab();
			expect(ui.composer.text()).toBe("@m:");
			expect(typedAs()).toEqual({ anchor: { caret: "line/input", query: [1, 3] }, query: "" });

			// `^` has no token: what follows it.
			ui.composer.setText("");
			ui.type("^cl");
			expect(typedAs()).toEqual({ anchor: { caret: "line/input", query: [1, 3] }, query: "cl" });
		});
	});

	it("follows a keystroke in the picker's query and range while its rows are still being looked up", () => {
		// The lookup never settles: what the picker says comes from the draft alone.
		const slowFiles: MentionSource = {
			...fileSource,
			querySync: query => ({ ...fileSource.querySync(query), loading: true }),
			queryAsync: () => new Promise<MentionSourceResult>(() => {}),
		};
		createRoot(() => {
			const ui = mentionComposer([slowFiles]);
			ui.type("@");
			for (const [char, typed] of [
				["i", "i"],
				["n", "in"],
				["d", "ind"],
			] as const) {
				ui.type(char);
				expect(ui.picker()).toMatchObject({
					anchor: { caret: "line/input", query: [1, 1 + typed.length] },
					query: typed,
				});
			}
		});
	});

	it("keeps an unmatched mention open natively until Space, and closes it in a terminal", () => {
		// Files predict on a bare `@` and match nothing once something is typed.
		const noMatches: MentionSource = {
			id: "files",
			label: "Files",
			querySync: query =>
				query.query === ""
					? fileSource.querySync(query)
					: { category: "files", items: [], bestTier: MATCH_TIER.None, total: 0, available: true },
		};
		createRoot(() => {
			const ui = mentionComposer([noMatches]);
			ui.type("@zz");
			expect(ui.composer.completing()).toBe(false);

			ui.composer.setText("");
			setNativeRenderingForTest(true);
			ui.type("@");
			expect(ui.picker()?.items).toHaveLength(1);
			ui.type("zz");
			expect(ui.picker()).toMatchObject({
				items: [],
				query: "zz",
				anchor: { caret: "line/input", query: [1, 3] },
				empty: "No matching mentions",
			});
			expect(ui.picker()?.state).toBeUndefined();
			// A match brings the rows back into the same picker.
			ui.backspace();
			ui.backspace();
			expect(ui.picker()?.items).toHaveLength(1);
			ui.type("zz ");
			expect(ui.composer.completing()).toBe(false);
			expect(ui.composer.text()).toBe("@zz ");
		});
	});

	it("clears what is typed on the native picker's clear action, keeping the mention and its scope", () => {
		// Each category predicts with nothing typed and matches nothing once something is.
		const unmatched = (source: MentionSource): MentionSource => ({
			...source,
			querySync: query =>
				query.query === ""
					? source.querySync(query)
					: { category: source.id, items: [], bestTier: MATCH_TIER.None, total: 0, available: true },
		});
		createRoot(() => {
			setNativeRenderingForTest(true);
			const ui = mentionComposer([unmatched(fileSource), unmatched(modelSource)]);
			ui.type("look at @zzqx");
			expect(ui.picker()).toMatchObject({ items: [], query: "zzqx" });
			ui.clear();
			expect(ui.state()).toEqual({ text: "look at @", scope: undefined });
			expect(ui.picker()).toMatchObject({ query: "", anchor: { caret: "line/input", query: [9, 9] } });
			expect(ui.picker()?.items?.map(item => item.label)).toEqual(["index.ts"]);
			// One undo step brings the query back.
			ui.composer.undo();
			expect(ui.composer.text()).toBe("look at @zzqx");

			ui.composer.setText("");
			ui.type("@m:zz");
			expect(ui.picker()).toMatchObject({ items: [], scope: "models", query: "zz" });
			ui.clear();
			expect(ui.state()).toEqual({ text: "@m:", scope: "models" });
			expect(ui.picker()?.items?.map(item => item.label)).toEqual(["Claude Opus 4.6"]);
			// Nothing typed: nothing to clear.
			ui.clear();
			expect(ui.state()).toEqual({ text: "@m:", scope: "models" });
		});
	});
});
