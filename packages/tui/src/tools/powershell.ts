import { createShellRenderer, type BashToolDetails } from "./bash";

export interface PowerShellRenderArgs {
	command?: string;
	host?: "session" | "ephemeral" | "new-session";
}

export interface PowerShellToolDetails extends BashToolDetails {
	host?: "session" | "ephemeral" | "new-session";
	pid?: number;
	execId?: number;
	hadErrors?: boolean;
}

export const powershellToolRenderer = createShellRenderer<PowerShellRenderArgs>({
	resolveTitle: args => (args?.host && args.host !== "session" ? `PowerShell · ${args.host}` : "PowerShell"),
	resolveCommand: args => args?.command,
	commandLanguage: "powershell",
	commandPrefix: "PS>",
	// `pwsh` (nf-dev-powershell) vs Windows PowerShell (nf-seti-powershell):
	// the two editions run in independent pooled hosts and can be used side
	// by side in one session, so the icon is the call's visual distinguisher.
	// Missing `edition` (older transcripts, or a result still in flight) is
	// treated as `pwsh`, the configured default.
	resolveIcon: details => (details?.edition === "powershell" ? "tool.powershell" : "tool.pwsh"),
});
