import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { PsHost, PsRunResult } from "@oh-my-pi/pi-natives";
import { formatTruncationMetaNotice, type OutputMeta } from "@oh-my-pi/pi-tui/tools/output-meta";
import { ToolError } from "@oh-my-pi/pi-tui/tools/tool-errors";
import { DEFAULT_MAX_BYTES, OutputSink, streamTailUpdates, TailBuffer } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { $which, prompt } from "@oh-my-pi/pi-utils";
import powershellDescription from "../prompts/tools/powershell.md" with { type: "text" };
import type { ToolSession } from ".";
import { truncateForPrompt } from "./approval";
import { outputMeta, resolveOutputMaxColumns, resolveOutputSinkHeadBytes } from "./output-meta";
import { resolveToCwd } from "./path-utils";
import { acquirePsHost, disposePsHostSession, spawnEphemeralPsHost } from "./pshost-manager";
import { ToolAbortError, throwIfAborted } from "./tool-errors";
import { toolResult } from "./tool-result";
import { clampTimeout } from "./tool-timeouts";

const powershellSchema = type({
	command: type("string").describe("PowerShell command to run in the persistent session"),
	"cwd?": type("string").describe("working directory for this command"),
	"timeout?": type("number").describe("timeout in seconds"),
	"host?": type('"session" | "ephemeral" | "new-session"').describe(
		'which host runs the command: "session" (default) the persistent session host; "ephemeral" a throwaway host fully terminated before the result returns; "new-session" discard the session host and run in a fresh replacement',
	),
});

type PowerShellToolParams = typeof powershellSchema.infer;

export type PowerShellHostMode = "session" | "ephemeral" | "new-session";

export interface PowerShellToolDetails {
	meta?: OutputMeta;
	/** Which host ran the command. */
	host?: PowerShellHostMode;
	/**
	 * PID of the backing pwsh host (attach with `Enter-PSHostProcess -Id`).
	 * For ephemeral runs the process has already exited; the PID is only a
	 * historical record for log correlation.
	 */
	pid?: number;
	/** Monotonic execution id within the host. */
	execId?: number;
	exitCode?: number;
	hadErrors?: boolean;
}

/**
 * Pool key for the session host. Sessions without an explicit id must not
 * collapse onto one shared key: "new-session" would otherwise replace another
 * session's host, and runspace state would leak across sessions.
 */
const FALLBACK_POOL_KEYS = new WeakMap<ToolSession, string>();
let fallbackPoolKeySeq = 0;

function psHostPoolKey(session: ToolSession): string {
	const explicit = session.getSessionId?.();
	if (explicit) return explicit;
	let key = FALLBACK_POOL_KEYS.get(session);
	if (!key) {
		fallbackPoolKeySeq += 1;
		key = `anon:${fallbackPoolKeySeq}`;
		FALLBACK_POOL_KEYS.set(session, key);
	}
	return key;
}

