//! Measured spawns (Linux): `time`'s programs run under a helper process,
//! so `wait4` reports the program's own peak resident set size.
//!
//! At `execve` the kernel folds the replaced address space's high-water
//! mark into the process's `ru_maxrss`, and no later exec lowers it. A child
//! spawned from the host execs from the host's address space (the spawn
//! path's vfork child shares it, a `fork` copies its resident pages), so its
//! peak is at least the host's. The helper is exec'd from the host and
//! keeps that figure for itself; it `vfork`s the program from its own
//! address space of a page or two, so the program is a new process whose
//! peak is its own. As GNU time does, it stays the program's parent: it
//! waits for it, hands its `rusage` to the spawner and exits as the program
//! did.
//!
//! The helper is raw-syscall machine code assembled into this library
//! ([`global_asm!`]; `x86_64` and `aarch64`), wrapped at runtime in a minimal
//! ELF image in a sealed memfd, and exec'd through `/proc/self/fd` by the
//! regular spawn path ([`launch`]), whose child sets the helper's OOM
//! adjustment before the exec, as for any external; the program inherits it.
//! Where the helper cannot run (no such architecture, no `/proc`, memfds
//! not executable, a seccomp policy refusing the exec) the program is
//! spawned directly, its peak then including the host's.
//!
//! **Protocol.** The spawner execs the helper with `time FD PATH ARGV...`
//! (`FD` in decimal), the program's environment, and the program's fds,
//! placement, mask and dispositions; `FD` is the write end of a pipe above
//! every fd of the program. The helper
//! 1. marks `FD` close-on-exec and blocks every signal but `SIGTSTP`, `SIGTTIN`
//!    and `SIGTTOU`;
//! 2. `vfork`s a child that unblocks every signal and execs `PATH` with `ARGV`,
//!    reporting a failed exec on a close-on-exec pipe;
//! 3. writes the exec's errno (0: the program runs) as a native `i32`, and
//!    closes every fd below `FD`, so the pipes the program holds end with it;
//! 4. waits for the program and writes its `struct rusage`;
//! 5. exits with the program's status, or dies of the signal that killed it
//!    (core dumps off: the program dumped already).
//!
//! The helper leads or joins the group the program would have and the
//! program shares it, so signals to the group reach the program itself; the
//! helper holds them blocked and reports once the program is gone. The
//! terminal stops it with the program, as they stop GNU time. Spawns that
//! signal the pid alone ([`super::Place::Inherit`]), ignore `SIGCHLD` (the
//! helper could not wait) or apply redirections in the child skip the
//! helper.

use std::{
	fs::File,
	io::{self, Read as _, Write as _},
	os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd},
	sync::LazyLock,
};

use bstr::BString;

use super::{Place, Program, Source, State, launch, reap};

/// Where the image loads; the code itself is position-independent.
const BASE: u64 = 0x40_0000;
/// ELF header and program header sizes (ELF64).
const EHDR: usize = 64;
const PHDR: usize = 56;
/// File offset of the code: after the header and the two program headers.
const CODE_AT: usize = EHDR + 2 * PHDR;

/// Bytes of the kernel's 64-bit `struct rusage`, which the helper writes
/// (step 4). libc's type starts with the same fields; musl appends a
/// reserved tail.
const RUSAGE: usize = 144;
const _: () =
	assert!(size_of::<libc::rusage>() >= RUSAGE, "libc's rusage starts with the kernel's");

