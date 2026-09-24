import {
	createI18n,
	EN_MESSAGES,
	resolveLocale,
	type I18n,
	type LocalePreference,
	type MessageKey,
} from "@oh-my-pi/pi-i18n";
import { configureDefaultI18n } from "@oh-my-pi/pi-tui/i18n";
import type { Args } from "./cli/args";

export interface CodingAgentLocaleInput {
	language?: LocalePreference;
	configured?: LocalePreference;
	environment?: readonly string[];
}

export function readCliLanguagePreference(argv: readonly string[]): LocalePreference | undefined {
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index];
		const value = arg === "--language" ? argv[index + 1] : arg.startsWith("--language=") ? arg.slice(11) : undefined;
		if (value === "auto" || value === "en" || value === "zh-CN") return value;
	}
	return undefined;
}

export function getEnvironmentLocalePreferences(environment: NodeJS.ProcessEnv = process.env): string[] {
	return [environment.OMP_LOCALE, environment.LC_ALL, environment.LC_MESSAGES, environment.LANG].filter(
		(value): value is string => value !== undefined,
	);
}

let activeI18n: I18n = createI18n("en");

export function resolveCodingAgentLocale(input: CodingAgentLocaleInput): I18n["locale"] {
	return resolveLocale({
		explicit: input.language,
		configured: input.configured,
		environment: input.environment,
	});
}

export function configureCodingAgentI18n(input: CodingAgentLocaleInput): I18n {
	activeI18n = createI18n(resolveCodingAgentLocale(input));
	configureDefaultI18n(activeI18n);
	return activeI18n;
}

export function configureCodingAgentI18nFromArgs(
	args: Pick<Args, "language">,
	configured?: LocalePreference,
	environment: NodeJS.ProcessEnv = process.env,
): I18n {
	return configureCodingAgentI18n({
		language: args.language,
		configured,
		environment: getEnvironmentLocalePreferences(environment),
	});
}

export function getCodingAgentI18n(): I18n {
	return activeI18n;
}

