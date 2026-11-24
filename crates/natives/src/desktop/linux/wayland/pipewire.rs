//! The client calls behind Wayland screen capture, resolved from the system's
//! `libpipewire-0.3.so.0` on first use. Linking the library would stop the
//! addon from loading on hosts without it, so only its stable C ABI is
//! declared here, and the two SPA PODs a capture stream exchanges are encoded
//! and decoded by hand.

use std::{
	ffi::{CStr, c_char, c_int, c_void},
	ptr,
	sync::LazyLock,
	time::Duration,
};

/// Soname of the 0.3 client ABI, shared by every 0.3.x and 1.x release.
const LIBRARY: &CStr = c"libpipewire-0.3.so.0";

static PIPEWIRE: LazyLock<Result<PipeWire, String>> = LazyLock::new(|| load(LIBRARY));

/// The loaded library, or why it could not be loaded.
pub(super) type Loaded = Result<&'static PipeWire, &'static str>;

pub(super) fn library() -> Loaded {
	PIPEWIRE.as_ref().map_err(String::as_str)
}

#[repr(C)]
pub(super) struct MainLoop([u8; 0]);
#[repr(C)]
pub(super) struct Context([u8; 0]);
#[repr(C)]
pub(super) struct Core([u8; 0]);
#[repr(C)]
pub(super) struct Properties([u8; 0]);
#[repr(C)]
pub(super) struct Stream([u8; 0]);

/// Declares the library functions capture calls and resolves each by its C
/// name.
macro_rules! functions {
	($($name:ident($($arg:ty),*) $(-> $ret:ty)?;)*) => {
		pub(super) struct PipeWire {
			$(pub(super) $name: unsafe extern "C" fn($($arg),*) $(-> $ret)?,)*
		}

		impl PipeWire {
			/// # Safety
			/// `handle` is a live `dlopen` handle.
			unsafe fn resolve(handle: *mut c_void, library: &CStr) -> Result<Self, String> {
				Ok(Self {$(
					$name: {
						let symbol = concat!(stringify!($name), "\0");
						// SAFETY: `handle` is live and `symbol` is NUL-terminated.
						let pointer = unsafe { libc::dlsym(handle, symbol.as_ptr().cast()) };
						if pointer.is_null() {
							return Err(format!(
								"{} lacks {}",
								library.to_string_lossy(),
								stringify!($name)
							));
						}
						// SAFETY: the declaration matches the function's prototype in
						// the PipeWire 0.3 headers.
						unsafe {
							std::mem::transmute::<*mut c_void, unsafe extern "C" fn($($arg),*) $(-> $ret)?>(
								pointer,
							)
						}
					},
				)*})
			}
		}
	};
}

functions! {
	pw_init(*mut c_int, *mut *mut *mut c_char);
	pw_main_loop_new(*const SpaDict) -> *mut MainLoop;
	pw_main_loop_get_loop(*mut MainLoop) -> *mut Loop;
	pw_main_loop_destroy(*mut MainLoop);
	pw_context_new(*mut Loop, *mut Properties, usize) -> *mut Context;
	pw_context_connect_fd(*mut Context, c_int, *mut Properties, usize) -> *mut Core;
	pw_context_destroy(*mut Context);
	pw_core_disconnect(*mut Core) -> c_int;
	pw_properties_new_dict(*const SpaDict) -> *mut Properties;
	pw_stream_new(*mut Core, *const c_char, *mut Properties) -> *mut Stream;
	pw_stream_add_listener(*mut Stream, *mut SpaHook, *const StreamEvents, *mut c_void);
	pw_stream_connect(*mut Stream, u32, u32, u32, *mut *const SpaPod, u32) -> c_int;
	pw_stream_dequeue_buffer(*mut Stream) -> *mut Buffer;
	pw_stream_queue_buffer(*mut Stream, *mut Buffer) -> c_int;
	pw_stream_destroy(*mut Stream);
}

