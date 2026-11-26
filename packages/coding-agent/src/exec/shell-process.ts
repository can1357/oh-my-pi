/**
 * Starting shell processes (`exec/shell-process-worker.ts`).
 *
 * A named service and a `pty` command run in the embedded engine as a process
 * of their own: the command line {@link shellProcessCommand} builds re-enters
 * this build with the worker selector. The engine there has no session, so the
 * file-backed URL schemes its command may name are mounted by the script it
 * sources first ({@link shellMounts}): `local://` (spills included),
 * `skill://` and `attachment://`. Every other scheme is missing there.
 */
import * as fs from "node:fs/promises";
import type { ToolTier } from "@oh-my-pi/pi-agent-core";
import { SHELL_PROCESS_SELECTOR } from "@oh-my-pi/pi-utils";
import { getActiveSkills } from "../extensibility/skills";
import { LocalProtocolHandler, resolveLocalRoot } from "../internal-urls/local-protocol";
import { contextUrlRouter } from "../internal-urls/context";
import type { ResolveContext } from "../internal-urls/types";
import { resolveCliEntryCmd } from "../subprocess/worker-client";
import { TIER_RANK } from "../tools/approval";
import { quotePosixArgument } from "../utils/shell-quote";
import { type ShellProcessSpec, shellProcessArgs } from "./shell-process-protocol";

/** The program and arguments that run `spec` as a shell process of this build. */
export function shellProcessCommand(spec: ShellProcessSpec): { application: string; args: string[] } {
	const [application, ...entry] = resolveCliEntryCmd();
	return { application, args: [...entry, SHELL_PROCESS_SELECTOR, ...shellProcessArgs(spec)] };
}

/** One `urlmap` command mounting `host` at `url`. */
function mount(flags: string, url: string, host: string): string {
	return `urlmap ${flags}${quotePosixArgument(url)} ${quotePosixArgument(host)}\n`;
}

/**
 * The script that mounts, in a shell process started for `context`'s session,
 * the host entries behind the URL paths it may open, from the sources the
 * scheme handlers read: the `local://` root, each skill's directory and
 * instruction file, and the attachments that exist now. `tier`
 * is what its command was approved at: `local://` is read-only when writing
 * it needs more.
 */
export async function shellMounts(context: ResolveContext, tier: ToolTier): Promise<string> {
	let script = "";
	const localOptions = LocalProtocolHandler.resolveOptions(context);
	if (localOptions) {
		const root = resolveLocalRoot(localOptions);
		// The session scratch root always exists, like a mount point.
		await fs.mkdir(root, { recursive: true });
		const decision = contextUrlRouter(context).writeTier("local://", undefined, context.session);
		const refused = typeof decision !== "string" && decision.policy === "deny";
		const readOnly = refused || TIER_RANK[typeof decision === "string" ? decision : decision.tier] > TIER_RANK[tier];
		script += mount(readOnly ? "-r " : "", "local://", root);
	}
	for (const skill of context.skills ?? getActiveSkills()) {
		// A namespaced skill (`<plugin>/<name>`) spans two URL segments.
		const url = `skill://${skill.name.split("/").map(encodeURIComponent).join("/")}`;
		script += mount("-r ", url, skill.baseDir);
		script += mount("-r -e ", url, skill.filePath);
	}
	for (const attachment of context.session?.getImageAttachments?.() ?? []) {
		script += mount("-r -e ", attachment.uri, attachment.sourcePath);
	}
	return script;
}
