// A readonly bind mount does not prevent connecting to a host pathname Unix socket.
// Keep guest-local stream socketpairs for runtime IPC, but prohibit sockets, connects,
// datagram socketpairs, and io_uring (which can otherwise issue socket operations).
let cachedPolicy: Buffer | undefined;

export function readonlySeccompPolicy(): Buffer {
	if (cachedPolicy) return cachedPolicy;
	const arch = process.arch;
	if (arch !== "x64" && arch !== "arm64") throw new Error("READONLY_SANDBOX_ARCH_UNSUPPORTED");
	const auditArch = arch === "x64" ? 0xc000003e : 0xc00000b7;
	const socket = arch === "x64" ? 41 : 198;
	const connect = arch === "x64" ? 42 : 203;
	const socketpair = arch === "x64" ? 53 : 199;
	const deny = 0x00050001; // SECCOMP_RET_ERRNO | EPERM
	const allow = 0x7fff0000;
	const instructions: readonly (readonly [number, number, number, number])[] = [
		[0x20, 0, 0, 4], // seccomp_data.arch
		[0x15, 1, 0, auditArch],
		[0x06, 0, 0, 0x80000000], // unknown ABI: KILL_PROCESS
		[0x20, 0, 0, 0], // seccomp_data.nr
		[0x35, 0, 1, 0x40000000], // reject x32 syscall aliases and invalid negative numbers
		[0x06, 0, 0, deny],
		[0x15, 0, 1, socket],
		[0x06, 0, 0, deny],
		[0x15, 0, 1, connect],
		[0x06, 0, 0, deny],
		[0x15, 0, 1, 425], // io_uring_setup, both supported Linux ABIs
		[0x06, 0, 0, deny],
		[0x15, 0, 4, socketpair],
		[0x20, 0, 0, 24], // args[1]: socketpair type (strip CLOEXEC/NONBLOCK)
		[0x54, 0, 0, 0x0f],
		[0x15, 1, 0, 1], // SOCK_STREAM only; cannot address a different endpoint
		[0x06, 0, 0, deny],
		[0x06, 0, 0, allow],
	];
	const bytes = Buffer.alloc(instructions.length * 8);
	for (let i = 0; i < instructions.length; i++) {
		const [code, jt, jf, k] = instructions[i];
		bytes.writeUInt16LE(code, i * 8);
		bytes[i * 8 + 2] = jt;
		bytes[i * 8 + 3] = jf;
		bytes.writeUInt32LE(k, i * 8 + 4);
	}
	cachedPolicy = bytes;
	return bytes;
}
