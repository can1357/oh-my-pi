//! The libm and libutil functions the linux-gnu addon calls, linked in.
//!
//! At the addon's glibc 2.17 floor these live outside `libc.so.6`. Defining
//! them here drops `libm.so.6` and `libutil.so.1` from its `DT_NEEDED`,
//! leaving only what 2.17 keeps out of reach: `libc.so.6`, `libpthread.so.0`,
//! `libdl.so.2` and the dynamic loader. The link binds every caller in the
//! addon to these (Rust, the C dependencies, omp-shell's `libc::openpty`),
//! and nothing in the host interposes on them at load time: `BUILD.bazel`'s
//! `:exports_map` keeps them local, and `build.rs`'s `-Bsymbolic` binds them
//! in cargo builds.
//!
//! The set is exactly what the addon references. `scripts/bazel-natives.ts`
//! rejects a glibc addon that needs any other library, so code that starts
//! calling another libm function fails the build until it is added here.

use std::ffi::{c_char, c_int};

/// Defines each C math function over its port in the `libm` crate.
macro_rules! c_math {
	($($name:ident($($arg:ident: $ty:ty),+) -> $ret:ty;)+) => {$(
		#[unsafe(no_mangle)]
		extern "C" fn $name($($arg: $ty),+) -> $ret {
			libm::$name($($arg),+)
		}
	)+};
}

c_math! {
	acos(x: f64) -> f64;
	acosf(x: f32) -> f32;
	acosh(x: f64) -> f64;
	asin(x: f64) -> f64;
	asinh(x: f64) -> f64;
	atan(x: f64) -> f64;
	atan2(y: f64, x: f64) -> f64;
	atan2f(y: f32, x: f32) -> f32;
	cos(x: f64) -> f64;
	cosf(x: f32) -> f32;
	cosh(x: f64) -> f64;
	exp(x: f64) -> f64;
	exp2(x: f64) -> f64;
	expf(x: f32) -> f32;
	expm1(x: f64) -> f64;
	hypot(x: f64, y: f64) -> f64;
	hypotf(x: f32, y: f32) -> f32;
	log(x: f64) -> f64;
	log10(x: f64) -> f64;
	log10f(x: f32) -> f32;
	log1p(x: f64) -> f64;
	log2(x: f64) -> f64;
	logf(x: f32) -> f32;
	pow(x: f64, y: f64) -> f64;
	powf(x: f32, y: f32) -> f32;
	sin(x: f64) -> f64;
	sinf(x: f32) -> f32;
	sinh(x: f64) -> f64;
	tan(x: f64) -> f64;
	tanf(x: f32) -> f32;
	tanh(x: f64) -> f64;
	tanhf(x: f32) -> f32;
}

/// GNU `sincos`, which LLVM emits for a `sin` and a `cos` of the same value.
///
/// # Safety
/// `sin` and `cos` must be valid for writes.
#[unsafe(no_mangle)]
unsafe extern "C" fn sincos(x: f64, sin: *mut f64, cos: *mut f64) {
	let (s, c) = libm::sincos(x);
	// SAFETY: the caller passes writable `sin` and `cos`.
	unsafe {
		sin.write(s);
		cos.write(c);
	}
}

/// `f32` [`sincos`].
///
/// # Safety
/// `sin` and `cos` must be valid for writes.
#[unsafe(no_mangle)]
unsafe extern "C" fn sincosf(x: f32, sin: *mut f32, cos: *mut f32) {
	let (s, c) = libm::sincosf(x);
	// SAFETY: the caller passes writable `sin` and `cos`.
	unsafe {
		sin.write(s);
		cos.write(c);
	}
}

/// `openpty(3)`, step for step as glibc 2.17's libutil implements it: errors
/// from applying `termp` and `winp` are ignored, and neither descriptor is
/// close-on-exec.
///
/// # Safety
/// `master` and `slave` must be valid for writes. `name`, when not null, must
/// have room for the slave's path (the C API leaves its size to the caller).
/// `termp` and `winp` must each be null or valid.
#[unsafe(no_mangle)]
unsafe extern "C" fn openpty(
	master: *mut c_int,
	slave: *mut c_int,
	name: *mut c_char,
	termp: *const libc::termios,
	winp: *const libc::winsize,
) -> c_int {
	// SAFETY: opens a new descriptor; no pointers involved.
	let m = unsafe { libc::posix_openpt(libc::O_RDWR | libc::O_NOCTTY) };
	if m < 0 {
		return -1;
	}
	let mut path = [0 as c_char; 64];
	// SAFETY: `m` is the master just opened, and `path` is writable for its
	// whole length, which `ptsname_r` writes a NUL-terminated name into.
	let s = unsafe {
		if libc::grantpt(m) != 0
			|| libc::unlockpt(m) != 0
			|| libc::ptsname_r(m, path.as_mut_ptr(), path.len()) != 0
		{
			-1
		} else {
			libc::open(path.as_ptr(), libc::O_RDWR | libc::O_NOCTTY)
		}
	};
	if s < 0 {
		// SAFETY: `m` is ours and handed out nowhere.
		unsafe { libc::close(m) };
		return -1;
	}
	// SAFETY: `s` is open, `termp` and `winp` are null or valid, `name` is
	// null or has room for `path`, and `master` and `slave` are writable, all
	// per the caller.
	unsafe {
		if !termp.is_null() {
			libc::tcsetattr(s, libc::TCSAFLUSH, termp);
		}
		if !winp.is_null() {
			libc::ioctl(s, libc::TIOCSWINSZ, winp);
		}
		if !name.is_null() {
			libc::strcpy(name, path.as_ptr());
		}
		master.write(m);
		slave.write(s);
	}
	0
}