fn load(name: &CStr) -> Result<PipeWire, String> {
	// SAFETY: `name` is NUL-terminated. The handle is never closed: PipeWire
	// keeps plugin handles and threads alive for the process lifetime.
	let handle = unsafe { libc::dlopen(name.as_ptr(), libc::RTLD_NOW | libc::RTLD_LOCAL) };
	if handle.is_null() {
		// SAFETY: dlerror returns a NUL-terminated string or null.
		let detail = unsafe { libc::dlerror() };
		let detail = if detail.is_null() {
			"unknown error".into()
		} else {
			// SAFETY: non-null dlerror results are valid C strings.
			unsafe { CStr::from_ptr(detail) }.to_string_lossy()
		};
		return Err(format!("{} could not be loaded ({detail})", name.to_string_lossy()));
	}
	// SAFETY: `handle` came from the successful dlopen above.
	let pipewire = unsafe { PipeWire::resolve(handle, name) }?;
	// SAFETY: pw_init accepts null arguments and may be called more than once.
	unsafe { (pipewire.pw_init)(ptr::null_mut(), ptr::null_mut()) };
	Ok(pipewire)
}

pub(super) const SPA_DIRECTION_INPUT: u32 = 0;
pub(super) const PW_STREAM_FLAG_AUTOCONNECT: u32 = 1 << 0;
pub(super) const PW_STREAM_FLAG_MAP_BUFFERS: u32 = 1 << 2;
pub(super) const PW_VERSION_STREAM_EVENTS: u32 = 2;

/// `struct spa_dict`.
#[repr(C)]
pub(super) struct SpaDict {
	pub(super) flags:   u32,
	pub(super) n_items: u32,
	pub(super) items:   *const SpaDictItem,
}

/// `struct spa_dict_item`.
#[repr(C)]
pub(super) struct SpaDictItem {
	pub(super) key:   *const c_char,
	pub(super) value: *const c_char,
}

/// `struct spa_hook`: zeroed by its owner, then linked into a listener list
/// by the library.
#[repr(C)]
pub(super) struct SpaHook([*mut c_void; 6]);

impl SpaHook {
	pub(super) const fn new() -> Self {
		Self([ptr::null_mut(); 6])
	}
}

type Unused = Option<unsafe extern "C" fn()>;

/// `struct pw_stream_events` at version 2, with the two callbacks capture
/// uses.
#[repr(C)]
pub(super) struct StreamEvents {
	version:       u32,
	destroy:       Unused,
	state_changed: Unused,
	control_info:  Unused,
	io_changed:    Unused,
	param_changed: Option<unsafe extern "C" fn(*mut c_void, u32, *const SpaPod)>,
	add_buffer:    Unused,
	remove_buffer: Unused,
	process:       Option<unsafe extern "C" fn(*mut c_void)>,
	drained:       Unused,
	command:       Unused,
	trigger_done:  Unused,
}

impl StreamEvents {
	pub(super) const fn new(
		param_changed: unsafe extern "C" fn(*mut c_void, u32, *const SpaPod),
		process: unsafe extern "C" fn(*mut c_void),
	) -> Self {
		Self {
			version:       PW_VERSION_STREAM_EVENTS,
			destroy:       None,
			state_changed: None,
			control_info:  None,
			io_changed:    None,
			param_changed: Some(param_changed),
			add_buffer:    None,
			remove_buffer: None,
			process:       Some(process),
			drained:       None,
			command:       None,
			trigger_done:  None,
		}
	}
}

/// The leading fields of `struct pw_loop`.
#[repr(C)]
pub(super) struct Loop {
	system:  *mut c_void,
	handle:  *mut c_void,
	control: *const SpaInterface,
}

/// `struct spa_interface`.
#[repr(C)]
struct SpaInterface {
	type_:   *const c_char,
	version: u32,
	methods: *const LoopControlMethods,
	object:  *mut c_void,
}

/// The leading fields of `struct spa_loop_control_methods`.
#[repr(C)]
struct LoopControlMethods {
	version:  u32,
	get_fd:   Unused,
	add_hook: Unused,
	enter:    Option<unsafe extern "C" fn(*mut c_void)>,
	leave:    Option<unsafe extern "C" fn(*mut c_void)>,
	iterate:  Option<unsafe extern "C" fn(*mut c_void, c_int) -> c_int>,
}

