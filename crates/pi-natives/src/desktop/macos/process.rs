//! Classifies target processes whose input stack cannot honour a particular
//! background delivery route, so the route can refuse instead of reporting a
//! silent drop as success.

use std::{
	collections::HashMap,
	ffi::{CStr, OsStr},
	fs::File,
	io::{Read, Seek, SeekFrom},
	mem,
	os::unix::ffi::OsStrExt,
	path::{Path, PathBuf},
	sync::LazyLock,
};

use objc2::rc::autoreleasepool;
use objc2_app_kit::NSRunningApplication;
use objc2_foundation::{NSBundle, ns_string};
use parking_lot::Mutex;

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
			if reads_pointer(image, || linked_tk(&mut File::open(&*path).ok()?)) {
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
	let stem = file.strip_circumfix("lib", ".dylib")?;
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

/// The Tk a Mach-O image links, from its dylib load commands
/// ([`linked_dylibs`]); `None` when it links none or cannot be read.
fn linked_tk(image: &mut (impl Read + Seek)) -> Option<TkImage> {
	linked_dylibs(image)?
		.iter()
		.find_map(|name| tk_image(&String::from_utf8_lossy(name)))
}

/// Whether `pid` runs inside an Electron app bundle, whose renderer drops
/// pid-routed wheel events while its window is in the background.
pub(super) fn is_electron(pid: libc::pid_t) -> bool {
	// `<App>.app/Contents/MacOS/<exe>` ships its runtime beside it in
	// `<App>.app/Contents/Frameworks`.
	executable_path(pid)
		.as_deref()
		.and_then(Path::parent)
		.and_then(Path::parent)
		.is_some_and(|contents| {
			contents
				.join("Frameworks/Electron Framework.framework")
				.exists()
		})
}

fn executable_path(pid: libc::pid_t) -> Option<PathBuf> {
	let mut buffer = [0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
	let capacity = u32::try_from(buffer.len()).ok()?;
	// SAFETY: `buffer` is writable for `capacity` bytes for the synchronous
	// call.
	let length = unsafe { libc::proc_pidpath(pid, buffer.as_mut_ptr().cast(), capacity) };
	let executable = buffer.get(..usize::try_from(length).ok()?)?;
	Some(Path::new(OsStr::from_bytes(executable)).to_path_buf())
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
		"com.google.chrome.for.testing",
		"org.chromium.Chromium",
		"com.brave.Browser",
		"com.microsoft.edgemac",
		"company.thebrowser.Browser",
		"com.vivaldi.Vivaldi",
		"com.operasoftware.Opera",
	]
	.iter()
	.any(|base| {
		bundle == *base
			|| bundle
				.strip_prefix(*base)
				.is_some_and(|suffix| suffix.starts_with('.'))
	})
}

/// How a client that shows another computer or device forwards input to it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum RemoteScreen {
	/// Sends each key event's key code to the remote computer (Screen
	/// Sharing), with the modifiers the physical keyboard holds rather than
	/// any the event carries.
	KeyEvents,
	/// Streams HID report state, modifier keys included, to a paired device
	/// (iPhone Mirroring), which misses a key or button transition shorter
	/// than its report interval.
	HidReports,
}

/// Remote-screen linkage of the executables processes run, keyed by pid and
/// executable path so a reused pid is read afresh.
type LinkageCache = Mutex<HashMap<(libc::pid_t, PathBuf), Option<RemoteScreen>>>;

/// Every input event classifies its target, so each process's executable is
/// read once.
static LINKAGE: LazyLock<LinkageCache> = LazyLock::new(LinkageCache::default);
/// Processes whose linkage is kept before the cache starts over.
const MAX_CACHED_LINKAGES: usize = 64;

/// Whether `pid` shows a remote screen. Such a client forwards a key event's
/// key code and ignores its Unicode text.
pub(super) fn remote_screen(pid: libc::pid_t) -> Option<RemoteScreen> {
	let bundle = NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
		.and_then(|app| app.bundleIdentifier())
		.map(|bundle| bundle.to_string());
	classify_remote_screen(bundle.as_deref(), || {
		cached_linkage(&LINKAGE, pid, executable_path(pid)?, |executable| {
			linked_dylibs(&mut File::open(executable).ok()?)
		})
	})
}

