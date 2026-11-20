//! Window-handle facts and activation guards shared by Win32 input and UI
//! Automation delivery.

use std::{
	ptr::{null_mut, with_exposed_provenance, with_exposed_provenance_mut},
	time::{Duration, Instant},
};

use windows_sys::{
	Win32::{
		Foundation::{CloseHandle, HANDLE, HWND, LPARAM, POINT, RECT},
		Graphics::{
			Dwm::{DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute},
			Gdi::{
				COMPLEXREGION, CombineRgn, CreateRectRgn, DeleteObject, EnumDisplayMonitors,
				GDI_REGION_TYPE, GetWindowRgnBox, HDC, HMONITOR, HRGN, IntersectRect, NULLREGION,
				RGN_AND, RGN_COMBINE_MODE, RGN_DIFF, RGN_ERROR, RGN_OR, SIMPLEREGION, ScreenToClient,
			},
		},
		Security::{
			GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TOKEN_MANDATORY_LABEL,
			TOKEN_QUERY, TokenIntegrityLevel,
		},
		System::Threading::{
			GetCurrentProcess, OpenProcess, OpenProcessToken, PROCESS_NAME_WIN32,
			PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
		},
		UI::{
			HiDpi::{
				DPI_AWARENESS_CONTEXT, GetWindowDpiAwarenessContext,
				PhysicalToLogicalPointForPerMonitorDPI, SetThreadDpiAwarenessContext,
			},
			Input::KeyboardAndMouse::IsWindowEnabled,
			WindowsAndMessaging::{
				CWP_SKIPDISABLED, CWP_SKIPINVISIBLE, CWP_SKIPTRANSPARENT, ChildWindowFromPointEx,
				EnumChildWindows, EnumWindows, GA_PARENT, GA_ROOT, GUITHREADINFO, GWL_EXSTYLE,
				GetAncestor, GetClassNameW, GetForegroundWindow, GetGUIThreadInfo,
				GetLayeredWindowAttributes, GetWindowLongW, GetWindowRect, GetWindowThreadProcessId,
				IsChild, IsIconic, IsWindowVisible, LWA_ALPHA, LWA_COLORKEY, SetForegroundWindow,
				WS_EX_LAYERED, WS_EX_TRANSPARENT,
			},
		},
	},
	core::BOOL,
};

use super::{
	super::{
		control,
		error::{CoreResult, DesktopError},
	},
	delivery::{is_chromium_class, is_wpf_class},
};

/// Top-level classes that host XAML/UWP/WinUI content.
const XAML_HOST_CLASSES: [&str; 4] = [
	"ApplicationFrameWindow",
	"WinUIDesktopWin32WindowClass",
	"Windows.UI.Core.CoreWindow",
	"Microsoft.UI.Content.DesktopChildSiteBridge",
];

/// Executables that render XAML behind a legacy top-level class (Windows 11
/// Notepad keeps the `Notepad` class) or a generic frame host.
const XAML_HOST_EXECUTABLES: [&str; 6] = [
	"notepad.exe",
	"calculatorapp.exe",
	"calc.exe",
	"applicationframehost.exe",
	"photos.exe",
	"systemsettings.exe",
];

/// Top-level window that owns `hwnd`, or `hwnd` itself when it has none.
pub(super) fn root(hwnd: HWND) -> HWND {
	// SAFETY: GetAncestor validates the handle and returns null for stale ones.
	let root = unsafe { GetAncestor(hwnd, GA_ROOT) };
	if root.is_null() { hwnd } else { root }
}

/// Class name of `hwnd`, or `<unknown>` when Win32 cannot report one.
pub(super) fn class_name(hwnd: HWND) -> String {
	with_class_name(hwnd, |class| {
		if class.is_empty() {
			"<unknown>".to_string()
		} else {
			class.to_string()
		}
	})
}

