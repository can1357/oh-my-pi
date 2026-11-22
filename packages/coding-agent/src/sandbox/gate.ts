/**
 * The one sandbox gate for host-side effects omp performs for the agent outside the OS sandbox:
 * in-process file tools, actions it cannot contain (a debug adapter, computer use, a browser), and
 * paths learned only at run time (an LSP server's edit). It runs at the call sites that start such
 * effects (the tool wrapper, eval preludes, Cursor's direct file frames, LSP workspace edits),
 * never inside a tool or prelude handler, and refuses a call whose subjects the effective policy —
 * configured lists plus `sandbox_request` grants — does not allow.
 */
import type { SandboxSubject } from "@oh-my-pi/pi-agent-core";
import { prompt } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import sandboxCallDenialPrompt from "../prompts/tools/sandbox-call-denial.md" with { type: "text" };
import { type ApprovalSubject, approvalPathSubjects, type ToolTier } from "../tools/approval";
import { containingSandbox } from "./file-access";
import { sandboxEnabled } from "./policy";
import type { SandboxAccessDenial } from "./runtime";

/**
 * What a call does on the host: the tool's declared `sandboxSubjects`, or else the paths it names
 * (its absolute `approvalCacheTargets`, else `approvalRestrictionPaths`), read for a `read`-tier
 * call and written for any other (a delete or move modifies its source too).
 */
export function sandboxSubjects(tool: ApprovalSubject, args: unknown, tier: ToolTier): readonly SandboxSubject[] {
	const declared = tool.sandboxSubjects?.(args);
	if (declared) return declared;
	const kind = tier === "read" ? "read" : "write";
	return approvalPathSubjects(tool, args).map(({ path, recursive }) => ({ kind, target: path, recursive }));
}

/**
 * The model-facing refusal of call `name` for the first of its `subjects` the sandbox does not
 * allow, naming the `sandbox_request` that would allow it, or `undefined` when the sandbox is not
 * active (or `settings` is absent) or every subject is allowed. Returns `undefined` synchronously
 * when there is nothing to check (sandbox off, no subjects), so the common path adds no await;
 * `subjects` is derived only while the sandbox is enabled.
 */
export function sandboxCallDenial(call: {
	settings: Settings | undefined;
	workspace: string;
	name: string;
	subjects: () => readonly SandboxSubject[];
	/** Whether `sandbox_request` is available to point the refusal at; asked only for a refusal. */
	requestTool: () => boolean;
}): Promise<string | undefined> | undefined {
	if (!call.settings || !sandboxEnabled(call.settings)) return undefined;
	const subjects = call.subjects();
	if (subjects.length === 0) return undefined;
	return renderDenial(call.settings, { ...call, subjects });
}

async function renderDenial(
	settings: Settings,
	call: { workspace: string; name: string; subjects: readonly SandboxSubject[]; requestTool: () => boolean },
): Promise<string | undefined> {
	const runtime = await containingSandbox(call.workspace, { settings, throwWhenBlocked: false });
	const denial = runtime?.accessDenial(call.subjects);
	if (!denial) return undefined;
	return formatSandboxCallDenial(call.name, denial, call.requestTool());
}

/**
 * The model-facing refusal of call `tool` for `denial`, naming the `sandbox_request` that would lift a
 * liftable one when `requestTool` (that tool is available).
 */
export function formatSandboxCallDenial(tool: string, denial: SandboxAccessDenial, requestTool: boolean): string {
	return prompt.render(sandboxCallDenialPrompt, { tool, ...denial, requestTool }).trim();
}
