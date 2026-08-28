import { File, Folder, FolderPlus, Maximize2, PanelLeft, PanelRight, SlidersHorizontal, SquarePen } from "lucide-react";

/**
 * Title-bar icons.
 *
 * Thin wrappers rather than direct lucide imports at the call sites, so size and
 * stroke are decided once: at 16px lucide's default stroke of 2 reads heavy next
 * to monospace text, and a bar with two weights of icon looks unfinished.
 */
const ICON = { size: 16, strokeWidth: 1.75, className: "omp-icon", "aria-hidden": true } as const;

/** Panel toggles: a pane with its divider on the side that panel lives on. */
export const PanelLeftIcon = () => <PanelLeft {...ICON} />;
export const PanelRightIcon = () => <PanelRight {...ICON} />;

/** Compose a new session. */
export const SquarePenIcon = () => <SquarePen {...ICON} />;

/** Add a project folder. */
export const FolderPlusIcon = () => <FolderPlus {...ICON} />;

/** Marks the project in the title bar's context label. */
export const FolderIcon = () => <Folder {...ICON} />;

/** Settings, plugins and MCP. */
export const SlidersIcon = () => <SlidersHorizontal {...ICON} />;

/** Expand the composer to the full-size editor. */
export const ExpandIcon = () => <Maximize2 {...ICON} />;

/** Marks a referenced file — one the agent reads, rather than one we upload. */
export const FileIcon = () => <File {...ICON} />;
