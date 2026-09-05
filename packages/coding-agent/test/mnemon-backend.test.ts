import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	disposeMnemonSessionState,
	getMnemonSessionState,
	mnemonBackend,
	normalizeMnemonImportance,
	resetMnemonConversationTracking,
} from "../src/mnemon/backend";
import { findMnemonCommand } from "../src/mnemon/cli";
import { applyMnemonRecallQuality, focusMnemonQuery, formatMnemonSilentRecall } from "../src/mnemon/quality";
import { LearnTool } from "../src/tools/learn";

describe("mnemon quality", () => {
	it("drops superseded rows in both silent and explicit recall modes", () => {
		const silent = applyMnemonRecallQuality(
			[
				{ id: "high", content: "keep", score: 0.81 },
				{ id: "medium", content: "drop", score: 0.4 },
				{ id: "old", content: "drop", score: 0.9, superseded: true },
			],
			{ limit: 3, mode: "silent" },
		);
		expect(silent.results.map(row => row.id)).toEqual(["high"]);

		const explicit = applyMnemonRecallQuality(
			[
				{ id: "high", content: "keep", score: 0.81 },
				{ id: "medium", content: "keep", score: 0.4 },
				{ id: "old", content: "drop", score: 0.9, superseded: true },
			],
			{ limit: 3, mode: "explicit" },
		);
		expect(explicit.results.map(row => row.id)).toEqual(["high", "medium"]);
	});

	it("clamps limit 0 to 1 instead of falling back to default 10", () => {
		const filtered = applyMnemonRecallQuality(
			[
				{ id: "one", content: "first", score: 0.8 },
				{ id: "two", content: "second", score: 0.7 },
			],
			{ limit: 0, mode: "explicit" },
		);
		expect(filtered.results.length).toBe(1);
	});

	it("formats every already-limited silent row", () => {
		const text = formatMnemonSilentRecall([
			{ category: "fact", importance: 4, confidence: "high", content: "first" },
			{ category: "decision", importance: 5, confidence: "high", content: "second" },
			{ category: "context", importance: 3, confidence: "high", content: "third" },
			{ category: "insight", importance: 4, confidence: "high", content: "fourth" },
		]);
		expect(text).toContain("first");
		expect(text).toContain("fourth");
	});

	it("focuses conversational queries down to keywords", () => {
		const query = focusMnemonQuery(
			"ok reloaded. how do you feel in this and anything else we should do before publishing this as a proper omp extension repo?",
		);
		expect(query.toLowerCase()).toContain("omp");
		expect(query.toLowerCase()).not.toContain("feel");
	});

	it("maps fractional importance onto 1-5 but keeps explicit integer 1", () => {
		expect(normalizeMnemonImportance(0.8)).toBe(4);
		expect(normalizeMnemonImportance(1)).toBe(1);
		expect(normalizeMnemonImportance(3)).toBe(3);
		expect(normalizeMnemonImportance(9)).toBe(5);
		expect(normalizeMnemonImportance(undefined)).toBe(3);
	});

	it("keeps a configured cliPath authoritative even when the path is missing", () => {
		const missing = path.join(os.tmpdir(), "omp-mnemon-does-not-exist", "mnemon");
		expect(findMnemonCommand(missing)).toBe(missing);
		expect(findMnemonCommand("  ")).not.toBe("  ");
	});
});

