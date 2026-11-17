//! Moves Bun's SQLite record locks onto open-file-description locks (Linux).
//!
//! A POSIX record lock belongs to the process, so closing *any* descriptor of
//! the file releases it — including closes the addon cannot see: Bun's own file
//! APIs close with raw syscalls, and extension or eval code runs through them.
//! An open-file-description (OFD) lock belongs to one open file description and
//! survives every other close. OFD and POSIX locks conflict with each other, so
//! omp processes on either kind still exclude one another.
//!
//! SQLite's unix VFS calls `fcntl` and `close` through its `aSyscall` table,
//! the table `xSetSystemCall` overrides. Bun links SQLite statically and
//! exports no `sqlite3_*` symbol, so [`install`] finds the table in Bun's
//! writable segments by its fixed name sequence and points its `fcntl` and
//! `close` entries here:
//!
//! - Every lock request on a descriptor is applied, as the matching `F_OFD_*`
//!   command, to one private descriptor of the same inode (`/proc/self/fd`
//!   reopened). One open file description per inode keeps POSIX's per-process
//!   semantics inside omp: locks taken through one connection's descriptor and
//!   released through another's are the same locks, and the process never
//!   conflicts with itself.
//! - SQLite's closes are counted per inode; the private descriptor closes with
//!   the last descriptor SQLite took a lock through, releasing what that close
//!   would have released under POSIX (the WAL-index `DMS` lock, notably).
//! - An inode the process already holds POSIX locks on (a connection opened
//!   before [`install`]) keeps using POSIX locks, since its own OFD requests
//!   would conflict with them.

use std::{
	collections::HashMap,
	ffi::{CStr, c_char, c_int, c_void},
	mem::MaybeUninit,
	sync::{
		LazyLock,
		atomic::{AtomicPtr, Ordering},
	},
};

use parking_lot::Mutex;

/// The leading names of SQLite's `aSyscall` table, in its fixed order.
const TABLE_NAMES: [&[u8]; 8] =
	[b"open", b"close", b"access", b"getcwd", b"stat", b"fstat", b"ftruncate", b"fcntl"];
const CLOSE_INDEX: usize = 1;
const FCNTL_INDEX: usize = 7;

/// `struct unix_syscall { const char *zName; sqlite3_syscall_ptr pCurrent,
/// pDefault; }`.
#[repr(C)]
struct SyscallEntry {
	name:    *const c_char,
	current: AtomicPtr<c_void>,
	default: AtomicPtr<c_void>,
}

type FcntlFn = unsafe extern "C" fn(c_int, c_int, ...) -> c_int;
type CloseFn = unsafe extern "C" fn(c_int) -> c_int;

static REAL_FCNTL: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());
static REAL_CLOSE: AtomicPtr<c_void> = AtomicPtr::new(std::ptr::null_mut());

#[derive(Clone, Copy, PartialEq, Eq, Hash)]
struct Inode {
	dev: u64,
	ino: u64,
}

struct Locks {
	/// The private descriptor the inode's locks live on; `-1` for an inode
	/// left on POSIX locks.
	lock_fd: c_int,
	/// SQLite's descriptors of the inode that have issued lock requests.
	users:   Vec<c_int>,
}

static INODES: LazyLock<Mutex<HashMap<Inode, Locks>>> =
	LazyLock::new(|| Mutex::new(HashMap::new()));

/// A readable mapping of this process, from `/proc/self/maps`.
struct Mapping {
	start:    usize,
	end:      usize,
	writable: bool,
	path:     String,
}

fn mappings() -> Vec<Mapping> {
	let Ok(maps) = std::fs::read_to_string("/proc/self/maps") else {
		return Vec::new();
	};
	maps
		.lines()
		.filter_map(|line| {
			let mut fields = line.split_whitespace();
			let (range, perms) = (fields.next()?, fields.next()?);
			let path = fields.nth(3).unwrap_or("").to_owned();
			let (start, end) = range.split_once('-')?;
			let perms = perms.as_bytes();
			if perms.first() != Some(&b'r') {
				return None;
			}
			Some(Mapping {
				start: usize::from_str_radix(start, 16).ok()?,
				end: usize::from_str_radix(end, 16).ok()?,
				writable: perms.get(1) == Some(&b'w'),
				path,
			})
		})
		.collect()
}