#[cfg(target_arch = "x86_64")]
std::arch::global_asm!(
	".pushsection .rodata.omp_time_helper, \"a\"",
	".globl __omp_time_helper",
	".hidden __omp_time_helper",
	"__omp_time_helper:",
	// Frame (rbx): exec errno +0, signal set +8, wait status +16, rusage
	// +24, zeroed sigaction (SIG_DFL) +168, zeroed rlimit and empty signal
	// set +200, exec pipe +216.
	"mov r12, rsp",
	"and rsp, -16",
	"sub rsp, 224",
	"mov rbx, rsp",
	"mov rdi, rbx",
	"xor eax, eax",
	"mov ecx, 28",
	"rep stosq",
	// r13 = FD, parsed from argv[1].
	"mov rsi, [r12 + 16]",
	"xor r13d, r13d",
	".Lomp_parse:",
	"movzx eax, byte ptr [rsi]",
	"test eax, eax",
	"jz .Lomp_parsed",
	"sub eax, 48",
	"imul r13, r13, 10",
	"add r13, rax",
	"inc rsi",
	"jmp .Lomp_parse",
	".Lomp_parsed:",
	// fcntl(FD, F_SETFD, FD_CLOEXEC)
	"mov eax, 72",
	"mov rdi, r13",
	"mov esi, 2",
	"mov edx, 1",
	"syscall",
	// rt_sigprocmask(SIG_BLOCK, all but TSTP, TTIN, TTOU)
	"mov rax, 0xFFFFFFFFFFC7FFFF",
	"mov [rbx + 8], rax",
	"mov eax, 14",
	"xor edi, edi",
	"lea rsi, [rbx + 8]",
	"xor edx, edx",
	"mov r10d, 8",
	"syscall",
	// pipe2(&exec pipe, O_CLOEXEC): the child's exec closes it
	"mov eax, 293",
	"lea rdi, [rbx + 216]",
	"mov esi, 0x80000",
	"syscall",
	"test rax, rax",
	"js .Lomp_forkfail",
	// vfork
	"mov eax, 58",
	"syscall",
	"test rax, rax",
	"jz .Lomp_child",
	"js .Lomp_forkfail",
	"mov r14, rax",
	// close(write end); read(read end, errno, 4): end of file once the
	// program runs (an emulated vfork may not wait for the exec)
	"mov eax, 3",
	"mov edi, dword ptr [rbx + 220]",
	"syscall",
	"xor eax, eax",
	"mov edi, dword ptr [rbx + 216]",
	"mov rsi, rbx",
	"mov edx, 4",
	"syscall",
	// write(FD, errno, 4)
	"mov eax, 1",
	"mov rdi, r13",
	"mov rsi, rbx",
	"mov edx, 4",
	"syscall",
	// close every fd below FD
	"xor r15d, r15d",
	".Lomp_close:",
	"cmp r15, r13",
	"jae .Lomp_closed",
	"mov eax, 3",
	"mov rdi, r15",
	"syscall",
	"inc r15",
	"jmp .Lomp_close",
	".Lomp_closed:",
	"cmp dword ptr [rbx], 0",
	"jne .Lomp_reap",
	// wait4(pid, &status, 0, &rusage), again on EINTR
	".Lomp_wait:",
	"mov eax, 61",
	"mov rdi, r14",
	"lea rsi, [rbx + 16]",
	"xor edx, edx",
	"lea r10, [rbx + 24]",
	"syscall",
	"cmp rax, -4",
	"je .Lomp_wait",
	"cmp rax, r14",
	"jne .Lomp_fail",
	// write(FD, rusage, 144)
	"mov eax, 1",
	"mov rdi, r13",
	"lea rsi, [rbx + 24]",
	"mov edx, 144",
	"syscall",
	"mov eax, dword ptr [rbx + 16]",
	"mov r15d, eax",
	"and r15d, 0x7f",
	"jnz .Lomp_die",
	// exit_group(WEXITSTATUS)
	"shr eax, 8",
	"movzx edi, al",
	"mov eax, 231",
	"syscall",
	".Lomp_die:",
	// prlimit64(0, RLIMIT_CORE, {0, 0}, NULL)
	"mov eax, 302",
	"xor edi, edi",
	"mov esi, 4",
	"lea rdx, [rbx + 200]",
	"xor r10d, r10d",
	"syscall",
	// rt_sigaction(sig, SIG_DFL, NULL, 8)
	"mov eax, 13",
	"mov edi, r15d",
	"lea rsi, [rbx + 168]",
	"xor edx, edx",
	"mov r10d, 8",
	"syscall",
	// kill(getpid(), sig), then unblock it
	"mov eax, 39",
	"syscall",
	"mov rdi, rax",
	"mov esi, r15d",
	"mov eax, 62",
	"syscall",
	"lea ecx, [r15 - 1]",
	"mov eax, 1",
	"shl rax, cl",
	"mov [rbx + 8], rax",
	"mov eax, 14",
	"mov edi, 1",
	"lea rsi, [rbx + 8]",
	"xor edx, edx",
	"mov r10d, 8",
	"syscall",
	// Not a deadly signal after all: exit as a shell reports it.
	"lea edi, [r15 + 128]",
	"mov eax, 231",
	"syscall",
	".Lomp_forkfail:",
	"neg eax",
	"mov dword ptr [rbx], eax",
	"mov eax, 1",
	"mov rdi, r13",
	"mov rsi, rbx",
	"mov edx, 4",
	"syscall",
	".Lomp_fail:",
	"mov edi, 127",
	"mov eax, 231",
	"syscall",
	// The exec failed: reap the child, then fail.
	".Lomp_reap:",
	"mov eax, 61",
	"mov rdi, r14",
	"xor esi, esi",
	"xor edx, edx",
	"xor r10d, r10d",
	"syscall",
	"cmp rax, -4",
	"je .Lomp_reap",
	"jmp .Lomp_fail",
	// The vfork child: empty mask, execve(argv[2], &argv[3], envp); on
	// failure write the errno to the exec pipe.
	".Lomp_child:",
	"mov eax, 14",
	"mov edi, 2",
	"lea rsi, [rbx + 200]",
	"xor edx, edx",
	"mov r10d, 8",
	"syscall",
	"mov rdi, [r12 + 24]",
	"lea rsi, [r12 + 32]",
	"mov rax, [r12]",
	"lea rdx, [r12 + rax * 8 + 16]",
	"mov eax, 59",
	"syscall",
	"neg eax",
	"mov dword ptr [rbx], eax",
	"mov eax, 1",
	"mov edi, dword ptr [rbx + 220]",
	"mov rsi, rbx",
	"mov edx, 4",
	"syscall",
	"mov edi, 127",
	"mov eax, 60",
	"syscall",
	".globl __omp_time_helper_end",
	".hidden __omp_time_helper_end",
	"__omp_time_helper_end:",
	".popsection",
);