/// Apple's own clients are known by bundle identifier, so an executable that
/// cannot be read (replaced by an update, say) never hides them; any other
/// application is judged by the Apple screen-sharing framework it links.
fn classify_remote_screen(
	bundle: Option<&str>,
	linkage: impl FnOnce() -> Option<RemoteScreen>,
) -> Option<RemoteScreen> {
	match bundle {
		Some("com.apple.ScreenSharing") => Some(RemoteScreen::KeyEvents),
		Some("com.apple.ScreenContinuity") => Some(RemoteScreen::HidReports),
		_ => linkage(),
	}
}

/// The linkage `cache` holds for `pid` running `executable`, otherwise the
/// one `linked_dylibs` reads. An executable that cannot be read is not kept,
/// so the next event reads it again.
fn cached_linkage(
	cache: &LinkageCache,
	pid: libc::pid_t,
	executable: PathBuf,
	linked_dylibs: impl FnOnce(&Path) -> Option<Vec<Vec<u8>>>,
) -> Option<RemoteScreen> {
	let key = (pid, executable);
	if let Some(&linkage) = cache.lock().get(&key) {
		return linkage;
	}
	let linkage = remote_screen_linkage(&linked_dylibs(&key.1)?);
	let mut cache = cache.lock();
	if cache.len() >= MAX_CACHED_LINKAGES {
		cache.clear();
	}
	cache.insert(key, linkage);
	linkage
}

fn remote_screen_linkage(dylibs: &[Vec<u8>]) -> Option<RemoteScreen> {
	let links = |framework: &[u8]| {
		dylibs
			.iter()
			.any(|dylib| dylib.windows(framework.len()).any(|part| part == framework))
	};
	if links(b"/ScreenSharingKit.framework/") {
		Some(RemoteScreen::HidReports)
	} else if links(b"/ScreenSharing.framework/") {
		Some(RemoteScreen::KeyEvents)
	} else {
		None
	}
}

const FAT_MAGIC: u32 = 0xcafe_babe;
const FAT_MAGIC_64: u32 = 0xcafe_babf;
const MH_MAGIC_64: u32 = 0xfeed_facf;
#[cfg(target_arch = "aarch64")]
const NATIVE_CPU_TYPE: u32 = 0x0100_000c;
#[cfg(not(target_arch = "aarch64"))]
const NATIVE_CPU_TYPE: u32 = 0x0100_0007;
/// `LC_LOAD_DYLIB` and its weak, re-export, lazy and upward variants.
const DYLIB_COMMANDS: [u32; 5] = [0xc, 0x8000_0018, 0x8000_001f, 0x20, 0x8000_0023];
/// Bounds the load-command read of a malformed executable.
const MAX_LOAD_COMMANDS: usize = 1 << 20;

/// Install names of the dylibs a 64-bit Mach-O executable links, read from
/// the slice for this CPU (or the first slice) of a universal binary.
fn linked_dylibs(file: &mut (impl Read + Seek)) -> Option<Vec<Vec<u8>>> {
	let mut start = [0u8; 8];
	file.read_exact(&mut start).ok()?;
	let slice = match be_u32(&start, 0)? {
		fat @ (FAT_MAGIC | FAT_MAGIC_64) => {
			// `fat_arch` holds a 32-bit offset at 8; `fat_arch_64` a 64-bit one.
			let entry_size = if fat == FAT_MAGIC { 20 } else { 32 };
			let count = usize::try_from(be_u32(&start, 4)?).ok()?.min(16);
			let mut entries = vec![0u8; entry_size * count];
			file.read_exact(&mut entries).ok()?;
			let mut slices = entries.chunks_exact(entry_size);
			let entry = slices
				.clone()
				.find(|entry| be_u32(entry, 0) == Some(NATIVE_CPU_TYPE))
				.or_else(|| slices.next())?;
			if fat == FAT_MAGIC {
				u64::from(be_u32(entry, 8)?)
			} else {
				u64::from_be_bytes(*entry.get(8..)?.first_chunk()?)
			}
		},
		_ => 0,
	};
	// `mach_header_64`: magic at 0, `ncmds` at 16, `sizeofcmds` at 20.
	let mut header = [0u8; 32];
	file.seek(SeekFrom::Start(slice)).ok()?;
	file.read_exact(&mut header).ok()?;
	if le_u32(&header, 0)? != MH_MAGIC_64 {
		return None;
	}
	let size = usize::try_from(le_u32(&header, 20)?).ok()?;
	if size > MAX_LOAD_COMMANDS {
		return None;
	}
	let mut commands = vec![0u8; size];
	file.read_exact(&mut commands).ok()?;
	let mut dylibs = Vec::new();
	let mut rest = commands.as_slice();
	for _ in 0..le_u32(&header, 16)? {
		// Every load command starts with its kind and total size; a dylib
		// command's install name sits at the offset stored at 8.
		let length = usize::try_from(le_u32(rest, 4)?).ok()?;
		let (command, tail) = rest.split_at_checked(length).filter(|_| length >= 8)?;
		if DYLIB_COMMANDS.contains(&le_u32(command, 0)?) {
			let name = command.get(usize::try_from(le_u32(command, 8)?).ok()?..)?;
			dylibs.push(name.split(|&byte| byte == 0).next()?.to_vec());
		}
		rest = tail;
	}
	Some(dylibs)
}

