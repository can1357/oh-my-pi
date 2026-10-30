import { getRoleInfo } from "../config/model-roles";
import { resolveModelRoleValue } from "../config/model-resolver";
import type { SlashCommandSpec } from "./types";

export const BUILTIN_SETTINGS_SLASH_COMMANDS: ReadonlyArray<SlashCommandSpec> = [
	{
		name: "reload-settings",
		aliases: ["reload-config"],
		description: "Reload settings and the model catalog from disk and report applied changes",
		acpDescription: "Reload settings and models from disk",
		handle: async (_command, runtime) => {
			const { session, settings } = runtime;
			try {
				await settings.reloadFromDisk();
			} catch (error) {
				await runtime.output(`Settings reload failed: ${error instanceof Error ? error.message : String(error)}`);
				return;
			}

			const warnings: string[] = [];
			let catalogRefreshed = false;
			try {
				await session.refreshModels();
				catalogRefreshed = true;
			} catch (error) {
				warnings.push(error instanceof Error ? error.message : String(error));
			}
			session.reapplyModelRoles();
			await runtime.notifyConfigChanged?.();

			const models = session.modelRegistry.getAll();
			for (const [role, selector] of Object.entries(settings.getModelRoles())) {
				if (!selector?.trim()) continue;
				const pool = models.filter(getRoleInfo(role, settings).accepts);
				if (!resolveModelRoleValue(selector, pool, { settings }).model) {
					warnings.push(`Model role '${role}' references unknown model: ${selector}`);
				}
			}
			warnings.push(...session.configWarnings);
			const ids = session.takeSettingChanges();
			const report = [ids.length > 0 ? `Applied: ${ids.join(", ")}` : "No settings changed"];
			if (catalogRefreshed) report.push("Model catalog refreshed");
			for (const warning of new Set(warnings)) report.push(`Warning: ${warning}`);
			await runtime.output(report.join("\n"));
		},
	},
];
