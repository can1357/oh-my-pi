/** Expand Windows 8.3 components without resolving symlinks or junctions. Load the addon only on Windows. */
export declare function expandWindowsLongPath(path: string): string;

/** Get the existing Windows 8.3 spelling. Load the addon only on Windows; preserve paths on other platforms. */
export declare function getWindowsShortPath(path: string): string;