fn be_u32(bytes: &[u8], at: usize) -> Option<u32> {
	Some(u32::from_be_bytes(*bytes.get(at..)?.first_chunk()?))
}

fn le_u32(bytes: &[u8], at: usize) -> Option<u32> {
	Some(u32::from_le_bytes(*bytes.get(at..)?.first_chunk()?))
}

/// Whether `pid` is a `UIKit` app such as Mac Catalyst: its bundle declares
/// `UIDeviceFamily`, which `AppKit` apps' do not. The session
/// thread has no autorelease pool of its own, so the lookup brings one.
pub(super) fn is_uikit(pid: libc::pid_t) -> bool {
	autoreleasepool(|_| {
		NSRunningApplication::runningApplicationWithProcessIdentifier(pid)
			.and_then(|app| app.bundleURL())
			.and_then(|url| NSBundle::bundleWithURL(&url))
			.is_some_and(|bundle| {
				bundle
					.objectForInfoDictionaryKey(ns_string!("UIDeviceFamily"))
					.is_some()
			})
	})
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

/// When `pid` started, in microseconds since the epoch: a later process that
/// reuses the id has a later start.
pub(in crate::desktop) fn started(pid: libc::pid_t) -> Option<u64> {
	let size = libc::c_int::try_from(mem::size_of::<libc::proc_bsdinfo>()).ok()?;
	// SAFETY: An all-zero bit pattern is valid for this plain C struct.
	let mut info: libc::proc_bsdinfo = unsafe { mem::zeroed() };
	// SAFETY: The buffer is exactly the kernel structure size and outlives the
	// synchronous call.
	let written =
		unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&raw mut info).cast(), size) };
	(written == size).then(|| {
		info
			.pbi_start_tvsec
			.saturating_mul(1_000_000)
			.saturating_add(info.pbi_start_tvusec)
	})
}

