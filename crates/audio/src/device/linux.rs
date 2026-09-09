//! Linux default-device audio through runtime-loaded `PulseAudio` or ALSA.

use std::{
	collections::BTreeMap,
	ffi::{CStr, CString, c_char, c_int, c_long, c_uint, c_void},
	mem, ptr,
	sync::{
		Arc, LazyLock, Mutex, OnceLock,
		atomic::{AtomicBool, Ordering},
		mpsc::{self, Receiver},
	},
	thread::{self, JoinHandle},
	time::Duration,
};

use omp_core::Str;

use super::{
	AudioDevice, CaptureSink, DeviceConfig, DeviceSnapshot, MicrophonePermission, PlaybackFill,
};
use crate::device::BackendResult as VoiceResult;

const PA_STREAM_PLAYBACK: c_int = 1;
const PA_STREAM_RECORD: c_int = 2;
#[cfg(target_endian = "little")]
const PA_SAMPLE_FLOAT32_NATIVE: c_int = 5;
#[cfg(target_endian = "big")]
const PA_SAMPLE_FLOAT32_NATIVE: c_int = 6;

const SND_PCM_STREAM_PLAYBACK: c_int = 0;
const SND_PCM_STREAM_CAPTURE: c_int = 1;
const SND_PCM_NONBLOCK: c_int = 1;
const SND_PCM_ACCESS_RW_INTERLEAVED: c_int = 3;
#[cfg(target_endian = "little")]
const SND_PCM_FORMAT_FLOAT_NATIVE: c_int = 14;
#[cfg(target_endian = "big")]
const SND_PCM_FORMAT_FLOAT_NATIVE: c_int = 15;

mod delivery {
	use std::sync::atomic::AtomicBool;

	use parking_lot::Mutex;

	pub(super) type DeliveryGate = (AtomicBool, Mutex<()>);

	pub(super) fn armed() -> DeliveryGate {
		(AtomicBool::new(true), Mutex::new(()))
	}
}

use delivery::DeliveryGate;

#[repr(C)]
struct PaSampleSpec {
	format:   c_int,
	rate:     u32,
	channels: u8,
}

#[repr(C)]
struct PaBufferAttr {
	maxlength: u32,
	tlength:   u32,
	prebuf:    u32,
	minreq:    u32,
	fragsize:  u32,
}

type PaSimpleNew = unsafe extern "C" fn(
	*const c_char,
	*const c_char,
	c_int,
	*const c_char,
	*const c_char,
	*const PaSampleSpec,
	*const c_void,
	*const PaBufferAttr,
	*mut c_int,
) -> *mut c_void;
type PaSimpleFree = unsafe extern "C" fn(*mut c_void);
type PaSimpleWrite = unsafe extern "C" fn(*mut c_void, *const c_void, usize, *mut c_int) -> c_int;
type PaSimpleRead = unsafe extern "C" fn(*mut c_void, *mut c_void, usize, *mut c_int) -> c_int;
type PaStrerror = unsafe extern "C" fn(c_int) -> *const c_char;

struct PulseApi {
	simple_new:   PaSimpleNew,
	simple_free:  PaSimpleFree,
	simple_write: PaSimpleWrite,
	simple_read:  PaSimpleRead,
	strerror:     PaStrerror,
}

static PULSE_API: LazyLock<Result<PulseApi, String>> = LazyLock::new(PulseApi::load);

impl PulseApi {
	fn get() -> Result<&'static Self, String> {
		PULSE_API.as_ref().map_err(Clone::clone)
	}

	fn load() -> Result<Self, String> {
		let simple = open_library(c"libpulse-simple.so.0", libc::RTLD_NOW | libc::RTLD_GLOBAL)?;
		let pulse = open_library(c"libpulse.so.0", libc::RTLD_NOW | libc::RTLD_GLOBAL)?;

		// SAFETY: each symbol is resolved from the library defining this exact C API.
		let simple_new =
			unsafe { mem::transmute::<*mut c_void, PaSimpleNew>(symbol(simple, c"pa_simple_new")?) };
		// SAFETY: each symbol is resolved from the library defining this exact C API.
		let simple_free =
			unsafe { mem::transmute::<*mut c_void, PaSimpleFree>(symbol(simple, c"pa_simple_free")?) };
		// SAFETY: each symbol is resolved from the library defining this exact C API.
		let simple_write = unsafe {
			mem::transmute::<*mut c_void, PaSimpleWrite>(symbol(simple, c"pa_simple_write")?)
		};
		// SAFETY: each symbol is resolved from the library defining this exact C API.
		let simple_read =
			unsafe { mem::transmute::<*mut c_void, PaSimpleRead>(symbol(simple, c"pa_simple_read")?) };
		// SAFETY: each symbol is resolved from the library defining this exact C API.
		let strerror =
			unsafe { mem::transmute::<*mut c_void, PaStrerror>(symbol(pulse, c"pa_strerror")?) };

		Ok(Self { simple_new, simple_free, simple_write, simple_read, strerror })
	}

	fn error(&self, code: c_int) -> String {
		// SAFETY: pa_strerror accepts every PulseAudio error code and returns a static
		// string.
		let message = unsafe { (self.strerror)(code) };
		cstring_lossy(message, "unknown PulseAudio error")
	}
}

