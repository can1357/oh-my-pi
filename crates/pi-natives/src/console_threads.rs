//! Thread starts that survive a stalled Windows console.
//!
//! When the terminal behind a console stops reading (a hung Windows Terminal,
//! a paused ssh client), conhost blocks on its full output pipe while holding
//! the console lock, and every console call from an attached process waits.
//! Every new thread makes one: `KernelBase`'s `DLL_THREAD_ATTACH` asks the
//! console for a language ID (`SetTEBLangID`). JSC starts its GC and JIT
//! helper threads lazily and waits for each one to come up, so a stalled
//! console froze the JS thread at its next collection, whether or not this
//! process was writing at the time.
//!
//! [`isolate_thread_starts_from_console`] marks `KernelBase`'s loader entry
//! `DontCallForThreads`. That is the flag `DisableThreadLibraryCalls` sets,
//! but the call silently skips `KernelBase`, whose `TlsIndex` is `0xFFFF`.
//! What `KernelBase` then stops doing per thread (Windows 10 19045):
//! - new threads don't adopt a console-specific UI language, which only matters
//!   on CJK console code pages;
//! - exiting threads leave their MUI language lists and NLS cache allocated
//!   (measured at about 67 bytes for a thread that used locale APIs) and their
//!   `HKEY_CLASSES_ROOT` enumeration state uncleared.

use napi_derive::napi;

/// Keep a stalled Windows console from blocking thread starts in this process.
///
/// Stops `KernelBase`'s per-thread console call, which JSC's lazily started
/// helper threads would otherwise wait on. Process-wide and permanent; repeat
/// calls are no-ops. Returns false, leaving the process untouched, when
/// `KernelBase`'s loader entry does not have the expected shape; always false
/// off Windows.
#[napi]
#[allow(clippy::missing_const_for_fn, reason = "napi macro is incompatible with const fn")]
pub fn isolate_thread_starts_from_console() -> bool {
	#[cfg(windows)]
	{
		sys::isolate()
	}
	#[cfg(not(windows))]
	{
		false
	}
}

#[cfg(windows)]
mod sys {
	use std::{
		ffi::c_void,
		sync::atomic::{AtomicU32, Ordering},
	};

	use windows_sys::{Win32::System::LibraryLoader::GetModuleHandleW, w};

	// `LDR_DATA_TABLE_ENTRY` fields, unchanged since Windows 8 on x64 and arm64.
	const DLL_BASE: usize = 0x30;
	const FLAGS: usize = 0x68;
	const TLS_INDEX: usize = 0x6e;
	/// `LDRP_DONT_CALL_FOR_THREADS`: `LdrpInitializeThread` skips the DLL.
	const DONT_CALL_FOR_THREADS: u32 = 0x4_0000;
	/// `ImageDll | ProcessAttachCalled`: a DLL that does receive thread calls.
	const ATTACHED_DLL: u32 = 0x8_0004;
	/// `KernelBase`'s `TlsIndex`, the value that makes
	/// `DisableThreadLibraryCalls` refuse it.
	const PINNED_TLS_INDEX: u16 = 0xffff;

	#[link(name = "ntdll")]
	unsafe extern "system" {
		fn LdrLockLoaderLock(flags: u32, disposition: *mut u32, cookie: *mut usize) -> i32;
		fn LdrUnlockLoaderLock(flags: u32, cookie: usize) -> i32;
		fn LdrFindEntryForAddress(address: *const c_void, entry: *mut *mut u8) -> i32;
	}

	pub(super) fn isolate() -> bool {
		// SAFETY: plain lookup of an always-loaded module.
		let kernelbase = unsafe { GetModuleHandleW(w!("kernelbase.dll")) };
		if kernelbase.is_null() {
			return false;
		}
		let mut cookie = 0;
		// The loader updates entry flags under this lock; flags 0 waits for it.
		// SAFETY: cookie is valid storage; the disposition is optional.
		if unsafe { LdrLockLoaderLock(0, std::ptr::null_mut(), &mut cookie) } < 0 {
			return false;
		}
		// SAFETY: the loader lock is held, so the entry cannot change or go away.
		let marked = unsafe { mark(kernelbase) };
		// SAFETY: releases the lock taken above with its cookie.
		unsafe { LdrUnlockLoaderLock(0, cookie) };
		marked
	}

	/// Set `DONT_CALL_FOR_THREADS` on `KernelBase`'s entry after checking that
	/// the entry is the one this module describes.
	///
	/// # Safety
	/// The caller holds the loader lock.
	unsafe fn mark(kernelbase: *mut c_void) -> bool {
		let mut entry = std::ptr::null_mut();
		// SAFETY: entry is valid storage for the found entry's address.
		if unsafe { LdrFindEntryForAddress(kernelbase, &mut entry) } < 0 || entry.is_null() {
			return false;
		}
		// SAFETY: entry points at a live LDR_DATA_TABLE_ENTRY, which spans the
		// offsets read here on every supported Windows version.
		let (base, tls_index) = unsafe {
			(
				entry.add(DLL_BASE).cast::<*mut c_void>().read(),
				entry.add(TLS_INDEX).cast::<u16>().read(),
			)
		};
		if base != kernelbase || tls_index != PINNED_TLS_INDEX {
			return false;
		}
		// SAFETY: the flags word is 4-byte aligned in the live entry.
		let flags = unsafe { AtomicU32::from_ptr(entry.add(FLAGS).cast()) };
		if flags.load(Ordering::Relaxed) & ATTACHED_DLL != ATTACHED_DLL {
			return false;
		}
		flags.fetch_or(DONT_CALL_FOR_THREADS, Ordering::Relaxed);
		true
	}
}
