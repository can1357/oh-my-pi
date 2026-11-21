/**
 * The system-prompt block describing the OS sandbox, and the settings it renders from.
 */
import { prompt } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import sandboxPromptTemplate from "../prompts/system/sandbox.md" with { type: "text" };
import { sandboxEnabled } from "./policy";
import { SandboxRuntime } from "./runtime";
import {
	cfgSandboxAllowWrite,
	cfgSandboxDenyRead,
	cfgSandboxEnabled,
	cfgSandboxMode,
	cfgSandboxNetworkMode,
	cfgSandboxReadScope,
	cfgSandboxScope,
} from "./settings";

/** The `sandbox.*` settings {@link buildSandboxPrompt} states; part of `cfgSystemPromptInputs`. */
export const cfgSandboxPromptInputs = {
	sandboxEnabled: cfgSandboxEnabled,
	sandboxMode: cfgSandboxMode,
	sandboxScope: cfgSandboxScope,
	sandboxReadScope: cfgSandboxReadScope,
	sandboxAllowWrite: cfgSandboxAllowWrite,
	sandboxDenyRead: cfgSandboxDenyRead,
	sandboxNetworkMode: cfgSandboxNetworkMode,
};

/**
 * The system-prompt block describing the OS sandbox while it is active for `workspace`, else
 * `undefined`. Everything is derived from what containment itself uses (the process-global
 * settings through {@link SandboxRuntime}), never from the session's settings: a session or subagent
 * overlay that differs from the global ones does not change what `bash`/`eval` actually run under.
 * Rebuilt with the prompt on every `sandbox.*` change (`cfgSystemPromptInputs`).
 */
export async function buildSandboxPrompt(
	workspace: string,
	options: { requestTool?: boolean } = {},
): Promise<string | undefined> {
	// The config read is pure; a disabled sandbox never creates the runtime (or runs its native probes).
	if (!sandboxEnabled(await Settings.init())) return undefined;
	const runtime = await SandboxRuntime.for(workspace);
	const status = runtime.status();
	if (status.state !== "active") return undefined;
	const policy = runtime.effectivePolicy();
	// `status` is active, so `applies` neither throws nor warns.
	return prompt
		.render(sandboxPromptTemplate, {
			bash: runtime.applies("bash"),
			eval: runtime.applies("eval"),
			exec: runtime.applies("exec"),
			backend: status.backend,
			writable: policy.readwritePaths,
			denied: policy.deniedPaths,
			networkAllow: status.network === "allow",
			networkDeny: status.network === "deny",
			// `sandbox_request` is registered: point denials at it instead of prose.
			requestTool: options.requestTool === true,
		})
		.trim();
}