type SndPcmOpen = unsafe extern "C" fn(*mut *mut c_void, *const c_char, c_int, c_int) -> c_int;
type SndPcmSetParams =
	unsafe extern "C" fn(*mut c_void, c_int, c_int, c_uint, c_uint, c_int, c_uint) -> c_int;
type SndPcmIo = unsafe extern "C" fn(*mut c_void, *mut c_void, c_long) -> c_long;
type SndPcmRecover = unsafe extern "C" fn(*mut c_void, c_int, c_int) -> c_int;
type SndPcmWait = unsafe extern "C" fn(*mut c_void, c_int) -> c_int;
type SndPcmControl = unsafe extern "C" fn(*mut c_void) -> c_int;
type SndStrerror = unsafe extern "C" fn(c_int) -> *const c_char;
type SndDeviceNameHint = unsafe extern "C" fn(c_int, *const c_char, *mut *mut *mut c_void) -> c_int;
type SndDeviceNameGetHint = unsafe extern "C" fn(*const c_void, *const c_char) -> *mut c_char;
type SndDeviceNameFreeHint = unsafe extern "C" fn(*mut *mut c_void) -> c_int;

struct AlsaApi {
	pcm_open:              SndPcmOpen,
	pcm_set_params:        SndPcmSetParams,
	pcm_writei:            SndPcmIo,
	pcm_readi:             SndPcmIo,
	pcm_recover:           SndPcmRecover,
	pcm_wait:              SndPcmWait,
	pcm_start:             SndPcmControl,
	pcm_close:             SndPcmControl,
	strerror:              SndStrerror,
	device_name_hint:      SndDeviceNameHint,
	device_name_get_hint:  SndDeviceNameGetHint,
	device_name_free_hint: SndDeviceNameFreeHint,
}

static ALSA_API: LazyLock<Result<AlsaApi, String>> = LazyLock::new(AlsaApi::load);

impl AlsaApi {
	fn get() -> Result<&'static Self, String> {
		ALSA_API.as_ref().map_err(Clone::clone)
	}

	fn load() -> Result<Self, String> {
		let library = open_library(c"libasound.so.2", libc::RTLD_NOW | libc::RTLD_GLOBAL)?;
		// SAFETY: each symbol is resolved from the library defining this exact C API.
		let pcm_open =
			unsafe { mem::transmute::<*mut c_void, SndPcmOpen>(symbol(library, c"snd_pcm_open")?) };
		// SAFETY: each symbol is resolved from the library defining this exact C API.
		let pcm_set_params = unsafe {
			mem::transmute::<*mut c_void, SndPcmSetParams>(symbol(library, c"snd_pcm_set_params")?)
		};
		// SAFETY: each symbol is resolved from the library defining this exact C API.
		let pcm_writei =
			unsafe { mem::transmute::<*mut c_void, SndPcmIo>(symbol(library, c"snd_pcm_writei")?) };
		// SAFETY: each symbol is resolved from the library defining this exact C API.
		let pcm_readi =
			unsafe { mem::transmute::<*mut c_void, SndPcmIo>(symbol(library, c"snd_pcm_readi")?) };
		// SAFETY: each symbol is resolved from the library defining this exact C API.
		let pcm_recover = unsafe {
			mem::transmute::<*mut c_void, SndPcmRecover>(symbol(library, c"snd_pcm_recover")?)
		};
		// SAFETY: each symbol is resolved from the library defining this exact C API.
		let pcm_wait =
			unsafe { mem::transmute::<*mut c_void, SndPcmWait>(symbol(library, c"snd_pcm_wait")?) };
		// SAFETY: each symbol is resolved from the library defining this exact C API.
		let pcm_start = unsafe {
			mem::transmute::<*mut c_void, SndPcmControl>(symbol(library, c"snd_pcm_start")?)
		};
		// SAFETY: each symbol is resolved from the library defining this exact C API.
		let pcm_close = unsafe {
			mem::transmute::<*mut c_void, SndPcmControl>(symbol(library, c"snd_pcm_close")?)
		};
		// SAFETY: each symbol is resolved from the library defining this exact C API.
		let strerror =
			unsafe { mem::transmute::<*mut c_void, SndStrerror>(symbol(library, c"snd_strerror")?) };
		// SAFETY: each symbol is resolved from the library defining this exact C API.
		let device_name_hint = unsafe {
			mem::transmute::<*mut c_void, SndDeviceNameHint>(symbol(library, c"snd_device_name_hint")?)
		};
		// SAFETY: each symbol is resolved from the library defining this exact C API.
		let device_name_get_hint = unsafe {
			mem::transmute::<*mut c_void, SndDeviceNameGetHint>(symbol(
				library,
				c"snd_device_name_get_hint",
			)?)
		};
		// SAFETY: each symbol is resolved from the library defining this exact C API.
		let device_name_free_hint = unsafe {
			mem::transmute::<*mut c_void, SndDeviceNameFreeHint>(symbol(
				library,
				c"snd_device_name_free_hint",
			)?)
		};

		Ok(Self {
			pcm_open,
			pcm_set_params,
			pcm_writei,
			pcm_readi,
			pcm_recover,
			pcm_wait,
			pcm_start,
			pcm_close,
			strerror,
			device_name_hint,
			device_name_get_hint,
			device_name_free_hint,
		})
	}

	fn error(&self, code: c_int) -> String {
		// SAFETY: snd_strerror accepts ALSA status codes and returns a static string.
		let message = unsafe { (self.strerror)(code) };
		cstring_lossy(message, "unknown ALSA error")
	}
}

