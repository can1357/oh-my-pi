//! Classifies target processes whose input stack cannot honour a particular
//! background delivery route, so the route can refuse instead of reporting a
//! silent drop as success.

use std::{ffi::CStr, fs, io::Read, mem};

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

/// Whether `pid` maps a Tk toolkit that places presses at the hardware
/// pointer: Tk 8.6 and later, or a Tk whose version cannot be read.
///
/// Tk 9's macOS backend translates every mouse event through the global
/// hardware pointer position rather than the event's own location, so a
/// pid-routed background press lands wherever the user's pointer happens to
/// be, or nowhere; macOS's own Tk 8.5 places it at the event location.
/// Detection walks the target's file-backed regions (same-user, no task
/// port); a Tk image loaded only from the dyld shared cache, as macOS's Tk 8.5
/// is, is invisible here, so Python's `_tkinter` is judged by the Tk it links.
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
	// An image maps several segments; its verdict is read once.
	let mut cleared = String::new();
	for _ in 0..MAX_REGIONS {
		// SAFETY: An all-zero bit pattern is valid for this plain C struct.
		let mut info: ProcRegionWithPathInfo = unsafe { mem::zeroed() };
		// SAFETY: The buffer is exactly the kernel structure size and outlives
		// the synchronous call.
		let written =
			unsafe { libc::proc_pidinfo(pid, flavor, address, (&raw mut info).cast(), size_arg) };
		if !usize::try_from(written).is_ok_and(|written| written >= size) {
			break;
		}
		read_any = true;
		// SAFETY: The kernel NUL-terminates `path` within its MAXPATHLEN buffer.
		let path = unsafe { CStr::from_ptr(info.path.as_ptr()) }.to_string_lossy();
		if path != cleared
			&& let Some(image) = tk_image(&path)
		{
			if reads_pointer(image, || read_image(path.as_ref()).and_then(|binary| linked_tk(&binary)))
			{
				return Some(true);
			}
			cleared = path.into_owned();
		}
		let next = info.region.address.saturating_add(info.region.size);
		if next <= address {
			break;
		}
		address = next;
	}
	read_any.then_some(false)
}

/// A mapped image that is, or carries, the Tk toolkit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TkImage {
	/// A Tk library or framework of this (major, minor) version.
	Version(u32, u32),
	/// A Tk library or framework whose path names no version.
	Unversioned,
	/// Python's `_tkinter` extension, which links or embeds Tk.
	Tkinter,
}

/// Classifies `Tk.framework` bundles, Tk shared libraries (`libtk8.6.dylib`,
/// Tk 9's `libtcl9tk9.0.dylib`), and Python's `_tkinter` extension.
fn tk_image(path: &str) -> Option<TkImage> {
	if let Some((_, inside)) = path.split_once("/Tk.framework/") {
		return Some(
			inside
				.strip_prefix("Versions/")
				.and_then(|rest| rest.split('/').next())
				.and_then(tk_version)
				.unwrap_or(TkImage::Unversioned),
		);
	}
	let file = path.rsplit('/').next().unwrap_or(path).to_ascii_lowercase();
	if file
		.strip_suffix(".so")
		.is_some_and(|stem| stem.starts_with("_tkinter"))
	{
		return Some(TkImage::Tkinter);
	}
	let stem = file.strip_suffix(".dylib")?.strip_prefix("lib")?;
	let stem = match stem.strip_prefix("tcl") {
		Some(after_tcl) => {
			let digits = after_tcl.bytes().take_while(u8::is_ascii_digit).count();
			if digits == 0 {
				return None;
			}
			&after_tcl[digits..]
		},
		None => stem,
	};
	let version = stem.strip_prefix("tk")?;
	if !version
		.bytes()
		.next()
		.is_some_and(|byte| byte.is_ascii_digit())
	{
		return None;
	}
	Some(tk_version(version).unwrap_or(TkImage::Unversioned))
}

/// Parses `major.minor` with an optional patch level.
fn tk_version(version: &str) -> Option<TkImage> {
	let mut parts = version.split('.');
	let major = parts.next()?.parse().ok()?;
	let minor = parts.next()?.parse().ok()?;
	Some(TkImage::Version(major, minor))
}