/// Dispatch the loop's ready events, waiting up to `timeout` for one; what
/// the header-only `pw_loop_enter`, `pw_loop_iterate` and `pw_loop_leave` do.
/// Returns a negative errno when the loop failed.
///
/// # Safety
/// `pw_loop` is the live loop of a main loop owned by the calling thread.
pub(super) unsafe fn iterate(pw_loop: *mut Loop, timeout: Duration) -> c_int {
	// SAFETY: a live pw_loop always carries its loop-control interface.
	let control = unsafe { &*(*pw_loop).control };
	// SAFETY: the interface's method table lives as long as the loop.
	let methods = unsafe { &*control.methods };
	let (Some(enter), Some(leave), Some(iterate)) = (methods.enter, methods.leave, methods.iterate)
	else {
		return -libc::ENOTSUP;
	};
	let timeout = c_int::try_from(timeout.as_millis()).unwrap_or(c_int::MAX);
	// SAFETY: each method receives the interface's own object, on the thread
	// that owns the loop.
	unsafe {
		enter(control.object);
		let result = iterate(control.object, timeout);
		leave(control.object);
		result
	}
}

/// The leading field of `struct pw_buffer`.
#[repr(C)]
pub(super) struct Buffer {
	buffer: *mut SpaBuffer,
}

/// `struct spa_buffer`.
#[repr(C)]
struct SpaBuffer {
	n_metas: u32,
	n_datas: u32,
	metas:   *mut c_void,
	datas:   *mut SpaData,
}

/// `struct spa_data`.
#[repr(C)]
struct SpaData {
	type_:     u32,
	flags:     u32,
	fd:        i64,
	mapoffset: u32,
	maxsize:   u32,
	data:      *mut c_void,
	chunk:     *const SpaChunk,
}

/// `struct spa_chunk`: where the producer wrote the frame in a data plane.
#[repr(C)]
#[derive(Clone, Copy)]
pub(super) struct SpaChunk {
	pub(super) offset: u32,
	pub(super) size:   u32,
	pub(super) stride: i32,
	flags:             i32,
}

/// The first data plane of a dequeued buffer.
pub(super) struct Plane<'a> {
	/// The plane's mapped memory, absent when it was not mapped.
	pub(super) memory: Option<&'a [u8]>,
	pub(super) chunk:  SpaChunk,
}

/// The first data plane of `buffer`, absent when it has none.
///
/// # Safety
/// `buffer` was dequeued from a stream and stays dequeued for `'a`.
pub(super) unsafe fn first_plane<'a>(buffer: *mut Buffer) -> Option<Plane<'a>> {
	// SAFETY: a dequeued pw_buffer points at its spa_buffer.
	let buffer = unsafe { &*(*buffer).buffer };
	if buffer.n_datas == 0 || buffer.datas.is_null() {
		return None;
	}
	// SAFETY: `datas` holds `n_datas` (at least one) entries.
	let data = unsafe { &*buffer.datas };
	if data.chunk.is_null() {
		return None;
	}
	// SAFETY: a non-null chunk is valid while the buffer is dequeued.
	let chunk = unsafe { *data.chunk };
	let memory = (!data.data.is_null()).then(|| {
		// SAFETY: a mapped plane (MAP_BUFFERS) spans `maxsize` readable bytes.
		unsafe { std::slice::from_raw_parts(data.data.cast::<u8>(), data.maxsize as usize) }
	});
	Some(Plane { memory, chunk })
}

/// `struct spa_pod`: the header every POD starts with.
#[repr(C)]
pub(super) struct SpaPod {
	size:  u32,
	type_: u32,
}

/// The header and body of the POD `pod` points at.
///
/// # Safety
/// `pod` points at a valid POD that outlives `'a`.
pub(super) const unsafe fn pod_bytes<'a>(pod: *const SpaPod) -> &'a [u8] {
	// SAFETY: a valid POD's body follows its 8-byte header.
	unsafe { std::slice::from_raw_parts(pod.cast::<u8>(), (*pod).size as usize + 8) }
}

const SPA_TYPE_ID: u32 = 3;
const SPA_TYPE_RECTANGLE: u32 = 10;
const SPA_TYPE_OBJECT: u32 = 15;
const SPA_TYPE_CHOICE: u32 = 19;
const SPA_CHOICE_NONE: u32 = 0;
const SPA_CHOICE_RANGE: u32 = 1;
const SPA_CHOICE_ENUM: u32 = 3;
const SPA_TYPE_OBJECT_FORMAT: u32 = 0x4_0003;
const SPA_PARAM_ENUM_FORMAT: u32 = 3;
pub(super) const SPA_PARAM_FORMAT: u32 = 4;
const SPA_FORMAT_MEDIA_TYPE: u32 = 1;
const SPA_FORMAT_MEDIA_SUBTYPE: u32 = 2;
const SPA_FORMAT_VIDEO_FORMAT: u32 = 0x2_0001;
const SPA_FORMAT_VIDEO_SIZE: u32 = 0x2_0003;
const SPA_MEDIA_TYPE_VIDEO: u32 = 2;
const SPA_MEDIA_SUBTYPE_RAW: u32 = 1;

