/** Compact title-model input for a user-invoked `/skill:<name>` prompt. */
export function skillPromptTitleInput(input: { name?: string; args?: string; queueChipText?: string }): string {
	const chip = input.queueChipText?.trim();
	if (chip) return chip;
	const name = input.name?.trim();
	const args = input.args?.trim();
	if (name && args) return `/skill:${name} ${args}`;
	if (name) return `/skill:${name}`;
	return args ?? "";
}

/** Title text for a persisted skill-prompt custom message. Never the expanded SKILL.md body. */
export function titleTextFromSkillPrompt(message: {
	role: string;
	customType?: string;
	attribution?: string;
	details?: unknown;
}): string | undefined {
	if (message.role !== "custom" || message.customType !== "skill-prompt" || message.attribution !== "user") {
		return undefined;
	}
	let name: string | undefined;
	let args: string | undefined;
	let queueChipText: string | undefined;
	if (message.details && typeof message.details === "object") {
		const details = message.details as Record<string, unknown>;
		if (typeof details.name === "string") name = details.name;
		if (typeof details.args === "string") args = details.args;
		if (typeof details.__queueChipText === "string") queueChipText = details.__queueChipText;
	}
	return skillPromptTitleInput({ name, args, queueChipText }) || undefined;
}
