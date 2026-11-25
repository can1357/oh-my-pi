/** The composer: the prompt field, its draft state and its extension hooks. */
export * from "./attachments";
export * from "./autocomplete";
export * from "./chips";
export * from "./composer";
export type { VimMode } from "./vim";
export * from "./vim-editor";
export {
	type ComposerChromeContext,
	type ComposerRowContext,
	type ComposerRowRender,
	type ComposerShape,
	type ComposerStatus,
	composerShape,
	composerShapeIds,
	registerComposerShape,
} from "../styles/composer/shapes";
