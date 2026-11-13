/**
 * The sandbox's filesystem policy applied to omp's in-process file tools (`read`, `write`, `edit`,
 * `ast_edit`, the searches, eval helpers that call them). They run inside omp, so the OS backend
 * never sees them; omp checks every local path a call names against the same effective policy
 * contained commands get — configured lists plus `sandbox_request` grants — before it runs.
 */
import { prompt } from "@oh-my-pi/pi-utils";
import { Settings } from "../config/settings";
import sandboxFileDenial from "../prompts/tools/sandbox-file-denial.md" with { type: "text" };
import { type ApprovalSubject, approvalPathSubjects, type ToolTier } from "../tools/approval";
import { sandboxEnabled } from "./policy";
import { SandboxRuntime } from "./runtime";

/**
 * The model-facing refusal for a call that names a path outside the sandbox policy, or `undefined`
 * when the sandbox is not active or every path is allowed. A `read`-tier call is checked for read
 * access; any other tier for write access (a delete or move modifies its source too). Returns
 * `undefined` synchronously for a call with nothing to check (sandbox off, no local paths), so
 * the common path adds no await before the approval gate.
 */
export function sandboxFileToolDenial(options: {
	settings: Settings | undefined;
	workspace: string;
	tool: ApprovalSubject;
	args: unknown;
	tier: ToolTier;
	/** Whether `sandbox_request` is available to point the refusal at; asked only for a refusal. */
	requestTool: () => boolean;
}): Promise<string | undefined> | undefined {
	const { settings, tool, args } = options;
	if (!settings || !sandboxEnabled(settings)) return undefined;
	const subjects = approvalPathSubjects(tool, args);
	if (subjects.length === 0) return undefined;
	return checkSubjects(
		{ workspace: options.workspace, toolName: tool.name, tier: options.tier, requestTool: options.requestTool },
		subjects,
	);
}

/**
 * The refusal for writes omp makes on a tool's behalf to paths it learns only while running (an
 * LSP server's workspace edit), or `undefined` when the sandbox is not active or every path is
 * writable. Reads the process settings, like the runtime itself.
 */
export async function sandboxWritePathsDenial(
	workspace: string,
	toolName: string,
	paths: readonly string[],
): Promise<string | undefined> {
	if (paths.length === 0 || !sandboxEnabled(await Settings.init())) return undefined;
	return checkSubjects(
		{ workspace, toolName, tier: "write", requestTool: () => true },
		paths.map(target => ({ path: target, recursive: false })),
	);
}

async function checkSubjects(
	options: { workspace: string; toolName: string; tier: ToolTier; requestTool: () => boolean },
	subjects: readonly { path: string; recursive: boolean }[],
): Promise<string | undefined> {
	const runtime = await SandboxRuntime.for(options.workspace);
	if (runtime.status().state !== "active") return undefined;
	const kind = options.tier === "read" ? "read" : "write";
	for (const subject of subjects) {
		const denial = runtime.fileAccessDenial(kind, subject.path, subject.recursive);
		if (!denial) continue;
		return prompt
			.render(sandboxFileDenial, {
				tool: options.toolName,
				kind,
				reason: denial.reason,
				protected: denial.protected,
				requestTool: options.requestTool(),
			})
			.trim();
	}
	return undefined;
}