describe("mnemonBackend", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	it("refuses /memory clear so ~/.mnemon is never wiped", async () => {
		await expect(mnemonBackend.clear("/tmp/agent", "/tmp/project")).rejects.toThrow(/will not wipe/);
	});

	it("refuses secret-like saves", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemon" });
		const result = await mnemonBackend.save?.(
			{ agentDir: "/tmp/agent", cwd: "/tmp/project", session: { settings } as never },
			{ content: "token sk-abcdefghijklmnopqrstuvwxyz123456" },
		);
		expect(result?.stored).toBe(0);
		expect(result?.message).toContain("secret");
	});

	it("refuses a secret placed in entities or source", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemon" });
		const ctx = { agentDir: "/tmp/agent", cwd: "/tmp/project", session: { settings } as never };
		const token = "sk-abcdefghijklmnopqrstuvwxyz123456";
		const viaEntities = await mnemonBackend.save?.(ctx, { content: "ok fact", entities: token });
		expect(viaEntities?.stored).toBe(0);
		expect(viaEntities?.message).toContain("secret");
		const viaSource = await mnemonBackend.save?.(ctx, { content: "ok fact", source: token });
		expect(viaSource?.stored).toBe(0);
		expect(viaSource?.message).toContain("secret");
	});

	it("clears first-turn recall so a new transcript can auto-recall", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemon" });
		const session = { sessionId: "s-new", settings } as never;
		await mnemonBackend.start({
			session,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp/agent",
			taskDepth: 0,
		});
		const state = getMnemonSessionState(session);
		expect(state).toBeDefined();
		state!.hasRecalledForFirstTurn = true;
		state!.lastRecallSnippet = "stale clip";
		expect(resetMnemonConversationTracking(session)).toBe(true);
		expect(state!.hasRecalledForFirstTurn).toBe(false);
		expect(state!.lastRecallSnippet).toBeUndefined();
	});

	it("renders developer instructions and incorporates lastRecallSnippet when present", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemon" });
		const session = { sessionId: "s-snippet", settings } as never;
		await mnemonBackend.start({
			session,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp/agent",
			taskDepth: 0,
		});
		const state = getMnemonSessionState(session);
		expect(state).toBeDefined();

		const initial = await mnemonBackend.buildDeveloperInstructions("/tmp/agent", settings, session);
		expect(initial).toBeDefined();

		state!.lastRecallSnippet = "Recalled memories snippet test marker";
		const withSnippet = await mnemonBackend.buildDeveloperInstructions("/tmp/agent", settings, session);
		expect(withSnippet).toContain("Recalled memories snippet test marker");
	});

	it("formats compaction context with focused query", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemon" });
		const emptyContext = await mnemonBackend.preCompactionContext?.([], settings);
		expect(emptyContext).toBeDefined();

		const withUser = await mnemonBackend.preCompactionContext?.(
			[{ role: "user", content: "Please check the authentication middleware refactor" } as never],
			settings,
		);
		expect(withUser).toContain("authentication");
	});

	it("renders /memory stats when the hook is extracted unbound", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemon" });
		const hook = mnemonBackend.stats;
		const text = await hook?.("/tmp/agent", "/tmp/project", { settings } as never);
		expect(text).toContain("# mnemon");
		expect(text).not.toContain("undefined is not an object");
	});

	it("rejects malformed link payloads without calling this", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemon" });
		const hook = mnemonBackend.link;
		const ctx = { agentDir: "/tmp/agent", cwd: "/tmp/project", session: { settings } as never };
		const badId = await hook?.(ctx, {
			id1: "not-a-uuid",
			id2: "c47248fa-2aa5-4268-b49a-6a0d5f45d593",
			type: "semantic",
			weight: 0.7,
		});
		expect(badId?.status).toBe("rejected");
		expect(badId?.message).toContain("UUID");

		const self = await hook?.(ctx, {
			id1: "c47248fa-2aa5-4268-b49a-6a0d5f45d593",
			id2: "c47248fa-2aa5-4268-b49a-6a0d5f45d593",
			type: "semantic",
			weight: 0.7,
		});
		expect(self?.status).toBe("rejected");
		expect(self?.message).toContain("itself");

		const weight = await hook?.(ctx, {
			id1: "c47248fa-2aa5-4268-b49a-6a0d5f45d593",
			id2: "178abf3f-9202-4850-b795-e9c8cc0315b9",
			type: "semantic",
			weight: 1.5,
		});
		expect(weight?.status).toBe("rejected");
		expect(weight?.message).toContain("0");
	});

	it("rejects invalid category without writing", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemon" });
		const result = await mnemonBackend.save?.(
			{ agentDir: "/tmp/agent", cwd: "/tmp/project", session: { settings } as never },
			{ content: "should not write", category: "episode" },
		);
		expect(result?.stored).toBe(0);
		expect(result?.message).toContain("category");
	});

	it("rejects malformed related and forget payloads unbound", async () => {
		const settings = Settings.isolated({ "memory.backend": "mnemon" });
		const ctx = { agentDir: "/tmp/agent", cwd: "/tmp/project", session: { settings } as never };
		const related = await mnemonBackend.related?.(ctx, { id: "nope" });
		expect(related?.count).toBe(0);
		expect(related?.message).toContain("UUID");
		const forget = await mnemonBackend.forget?.(ctx, "nope");
		expect(forget?.status).toBe("rejected");
		expect(forget?.message).toContain("UUID");
	});

	it("falls back supersedes to causal when the CLI rejects the fifth type", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemon-cli-"));
		const cli = path.join(dir, "mnemon");
		fs.writeFileSync(
			cli,
			`#!/usr/bin/env bash
set -e
args=("$@")
if [[ "\${args[0]}" == "link" ]]; then
  type=""
  for ((i=0; i<\${#args[@]}; i++)); do
    if [[ "\${args[i]}" == "--type" ]]; then type="\${args[i+1]}"; fi
  done
  if [[ "$type" == "supersedes" ]]; then
    echo 'invalid edge type "supersedes"; valid: temporal, semantic, causal, entity' >&2
    exit 1
  fi
  printf '%s\\n' "{\\"status\\":\\"linked\\",\\"source_id\\":\\"\${args[1]}\\",\\"target_id\\":\\"\${args[2]}\\",\\"edge_type\\":\\"$type\\"}"
  exit 0
fi
echo "unexpected \${args[*]}" >&2
exit 1
`,
		);
		fs.chmodSync(cli, 0o755);
		const settings = Settings.isolated({ "memory.backend": "mnemon", "mnemon.cliPath": cli });
		const result = await mnemonBackend.link?.(
			{ agentDir: "/tmp/agent", cwd: "/tmp/project", session: { settings } as never },
			{
				id1: "c47248fa-2aa5-4268-b49a-6a0d5f45d593",
				id2: "178abf3f-9202-4850-b795-e9c8cc0315b9",
				type: "supersedes",
				weight: 1,
			},
		);
		expect(result?.status).toBe("linked");
		expect(result?.type).toBe("causal");
		expect(result?.message).toContain("causal");
	});

	it("folds input.context and terminates flags before content and query", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemon-cli-test-"));
		const cli = path.join(dir, "mnemon");
		fs.writeFileSync(
			cli,
			`#!/usr/bin/env bash
set -e
args=("$@")
if [[ "\${args[*]}" =~ remember ]]; then
  dashdash_idx=-1
  for ((i=0; i<\${#args[@]}; i++)); do
    if [[ "\${args[i]}" == "--" ]]; then dashdash_idx=$i; fi
  done
  if [[ $dashdash_idx -lt 0 ]]; then
    echo "missing -- separator before positional content" >&2
    exit 1
  fi
  printf '{"id":"c47248fa-2aa5-4268-b49a-6a0d5f45d593","action":"added"}\\n'
  exit 0
elif [[ "\${args[*]}" =~ recall ]]; then
  dashdash_idx=-1
  for ((i=0; i<\${#args[@]}; i++)); do
    if [[ "\${args[i]}" == "--" ]]; then dashdash_idx=$i; fi
  done
  if [[ $dashdash_idx -lt 0 ]]; then
    echo "missing -- separator before query" >&2
    exit 1
  fi
  printf '{"results":[{"id":"c47248fa-2aa5-4268-b49a-6a0d5f45d593","content":"matched","score":0.9}]}\\n'
  exit 0
fi
echo "unexpected \${args[*]}" >&2
exit 1
`,
		);
		fs.chmodSync(cli, 0o755);
		const settings = Settings.isolated({ "memory.backend": "mnemon", "mnemon.cliPath": cli });
		const ctx = { agentDir: "/tmp/agent", cwd: "/tmp/project", session: { settings } as never };

		const saveRes = await mnemonBackend.save?.(ctx, {
			content: "--watch flag behavior",
			context: "investigated in cli.ts",
		});
		expect(saveRes?.stored).toBe(1);
		expect(saveRes?.ids?.[0]).toBe("c47248fa-2aa5-4268-b49a-6a0d5f45d593");

		const searchRes = await mnemonBackend.search?.(ctx, "--watch", { limit: 5 });
		expect(searchRes?.count).toBe(1);
		expect(searchRes?.items[0]?.content).toBe("matched");
	});

	it("returns replaced_id as id when action is skipped", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemon-cli-dup-"));
		const cli = path.join(dir, "mnemon");
		fs.writeFileSync(
			cli,
			`#!/usr/bin/env bash
set -e
printf '{"id":"new-unpersisted-id","replaced_id":"existing-persisted-uuid","action":"skipped"}\\n'
`,
		);
		fs.chmodSync(cli, 0o755);
		const settings = Settings.isolated({ "memory.backend": "mnemon", "mnemon.cliPath": cli });
		const ctx = { agentDir: "/tmp/agent", cwd: "/tmp/project", session: { settings } as never };

		const result = await mnemonBackend.save?.(ctx, { content: "duplicate fact" });
		expect(result?.stored).toBe(0);
		expect(result?.message).toBe("skipped");
		expect(result?.ids).toEqual(["existing-persisted-uuid"]);
	});

	it("stores learned lessons at Mnemon's default non-immune importance", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemon-cli-durable-learn-"));
		const cli = path.join(dir, "mnemon");
		fs.writeFileSync(
			cli,
			`#!/usr/bin/env bash
set -e
if [[ " $* " != *" --imp 3 "* ]]; then
  echo "expected learned lesson to use --imp 3: $*" >&2
  exit 1
fi
printf '{"id":"durable-id","action":"added"}\\n'
`,
		);
		fs.chmodSync(cli, 0o755);
		const settings = Settings.isolated({
			"autolearn.enabled": true,
			"memory.backend": "mnemon",
			"mnemon.cliPath": cli,
		});
		const session = {
			cwd: "/tmp/project",
			hasUI: false,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		};

		const tool = LearnTool.createIf(session as never);
		expect(tool).toBeInstanceOf(LearnTool);
		const execution = await tool!.execute("1", { memory: "Keep this reusable lesson" });
		const text = execution.content[0]?.type === "text" ? execution.content[0].text : "";
		expect(text).toContain("Lesson stored");
	});

	it("learn tool succeeds without error when mnemon returns action: skipped", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemon-cli-learn-"));
		const cli = path.join(dir, "mnemon");
		fs.writeFileSync(
			cli,
			`#!/usr/bin/env bash
set -e
printf '{"id":"new-id","replaced_id":"existing-uuid","action":"skipped"}\\n'
`,
		);
		fs.chmodSync(cli, 0o755);
		const settings = Settings.isolated({
			"autolearn.enabled": true,
			"memory.backend": "mnemon",
			"mnemon.cliPath": cli,
		});
		const session = {
			cwd: "/tmp/project",
			hasUI: false,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		};
		const tool = LearnTool.createIf(session as never);
		expect(tool).toBeInstanceOf(LearnTool);
		const execution = await tool!.execute("1", { memory: "Already remembered rule" });
		const text = execution.content[0]?.type === "text" ? execution.content[0].text : "";
		expect(text).toContain("Lesson already present in memory");
	});
});

