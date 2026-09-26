//! Classifies target processes whose input stack cannot honour a particular
//! background delivery route, so the route can refuse instead of reporting a
//! silent drop as success.

use std::{
	ffi::{CStr, OsStr},
	mem,
	os::unix::ffi::OsStrExt,
	path::Path,
};

use objc2_app_kit::NSRunningApplication;
use objc2_foundation::ns_string;

/// `proc_pidinfo` flavor for file-backed regions only
/// (`PROC_PIDREGIONPATHINFO2`, private in `<sys/proc_info_private.h>`); skips
/// anonymous memory.
const PROC_PIDREGIONPATHINFO2: libc::c_int = 22;
/// Public `proc_pidinfo` flavor that walks every region.
const PROC_PIDREGIONPATHINFO: libc::c_int = 8;
/// Bounds the region walk so a pathological address space cannot stall input.
const MAX_REGIONS: usize = 65_536;

/// `struct proc_regioninfo` from `<sys/proc_info.h>`.
#[repr(C)]
struct ProcRegionInfo {
	protection:               u32,
	max_protection:           u32,
	inheritance:              u32,
	flags:                    u32,
	offset:                   u64,
	behavior:                 u32,
	user_wired_count:         u32,
	user_tag:                 u32,
	pages_resident:           u32,
	pages_shared_now_private: u32,
	pages_swapped_out:        u32,
	pages_dirtied:            u32,
	ref_count:                u32,
	shadow_depth:             u32,
	share_mode:               u32,
	private_pages_resident:   u32,
	shared_pages_resident:    u32,
	obj_id:                   u32,
	depth:                    u32,
	address:                  u64,
	size:                     u64,
}

/// `struct proc_regionwithpathinfo`: region info followed by
/// `struct vnode_info_path` (152-byte `vnode_info`, then a `MAXPATHLEN` path).
#[repr(C)]
struct ProcRegionWithPathInfo {
	region:     ProcRegionInfo,
	vnode_info: [u8; 152],
	path:       [libc::c_char; 1024],
}

/// Whether `pid` maps the Tk toolkit.
///
/// Tk's macOS backend translates every mouse event through the global
/// hardware pointer position rather than the event's own location, so a
/// pid-routed background click lands wherever the user's pointer happens to
/// be. Detection walks the target's file-backed regions (same-user, no task
/// port); a Tk image loaded only from the dyld shared cache is invisible here
/// and falls through to ordinary delivery.
pub(super) fn reads_hardware_pointer(pid: libc::pid_t) -> bool {
	walk_regions(pid, PROC_PIDREGIONPATHINFO2)
		.or_else(|| walk_regions(pid, PROC_PIDREGIONPATHINFO))
		.unwrap_or(false)
}

/// Walks `pid`'s mapped regions with `flavor`. `None` means the kernel
/// rejected the flavor before any region was read.
fn walk_regions(pid: libc::pid_t, flavor: libc::c_int) -> Option<bool> {
	let size = mem::size_of::<ProcRegionWithPathInfo>();
	let size_arg = libc::c_int::try_from(size).ok()?;
	let mut address = 0u64;
	let mut read_any = false;
	for _ in 0..MAX_REGIONS {
		// SAFETY: An all-zero bit pattern is valid for this plain C struct.
		let mut info: ProcRegionWithPathInfo = unsafe { mem::zeroed() };
		// SAFETY: The buffer is exactly the kernel structure size and outlives the
		// synchronous call.
		let written =
			unsafe { libc::proc_pidinfo(pid, flavor, address, (&raw mut info).cast(), size_arg) };
		if !usize::try_from(written).is_ok_and(|written| written >= size) {
			break;
		}
		read_any = true;
		// SAFETY: The kernel NUL-terminates `path` within its MAXPATHLEN buffer.
		let path = unsafe { CStr::from_ptr(info.path.as_ptr()) };
		if is_tk_image(&path.to_string_lossy()) {
			return Some(true);
		}
		let next = info.region.address.saturating_add(info.region.size);
		if next <= address {
			break;
		}
		address = next;
	}
	read_any.then_some(false)
}

/// Matches `Tk.framework` bundles, Tk shared libraries (`libtk8.6.dylib`, Tk
/// 9's `libtcl9tk9.0.dylib`), and Python's `_tkinter` extension, which links
/// or embeds Tk.
fn is_tk_image(path: &str) -> bool {
	if path.contains("/Tk.framework/") {
		return true;
	}
	let file = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
	if file
		.strip_suffix(".so")
		.is_some_and(|stem| stem.starts_with("_tkinter"))
	{
		return true;
	}
	let Some(stem) = file
		.strip_suffix(".dylib")
		.and_then(|file| file.strip_prefix("lib"))
	else {
		return false;
	};
	let stem = match stem.strip_prefix("tcl") {
		Some(after_tcl) => {
			let digits = after_tcl.bytes().take_while(u8::is_ascii_digit).count();
			if digits == 0 {
				return false;
			}
			&after_tcl[digits..]
		},
		None => stem,
	};
	stem
		.strip_prefix("tk")
		.and_then(|version| version.bytes().next())
		.is_some_and(|byte| byte.is_ascii_digit())
}