/// Whether a mapped Tk `image` places presses at the hardware pointer. A
/// `_tkinter` extension is judged by the Tk `linked` reads from its load
/// commands; one that links no Tk embeds a Tk of unknown version.
fn reads_pointer(image: TkImage, linked: impl FnOnce() -> Option<TkImage>) -> bool {
	let image = match image {
		TkImage::Tkinter => linked().unwrap_or(TkImage::Unversioned),
		image => image,
	};
	match image {
		TkImage::Version(major, minor) => (major, minor) > (8, 5),
		TkImage::Unversioned | TkImage::Tkinter => true,
	}
}

const MH_MAGIC_64: u32 = 0xfeed_facf;
const FAT_MAGIC: u32 = 0xcafe_babe;
const FAT_MAGIC_64: u32 = 0xcafe_babf;
const LC_REQ_DYLD: u32 = 0x8000_0000;
/// `LC_LOAD_DYLIB`, `LC_LOAD_WEAK_DYLIB`, `LC_REEXPORT_DYLIB`,
/// `LC_LAZY_LOAD_DYLIB`, `LC_LOAD_UPWARD_DYLIB`: commands whose payload is a
/// `dylib_command` naming a library the image links.
const DYLIB_COMMANDS: [u32; 5] =
	[0x0c, 0x18 | LC_REQ_DYLD, 0x1f | LC_REQ_DYLD, 0x20, 0x23 | LC_REQ_DYLD];
/// `sizeof(struct mach_header_64)`.
const MACH_HEADER_64: usize = 32;
/// `sizeof(struct dylib_command)`, where the install name may start.
const DYLIB_COMMAND: usize = 24;
/// Largest `_tkinter` image read for its load commands; Python's are about
/// 100 KiB. A larger one counts as unreadable.
const MAX_IMAGE_BYTES: u64 = 16 << 20;

/// The bytes of the image at `path`, unless it is larger than
/// [`MAX_IMAGE_BYTES`] or unreadable.
fn read_image(path: &str) -> Option<Vec<u8>> {
	let file = fs::File::open(path).ok()?;
	if file.metadata().ok()?.len() > MAX_IMAGE_BYTES {
		return None;
	}
	let mut binary = Vec::new();
	file.take(MAX_IMAGE_BYTES).read_to_end(&mut binary).ok()?;
	Some(binary)
}

/// The Tk library a Mach-O image (thin 64-bit or universal) links, from its
/// dylib load commands. A universal image counts only when every slice that
/// names a Tk names the same one. Malformed headers read as `None`, which
/// [`reads_pointer`] treats as a Tk of unknown version.
fn linked_tk(binary: &[u8]) -> Option<TkImage> {
	let be = |at: usize| -> Option<u32> {
		Some(u32::from_be_bytes(binary.get(at..at.checked_add(4)?)?.try_into().ok()?))
	};
	let slices: Vec<&[u8]> = match be(0)? {
		magic @ (FAT_MAGIC | FAT_MAGIC_64) => {
			let wide = magic == FAT_MAGIC_64;
			let entry = if wide { 32 } else { 20 };
			let count = usize::try_from(be(4)?).ok()?;
			if count.checked_mul(entry)?.checked_add(8)? > binary.len() {
				return None;
			}
			(0..count)
				.map(|index| {
					let at = 8 + index * entry;
					let (offset, size) = if wide {
						let read = |at: usize| -> Option<usize> {
							usize::try_from(u64::from_be_bytes(binary.get(at..at + 8)?.try_into().ok()?))
								.ok()
						};
						(read(at + 8)?, read(at + 16)?)
					} else {
						(usize::try_from(be(at + 8)?).ok()?, usize::try_from(be(at + 12)?).ok()?)
					};
					binary.get(offset..offset.checked_add(size)?)
				})
				.collect::<Option<_>>()?
		},
		_ => vec![binary],
	};
	let mut found = None;
	for slice in slices {
		let Some(image) = linked_libraries(slice)?
			.into_iter()
			.find_map(|name| tk_image(&name))
		else {
			continue;
		};
		if found.is_some_and(|seen| seen != image) {
			return Some(TkImage::Unversioned);
		}
		found = Some(image);
	}
	found
}