/// Runs `inspect` on `hwnd`'s class name without heap allocation; the name is
/// empty when Win32 cannot report one.
fn with_class_name<R>(hwnd: HWND, inspect: impl FnOnce(&str) -> R) -> R {
	let mut wide = [0u16; 256];
	// SAFETY: the buffer is writable for its advertised length; Win32 validates
	// the handle.
	let length = unsafe { GetClassNameW(hwnd, wide.as_mut_ptr(), wide.len() as i32) };
	// Each UTF-16 unit decodes to at most three UTF-8 bytes.
	let mut utf8 = [0u8; 256 * 3];
	let mut used = 0;
	for decoded in char::decode_utf16(wide[..length.max(0) as usize].iter().copied()) {
		used += decoded
			.unwrap_or(char::REPLACEMENT_CHARACTER)
			.encode_utf8(&mut utf8[used..])
			.len();
	}
	inspect(std::str::from_utf8(&utf8[..used]).unwrap_or_default())
}

/// Whether `hwnd`'s top-level window currently owns the foreground.
pub(super) fn owns_foreground(hwnd: HWND) -> bool {
	// SAFETY: GetForegroundWindow has no preconditions.
	let foreground = unsafe { GetForegroundWindow() };
	!foreground.is_null() && root(foreground) == root(hwnd)
}

/// Whether `hwnd` is drawn by Chromium (its own class or a renderer child),
/// which runs its own occlusion check: once that finds nothing of the window
/// showing, Chromium can mark its pages hidden and stop painting them and
/// updating their accessibility tree, while Windows keeps composing the last
/// frame.
pub(super) fn paused_while_covered(hwnd: HWND) -> bool {
	with_class_name(hwnd, is_chromium_class) || has_chromium_descendant(hwnd)
}

/// Whether top-level `hwnd` appears fully covered: no part of its frame lies
/// on a display outside the visible, opaque windows above it in the z-order.
/// False when any of that cannot be read.
pub(super) fn fully_covered(hwnd: HWND) -> bool {
	let (Some(frame), Some(displays), Some(above)) =
		(frame_bounds(hwnd), displays(), occluders_above(hwnd))
	else {
		return false;
	};
	let Some(shown) = Region::new(frame) else {
		return false;
	};
	let mut kind = shown.combine(&displays, RGN_AND);
	for rect in above {
		if kind != SIMPLEREGION && kind != COMPLEXREGION {
			break;
		}
		let Some(cover) = Region::new(rect) else {
			return false;
		};
		kind = shown.combine(&cover, RGN_DIFF);
	}
	kind == NULLREGION
}

/// The union of every display's rectangle, `None` when one cannot be read.
fn displays() -> Option<Region> {
	unsafe extern "system" fn add(_: HMONITOR, _: HDC, rect: *mut RECT, state: LPARAM) -> BOOL {
		// SAFETY: `state` is the exposed address of the region owned by the
		// enclosing call, which outlives this synchronous enumeration; `rect`
		// is the monitor's rectangle for the duration of the callback.
		let (union, rect) = unsafe { (&*with_exposed_provenance::<Region>(state as usize), *rect) };
		BOOL::from(
			Region::new(rect).is_some_and(|monitor| union.combine(&monitor, RGN_OR) != RGN_ERROR),
		)
	}

	let union = Region::new(RECT::default())?;
	// SAFETY: `add` runs only during this synchronous call and receives the
	// address of `union`, which outlives it.
	let complete = unsafe {
		EnumDisplayMonitors(
			null_mut(),
			std::ptr::null(),
			Some(add),
			(&raw const union).expose_provenance() as LPARAM,
		)
	} != 0;
	complete.then_some(union)
}

/// The screen rectangles hiding what lies under them of every top-level
/// window above `hwnd`, from one top-to-bottom pass over the z-order; `None`
/// when the pass does not reach `hwnd`.
fn occluders_above(hwnd: HWND) -> Option<Vec<RECT>> {
	struct Walk {
		target: HWND,
		found:  bool,
		rects:  Vec<RECT>,
	}

	unsafe extern "system" fn visit(window: HWND, state: LPARAM) -> BOOL {
		// SAFETY: `state` is the exposed address of the walk owned by the
		// enclosing call, which outlives this synchronous enumeration.
		let walk = unsafe { &mut *with_exposed_provenance_mut::<Walk>(state as usize) };
		if window == walk.target {
			walk.found = true;
			return BOOL::from(false);
		}
		walk.rects.extend(occluder(window));
		BOOL::from(true)
	}

	let mut walk = Walk { target: hwnd, found: false, rects: Vec::new() };
	// SAFETY: `visit` runs only during this synchronous call and receives the
	// address of `walk`, which outlives it.
	unsafe {
		EnumWindows(Some(visit), (&raw mut walk).expose_provenance() as LPARAM);
	}
	walk.found.then_some(walk.rects)
}

