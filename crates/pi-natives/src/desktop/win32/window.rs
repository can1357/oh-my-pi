//! Window-handle facts and activation guards shared by Win32 input and UI
//! Automation delivery.

use std::{
	mem::size_of,
	ptr::{null_mut, with_exposed_provenance_mut},
	thread,
	time::{Duration, Instant},
};

use windows_sys::{
	Win32::{
		Foundation::{CloseHandle, HANDLE, HWND, LPARAM, POINT},
		Graphics::Gdi::ScreenToClient,
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
				EnumChildWindows, GA_PARENT, GA_ROOT, GUITHREADINFO, GetAncestor, GetClassNameW,
				GetForegroundWindow, GetGUIThreadInfo, GetWindowThreadProcessId, IsChild,
				IsWindowVisible, SetForegroundWindow,
			},
		},
	},
	core::BOOL,
};

use super::{
	super::error::{CoreResult, DesktopError},
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
/// coordinates (also required by posted wheel and WM_NCHITTEST messages).
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
		if focused.is_null()
			|| (focused != root && unsafe { IsChild(root, focused) } == 0)
			|| unsafe { IsWindowVisible(focused) } == 0
			|| unsafe { IsWindowEnabled(focused) } == 0
			|| (!info.hwndActive.is_null() && self::root(info.hwndActive) != root)
		{
			continue;
		}
		let Some(depth) = depth_below(root, focused) else { continue };
		if let Some((_, previous)) = best
			&& previous != focused
			// SAFETY: IsChild validates both handles. Independent child
			// threads can retain stale focus in different branches; neither
			// branch is an unambiguous keyboard target.
			&& unsafe { IsChild(previous, focused) } == 0
			&& unsafe { IsChild(focused, previous) } == 0
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
		return Some("cannot establish this process's integrity level; no input was sent".to_string());
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
pub(super) fn activate(target: HWND) -> bool {
	// SAFETY: both functions take only OS-validated handles and scalar state.
	unsafe {
		SetForegroundWindow(target);
		GetForegroundWindow() == target
	}
}

/// Waits up to `timeout` for the exact target HWND. An owned modal dialog is
/// not an equivalent input destination.
pub(super) fn wait_for_foreground(target: HWND, timeout: Duration) -> bool {
	let deadline = Instant::now() + timeout;
	loop {
		// SAFETY: GetForegroundWindow has no preconditions.
		let foreground = unsafe { GetForegroundWindow() };
		if foreground == target {
			return true;
		}
		if Instant::now() >= deadline {
			return false;
		}
		thread::sleep(Duration::from_millis(10));
	}
}

/// Known self-activating providers cannot be made background-safe by changing
/// WS_EX_NOACTIVATE (explicit SetForegroundWindow bypasses it), disabling
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
			 use coordinate input with takeover:true or explicitly focus the target first",
			root.expose_provenance(),
			class_name(root),
		)));
	}
	Ok(())
}
