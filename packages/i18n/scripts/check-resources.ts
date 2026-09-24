import { assertCatalogParity, assertMessagePlaceholders } from "../src/catalog";
import { EN_MESSAGES, ZH_CN_MESSAGES } from "../src/messages";

try {
	assertCatalogParity(EN_MESSAGES, ZH_CN_MESSAGES, "zh-CN");
	assertMessagePlaceholders(EN_MESSAGES, ZH_CN_MESSAGES, "zh-CN");
	console.log("i18n resources: ok");
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exitCode = 1;
}
