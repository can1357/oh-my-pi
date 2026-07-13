/**
 * Agent Hub background-lane contract: persistent background sessions discovered
 * on disk render as top-level lanes that are COLLAPSED by default; Space expands
 * a lane to reveal its nested subagents, and Enter resumes the session. This is
 * the consolidation of the old `/backgrounds` switcher into the Agent Hub.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { IrcBus } from "@pk-nerdsaver-ai/pi-coding-agent/irc/bus";
import { AgentHubOverlayComponent } from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/agent-hub";
import { SessionObserverRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/modes/session-observer-registry";
import { initTheme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import { AgentRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/registry/agent-registry";
import type { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";

const LANE_NAME = "api-worker";

const RENAMED_LANE_NAME = "renamed-worker";
async function seedBackgroundSession(dir: string): Promise<string> {
	const sessionFile = path.join(dir, "bgsess.jsonl");
	const headerObj = {
		type: "session",
		version: 3,
		id: "bgsess",
		cwd: dir,
		timestamp: new Date().toISOString(),
		backgroundInstance: { name: LANE_NAME, status: "active", model: "anthropic/claude" },
	};
	const userMsg = {
		type: "message",
		id: "e1",
		parentId: null,
		timestamp: new Date().toISOString(),
		message: { role: "user", content: "kick off the worker" },
	};
	await fs.writeFile(sessionFile, `${JSON.stringify(headerObj)}\n${JSON.stringify(userMsg)}\n`);
	// One nested subagent transcript in the session's artifact dir.
	const artifactDir = path.join(dir, "bgsess");
	await fs.mkdir(artifactDir, { recursive: true });
	await fs.writeFile(
		path.join(artifactDir, "Sub-1.jsonl"),
		`${JSON.stringify({ type: "session", version: 3, id: "Sub-1", cwd: dir, timestamp: new Date().toISOString() })}\n`,
	);
	return sessionFile;
}

/**
 * Poll the rendered output until `needle` appears. The hub loads background
 * sessions via a real async filesystem scan kicked off in its constructor and
 * exposes no completion signal, so an integration test must wait on the
 * observable render rather than a deterministic fake clock.
 */
async function renderUntil(hub: AgentHubOverlayComponent, needle: string, timeoutMs = 3000): Promise<string> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const text = Bun.stripANSI(hub.render(120).join("\n"));
		if (text.includes(needle) || Date.now() >= deadline) return text;
		await Bun.sleep(25);
	}
}