#[cfg(target_arch = "aarch64")]
std::arch::global_asm!(
	".pushsection .rodata.omp_time_helper, \"a\"",
	".globl __omp_time_helper",
	".hidden __omp_time_helper",
	"__omp_time_helper:",
	// x19 = argc's address; frame (x20) as on x86-64.
	"mov x19, sp",
	"sub sp, sp, #224",
	"mov x20, sp",
	"mov x0, x20",
	"mov x1, #28",
	".Lomp_zero:",
	"str xzr, [x0], #8",
	"subs x1, x1, #1",
	"b.ne .Lomp_zero",
	// x21 = FD, parsed from argv[1].
	"ldr x1, [x19, #16]",
	"mov x21, #0",
	"mov x3, #10",
	".Lomp_parse:",
	"ldrb w2, [x1], #1",
	"cbz w2, .Lomp_parsed",
	"sub w2, w2, #48",
	"madd x21, x21, x3, x2",
	"b .Lomp_parse",
	".Lomp_parsed:",
	// fcntl(FD, F_SETFD, FD_CLOEXEC)
	"mov x0, x21",
	"mov x1, #2",
	"mov x2, #1",
	"mov x8, #25",
	"svc #0",
	// rt_sigprocmask(SIG_BLOCK, all but TSTP, TTIN, TTOU)
	"movn x0, #0x38, lsl #16",
	"str x0, [x20, #8]",
	"mov x0, #0",
	"add x1, x20, #8",
	"mov x2, #0",
	"mov x3, #8",
	"mov x8, #135",
	"svc #0",
	// pipe2(&exec pipe, O_CLOEXEC): the child's exec closes it
	"add x0, x20, #216",
	"mov x1, #0x80000",
	"mov x8, #59",
	"svc #0",
	"tbnz x0, #63, .Lomp_forkfail",
	// clone(CLONE_VM | CLONE_VFORK | SIGCHLD, same stack): vfork
	"mov x0, #0x4111",
	"mov x1, #0",
	"mov x2, #0",
	"mov x3, #0",
	"mov x4, #0",
	"mov x8, #220",
	"svc #0",
	"cbz x0, .Lomp_child",
	"tbnz x0, #63, .Lomp_forkfail",
	"mov x22, x0",
	// close(write end); read(read end, errno, 4): end of file once the
	// program runs (an emulated vfork may not wait for the exec)
	"ldr w0, [x20, #220]",
	"mov x8, #57",
	"svc #0",
	"ldr w0, [x20, #216]",
	"mov x1, x20",
	"mov x2, #4",
	"mov x8, #63",
	"svc #0",
	// write(FD, errno, 4)
	"mov x0, x21",
	"mov x1, x20",
	"mov x2, #4",
	"mov x8, #64",
	"svc #0",
	// close every fd below FD
	"mov x23, #0",
	".Lomp_close:",
	"cmp x23, x21",
	"b.hs .Lomp_closed",
	"mov x0, x23",
	"mov x8, #57",
	"svc #0",
	"add x23, x23, #1",
	"b .Lomp_close",
	".Lomp_closed:",
	"ldr w0, [x20]",
	"cbnz w0, .Lomp_reap",
	// wait4(pid, &status, 0, &rusage), again on EINTR
	".Lomp_wait:",
	"mov x0, x22",
	"add x1, x20, #16",
	"mov x2, #0",
	"add x3, x20, #24",
	"mov x8, #260",
	"svc #0",
	"cmn x0, #4",
	"b.eq .Lomp_wait",
	"cmp x0, x22",
	"b.ne .Lomp_fail",
	// write(FD, rusage, 144)
	"mov x0, x21",
	"add x1, x20, #24",
	"mov x2, #144",
	"mov x8, #64",
	"svc #0",
	"ldr w0, [x20, #16]",
	"ands w1, w0, #0x7f",
	"b.ne .Lomp_die",
	// exit_group(WEXITSTATUS)
	"ubfx w0, w0, #8, #8",
	"mov x8, #94",
	"svc #0",
	".Lomp_die:",
	"mov w23, w1",
	// prlimit64(0, RLIMIT_CORE, {0, 0}, NULL)
	"mov x0, #0",
	"mov x1, #4",
	"add x2, x20, #200",
	"mov x3, #0",
	"mov x8, #261",
	"svc #0",
	// rt_sigaction(sig, SIG_DFL, NULL, 8)
	"mov x0, x23",
	"add x1, x20, #168",
	"mov x2, #0",
	"mov x3, #8",
	"mov x8, #134",
	"svc #0",
	// kill(getpid(), sig), then unblock it
	"mov x8, #172",
	"svc #0",
	"mov x1, x23",
	"mov x8, #129",
	"svc #0",
	"sub w2, w23, #1",
	"mov x0, #1",
	"lsl x0, x0, x2",
	"str x0, [x20, #8]",
	"mov x0, #1",
	"add x1, x20, #8",
	"mov x2, #0",
	"mov x3, #8",
	"mov x8, #135",
	"svc #0",
	// Not a deadly signal after all: exit as a shell reports it.
	"add x0, x23, #128",
	"mov x8, #94",
	"svc #0",
	".Lomp_forkfail:",
	"neg w0, w0",
	"str w0, [x20]",
	"mov x0, x21",
	"mov x1, x20",
	"mov x2, #4",
	"mov x8, #64",
	"svc #0",
	".Lomp_fail:",
	"mov x0, #127",
	"mov x8, #94",
	"svc #0",
	// The exec failed: reap the child, then fail.
	".Lomp_reap:",
	"mov x0, x22",
	"mov x1, #0",
	"mov x2, #0",
	"mov x3, #0",
	"mov x8, #260",
	"svc #0",
	"cmn x0, #4",
	"b.eq .Lomp_reap",
	"b .Lomp_fail",
	// The vfork child: empty mask, execve(argv[2], &argv[3], envp); on
	// failure write the errno to the exec pipe.
	".Lomp_child:",
	"mov x0, #2",
	"add x1, x20, #200",
	"mov x2, #0",
	"mov x3, #8",
	"mov x8, #135",
	"svc #0",
	"ldr x0, [x19, #24]",
	"add x1, x19, #32",
	"ldr x3, [x19]",
	"add x2, x19, x3, lsl #3",
	"add x2, x2, #16",
	"mov x8, #221",
	"svc #0",
	"neg w0, w0",
	"str w0, [x20]",
	"ldr w0, [x20, #220]",
	"mov x1, x20",
	"mov x2, #4",
	"mov x8, #64",
	"svc #0",
	"mov x0, #127",
	"mov x8, #93",
	"svc #0",
	".globl __omp_time_helper_end",
	".hidden __omp_time_helper_end",
	"__omp_time_helper_end:",
	".popsection",
);