/// The screen rectangle `hwnd` hides what lies under, as Chromium's own
/// occlusion check counts it: none unless it is visible, not minimized, not
/// cloaked (another virtual desktop, a suspended UWP frame), without
/// `WS_EX_TRANSPARENT` and not see-through layered; its frame, cut to a
/// rectangular window region, and none for an empty or shaped one.
fn occluder(hwnd: HWND) -> Option<RECT> {
	let mut cloaked = 0u32;
	// SAFETY: every call validates the handle; the out-pointers are writable
	// locals of the advertised size.
	unsafe {
		if IsWindowVisible(hwnd) == 0
			|| IsIconic(hwnd) != 0
			|| DwmGetWindowAttribute(
				hwnd,
				DWMWA_CLOAKED as u32,
				(&raw mut cloaked).cast(),
				size_of::<u32>() as u32,
			) >= 0
				&& cloaked != 0
		{
			return None;
		}
		let style = GetWindowLongW(hwnd, GWL_EXSTYLE) as u32;
		// Chromium skips such a window as an occluder even when it is opaque
		// (`IsWindowVisibleAndFullyOpaque` in ui/gfx/win/hwnd_util.cc), so it
		// keeps drawing under it and its reads stay current.
		if style & WS_EX_TRANSPARENT != 0 {
			return None;
		}
		if style & WS_EX_LAYERED != 0 {
			// Without attributes the window was drawn by UpdateLayeredWindow, with
			// per-pixel alpha.
			let (mut alpha, mut flags) = (0u8, 0u32);
			if GetLayeredWindowAttributes(hwnd, null_mut(), &raw mut alpha, &raw mut flags) == 0
				|| flags & LWA_COLORKEY != 0
				|| flags & LWA_ALPHA != 0 && alpha < u8::MAX
			{
				return None;
			}
		}
		let frame = frame_bounds(hwnd)?;
		let mut region = RECT::default();
		match GetWindowRgnBox(hwnd, &raw mut region) {
			// No window region: the whole frame shows.
			RGN_ERROR => Some(frame),
			SIMPLEREGION => {
				// The region box is relative to the window rectangle.
				let mut window = RECT::default();
				if GetWindowRect(hwnd, &raw mut window) == 0 {
					return None;
				}
				let shown = RECT {
					left:   window.left + region.left,
					top:    window.top + region.top,
					right:  window.left + region.right,
					bottom: window.top + region.bottom,
				};
				let mut both = RECT::default();
				(IntersectRect(&raw mut both, &raw const shown, &raw const frame) != 0).then_some(both)
			},
			_ => None,
		}
	}
}

/// The part of `hwnd` Windows draws on screen, in physical pixels: DWM's
/// frame bounds, which leave out the invisible resize borders.
fn frame_bounds(hwnd: HWND) -> Option<RECT> {
	let mut rect = RECT::default();
	// SAFETY: both calls validate the handle and write one RECT.
	let read = unsafe {
		DwmGetWindowAttribute(
			hwnd,
			DWMWA_EXTENDED_FRAME_BOUNDS as u32,
			(&raw mut rect).cast(),
			size_of::<RECT>() as u32,
		) >= 0
			|| GetWindowRect(hwnd, &raw mut rect) != 0
	};
	(read && rect.right > rect.left && rect.bottom > rect.top).then_some(rect)
}

/// A GDI region, deleted on drop.
struct Region(HRGN);

impl Region {
	fn new(rect: RECT) -> Option<Self> {
		// SAFETY: CreateRectRgn takes plain coordinates; null means failure.
		let region = unsafe { CreateRectRgn(rect.left, rect.top, rect.right, rect.bottom) };
		(!region.is_null()).then_some(Self(region))
	}

	/// Combines `other` into this region with `mode` and returns the
	/// result's kind.
	fn combine(&self, other: &Self, mode: RGN_COMBINE_MODE) -> GDI_REGION_TYPE {
		// SAFETY: both regions are live; GDI allows the destination to be a
		// source.
		unsafe { CombineRgn(self.0, self.0, other.0, mode) }
	}
}