fn hint_value(api: &AlsaApi, hint: *const c_void, key: &CStr) -> Option<String> {
	// SAFETY: ALSA supplied `hint`; the key is a valid NUL-terminated string.
	let value = unsafe { (api.device_name_get_hint)(hint, key.as_ptr()) };
	if value.is_null() {
		return None;
	}
	// SAFETY: ALSA returns a malloc-owned NUL-terminated string.
	let result = unsafe { CStr::from_ptr(value) }
		.to_string_lossy()
		.into_owned();
	// SAFETY: ALSA documents this returned value as caller-freed with free(3).
	unsafe { libc::free(value.cast()) };
	Some(result)
}

fn alsa_endpoints(direction: &str) -> VoiceResult<Vec<AudioDevice>> {
	let api = AlsaApi::get()?;
	let mut hints = ptr::null_mut();
	// SAFETY: `hints` is writable and "pcm" is a stable ALSA interface name.
	let status = unsafe { (api.device_name_hint)(-1, c"pcm".as_ptr(), &raw mut hints) };
	if status < 0 {
		return Err(format!("ALSA device enumeration failed: {}", api.error(status)));
	}
	let mut devices = BTreeMap::<String, Str>::new();
	if !hints.is_null() {
		let mut cursor = hints;
		loop {
			// SAFETY: ALSA returns a null-terminated array of hint pointers.
			let hint = unsafe { *cursor };
			if hint.is_null() {
				break;
			}
			let io = hint_value(api, hint, c"IOID");
			if io.as_deref().is_none_or(|io| io == direction) {
				if let Some(name) = hint_value(api, hint, c"NAME").filter(|name| name != "null") {
					let label = hint_value(api, hint, c"DESC")
						.and_then(|description| description.lines().next().map(Str::from))
						.unwrap_or_else(|| Str::from(name.as_str()));
					devices.entry(name).or_insert(label);
				}
			}
			// SAFETY: cursor remains within ALSA's null-terminated hint array.
			cursor = unsafe { cursor.add(1) };
		}
		// SAFETY: the complete hint array is owned by the matching ALSA free function.
		unsafe { (api.device_name_free_hint)(hints) };
	}
	Ok(devices
		.into_iter()
		.map(|(name, label)| AudioDevice {
			id: Str::from(format!("alsa:{name}")),
			label,
			is_default: name == "default",
		})
		.collect())
}

pub(super) const fn microphone_permission() -> MicrophonePermission {
	MicrophonePermission::Unknown
}

pub(super) async fn request_microphone_permission() -> VoiceResult<MicrophonePermission> {
	Ok(MicrophonePermission::Unknown)
}

pub(super) fn snapshot() -> VoiceResult<DeviceSnapshot> {
	Ok(DeviceSnapshot {
		input:                 alsa_endpoints("Input")?,
		output:                alsa_endpoints("Output")?,
		microphone_permission: microphone_permission(),
	})
}

fn open_library(name: &CStr, flags: c_int) -> Result<*mut c_void, String> {
	// SAFETY: name is a valid NUL-terminated string and flags are supported by
	// dlopen.
	let library = unsafe { libc::dlopen(name.as_ptr(), flags) };
	if library.is_null() {
		Err(format!("could not load {}: {}", name.to_string_lossy(), dlerror()))
	} else {
		Ok(library)
	}
}

fn symbol(library: *mut c_void, name: &CStr) -> Result<*mut c_void, String> {
	// SAFETY: library is a live handle deliberately retained for process lifetime.
	unsafe { libc::dlerror() };
	// SAFETY: library is live and name is a valid NUL-terminated symbol name.
	let address = unsafe { libc::dlsym(library, name.as_ptr()) };
	// SAFETY: dlerror reads and clears this thread's dynamic-loader error state.
	let error = unsafe { libc::dlerror() };
	if error.is_null() {
		Ok(address)
	} else {
		Err(format!(
			"could not resolve {}: {}",
			name.to_string_lossy(),
			cstring_lossy(error, "unknown dynamic-loader error")
		))
	}
}

fn dlerror() -> String {
	// SAFETY: dlerror returns either null or a thread-local NUL-terminated string.
	let error = unsafe { libc::dlerror() };
	cstring_lossy(error, "unknown dynamic-loader error")
}

fn cstring_lossy(value: *const c_char, fallback: &str) -> String {
	if value.is_null() {
		fallback.to_owned()
	} else {
		// SAFETY: callers only pass pointers returned by APIs specifying NUL-terminated
		// strings.
		unsafe { CStr::from_ptr(value) }
			.to_string_lossy()
			.into_owned()
	}
}

struct PulseStream(*mut c_void);

// SAFETY: the pointer is transferred to and exclusively dereferenced by its
// worker thread.
unsafe impl Send for PulseStream {}

impl PulseStream {
	fn open(
		api: &PulseApi,
		config: &DeviceConfig,
		direction: c_int,
		attr: &PaBufferAttr,
	) -> Result<Self, String> {
		let spec = PaSampleSpec {
			format:   PA_SAMPLE_FLOAT32_NATIVE,
			rate:     config.sample_rate,
			channels: 1,
		};
		let mut error = 0;
		// SAFETY: all pointers reference valid values for the duration of
		// pa_simple_new.
		let stream = unsafe {
			(api.simple_new)(
				ptr::null(),
				c"omp".as_ptr(),
				direction,
				ptr::null(),
				c"voice".as_ptr(),
				&raw const spec,
				ptr::null(),
				&raw const *attr,
				&raw mut error,
			)
		};
		if stream.is_null() {
			Err(format!("PulseAudio open failed: {}", api.error(error)))
		} else {
			Ok(Self(stream))
		}
	}
}

