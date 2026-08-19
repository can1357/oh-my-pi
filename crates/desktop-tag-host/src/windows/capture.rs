use std::{
	fs,
	path::{Path, PathBuf},
	ptr,
	sync::atomic::{AtomicU64, Ordering},
	time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result, bail};
use image::{ImageBuffer, Rgba};
use windows_sys::Win32::{
	Foundation::{CloseHandle, HWND, MAX_PATH, RECT},
	Graphics::{
		Dwm::{DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute},
		Gdi::{
			BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BitBlt, CAPTUREBLT, CreateCompatibleBitmap,
			CreateCompatibleDC, DIB_RGB_COLORS, DeleteDC, DeleteObject, GetDC, GetDIBits, ReleaseDC,
			SRCCOPY, SelectObject,
		},
	},
	System::Threading::{
		OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, QueryFullProcessImageNameW,
	},
	UI::{
		HiDpi::GetDpiForWindow,
		WindowsAndMessaging::{
			GetForegroundWindow, GetWindowRect, GetWindowTextLengthW, GetWindowTextW,
			GetWindowThreadProcessId,
		},
	},
};

use crate::protocol::{Bounds, CaptureManifest, ForegroundApp, VisualCapture};

static NEXT_ID: AtomicU64 = AtomicU64::new(0);

pub struct PixelSnapshot {
	pub manifest: CaptureManifest,
	pixels:       Vec<u8>,
}

pub fn snapshot_foreground(capture_root: &Path) -> Result<PixelSnapshot> {
	// SAFETY: This call takes no pointers; its nullable result is checked below.
	let hwnd = unsafe { GetForegroundWindow() };
	if hwnd.is_null() {
		bail!("no foreground window is available");
	}
	let bounds = window_bounds(hwnd)?;
	let (process_id, process_name, executable_path) = process_metadata(hwnd);
	let window_title = window_title(hwnd);
	// SAFETY: `hwnd` was returned by Win32 and checked for null above.
	let dpi = unsafe { GetDpiForWindow(hwnd) };
	let display_scale = if dpi == 0 { 1.0 } else { f64::from(dpi) / 96.0 };
	let pixels = copy_pixels(&bounds)?;
	let captured_at = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis() as u64;
	let serial = NEXT_ID.fetch_add(1, Ordering::Relaxed);
	let capture_id = format!("{captured_at:016x}-{process_id:08x}-{serial:08x}");
	let screenshot_path = capture_root.join(format!("{capture_id}.png"));
	Ok(PixelSnapshot {
		manifest: CaptureManifest {
			version: 1,
			capture_id,
			captured_at,
			mode: "window".into(),
			visual: VisualCapture { screenshot_path, selected_region: bounds, display_scale },
			foreground_app: ForegroundApp { process_id, process_name, window_title, executable_path },
		},
		pixels,
	})
}

impl PixelSnapshot {
	pub fn persist(self, capture_root: &Path) -> Result<CaptureManifest> {
		self.manifest.validate(capture_root)?;
		fs::create_dir_all(capture_root)?;
		let bounds = &self.manifest.visual.selected_region;
		let image = ImageBuffer::<Rgba<u8>, _>::from_raw(bounds.width, bounds.height, self.pixels)
			.context("invalid capture pixel buffer")?;
		let png = self.manifest.visual.screenshot_path.clone();
		let png_tmp = temporary_path(&png);
		image.save_with_format(&png_tmp, image::ImageFormat::Png)?;
		fs::rename(&png_tmp, &png)?;
		let manifest_path = capture_root.join(format!("{}.json", self.manifest.capture_id));
		let manifest_tmp = temporary_path(&manifest_path);
		fs::write(&manifest_tmp, serde_json::to_vec(&self.manifest)?)?;
		fs::rename(&manifest_tmp, manifest_path)?;
		Ok(self.manifest)
	}
}

fn temporary_path(path: &Path) -> PathBuf {
	path.with_extension(format!(
		"{}.tmp",
		path
			.extension()
			.and_then(|value| value.to_str())
			.unwrap_or("file")
	))
}

fn window_bounds(hwnd: HWND) -> Result<Bounds> {
	let mut rect = RECT::default();
	// SAFETY: `hwnd` is a live foreground-window handle and `rect` is valid
	// writable storage whose exact size is supplied.
	let dwm = unsafe {
		DwmGetWindowAttribute(
			hwnd,
			DWMWA_EXTENDED_FRAME_BOUNDS as u32,
			(&mut rect as *mut RECT).cast(),
			size_of::<RECT>() as u32,
		)
	};
	// SAFETY: `hwnd` is the same live handle and `rect` remains valid writable
	// storage.
	if dwm < 0 && unsafe { GetWindowRect(hwnd, &mut rect) } == 0 {
		return Err(std::io::Error::last_os_error()).context("read foreground window bounds");
	}
	let width = rect
		.right
		.checked_sub(rect.left)
		.filter(|value| *value > 0)
		.context("foreground window has empty bounds")? as u32;
	let height = rect
		.bottom
		.checked_sub(rect.top)
		.filter(|value| *value > 0)
		.context("foreground window has empty bounds")? as u32;
	Ok(Bounds { x: rect.left, y: rect.top, width, height })
}

