/**
 * Protocol handler for `cfg://` URLs: the agent's view of omp settings.
 *
 * Read forms (`/` and `.` both separate segments):
 * - `cfg://`                  every setting as a YAML-ish tree
 * - `cfg://<namespace>`       one namespace's subtree, e.g. `cfg://advisor`
 * - `cfg://<setting>`         one setting: value, type, default, source, description
 *
 * Write forms (content is the new value). Only a session created with
 * `settingsApproval` (the top-level TUI session) may write, and every write
 * requires user approval through the host registered with {@link setCfgApprovalHost}.
 * Other sessions (subagents, print, RPC, ACP, background forks) never see the
 * scheme advertised and are refused so they never block on a prompt the user
 * did not start:
 * - `cfg://<setting>`         session-only runtime override
 * - `cfg://<setting>/save`    persisted to the global config.yml
 *
 * A record setting's content is a patch: a JSON object naming only the entries it
 * changes, `null` removing one; the record's other entries stay as they are.
 *
 * Credential values are always redacted.
 */
import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import { fuzzyFilter } from "../utils/fuzzy";
import { type CfgWriteDetails, type CfgWriteOutcome } from "../tools/details/cfg-render";
import { CFG_SAVE_SEGMENT, CFG_URL_PREFIX, parseCfgUrl } from "./cfg-url";
import { type AnySetting, all } from "../config/registry";
import type { SettingProvenance, Settings } from "../config/settings";
import cfgPromptDoc from "../prompts/internal-urls/cfg.md" with { type: "text" };
import cfgEnvShadowedTemplate from "../prompts/tools/cfg-env-shadowed.md" with { type: "text" };
import cfgApprovalTimeoutTemplate from "../prompts/tools/cfg-approval-timeout.md" with { type: "text" };
import cfgEntryConfiguredTemplate from "../prompts/tools/cfg-entry-configured.md" with { type: "text" };
import cfgWriteResultTemplate from "../prompts/tools/cfg-write-result.md" with { type: "text" };
import type { ToolSession } from "../tools";
import type {
	InternalResource,
	InternalUrl,
	InternalWriteResult,
	ProtocolHandler,
	ResolveContext,
	SchemeHost,
	SchemeSpec,
	UrlCompletion,
	WriteContext,
} from "./types";

let sortedSettings: AnySetting[] | undefined;

/**
 * Every setting, ordered by id segment by segment so each namespace's members stay
 * contiguous. Computed on first use: the settings module is still initializing
 * when the router loads this handler.
 */
function allSettings(): AnySetting[] {
	sortedSettings ??= all().toSorted((a, b) => {
		const left = a.id.split(".");
		const right = b.id.split(".");
		for (let i = 0; i < Math.min(left.length, right.length); i++) {
			const order = left[i]!.localeCompare(right[i]!, "en", { sensitivity: "base" });
			if (order !== 0) return order;
		}
		return left.length - right.length;
	});
	return sortedSettings;
}
const REDACTED = "<redacted>";
/** Tree listings keep only the description's first sentence, capped here; single-setting reads show it whole. */
const TREE_COMMENT_MAX_CHARS = 120;

const PROVENANCE_LABELS: Record<SettingProvenance, string> = {
	env: "environment variable",
	runtime: "session override",
	overlay: "--config overlay",
	project: "project config",
	global: "global config",
	default: "default",
};

/** A settings change awaiting the user's decision. Values are display-formatted, credentials redacted. */
export interface CfgChangeRequest {
	path: string;
	previous: string;
	value: string;
	/** Persist to config.yml instead of scoping the change to the session. */
	save: boolean;
	/** Higher layer that will keep a `/save` from taking effect here (e.g. `project config`); absent when it applies. */
	shadowedBy?: string;
}

/** An approved change that took effect on one {@link Settings} instance. */
export interface CfgAppliedChange {
	path: string;
	/** Effective value on {@link settings} after the change. */
	value: unknown;
	settings: Settings;
	/** Whether the change was persisted to config.yml. */
	save: boolean;
}

