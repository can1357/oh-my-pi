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
			GetCurrentProcess, GetCurrentThreadId, OpenProcess, OpenProcessToken, PROCESS_NAME_WIN32,
			PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
		},
		UI::{
			Controls::BST_CHECKED,
			HiDpi::{
				DPI_AWARENESS_CONTEXT, GetWindowDpiAwarenessContext,
				PhysicalToLogicalPointForPerMonitorDPI, SetThreadDpiAwarenessContext,
			},
			Input::KeyboardAndMouse::IsWindowEnabled,
			WindowsAndMessaging::{
				BM_CLICK, BM_GETCHECK, BS_AUTO3STATE, BS_AUTOCHECKBOX, BS_AUTORADIOBUTTON,
				BS_OWNERDRAW, CWP_SKIPDISABLED, CWP_SKIPINVISIBLE, CWP_SKIPTRANSPARENT,
				ChildWindowFromPointEx, EnumChildWindows, EnumWindows, GA_PARENT, GA_ROOT,
				GUITHREADINFO, GWL_EXSTYLE, GWL_STYLE, GetAncestor, GetClassNameW, GetForegroundWindow,
				GetGUIThreadInfo, GetLayeredWindowAttributes, GetWindowLongW, GetWindowRect,
				GetWindowThreadProcessId, IsChild, IsIconic, IsWindowVisible, LWA_ALPHA, LWA_COLORKEY,
				SetForegroundWindow, WS_EX_LAYERED, WS_EX_TOOLWINDOW, WS_EX_TRANSPARENT, WS_POPUP,
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
	delivery::{button_takes_bm_click, is_chromium_class, is_native_class, is_wpf_class},
	value_write::{Unanswered, operation_wait_ms, send_message_within},
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
/// on a display outside the windows above it in the z-order that Chromium
/// counts as covers (see [`occluder`]). An approximation of Chromium's own
/// check, whose geometry differs in places. False when any of that cannot be
/// read.
pub(super) fn fully_covered(hwnd: HWND) -> bool {
	struct Walk {
		target: HWND,
		shown:  Region,
		kind:   GDI_REGION_TYPE,
	}

	unsafe extern "system" fn visit(window: HWND, state: LPARAM) -> BOOL {
		// SAFETY: `state` is the exposed address of the walk owned by the
		// enclosing call, which outlives this synchronous enumeration.
		let walk = unsafe { &mut *with_exposed_provenance_mut::<Walk>(state as usize) };
		if window == walk.target {
			return BOOL::from(false);
		}
		if let Some(rect) = occluder(window) {
			walk.kind =
				Region::new(rect).map_or(RGN_ERROR, |cover| walk.shown.combine(&cover, RGN_DIFF));
		}
		// Every window still to come lies below what already covers it all.
		BOOL::from(walk.kind == SIMPLEREGION || walk.kind == COMPLEXREGION)
	}

	let (Some(frame), Some(displays)) = (frame_bounds(hwnd), displays()) else {
		return false;
	};
	let Some(shown) = Region::new(frame) else {
		return false;
	};
	let kind = shown.combine(&displays, RGN_AND);
	let mut walk = Walk { target: hwnd, shown, kind };
	if walk.kind == SIMPLEREGION || walk.kind == COMPLEXREGION {
		// SAFETY: `visit` runs only during this synchronous call and receives
		// the address of `walk`, which outlives it.
		unsafe {
			EnumWindows(Some(visit), (&raw mut walk).expose_provenance() as LPARAM);
		}
	}
	// Nothing left showing, whether the walk reached `hwnd` or stopped above
	// it; an error or any part still showing reads as not covered.
	walk.kind == NULLREGION
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

/// The screen rectangle `hwnd` hides what lies under, as Chromium's own
/// occlusion check counts it (`IsWindowVisibleAndFullyOpaque` in
/// `ui/gfx/win/hwnd_util.cc`): none unless it is visible, not minimized, not
/// cloaked (another virtual desktop, a suspended UWP frame), without
/// `WS_EX_TRANSPARENT`, not a tool window other than the taskbar, not a popup
/// other than the taskbar or a Chromium widget, and not see-through layered;
/// its frame, cut to a rectangular window region, and none for an empty or
/// shaped one.
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
		// Chromium skips these windows as covers even when they are opaque, so
		// it keeps drawing under them and its reads stay current.
		if style & WS_EX_TRANSPARENT != 0 {
			return None;
		}
		let tool = style & WS_EX_TOOLWINDOW != 0;
		if (tool || GetWindowLongW(hwnd, GWL_STYLE) as u32 & WS_POPUP != 0)
			&& with_class_name(hwnd, |class| {
				class != "Shell_TrayWnd" && (tool || !class.starts_with("Chrome_WidgetWin_"))
			}) {
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

/// A system or `WinForms` button whose click `BM_CLICK` performs
/// ([`click_button`]).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum NativeButton {
	/// Enabled together with every window up to its top-level one.
	Enabled,
	/// Disabled, itself or through a window above it (a form behind its modal
	/// dialog disables its children): a click would do nothing.
	Disabled,
}

/// Whether `hwnd` is a button [`click_button`] can click, and whether it is
/// enabled; `None` for other windows, group boxes, split buttons and windows
/// owned by this thread, whose synchronous message handlers cannot time out.
pub(super) fn native_button(hwnd: HWND) -> Option<NativeButton> {
	// SAFETY: these APIs only query thread identifiers.
	if unsafe { GetWindowThreadProcessId(hwnd, null_mut()) == GetCurrentThreadId() }
		|| !with_class_name(hwnd, |class| is_native_class(class, "Button"))
	{
		return None;
	}
	// SAFETY: GetWindowLongW only queries the handle.
	let style = unsafe { GetWindowLongW(hwnd, GWL_STYLE) } as u32;
	if !button_takes_bm_click(style) {
		return None;
	}
	let top = root(hwnd);
	let mut current = hwnd;
	loop {
		// SAFETY: IsWindowEnabled only queries the handle.
		if current.is_null() || unsafe { IsWindowEnabled(current) } == 0 {
			return Some(NativeButton::Disabled);
		}
		if current == top {
			return Some(NativeButton::Enabled);
		}
		// SAFETY: GetAncestor only queries the handle.
		current = unsafe { GetAncestor(current, GA_PARENT) };
	}
}

/// Whether a click on button `hwnd` means the same wherever it lands: every
/// `WinForms` button, and system buttons the system draws. A Win32
/// owner-drawn button paints itself and may give the point meaning, so a
/// pointer click on it stays a click at that point.
pub(super) fn click_ignores_point(hwnd: HWND) -> bool {
	with_class_name(hwnd, |class| !class.eq_ignore_ascii_case("Button"))
		// SAFETY: GetWindowLongW only queries the handle.
		|| unsafe { GetWindowLongW(hwnd, GWL_STYLE) } as u32 & 0xf != BS_OWNERDRAW as u32
}

/// System automatic buttons expose their state through `BM_GETCHECK`.
pub(super) fn native_auto_button(hwnd: HWND) -> bool {
	with_class_name(hwnd, |class| class.eq_ignore_ascii_case("Button"))
		&& matches!(
			// SAFETY: GetWindowLongW only queries the handle.
			unsafe { GetWindowLongW(hwnd, GWL_STYLE) } & 0xf,
			BS_AUTOCHECKBOX | BS_AUTO3STATE | BS_AUTORADIOBUTTON
		)
}

/// Sends a system or `WinForms` button its own `BM_CLICK` message and waits
/// for the answer. A reply alone does not prove that the app acted on it.
/// UI Automation's `Invoke` on these buttons activates their window first,
/// taking the foreground and the user's next keys, and a press and release
/// posted to the button can leave it unclicked. An automatic check box must
/// change state and an automatic radio button must end up checked, or the click
/// is reported as not taken. The click is sent only while the button is still
/// an enabled one inside `top`, the top-level window it was found in.
pub(super) fn click_button(hwnd: HWND, top: HWND) -> CoreResult<()> {
	let id = hwnd.expose_provenance();
	if let Some(reason) = uipi_block(hwnd) {
		return Err(DesktopError::permission_denied(format!(
			"button {id} cannot receive synthetic input: {reason}"
		)));
	}
	// SAFETY: GetWindowLongW only queries the handle.
	let kind = unsafe { GetWindowLongW(hwnd, GWL_STYLE) } as u32 & 0xf;
	let checkable = native_auto_button(hwnd);
	let send = |message| send_message_within(hwnd, message, 0, 0, false, operation_wait_ms());
	let check_state = || send(BM_GETCHECK).ok();
	let before = if checkable {
		Some(check_state().ok_or_else(|| {
			DesktopError::input_failed(format!(
				"button {id} did not report its check state; no input was sent"
			))
		})?)
	} else {
		None
	};
	control::check()?;
	// The state read and the caller's own queries run app code, which can
	// disable the button or move it into another window.
	if native_button(hwnd) != Some(NativeButton::Enabled) || root(hwnd) != top {
		return Err(DesktopError::input_failed(format!(
			"button {id} is no longer an eligible enabled button inside window {}, or its window is \
			 disabled; nothing was clicked",
			top.expose_provenance()
		)));
	}
	// The point past which a fenced AX request reports `AxUnconfirmed` rather
	// than `Timeout` if its reply wait ends: from here the click may land.
	control::dispatching()?;
	// A click that may have landed is reported as `InputFailed` with wording
	// that says so, not `AxUnconfirmed`: naming its target would query the same
	// possibly blocked app again.
	match send(BM_CLICK) {
		Ok(_) => {},
		Err(Unanswered::NoAnswer) => {
			return Err(DesktopError::input_failed(format!(
				"button {id}'s BM_CLICK was not confirmed and may already have taken effect; inspect \
				 the target before clicking again"
			)));
		},
		Err(Unanswered::Undelivered | Unanswered::OtherThread) => {
			return Err(DesktopError::input_failed(format!(
				"button {id} could not be sent BM_CLICK; nothing was clicked"
			)));
		},
	}
	let Some(before) = before else { return Ok(()) };
	// A control destroyed by its click reads as no answer here: the click may
	// have landed without changing anything.
	let Some(after) = check_state() else {
		return Err(DesktopError::input_failed(format!(
			"button {id} answered BM_CLICK but did not report its check state afterwards, so the \
			 click may have taken effect; inspect the target before clicking again"
		)));
	};
	let taken = if kind as i32 == BS_AUTORADIOBUTTON {
		after == BST_CHECKED as isize
	} else {
		after != before
	};
	if !taken {
		let state = if kind as i32 == BS_AUTORADIOBUTTON {
			"it was not checked after the click"
		} else {
			"its check state did not change"
		};
		return Err(DesktopError::input_failed(format!(
			"button {id} answered BM_CLICK but {state}; the app may have refused the click"
		)));
	}
	Ok(())
}

#[cfg(test)]
pub(super) mod tests {
	use std::cell::Cell;

	use windows_sys::Win32::{
		Foundation::{HWND, LPARAM, LRESULT, WPARAM},
		Graphics::Gdi::SetWindowRgn,
		System::LibraryLoader::GetModuleHandleW,
		UI::{
			Controls::{BST_CHECKED, BST_UNCHECKED},
			Input::KeyboardAndMouse::EnableWindow,
			WindowsAndMessaging::{
				BM_CLICK, BM_GETCHECK, BN_CLICKED, BS_AUTOCHECKBOX, BS_GROUPBOX, BS_OWNERDRAW,
				BS_PUSHBUTTON, CallWindowProcW, CreateWindowExW, DefWindowProcW, DestroyWindow,
				GWLP_WNDPROC, GetClassInfoW, GetParent, HWND_TOPMOST, RegisterClassW, SWP_NOACTIVATE,
				SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SWP_SHOWWINDOW, SendMessageW,
				SetLayeredWindowAttributes, SetParent, SetWindowLongPtrW, SetWindowLongW, SetWindowPos,
				WM_COMMAND, WM_LBUTTONDOWN, WM_LBUTTONUP, WNDCLASSW, WNDPROC, WS_CHILD, WS_OVERLAPPED,
				WS_OVERLAPPEDWINDOW,
			},
		},
	};

	use super::{
		super::{super::error::ErrorCode, capture},
		*,
	};

	/// Owns fixture windows on a pumping thread, separate from the caller
	/// sending bounded synchronous messages to them.
	pub(in crate::desktop::win32) struct ButtonThread {
		jobs:   std::sync::mpsc::Sender<Box<dyn FnOnce() + Send>>,
		id:     u32,
		thread: Option<std::thread::JoinHandle<()>>,
	}

	impl ButtonThread {
		pub(in crate::desktop::win32) fn new() -> Self {
			let (jobs, receive) = std::sync::mpsc::channel::<Box<dyn FnOnce() + Send>>();
			let (ready, started) = std::sync::mpsc::sync_channel(1);
			let thread = std::thread::spawn(move || {
				use windows_sys::Win32::UI::WindowsAndMessaging::{
					DispatchMessageW, GetMessageW, MSG, PM_NOREMOVE, PeekMessageW, WM_APP,
				};
				let mut message = MSG::default();
				// SAFETY: creates this thread's message queue before publishing its
				// id.
				unsafe { PeekMessageW(&raw mut message, null_mut(), 0, 0, PM_NOREMOVE) };
				// SAFETY: queries only this thread.
				ready.send(unsafe { GetCurrentThreadId() }).unwrap();
				// SAFETY: message is writable; the loop dispatches only this
				// thread's messages.
				while unsafe { GetMessageW(&raw mut message, null_mut(), 0, 0) } > 0 {
					if message.hwnd.is_null() && message.message == WM_APP {
						receive.recv().unwrap()();
					} else {
						// SAFETY: GetMessageW filled message.
						unsafe { DispatchMessageW(&raw const message) };
					}
				}
			});
			Self { jobs, id: started.recv().expect("fixture thread started"), thread: Some(thread) }
		}

		pub(in crate::desktop::win32) fn run<R: Send + 'static>(
			&self,
			job: impl FnOnce() -> R + Send + 'static,
		) -> R {
			use windows_sys::Win32::UI::WindowsAndMessaging::{PostThreadMessageW, WM_APP};
			let (send, receive) = std::sync::mpsc::sync_channel(1);
			self
				.jobs
				.send(Box::new(move || {
					let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(job));
					let _ = send.send(result);
				}))
				.unwrap();
			// SAFETY: new() has created the thread's queue; it lives until Drop.
			assert_ne!(unsafe { PostThreadMessageW(self.id, WM_APP, 0, 0) }, 0);
			match receive.recv().expect("fixture thread answered") {
				Ok(result) => result,
				Err(panic) => std::panic::resume_unwind(panic),
			}
		}
	}

	impl Drop for ButtonThread {
		fn drop(&mut self) {
			use windows_sys::Win32::UI::WindowsAndMessaging::{PostThreadMessageW, WM_QUIT};
			// SAFETY: the fixture thread's queue exists until it handles WM_QUIT.
			let posted = unsafe { PostThreadMessageW(self.id, WM_QUIT, 0, 0) };
			// Never join a thread that could still be waiting for messages.
			if !std::thread::panicking() {
				assert_ne!(posted, 0);
				self.thread.take().unwrap().join().unwrap();
			}
		}
	}

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
		unsafe { SetWindowLongW(cover, GWL_EXSTYLE, plain | WS_EX_TOOLWINDOW as i32) };
		assert!(!marked(target), "Chromium does not count an opaque tool window as covering it");
		// SAFETY: as above.
		unsafe { SetWindowLongW(cover, GWL_EXSTYLE, plain) };
		assert!(marked(target));

		// SAFETY: `GetWindowLongW` validates the handle.
		let framed = unsafe { GetWindowLongW(cover, GWL_STYLE) };
		// SAFETY: this thread owns `cover`.
		unsafe { SetWindowLongW(cover, GWL_STYLE, framed | WS_POPUP as i32) };
		assert!(!marked(target), "Chromium does not count an opaque popup as covering it");
		let widget = window("Chrome_WidgetWin_7", rect(50, 50, 400, 400));
		// SAFETY: this thread owns `widget`.
		unsafe {
			let style = GetWindowLongW(widget, GWL_STYLE);
			SetWindowLongW(widget, GWL_STYLE, style | WS_POPUP as i32);
		}
		assert!(marked(target), "but it counts a popup of its own");
		// SAFETY: this thread owns both windows.
		unsafe {
			DestroyWindow(widget);
			SetWindowLongW(cover, GWL_STYLE, framed);
		}
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

	std::thread_local! {
		static PARENT_PROC: Cell<WNDPROC> = const { Cell::new(None) };
		static BUTTON_PROC: Cell<WNDPROC> = const { Cell::new(None) };
		static CLICKS: Cell<usize> = const { Cell::new(0) };
		static DISABLE_ON_CHECK: Cell<bool> = const { Cell::new(false) };
		static MOVE_ON_CHECK: Cell<HWND> = const { Cell::new(std::ptr::null_mut()) };
		static DESTROY_ON_CLICK: Cell<bool> = const { Cell::new(false) };
		static CLICK_MESSAGES: Cell<usize> = const { Cell::new(0) };
		static PRESSED_AT: Cell<Option<(i32, i32)>> = const { Cell::new(None) };
	}

	unsafe extern "system" fn counting_parent(
		hwnd: HWND,
		message: u32,
		wparam: WPARAM,
		lparam: LPARAM,
	) -> LRESULT {
		if message == WM_COMMAND && ((wparam >> 16) & 0xffff) as u32 == BN_CLICKED {
			CLICKS.with(|clicks| clicks.set(clicks.get() + 1));
		}
		// SAFETY: the test saved this parent's original procedure.
		unsafe { CallWindowProcW(PARENT_PROC.with(Cell::get), hwnd, message, wparam, lparam) }
	}

	/// A check box whose app swallows the release, so a click never lands. On
	/// request, reading its state disables its form or moves it into another
	/// window, and its click destroys it.
	unsafe extern "system" fn refusing_button(
		hwnd: HWND,
		message: u32,
		wparam: WPARAM,
		lparam: LPARAM,
	) -> LRESULT {
		if message == BM_GETCHECK {
			if DISABLE_ON_CHECK.with(|disable| disable.replace(false)) {
				// SAFETY: this fixture owns the button and its parent.
				unsafe { EnableWindow(GetParent(hwnd), 0) };
			}
			let other = MOVE_ON_CHECK.with(|other| other.replace(std::ptr::null_mut()));
			if !other.is_null() {
				// SAFETY: this fixture owns the button and both windows.
				unsafe { SetParent(hwnd, other) };
			}
		}
		if message == BM_CLICK {
			CLICK_MESSAGES.with(|clicks| clicks.set(clicks.get() + 1));
			if DESTROY_ON_CLICK.with(|destroy| destroy.replace(false)) {
				// SAFETY: this fixture owns the button.
				unsafe { DestroyWindow(hwnd) };
				return 0;
			}
		}
		if message == WM_LBUTTONUP {
			return 0;
		}
		// SAFETY: the test saved this button's original procedure.
		unsafe { CallWindowProcW(BUTTON_PROC.with(Cell::get), hwnd, message, wparam, lparam) }
	}

	/// A button that records its click messages and where it was pressed.
	unsafe extern "system" fn recording_button(
		hwnd: HWND,
		message: u32,
		wparam: WPARAM,
		lparam: LPARAM,
	) -> LRESULT {
		if message == BM_CLICK {
			CLICK_MESSAGES.with(|clicks| clicks.set(clicks.get() + 1));
		}
		if message == WM_LBUTTONDOWN {
			let point = (i32::from(lparam as i16), i32::from((lparam >> 16) as i16));
			PRESSED_AT.with(|pressed| pressed.set(Some(point)));
		}
		// SAFETY: the test saved this button's original procedure.
		unsafe { CallWindowProcW(BUTTON_PROC.with(Cell::get), hwnd, message, wparam, lparam) }
	}

	/// Replaces `button`'s window procedure with `procedure`, which forwards
	/// to the saved original.
	fn subclass(button: HWND, procedure: WNDPROC) {
		// SAFETY: this thread owns `button`; the original procedure is saved
		// before any message reaches the replacement.
		unsafe {
			let original = SetWindowLongPtrW(
				button,
				GWLP_WNDPROC,
				procedure.map_or(0, |procedure| procedure as usize as isize),
			);
			BUTTON_PROC.with(|proc| proc.set(std::mem::transmute::<isize, WNDPROC>(original)));
		}
	}

	fn top_level() -> HWND {
		// SAFETY: the strings outlive the synchronous call.
		let hwnd = unsafe {
			CreateWindowExW(
				0,
				wide("STATIC").as_ptr(),
				wide("").as_ptr(),
				WS_OVERLAPPED,
				0,
				0,
				200,
				100,
				std::ptr::null_mut(),
				std::ptr::null_mut(),
				std::ptr::null_mut(),
				std::ptr::null(),
			)
		};
		assert!(!hwnd.is_null());
		hwnd
	}

	/// A hidden top-level window counting its buttons' `BN_CLICKED`
	/// notifications ([`clicks`]).
	pub(in crate::desktop::win32) fn button_parent() -> HWND {
		let parent = top_level();
		// SAFETY: this thread owns `parent`; its original procedure is saved
		// before any message reaches the replacement.
		unsafe {
			let original =
				SetWindowLongPtrW(parent, GWLP_WNDPROC, counting_parent as *const () as isize);
			PARENT_PROC.with(|proc| proc.set(std::mem::transmute::<isize, WNDPROC>(original)));
		}
		parent
	}

	/// An 80 x 20 button of `class` and `style` at the top left of `parent`.
	pub(in crate::desktop::win32) fn button(parent: HWND, class: &str, style: u32) -> HWND {
		// SAFETY: the strings outlive the synchronous call.
		let button = unsafe {
			CreateWindowExW(
				0,
				wide(class).as_ptr(),
				wide("b").as_ptr(),
				WS_CHILD | style,
				0,
				0,
				80,
				20,
				parent,
				1 as _,
				GetModuleHandleW(std::ptr::null()),
				std::ptr::null(),
			)
		};
		assert!(!button.is_null());
		button
	}

	/// Name of a `WinForms`-named subclass of the system button class,
	/// registered once per process.
	pub(in crate::desktop::win32) fn winforms_button_class() -> &'static str {
		const NAME: &str = "WindowsForms10.BUTTON.app.0.omp_test";
		static REGISTER: std::sync::Once = std::sync::Once::new();
		REGISTER.call_once(|| {
			// SAFETY: `class` is a writable WNDCLASSW; Win32 copies the class
			// name during registration.
			unsafe {
				let mut class: WNDCLASSW = std::mem::zeroed();
				assert_ne!(
					GetClassInfoW(std::ptr::null_mut(), wide("BUTTON").as_ptr(), &raw mut class),
					0
				);
				let name = wide(NAME);
				class.hInstance = GetModuleHandleW(std::ptr::null());
				class.lpszClassName = name.as_ptr();
				assert_ne!(RegisterClassW(&raw const class), 0);
			}
		});
		NAME
	}

	/// Records `button`'s click messages ([`click_messages`]) and where it is
	/// pressed ([`pressed_at`]) from now on.
	pub(in crate::desktop::win32) fn record(button: HWND) {
		CLICK_MESSAGES.with(|clicks| clicks.set(0));
		PRESSED_AT.with(|pressed| pressed.set(None));
		subclass(button, Some(recording_button));
	}

	pub(in crate::desktop::win32) fn clicks() -> usize {
		CLICKS.with(Cell::get)
	}

	pub(in crate::desktop::win32) fn click_messages() -> usize {
		CLICK_MESSAGES.with(Cell::get)
	}

	/// Client point of the last `WM_LBUTTONDOWN` a recorded button received.
	pub(in crate::desktop::win32) fn pressed_at() -> Option<(i32, i32)> {
		PRESSED_AT.with(Cell::get)
	}

	#[test]
	fn button_clicks_land_before_returning_and_unchanged_check_boxes_fail() {
		let fixture = ButtonThread::new();
		let parent_id = fixture.run(|| button_parent() as usize);
		let parent = parent_id as HWND;
		let child = |style: i32| {
			fixture.run(move || button(parent_id as HWND, "BUTTON", style as u32) as usize) as HWND
		};
		// SAFETY: handles remain live on the fixture thread until cleanup.
		unsafe {
			let check = |button| SendMessageW(button, BM_GETCHECK, 0, 0);

			// Synchronous delivery must finish before click_button reports
			// success.
			let pushed = child(BS_PUSHBUTTON);
			let group = child(BS_GROUPBOX);
			assert_eq!(native_button(pushed), Some(NativeButton::Enabled));
			assert_eq!(native_button(group), None);
			click_button(pushed, parent).unwrap();
			assert_eq!(fixture.run(clicks), 1);
			EnableWindow(pushed, 0);
			assert_eq!(native_button(pushed), Some(NativeButton::Disabled));
			// A pointer click on a Win32 owner-drawn button stays a click at
			// its point; the system draws (and so ignores the point of) the rest.
			assert!(click_ignores_point(pushed));
			assert!(!click_ignores_point(child(BS_OWNERDRAW)));

			let toggles = child(BS_AUTOCHECKBOX);
			click_button(toggles, parent).unwrap();
			assert_eq!(check(toggles), BST_CHECKED as isize);

			let refuses = child(BS_AUTOCHECKBOX);
			let refuses_id = refuses as usize;
			fixture.run(move || subclass(refuses_id as HWND, Some(refusing_button)));
			let error = click_button(refuses, parent).unwrap_err();
			assert!(matches!(error.code, ErrorCode::InputFailed), "{error:?}");
			assert_eq!(check(refuses), BST_UNCHECKED as isize);

			// The pre-read can synchronously disable the form. Recheck before
			// delivery, not only when classifying the original target.
			fixture.run(|| {
				CLICK_MESSAGES.with(|clicks| clicks.set(0));
				DISABLE_ON_CHECK.with(|disable| disable.set(true));
			});
			let error = click_button(refuses, parent).unwrap_err();
			assert!(matches!(error.code, ErrorCode::InputFailed), "{error:?}");
			assert_eq!(fixture.run(click_messages), 0);
			assert_eq!(check(refuses), BST_UNCHECKED as isize);
			EnableWindow(parent, 1);

			// It can also move the button into another enabled window, where
			// it is still an eligible button: not the window asked for.
			let other_id = fixture.run(|| top_level() as usize);
			let other = other_id as HWND;
			fixture.run(move || MOVE_ON_CHECK.with(|target| target.set(other_id as HWND)));
			let error = click_button(refuses, parent).unwrap_err();
			assert!(matches!(error.code, ErrorCode::InputFailed), "{error:?}");
			assert_eq!(GetParent(refuses), other);
			assert_eq!(native_button(refuses), Some(NativeButton::Enabled));
			assert_eq!(fixture.run(click_messages), 0);
			fixture.run(move || {
				DestroyWindow(other_id as HWND);
			});

			// A check box destroyed by its click leaves no state to read: the
			// click may have landed, so neither ok nor unsent.
			let destroyed = child(BS_AUTOCHECKBOX);
			let destroyed_id = destroyed as usize;
			fixture.run(move || {
				subclass(destroyed_id as HWND, Some(refusing_button));
				DESTROY_ON_CLICK.with(|destroy| destroy.set(true));
			});
			let error = click_button(destroyed, parent).unwrap_err();
			assert!(matches!(error.code, ErrorCode::InputFailed), "{error:?}");
			assert!(error.message.contains("may have taken effect"), "{error:?}");
			assert_eq!(fixture.run(click_messages), 1);

			// A disabled parent (a form behind its modal dialog) disables the
			// buttons inside it.
			assert_eq!(native_button(toggles), Some(NativeButton::Enabled));
			EnableWindow(parent, 0);
			assert_eq!(native_button(toggles), Some(NativeButton::Disabled));
			fixture.run(move || {
				DestroyWindow(parent_id as HWND);
			});
		}
	}

	#[test]
	fn same_thread_buttons_do_not_take_the_synchronous_click_route() {
		let parent = button_parent();
		let pushed = button(parent, "BUTTON", BS_PUSHBUTTON as u32);
		// Observe the routing decision, without entering a modal handler or
		// relying on a timeout to rescue the test.
		assert_eq!(native_button(pushed), None);
		// SAFETY: this thread owns parent and its child.
		unsafe { DestroyWindow(parent) };
	}
}
