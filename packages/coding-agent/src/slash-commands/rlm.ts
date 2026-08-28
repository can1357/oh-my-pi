import { randomUUID } from "node:crypto";
import { prompt } from "@oh-my-pi/pi-utils";
import { pythonBackend } from "../eval";
import { DEFAULT_PROBE_TIMEOUT_MS } from "../eval/probe";
import { resolveLocalUrlToPath } from "../internal-urls/local-protocol";
import rlmTemplate from "../prompts/rlm.md" with { type: "text" };
import type { ToolSession } from "../tools";
import { resolveEvalBackends } from "../tools/eval-backends";
import { commandConsumed } from "./helpers/parse";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "./types";

/**
 * `/rlm` handler: flag-gated entry point into RLM (Recursive Language Model)
 * mode. When `rlm.enabled` is off, tells the operator how to enable it and
 * consumes the command. When on, renders the RLM strategy prompt combined
 * with the user's request and returns it as a `{ prompt }` so the model runs
 * the RLM strategy on that request.
 */
export async function handleRlmCommand(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	if (!runtime.settings.get("rlm.enabled")) {
		await runtime.output(
			"RLM mode is disabled. Enable it via the rlm.enabled setting (e.g. omp config set rlm.enabled true).",
		);
		return commandConsumed();
	}
	const session = { settings: runtime.settings, cwd: runtime.cwd } as ToolSession;
	const backends = resolveEvalBackends(session);
	if (!backends.python && !backends.js) {
		await runtime.output(
			"RLM mode requires the Python or JavaScript eval backend (the RLM helpers are not implemented for Ruby/Julia), but neither is enabled in this session (eval.py/eval.js are off or PI_PY/PI_JS disable them). Enable one before using /rlm.",
		);
		return commandConsumed();
	}
	// Python is the only candidate backend: probe that an interpreter actually
	// exists before accepting the command. Every real eval cell is gated on
	// pythonBackend.isAvailable() (resolveBackend), so accepting /rlm here and
	// letting the probe fail later would externalize the payload and hand the
	// model a workflow it cannot execute. Surface the same prerequisite error
	// up front instead. JS needs no probe (jsBackend.isAvailable() is trivially
	// true), and when both are enabled the model can fall back to JS cells.
	if (backends.python && !backends.js) {
		const available = await pythonBackend.isAvailable(session, { timeoutMs: DEFAULT_PROBE_TIMEOUT_MS });
		if (!available) {
			await runtime.output(
				"RLM mode requires a working eval backend: Python is the only one enabled in this session, but no working Python interpreter is available (every RLM eval cell would be rejected). Install the python kernel or enable the JavaScript eval backend before using /rlm.",
			);
			return commandConsumed();
		}
	}
	// Derive the request from the raw command text instead of `command.args`:
	// the shared slash parser (parseSlashCommand) already trims args, so
	// externalizing the normalized string would silently strip meaningful
	// leading/trailing whitespace from the payload (indented code,
	// whitespace-sensitive templates, documents whose final newlines matter).
	// Slicing past the leading "/", the command name, and the single separator
	// character reproduces the parser's own arg extraction without the trim,
	// so the payload RLM analyzes is byte-for-byte what the user typed as the
	// argument.
	const request = command.text.slice(command.name.length + 2);
	if (!request.trim()) {
		return { prompt: prompt.render(rlmTemplate, { request: "(no request text provided)" }).trim() };
	}
	// Write through the eval session's canonical local:// mapping — the same
	// one the sandbox resolves `read("local://…")` through
	// (ToolSession.localProtocolOptions). The dispatchers expose that mapping
	// on the runtime; reconstructing it from sessionManager here would diverge
	// when an SDK host supplies a custom localProtocolOptions on
	// createAgentSession: the write would land under the session manager's
	// artifacts dir while the sandbox reads from the custom root
	// (file-not-found). The fallback below is the sessionManager-derived
	// mapping itself — exactly what ToolSession.localProtocolOptions defaults
	// to when no host override exists — so behavior is identical for hosts
	// that do not carry the field (and for test fixtures). The process-wide
	// LocalProtocolHandler override is deliberately never consulted: it is a
	// last-resort branch for callers with no session reference, and in a
	// multi-session process it belongs to whichever session installed it last.
	const localProtocolOptions = runtime.localProtocolOptions ?? {
		getArtifactsDir: () => runtime.sessionManager.getArtifactsDir(),
		getSessionId: () => runtime.sessionManager.getSessionId(),
	};
	const inputUrl = `local://rlm-input-${randomUUID()}.txt`;
	const inputPath = resolveLocalUrlToPath(inputUrl, localProtocolOptions);
	await Bun.write(inputPath, request);
	return {
		prompt: prompt.render(rlmTemplate, { externalized: true, inputUrl, charCount: request.length }).trim(),
	};
}