/// Install names from a thin little-endian 64-bit Mach-O image's dylib load
/// commands, read only inside the header's `sizeofcmds`; empty for anything
/// but such an image, and `None` when its load commands are malformed.
fn linked_libraries(image: &[u8]) -> Option<Vec<String>> {
	let le = |at: usize| -> Option<usize> {
		let bytes = image.get(at..at.checked_add(4)?)?;
		usize::try_from(u32::from_le_bytes(bytes.try_into().ok()?)).ok()
	};
	let mut names = Vec::new();
	if le(0) != usize::try_from(MH_MAGIC_64).ok() {
		return Some(names);
	}
	let count = le(16)?;
	let end = MACH_HEADER_64.checked_add(le(20)?)?;
	if end > image.len() {
		return None;
	}
	let mut at = MACH_HEADER_64;
	for _ in 0..count {
		let command = u32::try_from(le(at)?).ok()?;
		let size = le(at + 4)?;
		let next = at.checked_add(size)?;
		if size < 8 || next > end {
			return None;
		}
		if DYLIB_COMMANDS.contains(&command) {
			let offset = le(at + 8)?;
			if !(DYLIB_COMMAND..size).contains(&offset) {
				return None;
			}
			let name = &image[at + offset..next];
			let length = name
				.iter()
				.position(|&byte| byte == 0)
				.unwrap_or(name.len());
			names.push(String::from_utf8_lossy(&name[..length]).into_owned());
		}
		at = next;
	}
	Some(names)
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
/// successful AXSelectedText/AXValue write is not proof that the shell received
/// it.
pub(super) fn is_terminal(pid: libc::pid_t) -> bool {
	NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
		.and_then(|app| app.bundleIdentifier())
		.is_some_and(|bundle| {
			matches!(
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
			)
		})
}

#[cfg(test)]
mod tests {
	use std::{
		io::{BufRead, BufReader},
		path::Path,
		process::{Command, Stdio},
	};

	use super::*;

	#[test]
	fn tk_images_match_with_their_versions_and_neighbours_do_not() {
		for (path, image) in [
			("/Library/Frameworks/Tk.framework/Versions/8.6/Tk", TkImage::Version(8, 6)),
			("/System/Library/Frameworks/Tk.framework/Versions/8.5/Tk", TkImage::Version(8, 5)),
			("/opt/homebrew/Cellar/tcl-tk/9.0.2/lib/libtcl9tk9.0.dylib", TkImage::Version(9, 0)),
			("/opt/homebrew/opt/tcl-tk@8/lib/libtk8.6.dylib", TkImage::Version(8, 6)),
			("/Applications/Foo.app/Contents/Frameworks/Tk.framework/Tk", TkImage::Unversioned),
			("/usr/local/lib/libtk86.dylib", TkImage::Unversioned),
			("/usr/local/lib/python3.12/lib-dynload/_tkinter.cpython-312-darwin.so", TkImage::Tkinter),
		] {
			assert_eq!(tk_image(path), Some(image), "{path}");
		}
		for path in [
			"",
			"/opt/homebrew/lib/libtcl9.0.dylib",
			"/opt/homebrew/lib/libtkrzw.dylib",
			"/System/Library/Frameworks/AppKit.framework/Versions/C/AppKit",
			"/usr/lib/python3/_tkinter_helper.py",
			"/Applications/Foo.app/Contents/MacOS/tk8.6",
		] {
			assert_eq!(tk_image(path), None, "{path}");
		}
	}

	#[test]
	fn only_tk_newer_than_8_5_or_of_unknown_version_reads_the_hardware_pointer() {
		let unread = || -> Option<TkImage> { panic!("only _tkinter reads its linked Tk") };
		assert!(!reads_pointer(TkImage::Version(8, 5), unread));
		assert!(!reads_pointer(TkImage::Version(8, 4), unread));
		assert!(reads_pointer(TkImage::Version(8, 6), unread));
		assert!(reads_pointer(TkImage::Version(9, 1), unread));
		assert!(reads_pointer(TkImage::Unversioned, unread));
		// macOS's /usr/bin/python3 links the system Tk 8.5, which lives only in
		// the dyld shared cache, so its _tkinter is the one image the walk sees.
		assert!(!reads_pointer(TkImage::Tkinter, || Some(TkImage::Version(8, 5))));
		assert!(reads_pointer(TkImage::Tkinter, || Some(TkImage::Version(9, 0))));
		assert!(reads_pointer(TkImage::Tkinter, || Some(TkImage::Unversioned)));
		// A _tkinter that links no Tk embeds one of unknown version.
		assert!(reads_pointer(TkImage::Tkinter, || None));
	}

	/// A thin arm64 Mach-O image whose load commands link `libraries`, after a
	/// segment command that names no library.
	fn macho(libraries: &[&str]) -> Vec<u8> {
		let mut commands = Vec::new();
		let mut segment = vec![0u8; 72];
		segment[..4].copy_from_slice(&0x19u32.to_le_bytes());
		segment[4..8].copy_from_slice(&72u32.to_le_bytes());
		commands.push(segment);
		for library in libraries {
			let size = (24 + library.len() + 1).next_multiple_of(8);
			let mut command = vec![0u8; size];
			command[..4].copy_from_slice(&0x0cu32.to_le_bytes());
			command[4..8].copy_from_slice(&u32::try_from(size).unwrap().to_le_bytes());
			command[8..12].copy_from_slice(&24u32.to_le_bytes());
			command[24..24 + library.len()].copy_from_slice(library.as_bytes());
			commands.push(command);
		}
		let commands = commands.concat();
		let mut image = vec![0u8; 32];
		image[..4].copy_from_slice(&MH_MAGIC_64.to_le_bytes());
		image[16..20].copy_from_slice(&u32::try_from(libraries.len() + 1).unwrap().to_le_bytes());
		image[20..24].copy_from_slice(&u32::try_from(commands.len()).unwrap().to_le_bytes());
		image.extend(commands);
		image
	}

	/// `image` with the little-endian `u32` at `at` replaced by `value`.
	fn patched(image: &[u8], at: usize, value: u32) -> Vec<u8> {
		let mut image = image.to_vec();
		image[at..at + 4].copy_from_slice(&value.to_le_bytes());
		image
	}

	/// A universal image holding `slices` back to back after a 32-bit fat
	/// header.
	fn universal(slices: &[Vec<u8>]) -> Vec<u8> {
		let mut header = FAT_MAGIC.to_be_bytes().to_vec();
		header.extend(u32::try_from(slices.len()).unwrap().to_be_bytes());
		let mut offset = 8 + 20 * slices.len();
		for slice in slices {
			header.extend([0u8; 8]);
			header.extend(u32::try_from(offset).unwrap().to_be_bytes());
			header.extend(u32::try_from(slice.len()).unwrap().to_be_bytes());
			header.extend([0u8; 4]);
			offset += slice.len();
		}
		header.extend(slices.concat());
		header
	}

	#[test]
	fn tkinter_is_judged_by_the_tk_its_load_commands_link() {
		const SYSTEM_TK: &str = "/System/Library/Frameworks/Tk.framework/Versions/8.5/Tk";
		const SYSTEM_TCL: &str = "/System/Library/Frameworks/Tcl.framework/Versions/8.5/Tcl";
		const BREW_TK: &str = "/opt/homebrew/opt/tcl-tk/lib/libtcl9tk9.1.dylib";
		let system = macho(&[SYSTEM_TCL, SYSTEM_TK, "/usr/lib/libSystem.B.dylib"]);
		assert_eq!(linked_tk(&system), Some(TkImage::Version(8, 5)));
		assert_eq!(linked_tk(&macho(&[BREW_TK])), Some(TkImage::Version(9, 1)));
		assert_eq!(linked_tk(&macho(&["/usr/lib/libSystem.B.dylib"])), None);
		assert_eq!(
			linked_tk(&universal(&[system.clone(), system.clone()])),
			Some(TkImage::Version(8, 5))
		);
		assert_eq!(
			linked_tk(&universal(&[system.clone(), macho(&[BREW_TK])])),
			Some(TkImage::Unversioned),
		);
		// Truncated or foreign bytes link nothing.
		assert_eq!(linked_tk(&system[..40]), None);
		assert_eq!(linked_tk(b"#!/bin/sh\n"), None);
		assert_eq!(linked_tk(&[]), None);
	}

	#[test]
	fn malformed_mach_o_headers_link_no_known_tk() {
		const SYSTEM_TK: &str = "/System/Library/Frameworks/Tk.framework/Versions/8.5/Tk";
		let system = macho(&[SYSTEM_TK]);
		let segment_end = 32 + 72;
		// Load commands outside `sizeofcmds`, or running past it.
		assert_eq!(linked_tk(&patched(&system, 20, 0)), None);
		assert_eq!(linked_tk(&patched(&system, 20, 72)), None);
		assert_eq!(linked_tk(&patched(&system, 20, u32::MAX)), None);
		// A dylib command too small for its header, or whose name starts
		// inside the header or beyond the command.
		assert_eq!(linked_tk(&patched(&system, segment_end + 4, 4)), None);
		assert_eq!(linked_tk(&patched(&system, segment_end + 8, 8)), None);
		assert_eq!(linked_tk(&patched(&system, segment_end + 8, 4096)), None);
		// A command count beyond what `sizeofcmds` holds.
		assert_eq!(linked_tk(&patched(&system, 16, u32::MAX)), None);
		// Universal headers whose architecture table or slices lie outside
		// the file, including a huge advertised count, are rejected at once.
		for magic in [FAT_MAGIC, FAT_MAGIC_64] {
			let mut fat = magic.to_be_bytes().to_vec();
			fat.extend(u32::MAX.to_be_bytes());
			let started = std::time::Instant::now();
			assert_eq!(linked_tk(&fat), None);
			assert!(started.elapsed() < std::time::Duration::from_millis(100));
		}
		let mut beyond = universal(std::slice::from_ref(&system));
		beyond[16..20].copy_from_slice(&u32::MAX.to_be_bytes());
		assert_eq!(linked_tk(&beyond), None);
		// A conservative verdict follows: an unknown Tk reads the pointer.
		assert!(reads_pointer(TkImage::Tkinter, || linked_tk(&patched(&system, 20, 0))));
	}

	/// A Python whose `_tkinter` links macOS's own Tk 8.5: the developer tools'
	/// Python, which `/usr/bin/python3` runs once they are installed.
	fn system_tk_python() -> Option<&'static str> {
		[
			"/Library/Developer/CommandLineTools/Library/Frameworks/Python3.framework/Versions/\
			 Current/bin/python3",
			"/Applications/Xcode.app/Contents/Developer/Library/Frameworks/Python3.framework/\
			 Versions/Current/bin/python3",
		]
		.into_iter()
		.find(|path| Path::new(path).exists())
	}

	/// Kills and reaps the child on every exit from the test.
	struct Reaped(std::process::Child);

	impl Drop for Reaped {
		fn drop(&mut self) {
			let _ = self.0.kill();
			let _ = self.0.wait();
		}
	}

	#[test]
	fn a_live_process_on_macos_tk_8_5_does_not_read_the_hardware_pointer() {
		let Some(python) = system_tk_python() else {
			eprintln!("skipped: no developer-tools Python with macOS's Tk 8.5");
			return;
		};
		// Isolated mode ignores PYTHONPATH, PYTHONHOME and user site-packages,
		// so the module imported is the developer tools' own extension.
		let mut child = Reaped(
			Command::new(python)
				.args([
					"-I",
					"-c",
					"import _tkinter, time; print(_tkinter.__file__, flush=True); time.sleep(30)",
				])
				.stdout(Stdio::piped())
				.spawn()
				.expect("spawn python"),
		);
		let mut extension = String::new();
		BufReader::new(child.0.stdout.take().expect("stdout"))
			.read_line(&mut extension)
			.expect("read the _tkinter path");
		let extension = extension.trim();
		let linked = read_image(extension).and_then(|binary| linked_tk(&binary));
		if !extension.contains("/Python3.framework/") || linked != Some(TkImage::Version(8, 5)) {
			eprintln!("skipped: {python} imported {extension:?}, which links {linked:?}");
			return;
		}
		let pid = libc::pid_t::try_from(child.0.id()).expect("pid");
		// The walk sees only `_tkinter`; the Tk 8.5 it links lives in the dyld
		// shared cache. That Tk places presses at the event location.
		assert!(!reads_hardware_pointer(pid), "{extension} judged as reading the hardware pointer");
	}

	#[test]
	fn region_record_matches_kernel_layout() {
		assert_eq!(mem::size_of::<ProcRegionInfo>(), 96);
		assert_eq!(mem::size_of::<ProcRegionWithPathInfo>(), 1272);
	}
}