impl Drop for Region {
	fn drop(&mut self) {
		// SAFETY: the region is owned here and selected into no device context.
		unsafe { DeleteObject(self.0) };
	}
}

/// Whether a Chromium or CEF renderer lives in a descendant of `hwnd`.
pub(super) fn has_chromium_descendant(hwnd: HWND) -> bool {
	unsafe extern "system" fn visit(child: HWND, state: LPARAM) -> BOOL {
		// SAFETY: `state` is the exposed address of the flag owned by the
		// enclosing call, which outlives this synchronous enumeration.
		let found = unsafe { &mut *with_exposed_provenance_mut::<bool>(state as usize) };
		*found = with_class_name(child, is_chromium_class);
		BOOL::from(!*found)
	}

	let mut found = false;
	// SAFETY: `visit` runs only during this synchronous call and receives the
	// address of `found`, which outlives it.
	unsafe {
		EnumChildWindows(hwnd, Some(visit), (&raw mut found).expose_provenance() as LPARAM);
	}
	found
}

/// Deepest visible, enabled descendant of `root` under a physical screen
/// point, with the point in that descendant's client coordinates. `None` when
/// `root` cannot map screen coordinates.
///
/// Posting to the control that owns the point keeps button presses out of the
/// top-level frame, which may activate itself in response, and lets
/// child-window controls see input for the region they own.
pub(super) fn deepest_child(root: HWND, screen: POINT) -> Option<(HWND, POINT)> {
	let mut current = root;
	for _ in 0..32 {
		let (client, child) = in_window_dpi(current, || {
			let client = physical_to_client(current, screen)?;
			// SAFETY: scalar arguments; Win32 validates the handle. The point
			// and this thread use the current window's DPI coordinate regime.
			let child = unsafe {
				ChildWindowFromPointEx(
					current,
					client,
					CWP_SKIPINVISIBLE | CWP_SKIPDISABLED | CWP_SKIPTRANSPARENT,
				)
			};
			Some((client, child))
		})??;
		// ChildWindowFromPointEx returns null outside the parent's client
		// rectangle, not the parent. Never post non-client coordinates as a
		// successful client click on the frame.
		if child.is_null() {
			return None;
		}
		// SAFETY: IsChild validates both handles.
		if child == current || unsafe { IsChild(root, child) } == 0 {
			return Some((current, client));
		}
		current = child;
	}
	None
}

/// Executes a synchronous coordinate query in the target window's DPI
/// context, restoring only this thread's context on return or unwind.
fn in_window_dpi<T>(hwnd: HWND, query: impl FnOnce() -> T) -> Option<T> {
	struct RestoreDpi(DPI_AWARENESS_CONTEXT);
	impl Drop for RestoreDpi {
		fn drop(&mut self) {
			// SAFETY: this is the context returned by the same thread's
			// successful SetThreadDpiAwarenessContext call below.
			unsafe { SetThreadDpiAwarenessContext(self.0) };
		}
	}
	// SAFETY: Win32 validates hwnd and the context it returns.
	let previous = unsafe {
		let context = GetWindowDpiAwarenessContext(hwnd);
		if context.is_null() {
			return None;
		}
		SetThreadDpiAwarenessContext(context)
	};
	if previous.is_null() {
		return None;
	}
	let _restore = RestoreDpi(previous);
	Some(query())
}

/// Converts physical screen coordinates to the target's logical screen
/// coordinates (also required by posted wheel and `WM_NCHITTEST` messages).
pub(super) fn logical_screen_point(hwnd: HWND, mut screen: POINT) -> Option<POINT> {
	// SAFETY: screen is writable and Win32 validates hwnd. This API explicitly
	// uses the target's DPI awareness regardless of the calling thread's.
	(unsafe { PhysicalToLogicalPointForPerMonitorDPI(hwnd, &mut screen) } != 0).then_some(screen)
}

fn physical_to_client(hwnd: HWND, screen: POINT) -> Option<POINT> {
	let mut client = logical_screen_point(hwnd, screen)?;
	// SAFETY: client is writable; caller has entered hwnd's DPI context.
	(unsafe { ScreenToClient(hwnd, &mut client) } != 0).then_some(client)
}

/// Target-DPI client coordinates for a physical screen point.
pub(super) fn client_point(hwnd: HWND, screen: POINT) -> Option<POINT> {
	in_window_dpi(hwnd, || physical_to_client(hwnd, screen))?
}

