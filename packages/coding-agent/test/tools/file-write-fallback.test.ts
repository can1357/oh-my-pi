import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { applyPatch } from "@oh-my-pi/pi-coding-agent/edit/modes/patch";
import {
	addFileDeleteFallback,
	addFileWriteFallback,
	deleteFileWithFallback,
	isPermissionDeniedError,
	withFileMutationSession,
	writeFileWithFallback,
} from "@oh-my-pi/pi-coding-agent/tools/file-write-fallback";

/** Mimics a Node/Bun filesystem error with a structured `code`, without touching a real fs. */
function fsError(code: string, message = `${code}: simulated`): NodeJS.ErrnoException {
	const error = new Error(message) as NodeJS.ErrnoException;
	error.code = code;
	return error;
}

describe("isPermissionDeniedError", () => {
	it("is true for EPERM, EACCES, and EROFS error codes", () => {
		expect(isPermissionDeniedError(fsError("EPERM"))).toBe(true);
		expect(isPermissionDeniedError(fsError("EACCES"))).toBe(true);
		expect(isPermissionDeniedError(fsError("EROFS"))).toBe(true);
	});

	it("is false for unrelated error codes", () => {
		expect(isPermissionDeniedError(fsError("ENOENT"))).toBe(false);
		expect(isPermissionDeniedError(fsError("EISDIR"))).toBe(false);
		expect(isPermissionDeniedError(fsError("ENOSPC"))).toBe(false);
	});

	it("is false for a plain error with no code or matching message", () => {
		expect(isPermissionDeniedError(new Error("something else went wrong"))).toBe(false);
		expect(isPermissionDeniedError("not an error")).toBe(false);
		expect(isPermissionDeniedError(undefined)).toBe(false);
	});

	it("defensively matches a permission code embedded only in the message", () => {
		// A bridged/transport write can surface a denial as a plain Error with no code.
		expect(isPermissionDeniedError(new Error("write failed: EACCES permission denied"))).toBe(true);
	});

	it("trusts a structured code over a permission name appearing in the path", () => {
		// Bun embeds the full path in fs error messages, so a directory literally named
		// EACCES would otherwise make an ordinary missing-path ENOENT look like a denial
		// and divert a write that should just fail.
		expect(isPermissionDeniedError(fsError("ENOENT", "ENOENT: no such file, open '/repo/EACCES/x.txt'"))).toBe(false);
	});
});