/// The packed RGB layouts capture converts, by `enum spa_video_format` id.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum PixelFormat {
	Rgbx = 7,
	Bgrx = 8,
	Rgba = 11,
	Bgra = 12,
	Rgb  = 15,
	Bgr  = 16,
}

impl PixelFormat {
	const OFFERED: [Self; 6] =
		[Self::Bgrx, Self::Bgra, Self::Rgbx, Self::Rgba, Self::Rgb, Self::Bgr];

	pub(super) fn from_spa(id: u32) -> Option<Self> {
		Self::OFFERED
			.into_iter()
			.find(|format| *format as u32 == id)
	}
}

/// The `EnumFormat` param of a capture stream: raw video in any
/// `PixelFormat`, `Bgrx` preferred, up to 16384x16384.
pub(super) fn enum_format() -> Vec<u32> {
	let mut pod = vec![0, SPA_TYPE_OBJECT, SPA_TYPE_OBJECT_FORMAT, SPA_PARAM_ENUM_FORMAT];
	push_property(&mut pod, SPA_FORMAT_MEDIA_TYPE, &[4, SPA_TYPE_ID, SPA_MEDIA_TYPE_VIDEO]);
	push_property(&mut pod, SPA_FORMAT_MEDIA_SUBTYPE, &[4, SPA_TYPE_ID, SPA_MEDIA_SUBTYPE_RAW]);
	// An enum choice lists its default first, then every alternative.
	let mut formats = vec![PixelFormat::Bgrx as u32];
	formats.extend(PixelFormat::OFFERED.map(|format| format as u32));
	push_property(
		&mut pod,
		SPA_FORMAT_VIDEO_FORMAT,
		&choice(SPA_CHOICE_ENUM, SPA_TYPE_ID, 4, &formats),
	);
	// A range choice lists its default, minimum and maximum.
	let sizes = [1920, 1080, 1, 1, 16384, 16384];
	push_property(
		&mut pod,
		SPA_FORMAT_VIDEO_SIZE,
		&choice(SPA_CHOICE_RANGE, SPA_TYPE_RECTANGLE, 8, &sizes),
	);
	pod[0] = ((pod.len() - 2) * 4) as u32;
	pod
}

/// Append an object property: key, flags, then the value POD padded to 8
/// bytes.
fn push_property(pod: &mut Vec<u32>, key: u32, value: &[u32]) {
	pod.extend([key, 0]);
	pod.extend_from_slice(value);
	if value.len() % 2 == 1 {
		pod.push(0);
	}
}

fn choice(kind: u32, child_type: u32, child_size: u32, values: &[u32]) -> Vec<u32> {
	let size = 16 + values.len() as u32 * 4;
	let mut pod = vec![size, SPA_TYPE_CHOICE, kind, 0, child_size, child_type];
	pod.extend_from_slice(values);
	pod
}

/// A negotiated raw video format.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct VideoFormat {
	/// The `enum spa_video_format` id.
	pub(super) format: u32,
	pub(super) width:  u32,
	pub(super) height: u32,
}

/// Read the video format and size out of a `Format` param the way
/// `spa_format_video_raw_parse` does: each is a plain value or a `None`
/// choice holding one.
pub(super) fn parse_video_format(pod: &[u8]) -> Option<VideoFormat> {
	let word = |offset: usize| {
		let bytes = pod.get(offset..offset.checked_add(4)?)?;
		Some(u32::from_ne_bytes(bytes.try_into().ok()?))
	};
	if word(4)? != SPA_TYPE_OBJECT || word(8)? != SPA_TYPE_OBJECT_FORMAT {
		return None;
	}
	let end = (word(0)? as usize).checked_add(8)?;
	if end > pod.len() {
		return None;
	}
	let (mut format, mut size) = (None, None);
	let mut offset = 16;
	while offset + 16 <= end {
		let key = word(offset)?;
		let mut value_type = word(offset + 12)?;
		let mut value = offset + 16;
		let next = value.checked_add(word(offset + 8)? as usize)?;
		if next > end {
			return None;
		}
		if value_type == SPA_TYPE_CHOICE && value + 16 <= next && word(value)? == SPA_CHOICE_NONE {
			value_type = word(value + 12)?;
			value += 16;
		}
		match (key, value_type) {
			(SPA_FORMAT_VIDEO_FORMAT, SPA_TYPE_ID) if value + 4 <= next => format = word(value),
			(SPA_FORMAT_VIDEO_SIZE, SPA_TYPE_RECTANGLE) if value + 8 <= next => {
				size = Some((word(value)?, word(value + 4)?));
			},
			_ => {},
		}
		offset = next.next_multiple_of(8);
	}
	let (width, height) = size?;
	Some(VideoFormat { format: format?, width, height })
}

