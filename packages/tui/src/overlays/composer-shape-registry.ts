import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { type ComposerStyle, registerComposerStyle } from "../index";
import type { SubmenuOption } from "./settings-defs";

/** Composer shape id; extensions may register additional values at runtime. */
export type ComposerShape = string;

/** Built-in composer choices and their shared settings/setup copy. */
export const BUILTIN_COMPOSER_SHAPES = [
	{
		value: "band",
		label: __ompTranslate("Status Band (Default)"),
		description: __ompTranslate("Flush soft-capped status band above a curved prompt, no frame"),
	},
	{
		value: "box",
		label: __ompTranslate("Rounded Box"),
		description: __ompTranslate("Status line embedded in top border, compact 2-line prompt"),
	},
	{
		value: "claude",
		label: "Claude Code",
		description: __ompTranslate("Full-width horizontal rules above and below, status line at bottom"),
	},
	{
		value: "pi",
		label: "Pi",
		description: __ompTranslate("Framed horizontal rules with status line at bottom"),
	},
	{
		value: "borderless",
		label: __ompTranslate("Borderless"),
		description: __ompTranslate("Clean prompt glyph with status line at bottom, no box borders"),
	},
	{
		value: "rule",
		label: __ompTranslate("Top Rule Dock"),
		description: __ompTranslate("Single top rule with status docked onto it and below"),
	},
	{
		value: "field",
		label: __ompTranslate("Compact Field"),
		description: __ompTranslate("Filled one-row field with accent end caps"),
	},
	{
		value: "rail",
		label: __ompTranslate("Accent Rail"),
		description: __ompTranslate("Filled one-row field anchored by a single accent rail"),
	},
] as const;

/** Built-in composer ids used by tests and non-runtime consumers. */
export const COMPOSER_SHAPE_VALUES = BUILTIN_COMPOSER_SHAPES.map(shape => shape.value);

/** Visual composer style and selector copy registered by an extension. */
export interface ComposerShapeDefinition {
	label: string;
	description?: string;
	style: ComposerStyle;
}

const extensionComposerShapes = new Map<string, SubmenuOption>();

/** Install one extension composer shape into rendering and selector registries. */
export function installExtensionComposerShape(definition: ComposerShapeDefinition): () => void {
	const unregisterStyle = registerComposerStyle(definition.style);
	const id = definition.style.id;
	const option: SubmenuOption = {
		value: id,
		label: definition.label,
		description: definition.description,
	};
	extensionComposerShapes.set(id, option);
	return () => {
		if (extensionComposerShapes.get(id) === option) extensionComposerShapes.delete(id);
		unregisterStyle();
	};
}

/** Available built-in and extension composer choices in selector order. */
export function getComposerShapeOptions(): readonly SubmenuOption[] {
	return [...BUILTIN_COMPOSER_SHAPES, ...extensionComposerShapes.values()];
}
