// Always null on disk. Standalone binary builds replace this module in memory
// with the target's manifest and one zstd frame per addon (scripts/embed-native.ts).

/** @typedef {"modern" | "baseline" | "default"} EmbeddedAddonVariant */

/**
 * @typedef {Object} EmbeddedAddonFile
 * @property {EmbeddedAddonVariant} variant
 * @property {string} filename
 * @property {number} size Decompressed `.node` size in bytes.
 * @property {string} hash Build-time xxHash64 (hex) of the decompressed addon.
 * @property {string} zstdPath Embedded zstd frame holding the addon bytes.
 */

/**
 * @typedef {Object} EmbeddedAddon
 * @property {string} platformTag
 * @property {string} version
 * @property {EmbeddedAddonFile[]} files
 * @property {EmbeddedAddonFile} [v8EvalBinary]
 */
/** @type {EmbeddedAddon|null} */
export const embeddedAddon = null;