/// Focused descendant of `root` across every UI thread that owns part of its
/// window tree.
///
/// Top-level window procedures do not forward keyboard messages to embedded
/// editors (Scintilla, `RichEdit`, `WebView2`), and embedded renderers often
/// keep their focused child on another thread than the frame, so each
/// descendant thread's `GUITHREADINFO` is consulted. The deepest candidate
/// wins only within one ancestry chain; ambiguous branches, hidden/disabled
/// controls and same-thread sibling windows are not usable focus targets.
pub(super) fn focused_descendant(root: HWND) -> Option<HWND> {
	unsafe extern "system" fn collect(child: HWND, state: LPARAM) -> BOOL {
		// SAFETY: `state` is the exposed address of the thread list owned by
		// the enclosing call, which outlives this synchronous enumeration.
		let threads = unsafe { &mut *with_exposed_provenance_mut::<Vec<u32>>(state as usize) };
		// SAFETY: a null process-id pointer is permitted; Win32 validates the
		// handle.
		let thread = unsafe { GetWindowThreadProcessId(child, null_mut()) };
		if thread != 0 && !threads.contains(&thread) {
			threads.push(thread);
		}
		1
	}

	// SAFETY: a null process-id pointer is permitted; Win32 validates the
	// handle.
	let root_thread = unsafe { GetWindowThreadProcessId(root, null_mut()) };
	if root_thread == 0 {
		return None;
	}
	let mut threads = vec![root_thread];
	// SAFETY: `collect` runs only during this synchronous call and receives the
	// address of `threads`, which outlives it.
	unsafe {
		EnumChildWindows(root, Some(collect), (&raw mut threads).expose_provenance() as LPARAM);
	}
	let mut best: Option<(usize, HWND)> = None;
	for thread in threads {
		let mut info =
			GUITHREADINFO { cbSize: size_of::<GUITHREADINFO>() as u32, ..Default::default() };
		// SAFETY: `info` is writable and its size field is initialized.
		if unsafe { GetGUIThreadInfo(thread, &mut info) } == 0 {
			continue;
		}
		let focused = info.hwndFocus;
		// SAFETY: these predicates validate the handles; a sibling window on
		// the same GUI thread is not a focused descendant of this target.
		let eligible = unsafe {
			(focused == root || IsChild(root, focused) != 0)
				&& IsWindowVisible(focused) != 0
				&& IsWindowEnabled(focused) != 0
		};
		if focused.is_null()
			|| !eligible
			|| (!info.hwndActive.is_null() && self::root(info.hwndActive) != root)
		{
			continue;
		}
		let Some(depth) = depth_below(root, focused) else {
			continue;
		};
		if let Some((_, previous)) = best
			&& previous != focused
			// SAFETY: IsChild validates both handles. Independent child
			// threads can retain stale focus in different branches; neither
			// branch is an unambiguous keyboard target.
			&& unsafe { IsChild(previous, focused) == 0 && IsChild(focused, previous) == 0 }
		{
			return None;
		}
		if best.is_none_or(|(best_depth, _)| depth > best_depth) {
			best = Some((depth, focused));
		}
	}
	best.map(|(_, focused)| focused)
}

/// Number of parent links between `descendant` and `ancestor`.
fn depth_below(ancestor: HWND, descendant: HWND) -> Option<usize> {
	let mut depth = 0;
	let mut current = descendant;
	while current != ancestor && depth < 64 {
		// SAFETY: GetAncestor validates the handle and returns null at the top.
		current = unsafe { GetAncestor(current, GA_PARENT) };
		if current.is_null() {
			break;
		}
		depth += 1;
	}
	(current == ancestor).then_some(depth)
}

/// The process that owns `hwnd`, if the window still exists.
pub(super) fn process_id(hwnd: HWND) -> Option<u32> {
	let mut pid = 0;
	// SAFETY: `pid` is writable; Win32 validates the handle.
	unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
	(pid != 0).then_some(pid)
}

