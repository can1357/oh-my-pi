// Plugin system exports
export { formatDoctorResults, runDoctorChecks } from "./doctor.js";
export {
	getAllPluginCommandPaths,
	getAllPluginHookPaths,
	getAllPluginToolPaths,
	getEnabledPlugins,
	getPluginSettings,
	resolvePluginCommandPaths,
	resolvePluginHookPaths,
	resolvePluginToolPaths,
} from "./loader.js";
export { PluginManager, parseSettingValue, validateSetting } from "./manager.js";
export { extractPackageName, formatPluginSpec, parsePluginSpec } from "./parser.js";
export {
	getPluginsDir,
	getPluginsLockfile,
	getPluginsNodeModules,
	getPluginsPackageJson,
	getProjectPluginOverrides,
} from "./paths.js";
export type {
	BooleanSetting,
	DoctorCheck,
	DoctorOptions,
	EnumSetting,
	InstalledPlugin,
	InstallOptions,
	NumberSetting,
	PluginFeature,
	PluginManifest,
	PluginRuntimeConfig,
	PluginRuntimeState,
	PluginSettingSchema,
	PluginSettingType,
	ProjectPluginOverrides,
	StringSetting,
} from "./types.js";