/// The helper's machine code and its ELF machine number.
#[cfg(any(target_arch = "x86_64", target_arch = "aarch64"))]
#[allow(clippy::unnecessary_wraps, reason = "other architectures have no helper")]
fn code() -> Option<(&'static [u8], u16)> {
	unsafe extern "C" {
		static __omp_time_helper: u8;
		static __omp_time_helper_end: u8;
	}
	const MACHINE: u16 = if cfg!(target_arch = "x86_64") {
		62
	} else {
		183
	};
	let start = &raw const __omp_time_helper;
	let end = &raw const __omp_time_helper_end;
	// SAFETY: the two symbols delimit the helper's bytes, assembled into one
	// read-only data section above and never written.
	let code = unsafe { std::slice::from_raw_parts(start, end.addr() - start.addr()) };
	Some((code, MACHINE))
}

#[cfg(not(any(target_arch = "x86_64", target_arch = "aarch64")))]
const fn code() -> Option<(&'static [u8], u16)> {
	None
}

/// A static ELF64 executable of `code` for `machine`: one read-execute
/// segment, a non-executable stack, the entry at the code's start.
fn image(code: &[u8], machine: u16) -> Vec<u8> {
	let size = (CODE_AT + code.len()) as u64;
	let mut elf = Vec::with_capacity(CODE_AT + code.len());
	// 64-bit, little-endian, version 1, System V ABI.
	elf.extend_from_slice(b"\x7fELF\x02\x01\x01");
	elf.resize(16, 0);
	let header: [&[u8]; 13] = [
		&2u16.to_le_bytes(), // ET_EXEC
		&machine.to_le_bytes(),
		&1u32.to_le_bytes(),
		&(BASE + CODE_AT as u64).to_le_bytes(),
		&(EHDR as u64).to_le_bytes(),
		&0u64.to_le_bytes(), // no section headers
		&0u32.to_le_bytes(),
		&(EHDR as u16).to_le_bytes(),
		&(PHDR as u16).to_le_bytes(),
		&2u16.to_le_bytes(),
		&0u16.to_le_bytes(),
		&0u16.to_le_bytes(),
		&0u16.to_le_bytes(),
	];
	let load: [&[u8]; 8] = [
		&1u32.to_le_bytes(), // PT_LOAD
		&5u32.to_le_bytes(), // R | X
		&0u64.to_le_bytes(),
		&BASE.to_le_bytes(),
		&BASE.to_le_bytes(),
		&size.to_le_bytes(),
		&size.to_le_bytes(),
		&0x1_0000u64.to_le_bytes(),
	];
	let stack: [&[u8]; 8] = [
		&0x6474_e551u32.to_le_bytes(), // PT_GNU_STACK
		&6u32.to_le_bytes(),           // R | W
		&0u64.to_le_bytes(),
		&0u64.to_le_bytes(),
		&0u64.to_le_bytes(),
		&0u64.to_le_bytes(),
		&0u64.to_le_bytes(),
		&16u64.to_le_bytes(),
	];
	for field in header.iter().chain(&load).chain(&stack) {
		elf.extend_from_slice(field);
	}
	debug_assert_eq!(elf.len(), CODE_AT);
	elf.extend_from_slice(code);
	elf
}