/// Refuses higher-integrity targets and unreadable tokens. An OS enqueue
/// result is not evidence that a higher-integrity application consumed input.
pub(super) fn uipi_block(hwnd: HWND) -> Option<String> {
	let mut pid = 0;
	// SAFETY: `pid` is writable; Win32 validates the handle.
	unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
	if pid == 0 {
		return Some("the target's owning process is no longer available".to_string());
	}
	// SAFETY: the pseudo-handle for the current process needs no cleanup.
	let Some(own) = integrity_level(unsafe { GetCurrentProcess() }) else {
		return Some(
			"cannot establish this process's integrity level; no input was sent".to_string(),
		);
	};
	// SAFETY: scalar arguments; a null result is handled below.
	let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
	if process.is_null() {
		return Some(format!("cannot inspect process {pid}'s integrity level; no input was sent"));
	}
	let target = integrity_level(process);
	// SAFETY: `process` was opened above and is closed exactly once.
	unsafe { CloseHandle(process) };
	let Some(target) = target else {
		return Some(format!("cannot read process {pid}'s integrity token; no input was sent"));
	};
	(target > own).then(|| {
		format!(
			"process {pid} runs at {} integrity, above this process's {} integrity, so Windows UIPI \
			 discards input sent to it; run omp at the same integrity level to drive it",
			integrity_name(target),
			integrity_name(own),
		)
	})
}

/// Mandatory integrity-level RID of `process`, or `None` when its token is
/// unreadable.
fn integrity_level(process: HANDLE) -> Option<u32> {
	let mut token: HANDLE = null_mut();
	// SAFETY: `token` is writable; `process` is a live handle owned by the
	// caller.
	if unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) } == 0 {
		return None;
	}
	// A mandatory label is a TOKEN_MANDATORY_LABEL followed by a
	// one-subauthority SID; the u64 array provides the pointer alignment.
	let mut label = [0u64; 16];
	let mut written = 0;
	// SAFETY: `label` is writable for its full byte length and `token` is live.
	let read = unsafe {
		GetTokenInformation(
			token,
			TokenIntegrityLevel,
			label.as_mut_ptr().cast(),
			size_of_val(&label) as u32,
			&mut written,
		)
	} != 0;
	// SAFETY: `token` was opened above and is closed exactly once.
	unsafe { CloseHandle(token) };
	if !read {
		return None;
	}
	// SAFETY: GetTokenInformation filled `label` with a TOKEN_MANDATORY_LABEL
	// whose SID points into the same still-live buffer.
	let sid = unsafe { (*label.as_ptr().cast::<TOKEN_MANDATORY_LABEL>()).Label.Sid };
	// SAFETY: `sid` is a valid SID inside `label`.
	let count = unsafe { GetSidSubAuthorityCount(sid) };
	if count.is_null() {
		return None;
	}
	// SAFETY: a non-null count pointer addresses the SID header inside `label`.
	let count = unsafe { *count };
	let last = u32::from(count.checked_sub(1)?);
	// SAFETY: `last` indexes an existing subauthority of `sid`.
	let rid = unsafe { GetSidSubAuthority(sid, last) };
	// SAFETY: a non-null result addresses the subauthority inside `label`.
	(!rid.is_null()).then(|| unsafe { *rid })
}

const fn integrity_name(rid: u32) -> &'static str {
	match rid {
		0x0000..0x1000 => "untrusted",
		0x1000..0x2000 => "low",
		0x2000..0x3000 => "medium",
		0x3000..0x4000 => "high",
		_ => "system",
	}
}

/// Whether `root` hosts XAML/UWP/WinUI content, whose pattern handlers call
/// `SetForegroundWindow(self)` and whose keyboard input comes only from the
/// system input queue.
pub(super) fn is_xaml_host(root: HWND) -> bool {
	with_class_name(root, |class| XAML_HOST_CLASSES.contains(&class))
		|| executable_is_any(root, &XAML_HOST_EXECUTABLES)
}