describe("mnemon auto-retain", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		resetSettingsForTest();
	});

	function makeFakeCli(logPath: string): string {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnemon-retain-"));
		const cli = path.join(dir, "mnemon");
		fs.writeFileSync(
			cli,
			`#!/usr/bin/env bash
set -e
args=("$@")
if [[ "\${args[0]}" == "remember" ]]; then
  joined=$(printf '%s ' "\${args[@]}")
  printf '%s\\n' "\${joined//$'\\n'/ }" >> "${logPath}"
  printf '{"id":"c47248fa-2aa5-4268-b49a-6a0d5f45d593","action":"added"}\\n'
  exit 0
fi
echo "unexpected \${args[*]}" >&2
exit 1
`,
		);
		fs.chmodSync(cli, 0o755);
		return cli;
	}

	function makeSession(settings: Settings, entries: unknown[], listeners: Array<(event: unknown) => void>) {
		return {
			sessionId: "retain-test-session",
			settings,
			sessionManager: { getEntries: () => entries },
			subscribe: (listener: (event: unknown) => void) => {
				listeners.push(listener);
				return () => {};
			},
		} as never;
	}

	function userEntry(text: string) {
		return { type: "message", message: { role: "user", content: text } };
	}

	function assistantEntry(text: string) {
		return { type: "message", message: { role: "assistant", content: [{ type: "text", text }] } };
	}

	function readLog(logPath: string): string[] {
		if (!fs.existsSync(logPath)) return [];
		return fs.readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean);
	}

	it("retains the unretained transcript tail on agent_end after N user turns", async () => {
		const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mnemon-retain-log-")), "log.txt");
		const cli = makeFakeCli(logPath);
		const settings = Settings.isolated({
			"memory.backend": "mnemon",
			"mnemon.cliPath": cli,
			"mnemon.retainEveryNTurns": 2,
		});
		const listeners: Array<(event: unknown) => void> = [];
		const session = makeSession(
			settings,
			[
				userEntry("first question"),
				assistantEntry("first answer"),
				userEntry("second question"),
				assistantEntry("second answer"),
			],
			listeners,
		);

		await mnemonBackend.start({
			session,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp/agent",
			taskDepth: 0,
		});
		listeners[0]!({ type: "agent_end", messages: [] });
		await getMnemonSessionState(session)?.retainInFlight;

		const lines = readLog(logPath);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("remember");
		expect(lines[0]).toContain("--cat context");
		expect(lines[0]).toContain("--imp 2");
		expect(lines[0]).toContain("--source agent");
		expect(lines[0]).toContain("--no-diff");
		expect(lines[0]).toContain("first question");
		expect(lines[0]).toContain("second answer");
	});

	it("skips retention until the turn cadence is met", async () => {
		const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mnemon-retain-log-")), "log.txt");
		const cli = makeFakeCli(logPath);
		const settings = Settings.isolated({
			"memory.backend": "mnemon",
			"mnemon.cliPath": cli,
			"mnemon.retainEveryNTurns": 2,
		});
		const listeners: Array<(event: unknown) => void> = [];
		const session = makeSession(settings, [userEntry("only one turn"), assistantEntry("answer")], listeners);

		await mnemonBackend.start({
			session,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp/agent",
			taskDepth: 0,
		});
		listeners[0]!({ type: "agent_end", messages: [] });
		await getMnemonSessionState(session)?.retainInFlight;

		expect(readLog(logPath)).toHaveLength(0);
	});

	it("enqueue forces retention regardless of cadence", async () => {
		const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mnemon-retain-log-")), "log.txt");
		const cli = makeFakeCli(logPath);
		const settings = Settings.isolated({
			"memory.backend": "mnemon",
			"mnemon.cliPath": cli,
			"mnemon.retainEveryNTurns": 4,
		});
		const listeners: Array<(event: unknown) => void> = [];
		const session = makeSession(settings, [userEntry("single turn"), assistantEntry("answer")], listeners);

		await mnemonBackend.start({
			session,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp/agent",
			taskDepth: 0,
		});
		await mnemonBackend.enqueue("/tmp/agent", "/tmp/project", session);

		const lines = readLog(logPath);
		expect(lines).toHaveLength(1);
		expect(lines[0]).toContain("single turn");
	});

	it("does not retain when autoRetain is disabled", async () => {
		const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mnemon-retain-log-")), "log.txt");
		const cli = makeFakeCli(logPath);
		const settings = Settings.isolated({
			"memory.backend": "mnemon",
			"mnemon.cliPath": cli,
			"mnemon.autoRetain": false,
			"mnemon.retainEveryNTurns": 1,
		});
		const listeners: Array<(event: unknown) => void> = [];
		const session = makeSession(settings, [userEntry("turn"), assistantEntry("answer")], listeners);

		await mnemonBackend.start({
			session,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp/agent",
			taskDepth: 0,
		});
		// No subscription is installed when autoRetain is off.
		expect(listeners).toHaveLength(0);
		expect(readLog(logPath)).toHaveLength(0);
	});

	it("disposeMnemonSessionState unsubscribes listeners and clears state", async () => {
		const logPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mnemon-retain-log-")), "log.txt");
		const cli = makeFakeCli(logPath);
		const settings = Settings.isolated({
			"memory.backend": "mnemon",
			"mnemon.cliPath": cli,
			"mnemon.autoRetain": true,
			"mnemon.retainEveryNTurns": 1,
		});
		let unsubscribed = false;
		const listeners: Array<(event: unknown) => void> = [];
		const session = {
			sessionId: "test-session",
			settings,
			sessionManager: { getEntries: () => [userEntry("question"), assistantEntry("answer")] },
			subscribe: (listener: (event: unknown) => void) => {
				listeners.push(listener);
				return () => {
					unsubscribed = true;
				};
			},
		} as never;

		await mnemonBackend.start({
			session,
			settings,
			modelRegistry: {} as never,
			agentDir: "/tmp/agent",
			taskDepth: 0,
		});
		expect(getMnemonSessionState(session)).toBeDefined();
		expect(unsubscribed).toBe(false);

		disposeMnemonSessionState(session);
		expect(unsubscribed).toBe(true);
		expect(getMnemonSessionState(session)).toBeUndefined();
	});
});