struct AlsaStream(*mut c_void);

// SAFETY: the pointer is transferred to and exclusively dereferenced by its
// worker thread.
unsafe impl Send for AlsaStream {}

impl AlsaStream {
	fn open(api: &AlsaApi, config: &DeviceConfig, direction: c_int) -> Result<Self, String> {
		let latency = config
			.period_ms
			.checked_mul(3)
			.and_then(|value| value.checked_mul(1000))
			.ok_or_else(|| "audio period is too large".to_owned())?;
		if let Some(device_id) = config.device_id.as_deref() {
			let name = device_id
				.strip_prefix("alsa:")
				.ok_or_else(|| format!("unsupported Linux audio device ID `{device_id}`"))?;
			let name =
				CString::new(name).map_err(|_| "ALSA device ID contains an interior NUL".to_owned())?;
			return Self::open_named(api, config, direction, latency, &name)
				.map_err(|error| error.message().to_owned());
		}
		match Self::open_named(api, config, direction, latency, c"default") {
			Ok(stream) => Ok(stream),
			Err(AlsaOpenError::Open(error)) => Err(error),
			Err(AlsaOpenError::Params(default_error)) => {
				Self::open_named(api, config, direction, latency, c"plug:default").map_err(|error| {
					format!("{default_error}; plug:default fallback failed: {}", error.message())
				})
			},
		}
	}

	fn open_named(
		api: &AlsaApi,
		config: &DeviceConfig,
		direction: c_int,
		latency: u32,
		name: &CStr,
	) -> Result<Self, AlsaOpenError> {
		let mut pcm = ptr::null_mut();
		// SAFETY: pcm is valid output storage and name is NUL-terminated.
		let status =
			unsafe { (api.pcm_open)(&raw mut pcm, name.as_ptr(), direction, SND_PCM_NONBLOCK) };
		if status < 0 {
			return Err(AlsaOpenError::Open(format!(
				"ALSA open of {} failed: {}",
				name.to_string_lossy(),
				api.error(status)
			)));
		}
		let stream = Self(pcm);
		// SAFETY: pcm is an open handle owned by this thread and all enum values match
		// ALSA.
		let status = unsafe {
			(api.pcm_set_params)(
				stream.0,
				SND_PCM_FORMAT_FLOAT_NATIVE,
				SND_PCM_ACCESS_RW_INTERLEAVED,
				1,
				config.sample_rate,
				1,
				latency,
			)
		};
		if status < 0 {
			// SAFETY: stream owns this open handle and it has not been closed.
			unsafe { (api.pcm_close)(stream.0) };
			Err(AlsaOpenError::Params(format!(
				"ALSA parameter setup on {} failed: {}",
				name.to_string_lossy(),
				api.error(status)
			)))
		} else {
			Ok(stream)
		}
	}
}

enum AlsaOpenError {
	Open(String),
	Params(String),
}

impl AlsaOpenError {
	fn message(self) -> String {
		match self {
			Self::Open(message) | Self::Params(message) => message,
		}
	}
}

/// Network-safe target for streams connected to a remote PulseAudio server.
const REMOTE_PULSE_LATENCY_MS: u32 = 200;

/// PulseAudio's maximum server-side backlog, expressed in target periods.
const PULSE_BACKLOG_PERIODS: u32 = 3;

fn pulse_latency_ms(period_ms: u32) -> u32 {
	let latency_override = std::env::var("PULSE_LATENCY_MSEC")
		.ok()
		.and_then(|raw| parse_latency_msec(&raw));
	let pulse_server_configured = latency_override.is_none()
		&& std::env::var_os("PULSE_SERVER").is_some_and(|server| !server.is_empty());
	select_pulse_latency_ms(period_ms, latency_override, pulse_server_configured)
}

fn select_pulse_latency_ms(
	period_ms: u32,
	latency_override: Option<u32>,
	pulse_server_configured: bool,
) -> u32 {
	latency_override
		.unwrap_or(if pulse_server_configured {
			REMOTE_PULSE_LATENCY_MS
		} else {
			period_ms
		})
		.max(period_ms)
}

fn parse_latency_msec(raw: &str) -> Option<u32> {
	raw.trim().parse::<u32>().ok().filter(|ms| *ms > 0)
}

fn pulse_bytes(config: &DeviceConfig, latency_ms: u32) -> Result<u32, String> {
	(config.sample_rate as usize)
		.checked_mul(latency_ms as usize)
		.map(|samples| (samples / 1000).max(1))
		.and_then(|samples| samples.checked_mul(size_of::<f32>()))
		.and_then(|bytes| u32::try_from(bytes).ok())
		.ok_or_else(|| "audio buffer is too large".to_owned())
}

