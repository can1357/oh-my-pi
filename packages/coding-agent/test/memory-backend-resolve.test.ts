import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	createMemoryRuntimeContext,
	createSessionMemoryRuntimeContext,
	resolveMemoryBackend,
} from "@oh-my-pi/pi-coding-agent/memory-backend";
import { sharpshooterBackend } from "@oh-my-pi/pi-coding-agent/sharpshooter/backend";

describe("resolveMemoryBackend", () => {
	beforeEach(() => {
		resetSettingsForTest();
	});

	afterEach(() => {
		// Restored here, not at the end of each test: a rejection or a failed
		// assertion would otherwise leave `sharpshooterBackend.search` mocked for
		// later tests and later files in the full suite (AGENTS.md:305).
		mock.restore();
		resetSettingsForTest();
	});

	it("returns the hindsight backend when memory.backend is hindsight, regardless of legacy memories.enabled", async () => {
		const a = Settings.isolated({ "memory.backend": "hindsight", "memories.enabled": false });
		const b = Settings.isolated({ "memory.backend": "hindsight", "memories.enabled": true });
		expect((await resolveMemoryBackend(a)).id).toBe("hindsight");
		expect((await resolveMemoryBackend(b)).id).toBe("hindsight");
	});

	it("exposes inactive status when no session is available", async () => {
		const memory = createMemoryRuntimeContext({ agentDir: "/tmp/agent", cwd: "/tmp/project" });

		await expect(memory.status()).resolves.toMatchObject({
			backend: "off",
			active: false,
			writable: false,
			searchable: false,
		});
	});

	it("reads cwd from the session on every call, so a moved session does not search the old project", async () => {
		// `/move` changes the session's directory while the cwd handed to
		// createSessionMemoryRuntimeContext is fixed at session creation. A backend
		// that scopes on context.cwd (sharpshooter keys its decision bank on it)
		// would otherwise keep answering for the project the session started in.
		const settings = Settings.isolated({ "memory.backend": "sharpshooter" });
		let current = "/tmp/source-project";
		const session = { settings, sessionManager: { getCwd: () => current } } as never;
		const seen: string[] = [];
		spyOn(sharpshooterBackend, "search").mockImplementation(async ({ cwd }, query) => {
			seen.push(cwd);
			return { backend: "sharpshooter" as const, query, count: 0, items: [] };
		});

		const memory = createSessionMemoryRuntimeContext(session, "/tmp/agent", "/tmp/source-project");
		await memory.search("deploy");
		current = "/tmp/destination-project";
		await memory.search("deploy");

		expect(seen).toEqual(["/tmp/source-project", "/tmp/destination-project"]);
	});

	it("falls back to the creation cwd when the session manager reports none", async () => {
		const settings = Settings.isolated({ "memory.backend": "sharpshooter" });
		const session = { settings, sessionManager: { getCwd: () => "" } } as never;
		const seen: string[] = [];
		spyOn(sharpshooterBackend, "search").mockImplementation(async ({ cwd }, query) => {
			seen.push(cwd);
			return { backend: "sharpshooter" as const, query, count: 0, items: [] };
		});

		await createSessionMemoryRuntimeContext(session, "/tmp/agent", "/tmp/fallback").search("deploy");

		expect(seen).toEqual(["/tmp/fallback"]);
	});

	it("reports local backend runtime status as writable (lessons) without structured search", async () => {
		const settings = Settings.isolated({ "memory.backend": "local" });
		const memory = createMemoryRuntimeContext({
			agentDir: "/tmp/agent",
			cwd: "/tmp/project",
			session: { settings } as never,
		});

		await expect(memory.status()).resolves.toMatchObject({
			backend: "local",
			active: true,
			writable: true,
			searchable: false,
		});
		await expect(memory.search("project preference")).resolves.toMatchObject({
			backend: "local",
			count: 0,
		});
	});
});
