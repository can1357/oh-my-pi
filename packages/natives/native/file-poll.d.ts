/**
 * Stat-poll `file` every `intervalMs`; `onChange` runs when its mtime, size or
 * inode changes, including when it appears or disappears. Returns a disposer.
 *
 * Each tick re-resolves the path, so atomic rename-over saves, symlink
 * retargets and missing parents never silence it, unlike `fs.watch`. The poll
 * never keeps the process alive. Used by config and theme live reload.
 */
export declare function pollFile(file: string, onChange: () => void, intervalMs: number): () => void;
