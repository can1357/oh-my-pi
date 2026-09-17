/** Shared I/O delegation policy; deliberately independent of root model steering. */
type FusionIoSettings = { get(key: string): unknown };

export const DEFAULT_FUSION_IO_MIN_LINES = 350;

export function isFusionIoDelegationActive(settings: FusionIoSettings): boolean {
	const mode = settings.get("fusion.mode");
	return (
		settings.get("fusion.enabled") === true &&
		settings.get("fusion.ioDelegation.enabled") !== false &&
		(mode === "token-savings" || mode === "savings" || mode === "autonomous")
	);
}

function isPositiveInteger(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function parseEnvMinLines(value: string | undefined): number | undefined {
	if (value === undefined || !/^\d+$/.test(value.trim())) return undefined;
	const number = Number(value.trim());
	return isPositiveInteger(number) ? number : undefined;
}

export function resolveFusionIoMinLines(settings: FusionIoSettings, envValue: string | undefined): number {
	const override = parseEnvMinLines(envValue);
	if (override !== undefined) return override;
	const configured = settings.get("fusion.ioDelegation.minLines");
	return isPositiveInteger(configured) ? configured : DEFAULT_FUSION_IO_MIN_LINES;
}

/** Bounded diagnostic; the session boundary owns warning deduplication and environment access. */
export function getFusionIoThresholdWarning(
	settings: FusionIoSettings,
	envValue: string | undefined,
): string | undefined {
	const invalidEnv = envValue !== undefined && parseEnvMinLines(envValue) === undefined;
	const configured = settings.get("fusion.ioDelegation.minLines");
	const invalidSetting = configured !== undefined && !isPositiveInteger(configured);
	if (!invalidEnv && !invalidSetting) return undefined;
	const sources = [
		invalidEnv ? "SHUNT_MIN_LINES" : undefined,
		invalidSetting ? "fusion.ioDelegation.minLines" : undefined,
	]
		.filter(Boolean)
		.join(" and ");
	return `[Fusion I/O] Ignoring invalid ${sources}; expected a positive integer. Using the valid override, setting, or default of 350 lines.`;
}

/** Whether this agent is the autonomous planning-only root. */
export function isAutonomousRoot(settings: FusionIoSettings, agentKind: string): boolean {
	return (
		agentKind === "main" && settings.get("fusion.enabled") === true && settings.get("fusion.mode") === "autonomous"
	);
}

const AUTONOMOUS_ROOT_TOOL_NAMES: Readonly<Record<string, true>> = {
	read: true,
	search: true,
	find: true,
	grep: true,
	glob: true,
	ast_grep: true,
	web_search: true,
	inspect_image: true,
	recall: true,
	reflect: true,
	ask: true,
	task: true,
	todo: true,
	irc: true,
	job: true,
	yield: true,
	report_finding: true,
	report_tool_issue: true,
	search_tool_bm25: true,
};

/** Fail closed on unknown capabilities, including nested execution and discovery additions. */
export function getAutonomousRootToolBlockReason(
	settings: FusionIoSettings,
	agentKind: string,
	name: string,
	args: unknown,
): string | undefined {
	if (!isAutonomousRoot(settings, agentKind)) {
		return undefined;
	}
	if (Object.hasOwn(AUTONOMOUS_ROOT_TOOL_NAMES, name)) return undefined;
	if (
		name === "resolve" &&
		args !== null &&
		typeof args === "object" &&
		"action" in args &&
		args.action === "discard"
	) {
		return undefined;
	}
	return "[Autonomous Fusion Mode] This capability is unavailable to the planning-only root. Delegate execution through task.";
}