describe("Agent hub background lanes", () => {
	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(() => {
		// When the per-directory scan comes back empty the hub falls back to
		// SessionManager.listAll() — the whole machine's sessions. Pin it to []
		// so these tests only ever see what they seed into their tmp dirs.
		vi.spyOn(SessionManager, "listAll").mockResolvedValue([]);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("shows a background session as a collapsed lane, expands to its subagents, resumes on Enter", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bg-hub-"));
		try {
			const sessionFile = await seedBackgroundSession(tmp);
			const resumed = Promise.withResolvers<string>();
			const resume = vi.fn(async (p: string) => {
				resumed.resolve(p);
			});
			const hub = new AgentHubOverlayComponent({
				observers: new SessionObserverRegistry(),
				hubKeys: [],
				onDone: () => {},
				requestRender: () => {},
				registry: new AgentRegistry(),
				irc: new IrcBus(new AgentRegistry()),
				focusAgent: async () => {},
				cwd: tmp,
				sessionDir: tmp,
				resumeSession: resume,
				kanbanSync: null,
			});
			try {
				// Lane appears once the async disk scan completes.
				const collapsed = await renderUntil(hub, LANE_NAME);
				expect(collapsed).toContain(LANE_NAME);
				// Collapsed by default: the nested subagent stays hidden.
				expect(collapsed).not.toContain("Sub-1");

				// Rows: folder (0) → current session (1) → background lane (2). Select the lane.
				hub.handleInput("j");
				hub.handleInput("j");
				hub.handleInput("\r");
				expect(await resumed.promise).toBe(sessionFile);
				// Space expands the selected lane to reveal its subagent.
				hub.handleInput(" ");
				const expanded = Bun.stripANSI(hub.render(120).join("\n"));
				expect(expanded).toContain("Sub-1");

				// Lowercase r starts inline rename for the selected background session.
				hub.handleInput("r");
				for (const _char of LANE_NAME) hub.handleInput("\x7f");
				for (const char of RENAMED_LANE_NAME) hub.handleInput(char);
				hub.handleInput("\r");
				const renamed = await renderUntil(hub, RENAMED_LANE_NAME, 1000);
				expect(renamed).toContain(RENAMED_LANE_NAME);
				expect(renamed).not.toContain(LANE_NAME);

				// Press x once to warn
				hub.handleInput("x");
				const warned = Bun.stripANSI(hub.render(120).join("\n"));
				expect(warned).toContain(`Press x again (or Ctrl+X) to remove background session "${RENAMED_LANE_NAME}"`);

				// Press x again to confirm removal (archives on disk and deletes from UI)
				hub.handleInput("x");
				const postRemove = await renderUntil(hub, "Removed background session", 1000);
				expect(postRemove).toContain(`Removed background session "${RENAMED_LANE_NAME}"`);

				// Clear the notice (e.g. by moving the cursor) and verify the lane is gone
				hub.handleInput("k");
				const finalRender = Bun.stripANSI(hub.render(120).join("\n"));
				expect(finalRender).not.toContain(LANE_NAME);

				// Verify session file on disk contains the archived status entry
				const fileContent = await fs.readFile(sessionFile, "utf-8");
				expect(fileContent).toContain(`"name":"${RENAMED_LANE_NAME}"`);
				expect(fileContent).toContain('"status":"archived"');
			} finally {
				hub.dispose();
			}
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("does not render the current session again when Windows path casing differs", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bg-hub-current-"));
		try {
			const sessionFile = await seedBackgroundSession(tmp);
			const currentSessionFile =
				process.platform === "win32" ? path.resolve(sessionFile).toUpperCase() : sessionFile;
			const backgroundLoaded = Promise.withResolvers<void>();
			const registry = new AgentRegistry();
			const hub = new AgentHubOverlayComponent({
				observers: new SessionObserverRegistry(),
				hubKeys: [],
				onDone: () => {},
				requestRender: () => backgroundLoaded.resolve(),
				registry,
				irc: new IrcBus(registry),
				focusAgent: async () => {},
				cwd: tmp,
				sessionDir: tmp,
				sessionFile: currentSessionFile,
				resumeSession: async () => {},
				kanbanSync: null,
			});
			try {
				await backgroundLoaded.promise;
				const rendered = Bun.stripANSI(hub.render(120).join("\n"));
				expect(rendered).not.toContain(LANE_NAME);
			} finally {
				hub.dispose();
			}
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("does not duplicate a persisted lane already owned by a live or parked registry subagent", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bg-hub-dedupe-"));
		try {
			const sessionFile = await seedBackgroundSession(tmp);
			const registrySessionFile =
				process.platform === "win32"
					? path.resolve(sessionFile).toUpperCase()
					: path.relative(process.cwd(), sessionFile);
			for (const status of ["running", "parked"] as const) {
				const registry = new AgentRegistry();
				registry.register({
					id: "DesktopTag-1",
					displayName: LANE_NAME,
					kind: "sub",
					parentId: "Main",
					session: status === "running" ? ({} as AgentSession) : null,
					sessionFile: registrySessionFile,
					status,
					cwd: tmp,
				});
				const backgroundLoaded = Promise.withResolvers<void>();
				const hub = new AgentHubOverlayComponent({
					observers: new SessionObserverRegistry(),
					hubKeys: [],
					onDone: () => {},
					requestRender: () => backgroundLoaded.resolve(),
					registry,
					irc: new IrcBus(registry),
					focusAgent: async () => {},
					cwd: tmp,
					sessionDir: tmp,
					resumeSession: async () => {},
					kanbanSync: null,
				});
				try {
					await backgroundLoaded.promise;
					const rendered = Bun.stripANSI(hub.render(120).join("\n"));
					expect(rendered.match(new RegExp(LANE_NAME, "g"))).toHaveLength(1);
					expect(rendered).toContain("DesktopTag-1");
					expect(rendered).not.toContain("model anthropic/claude");
				} finally {
					hub.dispose();
				}
			}
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	// Contract behind the ←← gesture: with no live subagents, `isEmpty` is only
	// authoritative once the async background disk scan lands. The gesture path
	// awaits `backgroundsLoaded()` before deciding to stay inert — without this,
	// background-only sessions made double-← a permanent no-op.
	it("backgroundsLoaded resolves after the disk scan and flips isEmpty for background-only sessions", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bg-hub-ready-"));
		try {
			await seedBackgroundSession(tmp);
			const registry = new AgentRegistry();
			const hub = new AgentHubOverlayComponent({
				observers: new SessionObserverRegistry(),
				hubKeys: [],
				onDone: () => {},
				requestRender: () => {},
				registry,
				irc: new IrcBus(registry),
				focusAgent: async () => {},
				cwd: tmp,
				sessionDir: tmp,
				resumeSession: async () => {},
				kanbanSync: null,
			});
			try {
				await hub.backgroundsLoaded();
				expect(hub.isEmpty).toBe(false);
			} finally {
				hub.dispose();
			}
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});

	it("stays empty after the scan when no background sessions exist", async () => {
		const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "omp-bg-hub-empty-"));
		try {
			const registry = new AgentRegistry();
			const hub = new AgentHubOverlayComponent({
				observers: new SessionObserverRegistry(),
				hubKeys: [],
				onDone: () => {},
				requestRender: () => {},
				registry,
				irc: new IrcBus(registry),
				focusAgent: async () => {},
				cwd: tmp,
				sessionDir: tmp,
				resumeSession: async () => {},
				kanbanSync: null,
			});
			try {
				await hub.backgroundsLoaded();
				expect(hub.isEmpty).toBe(true);
			} finally {
				hub.dispose();
			}
		} finally {
			await fs.rm(tmp, { recursive: true, force: true });
		}
	});
});