/**
 * The user's answer to a {@link CfgChangeRequest}: `once` applies this change, `session`
 * also approves later writes of the same kind for the rest of the session (a session grant
 * from a `/save` prompt covers saves and session changes), `deny` declines, and `timeout`
 * means nobody answered, so the write fails and the agent carries on without it.
 */
export type CfgApproval = "once" | "session" | "deny" | "timeout";

/** Host UI that approves `cfg://` writes, plus the disk-backed settings `/save` persists to. */
export interface CfgApprovalHost {
	/** Asks the user; dismissing the prompt must resolve `deny`. Aborts on `options.signal`. */
	approve(request: CfgChangeRequest, options?: { signal?: AbortSignal }): Promise<CfgApproval>;
	/**
	 * Called once per settings instance whose value changed, so the host can apply
	 * side effects reserved for the user's in-process choices (a `defaultThinkingLevel`
	 * change also switches the live session).
	 */
	applied(change: CfgAppliedChange): void;
	persistentSettings: Settings;
}

let approvalHost: CfgApprovalHost | null = null;
/** Tail of the approval chain; concurrent writes prompt one at a time. */
let approvalQueue: Promise<unknown> = Promise.resolve();
/** "Always for this session" answer: which session it covers and whether it extends to `/save`. */
let sessionGrant: { sessionId: string; save: boolean } | undefined;

/**
 * Register the process-global approval host for `cfg://` writes. `/save`
 * persists through its disk-backed settings even when the calling session's
 * `Settings` is a separate instance. Passing `null` clears it; without a host
 * every write is refused, since nobody can approve it.
 */
export function setCfgApprovalHost(host: CfgApprovalHost | null): void {
	approvalHost = host;
	sessionGrant = undefined;
}

/** Answers from the session grant when it covers this write; otherwise asks the host and records a new grant. */
async function decide(
	host: CfgApprovalHost,
	request: CfgChangeRequest,
	sessionId: string | undefined,
	signal?: AbortSignal,
): Promise<CfgApproval> {
	const grant = sessionId !== undefined && sessionGrant?.sessionId === sessionId ? sessionGrant : undefined;
	if (grant && (grant.save || !request.save)) return "once";
	const answer = await host.approve(request, { signal });
	if (answer === "session" && sessionId !== undefined) {
		sessionGrant = { sessionId, save: request.save || (grant?.save ?? false) };
	}
	return answer;
}

function formatValue(setting: AnySetting, value: unknown): string {
	if (value === undefined || value === null) return "null";
	if (setting.isCredential && value !== "") return REDACTED;
	if (typeof value === "boolean" || typeof value === "number") return String(value);
	return JSON.stringify(value);
}

/**
 * Patch written to a record setting: entries to set, `null` for entries to remove.
 *
 * @throws Error when `content` is not a JSON object.
 */
function parseRecordPatch(content: string): Record<string, unknown> {
	let patch: unknown;
	try {
		patch = JSON.parse(content);
	} catch {
		patch = undefined;
	}
	if (!isRecord(patch)) throw new Error(`Invalid record JSON: ${content}`);
	return patch;
}

/** Own entry `key` of `record`; undefined when absent or `record` is not a record. */
function entryOf(record: unknown, key: string): unknown {
	return isRecord(record) && Object.hasOwn(record, key) ? record[key] : undefined;
}

/** `record` with `patch` applied: entries replaced in place or appended, `null` entries removed. */
function applyPatch(record: unknown, patch: Record<string, unknown>): Record<string, unknown> {
	const entries = new Map(isRecord(record) ? Object.entries(record) : []);
	for (const key in patch) {
		const entry = patch[key];
		if (entry === null) entries.delete(key);
		else entries.set(key, entry);
	}
	return Object.fromEntries(entries);
}