export class PowerShellTool implements AgentTool<typeof powershellSchema, PowerShellToolDetails> {
	readonly name = "powershell";
	readonly approval = "exec" as const;
	readonly formatApprovalDetails = (args: unknown): string[] => {
		const params = args as Partial<PowerShellToolParams>;
		const command = typeof params.command === "string" ? params.command : "(missing)";
		const lines = [`Command: ${truncateForPrompt(command)}`];
		if (typeof params.cwd === "string" && params.cwd.length > 0) lines.push(`Directory: ${params.cwd}`);
		if (params.host && params.host !== "session") lines.push(`Host: ${params.host}`);
		return lines;
	};
	readonly summary =
		"Execute PowerShell in a persistent host whose session state (variables, modules, last result objects) is retained across calls";
	readonly loadMode = "discoverable";
	readonly label = "PowerShell";
	readonly parameters = powershellSchema;
	// Ephemeral runs share nothing (own process, own runspace, never pooled),
	// so they may run alongside other tools. Session-host runs stay exclusive
	// not for runspace safety — the native exec_lock and the bootstrap's
	// in-flight rejection already serialize the runspace — but so a session
	// command's streaming output is never interleaved with sibling tools.
	readonly concurrency = (args: Partial<PowerShellToolParams>): "shared" | "exclusive" =>
		args.host === "ephemeral" ? "shared" : "exclusive";
	readonly strict = true;
	readonly description: string;

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(powershellDescription);
	}

	async execute(
		_toolCallId: string,
		{ command, cwd, timeout: rawTimeout, host: hostMode = "session" }: PowerShellToolParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<PowerShellToolDetails>,
		_ctx?: AgentToolContext,
	): Promise<AgentToolResult<PowerShellToolDetails>> {
		const settings = this.session.settings;
		const timeoutSec = clampTimeout("powershell", rawTimeout, settings.get("tools.maxTimeout"));

		const spawnOptions = {
			cwd: this.session.cwd,
			shellPath: settings.get("powershell.shellPath")?.trim() || undefined,
			historyDepth: settings.get("powershell.historyDepth"),
		};

		// Everything fallible on the input path runs BEFORE a host is acquired:
		// a rejected cwd or artifact failure must not leak an ephemeral pwsh or
		// strand a session lease (leases pin the host against idle eviction).
		const resolvedCwd = cwd ? resolveToCwd(cwd, this.session.cwd) : undefined;
		const width = settings.get("powershell.outputWidth");

		const tailBuffer = new TailBuffer(DEFAULT_MAX_BYTES);
		const { path: artifactPath, id: artifactId } = (await this.session.allocateOutputArtifact?.("powershell")) ?? {};
		const sink = new OutputSink({
			onChunk: streamTailUpdates(tailBuffer, onUpdate),
			artifactPath,
			artifactId,
			headBytes: resolveOutputSinkHeadBytes(settings),
			maxColumns: resolveOutputMaxColumns(settings),
		});

		// Teardown is awaited before the result is built, and means different
		// things per mode: for an ephemeral host it kills the process — "the
		// call returned" must mean "the process is gone", because loaded
		// assemblies and file locks are state and releasing them is the point
		// of the mode. For a session host it only returns the lease to the
		// pool (refreshing the idle clock); nothing is disposed.
		const sessionKey = psHostPoolKey(this.session);
		let host: PsHost;
		let teardown: () => void | Promise<void>;
		if (hostMode === "ephemeral") {
			// Mirror the session/new-session pre-check below: a call already
			// cancelled by the time execute() reaches the mode dispatch must
			// never spawn a throwaway pwsh just to tear it down unused.
			throwIfAborted(signal);
			const lease = await spawnEphemeralPsHost(spawnOptions);
			host = lease.host;
			teardown = lease.dispose;
		} else {
			// new-session: fully kill the old host before the acquire below, so
			// the poisoned runspace's locks are provably gone when the command
			// runs. The acquire then spawns the replacement — the pool entry is
			// gone, and acquirePsHost lazy-spawns on a missing entry. Spawn
			// failure leaves the session hostless; the next call re-spawns
			// lazily, exactly like a first call.
			throwIfAborted(signal);
			if (hostMode === "new-session") await disposePsHostSession(sessionKey);
			const lease = await acquirePsHost({
				...spawnOptions,
				sessionId: sessionKey,
				idleTtlMs: settings.get("powershell.idleTtlMs"),
			});
			host = lease.host;
			teardown = lease.release;
		}

		const pid = host.pid;
		let result: PsRunResult;
		try {
			// Acquiring a host (spawning a cold one, or waiting behind another
			// call on the shared runspace) can take a while; re-check here so a
			// call cancelled during acquisition never reaches host.run() at all.
			// (host.run()/PsHost.exec() also checks this immediately before
			// publishing the exec frame, as defense in depth.)
			throwIfAborted(signal);
			result = await host.run(
				{ command, cwd: resolvedCwd, width, timeoutMs: timeoutSec * 1000, signal },
				(_err, chunk) => sink.push(chunk),
			);
		} catch (err) {
			// The pre-run throwIfAborted() above throws ToolAbortError, not a
			// host-death rejection — never dispose a healthy pool entry or wrap
			// it as a crash for that case.
			if (err instanceof ToolAbortError) throw err;
			// run() otherwise rejects only when the host died mid-command
			// (crash, [Environment]::Exit, forced kill). Drop the session pool
			// entry now rather than releasing a corpse — otherwise the next
			// default call has to trip over the dead host before the pool's
			// alive check evicts it.
			if (hostMode !== "ephemeral") await disposePsHostSession(sessionKey);
			// Chunks already streamed to `sink` before the crash are otherwise
			// lost: the rethrown message carried only the native rejection
			// ("host terminated"), discarding any diagnostic output the command
			// printed before dying (and any truncation/artifact notice for it).
			const crashSummary = await sink.dump();
			const crashOutput = crashSummary.output;
			const crashMessage = err instanceof Error ? err.message : String(err);
			if (!crashOutput) throw new ToolError(crashMessage);
			const crashTruncation = outputMeta()
				.truncationFromSummary(crashSummary, { direction: "tail" })
				.get()?.truncation;
			const crashOutputWithNotice = crashTruncation
				? `${crashOutput}\n\n${formatTruncationMetaNotice(crashTruncation)}`
				: crashOutput;
			throw new ToolError(`${crashOutputWithNotice}\n\n${crashMessage}`);
		} finally {
			await teardown();
		}
		const summary = await sink.dump();
		const outputText = summary.output || "(no output)";
		// timedOut/cancelled below THROW instead of returning a builder result, so
		// they bypass toolResult(...).truncationFromSummary(...) — without this,
		// a timed-out command whose output exceeded the sink's in-memory window
		// silently dropped the "Showing lines X-Y…"/artifact notice, making a
		// truncated tail look like the command's complete output.
		const truncation = outputMeta().truncationFromSummary(summary, { direction: "tail" }).get()?.truncation;
		const outputWithNotice = truncation ? `${outputText}\n\n${formatTruncationMetaNotice(truncation)}` : outputText;

		if (result.timedOut) {
			throw new ToolError(`${outputWithNotice}\n\nCommand timed out after ${timeoutSec} seconds`);
		}
		if (result.cancelled) {
			throw new ToolAbortError(outputText === "(no output)" ? "Command aborted" : outputWithNotice);
		}

		const exitCode = result.exitCode ?? undefined;
		const nonZeroExit = exitCode !== undefined && exitCode !== 0 && result.hadErrors;
		const failed = result.hadErrors || nonZeroExit;

		const details: PowerShellToolDetails = {
			host: hostMode,
			pid,
			execId: result.execId,
			exitCode,
			hadErrors: result.hadErrors,
		};

		const note = nonZeroExit
			? `Command exited with code ${exitCode}`
			: result.hadErrors
				? "Command reported errors"
				: undefined;
		const finalText = note ? `${outputText}\n\n${note}` : outputText;

		const builder = toolResult(details).text(finalText).truncationFromSummary(summary, { direction: "tail" });
		if (failed) builder.error();
		return builder.done();
	}
}

/** Factory: only expose the tool when a pwsh executable is resolvable. */
export async function loadPowerShellTool(session: ToolSession): Promise<PowerShellTool | null> {
	const settings = session.settings;
	const shellPath = settings.get("powershell.shellPath")?.trim();
	const probe = shellPath || "pwsh";
	const resolved = await $which(probe);
	if (!resolved) return null;
	return new PowerShellTool(session);
}
