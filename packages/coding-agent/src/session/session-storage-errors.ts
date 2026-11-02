/** Node-shaped `ENOENT` error for a missing path in an indexed session storage backend. */
export function enoent(p: string): NodeJS.ErrnoException {
	const err = new Error(`ENOENT: no such file, '${p}'`) as NodeJS.ErrnoException;
	err.code = "ENOENT";
	err.errno = -2;
	err.path = p;
	err.syscall = "open";
	return err;
}

/** Node-shaped `EEXIST` error for a destination path a refusing rename found taken. */
export function eexist(p: string): NodeJS.ErrnoException {
	const err = new Error(`EEXIST: file already exists, rename to '${p}'`) as NodeJS.ErrnoException;
	err.code = "EEXIST";
	err.errno = -17;
	err.path = p;
	err.syscall = "rename";
	return err;
}

/** Node-shaped `ENOTDIR` error for a regular file where a directory component is required. */
export function enotdir(p: string): NodeJS.ErrnoException {
	const err = new Error(`ENOTDIR: not a directory, open '${p}'`) as NodeJS.ErrnoException;
	err.code = "ENOTDIR";
	err.errno = -20;
	err.path = p;
	err.syscall = "open";
	return err;
}
