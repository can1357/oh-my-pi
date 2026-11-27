/**
 * Shared pieces of the remote mirror-edit contract ({@link RemoteEditHooks}):
 * the errors `edit` turns into model-facing refusals, and the POSIX `cksum`
 * checksum handlers use to detect a remote file that changed after it was fetched.
 */

/** The remote file changed between the edit's fetch and its write; nothing was written. */
export class RemoteEditConflictError extends Error {
	constructor(readonly url: string) {
		super(`${url} changed on the remote host after this edit fetched it; nothing was written.`);
		this.name = "RemoteEditConflictError";
	}
}

/** Nothing exists at the remote path; mirror edits only update existing files. */
export class RemoteEditMissingError extends Error {
	constructor(readonly url: string) {
		super(`${url} does not exist`);
		this.name = "RemoteEditMissingError";
	}
}

const CKSUM_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let byte = 0; byte < 256; byte++) {
		let crc = byte << 24;
		for (let bit = 0; bit < 8; bit++) crc = crc & 0x80000000 ? (crc << 1) ^ 0x04c11db7 : crc << 1;
		table[byte] = crc >>> 0;
	}
	return table;
})();

/**
 * POSIX `cksum` of `bytes` as the utility prints it for stdin: `"<crc> <size>"`.
 * Remote hosts recompute it with `cksum`, which every POSIX system ships.
 */
export function posixCksum(bytes: Uint8Array): string {
	let crc = 0;
	const step = (byte: number) => {
		crc = ((crc << 8) ^ CKSUM_TABLE[((crc >>> 24) ^ byte) & 0xff]) >>> 0;
	};
	for (const byte of bytes) step(byte);
	for (let length = bytes.length; length > 0; length = Math.floor(length / 256)) step(length & 0xff);
	return `${~crc >>> 0} ${bytes.length}`;
}
