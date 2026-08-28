import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { deleteConfigFile, readConfigFile, writeConfigFileAtomic } from "@oh-my-pi/pi-coding-agent/state-broker/config-files";

// These tests exercise the untrusted-`rel` sandbox in `config-files`: a broker
// peer controls the relative key, so a `../`, an absolute path, or — the case a
// purely lexical check misses — a symlinked parent pointing outside the agent
// dir must never let a write or unlink escape. Everything runs against real
// temp dirs and real symlinks so the `fs.realpathSync` guard is genuinely under
// test; the agent dir is always passed explicitly, never via global state.
describe("state-broker config-files sandbox", () => {
	let agentDir = "";
	// A sibling dir OUTSIDE the agent dir that a malicious symlink targets.
	let outsideDir = "";

	beforeEach(() => {
		agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-cfg-agent-"));
		outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "sb-cfg-outside-"));
	});

	afterEach(() => {
		fs.rmSync(agentDir, { recursive: true, force: true });
		fs.rmSync(outsideDir, { recursive: true, force: true });
	});

	test("write through a symlinked parent dir is rejected instead of escaping", () => {
		// `agents/` is a symlink out of the agent dir; a lexical resolve of
		// `agents/evil.md` still starts with the agent dir, so only realpath
		// resolution can catch it. Failure mode: remote push writes into an
		// arbitrary location the symlink points at.
		fs.symlinkSync(outsideDir, path.join(agentDir, "agents"), "dir");

		expect(() => writeConfigFileAtomic(agentDir, path.join("agents", "evil.md"), "pwned", Date.now())).toThrow(
			/escapes agent dir/,
		);
		// Nothing may have leaked into the symlink target.
		expect(fs.existsSync(path.join(outsideDir, "evil.md"))).toBe(false);
	});

	test("delete through a symlinked parent dir is rejected and leaves the target intact", () => {
		// A real file sits in the outside dir; a symlinked `agents/` would let a
		// tombstone delete reach it. Failure mode: remote unlink erases files
		// outside the sandbox.
		const victim = path.join(outsideDir, "victim.md");
		fs.writeFileSync(victim, "keep me");
		fs.symlinkSync(outsideDir, path.join(agentDir, "agents"), "dir");

		expect(() => deleteConfigFile(agentDir, path.join("agents", "victim.md"))).toThrow(/escapes agent dir/);
		expect(fs.existsSync(victim)).toBe(true);
	});

	test("nested create under a real directory still succeeds when the leaf is absent", () => {
		// The create case must remain allowed: intermediate dirs and the leaf do
		// not exist yet, and no component is a symlink. Failure mode: an
		// over-strict guard rejects legitimate first-time writes.
		const rel = path.join("agents", "sub", "new.md");
		const stamp = 1_700_000_000_000;

		writeConfigFileAtomic(agentDir, rel, "hello", stamp);

		const written = path.join(agentDir, rel);
		expect(fs.existsSync(written)).toBe(true);
		expect(readConfigFile(agentDir, rel)).toBe("hello");
		// mtime is pinned to the remote rev (seconds granularity).
		expect(Math.round(fs.statSync(written).mtimeMs)).toBe(stamp);
	});

	test("plain `../` traversal is rejected on write", () => {
		// Failure mode: a lexical escape lands a write in the agent dir's parent.
		expect(() => writeConfigFileAtomic(agentDir, path.join("..", "escape.md"), "x", Date.now())).toThrow(
			/escapes agent dir/,
		);
		expect(fs.existsSync(path.join(agentDir, "..", "escape.md"))).toBe(false);
	});

	test("absolute path is rejected on write", () => {
		// Failure mode: an absolute key writes wherever the peer names.
		const target = path.join(outsideDir, "abs.md");
		expect(() => writeConfigFileAtomic(agentDir, target, "x", Date.now())).toThrow(/absolute path rejected/);
		expect(fs.existsSync(target)).toBe(false);
	});
});