/// The helper's executable: a sealed memfd, close-on-exec.
struct Helper {
	fd:   OwnedFd,
	/// `/proc/self/fd/N`: the exec path of `fd` in a child.
	path: Vec<u8>,
}

impl Helper {
	fn new() -> io::Result<Self> {
		let (code, machine) = code().ok_or(io::ErrorKind::Unsupported)?;
		let sealed = libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING;
		// SAFETY: the name is NUL-terminated; the result is checked.
		let mut fd = unsafe {
			libc::syscall(libc::SYS_memfd_create, c"time".as_ptr(), sealed | libc::MFD_EXEC)
		};
		if fd < 0 && io::Error::last_os_error().raw_os_error() == Some(libc::EINVAL) {
			// Before Linux 6.3 there is no MFD_EXEC: memfds are executable.
			// SAFETY: as above.
			fd = unsafe { libc::syscall(libc::SYS_memfd_create, c"time".as_ptr(), sealed) };
		}
		let fd = RawFd::try_from(fd)
			.ok()
			.filter(|&fd| fd >= 0)
			.ok_or_else(io::Error::last_os_error)?;
		// SAFETY: a successful memfd_create returned a descriptor we own.
		let fd = unsafe { OwnedFd::from_raw_fd(fd) };
		File::from(fd.try_clone()?).write_all(&image(code, machine))?;
		let seals = libc::F_SEAL_SEAL | libc::F_SEAL_SHRINK | libc::F_SEAL_GROW | libc::F_SEAL_WRITE;
		// SAFETY: fcntl on a descriptor we own, without pointer arguments.
		if unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_ADD_SEALS, seals) } != 0 {
			return Err(io::Error::last_os_error());
		}
		let path = format!("/proc/self/fd/{}", fd.as_raw_fd()).into_bytes();
		Ok(Self { fd, path })
	}
}