/**
 * Canonicalize URL segments against the schema, case-insensitively.
 * `leaf` is set when the path names a setting; `members` lists every setting beneath it.
 *
 * @throws Error when the path names neither a setting nor a namespace.
 */
function resolveSegments(segments: readonly string[]): { path: string; leaf?: AnySetting; members: AnySetting[] } {
	if (segments.length === 0) return { path: "", members: allSettings() };
	const lower = segments.join(".").toLowerCase();
	const leaf = allSettings().find(candidate => candidate.id.toLowerCase() === lower);
	const members = allSettings().filter(candidate => candidate.id.toLowerCase().startsWith(`${lower}.`));
	const path = leaf?.id ?? members[0]?.id.slice(0, lower.length);
	if (path === undefined) {
		const similar = fuzzyFilter(
			allSettings().map(candidate => candidate.id),
			segments.join("."),
			candidate => candidate,
		).slice(0, 8);
		const hint = similar.length > 0 ? `\nSimilar: ${similar.join(", ")}` : "";
		throw new Error(`Unknown setting: ${segments.join(".")}${hint}\nRead ${CFG_URL_PREFIX} for the full tree.`);
	}
	return { path, leaf, members };
}

function treeComment(setting: AnySetting, value: unknown): string {
	const parts: string[] = [];
	const choices = setting.enumValues;
	if (choices) parts.push(choices.join("|"));
	const fallback = setting.default;
	if (!Bun.deepEquals(value, fallback)) parts.push(`default ${formatValue(setting, fallback)}`);
	const description = setting.ui?.description;
	if (description) {
		const sentence = description.match(/^.*?[.!?](?=\s|$)/s)?.[0] ?? description;
		parts.push(
			sentence.length > TREE_COMMENT_MAX_CHARS ? `${sentence.slice(0, TREE_COMMENT_MAX_CHARS - 1)}…` : sentence,
		);
	}
	return parts.length > 0 ? `  # ${parts.join(" · ")}` : "";
}

/** YAML-ish tree of `members`, rooted below `prefix`. Returns the rendered text and the count of non-default values. */
function renderTree(
	settings: Settings,
	members: readonly AnySetting[],
	prefix: string,
): { text: string; modified: number } {
	const lines: string[] = [];
	let modified = 0;
	const opened: string[] = [];
	const strip = prefix ? prefix.length + 1 : 0;
	for (const setting of members) {
		const segments = setting.id.slice(strip).split(".");
		let shared = 0;
		while (shared < opened.length && shared < segments.length - 1 && opened[shared] === segments[shared]) shared++;
		opened.length = shared;
		for (let depth = shared; depth < segments.length - 1; depth++) {
			lines.push(`${"  ".repeat(depth)}${segments[depth]}:`);
			opened.push(segments[depth]!);
		}
		const value = setting.get(settings);
		if (!Bun.deepEquals(value, setting.default)) modified++;
		const indent = "  ".repeat(segments.length - 1);
		lines.push(`${indent}${segments.at(-1)}: ${formatValue(setting, value)}${treeComment(setting, value)}`);
	}
	return { text: lines.join("\n"), modified };
}

function renderLeaf(settings: Settings, setting: AnySetting): string {
	const value = setting.get(settings);
	const lines = [
		`${setting.id}: ${formatValue(setting, value)}`,
		`type: ${setting.type}`,
		`default: ${formatValue(setting, setting.default)}`,
		`source: ${PROVENANCE_LABELS[setting.provenance(settings)]}`,
	];
	const choices = setting.enumValues;
	if (choices) lines.push(`values: [${choices.join(", ")}]`);
	const description = setting.ui?.description;
	if (description) lines.push(`description: ${description}`);
	return lines.join("\n");
}

/**
 * Layer that keeps a written `value` from taking effect on `settings`, or undefined when it applies.
 * Decided by which layer owns the setting; `effective` only clears a false alarm where that layer
 * already agrees (for a record, `value` is the patch: each entry it names, `null` as absent).
 */