fn pulse_attr(
	config: DeviceConfig,
	direction: c_int,
	latency_ms: u32,
) -> Result<PaBufferAttr, String> {
	let period_bytes = pulse_bytes(&config, config.period_ms)?;
	let latency_bytes = pulse_bytes(&config, latency_ms.max(config.period_ms))?;
	let backlog_bytes = latency_bytes
		.checked_mul(PULSE_BACKLOG_PERIODS)
		.ok_or_else(|| "audio buffer is too large".to_owned())?;
	Ok(if direction == PA_STREAM_RECORD {
		PaBufferAttr {
			maxlength: backlog_bytes,
			tlength:   u32::MAX,
			prebuf:    u32::MAX,
			minreq:    u32::MAX,
			fragsize:  period_bytes,
		}
	} else {
		PaBufferAttr {
			maxlength: backlog_bytes,
			tlength:   latency_bytes,
			prebuf:    u32::MAX,
			minreq:    u32::MAX,
			fragsize:  u32::MAX,
		}
	})
}

/// Returns the maximum playback backlog in callback periods for this stream.
pub(super) fn playback_drain_periods(config: DeviceConfig) -> u32 {
	drain_periods_for_latency(config.period_ms, pulse_latency_ms(config.period_ms))
}

fn drain_periods_for_latency(period_ms: u32, latency_ms: u32) -> u32 {
	let period_ms = period_ms.max(1);
	latency_ms
		.max(period_ms)
		.saturating_mul(PULSE_BACKLOG_PERIODS)
		.div_ceil(period_ms)
}

fn remember_error(slot: &Mutex<Option<String>>, error: String) {
	if let Ok(mut stored) = slot.lock() {
		*stored = Some(error);
	}
}

fn fill_if_armed(gate: &DeliveryGate, fill: &mut PlaybackFill, buffer: &mut [f32]) -> bool {
	if !gate.0.load(Ordering::Acquire) {
		return false;
	}
	let _delivery = gate.1.lock();
	if !gate.0.load(Ordering::Acquire) {
		return false;
	}
	fill(buffer);
	gate.0.load(Ordering::Acquire)
}

fn sink_if_armed(gate: &DeliveryGate, sink: &mut CaptureSink, buffer: &[f32]) -> bool {
	if !gate.0.load(Ordering::Acquire) {
		return false;
	}
	let _delivery = gate.1.lock();
	if !gate.0.load(Ordering::Acquire) {
		return false;
	}
	sink(buffer);
	gate.0.load(Ordering::Acquire)
}

fn pulse_playback_loop(
	api: &PulseApi,
	stream: &PulseStream,
	stop: &AtomicBool,
	gate: &DeliveryGate,
	fill: &mut PlaybackFill,
	samples: usize,
) -> Result<(), String> {
	let mut buffer = vec![0.0_f32; samples];
	while !stop.load(Ordering::Acquire) {
		if !fill_if_armed(gate, fill, &mut buffer) {
			break;
		}
		let mut error = 0;
		// SAFETY: stream is open and buffer contains exactly the supplied byte count.
		let status = unsafe {
			(api.simple_write)(
				stream.0,
				buffer.as_ptr().cast(),
				size_of_val(buffer.as_slice()),
				&raw mut error,
			)
		};
		if status < 0 {
			// SAFETY: stream is still open and exclusively owned by this thread.
			unsafe { (api.simple_free)(stream.0) };
			return Err(format!("PulseAudio playback failed: {}", api.error(error)));
		}
	}
	// SAFETY: stream is still open and exclusively owned by this thread.
	unsafe { (api.simple_free)(stream.0) };
	Ok(())
}

fn pulse_capture_loop(
	api: &PulseApi,
	stream: &PulseStream,
	stop: &AtomicBool,
	gate: &DeliveryGate,
	sink: &mut CaptureSink,
	samples: usize,
) -> Result<(), String> {
	let mut buffer = vec![0.0_f32; samples];
	while !stop.load(Ordering::Acquire) {
		let mut error = 0;
		// SAFETY: stream is open and buffer has writable storage for the supplied byte
		// count.
		let status = unsafe {
			(api.simple_read)(
				stream.0,
				buffer.as_mut_ptr().cast(),
				size_of_val(buffer.as_slice()),
				&raw mut error,
			)
		};
		if status < 0 {
			// SAFETY: stream is still open and exclusively owned by this thread.
			unsafe { (api.simple_free)(stream.0) };
			return Err(format!("PulseAudio capture failed: {}", api.error(error)));
		}
		if !sink_if_armed(gate, sink, &buffer) {
			break;
		}
	}
	// SAFETY: stream is still open and exclusively owned by this thread.
	unsafe { (api.simple_free)(stream.0) };
	Ok(())
}

fn close_alsa_with_error(api: &AlsaApi, stream: &AlsaStream, error: String) -> Result<(), String> {
	// SAFETY: stream is open and exclusively owned by this thread.
	unsafe { (api.pcm_close)(stream.0) };
	Err(error)
}

fn recover_alsa(
	api: &AlsaApi,
	stream: &AlsaStream,
	error: c_int,
	context: &str,
) -> Result<(), String> {
	// SAFETY: stream is open and error came from an operation on this stream.
	let recovered = unsafe { (api.pcm_recover)(stream.0, error, 1) };
	if recovered < 0 {
		return Err(format!("{context}: {}", api.error(recovered)));
	}
	// SAFETY: stream is prepared after successful recovery and remains
	// worker-owned.
	let _ = unsafe { (api.pcm_start)(stream.0) };
	Ok(())
}