/// The NUL-terminated string at `address`, when it lies inside a readable
/// mapping of the executable.
fn name_at(address: usize, exe: &[Mapping]) -> Option<&'static [u8]> {
	let mapping = exe.iter().find(|m| m.start <= address && address < m.end)?;
	let available = mapping.end - address;
	// SAFETY: `address..mapping.end` is mapped readable for the process
	// lifetime.
	let bytes = unsafe { std::slice::from_raw_parts(address as *const u8, available.min(32)) };
	Some(CStr::from_bytes_until_nul(bytes).ok()?.to_bytes())
}

/// SQLite's `aSyscall` table inside the executable (Bun), found by its names.
fn find_table() -> Option<&'static [SyscallEntry]> {
	let maps = mappings();
	let exe_path = std::fs::read_link("/proc/self/exe")
		.ok()?
		.to_string_lossy()
		.into_owned();
	let exe: Vec<Mapping> = maps.into_iter().filter(|m| m.path == exe_path).collect();
	const STRIDE: usize = size_of::<SyscallEntry>();
	for mapping in exe.iter().filter(|m| m.writable) {
		let mut at = mapping.start;
		while at + STRIDE * TABLE_NAMES.len() <= mapping.end {
			// SAFETY: `at` is 8-aligned inside a readable mapping.
			let first = unsafe { *(at as *const usize) };
			if name_at(first, &exe) == Some(TABLE_NAMES[0])
				&& TABLE_NAMES.iter().enumerate().all(|(index, name)| {
					// SAFETY: every entry checked lies inside the mapping (loop
					// bound).
					let pointer = unsafe { *((at + index * STRIDE) as *const usize) };
					name_at(pointer, &exe) == Some(name)
				}) {
				// SAFETY: the names match SQLite's table layout; entries stay
				// mapped.
				return Some(unsafe {
					std::slice::from_raw_parts(at as *const SyscallEntry, TABLE_NAMES.len())
				});
			}
			at += size_of::<usize>();
		}
	}
	None
}

fn real_fcntl(fd: c_int, cmd: c_int, arg: usize) -> c_int {
	// SAFETY: set from SQLite's table before any call can reach here.
	let real: FcntlFn = unsafe { std::mem::transmute(REAL_FCNTL.load(Ordering::Acquire)) };
	// SAFETY: forwards the caller's arguments unchanged.
	unsafe { real(fd, cmd, arg) }
}

fn real_close(fd: c_int) -> c_int {
	// SAFETY: set from SQLite's table before any call can reach here.
	let real: CloseFn = unsafe { std::mem::transmute(REAL_CLOSE.load(Ordering::Acquire)) };
	// SAFETY: closing a descriptor number has no memory-safety requirement.
	unsafe { real(fd) }
}

fn inode_of(fd: c_int) -> Option<Inode> {
	let mut stat = MaybeUninit::<libc::stat>::uninit();
	// SAFETY: `stat` is valid for writes of one `struct stat`.
	if unsafe { libc::fstat(fd, stat.as_mut_ptr()) } != 0 {
		return None;
	}
	// SAFETY: a successful `fstat` filled `stat`.
	let stat = unsafe { stat.assume_init() };
	Some(Inode { dev: stat.st_dev, ino: stat.st_ino })
}

/// Whether this process holds a POSIX lock on `inode` (`/proc/locks`).
fn holds_posix_lock(inode: Inode) -> bool {
	let Ok(locks) = std::fs::read_to_string("/proc/locks") else {
		return false;
	};
	let pid = std::process::id().to_string();
	let (major, minor) = (libc::major(inode.dev), libc::minor(inode.dev));
	let device = format!("{major:02x}:{minor:02x}:{}", inode.ino);
	locks.lines().any(|line| {
		let fields: Vec<&str> = line.split_whitespace().filter(|f| *f != "->").collect();
		fields.get(1) == Some(&"POSIX")
			&& fields.get(4) == Some(&pid.as_str())
			&& fields.get(5) == Some(&device.as_str())
	})
}