function shadowingLayer(
	setting: AnySetting,
	settings: Settings,
	value: unknown,
	above: readonly SettingProvenance[],
): SettingProvenance | undefined {
	const owner = setting.provenance(settings);
	if (!above.includes(owner)) return undefined;
	const effective = setting.get(settings);
	if (keepsGlobalListEntries(setting, owner, effective, value)) return undefined;
	if (!isRecord(value) || !isRecord(effective)) {
		return Bun.deepEquals(effective, value) ? undefined : owner;
	}
	for (const key in value) {
		if (!Bun.deepEquals(entryOf(effective, key) ?? null, value[key])) return owner;
	}
	return undefined;
}

/** Value `persistent`'s global config gives `setting`, which a `/save` replaces. */
function globalValue(setting: AnySetting, persistent: Settings): unknown {
	let value: unknown = persistent.getGlobalSettings();
	for (const segment of setting.segments) value = isRecord(value) ? value[segment] : undefined;
	return value;
}

/**
 * {@link shadowingLayer} judged before a `/save` lands on `persistent`. Layers deep-merge records, so a
 * written key is shadowed only when its current value comes from a higher layer rather than the global
 * config the save replaces; an env var replaces the value whole and is judged as is.
 */
function saveShadowingLayer(
	setting: AnySetting,
	persistent: Settings,
	value: unknown,
	above: readonly SettingProvenance[],
): SettingProvenance | undefined {
	const owner = setting.provenance(persistent);
	const effective = setting.get(persistent);
	const global = globalValue(setting, persistent);
	if (above.includes(owner) && keepsGlobalListEntries(setting, owner, effective, global ?? setting.default)) {
		return undefined;
	}
	if (owner === "env" || !above.includes(owner) || !isRecord(value) || !isRecord(effective)) {
		return shadowingLayer(setting, persistent, value, above);
	}
	for (const key in value) {
		const current = entryOf(effective, key);
		if (current === undefined || Bun.deepEquals(current, value[key])) continue;
		if (Bun.deepEquals(entryOf(global, key), current)) continue;
		return owner;
	}
	return undefined;
}

/**
 * Whether the project or `--config` overlay list that owns `setting` keeps `globalList` in effect:
 * a `merge: "prepend" | "append"` list adds its own entries around the global ones instead of
 * replacing them, unless it configures an empty list.
 */
function keepsGlobalListEntries(
	setting: AnySetting,
	owner: SettingProvenance,
	effective: unknown,
	globalList: unknown,
): boolean {
	const merge = setting.definition.type === "array" ? setting.definition.merge : undefined;
	if ((owner !== "project" && owner !== "overlay") || (merge !== "prepend" && merge !== "append")) return false;
	if (!Array.isArray(effective) || !Array.isArray(globalList) || effective.length <= globalList.length) return false;
	const offset = merge === "prepend" ? effective.length - globalList.length : 0;
	return globalList.every((entry, index) => Bun.deepEquals(effective[offset + index], entry));
}

/** Only an environment variable outranks a session override. */
const ABOVE_SESSION: readonly SettingProvenance[] = ["env"];
/** Every layer that outranks the global config.yml a `/save` writes. */
const ABOVE_GLOBAL: readonly SettingProvenance[] = ["env", "runtime", "overlay", "project"];

function callerSession(context: ResolveContext | WriteContext | undefined): ToolSession {
	const session = context?.session;
	if (!session?.settings) throw new Error(`${CFG_URL_PREFIX} requires a calling session.`);
	return session;
}

/**
 * Settings of a caller allowed to write. Refuses sessions that must not raise
 * approval prompts: subagents (the user is not driving them) and sessions without
 * `settingsApproval` (print, RPC, ACP, `/tan` forks, programmatic agents).
 */
function writerSettings(context: WriteContext | undefined): Settings {
	const session = callerSession(context);
	if ((session.taskDepth ?? 0) > 0) {
		throw new Error(
			`Subagents cannot change settings. Report the setting you need changed to the parent agent instead of writing ${CFG_URL_PREFIX}.`,
		);
	}
	if (session.settingsApproval !== true) {
		throw new Error(
			`Changing settings requires user approval, but this session has no interactive UI. Ask the user to change the setting themselves.`,
		);
	}
	return session.settings;
}