describe("writeFileWithFallback", () => {
	const disposers: Array<() => void> = [];
	afterEach(() => {
		for (const dispose of disposers.splice(0)) dispose();
	});

	/** A `BunFile`-shaped stub whose `.write()` always fails with `error`. */
	function denyingFile(error: unknown): { write: (content: string) => Promise<number> } {
		return {
			write: async () => {
				throw error;
			},
		};
	}

	it("diverts a permission-denied write to a registered handler", async () => {
		const seen: Array<{ dst: string; content: string }> = [];
		disposers.push(
			addFileWriteFallback(async req => {
				seen.push({ dst: req.dst, content: req.content });
				return true;
			}),
		);

		await writeFileWithFallback("/denied/path.txt", "payload", denyingFile(fsError("EACCES")) as never);

		expect(seen).toEqual([{ dst: "/denied/path.txt", content: "payload" }]);
	});

	it("names the session that issued the write, and reports none outside a tool call", async () => {
		// The registry is process-wide, so a handler can be asked about a write from a
		// session other than its own. Without this it cannot tell the difference, which
		// is what makes a per-session decision (or a prompt through the right session's
		// UI) impossible.
		const seen: Array<string | undefined> = [];
		disposers.push(
			addFileWriteFallback(async req => {
				seen.push(req.sessionId);
				return true;
			}),
		);

		await withFileMutationSession("session-a", () =>
			writeFileWithFallback("/denied/path.txt", "payload", denyingFile(fsError("EACCES")) as never),
		);
		// No scope: an external `applyPatch` caller is not attributable to a session,
		// and inventing one would be worse than saying so.
		await writeFileWithFallback("/denied/path.txt", "payload", denyingFile(fsError("EACCES")) as never);

		expect(seen).toEqual(["session-a", undefined]);
	});

	it("rethrows a non-permission error without consulting any handler", async () => {
		let called = false;
		disposers.push(
			addFileWriteFallback(async () => {
				called = true;
				return true;
			}),
		);

		await expect(
			writeFileWithFallback("/denied/path.txt", "payload", denyingFile(fsError("EISDIR")) as never),
		).rejects.toMatchObject({ code: "EISDIR" });
		expect(called).toBe(false);
	});

	it("retries an ENOENT at most once when the parent turns out to be creatable", async () => {
		// A creatable parent means the ENOENT was a race, not a boundary: the helper
		// creates the directory and repeats the write. This stub keeps failing, which
		// pins the retry at exactly one extra attempt instead of spinning.
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "fallback-race-"));
		let attempts = 0;
		let handlerCalled = false;
		disposers.push(
			addFileWriteFallback(async () => {
				handlerCalled = true;
				return true;
			}),
		);
		const file = {
			write: async () => {
				attempts += 1;
				throw fsError("ENOENT");
			},
		};

		await expect(
			writeFileWithFallback(path.join(root, "fresh", "path.txt"), "payload", file as never),
		).rejects.toMatchObject({ code: "ENOENT" });
		expect(attempts).toBe(2);
		expect(handlerCalled).toBe(false);
		// The repair is the reason the retry happened, so it must be observable.
		expect((await fs.stat(path.join(root, "fresh"))).isDirectory()).toBe(true);

		await fs.rm(root, { recursive: true, force: true });
	});

	it("rethrows the ORIGINAL error when the handler returns false", async () => {
		const cause = fsError("EACCES");
		disposers.push(addFileWriteFallback(async () => false));

		await expect(writeFileWithFallback("/denied/path.txt", "payload", denyingFile(cause) as never)).rejects.toBe(
			cause,
		);
	});

	it("rethrows the ORIGINAL error when every handler throws", async () => {
		const cause = fsError("EACCES");
		disposers.push(
			addFileWriteFallback(async () => {
				throw new Error("handler blew up");
			}),
		);

		await expect(writeFileWithFallback("/denied/path.txt", "payload", denyingFile(cause) as never)).rejects.toBe(
			cause,
		);
	});

	it("falls through a throwing handler to the next registered handler", async () => {
		disposers.push(
			addFileWriteFallback(async () => {
				throw new Error("first handler blew up");
			}),
		);
		let secondCalled = false;
		disposers.push(
			addFileWriteFallback(async () => {
				secondCalled = true;
				return true;
			}),
		);

		await writeFileWithFallback("/denied/path.txt", "payload", denyingFile(fsError("EACCES")) as never);

		expect(secondCalled).toBe(true);
	});

	it("invokes handlers in registration order and stops at the first success", async () => {
		const order: string[] = [];
		disposers.push(
			addFileWriteFallback(async () => {
				order.push("first");
				return false;
			}),
		);
		disposers.push(
			addFileWriteFallback(async () => {
				order.push("second");
				return true;
			}),
		);
		disposers.push(
			addFileWriteFallback(async () => {
				order.push("third");
				return true;
			}),
		);

		await writeFileWithFallback("/denied/path.txt", "payload", denyingFile(fsError("EACCES")) as never);

		expect(order).toEqual(["first", "second"]);
	});

	it("stops receiving writes once its disposer runs", async () => {
		let calls = 0;
		// Registered through `disposers` as well: if an assertion below throws, afterEach
		// still removes the handler. A leaked registration is process-global and would
		// silently swallow denied writes in every later test file.
		const dispose = addFileWriteFallback(async () => {
			calls += 1;
			return true;
		});
		disposers.push(dispose);

		await writeFileWithFallback("/denied/path.txt", "payload", denyingFile(fsError("EACCES")) as never);
		expect(calls).toBe(1);

		dispose();

		await expect(
			writeFileWithFallback("/denied/path.txt", "payload", denyingFile(fsError("EACCES")) as never),
		).rejects.toMatchObject({ code: "EACCES" });
		expect(calls).toBe(1);
	});

	// A privileged user is not constrained by mode bits, so `chmod 0o500` denies
	// nothing and every expectation here would fail for a reason unrelated to this
	// seam. Root is real for a Docker-based local run and for a self-hosted runner.
	describe.skipIf(process.getuid?.() === 0)("against real kernel permissions", () => {
		let root = "";

		beforeEach(async () => {
			// Canonical from the start: the seam hands handlers a symlink-resolved path,
			// and `os.tmpdir()` is under `/var` — itself a link — on macOS, so a lexical
			// fixture path would differ from the brokered one for a reason unrelated to
			// what these tests are about.
			root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "fallback-kernel-")));
		});
		afterEach(async () => {
			// Restore the mode first: a 0o500 directory cannot be emptied.
			await fs.chmod(path.join(root, "locked"), 0o700).catch(() => {});
			await fs.rm(root, { recursive: true, force: true });
		});

		/** A directory the current user may traverse and read, but not create inside. */
		async function lockedDir(): Promise<string> {
			const dir = path.join(root, "locked");
			await fs.mkdir(dir);
			await fs.chmod(dir, 0o500);
			return dir;
		}

		it("diverts a real EACCES from creating a file in an unwritable directory", async () => {
			const dst = path.join(await lockedDir(), "new.txt");
			const seen: Array<{ dst: string; content: string; code: unknown }> = [];
			disposers.push(
				addFileWriteFallback(async req => {
					seen.push({ dst: req.dst, content: req.content, code: (req.cause as NodeJS.ErrnoException).code });
					return true;
				}),
			);

			await writeFileWithFallback(dst, "payload");

			expect(seen).toEqual([{ dst, content: "payload", code: "EACCES" }]);
		});

		it("unmasks a denied parent mkdir that Bun reports as ENOENT", async () => {
			// Bun's write creates missing parents itself and, when that mkdir is denied,
			// surfaces the open()'s ENOENT instead of the denial. Without unmasking, a
			// sandboxed write into a new out-of-tree directory never reaches a handler.
			const dst = path.join(await lockedDir(), "sub", "new.txt");
			const seen: Array<{ dst: string; content: string; code: unknown }> = [];
			disposers.push(
				addFileWriteFallback(async req => {
					seen.push({ dst: req.dst, content: req.content, code: (req.cause as NodeJS.ErrnoException).code });
					return true;
				}),
			);

			await writeFileWithFallback(dst, "payload");

			expect(seen).toEqual([{ dst, content: "payload", code: "EACCES" }]);
		});

		it("attaches the recovered denial as `cause` when no handler takes the write", async () => {
			// The thrown error stays the ENOENT Bun reported, so behaviour matches a host
			// with no fallback registered. But this code has already proven the real
			// boundary is EACCES, and discarding that would hand the caller back exactly
			// the misleading errno this module exists to see through.
			const dst = path.join(await lockedDir(), "sub", "new.txt");
			disposers.push(addFileWriteFallback(async () => false));

			await expect(writeFileWithFallback(dst, "payload")).rejects.toMatchObject({
				code: "ENOENT",
				cause: { code: "EACCES" },
			});
		});

		it("leaves an ENOENT alone when a path component is a file rather than a directory", async () => {
			const blocker = path.join(root, "blocker");
			await Bun.write(blocker, "not a directory");
			let called = false;
			disposers.push(
				addFileWriteFallback(async () => {
					called = true;
					return true;
				}),
			);

			await expect(writeFileWithFallback(path.join(blocker, "child.txt"), "payload")).rejects.toMatchObject({
				code: expect.stringMatching(/^(ENOTDIR|ENOENT)$/),
			});
			expect(called).toBe(false);
		});

		it("brokers the RESOLVED target for a write through a symlink", async () => {
			// The escape this closes: the agent creates a link inside a directory the
			// sandbox permits, pointing at a target it does not. The in-process write
			// follows the link, so the kernel denied the TARGET — but a handler given
			// the LINK would pass its own prefix allowlist, because the link sits inside
			// the allowed root while its target does not. The handler is told where the
			// bytes would really land, so its allowlist judges the real destination.
			const secretDir = path.join(root, "off-limits");
			await fs.mkdir(secretDir);
			const secret = path.join(secretDir, "authorized_keys");
			await Bun.write(secret, "original\n");
			await fs.chmod(secret, 0o400);
			await fs.chmod(secretDir, 0o500);

			const link = path.join(root, "innocent-link");
			await fs.symlink(secret, link);

			const seen: string[] = [];
			disposers.push(
				addFileWriteFallback(async req => {
					seen.push(req.dst);
					// Declining stands in for the allowlist refusal a real helper makes.
					return false;
				}),
			);

			try {
				await expect(writeFileWithFallback(link, "pwned\n")).rejects.toMatchObject({
					code: expect.stringMatching(/^(EACCES|EPERM)$/),
				});
				expect(seen).toEqual([secret]);
				expect(await Bun.file(secret).text()).toBe("original\n");
			} finally {
				await fs.chmod(secretDir, 0o700);
				await fs.chmod(secret, 0o600);
			}
		});

		it("resolves a symlinked ANCESTOR, not just a link at the last component", async () => {
			// `lstat(dst)` alone judges only the final component, so `ws/link/file` under
			// a `ws/link -> /outside` link is a lexically innocent path whose bytes land
			// outside. Every component above the last is followed by the kernel, so the
			// handler has to be told the resolved path for this shape too.
			const outside = path.join(root, "off-limits");
			await fs.mkdir(outside);
			const victim = path.join(outside, "secret.txt");
			await Bun.write(victim, "original\n");
			await fs.chmod(victim, 0o400);
			await fs.chmod(outside, 0o500);

			const linkDir = path.join(root, "innocent-dir");
			await fs.symlink(outside, linkDir);

			const seen: string[] = [];
			disposers.push(
				addFileWriteFallback(async req => {
					seen.push(req.dst);
					return false;
				}),
			);

			try {
				await expect(writeFileWithFallback(path.join(linkDir, "secret.txt"), "pwned\n")).rejects.toMatchObject({
					code: expect.stringMatching(/^(EACCES|EPERM)$/),
				});
				expect(seen).toEqual([victim]);
				expect(await Bun.file(victim).text()).toBe("original\n");
			} finally {
				await fs.chmod(outside, 0o700);
				await fs.chmod(victim, 0o600);
			}
		});

		it("refuses to broker a write through a dangling symlink", async () => {
			// `realpath` cannot name where a dangling link points, and the write follows
			// it, so there is no destination to hand a privileged writer. Refusing is the
			// only honest answer, and it is the one `confineToWorkspace` already gives.
			const dir = path.join(root, "locked");
			await fs.mkdir(dir);
			const dangling = path.join(dir, "dangling");
			await fs.symlink(path.join(dir, "nowhere"), dangling);
			await fs.chmod(dir, 0o500);

			let called = false;
			disposers.push(
				addFileWriteFallback(async () => {
					called = true;
					return true;
				}),
			);

			await expect(writeFileWithFallback(dangling, "payload")).rejects.toMatchObject({
				code: expect.stringMatching(/^(EACCES|EPERM)$/),
			});
			expect(called).toBe(false);
		});

		it("refuses to broker a write whose own metadata is behind the boundary", async () => {
			// A sandbox that denies the write often hides the target's metadata too, so
			// the final component cannot be shown to be a plain name rather than a link —
			// and `open` follows a link there. The delete seam keeps working in this shape
			// because `unlink` never follows the last component; a write cannot.
			const opaque = path.join(root, "opaque");
			await fs.mkdir(opaque);
			await fs.chmod(opaque, 0o000);

			let called = false;
			disposers.push(
				addFileWriteFallback(async () => {
					called = true;
					return true;
				}),
			);

			try {
				await expect(writeFileWithFallback(path.join(opaque, "new.txt"), "payload")).rejects.toMatchObject({
					code: expect.stringMatching(/^(EACCES|EPERM)$/),
				});
				expect(called).toBe(false);
			} finally {
				await fs.chmod(opaque, 0o700);
			}
		});
	});

	// `apply_patch` creates a missing parent before writing, so a denial there used
	// to throw before the write — and therefore before the seam — was ever reached.
	describe.skipIf(process.getuid?.() === 0)("apply_patch into a denied new directory", () => {
		let root = "";
		let locked = "";

		beforeEach(async () => {
			root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "fallback-patch-")));
			locked = path.join(root, "locked");
			await fs.mkdir(locked);
			await fs.chmod(locked, 0o500);
		});
		afterEach(async () => {
			await fs.chmod(locked, 0o700).catch(() => {});
			await fs.rm(root, { recursive: true, force: true });
		});

		it("reaches a registered handler with the bytes for the created file", async () => {
			const brokered: Array<{ dst: string; content: string }> = [];
			disposers.push(
				addFileWriteFallback(async req => {
					brokered.push({ dst: req.dst, content: req.content });
					return true;
				}),
			);

			const target = path.join(locked, "sub", "new.txt");
			const result = await applyPatch({ path: target, op: "create", diff: "hello\n" }, { cwd: root });

			expect(result.change).toMatchObject({ type: "create", path: target });
			expect(brokered).toEqual([{ dst: target, content: "hello\n" }]);
		});

		it("still fails when no handler is registered", async () => {
			const target = path.join(locked, "sub", "new.txt");
			await expect(applyPatch({ path: target, op: "create", diff: "hello\n" }, { cwd: root })).rejects.toMatchObject(
				{
					code: expect.stringMatching(/^(EACCES|EPERM)$/),
				},
			);
		});

		it("never brokers an exclusive create whose destination cannot be proven absent", async () => {
			// `apply_patch`'s `create` refuses to overwrite, and it decides that with
			// `Bun.file(dst).exists()`, which reports `false` when the parent hides the
			// target's metadata instead of distinguishing "absent" from "unknown". The
			// non-overwrite contract survives regardless, because the same denied `lstat`
			// that fools the existence check also stops the seam from brokering: a
			// privileged writer is never handed a destination whose identity is unproven,
			// and it is the only party that could have enforced exclusivity itself.
			//
			// Those are two independent guards in two files, so this pins the pair. If the
			// seam is ever relaxed to broker an unverifiable path, a `create` would start
			// silently clobbering a protected file it was told not to touch.
			const opaque = path.join(root, "opaque");
			await fs.mkdir(opaque);
			const victim = path.join(opaque, "victim.txt");
			await Bun.write(victim, "original\n");
			await fs.chmod(opaque, 0o000);

			let called = false;
			disposers.push(
				addFileWriteFallback(async () => {
					called = true;
					return true;
				}),
			);

			try {
				// The premise: the existence check cannot see the file it must not clobber.
				expect(await Bun.file(victim).exists()).toBe(false);

				await expect(
					applyPatch({ path: victim, op: "create", diff: "clobbered\n" }, { cwd: root }),
				).rejects.toMatchObject({ code: expect.stringMatching(/^(EACCES|EPERM)$/) });
				expect(called).toBe(false);
			} finally {
				await fs.chmod(opaque, 0o700);
			}
			expect(await Bun.file(victim).text()).toBe("original\n");
		});
	});
});