fn copy_pixels(bounds: &Bounds) -> Result<Vec<u8>> {
	// SAFETY: A null window handle requests the desktop DC; the nullable result
	// is checked and released on every later path.
	let screen = unsafe { GetDC(ptr::null_mut()) };
	if screen.is_null() {
		return Err(std::io::Error::last_os_error()).context("acquire virtual screen DC");
	}
	// SAFETY: `screen` is a valid desktop DC and the nullable result is checked.
	let memory = unsafe { CreateCompatibleDC(screen) };
	// SAFETY: `screen` is valid and the positive bounds fit the Win32 dimensions.
	let bitmap =
		unsafe { CreateCompatibleBitmap(screen, bounds.width as i32, bounds.height as i32) };
	if memory.is_null() || bitmap.is_null() {
		// SAFETY: Each non-null handle was created above and has not yet been
		// released; cleanup follows the corresponding Win32 ownership rules.
		unsafe {
			if !bitmap.is_null() {
				let _ = DeleteObject(bitmap);
			}
			if !memory.is_null() {
				let _ = DeleteDC(memory);
			}
			let _ = ReleaseDC(ptr::null_mut(), screen);
		}
		return Err(std::io::Error::last_os_error()).context("allocate capture bitmap");
	}
	// SAFETY: `memory` and `bitmap` are valid compatible GDI handles.
	let old = unsafe { SelectObject(memory, bitmap) };
	// SAFETY: Both DCs are live, and the source/destination rectangles use the
	// validated positive capture bounds.
	let copied = unsafe {
		BitBlt(
			memory,
			0,
			0,
			bounds.width as i32,
			bounds.height as i32,
			screen,
			bounds.x,
			bounds.y,
			SRCCOPY | CAPTUREBLT,
		)
	};
	let byte_count = (bounds.width as usize)
		.checked_mul(bounds.height as usize)
		.and_then(|count| count.checked_mul(4))
		.context("capture is too large")?;
	let mut bgra = vec![0_u8; byte_count];
	let mut info = BITMAPINFO {
		bmiHeader: BITMAPINFOHEADER {
			biSize: size_of::<BITMAPINFOHEADER>() as u32,
			biWidth: bounds.width as i32,
			biHeight: -(bounds.height as i32),
			biPlanes: 1,
			biBitCount: 32,
			biCompression: BI_RGB,
			..Default::default()
		},
		..Default::default()
	};
	let read = if copied != 0 {
		// SAFETY: The bitmap and DC are valid, `bgra` has the exact required
		// capacity, and `info` describes the requested 32-bit output.
		unsafe {
			GetDIBits(
				memory,
				bitmap,
				0,
				bounds.height,
				bgra.as_mut_ptr().cast(),
				&mut info,
				DIB_RGB_COLORS,
			)
		}
	} else {
		0
	};
	// SAFETY: Restore the selected object before releasing each live GDI handle;
	// none of these handles is used after this block.
	unsafe {
		SelectObject(memory, old);
		DeleteObject(bitmap);
		DeleteDC(memory);
		ReleaseDC(ptr::null_mut(), screen);
	}
	if read != bounds.height as i32 {
		return Err(std::io::Error::last_os_error()).context("copy foreground window pixels");
	}
	for pixel in bgra.chunks_exact_mut(4) {
		pixel.swap(0, 2);
		pixel[3] = 255;
	}
	Ok(bgra)
}

fn window_title(hwnd: HWND) -> Option<String> {
	// SAFETY: `hwnd` is a Win32 window handle supplied by the caller.
	let length = unsafe { GetWindowTextLengthW(hwnd) };
	if length <= 0 {
		return None;
	}
	let mut buffer = vec![0_u16; length as usize + 1];
	// SAFETY: The UTF-16 buffer is writable for the advertised capacity and
	// `hwnd` is the same caller-supplied window handle.
	let copied = unsafe { GetWindowTextW(hwnd, buffer.as_mut_ptr(), buffer.len() as i32) };
	(copied > 0).then(|| String::from_utf16_lossy(&buffer[..copied as usize]))
}

fn process_metadata(hwnd: HWND) -> (u32, Option<String>, Option<PathBuf>) {
	let mut process_id = 0;
	// SAFETY: `process_id` is valid writable storage for the duration of the call.
	unsafe { GetWindowThreadProcessId(hwnd, &mut process_id) };
	// SAFETY: `process_id` came from Win32; the nullable process handle is checked.
	let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, process_id) };
	if process.is_null() {
		return (process_id, None, None);
	}
	let mut buffer = vec![0_u16; MAX_PATH as usize * 4];
	let mut length = buffer.len() as u32;
	// SAFETY: `process` is live, and `buffer` plus `length` describe writable
	// UTF-16 storage owned by this function.
	let ok = unsafe { QueryFullProcessImageNameW(process, 0, buffer.as_mut_ptr(), &mut length) };
	// SAFETY: `process` is the live handle opened above and is no longer used.
	unsafe { CloseHandle(process) };
	if ok == 0 {
		return (process_id, None, None);
	}
	let path = PathBuf::from(String::from_utf16_lossy(&buffer[..length as usize]));
	let name = path
		.file_name()
		.map(|value| value.to_string_lossy().into_owned());
	(process_id, name, Some(path))
}

use std::mem::size_of;
