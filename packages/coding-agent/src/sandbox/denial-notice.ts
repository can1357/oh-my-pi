/**
 * The notice a bash or eval result carries when it looks like a sandbox denial or the proxy refused
 * one of its own requests, so the model treats it as policy and knows how to ask for access.
 */
import { prompt } from "@oh-my-pi/pi-utils";
import sandboxDenialTemplate from "../prompts/tools/sandbox-denial.md" with { type: "text" };
import { canonicalHost, hostLocalName } from "./policy";
import type { SandboxResultMeta } from "./types";

/**
 * The rendered notice for `sandbox`, or `undefined` when the result shows no denial, start failure,
 * network-off failure or refused host. Hosts refused to the call's own requests (`ownBlockedHosts`)
 * are named whether or not it `failed`; those attributed only by time (`blockedHosts`) when it
 * `failed`. The filesystem part follows the sandbox mode: in `read-only` it never suggests
 * requesting a write, and an IP literal or local name among the refused hosts is never offered for
 * a request.
 */
export function renderSandboxDenialNotice(
	sandbox: SandboxResultMeta | undefined,
	session: { isToolActive?: (name: string) => boolean },
	failed: boolean,
): string | undefined {
	if (!sandbox) return undefined;
	const refused = failed
		? [...(sandbox.ownBlockedHosts ?? []), ...(sandbox.blockedHosts ?? [])]
		: sandbox.ownBlockedHosts;
	const blockedHosts = refused && refused.length > 0 ? [...new Set(refused)] : undefined;
	if (!sandbox.denied && !sandbox.startFailed && !sandbox.networkOff && !blockedHosts?.length) return undefined;
	// An IP literal or local name is refused by `sandbox_request` too: only the user can list it.
	const isLocal = (host: string) => hostLocalName(canonicalHost(host) ?? host);
	return prompt
		.render(sandboxDenialTemplate, {
			mode: sandbox.mode,
			denied: sandbox.denied,
			networkOff: sandbox.networkOff,
			startFailed: sandbox.startFailed,
			blockedHosts,
			requestableHosts: blockedHosts?.filter(host => !isLocal(host)),
			localHosts: blockedHosts?.filter(isLocal),
			requestTool: session.isToolActive?.("sandbox_request") === true,
		})
		.trim();
}