const FIXED_STATUS_KEYS: Readonly<Record<string, MessageKey>> = {
	"Already at this point": "codingAgent.status.alreadyAtPoint",
	"Advisor history copied to clipboard": "codingAgent.status.advisorCopied",
	"Advisor has no history yet.": "codingAgent.status.advisorNoHistory",
	"Advisor is not active for this session.": "codingAgent.status.advisorNotActive",
	"Auto-handoff completed": "codingAgent.status.autoHandoffCompleted",
	"Auto-shake completed": "codingAgent.status.autoShakeCompleted",
	"Background jobs are disabled; enable async jobs to use /tan.": "codingAgent.status.backgroundJobsDisabled",
	"Returned to main session": "codingAgent.status.branchReturned",
	"Branched to new session": "codingAgent.status.branchedSession",
	"Cannot pin an account while the session is streaming.": "codingAgent.status.cannotPinStreaming",
	"Clipboard is empty": "codingAgent.status.clipboardEmpty",
	"Failed to read clipboard": "codingAgent.status.clipboardReadFailed",
	"Compaction cancelled": "codingAgent.status.compactionCancelled",
	"Commands run in the main session — press ←← to return first": "codingAgent.status.conversationMainOnly",
	"Delete cancelled": "codingAgent.status.deleteCancelled",
	"Fork failed (session not persisted or cancelled)": "codingAgent.status.forkFailed",
	"Goal is already complete.": "codingAgent.status.goalAlreadyComplete",
	"Goal mode completed.": "codingAgent.status.goalModeCompleted",
	"Goal mode disabled.": "codingAgent.status.goalModeDisabled",
	"Goal mode paused.": "codingAgent.status.goalModePaused",
	"Goal mode resumed.": "codingAgent.status.goalModeResumed",
	"Handoff cancelled": "codingAgent.status.handoffCancelled",
	"Hindsight backend is not active for this session.": "codingAgent.status.hindsightInactive",
	"Image paste is not supported in this prompt": "codingAgent.status.imagePasteUnsupported",
	"Local execution is host-only during a collab session": "codingAgent.status.localExecutionHostOnly",
	"Mental models are disabled (hindsight.mentalModelsEnabled = false).": "codingAgent.status.mentalModelsDisabled",
	"Memory data cleared and system prompt refreshed.": "codingAgent.status.memoryCleared",
	"Memory consolidation enqueued.": "codingAgent.status.memoryEnqueued",
	"Memory consolidation ran.": "codingAgent.status.memoryRan",
	"Model/thinking apply to the main session — press ←← to return first": "codingAgent.status.modelThinkingMainOnly",
	"No text in clipboard to paste raw": "codingAgent.status.noClipboardText",
	"No active model available for /omfg.": "codingAgent.status.noActiveModel",
	"No active model available for /btw.": "codingAgent.status.noActiveModelBtw",
	"No active model available for /tan.": "codingAgent.status.noActiveModelTan",
	"No messages to dump yet.": "codingAgent.status.noMessagesDump",
	"No entries in session": "codingAgent.status.noEntries",
	"No messages to branch from": "codingAgent.status.noMessagesToBranch",
	"No provider accounts found. Use /login to add one.": "codingAgent.status.noProviderAccounts",
	"No queued messages to restore": "codingAgent.status.noQueuedMessages",
	"No stored provider credentials to log out. Remove env or config auth at its source.":
		"codingAgent.status.noStoredCredentials",
	"No todos. Use /todo append <task> to start one.": "codingAgent.status.noTodos",
	"Nothing to delete (in-memory session)": "codingAgent.status.nothingToDelete",
	"Nothing to copy yet.": "codingAgent.status.nothingToCopy",
	"Nothing to copy": "codingAgent.status.nothingToCopyShort",
	"Nothing to retry": "codingAgent.status.nothingToRetry",
	"Nothing to shake.": "codingAgent.status.nothingToShake",
	"Only one role model available": "codingAgent.status.onlyOneRole",
	"Failed to read pasted image path": "codingAgent.status.pastedImageReadFailed",
	"Pasted path is not a supported image": "codingAgent.status.pastedPathUnsupported",
	"Failed to save paste to a file — attached as a text chip instead": "codingAgent.status.pasteFileFailed",
	"Failed to paste raw text from clipboard": "codingAgent.status.rawPasteFailed",
	"Navigation cancelled": "codingAgent.status.navigationCancelled",
	"Reloaded session": "codingAgent.status.reloadedSession",
	"Restored last queued message to editor": "codingAgent.status.restoredQueuedMessage",
	"Rewound to selected point": "codingAgent.status.rewound",
	"/retry is host-only during a collab session": "codingAgent.status.retryHostOnly",
	"Session name cannot be empty.": "codingAgent.status.sessionNameEmpty",
	"Session has not been saved yet": "codingAgent.status.sessionNotSaved",
	"Session deleted": "codingAgent.status.sessionDeleted",
	"Session shared": "codingAgent.status.sessionShared",
	"Share cancelled": "codingAgent.status.shareCancelled",
	"Smithery API key cannot be empty.": "codingAgent.status.smitheryKeyEmpty",
	"Smithery API key saved.": "codingAgent.status.smitheryKeySaved",
	"That subagent is gone — open the hub for live agents": "codingAgent.status.subagentGone",
	"Suspend (Ctrl+Z) is not supported on this platform": "codingAgent.status.suspendUnsupported",
	"Thinking is off — enable thinking to show blocks": "codingAgent.status.thinkingDisabled",
	"Current model does not support thinking": "codingAgent.status.thinkingUnsupported",
	"Cleared all todos.": "codingAgent.status.todosCleared",
	"Copied todos as Markdown to clipboard.": "codingAgent.status.todosCopied",
	"Navigated to selected point": "codingAgent.status.translatedPoint",
	"This collab link is read-only — prompting is disabled": "codingAgent.status.collabReadonly",
	"Copied plan to clipboard": "codingAgent.status.planCopied",
	"Plan updated in external editor.": "codingAgent.status.planUpdated",
	"Plan mode disabled.": "codingAgent.status.planDisabled",
	"Re-answer cancelled": "codingAgent.status.reanswerCancelled",
	"Branch summarization cancelled": "codingAgent.status.branchSummaryCancelled",
	"Ask tool UI is not ready": "codingAgent.status.askUiNotReady",
	"No session file to delete (in-memory session)": "codingAgent.status.noSessionFile",
};

const CATALOG_STATUS_KEYS: ReadonlyMap<string, MessageKey> = new Map(
	Object.entries(EN_MESSAGES.codingAgent.status).map(([key, value]) => [
		value,
		`codingAgent.status.${key}` as MessageKey,
	]),
);

/** Translate fixed controller chrome while preserving dynamic model/error text. */
export function localizeCodingAgentUiMessage(message: string): string {
	const i18n = getCodingAgentI18n();
	const fixedKey = FIXED_STATUS_KEYS[message] ?? CATALOG_STATUS_KEYS.get(message);
	if (fixedKey) return i18n.t(fixedKey);

	const fallback = /^Fallback succeeded on (.+)$/.exec(message);
	if (fallback) return i18n.t("codingAgent.status.fallbackSucceeded", { model: fallback[1]! });
	const login = /^Logging in to (.+)…$/.exec(message);
	if (login) return i18n.t("codingAgent.status.loginTo", { provider: login[1]! });
	const loginFailed = /^Login failed: (.+)$/.exec(message);
	if (loginFailed) return i18n.t("codingAgent.status.loginFailed", { error: loginFailed[1]! });
	const installing = /^Installing (.+) from (.+)\.\.\.$/.exec(message);
	if (installing)
		return i18n.t("codingAgent.status.installing", { name: installing[1]!, marketplace: installing[2]! });
	const installed = /^Installed (.+) from (.+)$/.exec(message);
	if (installed) return i18n.t("codingAgent.status.installed", { name: installed[1]!, marketplace: installed[2]! });
	const installFailed = /^Install failed: (.+)$/.exec(message);
	if (installFailed) return i18n.t("codingAgent.status.installFailed", { error: installFailed[1]! });
	return message;
}
