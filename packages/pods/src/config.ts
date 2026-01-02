import { homedir } from "os";
import { join } from "path";
import type { Config, Pod } from "./types.js";

// Get config directory from env or use default
const getConfigDir = async (): Promise<string> => {
	const configDir = process.env.PI_CONFIG_DIR || join(homedir(), ".pi");
	const dirFile = Bun.file(configDir);
	if (!(await dirFile.exists())) {
		await Bun.write(join(configDir, ".keep"), "");
	}
	return configDir;
};

const getConfigPath = async (): Promise<string> => {
	return join(await getConfigDir(), "pods.json");
};

export const loadConfig = async (): Promise<Config> => {
	const configPath = await getConfigPath();
	const configFile = Bun.file(configPath);
	if (!(await configFile.exists())) {
		// Return empty config if file doesn't exist
		return { pods: {} };
	}
	try {
		const data = await configFile.text();
		return JSON.parse(data);
	} catch (e) {
		console.error(`Error reading config: ${e}`);
		return { pods: {} };
	}
};

export const saveConfig = async (config: Config): Promise<void> => {
	const configPath = await getConfigPath();
	try {
		await Bun.write(configPath, JSON.stringify(config, null, 2));
	} catch (e) {
		console.error(`Error saving config: ${e}`);
		process.exit(1);
	}
};

export const getActivePod = async (): Promise<{ name: string; pod: Pod } | null> => {
	const config = await loadConfig();
	if (!config.active || !config.pods[config.active]) {
		return null;
	}
	return { name: config.active, pod: config.pods[config.active] };
};

export const addPod = async (name: string, pod: Pod): Promise<void> => {
	const config = await loadConfig();
	config.pods[name] = pod;
	// If no active pod, make this one active
	if (!config.active) {
		config.active = name;
	}
	await saveConfig(config);
};

export const removePod = async (name: string): Promise<void> => {
	const config = await loadConfig();
	delete config.pods[name];
	// If this was the active pod, clear active
	if (config.active === name) {
		config.active = undefined;
	}
	await saveConfig(config);
};

export const setActivePod = async (name: string): Promise<void> => {
	const config = await loadConfig();
	if (!config.pods[name]) {
		console.error(`Pod '${name}' not found`);
		process.exit(1);
	}
	config.active = name;
	await saveConfig(config);
};