describe("deleteFileWithFallback", () => {
	const disposers: Array<() => void> = [];
	afterEach(() => {
		for (const dispose of disposers.splice(0)) dispose();
	});

	it("rethrows ENOENT without consulting a handler", async () => {
		// `edit`'s REM turns this into a NotFoundError, so it must not be diverted.
		let called = false;
		disposers.push(
			addFileDeleteFallback(async () => {
				called = true;
				return true;
			}),
		);

		await expect(deleteFileWithFallback("/nonexistent/nope.txt")).rejects.toMatchObject({ code: "ENOENT" });
		expect(called).toBe(false);
	});

	it("does not consult a registered WRITE handler", async () => {
		// A write handler brokers `content` to `dst`. If a delete reached it, brokering
		// a request with no content would truncate the file instead of removing it.
		let writeCalled = false;
		disposers.push(
			addFileWriteFallback(async () => {
				writeCalled = true;
				return true;
			}),
		);

		await expect(deleteFileWithFallback("/nonexistent/nope.txt")).rejects.toMatchObject({ code: "ENOENT" });
		expect(writeCalled).toBe(false);
	});

	describe.skipIf(process.getuid?.() === 0)("against real kernel permissions", () => {
		let root = "";
		let locked = "";

		beforeEach(async () => {
			// Canonical from the start; see the write-side note above.
			root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "fallback-del-")));
			locked = path.join(root, "locked");
			await fs.mkdir(locked);
		});
		afterEach(async () => {
			await fs.chmod(locked, 0o700).catch(() => {});
			await fs.rm(root, { recursive: true, force: true });
		});

		/** A file whose containing directory denies the unlink. */
		async function lockedFile(name = "victim.txt"): Promise<string> {
			const target = path.join(locked, name);
			await Bun.write(target, "payload");
			await fs.chmod(locked, 0o500);
			return target;
		}

		it("diverts a real denied unlink to a registered handler, naming its session", async () => {
			const target = await lockedFile();
			const seen: Array<{ dst: string; code: unknown; sessionId: string | undefined }> = [];
			disposers.push(
				addFileDeleteFallback(async req => {
					seen.push({ dst: req.dst, code: (req.cause as NodeJS.ErrnoException).code, sessionId: req.sessionId });
					return true;
				}),
			);

			await withFileMutationSession("session-del", () => deleteFileWithFallback(target));

			expect(seen).toEqual([
				{ dst: target, code: expect.stringMatching(/^(EACCES|EPERM)$/), sessionId: "session-del" },
			]);
		});

		it("rethrows the ORIGINAL error when the handler declines", async () => {
			const target = await lockedFile();
			disposers.push(addFileDeleteFallback(async () => false));

			await expect(deleteFileWithFallback(target)).rejects.toMatchObject({
				code: expect.stringMatching(/^(EACCES|EPERM)$/),
			});
		});

		it("refuses to divert a directory it can confirm, reporting confirmedFile on files", async () => {
			// On Darwin `unlink` on a directory fails EPERM, which by code alone looks
			// exactly like a sandbox denial. Brokering it would ask a privileged deleter
			// to remove a whole directory for a tool that only ever removes one file.
			const dir = path.join(root, "a-directory");
			await fs.mkdir(dir);
			const seen: boolean[] = [];
			disposers.push(
				addFileDeleteFallback(async req => {
					seen.push(req.confirmedFile);
					return true;
				}),
			);

			await expect(deleteFileWithFallback(dir)).rejects.toMatchObject({
				code: expect.stringMatching(/^(EPERM|EISDIR)$/),
			});
			expect(seen).toEqual([]);
			expect((await fs.lstat(dir)).isDirectory()).toBe(true);

			// A file under a directory that denies the unlink but still permits lstat
			// resolves the check, so the handler is told the target is a real file.
			const target = await lockedFile("confirmed.txt");
			await deleteFileWithFallback(target);
			expect(seen).toEqual([true]);
		});

		it("still diverts, unresolved, when the target's own metadata is denied", async () => {
			// A sandbox that denies the unlink usually denies the metadata too, so the
			// directory check cannot run. The write must still reach a handler — that is
			// the whole point of the seam — but the handler has to be TOLD the check was
			// unresolved, or it may recursively remove a path that is really a directory.
			const opaque = path.join(root, "opaque");
			await fs.mkdir(opaque);
			const victim = path.join(opaque, "buried.txt");
			await Bun.write(victim, "payload");
			await fs.chmod(opaque, 0o000);

			const seen: Array<{ dst: string; confirmedFile: boolean }> = [];
			disposers.push(
				addFileDeleteFallback(async req => {
					seen.push({ dst: req.dst, confirmedFile: req.confirmedFile });
					return true;
				}),
			);

			try {
				await deleteFileWithFallback(victim);
				expect(seen).toEqual([{ dst: victim, confirmedFile: false }]);
			} finally {
				await fs.chmod(opaque, 0o700);
			}
		});

		it("rethrows a non-permission lstat failure rather than diverting", async () => {
			// `ENOTDIR` from a path component that is a file is a genuinely bad path, not
			// a boundary, so the seam must not paper over it by consulting a handler.
			const blocker = path.join(root, "not-a-dir");
			await Bun.write(blocker, "payload");
			let called = false;
			disposers.push(
				addFileDeleteFallback(async () => {
					called = true;
					return true;
				}),
			);

			await expect(deleteFileWithFallback(path.join(blocker, "child.txt"))).rejects.toMatchObject({
				code: "ENOTDIR",
			});
			expect(called).toBe(false);
		});

		it("resolves a symlinked ANCESTOR before brokering a delete", async () => {
			// `unlink` follows every component above the last, so a link in the path
			// removes a file outside the allowed root while the lexical path still looks
			// contained. The handler must be told which file actually disappears.
			const outside = path.join(root, "off-limits");
			await fs.mkdir(outside);
			const victim = path.join(outside, "keep.txt");
			await Bun.write(victim, "keep me");
			await fs.chmod(outside, 0o500);

			const linkDir = path.join(root, "innocent-dir");
			await fs.symlink(outside, linkDir);

			const seen: Array<{ dst: string; confirmedFile: boolean }> = [];
			disposers.push(
				addFileDeleteFallback(async req => {
					seen.push({ dst: req.dst, confirmedFile: req.confirmedFile });
					return false;
				}),
			);

			try {
				await expect(deleteFileWithFallback(path.join(linkDir, "keep.txt"))).rejects.toMatchObject({
					code: expect.stringMatching(/^(EACCES|EPERM)$/),
				});
				expect(seen).toEqual([{ dst: victim, confirmedFile: true }]);
				expect(await Bun.file(victim).text()).toBe("keep me");
			} finally {
				await fs.chmod(outside, 0o700);
			}
		});

		it("leaves the LAST component unresolved, reporting confirmedFile false for a link", async () => {
			// `unlink` removes the link itself, so resolving the final component would
			// name the wrong file. Diverting is still right — unlinking a link is a
			// legitimate file removal — but a handler that realpaths `dst` for auditing,
			// or removes it recursively, would act on the link's TARGET, a directory tree
			// here. So the link is brokered as itself, and `confirmedFile` is false even
			// though `lstat` succeeded.
			const targetDir = path.join(root, "link-target-dir");
			await fs.mkdir(targetDir);
			await Bun.write(path.join(targetDir, "keep.txt"), "keep me");
			const link = path.join(locked, "dir-link");
			await fs.symlink(targetDir, link);
			await fs.chmod(locked, 0o500);

			const seen: Array<{ dst: string; confirmedFile: boolean }> = [];
			disposers.push(
				addFileDeleteFallback(async req => {
					seen.push({ dst: req.dst, confirmedFile: req.confirmedFile });
					return true;
				}),
			);

			await deleteFileWithFallback(link);

			expect(seen).toEqual([{ dst: link, confirmedFile: false }]);
			// The target must be untouched: the seam only ever asked for the link.
			expect(await Bun.file(path.join(targetDir, "keep.txt")).text()).toBe("keep me");
		});

		it("diverts a denied unlink issued through a BunFile handle", async () => {
			// `LspFileSystem.delete` is the only caller that passes a `BunFile`, and it is
			// covered only transitively, so the `file.unlink()` branch would otherwise
			// never be exercised directly.
			const target = await lockedFile("via-handle.txt");
			const seen: string[] = [];
			disposers.push(
				addFileDeleteFallback(async req => {
					seen.push(req.dst);
					return true;
				}),
			);

			await deleteFileWithFallback(target, Bun.file(target));

			expect(seen).toEqual([target]);
		});

		it("routes an apply_patch delete op through the seam", async () => {
			const target = await lockedFile("doomed.txt");
			const removed: string[] = [];
			disposers.push(
				addFileDeleteFallback(async req => {
					await fs.chmod(locked, 0o700);
					await fs.unlink(req.dst);
					removed.push(req.dst);
					return true;
				}),
			);

			const result = await applyPatch({ path: target, op: "delete" }, { cwd: root });

			expect(result.change).toMatchObject({ type: "delete", path: target });
			expect(removed).toEqual([target]);
			expect(await Bun.file(target).exists()).toBe(false);
		});
	});
});