/// A private descriptor of `fd`'s inode: its own open file description.
fn reopen(fd: c_int) -> c_int {
	let path = std::ffi::CString::new(format!("/proc/self/fd/{fd}")).expect("no NUL");
	for mode in [libc::O_RDWR, libc::O_RDONLY] {
		// SAFETY: `path` is NUL-terminated.
		let reopened = unsafe { libc::open(path.as_ptr(), mode | libc::O_CLOEXEC) };
		if reopened >= 0 {
			return reopened;
		}
	}
	-1
}

/// SQLite's `fcntl`, with record-lock requests moved onto the inode's private
/// open file description.
extern "C" fn ofd_fcntl(fd: c_int, cmd: c_int, arg: usize) -> c_int {
	let ofd_cmd = match cmd {
		libc::F_GETLK => libc::F_OFD_GETLK,
		libc::F_SETLK => libc::F_OFD_SETLK,
		libc::F_SETLKW => libc::F_OFD_SETLKW,
		_ => return real_fcntl(fd, cmd, arg),
	};
	let Some(inode) = inode_of(fd) else {
		return real_fcntl(fd, cmd, arg);
	};
	let lock_fd = {
		let mut inodes = INODES.lock();
		let locks = inodes.entry(inode).or_insert_with(|| Locks {
			lock_fd: if holds_posix_lock(inode) {
				-1
			} else {
				reopen(fd)
			},
			users:   Vec::new(),
		});
		if !locks.users.contains(&fd) {
			locks.users.push(fd);
		}
		locks.lock_fd
	};
	if lock_fd < 0 {
		return real_fcntl(fd, cmd, arg);
	}
	let request = arg as *mut libc::flock;
	// SAFETY: SQLite passes a valid `struct flock` for lock commands.
	let mut probe = unsafe { request.read() };
	// OFD requests require `l_pid == 0`; SQLite leaves it unset.
	probe.l_pid = 0;
	let result = real_fcntl(lock_fd, ofd_cmd, std::ptr::from_mut(&mut probe) as usize);
	if result == 0 && cmd == libc::F_GETLK {
		// SAFETY: as above; `F_GETLK` reports back through the caller's struct.
		unsafe { request.write(probe) };
	}
	result
}

/// SQLite's `close`: the inode's private descriptor closes with the last
/// descriptor SQLite locked through, releasing its locks as POSIX would.
extern "C" fn ofd_close(fd: c_int) -> c_int {
	let released = {
		let mut inodes = INODES.lock();
		let mut released = None;
		inodes.retain(|_, locks| {
			let Some(position) = locks.users.iter().position(|&user| user == fd) else {
				return true;
			};
			locks.users.swap_remove(position);
			if locks.users.is_empty() {
				released = Some(locks.lock_fd);
				return false;
			}
			true
		});
		released
	};
	let result = real_close(fd);
	if let Some(lock_fd) = released.filter(|&lock_fd| lock_fd >= 0) {
		real_close(lock_fd);
	}
	result
}

/// Points SQLite's `fcntl` and `close` at the OFD shims; `false` when Bun's
/// SQLite table is not found (the process keeps POSIX locks). Idempotent.
pub fn install() -> bool {
	static INSTALLED: LazyLock<bool> = LazyLock::new(|| {
		let Some(table) = find_table() else {
			return false;
		};
		let (close, fcntl) = (&table[CLOSE_INDEX], &table[FCNTL_INDEX]);
		REAL_CLOSE.store(close.current.load(Ordering::Acquire), Ordering::Release);
		REAL_FCNTL.store(fcntl.current.load(Ordering::Acquire), Ordering::Release);
		if REAL_CLOSE.load(Ordering::Acquire).is_null()
			|| REAL_FCNTL.load(Ordering::Acquire).is_null()
		{
			return false;
		}
		// `xSetSystemCall` keeps the original in `pDefault` on first override.
		for entry in [close, fcntl] {
			let _ = entry.default.compare_exchange(
				std::ptr::null_mut(),
				entry.current.load(Ordering::Acquire),
				Ordering::AcqRel,
				Ordering::Acquire,
			);
		}
		fcntl
			.current
			.store(ofd_fcntl as *mut c_void, Ordering::Release);
		close
			.current
			.store(ofd_close as *mut c_void, Ordering::Release);
		true
	});
	*INSTALLED
}