#[cfg(test)]
mod tests {
	use super::*;

	fn hex(text: &str) -> Vec<u8> {
		(0..text.len())
			.step_by(2)
			.map(|at| u8::from_str_radix(&text[at..at + 2], 16).unwrap())
			.collect()
	}

	#[test]
	fn enum_format_matches_the_pipewire_builder() {
		// pipewire-rs 0.9.2's PodSerializer and libspa's
		// spa_pod_builder_add_object both produce these bytes for the same
		// object.
		let expected = hex(concat!(
			"b00000000f000000030004000300000001000000000000000400000003000000",
			"0200000000000000020000000000000004000000030000000100000000000000",
			"01000200000000002c0000001300000003000000000000000400000003000000",
			"08000000080000000c000000070000000b0000000f0000001000000000000000",
			"030002000000000028000000130000000100000000000000080000000a000000",
			"800700003804000001000000010000000040000000400000",
		));
		let encoded: Vec<u8> = enum_format()
			.iter()
			.flat_map(|word| word.to_ne_bytes())
			.collect();
		assert_eq!(encoded, expected);
	}

	#[test]
	fn video_format_reads_negotiated_compositor_formats() {
		// `Format` params GNOME 50 (mutter) and Plasma 6.8 (KWin) negotiated for
		// a capture stream; both wrap each value in a `None` choice.
		let mutter = hex(concat!(
			"400100000f000000030004000400000001000000000000001400000013000000",
			"0000000000000000040000000300000002000000000000000200000000000000",
			"1400000013000000000000000000000004000000030000000100000000000000",
			"01000200000000001c0000001300000000000000000000000400000003000000",
			"080000000800000008000000000000000400020000000000080000000b000000",
			"0000000001000000050002000000000028000000130000000000000000000000",
			"080000000b0000006dfe4a000000010000000000010000006dfe4a0000000100",
			"030002000000000028000000130000000000000000000000080000000a000000",
			"0005000020030000000500002003000000050000200300000f00020000000000",
			"040000000300000001000000000000000e000200000000000400000003000000",
			"0400000000000000",
		));
		let kwin = hex(concat!(
			"180100000f000000030004000400000001000000000000001400000013000000",
			"0000000000000000040000000300000002000000000000000200000000000000",
			"1400000013000000000000000000000004000000030000000100000000000000",
			"030002000000000028000000130000000000000000000000080000000a000000",
			"0005000020030000000500002003000000050000200300000400020000000000",
			"080000000b000000000000000100000005000200000000002800000013000000",
			"0000000000000000080000000b000000f2240100e80300000000000001000000",
			"f2240100e8030000010002000000000024000000130000000000000000000000",
			"04000000030000000800000008000000080000000c0000000c00000000000000",
		));
		let expected = VideoFormat { format: PixelFormat::Bgrx as u32, width: 1280, height: 800 };
		assert_eq!(parse_video_format(&mutter), Some(expected));
		assert_eq!(parse_video_format(&kwin), Some(expected));
		assert_eq!(parse_video_format(&kwin[..kwin.len() - 8]), None);
		// A video format choice too short to hold its header and value.
		let mut short = kwin;
		short[232 + 8..232 + 12].copy_from_slice(&4u32.to_ne_bytes());
		assert_eq!(parse_video_format(&short), None);
	}

	#[test]
	fn missing_library_names_the_soname() {
		let error = load(c"libpipewire-omp-missing.so.0").err().unwrap();
		assert!(error.starts_with("libpipewire-omp-missing.so.0 could not be loaded"), "{error}");
	}
}