/// Whether `pid` runs inside an Electron app bundle, whose renderer drops
/// pid-routed wheel events while its window is in the background.
pub(super) fn is_electron(pid: libc::pid_t) -> bool {
	let mut buffer = [0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
	let Ok(capacity) = u32::try_from(buffer.len()) else {
		return false;
	};
	// SAFETY: `buffer` is writable for `capacity` bytes for the synchronous call.
	let length = unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), capacity) };
	let Ok(length) = usize::try_from(length) else {
		return false;
	};
	let Some(executable) = buffer.get(..length) else {
		return false;
	};
	// `<App>.app/Contents/MacOS/<exe>` ships its runtime beside it in
	// `<App>.app/Contents/Frameworks`.
	Path::new(OsStr::from_bytes(executable))
		.parent()
		.and_then(Path::parent)
		.is_some_and(|contents| {
			contents
				.join("Frameworks/Electron Framework.framework")
				.exists()
		})
}

/// Use process identity, not a substring of the display name ("Arc" also
/// matches Archive Utility). Electron applications have arbitrary bundle ids.
pub(super) fn is_chromium(pid: libc::pid_t) -> bool {
	is_electron(pid)
		|| NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
			.and_then(|app| app.bundleIdentifier())
			.is_some_and(|bundle| is_chromium_bundle(&bundle.to_string()))
}

fn is_chromium_bundle(bundle: &str) -> bool {
	[
		"com.google.Chrome",
		"org.chromium.Chromium",
		"com.brave.Browser",
		"com.microsoft.edgemac",
		"company.thebrowser.Browser",
		"com.vivaldi.Vivaldi",
		"com.operasoftware.Opera",
	]
	.iter()
	.any(|base| bundle == *base || bundle.strip_prefix(*base).is_some_and(|suffix| suffix.starts_with('.')))
}

/// Whether `pid` is Apple's Screen Sharing client.
///
/// Screen Sharing forwards physical virtual-key transitions to the remote
/// host: it ignores the Unicode payload of synthesized keycode-0 events (the
/// guest sees a stream of `a`) and drops modifier flags on pid-routed chords.
pub(super) fn is_screen_sharing(pid: libc::pid_t) -> bool {
	NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
		.and_then(|app| app.bundleIdentifier())
		.is_some_and(|bundle| bundle.isEqualToString(ns_string!("com.apple.ScreenSharing")))
}

/// Terminal AX text areas represent a rendered grid, not the pty input. Even a
/// successful AXSelectedText/AXValue write is not proof that the shell received it.
pub(super) fn is_terminal(pid: libc::pid_t) -> bool {
	NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
		.and_then(|app| app.bundleIdentifier())
		.is_some_and(|bundle| matches!(
			bundle.to_string().as_str(),
			"co.zeit.hyper"
				| "com.apple.Terminal"
				| "com.github.wez.wezterm"
				| "com.googlecode.iterm2"
				| "com.mitchellh.ghostty"
				| "dev.warp.Warp-Stable"
				| "dev.zed.Zed.Helper"
				| "io.alacritty"
				| "net.kovidgoyal.kitty"
				| "org.alacritty"
		))
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn tk_images_match_and_neighbours_do_not() {
		for path in [
			"/Library/Frameworks/Tk.framework/Versions/8.6/Tk",
			"/opt/homebrew/Cellar/tcl-tk/9.0.2/lib/libtcl9tk9.0.dylib",
			"/opt/homebrew/opt/tcl-tk@8/lib/libtk8.6.dylib",
			"/usr/local/lib/python3.12/lib-dynload/_tkinter.cpython-312-darwin.so",
		] {
			assert!(is_tk_image(path), "{path}");
		}
		for path in [
			"",
			"/opt/homebrew/lib/libtcl9.0.dylib",
			"/opt/homebrew/lib/libtkrzw.dylib",
			"/System/Library/Frameworks/AppKit.framework/Versions/C/AppKit",
			"/usr/lib/python3/_tkinter_helper.py",
			"/Applications/Foo.app/Contents/MacOS/tk8.6",
		] {
			assert!(!is_tk_image(path), "{path}");
		}
	}

	#[test]
	fn chromium_identity_does_not_match_unrelated_display_names() {
		assert!(is_chromium_bundle("com.google.Chrome.canary"));
		assert!(is_chromium_bundle("company.thebrowser.Browser"));
		assert!(!is_chromium_bundle("com.apple.archiveutility"));
		assert!(!is_chromium_bundle("com.google.ChromeNotABrowser"));
	}

	#[test]
	fn region_record_matches_kernel_layout() {
		assert_eq!(mem::size_of::<ProcRegionInfo>(), 96);
		assert_eq!(mem::size_of::<ProcRegionWithPathInfo>(), 1272);
	}
}
