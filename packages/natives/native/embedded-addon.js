// Source and npm loads resolve their addon from disk. Release bundles replace this
// module with linked-addon.js; the Nix build supplies its own zstd manifest instead.

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
 */

/** @type {EmbeddedAddon|null} */
export const embeddedAddon = null;

/**
 * Supplied only by the standalone runtime built with pi-natives linked in.
 * @type {null | (() => Record<string, unknown>)}
 */
export const openLinkedAddon = null;
