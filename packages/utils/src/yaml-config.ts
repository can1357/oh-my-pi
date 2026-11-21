import { YAML } from "bun";

const YAML_MAPPING_HEADER_TRAILING_SPACE = /: +$/gm;

/** Serialize config YAML without Bun's trailing space on block mapping headers. */
export function stringifyYamlConfig(value: unknown): string {
	return YAML.stringify(value, null, 2).replace(YAML_MAPPING_HEADER_TRAILING_SPACE, ":");
}
