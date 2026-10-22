import { $env } from "@oh-my-pi/pi-utils";
import { getHeaderCaseInsensitive } from "../utils";
import type { ProviderTransport } from "./build";

const ZDR_HEADER = "x-cmd-zdr";
/**
 * Carries the value the originating process decided for {@link ZDR_HEADER} on
 * its way to the process that performs the provider request. omp-internal: the
 * receiving transport consumes and removes it, so it never reaches a provider.
 * It is deliberately *not* named `x-cmd-zdr`, because the value it carries is
 * not yet a request header — the receiving side still has to weigh it against
 * its own resolved model, and a second `x-cmd-zdr` entry would be joined into
 * one comma-separated field instead of losing a precedence contest.
 */
const ZDR_FORWARDED_HEADER = "x-omp-cmd-zdr";

/**
 * Command Code's zero-data-retention opt-in. Command Code gates retention per
 * request through the documented `x-cmd-zdr: 1` header; without it a request is
 * served under the account's default retention policy. `CMD_ZDR=1` — the same
 * variable Command Code's own CLI reads — enables it.
 *
 * The value stays unset by default: sending the header is a deliberate
 * per-machine decision, and a host that must not retain has no way to express
 * "off" if OMP opted in on its behalf. `$env` is read per request, so a
 * variable exported into the environment after boot takes effect on the next
 * turn instead of requiring a restart.
 *
 * Precedence is the caller's own header, then the model's, then the
 * environment. An `x-cmd-zdr` is never added beside one that already exists
 * under another casing: `Headers` joins duplicate names into a single field, so
 * the request would go out as `1, 0` and pick neither retention mode.
 *
 * Only inference is patched. The model catalog endpoint is public,
 * unauthenticated, and carries no conversation data, so there is no retention
 * for it to opt out of.
 */
export const commandCodeTransport: ProviderTransport = {
	prepareRequest: (model, options) => {
		// The documented precedence puts the caller's header above the model's,
		// but the shared header build merges the two case-sensitively — a model
		// entry under another casing would survive beside the caller's and
		// `Headers` would join them into one field (`0, 1`) instead of letting
		// the caller win. Settle it here, the one place that sees both layers, by
		// dispatching a model copy without its entry.
		let activeModel = model;
		if (
			getHeaderCaseInsensitive(options.headers, ZDR_HEADER) !== undefined &&
			getHeaderCaseInsensitive(model.headers, ZDR_HEADER) !== undefined
		) {
			const headers: Record<string, string> = {};
			for (const [name, value] of Object.entries(model.headers ?? {})) {
				if (name.toLowerCase() !== ZDR_HEADER) headers[name] = value;
			}
			activeModel = { ...model, headers };
		}
		// A `pi-native` turn arrives carrying the value the originating process
		// decided, and *this* process — the one that performs the request — has
		// the resolved model the decision has to be weighed against. A model
		// authored here was resolved from this deployment's own catalog, so it is
		// the explicit choice and outranks a value the client only echoed from its
		// copy of the config; an environment opt-in is a default either way. No
		// second `x-cmd-zdr` entry may be left standing beside it, differently
		// cased or not, or `Headers` joins the two into one unparseable field.
		const forwarded =
			options.headers === undefined ? undefined : getHeaderCaseInsensitive(options.headers, ZDR_FORWARDED_HEADER);
		if (forwarded !== undefined) {
			const headers: Record<string, string> = {};
			for (const [name, value] of Object.entries(options.headers ?? {})) {
				if (name.toLowerCase() !== ZDR_FORWARDED_HEADER) headers[name] = value;
			}
			if (
				getHeaderCaseInsensitive(activeModel.headers, ZDR_HEADER) === undefined &&
				getHeaderCaseInsensitive(headers, ZDR_HEADER) === undefined
			) {
				headers[ZDR_HEADER] = forwarded;
			}
			return { model: activeModel, options: { ...options, headers } };
		}
		// Both layers already reach this route: provider request setup merges the
		// model's headers and then the caller's over them. Only the environment
		// default needs adding, and only when neither layer authored a value.
		if (
			getHeaderCaseInsensitive(options.headers, ZDR_HEADER) !== undefined ||
			getHeaderCaseInsensitive(activeModel.headers, ZDR_HEADER) !== undefined
		) {
			return { model: activeModel, options };
		}
		if ($env.CMD_ZDR !== "1") return { model: activeModel, options };
		return { model: activeModel, options: { ...options, headers: { ...options.headers, [ZDR_HEADER]: "1" } } };
	},
	// The gateway re-resolves the model from its own catalog and never sees the
	// client's `model.headers`, so the value this process settled on has to
	// travel or it is lost — an explicit `1` would leave the conversation
	// retained, and an env-driven `1` would be absent whenever the gateway's own
	// environment lacks the opt-in. The caller's own header crosses the wire
	// unchanged and needs no help: it is already the top layer over there.
	preparePiNativeHeaders: (model, options) => {
		if (getHeaderCaseInsensitive(options.headers, ZDR_HEADER) !== undefined) return undefined;
		const value = getHeaderCaseInsensitive(model.headers, ZDR_HEADER) ?? ($env.CMD_ZDR === "1" ? "1" : undefined);
		return value === undefined ? undefined : { [ZDR_FORWARDED_HEADER]: value };
	},
};