export class CfgProtocolHandler implements ProtocolHandler {
	readonly scheme = "cfg";
	readonly spec: SchemeSpec = {
		backing: "virtual",
		selectors: "lines",
		immutable: true,
		write: { via: "handler", payload: "verbatim", scope: "workspace", tier: () => "write" },
	};

	/** Advertised only where writes can be approved; subagents and headless sessions never see `cfg://`. */
	promptDoc(host: SchemeHost): string | undefined {
		return host.settingsApproval ? cfgPromptDoc.trim() : undefined;
	}

	async resolve(url: InternalUrl, context?: ResolveContext): Promise<InternalResource> {
		const { settings } = callerSession(context);
		const target = parseCfgUrl(url.rawHref ?? url.href);
		const { path, leaf, members } = resolveSegments(target?.segments ?? []);
		const sections: string[] = [];
		let modified = 0;
		if (leaf) {
			sections.push(renderLeaf(settings, leaf));
			if (!Bun.deepEquals(leaf.get(settings), leaf.default)) modified++;
		}
		if (members.length > 0) {
			const tree = renderTree(settings, members, path);
			sections.push(tree.text);
			modified += tree.modified;
		}
		const content = sections.join("\n\n");
		return {
			url: url.href,
			content,
			contentType: "text/plain",
			size: Buffer.byteLength(content, "utf-8"),
			details: { cfg: { path, count: members.length + (leaf ? 1 : 0), modified } },
		};
	}

