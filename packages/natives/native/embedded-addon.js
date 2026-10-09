
// Always null on disk. Standalone binary builds replace this module in memory
// with the target's manifest and addon archive (scripts/embed-native.ts).

/** @typedef {"modern" | "baseline" | "default"} EmbeddedAddonVariant */

/**
 * @typedef {Object} EmbeddedAddonFile
 * @property {EmbeddedAddonVariant} variant
 * @property {string} filename
 * @property {number} size
 * @property {string=} filePath
 */

/**
 * @typedef {Object} EmbeddedAddonArchive
 * @property {"tar.gz"} format
 * @property {string} filename
 * @property {string} filePath
 */

/**
 * @typedef {Object} EmbeddedAddon
 * @property {string} platformTag
 * @property {string} version
 * @property {EmbeddedAddonFile[]} files
 * @property {EmbeddedAddonArchive=} archive
 */

/** @type {EmbeddedAddon|null} */
export const embeddedAddon = null;