/// The helper of this process; `None` where it cannot be built.
static HELPER: LazyLock<Option<Helper>> = LazyLock::new(|| Helper::new().ok());

/// A measured spawn's pipe from the helper.
pub(super) struct Report {
	reader: File,
	/// `FD`: where the write end goes in the helper.
	target: i32,
}

impl Report {
	/// Add the write end of the helper's pipe to `fds` (last, above every
	/// target), unless the helper is unavailable.
	pub(super) fn attach(fds: &mut Vec<(i32, Source)>) -> Option<Self> {
		let helper = HELPER.as_ref()?.fd.as_raw_fd();
		// The child would replace the helper's image before execing it.
		if fds.iter().any(|(t, _)| *t == helper) {
			return None;
		}
		let mut ends = [0; 2];
		// SAFETY: `ends` is a writable array of two descriptors.
		if unsafe { libc::pipe2(ends.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
			return None;
		}
		// SAFETY: a successful pipe2 returned two descriptors we own.
		let (reader, writer) =
			unsafe { (OwnedFd::from_raw_fd(ends[0]), OwnedFd::from_raw_fd(ends[1])) };
		let mut target = fds.iter().map(|(t, _)| *t).max().unwrap_or(2).max(2) + 1;
		if target == helper {
			target += 1;
		}
		fds.push((target, Source::Owned(writer)));
		Some(Self { reader: reader.into(), target })
	}

	/// Spawn `prog` under the helper with `fds` (the write end last, taken
	/// out once the helper runs); the pid and placement of the helper and
	/// the pipe to read its `rusage` from after the exit. When the helper
	/// did not exec (it cannot be exec'd, or a step before its exec failed),
	/// `direct` spawns the program with its own fds instead, without a pipe;
	/// a spawn that failed after the helper exec'd fails with that error, the
	/// program never started twice ([`super::vfork::program_ran`]). A program
	/// the helper failed to exec fails the spawn with the exec's error, as a
	/// direct spawn would.
	pub(super) fn launch(
		self,
		state: &State,
		prog: &Program<'_>,
		fds: &mut Vec<(i32, Source)>,
		place: Place,
		direct: impl FnOnce(&[(i32, Source)]) -> io::Result<(i32, Place)>,
	) -> (io::Result<(i32, Place)>, Option<File>) {
		let Some(helper) = HELPER.as_ref() else {
			fds.pop();
			return (direct(fds), None);
		};
		let mut argv = Vec::with_capacity(prog.argv.len() + 3);
		argv.extend([
			BString::from("time"),
			BString::from(self.target.to_string()),
			BString::from(prog.path),
		]);
		argv.extend_from_slice(prog.argv);
		let wrapped = Program { path: &helper.path, argv: &argv, ..*prog };
		let launched = launch(state, &wrapped, fds, place);
		// Only the helper holds the write end now: its exit ends the pipe.
		fds.pop();
		let (pid, place) = match launched {
			Ok(launched) => launched,
			// The helper exec'd: it may have started the program.
			Err(err) if super::vfork::program_ran(&err) => return (Err(err), None),
			Err(_) => return (direct(fds), None),
		};
		let mut errno = [0; 4];
		// End of file: the helper died before the exec; its status tells.
		if (&self.reader).read_exact(&mut errno).is_ok() {
			let errno = i32::from_ne_bytes(errno);
			if errno != 0 {
				reap(pid);
				return (Err(io::Error::from_raw_os_error(errno)), None);
			}
		}
		(Ok((pid, place)), Some(self.reader))
	}
}

/// The program's `rusage` the helper reported through `reader` before it
/// exited; `None` when it ended before the program did.
pub(super) fn usage(mut reader: File) -> Option<libc::rusage> {
	let mut raw = [0u8; size_of::<libc::rusage>()];
	reader.read_exact(&mut raw[..RUSAGE]).ok()?;
	// SAFETY: `raw` starts with the kernel's `struct rusage`, the prefix
	// libc's type shares; any tail (musl's reserved fields) stays zero. Plain
	// data.
	Some(unsafe { raw.as_ptr().cast::<libc::rusage>().read_unaligned() })
}