/// Whether the executable owning `hwnd` has one of the ASCII `names`,
/// compared case-insensitively against the image path's file name.
fn executable_is_any(hwnd: HWND, names: &[&str]) -> bool {
	let mut pid = 0;
	// SAFETY: `pid` is writable; Win32 validates the handle.
	unsafe { GetWindowThreadProcessId(hwnd, &mut pid) };
	if pid == 0 {
		return false;
	}
	// SAFETY: scalar arguments; a null result is handled below.
	let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
	if process.is_null() {
		return false;
	}
	let mut path = [0u16; 1024];
	let mut length = path.len() as u32;
	// SAFETY: `path` is writable for `length` units and `process` is live.
	let read = unsafe {
		QueryFullProcessImageNameW(process, PROCESS_NAME_WIN32, path.as_mut_ptr(), &mut length)
	} != 0;
	// SAFETY: `process` was opened above and is closed exactly once.
	unsafe { CloseHandle(process) };
	if !read {
		return false;
	}
	let path = &path[..(length as usize).min(path.len())];
	let file_name = path
		.iter()
		.rposition(|&unit| unit == u16::from(b'\\') || unit == u16::from(b'/'))
		.map_or(path, |separator| &path[separator + 1..]);
	names.iter().any(|name| {
		file_name.len() == name.len()
			&& file_name.iter().zip(name.bytes()).all(|(&unit, byte)| {
				u8::try_from(unit).is_ok_and(|unit| unit.eq_ignore_ascii_case(&byte))
			})
	})
}

/// Requests activation without attaching to an untrusted input queue or
/// injecting a dummy key into whichever application currently has focus.
/// Foreground-lock refusal is handled by the caller before it sends input.
pub(super) fn activate(target: HWND) -> CoreResult<bool> {
	control::check()?;
	// SAFETY: both functions take only OS-validated handles and scalar state.
	unsafe {
		SetForegroundWindow(target);
		Ok(GetForegroundWindow() == target)
	}
}

/// Waits up to `timeout` for the exact target HWND. An owned modal dialog is
/// not an equivalent input destination.
pub(super) fn wait_for_foreground(target: HWND, timeout: Duration) -> CoreResult<bool> {
	let deadline = Instant::now() + timeout;
	loop {
		control::check()?;
		// SAFETY: GetForegroundWindow has no preconditions.
		let foreground = unsafe { GetForegroundWindow() };
		if foreground == target {
			return Ok(true);
		}
		let remaining = deadline.saturating_duration_since(Instant::now());
		if remaining.is_zero() {
			return Ok(false);
		}
		control::wait(remaining.min(Duration::from_millis(10)))?;
	}
}