fn wait_for_alsa(api: &AlsaApi, stream: &AlsaStream, timeout_ms: c_int) -> Result<(), String> {
	// SAFETY: stream is open and timeout_ms is a valid non-negative timeout.
	let status = unsafe { (api.pcm_wait)(stream.0, timeout_ms) };
	if status >= 0 || status == -libc::EINTR {
		Ok(())
	} else {
		recover_alsa(api, stream, status, "ALSA wait recovery failed")
	}
}

fn alsa_playback_loop(
	api: &AlsaApi,
	stream: &AlsaStream,
	stop: &AtomicBool,
	gate: &DeliveryGate,
	fill: &mut PlaybackFill,
	samples: usize,
	timeout_ms: c_int,
) -> Result<(), String> {
	let mut buffer = vec![0.0_f32; samples];
	while !stop.load(Ordering::Acquire) {
		if !fill_if_armed(gate, fill, &mut buffer) {
			break;
		}
		let mut offset = 0;
		while offset < samples && !stop.load(Ordering::Acquire) {
			let Ok(frames) = c_long::try_from(samples - offset) else {
				return close_alsa_with_error(
					api,
					stream,
					"audio period exceeds ALSA frame range".to_owned(),
				);
			};
			// SAFETY: stream is open and the remaining buffer contains frames of mono f32
			// audio.
			let status = unsafe {
				(api.pcm_writei)(stream.0, buffer.as_ptr().add(offset).cast_mut().cast(), frames)
			};
			if status == -c_long::from(libc::EAGAIN) {
				if let Err(error) = wait_for_alsa(api, stream, timeout_ms) {
					return close_alsa_with_error(api, stream, error);
				}
			} else if status < 0 {
				let Ok(error) = c_int::try_from(status) else {
					return close_alsa_with_error(
						api,
						stream,
						format!("ALSA returned an invalid status: {status}"),
					);
				};
				if let Err(error) = recover_alsa(api, stream, error, "ALSA playback recovery failed") {
					return close_alsa_with_error(api, stream, error);
				}
			} else if status > 0 {
				let Ok(written) = usize::try_from(status) else {
					return close_alsa_with_error(
						api,
						stream,
						format!("ALSA returned an invalid frame count: {status}"),
					);
				};
				if written > samples - offset {
					// SAFETY: stream is still open and exclusively owned by this thread.
					unsafe { (api.pcm_close)(stream.0) };
					return Err(format!(
						"ALSA wrote {written} frames after receiving {}",
						samples - offset
					));
				}
				offset += written;
			}
		}
	}
	// SAFETY: stream is still open and exclusively owned by this thread.
	unsafe { (api.pcm_close)(stream.0) };
	Ok(())
}

fn alsa_capture_loop(
	api: &AlsaApi,
	stream: &AlsaStream,
	stop: &AtomicBool,
	gate: &DeliveryGate,
	sink: &mut CaptureSink,
	samples: usize,
	timeout_ms: c_int,
) -> Result<(), String> {
	let mut buffer = vec![0.0_f32; samples];
	let Ok(frames) = c_long::try_from(samples) else {
		return close_alsa_with_error(
			api,
			stream,
			"audio period exceeds ALSA frame range".to_owned(),
		);
	};
	while !stop.load(Ordering::Acquire) {
		// SAFETY: stream is open and buffer has writable storage for frames mono f32
		// frames.
		let status = unsafe { (api.pcm_readi)(stream.0, buffer.as_mut_ptr().cast(), frames) };
		if status == -c_long::from(libc::EAGAIN) {
			if let Err(error) = wait_for_alsa(api, stream, timeout_ms) {
				return close_alsa_with_error(api, stream, error);
			}
			continue;
		}
		if status < 0 {
			let Ok(error) = c_int::try_from(status) else {
				return close_alsa_with_error(
					api,
					stream,
					format!("ALSA returned an invalid status: {status}"),
				);
			};
			if let Err(error) = recover_alsa(api, stream, error, "ALSA capture recovery failed") {
				return close_alsa_with_error(api, stream, error);
			}
			continue;
		}
		if status > 0 {
			let Ok(captured) = usize::try_from(status) else {
				return close_alsa_with_error(
					api,
					stream,
					format!("ALSA returned an invalid frame count: {status}"),
				);
			};
			if captured > samples {
				// SAFETY: stream is still open and exclusively owned by this thread.
				unsafe { (api.pcm_close)(stream.0) };
				return Err(format!("ALSA captured {captured} frames into a {samples}-frame buffer"));
			}
			if !sink_if_armed(gate, sink, &buffer[..captured]) {
				break;
			}
		}
	}
	// SAFETY: stream is still open and exclusively owned by this thread.
	unsafe { (api.pcm_close)(stream.0) };
	Ok(())
}

struct ThreadDone(mpsc::Sender<()>);

impl Drop for ThreadDone {
	fn drop(&mut self) {
		let _ = self.0.send(());
	}
}

struct RunningDevice {
	stop:      AtomicBool,
	delivery:  Arc<DeliveryGate>,
	worker_id: OnceLock<thread::ThreadId>,
	error:     Mutex<Option<String>>,
}

