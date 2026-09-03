/**
 * End-to-end proof of the `registerFileWriteFallback` seam: a REAL extension,
 * loaded through the REAL loader/runner pipeline, registered on a REAL
 * `createAgentSession` session, intercepting a REAL EACCES raised by the
 * kernel for a genuinely-unwritable destination — not a fake resolver
 * standing in for the extension path.
 *
 * Permission denial is simulated without a sandbox, since real permission
 * bits behave differently depending on whether the destination already
 * exists:
 * - `write` targets a NEW file inside a directory chmod'd `0o500` (no write
 *   bit). Creating a file needs write permission on the *directory*, so this
 *   raises a real EACCES on `Bun.write`.
 * - `edit` overwrites an EXISTING file chmod'd `0o400` (no write bit). Bun
 *   opens the existing inode directly for the rewrite, so a locked
 *   *directory* alone does NOT block it (verified empirically) — only a
 *   locked *file* does.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type {
	ExtensionActions,
	ExtensionContextActions,
	ExtensionFactory,
	ExtensionRunner,
} from "@oh-my-pi/pi-coding-agent/extensibility/extensions";
import { type CreateAgentSessionOptions, createAgentSession, discoverAuthStorage } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { FileWriteFallbackRequest } from "@oh-my-pi/pi-coding-agent/tools/file-write-fallback";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

/**
 * Drives `ExtensionRunner.initialize` with no-op stubs, mirroring what a mode
 * controller (interactive/RPC/ACP/print/subagent) does after
 * `createAgentSession` returns. Without this, `registerFileWriteFallback`
 * handlers never install: `ExtensionRunner` binds them to a live `ctx` inside
 * `initialize`, not at extension-load time.
 */
function initializeRunnerForTest(runner: ExtensionRunner | undefined): void {
	if (!runner) return;
	const actions: ExtensionActions = {
		sendMessage: () => {},
		sendUserMessage: () => {},
		appendEntry: () => {},
		setLabel: () => {},
		getActiveTools: () => [],
		getAllTools: () => [],
		setActiveTools: async () => {},
		getCommands: () => [],
		setModel: async () => false,
		getThinkingLevel: () => undefined,
		setThinkingLevel: () => {},
		getSessionName: () => undefined,
		setSessionName: async () => {},
	};
	const contextActions: ExtensionContextActions = {
		getModel: () => undefined,
		isIdle: () => true,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: async () => {},
		getSystemPrompt: () => [],
	};
	runner.initialize(actions, contextActions);
}

function resultText(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
		.map(b => b.text)
		.join("\n");
}

