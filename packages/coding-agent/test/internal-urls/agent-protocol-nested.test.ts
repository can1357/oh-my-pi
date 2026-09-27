import { afterAll, afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { AgentProtocolHandler } from "../../src/internal-urls/agent-protocol";
import { resetRegisteredArtifactDirsForTests } from "../../src/internal-urls/registry-helpers";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { AgentSession } from "../../src/session/agent-session";
import { ArtifactManager } from "../../src/session/artifacts";

const tempDir = TempDir.createSync("omp-nested-agent-repro-");
afterEach(() => {
	AgentRegistry.resetGlobalForTests();
	resetRegisteredArtifactDirsForTests();
});
afterAll(() => {
	tempDir.removeSync();
});

it("agent:// resolves a depth-2 subagent's .md output while its session is live and artifact-manager-adopted", async () => {
	const root = tempDir.path();
	const rootSessionFile = path.join(root, "session.jsonl");
	const rootArtifactsDir = rootSessionFile.slice(0, -6);
	await fs.mkdir(rootArtifactsDir, { recursive: true });
	// Every subagent adopts the root ArtifactManager and reports its dir.
	const sharedArtifactManager = new ArtifactManager(rootArtifactsDir);

	// A depth-1 subagent's OWN children are written under its own
	// sessionFile.slice(0, -6) (task/index.ts), i.e. one level deeper.
	const midSessionFile = path.join(rootArtifactsDir, "CodexDeepDive.jsonl");
	const midOwnArtifactsDir = midSessionFile.slice(0, -6);
	await fs.mkdir(midOwnArtifactsDir, { recursive: true });

	const grandchildId = "CodexDeepDive.GraphStore";
	const grandchildSessionFile = path.join(midOwnArtifactsDir, `${grandchildId}.jsonl`);
	await fs.writeFile(path.join(midOwnArtifactsDir, `${grandchildId}.md`), "full report content");

	const fakeSession = {
		sessionManager: { getArtifactsDir: () => sharedArtifactManager.dir },
	} as unknown as AgentSession;
	const registry = AgentRegistry.global();
	registry.register({
		id: "Main",
		displayName: "main",
		kind: "main",
		session: fakeSession,
		sessionFile: rootSessionFile,
	});
	registry.register({
		id: "CodexDeepDive",
		displayName: "sub",
		kind: "sub",
		parentId: "Main",
		session: fakeSession,
		sessionFile: midSessionFile,
	});
	registry.register({
		id: grandchildId,
		displayName: "sub",
		kind: "sub",
		parentId: "CodexDeepDive",
		session: fakeSession,
		sessionFile: grandchildSessionFile,
	});

	const resource = await new AgentProtocolHandler().resolve(new URL(`agent://${grandchildId}`) as never);
	expect(resource.content).toBe("full report content");
});

it("agent:// nested child is the dotted host; a slash on the parent is a JSON path, never a hierarchy hop", async () => {
	const root = tempDir.path();
	const rootSessionFile = path.join(root, "slash-session.jsonl");
	const rootArtifactsDir = rootSessionFile.slice(0, -6);
	await fs.mkdir(rootArtifactsDir, { recursive: true });
	const sharedArtifactManager = new ArtifactManager(rootArtifactsDir);

	// Parent subagent adopts the root ArtifactManager; its own children are
	// written one level deeper under its sessionFile-derived dir, dot-qualified.
	const parentSessionFile = path.join(rootArtifactsDir, "Parent.jsonl");
	const parentOwnDir = parentSessionFile.slice(0, -6);
	await fs.mkdir(parentOwnDir, { recursive: true });
	await fs.writeFile(path.join(parentOwnDir, "Parent.Child.md"), "child capsule");
	// Parent output may be in the root dir; the nested child must still win.
	await fs.writeFile(path.join(rootArtifactsDir, "Parent.md"), JSON.stringify({ Child: "parent json field" }));

	const fakeSession = {
		sessionManager: { getArtifactsDir: () => sharedArtifactManager.dir },
	} as unknown as AgentSession;
	const registry = AgentRegistry.global();
	registry.register({
		id: "Main",
		displayName: "main",
		kind: "main",
		session: fakeSession,
		sessionFile: rootSessionFile,
	});
	registry.register({
		id: "Parent",
		displayName: "sub",
		kind: "sub",
		parentId: "Main",
		session: fakeSession,
		sessionFile: parentSessionFile,
	});

	const handler = new AgentProtocolHandler();
	const dotted = await handler.resolve(new URL("agent://Parent.Child") as never);
	expect(dotted.content).toBe("child capsule");
	expect(dotted.contentType).toBe("text/markdown");
	// The slash never hops the hierarchy: it extracts `Child` from Parent.md.
	const slash = await handler.resolve(new URL("agent://Parent/Child") as never);
	expect(slash.content).toBe("parent json field");
});

it("agent:// path form extracts JSON by key and array index", async () => {
	const root = tempDir.path();
	const rootSessionFile = path.join(root, "json-session.jsonl");
	const rootArtifactsDir = rootSessionFile.slice(0, -6);
	await fs.mkdir(rootArtifactsDir, { recursive: true });
	const sharedArtifactManager = new ArtifactManager(rootArtifactsDir);
	await fs.writeFile(
		path.join(rootArtifactsDir, "Worker.md"),
		JSON.stringify({ result: { ok: true }, reports: [{ data: "first report" }] }),
	);

	const fakeSession = {
		sessionManager: { getArtifactsDir: () => sharedArtifactManager.dir },
	} as unknown as AgentSession;
	const registry = AgentRegistry.global();
	registry.register({
		id: "Main",
		displayName: "main",
		kind: "main",
		session: fakeSession,
		sessionFile: rootSessionFile,
	});

	const handler = new AgentProtocolHandler();
	const extracted = await handler.resolve(new URL("agent://Worker/result") as never);
	expect(extracted.contentType).toBe("application/json");
	expect(JSON.parse(extracted.content)).toEqual({ ok: true });
	// Numeric segments index arrays; a string leaf reads as prose.
	const indexed = await handler.resolve(new URL("agent://Worker/reports/0/data") as never);
	expect(indexed.contentType).toBe("text/markdown");
	expect(indexed.content).toBe("first report");
	// A missing key yields `undefined`, not a crash or the whole document.
	const missing = await handler.resolve(new URL("agent://Worker/reports/5/data") as never);
	expect(missing.content).toBe("null");
});

it("agent:// path extraction prefers the <id>.json sidecar over the markdown body", async () => {
	const root = tempDir.path();
	const rootSessionFile = path.join(root, "sidecar-session.jsonl");
	const rootArtifactsDir = rootSessionFile.slice(0, -6);
	await fs.mkdir(rootArtifactsDir, { recursive: true });
	const sharedArtifactManager = new ArtifactManager(rootArtifactsDir);
	// Non-JSON body proves the fallback path could not have produced the answer.
	await fs.writeFile(path.join(rootArtifactsDir, "Worker.md"), "schema_violation summary text");
	await fs.writeFile(path.join(rootArtifactsDir, "Worker.json"), JSON.stringify({ summary: "ok", count: 7 }));

	const fakeSession = {
		sessionManager: { getArtifactsDir: () => sharedArtifactManager.dir },
	} as unknown as AgentSession;
	const registry = AgentRegistry.global();
	registry.register({
		id: "Main",
		displayName: "main",
		kind: "main",
		session: fakeSession,
		sessionFile: rootSessionFile,
	});

	const handler = new AgentProtocolHandler();
	const resource = await handler.resolve(new URL("agent://Worker/count") as never);
	expect(resource.contentType).toBe("application/json");
	expect(JSON.parse(resource.content)).toBe(7);
	expect(resource.sourcePath?.endsWith("Worker.json")).toBe(true);

	// A bare id keeps serving the markdown body, never the sidecar.
	const bare = await handler.resolve(new URL("agent://Worker") as never);
	expect(bare.contentType).toBe("text/markdown");
	expect(bare.content).toBe("schema_violation summary text");

	// A corrupt sidecar falls back to <id>.md instead of surfacing its own parse error.
	await fs.writeFile(path.join(rootArtifactsDir, "Worker.json"), "{not json");
	await expect(handler.resolve(new URL("agent://Worker/count") as never)).rejects.toThrow(/Worker is not valid JSON/);
});
