/** The settings window's pages: label and lead sentence per settings tab. */
import type { SettingTab } from "../../../config/settings-defs";

/** A settings page's title and the sentence under it. */
export interface SettingsPage {
	readonly label: string;
	readonly lead: string;
}

export const SETTINGS_PAGES: Readonly<Record<SettingTab, SettingsPage>> = {
	appearance: { label: "Appearance", lead: "Theme, composer, status line and how the transcript renders." },
	model: { label: "Model", lead: "Thinking, sampling, the system prompt, retries and the helper models." },
	interaction: { label: "Interaction", lead: "Input, approvals, notifications, speech and what happens at startup." },
	context: { label: "Context", lead: "What the model sees, and when and how the conversation compacts." },
	memory: { label: "Memory", lead: "What omp remembers across sessions and where it keeps it." },
	files: { label: "Files", lead: "How files are read, summarized and edited, and the language servers." },
	shell: { label: "Shell", lead: "The bash tool and the eval runtimes." },
	tools: { label: "Tools", lead: "Which tools the model has, their limits and the external integrations." },
	tasks: { label: "Tasks", lead: "Modes, subagents, isolation and custom commands." },
	providers: { label: "Providers", lead: "Services, provider protocols, timeouts and privacy." },
};
