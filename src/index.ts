// Core commands

export { createPlugin } from "./commands/create.js";
export { runDoctor } from "./commands/doctor.js";
export { disablePlugin, enablePlugin } from "./commands/enable.js";
export { showInfo } from "./commands/info.js";
// New commands
export { initProject } from "./commands/init.js";
export { installPlugin } from "./commands/install.js";
export { linkPlugin } from "./commands/link.js";
export { listPlugins } from "./commands/list.js";
export { showOutdated } from "./commands/outdated.js";
export { searchPlugins } from "./commands/search.js";
export { uninstallPlugin } from "./commands/uninstall.js";
export { updatePlugin } from "./commands/update.js";
export { whyFile } from "./commands/why.js";
export {
	detectAllConflicts,
	detectConflicts,
	formatConflicts,
} from "./conflicts.js";

// Types
export type {
	OmpField,
	OmpInstallEntry,
	PluginPackageJson,
	PluginsJson,
} from "./manifest.js";

// Utilities
export {
	getInstalledPlugins,
	initGlobalPlugins,
	loadPluginsJson,
	readPluginPackageJson,
	savePluginsJson,
} from "./manifest.js";
// Migration
export { checkMigration, migrateToNpm } from "./migrate.js";
export {
	npmInfo,
	npmInstall,
	npmOutdated,
	npmSearch,
	npmUninstall,
	npmUpdate,
} from "./npm.js";
export {
	checkPluginSymlinks,
	createPluginSymlinks,
	removePluginSymlinks,
} from "./symlinks.js";