/// `pid`'s application name as the Dock shows it.
pub(super) fn application_name(pid: libc::pid_t) -> Option<String> {
	NSRunningApplication::runningApplicationWithProcessIdentifier(pid)?
		.localizedName()
		.map(|name| name.to_string())
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
	fn chromium_identity_does_not_match_unrelated_display_names() {
		assert!(is_chromium_bundle("com.google.Chrome.canary"));
		assert!(is_chromium_bundle("company.thebrowser.Browser"));
		assert!(is_chromium_bundle("com.google.chrome.for.testing"));
		assert!(!is_chromium_bundle("com.apple.archiveutility"));
		assert!(!is_chromium_bundle("com.google.ChromeNotABrowser"));
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

	#[test]
	fn tkinter_is_judged_by_the_tk_its_load_commands_link() {
		const SYSTEM_TK: &str = "/System/Library/Frameworks/Tk.framework/Versions/8.5/Tk";
		const SYSTEM_TCL: &str = "/System/Library/Frameworks/Tcl.framework/Versions/8.5/Tcl";
		const BREW_TK: &str = "/opt/homebrew/opt/tcl-tk/lib/libtcl9tk9.1.dylib";
		let linked = |file: Vec<u8>| linked_tk(&mut std::io::Cursor::new(file));
		let native = NATIVE_CPU_TYPE;
		let system = macho(native, &[SYSTEM_TCL, SYSTEM_TK, "/usr/lib/libSystem.B.dylib"]);
		assert_eq!(linked(system.clone()), Some(TkImage::Version(8, 5)));
		assert_eq!(linked(macho(native, &[BREW_TK])), Some(TkImage::Version(9, 1)));
		assert_eq!(linked(macho(native, &["/usr/lib/libSystem.B.dylib"])), None);
		// An image whose load commands cannot be read counts as a Tk of
		// unknown version, which reads the pointer.
		let mut truncated = system;
		truncated.truncate(truncated.len() - 16);
		assert!(reads_pointer(TkImage::Tkinter, || linked(truncated)));
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
		let linked = File::open(extension)
			.ok()
			.and_then(|mut file| linked_tk(&mut file));
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

	const KIT: &str =
		"/System/Library/PrivateFrameworks/ScreenSharingKit.framework/Versions/A/ScreenSharingKit";
	const VNC: &str =
		"/System/Library/PrivateFrameworks/ScreenSharing.framework/Versions/A/ScreenSharing";
	const APPKIT: &str = "/System/Library/Frameworks/AppKit.framework/Versions/C/AppKit";

	/// A thin 64-bit Mach-O for `cpu` whose load commands are a UUID, then
	/// alternately strong and weak links to `dylibs`.
	fn macho(cpu: u32, dylibs: &[&str]) -> Vec<u8> {
		let mut commands = [0x1b_u32, 24].map(u32::to_le_bytes).concat();
		commands.resize(24, 0);
		for (index, name) in dylibs.iter().enumerate() {
			let kind = if index % 2 == 0 {
				DYLIB_COMMANDS[0]
			} else {
				DYLIB_COMMANDS[1]
			};
			let size = (24 + name.len() + 1).next_multiple_of(8);
			let start = commands.len();
			commands.extend([kind, size as u32, 24].map(u32::to_le_bytes).concat());
			commands.resize(start + 24, 0);
			commands.extend(name.as_bytes());
			commands.resize(start + size, 0);
		}
		let count = dylibs.len() as u32 + 1;
		let mut file = [MH_MAGIC_64, cpu, 0, 2, count, commands.len() as u32, 0, 0]
			.map(u32::to_le_bytes)
			.concat();
		file.extend(commands);
		file
	}

	/// A universal binary holding `slices` at 4 KiB-aligned offsets.
	fn universal(slices: &[(u32, Vec<u8>)]) -> Vec<u8> {
		let mut file = [FAT_MAGIC, slices.len() as u32]
			.map(u32::to_be_bytes)
			.concat();
		let mut offset = 4096;
		for (cpu, slice) in slices {
			file.extend(
				[*cpu, 0, offset, slice.len() as u32, 12]
					.map(u32::to_be_bytes)
					.concat(),
			);
			offset += (slice.len() as u32).next_multiple_of(4096);
		}
		for (_, slice) in slices {
			file.resize(file.len().next_multiple_of(4096), 0);
			file.extend(slice);
		}
		file
	}

	fn classify(file: Vec<u8>) -> Option<RemoteScreen> {
		remote_screen_linkage(&linked_dylibs(&mut std::io::Cursor::new(file))?)
	}

	#[test]
	fn remote_screens_are_recognised_by_the_screen_sharing_framework_they_link() {
		let native = NATIVE_CPU_TYPE;
		let mirror = ["@rpath/ScreenContinuityUI.framework/Versions/A/ScreenContinuityUI", KIT];
		assert_eq!(classify(macho(native, &mirror)), Some(RemoteScreen::HidReports));
		assert_eq!(classify(macho(native, &[APPKIT, VNC])), Some(RemoteScreen::KeyEvents));
		assert_eq!(classify(macho(native, &[APPKIT])), None);
		assert_eq!(
			classify(macho(native, &["/Library/Frameworks/MyScreenSharing.framework/A"])),
			None
		);
	}

	#[test]
	fn universal_binaries_are_read_from_this_cpus_slice() {
		let other = if NATIVE_CPU_TYPE == 0x0100_000c {
			0x0100_0007
		} else {
			0x0100_000c
		};
		let file = universal(&[
			(other, macho(other, &[APPKIT])),
			(NATIVE_CPU_TYPE, macho(NATIVE_CPU_TYPE, &[KIT])),
		]);
		assert_eq!(classify(file), Some(RemoteScreen::HidReports));
		let mut truncated = macho(NATIVE_CPU_TYPE, &[KIT]);
		truncated.truncate(truncated.len() - 16);
		assert_eq!(linked_dylibs(&mut std::io::Cursor::new(truncated)), None);
	}

	#[test]
	fn apple_clients_are_remote_screens_even_when_their_executable_is_unreadable() {
		let unreadable = || None;
		assert_eq!(
			classify_remote_screen(Some("com.apple.ScreenSharing"), unreadable),
			Some(RemoteScreen::KeyEvents)
		);
		assert_eq!(
			classify_remote_screen(Some("com.apple.ScreenContinuity"), unreadable),
			Some(RemoteScreen::HidReports)
		);
		assert_eq!(classify_remote_screen(Some("com.example.Viewer"), unreadable), None);
		assert_eq!(
			classify_remote_screen(Some("com.example.Viewer"), || Some(RemoteScreen::HidReports)),
			Some(RemoteScreen::HidReports)
		);
	}

	#[test]
	fn each_process_executable_is_read_once() {
		let cache = LinkageCache::default();
		let reads = std::cell::Cell::new(0);
		let read = |_: &Path| {
			reads.update(|v| v + 1);
			Some(vec![KIT.as_bytes().to_vec()])
		};
		let viewer = PathBuf::from("/Applications/Viewer.app/Contents/MacOS/Viewer");
		assert_eq!(cached_linkage(&cache, 7, viewer.clone(), read), Some(RemoteScreen::HidReports));
		let again = cached_linkage(&cache, 7, viewer.clone(), |_| panic!("read again"));
		assert_eq!(again, Some(RemoteScreen::HidReports));
		// A reused pid running another executable is read afresh.
		let other = cached_linkage(&cache, 7, PathBuf::from("/bin/ls"), |_| {
			Some(vec![APPKIT.as_bytes().to_vec()])
		});
		assert_eq!(other, None);
		// An executable that cannot be read is read again on the next event.
		assert_eq!(cached_linkage(&cache, 8, viewer.clone(), |_| None), None);
		assert_eq!(cached_linkage(&cache, 8, viewer, read), Some(RemoteScreen::HidReports));
		assert_eq!(reads.get(), 2);
	}

	#[test]
	fn a_full_linkage_cache_starts_over_and_reads_dropped_processes_again() {
		let cache = LinkageCache::default();
		let reads = std::cell::Cell::new(0);
		let read = |_: &Path| {
			reads.update(|v| v + 1);
			Some(vec![KIT.as_bytes().to_vec()])
		};
		let viewer = PathBuf::from("/Applications/Viewer.app/Contents/MacOS/Viewer");
		let last = MAX_CACHED_LINKAGES as libc::pid_t;
		for pid in 0..=last {
			assert_eq!(
				cached_linkage(&cache, pid, viewer.clone(), read),
				Some(RemoteScreen::HidReports)
			);
		}
		assert_eq!(reads.get(), MAX_CACHED_LINKAGES + 1);
		// The process read after the cache filled is still cached.
		let kept = cached_linkage(&cache, last, viewer.clone(), |_| panic!("read again"));
		assert_eq!(kept, Some(RemoteScreen::HidReports));
		// One dropped when it started over is read again, with the same answer.
		assert_eq!(cached_linkage(&cache, 0, viewer, read), Some(RemoteScreen::HidReports));
		assert_eq!(reads.get(), MAX_CACHED_LINKAGES + 2);
	}

	#[test]
	fn this_test_binary_links_system_libraries_but_no_screen_sharing_framework() {
		let pid = libc::pid_t::try_from(std::process::id()).unwrap();
		let mut executable = File::open(executable_path(pid).unwrap()).unwrap();
		let dylibs = linked_dylibs(&mut executable).unwrap();
		assert!(
			dylibs
				.iter()
				.any(|dylib| dylib.starts_with(b"/usr/lib/libSystem")),
			"{dylibs:?}"
		);
		assert_eq!(remote_screen(pid), None);
	}
}
