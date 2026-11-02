/**
 * Renaming the active session from the `/resume` picker first claims the
 * session's ownership lease, and refuses while another omp process holds it.
 * The lease belongs to the file backend: a backend with no lease (SQL) has no
 * owner to defer to, so the rename goes through even when some other holder
 * has the file lease for that id.
 */
import { SQL } from "bun";
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import type { SessionInfo } from "@oh-my-pi/pi-coding-agent/session/session-listing";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import {
	defaultSessionStorage,
	FileSessionStorage,
	type SessionStorage,
	setDefaultSessionStorage,
	tryAcquireSessionLease,
} from "@oh-my-pi/pi-coding-agent/session/session-storage";
import { SqlSessionStorage } from "@oh-my-pi/pi-coding-agent/session/sql-session-storage";
import * as SessionSelector from "@oh-my-pi/pi-tui/overlays/session-selector";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

beforeAll(async () => {
	await initTheme();
});

describe("/resume picker rename lease", () => {
	const cleanups: (() => Promise<void> | void)[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	});

	for (const kind of ["file", "sql"] as const) {
		it(`${kind === "file" ? "refuses" : "renames"} the active ${kind} session while another holder has its file lease`, async () => {
			const previous = defaultSessionStorage();
			let storage: SessionStorage = new FileSessionStorage();
			let reopen = async (): Promise<SessionStorage> => new FileSessionStorage();
			if (kind === "sql") {
				const client = new SQL("sqlite::memory:");
				storage = await SqlSessionStorage.create({ client });
				reopen = () => SqlSessionStorage.create({ client });
				cleanups.push(() => client.end());
			}
			setDefaultSessionStorage(storage);
			cleanups.push(() => setDefaultSessionStorage(previous));
			const dir = TempDir.createSync("@omp-picker-rename-lease-");
			cleanups.push(() => dir.removeSync());
			const sessionId = `rename-lease-${kind}-${crypto.randomUUID()}`;
			const sessionFile = dir.join(`${sessionId}.jsonl`);
			await storage.writeText(
				sessionFile,
				`${[
					{ type: "session", version: 3, id: sessionId, timestamp: "2026-11-02T00:00:00.000Z", cwd: dir.path() },
					{
						type: "message",
						id: "u1",
						parentId: null,
						timestamp: "2026-11-02T00:00:01.000Z",
						message: { role: "user", content: "first turn", timestamp: 1 },
					},
				]
					.map(entry => JSON.stringify(entry))
					.join("\n")}\n`,
			);
			// Held the way another live omp process holds a session it writes.
			const held = tryAcquireSessionLease(sessionId);
			if (!held) throw new Error("expected to take the session lease");
			cleanups.push(() => held.release());
			const manager = await SessionManager.open(sessionFile, dir.path(), storage);
			cleanups.push(() => manager.close());

			const session: SessionInfo = {
				path: sessionFile,
				id: sessionId,
				cwd: dir.path(),
				title: undefined,
				created: new Date("2026-11-02T00:00:00.000Z"),
				modified: new Date("2026-11-02T00:00:01.000Z"),
				messageCount: 1,
				size: 1,
				firstMessage: "first turn",
				allMessagesText: "first turn",
			};
			const listed = [session];
			vi.spyOn(SessionManager, "listForPicker").mockResolvedValue({
				sessions: listed,
				complete: Promise.resolve(listed),
			});
			let options: SessionSelector.SessionSelectorOptions<SessionInfo> | undefined;
			const OriginalSelector = SessionSelector.SessionSelectorComponent;
			vi.spyOn(SessionSelector, "SessionSelectorComponent").mockImplementation(((
				sessions: SessionInfo[],
				onSelect: (session: SessionInfo) => void,
				onCancel: () => void,
				onExit: () => void,
				selectorOptions: SessionSelector.SessionSelectorOptions<SessionInfo>,
			) => {
				options = selectorOptions;
				return new OriginalSelector<SessionInfo>(sessions, onSelect, onCancel, onExit, selectorOptions);
			}) as never);
			const ctx = {
				sessionManager: manager,
				settings: Settings.isolated(),
				showStatus: vi.fn(),
				showError: vi.fn(),
				ui: {
					requestRender: vi.fn(),
					setFocus: vi.fn(),
					terminal: { rows: 24 },
					showOverlay: vi.fn(() => ({ hide: vi.fn(), setHidden: vi.fn(), isHidden: () => false })),
				},
				editor: {},
				editorContainer: { children: [], clear: vi.fn(), addChild: vi.fn() },
			} as unknown as InteractiveModeContext;
			await new SelectorController(ctx).showSessionSelector();
			const onRename = options?.onRename;
			if (!onRename) throw new Error("the picker offered no rename");

			if (kind === "file") {
				await expect(onRename(session, "Renamed title")).rejects.toThrow("in use by another omp process");
				expect(manager.getSessionName()).toBeUndefined();
			} else {
				expect(await onRename(session, "Renamed title")).toBe("Renamed title");
				await storage.drain();
				expect(await (await reopen()).readText(sessionFile)).toContain("Renamed title");
			}
		});
	}
});