fn finish(
	device: &Arc<RunningDevice>,
	thread: &mut Option<JoinHandle<()>>,
	done: &mut Option<Receiver<()>>,
) -> VoiceResult<()> {
	device.delivery.0.store(false, Ordering::Release);
	device.stop.store(true, Ordering::Release);
	if device
		.worker_id
		.get()
		.is_some_and(|worker_id| *worker_id == thread::current().id())
	{
		// A callback-thread stop cannot wait on its own delivery lock or join
		// itself. Disarming is sufficient; the worker exits after the callback.
		return Ok(());
	}
	// The gate waits out an in-flight callback and prevents every future one,
	// keeping the bounded PulseAudio detach path contract-clean.
	drop(device.delivery.1.lock());
	if let Some(handle) = thread.take() {
		let completed = done.take().is_none_or(|receiver| {
			match receiver.recv_timeout(Duration::from_millis(500)) {
				Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => true,
				Err(mpsc::RecvTimeoutError::Timeout) => false,
			}
		});
		if completed {
			handle
				.join()
				.map_err(|_| "audio worker thread panicked".to_owned())?;
		} else {
			// A pathological PulseAudio server can stall pa_simple I/O forever.
			// Detaching keeps stop/Drop bounded; the worker owns and eventually frees
			// the handle if the server ever unblocks. The delivery gate prevents callbacks.
			drop(handle);
		}
	}
	device
		.error
		.lock()
		.map_err(|_| "audio worker error state was poisoned".to_owned())?
		.take()
		.map_or(Ok(()), Err)
}

/// Running `PulseAudio` or ALSA playback worker for a selected or default
/// endpoint.
pub struct PlaybackDevice {
	device: Arc<RunningDevice>,
	thread: Option<JoinHandle<()>>,
	done:   Option<Receiver<()>>,
}

impl PlaybackDevice {
	/// Opens the selected or default playback device and starts its worker
	/// thread.
	pub fn start(config: DeviceConfig, mut fill: PlaybackFill) -> VoiceResult<Self> {
		let samples = config.period_samples();
		let attr =
			pulse_attr(config.clone(), PA_STREAM_PLAYBACK, pulse_latency_ms(config.period_ms))?;
		let timeout_ms = c_int::try_from(config.period_ms)
			.unwrap_or(c_int::MAX)
			.max(1);
		let delivery = Arc::new(delivery::armed());
		let device = Arc::new(RunningDevice {
			stop: AtomicBool::new(false),
			delivery,
			error: Mutex::new(None),
			worker_id: OnceLock::new(),
		});
		let worker_device = Arc::clone(&device);
		let (opened_tx, opened_rx) = mpsc::sync_channel(1);
		let (done_tx, done_rx) = mpsc::channel();
		let thread = thread::Builder::new()
			.name("omp-audio-playback".to_owned())
			.spawn(move || {
				let _done = ThreadDone(done_tx);
				let _ = worker_device.worker_id.set(thread::current().id());
				let pulse_error = match (config.device_id.is_none())
					.then(PulseApi::get)
					.transpose()
					.and_then(|api| {
						api.ok_or_else(|| "explicit device selection bypasses PulseAudio".to_owned())
					})
					.and_then(|api| {
						PulseStream::open(api, &config, PA_STREAM_PLAYBACK, &attr)
							.map(|stream| (api, stream))
					}) {
					Ok((api, stream)) => {
						let _ = opened_tx.send(Ok(()));
						if let Err(error) = pulse_playback_loop(
							api,
							&stream,
							&worker_device.stop,
							worker_device.delivery.as_ref(),
							&mut fill,
							samples,
						) {
							remember_error(&worker_device.error, error);
						}
						return;
					},
					Err(error) => error,
				};
				match AlsaApi::get().and_then(|api| {
					AlsaStream::open(api, &config, SND_PCM_STREAM_PLAYBACK).map(|stream| (api, stream))
				}) {
					Ok((api, stream)) => {
						let _ = opened_tx.send(Ok(()));
						if let Err(error) = alsa_playback_loop(
							api,
							&stream,
							&worker_device.stop,
							worker_device.delivery.as_ref(),
							&mut fill,
							samples,
							timeout_ms,
						) {
							remember_error(&worker_device.error, error);
						}
					},
					Err(alsa_error) => {
						let _ = opened_tx.send(Err(format!(
							"no Linux playback backend available; PulseAudio: {pulse_error}; ALSA: \
							 {alsa_error}"
						)));
					},
				}
			})
			.map_err(|error| format!("could not start playback worker: {error}"))?;
		match opened_rx.recv() {
			Ok(Ok(())) => Ok(Self { device, thread: Some(thread), done: Some(done_rx) }),
			Ok(Err(error)) => {
				let _ = thread.join();
				Err(error)
			},
			Err(error) => {
				let _ = thread.join();
				Err(format!("playback worker exited during startup: {error}"))
			},
		}
	}

	/// Stops playback, waiting out delivery when called off the worker thread.
	pub fn stop(&mut self) -> VoiceResult<()> {
		finish(&self.device, &mut self.thread, &mut self.done)
	}
}

impl Drop for PlaybackDevice {
	fn drop(&mut self) {
		let _ = self.stop();
	}
}

/// Running `PulseAudio` or ALSA capture worker for a selected or default
/// endpoint.
pub struct CaptureDevice {
	device: Arc<RunningDevice>,
	thread: Option<JoinHandle<()>>,
	done:   Option<Receiver<()>>,
}

