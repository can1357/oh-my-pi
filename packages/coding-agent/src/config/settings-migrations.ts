/**
 * Settings schema migrations: rewrite retired setting shapes in a raw settings tree to their
 * current form. Shared by the settings store (`./settings-store`), which migrates the config files
 * it owns before serving or saving them, and by {@link Settings} for the layers it reads itself
 * (`--config` overlays, runtime overrides, merged project items).
 *
 * Runs inside the daemon too, so its imports stay light: no settings registry, no discovery.
 */
import { roleDefaultModels } from "@oh-my-pi/pi-catalog/compat/behavior";
import { type GeneratedProvider, getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { type Api, type Model, modelKind } from "@oh-my-pi/pi-catalog/types";
import { isRecord } from "@oh-my-pi/pi-utils";
import { type CompactionMethod, DEFAULT_COMPACTION_METHOD_ORDER } from "../session/compaction-method-ids";
import { isLightTheme } from "../ui/theme/service";
import { isRegisteredSearchEngine } from "../web/search/provider";
import type { RawSettings } from "./raw-settings";

/**
 * Phonon voice replacing each retired Kokoro voice family, keyed by Kokoro's
 * accent/gender prefix (`af_heart` → American female → `harper`).
 */
const PHONON_VOICE_FOR_KOKORO_PREFIX: Record<string, string> = {
	af_: "harper",
	am_: "easton",
	bf_: "maeve",
	bm_: "edwin",
};

/** Retired local speech models and the catalog model that replaced each. */
const RETIRED_LOCAL_SPEECH_MODELS: Record<string, string> = {
	"local/kokoro": "local/phonon-31m",
	"local/parakeet-tdt-0.6b-v3": "local/fluid-speech-pro",
};

/**
 * Local speech models were replaced in place: Kokoro-82M by Phonon 31M (TTS)
 * and Parakeet TDT 0.6B v3 by Fluid Speech Pro (dictation). Rewrite the
 * `speech`/`dictation` roles and their fallback chains to the successors, and
 * configured Kokoro voice ids (`tts.localVoice`, `speech.voice`) to the Phonon
 * voice of the same accent and gender. Handles nested and quoted-dotted sources.
 */
function migrateRetiredSpeechSettings(raw: RawSettings): void {
	const phononVoice = (value: unknown): string | undefined =>
		typeof value === "string" ? PHONON_VOICE_FOR_KOKORO_PREFIX[value.slice(0, 3)] : undefined;
	const successor = (value: unknown): unknown =>
		typeof value === "string" ? (RETIRED_LOCAL_SPEECH_MODELS[value] ?? value) : value;
	const migrateRole = (value: unknown): unknown => (Array.isArray(value) ? value.map(successor) : successor(value));
	const leaves: Array<[root: string, leaf: string, migrate: (value: unknown) => unknown]> = [
		["tts", "localVoice", value => phononVoice(value) ?? value],
		["speech", "voice", value => phononVoice(value) ?? value],
		["modelRoles", "speech", migrateRole],
		["modelRoles", "dictation", migrateRole],
	];
	for (const role of ["speech", "dictation"]) {
		const retry = raw.retry;
		const chains = isRecord(retry) ? retry.fallbackChains : raw["retry.fallbackChains"];
		if (isRecord(chains) && role in chains) chains[role] = migrateRole(chains[role]);
		const dotted = `retry.fallbackChains.${role}`;
		if (dotted in raw) raw[dotted] = migrateRole(raw[dotted]);
	}
	for (const [root, leaf, migrate] of leaves) {
		const rootObj = raw[root];
		if (isRecord(rootObj) && leaf in rootObj) rootObj[leaf] = migrate(rootObj[leaf]);
		const dotted = `${root}.${leaf}`;
		if (dotted in raw) raw[dotted] = migrate(raw[dotted]);
	}
}

/**
 * Migrate a v17 leaf rename that used to nest under a boolean parent path
 * (`dev.autoqa.consent` → `dev.autoqaConsent`, `todo.reminders.max` →
 * `todo.remindersMax`). Pre-rename configs left the leaf beneath the parent,
 * so the parent path resolved to an object and truthy checks like
 * `isAutoQaEnabled` treated a consent-only container as "enabled".
 *
 * Handles nested (`{ parent: { leaf } }`) and quoted-dotted (`"parent.leaf"`)
 * legacy sources. An explicit new key always wins; a separately configured
 * boolean parent is preserved; an irrecoverable object-valued parent (only ever
 * a container for the old leaf) is dropped so the schema default applies.
 */
function migrateNestedLeafRename(
	raw: RawSettings,
	root: string,
	parent: string,
	oldLeaf: string,
	newLeaf: string,
	isLeafValue: (value: unknown) => boolean,
): void {
	const rootObj = isRecord(raw[root]) ? (raw[root] as Record<string, unknown>) : undefined;
	const nestedParent = rootObj?.[parent];
	const flatParent = raw[`${root}.${parent}`];
	const oldParentPath = `${root}.${parent}`;

	const candidates = [
		rootObj?.[newLeaf],
		raw[`${root}.${newLeaf}`],
		isRecord(nestedParent) ? nestedParent[oldLeaf] : undefined,
		raw[`${oldParentPath}.${oldLeaf}`],
	];
	const resolvedLeaf = candidates.find(isLeafValue);

	const recoveredParent =
		typeof nestedParent === "boolean" ? nestedParent : typeof flatParent === "boolean" ? flatParent : undefined;

	const ensureRoot = (): Record<string, unknown> => {
		const current = raw[root];
		if (isRecord(current)) return current;
		const created: Record<string, unknown> = {};
		raw[root] = created;
		return created;
	};

	if (resolvedLeaf !== undefined) {
		const target = ensureRoot();
		if (!isLeafValue(target[newLeaf])) {
			target[newLeaf] = resolvedLeaf;
		}
	}

	// Strip legacy leaf sources (nested + flat dotted).
	delete raw[`${oldParentPath}.${oldLeaf}`];
	delete raw[`${root}.${newLeaf}`];
	if (isRecord(raw[root]) && isRecord((raw[root] as Record<string, unknown>)[parent])) {
		const parentObj = (raw[root] as Record<string, unknown>)[parent] as Record<string, unknown>;
		delete parentObj[oldLeaf];
		if (Object.keys(parentObj).length === 0) {
			delete (raw[root] as Record<string, unknown>)[parent];
		}
	}

	// The parent path must be a boolean or absent — never a leftover object.
	if (recoveredParent !== undefined) {
		const target = ensureRoot();
		if (typeof target[parent] !== "boolean") {
			target[parent] = recoveredParent;
		}
	} else if (isRecord(raw[root]) && isRecord((raw[root] as Record<string, unknown>)[parent])) {
		delete (raw[root] as Record<string, unknown>)[parent];
	}
	delete raw[oldParentPath];
	if (isRecord(raw[root]) && Object.keys(raw[root] as Record<string, unknown>).length === 0) {
		delete raw[root];
	}
}

/**
 * Rewrites `raw`, a settings tree as one config file holds it, from every retired shape to the
 * current one, in place; returns it. Runs per file before layers merge, so a layer's explicit
 * legacy choice keeps overriding the layers below it. A retired `lastChangelogVersion` is removed
 * and reported to `onLegacyChangelogVersion` (it moved to the last-changelog-version marker file).
 */
export function migrateRawSettings(
	raw: RawSettings,
	onLegacyChangelogVersion?: (version: string) => void,
): RawSettings {
	// queueMode -> steeringMode
	if ("queueMode" in raw && !("steeringMode" in raw)) {
		raw.steeringMode = raw.queueMode;
		delete raw.queueMode;
	}
	// doubleEscapeAction: legacy "branch" -> "rewind". The old branch backtrack
	// was superseded by the in-transcript rewind selector; "tree" survives as a
	// current action (opens the session tree) beside "rewind" and "none".
	if (raw.doubleEscapeAction === "branch") {
		raw.doubleEscapeAction = "rewind";
	}

	// lastChangelogVersion moved out of config.yml into the
	// <agentDir>/last-changelog-version marker file so version bumps no
	// longer dirty user-tracked configs. Capture for marker seeding (see
	// #seedLastChangelogVersionMarker), then strip the key — the next
	// config save drops it from disk.
	if (typeof raw.lastChangelogVersion === "string") onLegacyChangelogVersion?.(raw.lastChangelogVersion);
	delete raw.lastChangelogVersion;

	// collapseChangelog (boolean) -> startup.changelogMode (enum). Preserve
	// every explicit legacy choice while giving new installs the schema's
	// "summary" default: true -> summary, false -> expanded. A separately
	// configured new mode always wins.
	const startupObj = isRecord(raw.startup) ? (raw.startup as Record<string, unknown>) : undefined;
	const legacyCollapseChangelog = typeof raw.collapseChangelog === "boolean" ? raw.collapseChangelog : undefined;
	const flatChangelogMode = raw["startup.changelogMode"];
	const normalizedFlatChangelogMode =
		flatChangelogMode === "summary" || flatChangelogMode === "expanded" || flatChangelogMode === "hidden"
			? flatChangelogMode
			: undefined;
	if (legacyCollapseChangelog !== undefined || normalizedFlatChangelogMode !== undefined) {
		if (!startupObj) {
			raw.startup = {};
		}
		const target = raw.startup as Record<string, unknown>;
		if (target.changelogMode === undefined) {
			target.changelogMode =
				normalizedFlatChangelogMode ??
				(legacyCollapseChangelog !== undefined ? (legacyCollapseChangelog ? "summary" : "expanded") : undefined);
		}
	}
	delete raw.collapseChangelog;
	delete raw["startup.changelogMode"];

	// Migrate old flat "theme" string to nested theme.dark/theme.light
	if (typeof raw.theme === "string") {
		const oldTheme = raw.theme;
		if (oldTheme === "light" || oldTheme === "dark") {
			// Built-in defaults — just remove, let new defaults apply
			delete raw.theme;
		} else {
			// Custom theme — detect luminance to place in correct slot
			const slot = isLightTheme(oldTheme) ? "light" : "dark";
			raw.theme = { [slot]: oldTheme };
		}
	}

	// Remove the retired image-tool mode settings and preserve its request
	// timeout under the read image-question setting. Nested values win over
	// quoted-dotted legacy values; an existing new setting wins over both.
	const inspectImageObj = isRecord(raw.inspect_image) ? (raw.inspect_image as Record<string, unknown>) : undefined;
	const legacyQuestionTimeoutMs =
		typeof inspectImageObj?.timeoutMs === "number"
			? inspectImageObj.timeoutMs
			: typeof raw["inspect_image.timeoutMs"] === "number"
				? (raw["inspect_image.timeoutMs"] as number)
				: undefined;
	const imagesObj = isRecord(raw.images) ? (raw.images as Record<string, unknown>) : undefined;
	if (legacyQuestionTimeoutMs !== undefined && imagesObj?.questionTimeoutMs === undefined) {
		raw.images = { ...imagesObj, questionTimeoutMs: legacyQuestionTimeoutMs };
	}
	delete raw.inspect_image;
	delete raw["inspect_image.enabled"];
	delete raw["inspect_image.mode"];
	delete raw["inspect_image.timeoutMs"];

	const taskObj = raw.task as Record<string, unknown> | undefined;
	const isolationObj = taskObj?.isolation as Record<string, unknown> | undefined;

	// task.simple: removed — the task tool no longer accepts a per-call
	// schema (workflows drive structured output via eval agent()) and the
	// batch/context shape is gated by task.batch instead.
	if (taskObj && "simple" in taskObj) {
		delete taskObj.simple;
	}

	// task.eager / todo.eager: boolean -> enum (default | preferred | always).
	// `true` reproduced the previous "on" behavior, which is now `always`.
	if (taskObj && typeof taskObj.eager === "boolean") {
		taskObj.eager = taskObj.eager ? "always" : "default";
	}
	const todoObj = raw.todo as Record<string, unknown> | undefined;
	if (todoObj && typeof todoObj.eager === "boolean") {
		todoObj.eager = todoObj.eager ? "always" : "default";
	}

	// features.unexpectedStopDetection (boolean) -> enum none|mechanical|smart.
	// `true` reproduced the previous small-model-classified behavior, which is
	// now "smart"; `false` maps to "none" so explicitly disabled configs remain
	// off rather than inheriting the new "mechanical" default.
	// Handles nested and quoted-dotted sources, like the legacy image settings above.
	const featuresObj = isRecord(raw.features) ? (raw.features as Record<string, unknown>) : undefined;
	const legacyUnexpectedStop =
		typeof featuresObj?.unexpectedStopDetection === "boolean"
			? featuresObj.unexpectedStopDetection
			: typeof raw["features.unexpectedStopDetection"] === "boolean"
				? (raw["features.unexpectedStopDetection"] as boolean)
				: undefined;
	if (legacyUnexpectedStop !== undefined) {
		if (!featuresObj) {
			raw.features = {};
		}
		const target = raw.features as Record<string, unknown>;
		const current = target.unexpectedStopDetection;
		const currentIsMode = typeof current === "string" && ["none", "mechanical", "smart"].includes(current);
		if (!currentIsMode) {
			target.unexpectedStopDetection = legacyUnexpectedStop ? "smart" : "none";
		}
		delete raw["features.unexpectedStopDetection"];
	}
	// Split the legacy combined isolation setting into enablement and backend.
	// Handle both nested YAML and quoted dotted keys. Explicit enabled and
	// backend values win; legacy backend names are normalized everywhere.
	const legacyIsolationBackends: Record<string, string> = {
		worktree: "rcopy",
		"fuse-overlay": "overlayfs",
		"fuse-projfs": "projfs",
	};
	const legacyIsolationModePath = ["task", "isolation", "mode"].join(".");
	const legacyIsolationMode =
		typeof isolationObj?.mode === "string"
			? isolationObj.mode
			: typeof raw[legacyIsolationModePath] === "string"
				? (raw[legacyIsolationModePath] as string)
				: undefined;
	const flatIsolationEnabled = raw["task.isolation.enabled"];
	const explicitIsolationEnabled =
		typeof isolationObj?.enabled === "boolean"
			? isolationObj.enabled
			: typeof flatIsolationEnabled === "boolean"
				? flatIsolationEnabled
				: undefined;
	if (legacyIsolationMode !== undefined || explicitIsolationEnabled !== undefined) {
		if (!isRecord(raw.task)) raw.task = {};
		const targetTask = raw.task as Record<string, unknown>;
		if (!isRecord(targetTask.isolation)) targetTask.isolation = {};
		const targetIsolation = targetTask.isolation as Record<string, unknown>;
		targetIsolation.enabled = explicitIsolationEnabled ?? legacyIsolationMode !== "none";
		delete targetIsolation.mode;
	}
	delete raw[legacyIsolationModePath];
	delete raw["task.isolation.enabled"];

	const rootIsolation = isRecord(raw.isolation) ? (raw.isolation as Record<string, unknown>) : undefined;
	const configuredBackend =
		typeof rootIsolation?.backend === "string"
			? rootIsolation.backend
			: typeof raw["isolation.backend"] === "string"
				? (raw["isolation.backend"] as string)
				: undefined;
	const derivedBackend =
		legacyIsolationMode === undefined || legacyIsolationMode === "none"
			? undefined
			: (legacyIsolationBackends[legacyIsolationMode] ?? legacyIsolationMode);
	const backend = configuredBackend ?? derivedBackend;
	if (backend !== undefined) {
		if (!rootIsolation) raw.isolation = {};
		(raw.isolation as Record<string, unknown>).backend = legacyIsolationBackends[backend] ?? backend;
	}
	delete raw["isolation.backend"];

	// edit.mode: removed "atom" and "vim" variants map back to "hashline"
	const editObj = raw.edit as Record<string, unknown> | undefined;
	if (editObj) {
		if (editObj.mode === "atom" || editObj.mode === "vim") {
			editObj.mode = "hashline";
		}
		const modelVariants = editObj.modelVariants as Record<string, unknown> | undefined;
		if (modelVariants && typeof modelVariants === "object" && !Array.isArray(modelVariants)) {
			for (const [pattern, variant] of Object.entries(modelVariants)) {
				if (variant === "atom" || variant === "vim") {
					modelVariants[pattern] = "hashline";
				}
			}
		}
	}
	if (raw["edit.mode"] === "atom" || raw["edit.mode"] === "vim") {
		raw["edit.mode"] = "hashline";
	}

	// compaction.strategy / compaction.remoteEnabled → compaction.methodOrder.
	// The old single strategy could not express a capability-dependent fallback
	// chain. Preserve explicit legacy intent while new installs use the
	// server → snapcompact → handoff → shake → soft default.
	const compactionObj = isRecord(raw.compaction) ? raw.compaction : undefined;
	const configuredMethodOrder = compactionObj?.methodOrder ?? raw["compaction.methodOrder"];
	const legacyStrategy = compactionObj?.strategy ?? raw["compaction.strategy"];
	const legacyRemoteEnabled = compactionObj?.remoteEnabled ?? raw["compaction.remoteEnabled"];
	if (!Array.isArray(configuredMethodOrder)) {
		const remoteEnabled = legacyRemoteEnabled !== false;
		const strategy = legacyStrategy === "shake-summary" ? "shake" : legacyStrategy;
		let methodOrder: CompactionMethod[] | undefined;
		switch (strategy) {
			case "context-full":
				methodOrder = remoteEnabled ? ["remote", "soft"] : ["soft"];
				break;
			case "handoff":
				methodOrder = remoteEnabled ? ["handoff", "remote", "soft"] : ["handoff", "soft"];
				break;
			case "shake":
				methodOrder = remoteEnabled ? ["shake", "remote", "soft"] : ["shake", "soft"];
				break;
			case "snapcompact":
				methodOrder = remoteEnabled ? ["snapcompact", "remote", "soft"] : ["snapcompact", "soft"];
				break;
			case "off":
				methodOrder = [];
				break;
			default:
				if (legacyRemoteEnabled === false) {
					methodOrder = DEFAULT_COMPACTION_METHOD_ORDER.filter(method => method !== "remote");
				}
		}
		if (methodOrder) {
			const root = compactionObj ?? {};
			root.methodOrder = methodOrder;
			raw.compaction = root;
		}
	} else if (!compactionObj || compactionObj.methodOrder === undefined) {
		const root = compactionObj ?? {};
		root.methodOrder = configuredMethodOrder;
		raw.compaction = root;
	}
	if (compactionObj) {
		delete compactionObj.strategy;
		delete compactionObj.remoteEnabled;
	}
	delete raw["compaction.strategy"];
	delete raw["compaction.remoteEnabled"];
	delete raw["compaction.methodOrder"];

	// snapcompact.systemPrompt: boolean -> scoped enum.
	const snapcompactObj = raw.snapcompact as Record<string, unknown> | undefined;
	if (snapcompactObj && typeof snapcompactObj.systemPrompt === "boolean") {
		snapcompactObj.systemPrompt = snapcompactObj.systemPrompt ? "all" : "none";
	}
	if (typeof raw["snapcompact.systemPrompt"] === "boolean") {
		raw["snapcompact.systemPrompt"] = raw["snapcompact.systemPrompt"] ? "all" : "none";
	}

	// display.hideToolActivity (boolean) -> display.toolActivity (detailed |
	// concise | hidden): true hid tool calls, false drew full cards. Nested
	// values win over quoted-dotted ones; an explicit new mode wins over both.
	const displayObj = isRecord(raw.display) ? raw.display : undefined;
	const legacyHideToolActivity =
		typeof displayObj?.hideToolActivity === "boolean"
			? displayObj.hideToolActivity
			: typeof raw["display.hideToolActivity"] === "boolean"
				? raw["display.hideToolActivity"]
				: undefined;
	if (displayObj) delete displayObj.hideToolActivity;
	delete raw["display.hideToolActivity"];
	if (
		legacyHideToolActivity !== undefined &&
		displayObj?.toolActivity === undefined &&
		raw["display.toolActivity"] === undefined
	) {
		raw.display = { ...displayObj, toolActivity: legacyHideToolActivity ? "hidden" : "detailed" };
	}

	// inlineToolDescriptors: boolean -> enum (auto | on | off). The old
	// `true`/`false` mapped directly onto inline-on/inline-off, so preserve
	// the user's explicit choice; new installs get the `auto` default that
	// turns it on only for Gemini models.
	if (typeof raw.inlineToolDescriptors === "boolean") {
		raw.inlineToolDescriptors = raw.inlineToolDescriptors ? "on" : "off";
	}

	// find.enabled: boolean -> enum (auto | on | off). Preserve an explicit
	// choice; unset installs get `auto`, which enables `find` only when the
	// judge role resolves to a native System One model.
	const findObj = isRecord(raw.find) ? raw.find : undefined;
	if (findObj && typeof findObj.enabled === "boolean") {
		findObj.enabled = findObj.enabled ? "on" : "off";
	}
	if (typeof raw["find.enabled"] === "boolean") {
		raw["find.enabled"] = raw["find.enabled"] ? "on" : "off";
	}

	// spelling.autocomplete: boolean -> engine enum. `true` was the macOS
	// dictionary completion, which the cross-platform `auto` engine replaces.
	const spellingObj = isRecord(raw.spelling) ? raw.spelling : undefined;
	if (spellingObj && typeof spellingObj.autocomplete === "boolean") {
		spellingObj.autocomplete = spellingObj.autocomplete ? "auto" : "off";
	}
	if (typeof raw["spelling.autocomplete"] === "boolean") {
		raw["spelling.autocomplete"] = raw["spelling.autocomplete"] ? "auto" : "off";
	}

	// statusLine: rename "plan_mode" segment to "mode"
	const statusLineObj = raw.statusLine as Record<string, unknown> | undefined;
	if (statusLineObj) {
		for (const key of ["leftSegments", "rightSegments"] as const) {
			const segments = statusLineObj[key];
			if (Array.isArray(segments)) {
				statusLineObj[key] = segments.map(seg => (seg === "plan_mode" ? "mode" : seg));
			}
		}
		const segmentOptions = statusLineObj.segmentOptions as Record<string, unknown> | undefined;
		if (segmentOptions && "plan_mode" in segmentOptions && !("mode" in segmentOptions)) {
			segmentOptions.mode = segmentOptions.plan_mode;
			delete segmentOptions.plan_mode;
		}
	}

	// providers.parallelFetch (boolean) replaced by the providers.fetch reader
	// priority enum. The new default ("auto") supersedes both old values —
	// Parallel is now a deep fallback in the auto chain rather than the first
	// choice — so drop the legacy key (flat and nested) and let the enum
	// default apply.
	const providersObj = raw.providers as Record<string, unknown> | undefined;
	if (providersObj && "parallelFetch" in providersObj) {
		delete providersObj.parallelFetch;
	}
	delete raw["providers.parallelFetch"];

	// Retired local title models (replaced by the LFM2.5/Falcon refresh) map to
	// their closest current equivalents. Without this a pinned retired key
	// passes through as a stale string and title generation silently skips
	// every turn instead of falling back (no online fallback by design).
	const RETIRED_TINY_TITLE_MODELS: Record<string, string> = {
		"lfm2-350m": "lfm2.5-350m",
		"lfm2-700m": "lfm2.5-350m",
		"qwen3-0.6b": "lfm2.5-350m",
		"qwen2.5-0.5b": "lfm2.5-230m",
		"gemma-270m": "falcon-h1-90m",
	};
	const migrateTinyModelValue = (value: unknown): string | undefined =>
		typeof value === "string" ? RETIRED_TINY_TITLE_MODELS[value] : undefined;
	// Quoted-dotted flat keys (`"providers.tinyModel"` in YAML/legacy JSON)
	// promote into the nested setting; nested wins when both are present.
	const flatTinyModel = migrateTinyModelValue(raw["providers.tinyModel"]);
	if (flatTinyModel !== undefined) {
		const providersRoot = isRecord(raw.providers) ? raw.providers : {};
		if (typeof providersRoot.tinyModel !== "string") providersRoot.tinyModel = flatTinyModel;
		raw.providers = providersRoot;
		delete raw["providers.tinyModel"];
	}
	if (providersObj) {
		const migrated = migrateTinyModelValue(providersObj.tinyModel);
		if (migrated !== undefined) providersObj.tinyModel = migrated;
	}

	// Legacy single saved-reset `autoRedeem` (boolean or tri-state) -> the 5h and
	// weekly window keys not set yet. The Fable window is new and stays `unset`.
	for (const group of ["codexResets", "claudeResets"] as const) {
		const nested = isRecord(raw[group]) ? raw[group] : undefined;
		const dotted = `${group}.autoRedeem`;
		const legacy = nested?.autoRedeem ?? raw[dotted];
		if (nested) delete nested.autoRedeem;
		delete raw[dotted];
		if (legacy === undefined) continue;
		const mode = typeof legacy === "boolean" ? (legacy ? "yes" : "no") : legacy;
		for (const key of ["autoRedeem5h", "autoRedeemWeekly"]) {
			if (nested?.[key] !== undefined || raw[`${group}.${key}`] !== undefined) continue;
			if (nested) nested[key] = mode;
			else raw[`${group}.${key}`] = mode;
		}
	}

	// Map legacy `memories.enabled` boolean to the explicit `memory.backend`
	// enum if the latter hasn't been set yet. Idempotent: subsequent
	// migrations are no-ops once memory.backend is materialised.
	const memoryBackendObj = raw.memory as Record<string, unknown> | undefined;
	const memoryBackendSet = memoryBackendObj && typeof memoryBackendObj.backend === "string";
	const memoriesObj = raw.memories as Record<string, unknown> | undefined;
	if (!memoryBackendSet && memoriesObj && typeof memoriesObj.enabled === "boolean") {
		const next = memoriesObj.enabled ? "local" : "off";
		const memoryRoot = (memoryBackendObj ?? {}) as Record<string, unknown>;
		memoryRoot.backend = next;
		raw.memory = memoryRoot;
	}

	// Rename the legacy local `mnemosyne` memory backend to `mnemopi`.
	// - `memory.backend: "mnemosyne"` now selects the renamed backend.
	// - the top-level `mnemosyne` settings object becomes `mnemopi`.
	// Idempotent: skips the object move once `mnemopi` is materialised.
	if (memoryBackendObj && memoryBackendObj.backend === "mnemosyne") {
		memoryBackendObj.backend = "mnemopi";
	}
	if ("mnemosyne" in raw && !("mnemopi" in raw)) {
		raw.mnemopi = raw.mnemosyne;
		delete raw.mnemosyne;
	}

	// hindsight: dynamicBankId/agentName -> scoping enum + bankId
	// - dynamicBankId=true  → scoping="per-project" (closest semantic match;
	//   the legacy `agent::project::channel::user` tuple was per-project in
	//   practice — the channel/user env vars were rarely set).
	// - hindsight.agentName was only used as the agent slot in the legacy
	//   dynamic tuple; if the user customised it we surface it as the new
	//   bankId base when no explicit bankId is set.
	const hindsightObj = raw.hindsight as Record<string, unknown> | undefined;
	if (hindsightObj) {
		if ("dynamicBankId" in hindsightObj) {
			if (!("scoping" in hindsightObj) && hindsightObj.dynamicBankId === true) {
				hindsightObj.scoping = "per-project";
			}
			delete hindsightObj.dynamicBankId;
		}
		if ("agentName" in hindsightObj) {
			const agentName = hindsightObj.agentName;
			if (
				!("bankId" in hindsightObj) &&
				typeof agentName === "string" &&
				agentName.trim().length > 0 &&
				agentName !== "omp"
			) {
				hindsightObj.bankId = agentName;
			}
			delete hindsightObj.agentName;
		}
		// mentalModelRefreshIntervalMs removed: the mental-model block is now
		// frozen for the session lifetime rather than re-listed on a timer that
		// rewrote the cached prompt prefix mid-session (#11961).
		delete hindsightObj.mentalModelRefreshIntervalMs;
	}

	// power.preventIdleSleep / power.preventSystemSleep / power.declareUserActive
	// / power.preventDisplaySleep (four booleans) → power.sleepPrevention enum.
	// The enum is cumulative: each level adds the flags of all lower levels.
	// Migration picks the highest level whose condition is met, scanning from
	// most to least aggressive so a single enum value captures the old state.
	if (
		!("sleepPrevention" in ((raw.power as Record<string, unknown>) ?? {})) &&
		raw["power.sleepPrevention"] === undefined
	) {
		const powerObj = raw.power as Record<string, unknown> | undefined;
		const getFlag = (key: string): boolean | undefined => {
			const nested = powerObj?.[key];
			const flat = raw[`power.${key}`];
			const value = nested ?? flat;
			return typeof value === "boolean" ? value : undefined;
		};
		const idle = getFlag("preventIdleSleep");
		const system = getFlag("preventSystemSleep");
		const user = getFlag("declareUserActive");
		const display = getFlag("preventDisplaySleep");
		const anySet = idle !== undefined || system !== undefined || user !== undefined || display !== undefined;
		if (anySet) {
			const mode = system || user ? "system" : display ? "display" : idle !== false ? "idle" : "off";
			const powerRoot = (powerObj ?? {}) as Record<string, unknown>;
			powerRoot.sleepPrevention = mode;
			raw.power = powerRoot;
		}
		// Clean up old keys (nested + flat)
		if (powerObj) {
			delete powerObj.preventIdleSleep;
			delete powerObj.preventSystemSleep;
			delete powerObj.declareUserActive;
			delete powerObj.preventDisplaySleep;
		}
		delete raw["power.preventIdleSleep"];
		delete raw["power.preventSystemSleep"];
		delete raw["power.declareUserActive"];
		delete raw["power.preventDisplaySleep"];
	}

	// Migration for renamed settings grep.* from search.*. (`find.*` is no
	// longer migrated to `glob.*`: `find` is the semantic search tool now.)
	// 1. Nested settings: search -> grep (per-property merge to avoid clobbering)
	const ensureRawObject = (key: "grep"): Record<string, unknown> => {
		const current = raw[key];
		if (isRecord(current)) {
			return current;
		}
		const created: Record<string, unknown> = {};
		raw[key] = created;
		return created;
	};

	if ("search" in raw) {
		const searchObj = raw.search;
		if (isRecord(searchObj)) {
			const grepObj = ensureRawObject("grep");
			const searchKeys: Array<"enabled" | "contextBefore" | "contextAfter"> = [
				"enabled",
				"contextBefore",
				"contextAfter",
			];
			for (const key of searchKeys) {
				if (key in searchObj && !(key in grepObj)) {
					grepObj[key] = searchObj[key];
				}
			}
		}
		delete raw.search;
	}

	// 2. Flat settings keys: map them to the proper nested target so get/set resolves them correctly
	if ("search.enabled" in raw) {
		const grepObj = ensureRawObject("grep");
		if (!("enabled" in grepObj)) {
			grepObj.enabled = raw["search.enabled"];
		}
		delete raw["search.enabled"];
	}
	if ("search.contextBefore" in raw) {
		const grepObj = ensureRawObject("grep");
		if (!("contextBefore" in grepObj)) {
			grepObj.contextBefore = raw["search.contextBefore"];
		}
		delete raw["search.contextBefore"];
	}
	if ("search.contextAfter" in raw) {
		const grepObj = ensureRawObject("grep");
		if (!("contextAfter" in grepObj)) {
			grepObj.contextAfter = raw["search.contextAfter"];
		}
		delete raw["search.contextAfter"];
	}

	// Also clean up any empty nested objects we might have created or left behind
	if (raw.glob && typeof raw.glob === "object" && Object.keys(raw.glob).length === 0) {
		delete raw.glob;
	}
	if (raw.grep && typeof raw.grep === "object" && Object.keys(raw.grep).length === 0) {
		delete raw.grep;
	}
	// readHashLines: removed. Hashline anchors are now driven solely by
	// edit.mode === "hashline"; the separate read toggle only ever produced
	// the incoherent "hashline edits without addressable anchors" state.
	delete raw.readHashLines;

	// serviceTier (single enum with scoped openai-only/claude-only sentinels)
	// → per-family tier.openai/tier.anthropic/tier.google; serviceTierSubagent
	// → tier.subagent; serviceTierAdvisor → tier.advisor. `fastModeScope` is
	// dropped — per-family scoping is now expressed by the three tier settings.
	const tierObj = isRecord(raw.tier) ? raw.tier : {};
	let tierTouched = false;
	const setTier = (family: string, value: unknown): void => {
		if (value !== undefined && !(family in tierObj)) {
			tierObj[family] = value;
			tierTouched = true;
		}
	};
	if (typeof raw.serviceTier === "string") {
		switch (raw.serviceTier) {
			case "priority":
				setTier("openai", "priority");
				setTier("anthropic", "priority");
				setTier("google", "priority");
				break;
			case "openai-only":
				setTier("openai", "priority");
				break;
			case "claude-only":
				setTier("anthropic", "priority");
				break;
			case "auto":
			case "default":
			case "flex":
			case "scale":
				setTier("openai", raw.serviceTier);
				break;
		}
		delete raw.serviceTier;
	}
	const mapInheritTier = (value: unknown): unknown =>
		value === "openai-only" || value === "claude-only" ? "priority" : value;
	if ("serviceTierSubagent" in raw) {
		setTier("subagent", mapInheritTier(raw.serviceTierSubagent));
		delete raw.serviceTierSubagent;
	}
	if ("serviceTierAdvisor" in raw) {
		setTier("advisor", mapInheritTier(raw.serviceTierAdvisor));
		delete raw.serviceTierAdvisor;
	}
	if (tierTouched) raw.tier = tierObj;
	delete raw.fastModeScope;

	// advisor.subagents (blanket advisor on every spawned subagent) → per-agent
	// task.agentAdvisor, migrated to the bundled generic `task` agent. An
	// explicit boolean maps to "on"/"off" IN THE SAME LAYER — migration runs
	// per file, so a project-level `false` must keep overriding a global
	// `true` after both layers migrate.
	{
		const advisorObj = isRecord(raw.advisor) ? raw.advisor : undefined;
		const legacySubagents = advisorObj && "subagents" in advisorObj ? advisorObj.subagents : raw["advisor.subagents"];
		if (typeof legacySubagents === "boolean") {
			const taskObj = isRecord(raw.task) ? raw.task : {};
			const agentAdvisor = isRecord(taskObj.agentAdvisor) ? taskObj.agentAdvisor : {};
			if (!("task" in agentAdvisor)) agentAdvisor.task = legacySubagents ? "on" : "off";
			taskObj.agentAdvisor = agentAdvisor;
			raw.task = taskObj;
		}
		if (advisorObj) delete advisorObj.subagents;
		delete raw["advisor.subagents"];
	}

	// task.completionProbeMs (poll period, 0 = off) → task.completionProbe
	// (on/off with a built-in backoff schedule). Mapped IN THE SAME LAYER so a
	// project-level `0` keeps overriding a global period; an explicit new key wins.
	{
		const taskObj = isRecord(raw.task) ? raw.task : undefined;
		const legacyProbeMs =
			taskObj && "completionProbeMs" in taskObj ? taskObj.completionProbeMs : raw["task.completionProbeMs"];
		if (typeof legacyProbeMs === "number") {
			const target = taskObj ?? {};
			if (!("completionProbe" in target) && !("task.completionProbe" in raw)) {
				target.completionProbe = legacyProbeMs > 0;
			}
			raw.task = target;
		}
		if (taskObj) delete taskObj.completionProbeMs;
		delete raw["task.completionProbeMs"];
	}

	// Per-agent records accept booleans from early persisted toggles and
	// hand-written YAML, though the runtime contract is "on"/"off"/model pattern.
	// Normalize each layer before merging so project-level false still overrides global true.
	{
		const taskObj = isRecord(raw.task) ? raw.task : undefined;
		if (taskObj) {
			for (const key of ["agentPrewalk", "agentAdvisor", "agentPrewalkAuto"]) {
				const overrides = isRecord(taskObj[key]) ? taskObj[key] : undefined;
				if (!overrides) continue;
				for (const agentName in overrides) {
					const value = overrides[agentName];
					if (typeof value === "boolean") overrides[agentName] = value ? "on" : "off";
				}
			}
		}
	}

	// v17 renames that used to nest under a boolean parent path:
	//   dev.autoqa.consent -> dev.autoqaConsent
	//   todo.reminders.max -> todo.remindersMax
	migrateNestedLeafRename(
		raw,
		"dev",
		"autoqa",
		"consent",
		"autoqaConsent",
		value => value === "unset" || value === "granted" || value === "denied",
	);
	migrateNestedLeafRename(
		raw,
		"todo",
		"reminders",
		"max",
		"remindersMax",
		value => typeof value === "number" && Number.isFinite(value),
	);

	migrateRetiredSpeechSettings(raw);

	// BM25 tool discovery removal: tools.discoveryMode / tools.essentialOverride /
	// mcp.discoveryMode / mcp.discoveryDefaultServers are gone with no
	// replacement (`tools.commands` stays at its own default). Dead keys are
	// deleted so they stop lingering in config.yml.
	const toolsObj = raw.tools as Record<string, unknown> | undefined;
	if (toolsObj) {
		delete toolsObj.discoveryMode;
		delete toolsObj.essentialOverride;
	}
	delete raw["tools.discoveryMode"];
	delete raw["tools.essentialOverride"];
	const mcpObj = raw.mcp as Record<string, unknown> | undefined;
	if (mcpObj) {
		delete mcpObj.discoveryMode;
		delete mcpObj.discoveryDefaultServers;
	}
	delete raw["mcp.discoveryMode"];
	delete raw["mcp.discoveryDefaultServers"];

	// Retired provider/model selectors now live in modelRoles plus explicit
	// retry chains. Read nested and quoted-dotted forms from the same layer;
	// an owned nested key wins even when its value is undefined. Every legacy
	// key is removed after inspection so it cannot leak back into config.yml.
	function migrateKindRoleSettings(): void {
		const providerSettings = isRecord(raw.providers) ? raw.providers : undefined;
		const ttsSettings = isRecord(raw.tts) ? raw.tts : undefined;
		const sttSettings = isRecord(raw.stt) ? raw.stt : undefined;
		const legacy = (root: Record<string, unknown> | undefined, key: string, flatKey: string): unknown =>
			root && Object.hasOwn(root, key) ? root[key] : raw[flatKey];
		const removeLegacy = (root: Record<string, unknown> | undefined, key: string, flatKey: string): void => {
			if (root) delete root[key];
			delete raw[flatKey];
		};
		const dedupe = (values: readonly string[]): string[] => [...new Set(values)];

		const roles = isRecord(raw.modelRoles) ? raw.modelRoles : {};
		const retrySettings = isRecord(raw.retry) ? raw.retry : {};
		const fallbackChains = isRecord(retrySettings.fallbackChains) ? retrySettings.fallbackChains : {};
		let rolesChanged = false;
		let fallbackChainsChanged = false;
		const setRoleChain = (role: string, candidates: readonly string[]): void => {
			if (candidates.length === 0) return;
			if (!Object.hasOwn(roles, role)) {
				roles[role] = candidates[0];
				rolesChanged = true;
			}
			if (!Object.hasOwn(fallbackChains, role)) {
				fallbackChains[role] = candidates.slice(1);
				fallbackChainsChanged = true;
			}
		};

		const legacyWebSearch = legacy(providerSettings, "webSearch", "providers.webSearch");
		const legacyWebOrder = legacy(providerSettings, "webSearchOrder", "providers.webSearchOrder");
		const legacyWebExclude = legacy(providerSettings, "webSearchExclude", "providers.webSearchExclude");
		const legacyGeminiModel = legacy(providerSettings, "webSearchGeminiModel", "providers.webSearchGeminiModel");
		// Legacy settings named a provider; its swap target is the catalog's
		// resolved per-model policy (`web-search-model` / `image-model` / tts
		// seed kind), uniform across that provider's bundled rows.
		const bundledSelector = (
			provider: string,
			pick: (model: Model<Api>) => string | undefined,
		): string | undefined => {
			for (const model of getBundledModels(provider as GeneratedProvider)) {
				const id = pick(model);
				if (id) return `${provider}/${id}`;
			}
			return undefined;
		};
		const webSearchSelector = (provider: string): string[] => {
			const selector = bundledSelector(provider, model => model.webSearchModel);
			return selector ? [selector] : [];
		};
		const geminiSelectors = (model: string): string[] => [`google/${model}`];
		const webSelectors = (provider: string, geminiModel: string): string[] => {
			switch (provider) {
				case "gemini":
					return geminiSelectors(geminiModel);
				case "anthropic":
					return webSearchSelector("anthropic");
				case "codex":
					return webSearchSelector("openai-codex");
				case "xai":
					return webSearchSelector("xai");
				case "auto":
					return [];
				default:
					return isRegisteredSearchEngine(provider) ? [`web/${provider}`] : [];
			}
		};
		const geminiModel =
			typeof legacyGeminiModel === "string" && legacyGeminiModel.trim()
				? legacyGeminiModel.trim()
				: (getBundledModels("google").find(model => model.webSearchModel)?.webSearchModel ?? "");
		const excludedWebProviders = new Set(
			Array.isArray(legacyWebExclude)
				? legacyWebExclude.filter(
						(value): value is string => typeof value === "string" && webSelectors(value, geminiModel).length > 0,
					)
				: [],
		);
		const isWebSelectorExcluded = (selector: string): boolean => {
			if (excludedWebProviders.has("gemini") && geminiSelectors(geminiModel).includes(selector)) return true;
			if (excludedWebProviders.has("anthropic") && selector.startsWith("anthropic/")) return true;
			if (excludedWebProviders.has("codex") && selector.startsWith("openai-codex/")) return true;
			if (excludedWebProviders.has("xai") && (selector.startsWith("xai/") || selector.startsWith("xai-oauth/"))) {
				return true;
			}
			for (const provider of excludedWebProviders) {
				if (selector === `web/${provider}`) return true;
			}
			return false;
		};
		const orderedWebProviders = Array.isArray(legacyWebOrder)
			? legacyWebOrder
			: typeof legacyWebSearch === "string" && legacyWebSearch !== "auto"
				? [legacyWebSearch]
				: [];
		const orderedWebSelectors = orderedWebProviders.flatMap(value =>
			typeof value === "string" ? webSelectors(value, geminiModel) : [],
		);
		// The Gemini model only shapes an ordered `gemini` entry; the defaults hold no chat models.
		if (orderedWebSelectors.length > 0 || excludedWebProviders.size > 0) {
			setRoleChain(
				"web",
				dedupe([...orderedWebSelectors, ...roleDefaultModels().web]).filter(
					selector => !isWebSelectorExcluded(selector),
				),
			);
		}

		const legacyImage = legacy(providerSettings, "image", "providers.image");
		const legacyImageOrder = legacy(providerSettings, "imageOrder", "providers.imageOrder");
		const legacyImageProviders: Record<string, string> = {
			openai: "openai",
			"openai-codex": "openai-codex",
			xai: "xai",
			gemini: "google",
			deepinfra: "deepinfra",
		};
		const imageSelector = (provider: string): string | undefined => {
			// OpenRouter rows carry no gemini image-model swap (the gemini class
			// binds to Google transports only), so its legacy target stays literal.
			if (provider === "openrouter") return "openrouter/google/gemini-3-pro-image";
			const catalogProvider = legacyImageProviders[provider];
			return catalogProvider ? bundledSelector(catalogProvider, model => model.imageModel) : undefined;
		};
		const orderedImageProviders = Array.isArray(legacyImageOrder)
			? legacyImageOrder
			: typeof legacyImage === "string" && legacyImage !== "auto"
				? [legacyImage]
				: [];
		const orderedImageSelectors = orderedImageProviders.flatMap(value =>
			typeof value === "string" ? (imageSelector(value) ?? []) : [],
		);
		if (orderedImageSelectors.length > 0) {
			setRoleChain("image", dedupe([...orderedImageSelectors, ...roleDefaultModels().image]));
		}

		const legacyTtsProvider = legacy(providerSettings, "tts", "providers.tts");
		const speechSelector =
			legacyTtsProvider === "local" || legacyTtsProvider === "xai" || legacyTtsProvider === "deepinfra"
				? bundledSelector(legacyTtsProvider, model => (modelKind(model) === "tts" ? model.id : undefined))
				: undefined;
		if (speechSelector) setRoleChain("speech", [speechSelector]);

		const legacySttModel = legacy(sttSettings, "modelName", "stt.modelName");
		const dictationSelector =
			legacySttModel === "fast" || legacySttModel === "whisper-base"
				? "local/whisper-base"
				: legacySttModel === "balanced" || legacySttModel === "whisper-small"
					? "local/whisper-small"
					: legacySttModel === "turbo" || legacySttModel === "whisper-large-v3-turbo"
						? "local/whisper-large-v3-turbo"
						: undefined;
		if (dictationSelector && !Object.hasOwn(roles, "dictation")) {
			roles.dictation = dictationSelector;
			rolesChanged = true;
		}

		const legacyJudgmentProvider = legacy(providerSettings, "judgmentProvider", "providers.judgmentProvider");
		const legacyAutoThinkingModel = legacy(providerSettings, "autoThinkingModel", "providers.autoThinkingModel");
		const legacyUnexpectedStopModel = legacy(
			providerSettings,
			"unexpectedStopModel",
			"providers.unexpectedStopModel",
		);
		const nonDefaultJudge =
			(typeof legacyJudgmentProvider === "string" && legacyJudgmentProvider !== "auto") ||
			(typeof legacyAutoThinkingModel === "string" && legacyAutoThinkingModel !== "online") ||
			(typeof legacyUnexpectedStopModel === "string" && legacyUnexpectedStopModel !== "online");
		if (nonDefaultJudge) {
			const judgeCandidates: string[] = [];
			if (legacyJudgmentProvider !== "llm") judgeCandidates.push("typesafe/jev-1.14.0");
			if (typeof legacyAutoThinkingModel === "string" && legacyAutoThinkingModel !== "online") {
				judgeCandidates.push(`local/${legacyAutoThinkingModel}`);
			}
			if (typeof legacyUnexpectedStopModel === "string" && legacyUnexpectedStopModel !== "online") {
				judgeCandidates.push(`local/${legacyUnexpectedStopModel}`);
			}
			judgeCandidates.push("@tiny", "@smol", "@default");
			setRoleChain("judge", dedupe(judgeCandidates));
		}

		const prependLocalRole = (role: "tiny" | "memory", model: unknown): void => {
			if (typeof model !== "string" || model === "online" || model.length === 0) return;
			const selector = `local/${model}`;
			const configured = typeof roles[role] === "string" ? roles[role] : undefined;
			const patterns = configured
				? configured
						.split(",")
						.map(pattern => pattern.trim())
						.filter(Boolean)
				: [];
			roles[role] = dedupe([selector, ...patterns]).join(",");
			rolesChanged = true;
		};
		prependLocalRole("tiny", legacy(providerSettings, "tinyModel", "providers.tinyModel"));
		prependLocalRole("memory", legacy(providerSettings, "memoryModel", "providers.memoryModel"));

		for (const key of [
			"webSearch",
			"webSearchOrder",
			"webSearchExclude",
			"webSearchGeminiModel",
			"image",
			"imageOrder",
			"tts",
			"judgmentProvider",
			"autoThinkingModel",
			"unexpectedStopModel",
			"tinyModel",
			"memoryModel",
		]) {
			removeLegacy(providerSettings, key, `providers.${key}`);
		}
		removeLegacy(ttsSettings, "localModel", "tts.localModel");
		removeLegacy(sttSettings, "modelName", "stt.modelName");

		if (rolesChanged) raw.modelRoles = roles;
		if (fallbackChainsChanged) {
			retrySettings.fallbackChains = fallbackChains;
			raw.retry = retrySettings;
		}
		if (providerSettings && Object.keys(providerSettings).length === 0) delete raw.providers;
		if (ttsSettings && Object.keys(ttsSettings).length === 0) delete raw.tts;
		if (sttSettings && Object.keys(sttSettings).length === 0) delete raw.stt;
	}
	migrateKindRoleSettings();

	// The old web-provider migration persisted this pair of fuzzy defaults.
	// Qualified selectors are now exact, so replace the pair without changing
	// independently configured selectors or other role chains.
	{
		const retry = isRecord(raw.retry) ? raw.retry : undefined;
		const chains = retry && isRecord(retry.fallbackChains) ? retry.fallbackChains : undefined;
		const web = chains?.web;
		if (chains && Array.isArray(web)) {
			const index = web.findIndex(
				(selector, i) => selector === "openai-codex/gpt-5.6" && web[i + 1] === "openai-codex/gpt-5.5",
			);
			if (index !== -1) {
				chains.web = [...web.slice(0, index), "openai-codex/gpt-5.6-sol", ...web.slice(index + 2)];
			}
		}
	}

	// Consolidate the retired Exa suite toggles onto the sole remaining
	// provider switch. The old runtime required both `enabled` and
	// `enableSearch`, so preserve that AND semantics when both are present.
	// Researcher and Websets were removed with the standalone Exa tools.
	const exaObj = isRecord(raw.exa) ? raw.exa : undefined;
	const exaEnabledValues = [exaObj?.enabled, raw["exa.enabled"], exaObj?.enableSearch, raw["exa.enableSearch"]].filter(
		(value): value is boolean => typeof value === "boolean",
	);
	const hasFlatExaSetting =
		"exa.enabled" in raw || "exa.enableSearch" in raw || "exa.enableResearcher" in raw || "exa.enableWebsets" in raw;
	if (exaObj || hasFlatExaSetting) {
		const exaRoot = exaObj ?? {};
		if (exaEnabledValues.length > 0) {
			exaRoot.enabled = exaEnabledValues.every(Boolean);
		}
		delete exaRoot.enableSearch;
		delete exaRoot.enableResearcher;
		delete exaRoot.enableWebsets;
		if (Object.keys(exaRoot).length > 0) {
			raw.exa = exaRoot;
		} else {
			delete raw.exa;
		}
		delete raw["exa.enabled"];
		delete raw["exa.enableSearch"];
		delete raw["exa.enableResearcher"];
		delete raw["exa.enableWebsets"];
	}

	// computer.backend and model-specific controller routing were removed
	// when the computer tool moved to one native desktop implementation.
	const computerObj = isRecord(raw.computer) ? raw.computer : undefined;
	if (computerObj && "backend" in computerObj) {
		delete computerObj.backend;
		if (Object.keys(computerObj).length === 0) {
			delete raw.computer;
		}
	}
	delete raw["computer.backend"];

	// computer.backgroundFallback became computer.takeover, which added the
	// opt-in `foreground` and `always` modes. `refuse` carries over; the old
	// `takeover` is the default `fallback`, so it is dropped.
	const computerSettings = isRecord(raw.computer) ? raw.computer : undefined;
	const fallback = computerSettings?.backgroundFallback ?? raw["computer.backgroundFallback"];
	if (fallback === "refuse" && computerSettings?.takeover === undefined && raw["computer.takeover"] === undefined) {
		if (computerSettings) computerSettings.takeover = "refuse";
		else raw.computer = { takeover: "refuse" };
	}
	if (computerSettings) {
		delete computerSettings.backgroundFallback;
		if (Object.keys(computerSettings).length === 0) delete raw.computer;
	}
	delete raw["computer.backgroundFallback"];

	delete raw["hindsight.mentalModelRefreshIntervalMs"];

	return raw;
}