	async write(url: InternalUrl, content: string, context?: WriteContext): Promise<InternalWriteResult> {
		const settings = writerSettings(context);
		const target = parseCfgUrl(url.rawHref ?? url.href);
		const { path, leaf } = resolveSegments(target?.segments ?? []);
		if (!leaf) {
			const example = `${CFG_URL_PREFIX}${path ? `${path.replaceAll(".", "/")}/` : ""}<key>`;
			throw new Error(`${path || CFG_URL_PREFIX} is a namespace; write a single setting, e.g. ${example}.`);
		}
		const save = target?.save ?? false;
		const previous = leaf.get(settings);
		// A record write is a patch naming only the entries it changes; `value` is the whole resulting record.
		const patch = leaf.type === "record" ? parseRecordPatch(content) : undefined;
		const value = patch ? applyPatch(previous, patch) : leaf.parse(content);
		// Refuse before prompting: an approved change that fails validation would only fail afterwards.
		leaf.assertWritable(value);
		// Shadowing is judged on what the write names: a patch leaves the record's other entries alone.
		const written = patch ?? value;
		// A patched record shows only the entries the patch names, absent ones as `null`: the patch restoring them.
		const shown = (current: unknown) =>
			formatValue(
				leaf,
				patch ? Object.fromEntries(Object.keys(patch).map(key => [key, entryOf(current, key) ?? null])) : current,
			);
		const request: CfgChangeRequest = {
			path: leaf.id,
			previous: shown(previous),
			value: formatValue(leaf, written),
			save,
		};
		const settingUrl = `${CFG_URL_PREFIX}${leaf.id.replaceAll(".", "/")}`;
		const saveUrl = `${settingUrl}/${CFG_SAVE_SEGMENT}`;
		const finish = (
			outcome: CfgWriteOutcome,
			shadow?: { layer: SettingProvenance; scope: Settings },
		): InternalWriteResult => {
			const effective = shadow ? shown(leaf.get(shadow.scope)) : undefined;
			const details: CfgWriteDetails = { ...request, outcome, ...(effective !== undefined ? { effective } : {}) };
			const text = prompt
				.render(cfgWriteResultTemplate, {
					...request,
					url: settingUrl,
					saveUrl,
					patch: patch !== undefined,
					declined: outcome === "declined",
					unchanged: outcome === "unchanged",
					saved: outcome === "applied" && save,
					applied: outcome === "applied" && !save,
					effective,
					provenance: shadow ? PROVENANCE_LABELS[shadow.layer] : undefined,
				})
				.trim();
			return { content: [{ type: "text", text }], details: { cfg: details } };
		};

		if (!save && Bun.deepEquals(previous, value)) return finish("unchanged");
		// Refuse before prompting: approving a session change a non-fallback env var overrides is a no-op.
		// A fallback env var yields to the override the write adds, so it does not shadow.
		if (!save && !leaf.envFallback && shadowingLayer(leaf, settings, written, ABOVE_SESSION)) {
			throw new Error(
				prompt
					.render(cfgEnvShadowedTemplate, {
						path: leaf.id,
						effective: shown(previous),
						env: leaf.envName,
					})
					.trim(),
			);
		}
		const host = approvalHost;
		if (!host) {
			throw new Error(
				`Changing settings requires user approval, but no interactive UI is attached. Ask the user to change \`${leaf.id}\` themselves.`,
			);
		}
		if (save) {
			// Saving may still be meant for other projects, so ask anyway, but name the layer that wins here.
			// A session sharing the persistent instance drops or patches its own override on save, so it does not shadow.
			const persistent = host.persistentSettings;
			const above = ABOVE_GLOBAL.filter(
				layer => !(layer === "env" && leaf.envFallback) && !(layer === "runtime" && settings === persistent),
			);
			const layer = saveShadowingLayer(leaf, persistent, written, above);
			if (layer) {
				request.shadowedBy =
					layer === "env" && leaf.envName ? `environment variable ${leaf.envName}` : PROVENANCE_LABELS[layer];
			}
		}
		const sessionId = callerSession(context).getSessionId?.() ?? undefined;
		const decision = approvalQueue.then(() => decide(host, request, sessionId, context?.signal));
		approvalQueue = decision.catch(() => undefined);
		const answer = await decision;
		if (answer === "timeout") {
			throw new Error(
				prompt.render(cfgApprovalTimeoutTemplate, { path: leaf.id, previous: request.previous }).trim(),
			);
		}
		if (answer === "deny") return finish("declined");

		if (!save) {
			leaf.override(settings, value);
			host.applied({ path: leaf.id, value: leaf.get(settings), settings, save });
			// A non-fallback env var outranks runtime overrides; report it instead of claiming the change.
			const layer = shadowingLayer(leaf, settings, written, ABOVE_SESSION);
			return finish("applied", layer ? { layer, scope: settings } : undefined);
		}
		const persistent = host.persistentSettings;
		// A patch keeps the global record's other entries.
		leaf.set(persistent, patch ? applyPatch(globalValue(leaf, persistent), patch) : value);
		await persistent.flush();
		// A session sharing the persistent instance drops its override so the saved value takes effect,
		// unless a patch keeps that override's other entries; a separate instance never reloads from disk,
		// so mirror it.
		if (settings === persistent && !(patch && settings.hasRuntimeOverride(leaf))) {
			leaf.clearOverride(settings);
		} else {
			leaf.override(settings, patch ? applyPatch(leaf.get(settings), patch) : value);
			if (settings !== persistent) {
				host.applied({ path: leaf.id, value: leaf.get(persistent), settings: persistent, save });
			}
		}
		host.applied({ path: leaf.id, value: leaf.get(settings), settings, save });
		// Judged on the persistent instance: a separate session carries the mirrored override above.
		const layer = shadowingLayer(leaf, persistent, written, ABOVE_GLOBAL);
		return finish("applied", layer ? { layer, scope: persistent } : undefined);
	}

	async complete(): Promise<UrlCompletion[]> {
		return allSettings().map(setting => {
			const description = setting.ui?.description;
			return { value: setting.id.replaceAll(".", "/"), ...(description ? { description } : {}) };
		});
	}
}
