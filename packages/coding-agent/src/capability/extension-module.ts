/**
 * Extension Modules Capability
 *
 * TypeScript/JavaScript extension modules loaded by the extension system.
 */
import { defineCapability } from ".";
import type { SourceMeta } from "./types";

/**
 * A loaded extension module.
 */
export interface ExtensionModule {
	/** Extension module name (derived from path) */
	name: string;
	/** Absolute path to extension entrypoint */
	path: string;
	/** Source level */
	level: "user" | "project";
	/** Source metadata */
	_source: SourceMeta;
}

export const extensionModuleCapability = defineCapability<ExtensionModule>({
	id: "extension-modules",
	displayName: "Extension Modules",
	description: "TypeScript/JavaScript extension modules loaded by the extension system",
	key: ext => ext.name,
	toExtensionId: ext => `extension-module:${ext.name}`,
	validate: ext => {
		if (!ext.name) return "Missing name";
		if (!ext.path) return "Missing path";
		return undefined;
	},
});
