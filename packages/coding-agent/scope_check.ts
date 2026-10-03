import { AuthStorage } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "./src/config/model-registry";
import { Settings } from "./src/config/settings";
import { cfgEnabledModels } from "./src/config/model-settings";

const effortsFor = (model: unknown): string => {
	if (model && typeof model === "object" && "thinking" in model) {
		const thinking = model.thinking;
		if (thinking && typeof thinking === "object" && "efforts" in thinking) {
			const efforts = thinking.efforts;
			if (Array.isArray(efforts)) return efforts.map(String).join(",");
		}
	}
	return "-";
};

const authStorage = await AuthStorage.create(":memory:");
const settings = await Settings.init();
const registry = new ModelRegistry(authStorage, undefined, { settings });
const available = registry.getAvailable();
const patterns = cfgEnabledModels.get(settings) ?? [];

console.log("patterns:", patterns.length, "| available:", available.length);
console.log("--- commandcode entries in available() ---");
for (const m of available) {
	if (m.provider === "commandcode") {
		const match = patterns.some(p => p.startsWith(`commandcode/${m.id}`));
		if (match) console.log(`  ${m.id}  [${effortsFor(m)}]`);
	}
}
authStorage.close();
