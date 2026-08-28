import { afterEach, describe, expect, it, vi } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pythonBackend } from "@oh-my-pi/pi-coding-agent/eval";
import {
	LocalProtocolHandler,
	type LocalProtocolOptions,
} from "@oh-my-pi/pi-coding-agent/internal-urls/local-protocol";
import { executeAcpBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/acp-builtins";
import type { AcpBuiltinSlashCommandResult, SlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { isEnoent } from "@oh-my-pi/pi-utils";

const DISABLE_MESSAGE =
	"RLM mode is disabled. Enable it via the rlm.enabled setting (e.g. omp config set rlm.enabled true).";

async function acpRuntime(options?: {
	enabled?: boolean;
	backends?: Record<string, boolean>;
	localProtocolOptions?: LocalProtocolOptions;
}) {
	const store: Record<string, unknown> = {
		"rlm.enabled": options?.enabled ?? false,
		...options?.backends,
	};
	const settings = {
		get: (path: string) => store[path],
	} as unknown as SlashCommandRuntime["settings"];
	const get = vi.spyOn(settings, "get");
	const output = vi.fn();
	const artifactsDir = await mkdtemp(path.join(os.tmpdir(), "rlm-test-"));
	const sessionManager = {
		getArtifactsDir: () => artifactsDir,
		getSessionId: () => "test-session",
	} as unknown as SlashCommandRuntime["sessionManager"];
	const runtime = {
		settings,
		output,
		sessionManager,
		// Mirrors what the ACP/RPC/TUI dispatchers populate from the session's
		// canonical mapping (AgentSession.getLocalProtocolOptions()): undefined
		// exercises the handler's sessionManager-derived fallback, a value
		// exercises the SDK-host case where the eval sandbox reads local://
		// through a custom root.
		localProtocolOptions: options?.localProtocolOptions,
		cwd: artifactsDir,
	} as unknown as SlashCommandRuntime;
	return { get, output, runtime, artifactsDir };
}

function promptOf(result: AcpBuiltinSlashCommandResult): string {
	if (!result || !("prompt" in result)) throw new Error("expected a { prompt } result");
	return result.prompt;
}

/** Lists the session's local:// root; ENOENT (nothing written yet) reads as empty. */
async function localDirEntries(localDir: string): Promise<string[]> {
	try {
		return await readdir(localDir);
	} catch (error) {
		if (isEnoent(error)) return [];
		throw error;
	}
}

describe("/rlm slash command", () => {
	const tempDirs: string[] = [];

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const dir of tempDirs.splice(0)) await rm(dir, { recursive: true, force: true });
	});

	it("outputs the enable hint and consumes the command when rlm.enabled is false", async () => {
		const h = await acpRuntime({ enabled: false });

		const result = await executeAcpBuiltinSlashCommand("/rlm analyze this input", h.runtime);

		expect(h.get).toHaveBeenCalledWith("rlm.enabled");
		expect(h.output).toHaveBeenCalledWith(DISABLE_MESSAGE);
		expect(result).toEqual({ consumed: true });
	});

	it("does not leak a prompt when the gate is disabled", async () => {
		const h = await acpRuntime({ enabled: false });

		const result = await executeAcpBuiltinSlashCommand("/rlm summarize", h.runtime);

		expect(result).not.toHaveProperty("prompt");
		expect(h.output).toHaveBeenCalledTimes(1);
	});

	it("externalizes the inline request to a local:// file instead of inlining it", async () => {
		const h = await acpRuntime({ enabled: true });
		tempDirs.push(h.artifactsDir);

		const result = await executeAcpBuiltinSlashCommand("/rlm summarize the report", h.runtime);

		expect(h.get).toHaveBeenCalledWith("rlm.enabled");
		expect(h.output).not.toHaveBeenCalled();
		expect(result).not.toEqual({ consumed: true });
		const prompt = promptOf(result);
		// The raw request text must NOT be inlined into the prompt — only a
		// local:// reference the model loads from inside the eval sandbox.
		expect(prompt).not.toContain("summarize the report");
		expect(prompt).toContain("local://rlm-input-");
		expect(prompt).toContain("llm_query");
		expect(prompt).toContain("rlm_query");
		expect(prompt).toContain("task.maxRecursionDepth");

		const match = prompt.match(/local:\/\/(rlm-input-[\w.-]+\.txt)/);
		expect(match).not.toBeNull();
		const writtenPath = path.join(h.artifactsDir, "local", match?.[1] ?? "");
		expect(await Bun.file(writtenPath).text()).toBe("summarize the report");
	});

	it("writes each /rlm payload to a distinct path so a second call never clobbers the first", async () => {
		const h = await acpRuntime({ enabled: true });
		tempDirs.push(h.artifactsDir);

		const first = await executeAcpBuiltinSlashCommand("/rlm summarize the report", h.runtime);
		const second = await executeAcpBuiltinSlashCommand("/rlm summarize the report", h.runtime);

		const firstUrl = promptOf(first).match(/local:\/\/(rlm-input-[\w.-]+\.txt)/)?.[1];
		const secondUrl = promptOf(second).match(/local:\/\/(rlm-input-[\w.-]+\.txt)/)?.[1];
		expect(firstUrl).toBeDefined();
		expect(secondUrl).toBeDefined();
		// Two invocations in the same millisecond used to derive the same
		// Date.now() path, so the second write silently overwrote the first
		// payload and the first rendered prompt analyzed the second request.
		expect(firstUrl).not.toBe(secondUrl);
		expect(await Bun.file(path.join(h.artifactsDir, "local", firstUrl ?? "")).text()).toBe("summarize the report");
		expect(await Bun.file(path.join(h.artifactsDir, "local", secondUrl ?? "")).text()).toBe("summarize the report");
	});

	it("rejects with an actionable message when no eval backend is enabled", async () => {
		const h = await acpRuntime({ enabled: true, backends: { "eval.py": false, "eval.js": false } });

		const result = await executeAcpBuiltinSlashCommand("/rlm summarize the report", h.runtime);

		expect(result).toEqual({ consumed: true });
		expect(h.output).toHaveBeenCalledWith(expect.stringContaining("requires the Python or JavaScript eval backend"));
	});

	it("rejects when only Ruby/Julia are enabled (RLM helpers are py/js-only)", async () => {
		const h = await acpRuntime({
			enabled: true,
			backends: { "eval.py": false, "eval.js": false, "eval.rb": true, "eval.jl": true },
		});

		const result = await executeAcpBuiltinSlashCommand("/rlm summarize the report", h.runtime);

		expect(result).toEqual({ consumed: true });
		expect(h.output).toHaveBeenCalledWith(expect.stringContaining("requires the Python or JavaScript eval backend"));
	});

	it("pins the write to this session's own root, ignoring a process-wide localProtocolOptions override", async () => {
		const h = await acpRuntime({ enabled: true });
		tempDirs.push(h.artifactsDir);
		const overrideDir = await mkdtemp(path.join(os.tmpdir(), "rlm-override-"));
		tempDirs.push(overrideDir);
		LocalProtocolHandler.setOverride({
			getArtifactsDir: () => overrideDir,
			getSessionId: () => "override-session",
		});
		try {
			const result = await executeAcpBuiltinSlashCommand("/rlm summarize the report", h.runtime);
			const prompt = promptOf(result);
			const match = prompt.match(/local:\/\/(rlm-input-[\w.-]+\.txt)/);
			expect(match).not.toBeNull();
			// This fixture's runtime carries no localProtocolOptions, so the
			// handler falls back to the sessionManager-derived mapping. The
			// process-wide override must NOT redirect the write: it is a
			// last-resort branch for callers with no session reference, and in
			// a multi-session process it belongs to whichever session installed
			// it last — pinning the write to an unrelated session's root would
			// be exactly the bug this test guards against.
			const sessionPath = path.join(h.artifactsDir, "local", match?.[1] ?? "");
			expect(await Bun.file(sessionPath).text()).toBe("summarize the report");
			const overriddenPath = path.join(overrideDir, "local", match?.[1] ?? "");
			expect(await Bun.file(overriddenPath).exists()).toBe(false);
		} finally {
			LocalProtocolHandler.resetOverrideForTests();
		}
	});

	it("writes through the runtime's canonical localProtocolOptions when an SDK host supplies a custom mapping", async () => {
		// SDK hosts wire a custom local:// mapping on createAgentSession; eval
		// sandboxes and the model's tools resolve local:// through that
		// (ToolSession.localProtocolOptions), NOT the session manager's
		// artifacts dir. The dispatchers expose the canonical mapping on the
		// runtime, and the payload write must follow it — otherwise the
		// rendered `read("local://…")` instruction points at a root the
		// sandbox never reads from (file-not-found).
		const customDir = await mkdtemp(path.join(os.tmpdir(), "rlm-custom-"));
		tempDirs.push(customDir);
		const h = await acpRuntime({
			enabled: true,
			localProtocolOptions: {
				getArtifactsDir: () => customDir,
				getSessionId: () => "custom-session",
			},
		});
		tempDirs.push(h.artifactsDir);

		const result = await executeAcpBuiltinSlashCommand("/rlm summarize the report", h.runtime);

		const prompt = promptOf(result);
		const match = prompt.match(/local:\/\/(rlm-input-[\w.-]+\.txt)/);
		expect(match).not.toBeNull();
		const customPath = path.join(customDir, "local", match?.[1] ?? "");
		expect(await Bun.file(customPath).text()).toBe("summarize the report");
		const sessionPath = path.join(h.artifactsDir, "local", match?.[1] ?? "");
		expect(await Bun.file(sessionPath).exists()).toBe(false);
	});

	it("renders an explicit no-request marker and skips externalization when invoked without arguments", async () => {
		const h = await acpRuntime({ enabled: true });
		tempDirs.push(h.artifactsDir);

		const result = await executeAcpBuiltinSlashCommand("/rlm", h.runtime);

		// The no-argument branch must still hand the model an actionable
		// prompt: the rendered request slot carries the explicit
		// "(no request text provided)" marker instead of an empty/garbled
		// field the model could not act on.
		const prompt = promptOf(result);
		expect(prompt).toContain("User request: (no request text provided)");
		// And it must not take the inline-payload path: no local:// reference
		// is rendered and no payload file is written for a request with no
		// text (the with-args branch writes one).
		expect(prompt).not.toContain("local://rlm-input-");
		expect(prompt).not.toContain("Inline payload externalized");
		const localDir = path.join(h.artifactsDir, "local");
		expect(await localDirEntries(localDir)).toHaveLength(0);
		expect(h.output).not.toHaveBeenCalled();
	});

	it("preserves leading/trailing whitespace byte-for-byte in the externalized payload", async () => {
		const h = await acpRuntime({ enabled: true });
		tempDirs.push(h.artifactsDir);

		// Indented code block ending with a blank line: the shared slash
		// parser trims command.args, so externalizing the normalized string
		// would strip the leading indentation run and the final newlines
		// before Bun.write. The payload must instead be the exact remainder
		// of the raw command text after "/rlm" and its single separator char
		// — every remaining byte, whitespace included.
		const input = "/rlm    def foo():\n            return 42\n\n";
		const expectedPayload = input.slice("/rlm".length + 1);
		// Guard that this input actually exercises the corruption: the
		// trimmed arg string (what the old code externalized) differs.
		expect(expectedPayload.trim()).not.toBe(expectedPayload);
		expect(expectedPayload).toBe("   def foo():\n            return 42\n\n");

		const result = await executeAcpBuiltinSlashCommand(input, h.runtime);

		const prompt = promptOf(result);
		const match = prompt.match(/local:\/\/(rlm-input-[\w.-]+\.txt)/);
		expect(match).not.toBeNull();
		const writtenPath = path.join(h.artifactsDir, "local", match?.[1] ?? "");
		expect(await Bun.file(writtenPath).text()).toBe(expectedPayload);
		// charCount must describe the lossless payload, not the trimmed one.
		expect(prompt).toContain(`(${expectedPayload.length} chars)`);
	});

	it("externalizes an oversized input end-to-end: full payload on disk, prompt carries only the local:// handle", async () => {
		const h = await acpRuntime({ enabled: true });
		tempDirs.push(h.artifactsDir);

		// ~324k chars — well past a typical model context window (≈64k
		// tokens), exactly the over-window case /rlm exists for. The marker
		// sits mid-payload (after a 150k-char run of "a") so every "not
		// inlined" assertion below is discriminative: if the rendered prompt
		// ever embedded the payload text — whole or prefix-only — the marker,
		// the letter run, or the prompt size would give it away.
		const marker = "OVERSIZED-INPUT-MARKER-7f3a9c";
		const fillerLine = "oversized-input-line-abcdefghijklmnopqrstuvwxyz0123456789\n";
		const oversizedPayload = `${"a".repeat(150_000)}${marker}${fillerLine.repeat(3_000)}`;
		expect(oversizedPayload.length).toBeGreaterThan(200_000);

		const result = await executeAcpBuiltinSlashCommand(`/rlm ${oversizedPayload}`, h.runtime);

		expect(result).not.toEqual({ consumed: true });
		const prompt = promptOf(result);

		// (c) Heart of the externalization: the prompt sent to the model
		// carries only the local:// handle — never the giant payload text.
		expect(prompt).toContain("local://rlm-input-");
		expect(prompt).toContain("Inline payload externalized");
		expect(prompt).not.toContain(marker);
		expect(prompt).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
		expect(prompt).not.toContain("a".repeat(1_000));
		expect(prompt.length).toBeLessThan(oversizedPayload.length);

		// (a)+(b) The artifact exists and holds the payload byte-for-byte,
		// size included — nothing truncated or trimmed on the way to disk.
		const match = prompt.match(/local:\/\/(rlm-input-[\w.-]+\.txt)/);
		expect(match).not.toBeNull();
		const writtenPath = path.join(h.artifactsDir, "local", match?.[1] ?? "");
		const written = await Bun.file(writtenPath).text();
		expect(written).toBe(oversizedPayload);
		expect((await Bun.file(writtenPath).stat()).size).toBe(Buffer.byteLength(oversizedPayload, "utf-8"));

		// (d) The rendered charCount describes the real payload size.
		expect(prompt).toContain(`(${oversizedPayload.length} chars)`);
	});

	it("falls back to the no-request marker when the input contains only whitespace", async () => {
		const h = await acpRuntime({ enabled: true });
		tempDirs.push(h.artifactsDir);

		const result = await executeAcpBuiltinSlashCommand("/rlm   \n\t ", h.runtime);

		const prompt = promptOf(result);
		expect(prompt).toContain("User request: (no request text provided)");
		expect(prompt).not.toContain("local://rlm-input-");
		expect(prompt).not.toContain("Inline payload externalized");
		const localDir = path.join(h.artifactsDir, "local");
		expect(await localDirEntries(localDir)).toHaveLength(0);
		expect(h.output).not.toHaveBeenCalled();
	});

	it("rejects when Python is the only enabled backend but no interpreter is available", async () => {
		const h = await acpRuntime({ enabled: true, backends: { "eval.js": false } });
		// The real probe spawns `python -c ...` (bounded by
		// DEFAULT_PROBE_TIMEOUT_MS); in tests the kernel availability checker
		// short-circuits to "available", so stub the backend's own
		// isAvailable() — the exact gate resolveBackend() rejects every eval
		// cell with when no interpreter exists.
		vi.spyOn(pythonBackend, "isAvailable").mockResolvedValue(false);

		const result = await executeAcpBuiltinSlashCommand("/rlm summarize the report", h.runtime);

		// The command must fail up front with the prerequisite error rather
		// than externalizing the payload and handing the model a workflow
		// whose eval cells would all be rejected later.
		expect(result).toEqual({ consumed: true });
		expect(result).not.toHaveProperty("prompt");
		expect(h.output).toHaveBeenCalledWith(expect.stringContaining("no working Python interpreter"));
		expect(pythonBackend.isAvailable).toHaveBeenCalledTimes(1);
		const localDir = path.join(h.artifactsDir, "local");
		expect(await localDirEntries(localDir)).toHaveLength(0);
	});

	it("accepts /rlm when Python is the sole backend and its interpreter is available", async () => {
		const h = await acpRuntime({ enabled: true, backends: { "eval.js": false } });
		tempDirs.push(h.artifactsDir);
		vi.spyOn(pythonBackend, "isAvailable").mockResolvedValue(true);

		const result = await executeAcpBuiltinSlashCommand("/rlm summarize the report", h.runtime);

		expect(result).not.toEqual({ consumed: true });
		expect(promptOf(result)).toContain("local://rlm-input-");
		expect(pythonBackend.isAvailable).toHaveBeenCalledTimes(1);
		expect(h.output).not.toHaveBeenCalled();
	});
});
