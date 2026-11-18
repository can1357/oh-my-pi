/**
 * Starting shell processes (`exec/shell-process-worker.ts`).
 *
 * A named service and a `pty` command run in the embedded engine as a process
 * of their own: the command line {@link shellProcessCommand} builds re-enters
 * this build with the worker selector. The engine there has no session, so the
 * file-backed URL schemes its command may name travel with it as a
 * {@link ShellPathMap} ({@link shellPathMap}): `local://`, `skill://`,
 * `artifact://` and `attachment://`. Every other scheme is missing there.
 */
import type { ToolTier } from "@oh-my-pi/pi-agent-core";
import { SHELL_PROCESS_SELECTOR } from "@oh-my-pi/pi-utils";
import { getActiveSkills } from "../extensibility/skills";
import { LocalProtocolHandler, resolveLocalRoot } from "../internal-urls/local-protocol";
import { artifactsDirsFromRegistry } from "../internal-urls/registry-helpers";
import { InternalUrlRouter } from "../internal-urls/router";
import type { ResolveContext } from "../internal-urls/types";
import { resolveCliEntryCmd } from "../subprocess/worker-client";
import { TIER_RANK } from "../tools/approval";
import { type ShellPathMap, type ShellProcessSpec, shellProcessArgs } from "./shell-process-protocol";

/** The program and arguments that run `spec` as a shell process of this build. */
export function shellProcessCommand(spec: ShellProcessSpec): { application: string; args: string[] } {
	const [application, ...entry] = resolveCliEntryCmd();
	return { application, args: [...entry, SHELL_PROCESS_SELECTOR, ...shellProcessArgs(spec)] };
}

/**
 * The host locations behind the URL paths a shell process started for
 * `context`'s session may open, from the sources the scheme handlers read.
 * `tier` is what its command was approved at: `local://` is read-only when
 * writing it needs more.
 */
export function shellPathMap(context: ResolveContext, tier: ToolTier): ShellPathMap {
	const map: ShellPathMap = {};
	const localOptions = LocalProtocolHandler.resolveOptions(context);
	if (localOptions) {
		map.local = resolveLocalRoot(localOptions);
		const decision = InternalUrlRouter.instance().writeTier("local://", undefined, context.session);
		const refused = typeof decision !== "string" && decision.policy === "deny";
		if (refused || TIER_RANK[typeof decision === "string" ? decision : decision.tier] > TIER_RANK[tier]) {
			map.localReadOnly = true;
		}
	}
	// The calling session's own artifacts first, as `artifact://N` resolves them.
	const artifacts = context.localProtocolOptions?.getArtifactsDir?.() ?? artifactsDirsFromRegistry()[0];
	if (artifacts) map.artifacts = artifacts;
	for (const skill of context.skills ?? getActiveSkills()) {
		map.skills ??= {};
		map.skills[skill.name] = skill.filePath;
	}
	for (const attachment of context.session?.getImageAttachments?.() ?? []) {
		map.attachments ??= {};
		map.attachments[attachment.uri] = attachment.sourcePath;
	}
	return map;
}