/// Known self-activating providers cannot be made background-safe by changing
/// `WS_EX_NOACTIVATE` (explicit `SetForegroundWindow` bypasses it), disabling
/// foreign windows (synchronous, racy and potentially permanent on a hang), or
/// restoring focus afterward (already disturbed the user and changed z-order).
pub(super) fn ensure_pattern_safe(root: HWND) -> CoreResult<()> {
	if !owns_foreground(root)
		&& (is_xaml_host(root)
			|| with_class_name(root, |class| is_chromium_class(class) || is_wpf_class(class))
			|| has_chromium_descendant(root))
	{
		return Err(DesktopError::background_unavailable(format!(
			"window {} ({}) can take foreground during UI Automation actions; no action was sent; \
			 use coordinate input instead",
			root.expose_provenance(),
			class_name(root),
		)));
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use windows_sys::Win32::{
		Graphics::Gdi::SetWindowRgn,
		System::LibraryLoader::GetModuleHandleW,
		UI::WindowsAndMessaging::{
			CreateWindowExW, DefWindowProcW, DestroyWindow, HWND_TOPMOST, RegisterClassW,
			SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW,
			SetLayeredWindowAttributes, SetWindowLongW, SetWindowPos, WNDCLASSW, WS_OVERLAPPEDWINDOW,
		},
	};

	use super::{super::capture, *};

	fn wide(text: &str) -> Vec<u16> {
		text.encode_utf16().chain(Some(0)).collect()
	}

	/// An ordinary opaque top-level window of class `class` whose visible frame
	/// is `frame`, shown without activation in the topmost band above every
	/// window made before it, so the desktop's own windows never cover it.
	fn window(class: &str, frame: RECT) -> HWND {
		let class = wide(class);
		// SAFETY: the class name outlives the call; no parent, menu or data.
		let hwnd = unsafe {
			CreateWindowExW(
				0,
				class.as_ptr(),
				class.as_ptr(),
				WS_OVERLAPPEDWINDOW,
				frame.left,
				frame.top,
				frame.right - frame.left,
				frame.bottom - frame.top,
				null_mut(),
				null_mut(),
				GetModuleHandleW(std::ptr::null()),
				std::ptr::null(),
			)
		};
		assert!(!hwnd.is_null());
		// SAFETY: this thread owns `hwnd`.
		unsafe {
			SetWindowPos(
				hwnd,
				HWND_TOPMOST,
				0,
				0,
				0,
				0,
				SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW | SWP_NOACTIVATE,
			);
		}
		place(hwnd, frame);
		hwnd
	}

	/// Moves `hwnd` so that its visible frame is `frame`, around which the
	/// window rectangle keeps its invisible resize border.
	fn place(hwnd: HWND, frame: RECT) {
		let mut window = RECT::default();
		// SAFETY: this thread owns `hwnd`; `window` is a writable RECT.
		unsafe { GetWindowRect(hwnd, &raw mut window) };
		let shown = frame_bounds(hwnd).expect("the frame of a shown window");
		let (left, top) = (shown.left - window.left, shown.top - window.top);
		let (right, bottom) = (window.right - shown.right, window.bottom - shown.bottom);
		// SAFETY: this thread owns `hwnd`.
		unsafe {
			SetWindowPos(
				hwnd,
				null_mut(),
				frame.left - left,
				frame.top - top,
				frame.right - frame.left + left + right,
				frame.bottom - frame.top + top + bottom,
				SWP_NOZORDER | SWP_NOACTIVATE,
			);
		}
	}

	const fn rect(left: i32, top: i32, right: i32, bottom: i32) -> RECT {
		RECT { left, top, right, bottom }
	}

	#[test]
	fn a_chromium_window_is_marked_only_when_nothing_of_it_shows() {
		let chromium = wide("Chrome_WidgetWin_7");
		// SAFETY: the class name outlives the registration's use in this test.
		unsafe {
			RegisterClassW(&WNDCLASSW {
				lpfnWndProc: Some(DefWindowProcW),
				hInstance: GetModuleHandleW(std::ptr::null()),
				lpszClassName: chromium.as_ptr(),
				..Default::default()
			});
		}
		let native = window("STATIC", rect(100, 100, 300, 300));
		let target = window("Chrome_WidgetWin_7", rect(100, 100, 300, 300));
		let cover = window("STATIC", rect(50, 50, 400, 400));
		let marked = |hwnd: HWND| capture::window_covered(&(hwnd as usize).to_string());
		assert!(marked(target), "an opaque window over all of it");
		assert!(!marked(native), "covered too, but the app keeps drawing");
		assert!(!marked(cover));

		place(cover, rect(50, 50, 299, 400));
		assert!(!marked(target), "one column still shows");

		place(cover, rect(50, 50, 400, 400));
		// SAFETY: this thread owns `cover`; the system owns each region it is
		// given.
		unsafe { SetWindowRgn(cover, CreateRectRgn(0, 0, 100, 100), 1) };
		assert!(!marked(target), "the cover's window region leaves most of it showing");
		// SAFETY: as above; a null region restores the whole window.
		unsafe { SetWindowRgn(cover, null_mut(), 1) };
		assert!(marked(target));

		// SAFETY: `GetWindowLongW` validates the handle.
		let plain = unsafe { GetWindowLongW(cover, GWL_EXSTYLE) };
		// SAFETY: this thread owns `cover`.
		unsafe { SetWindowLongW(cover, GWL_EXSTYLE, plain | WS_EX_TRANSPARENT as i32) };
		assert!(
			!marked(target),
			"Chromium does not count an opaque WS_EX_TRANSPARENT window as covering it"
		);
		// SAFETY: as above.
		unsafe { SetWindowLongW(cover, GWL_EXSTYLE, plain) };
		assert!(marked(target));

		// SAFETY: this thread owns `cover`.
		unsafe {
			SetWindowLongW(cover, GWL_EXSTYLE, plain | WS_EX_LAYERED as i32);
			SetLayeredWindowAttributes(cover, 0, 200, LWA_ALPHA);
		}
		assert!(!marked(target), "the target shows through a translucent window");

		place(target, rect(-30_000, -30_000, -29_800, -29_800));
		assert!(marked(target), "off every display");

		// SAFETY: this thread owns the windows.
		unsafe {
			DestroyWindow(cover);
			DestroyWindow(target);
			DestroyWindow(native);
		}
	}
}