impl CaptureDevice {
	/// Opens the selected or default capture device and starts its worker
	/// thread.
	pub fn start(config: DeviceConfig, mut sink: CaptureSink) -> VoiceResult<Self> {
		let samples = config.period_samples();
		let attr = pulse_attr(config.clone(), PA_STREAM_RECORD, pulse_latency_ms(config.period_ms))?;
		let timeout_ms = c_int::try_from(config.period_ms)
			.unwrap_or(c_int::MAX)
			.max(1);
		let delivery = Arc::new(delivery::armed());
		let device = Arc::new(RunningDevice {
			stop: AtomicBool::new(false),
			delivery,
			error: Mutex::new(None),
			worker_id: OnceLock::new(),
		});
		let worker_device = Arc::clone(&device);
		let (opened_tx, opened_rx) = mpsc::sync_channel(1);
		let (done_tx, done_rx) = mpsc::channel();
		let thread = thread::Builder::new()
			.name("omp-audio-capture".to_owned())
			.spawn(move || {
				let _done = ThreadDone(done_tx);
				let _ = worker_device.worker_id.set(thread::current().id());
				let pulse_error = match (config.device_id.is_none())
					.then(PulseApi::get)
					.transpose()
					.and_then(|api| {
						api.ok_or_else(|| "explicit device selection bypasses PulseAudio".to_owned())
					})
					.and_then(|api| {
						PulseStream::open(api, &config, PA_STREAM_RECORD, &attr)
							.map(|stream| (api, stream))
					}) {
					Ok((api, stream)) => {
						let _ = opened_tx.send(Ok(()));
						if let Err(error) = pulse_capture_loop(
							api,
							&stream,
							&worker_device.stop,
							worker_device.delivery.as_ref(),
							&mut sink,
							samples,
						) {
							remember_error(&worker_device.error, error);
						}
						return;
					},
					Err(error) => error,
				};
				match AlsaApi::get().and_then(|api| {
					AlsaStream::open(api, &config, SND_PCM_STREAM_CAPTURE).map(|stream| (api, stream))
				}) {
					Ok((api, stream)) => {
						let _ = opened_tx.send(Ok(()));
						if let Err(error) = alsa_capture_loop(
							api,
							&stream,
							&worker_device.stop,
							worker_device.delivery.as_ref(),
							&mut sink,
							samples,
							timeout_ms,
						) {
							remember_error(&worker_device.error, error);
						}
					},
					Err(alsa_error) => {
						let _ = opened_tx.send(Err(format!(
							"no Linux capture backend available; PulseAudio: {pulse_error}; ALSA: \
							 {alsa_error}"
						)));
					},
				}
			})
			.map_err(|error| format!("could not start capture worker: {error}"))?;
		match opened_rx.recv() {
			Ok(Ok(())) => Ok(Self { device, thread: Some(thread), done: Some(done_rx) }),
			Ok(Err(error)) => {
				let _ = thread.join();
				Err(error)
			},
			Err(error) => {
				let _ = thread.join();
				Err(format!("capture worker exited during startup: {error}"))
			},
		}
	}

	/// Stops capture, waiting out delivery when called off the worker thread.
	pub fn stop(&mut self) -> VoiceResult<()> {
		finish(&self.device, &mut self.thread, &mut self.done)
	}
}

impl Drop for CaptureDevice {
	fn drop(&mut self) {
		let _ = self.stop();
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn config(sample_rate: u32, period_ms: u32) -> DeviceConfig {
		DeviceConfig { sample_rate, period_ms, device_id: None }
	}

	#[test]
	fn local_playback_keeps_period_sized_target() {
		let attr = pulse_attr(config(24_000, 20), PA_STREAM_PLAYBACK, 20).unwrap();
		assert_eq!(attr.tlength, 1_920);
		assert_eq!(attr.maxlength, 5_760);
		assert_eq!(attr.fragsize, u32::MAX);
	}

	#[test]
	fn remote_playback_widens_target_to_latency() {
		let attr = pulse_attr(config(24_000, 20), PA_STREAM_PLAYBACK, 200).unwrap();
		assert_eq!(attr.tlength, 19_200);
		assert_eq!(attr.maxlength, 57_600);
	}

	#[test]
	fn remote_capture_keeps_cadence_and_widens_backlog() {
		let attr = pulse_attr(config(16_000, 20), PA_STREAM_RECORD, 200).unwrap();
		assert_eq!(attr.fragsize, 1_280);
		assert_eq!(attr.maxlength, 38_400);
		assert_eq!(attr.tlength, u32::MAX);
	}

	#[test]
	fn latency_override_parses_positive_integers_only() {
		assert_eq!(parse_latency_msec(" 150 "), Some(150));
		assert_eq!(parse_latency_msec("0"), None);
		assert_eq!(parse_latency_msec("abc"), None);
	}

	#[test]
	fn latency_selection_obeys_local_remote_and_override_precedence() {
		let cases = [
			(50, None, false, 50),
			(50, None, true, 200),
			(50, Some(150), true, 150),
			(50, Some(10), true, 50),
			(250, None, true, 250),
		];
		for (period_ms, latency_override, remote, expected) in cases {
			assert_eq!(select_pulse_latency_ms(period_ms, latency_override, remote), expected);
		}
	}

	#[test]
	fn drain_periods_scale_with_widened_latency() {
		assert_eq!(drain_periods_for_latency(20, 20), 3);
		assert_eq!(drain_periods_for_latency(20, 200), 30);
	}
}