const HASHLINE_HEADER_LINE = /^\[([^#\r\n]+)#([0-9A-F]{4})\]$/;

describe("registerFileWriteFallback end-to-end (real extension, real session)", () => {
	const tempDirs: string[] = [];
	const lockedDirs: string[] = [];
	let modelRegistry!: ModelRegistry;
	let registryAuthDir: string;

	const makeTempDir = (): string => {
		const created = path.join(os.tmpdir(), `pi-file-write-fallback-e2e-${Snowflake.next()}`);
		fs.mkdirSync(created, { recursive: true });
		// The seam brokers a symlink-RESOLVED path, and `os.tmpdir()` sits under `/var`
		// — itself a link — on macOS. Canonicalizing the fixture up front keeps a
		// handler's `req.dst` comparable to the path a test built.
		const tempDir = fs.realpathSync.native(created);
		tempDirs.push(tempDir);
		return tempDir;
	};

	/** Tighten a mode and register it for restoration in `afterEach`, not in the test body. */
	const lock = (target: string, mode: number): void => {
		lockedDirs.push(target);
		fs.chmodSync(target, mode);
	};

	// Mode bits do not constrain a privileged user, so `chmod` denies nothing as root
	// and every expectation that depends on a real denial would fail for a reason
	// unrelated to the seam. Root is real for a Docker-based local run and for a
	// self-hosted CI runner. `getuid` is undefined on Windows, where these modes are
	// not enforced either.
	const itDenied = it.skipIf(process.platform === "win32" || process.getuid?.() === 0);

	const baseOptions = (tempDir: string, extensions: ExtensionFactory[]): CreateAgentSessionOptions => ({
		cwd: tempDir,
		agentDir: tempDir,
		modelRegistry,
		sessionManager: SessionManager.inMemory(),
		settings: Settings.isolated(),
		model: getBundledModel("openai", "gpt-4o-mini"),
		disableExtensionDiscovery: true,
		extensions,
		skills: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		enableMCP: false,
		enableLsp: false,
		rules: [],
		workspaceTree: { rootPath: tempDir, rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	});

	beforeAll(async () => {
		registryAuthDir = path.join(os.tmpdir(), `pi-file-write-fallback-e2e-auth-${Snowflake.next()}`);
		fs.mkdirSync(registryAuthDir, { recursive: true });
		modelRegistry = new ModelRegistry(await discoverAuthStorage(registryAuthDir));
	});

	afterAll(() => {
		removeSyncWithRetries(registryAuthDir);
	});

	// Restore every mode this file tightened BEFORE removing the trees. A test that
	// throws before its own `finally` would otherwise leave a 0o500 directory behind,
	// and `removeSyncWithRetries` only retries on Windows — on macOS/Linux it throws
	// EACCES, aborting this loop after `splice(0)` already emptied the list, which
	// strands every remaining temp dir for the rest of the run.
	afterEach(() => {
		for (const dir of lockedDirs.splice(0)) {
			try {
				fs.chmodSync(dir, 0o700);
			} catch {
				// Already gone, or never created: nothing to restore.
			}
		}
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
	});

	itDenied(
		"write: a permission-denied create succeeds through a registered fallback, and a follow-up hashline edit on the real path works",
		async () => {
			const tempDir = makeTempDir();
			const lockedDir = path.join(tempDir, "locked-write");
			fs.mkdirSync(lockedDir, { recursive: true });
			lock(lockedDir, 0o500); // no write bit: creating a file here needs dir-write

			const received: FileWriteFallbackRequest[] = [];
			const ownSessionIds: string[] = [];
			const factory: ExtensionFactory = pi => {
				pi.registerFileWriteFallback(async (req, ctx) => {
					received.push(req);
					ownSessionIds.push(ctx.sessionManager.getSessionId());
					// Stand-in for an out-of-process privileged broker: this test's own
					// user cannot write into `lockedDir`, so relax the permission bit
					// just long enough to place the exact bytes the tool intended, then
					// restore it — proving the handler alone determined success, not
					// some ambient permission the tool already had.
					fs.chmodSync(lockedDir, 0o700);
					try {
						fs.writeFileSync(req.dst, req.content);
					} finally {
						fs.chmodSync(lockedDir, 0o500);
					}
					return true;
				});
			};

			const { session } = await createAgentSession(baseOptions(tempDir, [factory]));
			initializeRunnerForTest(session.extensionRunner);

			try {
				const writeTool = session.getToolByName("write") as AgentTool | undefined;
				expect(writeTool).toBeDefined();

				const targetPath = path.join(lockedDir, "new-file.txt");
				const content = "export const value = 42;\n";

				const writeResult = await writeTool!.execute("call-write-1", { path: targetPath, content });

				// (i) the tool call succeeds
				expect(writeResult.isError).not.toBe(true);
				// (ii) the fallback received the exact intended bytes and the real destination path
				expect(received).toHaveLength(1);
				expect(received[0]?.dst).toBe(targetPath);
				expect(received[0]?.content).toBe(content);
				// (ii-b) and it can tell WHOSE write it was: the registry is process-wide, so
				// the request names the issuing session and `ctx` names the handler's own.
				// Both defined and equal here, which only holds if the tool-execution scope
				// that carries the session id is actually entered.
				expect(ownSessionIds[0]).toMatch(/./);
				expect(received[0]?.sessionId).toBe(ownSessionIds[0]);
				expect(fs.readFileSync(targetPath, "utf8")).toBe(content);

				const headerLine = resultText(writeResult).split("\n")[0] ?? "";
				expect(HASHLINE_HEADER_LINE.test(headerLine)).toBe(true);

				// (iii) a subsequent hashline edit on the SAME real path works — this only
				// holds if the write tool recorded its snapshot under `targetPath` itself
				// (not a temp path the fallback happened to route through).
				const editTool = session.getToolByName("edit") as AgentTool | undefined;
				expect(editTool).toBeDefined();
				const editInput = `${headerLine}\nPUT 1-1:\n+export const value = 43;\n`;
				const editResult = await editTool!.execute("call-edit-1", { input: editInput });

				expect(editResult.isError).not.toBe(true);
				expect(fs.readFileSync(targetPath, "utf8")).toBe("export const value = 43;\n");
			} finally {
				fs.chmodSync(lockedDir, 0o700);
				await session.dispose();
			}
		},
	);

	itDenied(
		"edit: a permission-denied overwrite of an existing file succeeds through a registered fallback",
		async () => {
			const tempDir = makeTempDir();
			const targetPath = path.join(tempDir, "existing.txt");
			const originalContent = "export const enabled = false;\n";
			fs.writeFileSync(targetPath, originalContent);
			lock(targetPath, 0o400); // no write bit on the file itself

			const received: FileWriteFallbackRequest[] = [];
			const factory: ExtensionFactory = pi => {
				pi.registerFileWriteFallback(async req => {
					received.push(req);
					fs.chmodSync(targetPath, 0o600);
					try {
						fs.writeFileSync(req.dst, req.content);
					} finally {
						fs.chmodSync(targetPath, 0o400);
					}
					return true;
				});
			};

			const { session } = await createAgentSession(baseOptions(tempDir, [factory]));
			initializeRunnerForTest(session.extensionRunner);

			try {
				// A prior `read` is required to seed the file-snapshot tag the hashline
				// edit addresses, mirroring how the model would discover an existing
				// file's current tag before patching it.
				const readTool = session.getToolByName("read") as AgentTool | undefined;
				expect(readTool).toBeDefined();
				const readResult = await readTool!.execute("call-read-1", { path: targetPath });
				const readHeaderLine = resultText(readResult).split("\n")[0] ?? "";
				expect(HASHLINE_HEADER_LINE.test(readHeaderLine)).toBe(true);

				const editTool = session.getToolByName("edit") as AgentTool | undefined;
				expect(editTool).toBeDefined();
				const editInput = `${readHeaderLine}\nPUT 1-1:\n+export const enabled = true;\n`;
				const editResult = await editTool!.execute("call-edit-2", { input: editInput });

				expect(editResult.isError).not.toBe(true);
				expect(received).toHaveLength(1);
				expect(received[0]?.dst).toBe(targetPath);
				expect(received[0]?.content).toBe("export const enabled = true;\n");
				expect(fs.readFileSync(targetPath, "utf8")).toBe("export const enabled = true;\n");
			} finally {
				fs.chmodSync(targetPath, 0o600);
				await session.dispose();
			}
		},
	);

	itDenied("edit: a hashline MV into an unwritable directory succeeds through a registered fallback", async () => {
		// `MV` is the one `edit` write that never passes through the LSP writethrough
		// (`HashlineFilesystem.move` writes the destination directly), so it needs its
		// own end-to-end proof that the seam covers it.
		const tempDir = makeTempDir();
		const sourcePath = path.join(tempDir, "source.txt");
		fs.writeFileSync(sourcePath, "export const stage = 1;\n");
		const lockedDir = path.join(tempDir, "locked-move");
		fs.mkdirSync(lockedDir, { recursive: true });
		lock(lockedDir, 0o500);
		const destPath = path.join(lockedDir, "moved.txt");

		const received: FileWriteFallbackRequest[] = [];
		const factory: ExtensionFactory = pi => {
			pi.registerFileWriteFallback(async req => {
				received.push(req);
				fs.chmodSync(lockedDir, 0o700);
				try {
					fs.writeFileSync(req.dst, req.content);
				} finally {
					fs.chmodSync(lockedDir, 0o500);
				}
				return true;
			});
		};

		const { session } = await createAgentSession(baseOptions(tempDir, [factory]));
		initializeRunnerForTest(session.extensionRunner);

		try {
			const readTool = session.getToolByName("read") as AgentTool | undefined;
			expect(readTool).toBeDefined();
			const readResult = await readTool!.execute("call-read-mv", { path: sourcePath });
			const readHeaderLine = resultText(readResult).split("\n")[0] ?? "";
			expect(HASHLINE_HEADER_LINE.test(readHeaderLine)).toBe(true);

			const editTool = session.getToolByName("edit") as AgentTool | undefined;
			expect(editTool).toBeDefined();
			const editInput = [readHeaderLine, "PUT 1-1:", "+export const stage = 2;", `MV ${destPath}`, ""].join("\n");
			const editResult = await editTool!.execute("call-edit-mv", { input: editInput });

			expect(editResult.isError).not.toBe(true);
			expect(received).toHaveLength(1);
			expect(received[0]?.dst).toBe(destPath);
			expect(received[0]?.content).toBe("export const stage = 2;\n");
			expect(fs.readFileSync(destPath, "utf8")).toBe("export const stage = 2;\n");
			// `move` unlinks the source after the destination lands.
			expect(fs.existsSync(sourcePath)).toBe(false);
		} finally {
			fs.chmodSync(lockedDir, 0o700);
			await session.dispose();
		}
	});

	it("edit: a hashline MV with no handler registered behaves exactly as before", async () => {
		// Guards the seam's inertness claim on the one site that now reaches it
		// outside the writethrough: with nothing registered, a plain MV must still
		// move the file and this package has no other coverage for that path.
		const tempDir = makeTempDir();
		const sourcePath = path.join(tempDir, "plain-source.txt");
		fs.writeFileSync(sourcePath, "export const stage = 1;\n");
		const destPath = path.join(tempDir, "nested", "plain-dest.txt");

		const { session } = await createAgentSession(baseOptions(tempDir, []));
		initializeRunnerForTest(session.extensionRunner);

		try {
			const readTool = session.getToolByName("read") as AgentTool | undefined;
			const readResult = await readTool!.execute("call-read-plain", { path: sourcePath });
			const readHeaderLine = resultText(readResult).split("\n")[0] ?? "";
			expect(HASHLINE_HEADER_LINE.test(readHeaderLine)).toBe(true);

			const editTool = session.getToolByName("edit") as AgentTool | undefined;
			const editInput = [readHeaderLine, "PUT 1-1:", "+export const stage = 2;", `MV ${destPath}`, ""].join("\n");
			const editResult = await editTool!.execute("call-edit-plain-mv", { input: editInput });

			expect(editResult.isError).not.toBe(true);
			expect(fs.readFileSync(destPath, "utf8")).toBe("export const stage = 2;\n");
			expect(fs.existsSync(sourcePath)).toBe(false);
		} finally {
			await session.dispose();
		}
	});

	itDenied("edit: a permission-denied REM succeeds through a registered delete fallback", async () => {
		// `REM` unlinks the file, which is a different primitive from the byte-write and
		// has its own seam. A write fallback must NOT be consulted for it: a write
		// handler brokers `content` to `dst`, so a delete arriving there would truncate
		// the file instead of removing it.
		const tempDir = makeTempDir();
		const lockedDir = path.join(tempDir, "locked-rem");
		fs.mkdirSync(lockedDir, { recursive: true });
		const targetPath = path.join(lockedDir, "doomed.txt");
		fs.writeFileSync(targetPath, "export const stage = 1;\n");
		lock(lockedDir, 0o500);

		const deleted: string[] = [];
		const writeCalls: string[] = [];
		const factory: ExtensionFactory = pi => {
			pi.registerFileWriteFallback(async req => {
				writeCalls.push(req.dst);
				return false;
			});
			pi.registerFileDeleteFallback(async req => {
				deleted.push(req.dst);
				fs.chmodSync(lockedDir, 0o700);
				try {
					fs.rmSync(req.dst);
				} finally {
					fs.chmodSync(lockedDir, 0o500);
				}
				return true;
			});
		};

		const { session } = await createAgentSession(baseOptions(tempDir, [factory]));
		initializeRunnerForTest(session.extensionRunner);

		try {
			const readTool = session.getToolByName("read") as AgentTool | undefined;
			const readResult = await readTool!.execute("call-read-rem", { path: targetPath });
			const readHeaderLine = resultText(readResult).split("\n")[0] ?? "";
			expect(HASHLINE_HEADER_LINE.test(readHeaderLine)).toBe(true);

			const editTool = session.getToolByName("edit") as AgentTool | undefined;
			const editResult = await editTool!.execute("call-edit-rem", {
				input: [readHeaderLine, "REM", ""].join("\n"),
			});

			expect(editResult.isError).not.toBe(true);
			expect(deleted).toEqual([targetPath]);
			expect(writeCalls).toEqual([]);
			expect(fs.existsSync(targetPath)).toBe(false);
		} finally {
			fs.chmodSync(lockedDir, 0o700);
			await session.dispose();
		}
	});

	itDenied("write: a throwing handler does not skip later handlers from the SAME extension", async () => {
		// The registry sees ONE trampoline per extension, so per-handler isolation has to
		// live inside that trampoline. Without it, a throw from the first handler escapes
		// to the registry, which advances to the next EXTENSION — so every later handler
		// this extension registered is skipped, breaking both the documented "a throwing
		// handler is skipped" rule and registration order for a backup-handler setup.
		const tempDir = makeTempDir();
		const lockedDir = path.join(tempDir, "locked-order");
		fs.mkdirSync(lockedDir, { recursive: true });
		lock(lockedDir, 0o500);

		const order: string[] = [];
		const factory: ExtensionFactory = pi => {
			pi.registerFileWriteFallback(async () => {
				order.push("throws");
				throw new Error("first handler blew up");
			});
			pi.registerFileWriteFallback(async () => {
				order.push("declines");
				return false;
			});
			pi.registerFileWriteFallback(async req => {
				order.push("brokers");
				fs.chmodSync(lockedDir, 0o700);
				try {
					fs.writeFileSync(req.dst, req.content);
				} finally {
					fs.chmodSync(lockedDir, 0o500);
				}
				return true;
			});
		};

		const { session } = await createAgentSession(baseOptions(tempDir, [factory]));
		initializeRunnerForTest(session.extensionRunner);

		try {
			const targetPath = path.join(lockedDir, "ordered.txt");
			const content = "export const value = 3;\n";
			const writeTool = session.getToolByName("write") as AgentTool | undefined;
			const writeResult = await writeTool!.execute("call-write-order", { path: targetPath, content });

			expect(writeResult.isError).not.toBe(true);
			expect(order).toEqual(["throws", "declines", "brokers"]);
			expect(fs.readFileSync(targetPath, "utf8")).toBe(content);
		} finally {
			fs.chmodSync(lockedDir, 0o700);
			await session.dispose();
		}
	});

	itDenied("write: a handler sees the session's CURRENT cwd, not the one captured at init", async () => {
		// Handlers are installed once, at `ExtensionRunner.initialize`, but every other
		// extension dispatch builds its `ExtensionContext` per call — and `createContext`
		// materializes `cwd` as a value. A trampoline holding one context for the life of
		// the session would keep reporting the workspace it initialized in, so a handler
		// that scopes or prompts against `ctx.cwd` would allow the old workspace and deny
		// the new one after a `/move`.
		const tempDir = makeTempDir();
		const lockedDir = path.join(tempDir, "locked-cwd");
		fs.mkdirSync(lockedDir, { recursive: true });
		lock(lockedDir, 0o500);

		const seenCwds: string[] = [];
		const factory: ExtensionFactory = pi => {
			pi.registerFileWriteFallback(async (req, ctx) => {
				seenCwds.push(ctx.cwd);
				fs.chmodSync(lockedDir, 0o700);
				try {
					fs.writeFileSync(req.dst, req.content);
				} finally {
					fs.chmodSync(lockedDir, 0o500);
				}
				return true;
			});
		};

		const { session } = await createAgentSession(baseOptions(tempDir, [factory]));
		initializeRunnerForTest(session.extensionRunner);

		// Stands in for `SessionManager.moveTo()` without relocating real session files:
		// `getCwd()` is the session's own source of truth for its workspace, and it is
		// what `ExtensionRunner.cwd` reads.
		const moved = path.join(tempDir, "moved-workspace");
		fs.mkdirSync(moved, { recursive: true });
		const cwdSpy = spyOn(session.sessionManager, "getCwd").mockReturnValue(moved);

		try {
			const writeTool = session.getToolByName("write") as AgentTool | undefined;
			const writeResult = await writeTool!.execute("call-write-cwd", {
				path: path.join(lockedDir, "after-move.txt"),
				content: "export const value = 4;\n",
			});

			expect(writeResult.isError).not.toBe(true);
			expect(seenCwds).toEqual([moved]);
		} finally {
			cwdSpy.mockRestore();
			fs.chmodSync(lockedDir, 0o700);
			await session.dispose();
		}
	});

	itDenied(
		"edit: a hashline MV OUT of an undeletable directory removes the source through the delete seam",
		async () => {
			// `HashlineFilesystem.move` writes the destination and then unlinks the source as
			// two separate primitives. Moving INTO a locked directory only exercises the
			// write seam, because the source sits in the writable workspace. This is the
			// mirror case, and the only end-to-end cover for the source-unlink site: before
			// the delete seam the destination landed and the unlink threw, so the move failed
			// with the original left behind.
			const tempDir = makeTempDir();
			const lockedDir = path.join(tempDir, "locked-source");
			fs.mkdirSync(lockedDir, { recursive: true });
			const sourcePath = path.join(lockedDir, "escaping.txt");
			fs.writeFileSync(sourcePath, "export const stage = 1;\n");
			const destPath = path.join(tempDir, "escaped.txt");
			lock(lockedDir, 0o500);

			const deleted: string[] = [];
			const factory: ExtensionFactory = pi => {
				pi.registerFileDeleteFallback(async req => {
					deleted.push(req.dst);
					fs.chmodSync(lockedDir, 0o700);
					try {
						fs.rmSync(req.dst);
					} finally {
						fs.chmodSync(lockedDir, 0o500);
					}
					return true;
				});
			};

			const { session } = await createAgentSession(baseOptions(tempDir, [factory]));
			initializeRunnerForTest(session.extensionRunner);

			try {
				const readTool = session.getToolByName("read") as AgentTool | undefined;
				const readResult = await readTool!.execute("call-read-mv-out", { path: sourcePath });
				const readHeaderLine = resultText(readResult).split("\n")[0] ?? "";
				expect(HASHLINE_HEADER_LINE.test(readHeaderLine)).toBe(true);

				const editTool = session.getToolByName("edit") as AgentTool | undefined;
				const editResult = await editTool!.execute("call-edit-mv-out", {
					input: [readHeaderLine, "PUT 1-1:", "+export const stage = 2;", `MV ${destPath}`, ""].join("\n"),
				});

				expect(editResult.isError).not.toBe(true);
				expect(deleted).toEqual([sourcePath]);
				expect(fs.readFileSync(destPath, "utf8")).toBe("export const stage = 2;\n");
				expect(fs.existsSync(sourcePath)).toBe(false);
			} finally {
				fs.chmodSync(lockedDir, 0o700);
				await session.dispose();
			}
		},
	);
});
