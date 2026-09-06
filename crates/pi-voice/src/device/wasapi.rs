//! Shared-mode WASAPI playback and capture for the default Windows devices.

use std::{
	ffi::c_void,
	ptr::{null, null_mut},
	slice,
	sync::{
		Arc,
		atomic::{AtomicBool, Ordering},
		mpsc::{self, Sender},
	},
	thread::{self, JoinHandle},
	time::Duration,
};

use windows_sys::{
	Win32::{
		Foundation::{CloseHandle, HANDLE, WAIT_OBJECT_0, WAIT_TIMEOUT},
		Media::{
			Audio::{
				AUDCLNT_BUFFERFLAGS_SILENT, AUDCLNT_E_DEVICE_INVALIDATED, AUDCLNT_SHAREMODE_SHARED,
				AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM, AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
				AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY, WAVEFORMATEX, eCapture, eConsole, eRender,
			},
			Multimedia::WAVE_FORMAT_IEEE_FLOAT,
		},
		System::{
			Com::{
				CLSCTX_ALL, COINIT_MULTITHREADED, CoCreateInstance, CoInitializeEx, CoUninitialize,
			},
			Threading::{CreateEventW, SetEvent, WaitForSingleObject},
		},
	},
	core::{GUID, HRESULT, IUnknown_Vtbl},
};

use super::{CaptureSink, DeviceConfig, PlaybackFill};
use crate::VoiceResult;

const WAIT_TIMEOUT_MS: u32 = 2_000;
const REOPEN_ATTEMPTS: usize = 4;
const REOPEN_BACKOFF: Duration = Duration::from_millis(200);
const CLSID_MMDEVICE_ENUMERATOR: GUID = GUID::from_u128(0xbcde_0395_e52f_467c_8e3d_c457_9291_692e);
const IID_IMMDEVICE_ENUMERATOR: GUID = GUID::from_u128(0xa956_64d2_9614_4f35_a746_de8d_b636_17e6);
const IID_IAUDIO_CLIENT: GUID = GUID::from_u128(0x1cb9_ad4c_dbfa_4c32_b178_c2f5_68a7_03b2);
const IID_IAUDIO_RENDER_CLIENT: GUID = GUID::from_u128(0xf294_acfc_3146_4483_a7bf_addc_a7c2_60e2);
const IID_IAUDIO_CAPTURE_CLIENT: GUID = GUID::from_u128(0xc8ad_bd64_e71e_48a0_a4de_185c_395c_d317);

#[repr(C)]
struct RawComInterface<V> {
	vtable: *const V,
}

trait ComVtable {
	fn unknown(&self) -> &IUnknown_Vtbl;
}

#[repr(C)]
#[allow(dead_code, reason = "all slots are required to preserve the COM vtable layout")]
struct MmDeviceEnumeratorVtable {
	base: IUnknown_Vtbl,
	enum_audio_endpoints:
		unsafe extern "system" fn(*mut c_void, i32, u32, *mut *mut c_void) -> HRESULT,
	get_default_audio_endpoint:
		unsafe extern "system" fn(*mut c_void, i32, i32, *mut *mut c_void) -> HRESULT,
	get_device: unsafe extern "system" fn(*mut c_void, *const u16, *mut *mut c_void) -> HRESULT,
	register_endpoint_notification_callback:
		unsafe extern "system" fn(*mut c_void, *mut c_void) -> HRESULT,
	unregister_endpoint_notification_callback:
		unsafe extern "system" fn(*mut c_void, *mut c_void) -> HRESULT,
}

impl ComVtable for MmDeviceEnumeratorVtable {
	fn unknown(&self) -> &IUnknown_Vtbl {
		&self.base
	}
}

#[repr(C)]
#[allow(dead_code, reason = "all slots are required to preserve the COM vtable layout")]
struct MmDeviceVtable {
	base:                IUnknown_Vtbl,
	activate: unsafe extern "system" fn(
		*mut c_void,
		*const GUID,
		u32,
		*const c_void,
		*mut *mut c_void,
	) -> HRESULT,
	open_property_store: unsafe extern "system" fn(*mut c_void, u32, *mut *mut c_void) -> HRESULT,
	get_id:              unsafe extern "system" fn(*mut c_void, *mut *mut u16) -> HRESULT,
	get_state:           unsafe extern "system" fn(*mut c_void, *mut u32) -> HRESULT,
}

impl ComVtable for MmDeviceVtable {
	fn unknown(&self) -> &IUnknown_Vtbl {
		&self.base
	}
}

#[repr(C)]
#[allow(dead_code, reason = "all slots are required to preserve the COM vtable layout")]
struct AudioClientVtable {
	base:                IUnknown_Vtbl,
	initialize: unsafe extern "system" fn(
		*mut c_void,
		i32,
		u32,
		i64,
		i64,
		*const WAVEFORMATEX,
		*const GUID,
	) -> HRESULT,
	get_buffer_size:     unsafe extern "system" fn(*mut c_void, *mut u32) -> HRESULT,
	get_stream_latency:  unsafe extern "system" fn(*mut c_void, *mut i64) -> HRESULT,
	get_current_padding: unsafe extern "system" fn(*mut c_void, *mut u32) -> HRESULT,
	is_format_supported: unsafe extern "system" fn(
		*mut c_void,
		i32,
		*const WAVEFORMATEX,
		*mut *mut WAVEFORMATEX,
	) -> HRESULT,
	get_mix_format:      unsafe extern "system" fn(*mut c_void, *mut *mut WAVEFORMATEX) -> HRESULT,
	get_device_period:   unsafe extern "system" fn(*mut c_void, *mut i64, *mut i64) -> HRESULT,
	start:               unsafe extern "system" fn(*mut c_void) -> HRESULT,
	stop:                unsafe extern "system" fn(*mut c_void) -> HRESULT,
	reset:               unsafe extern "system" fn(*mut c_void) -> HRESULT,
	set_event_handle:    unsafe extern "system" fn(*mut c_void, HANDLE) -> HRESULT,
	get_service: unsafe extern "system" fn(*mut c_void, *const GUID, *mut *mut c_void) -> HRESULT,
}

impl ComVtable for AudioClientVtable {
	fn unknown(&self) -> &IUnknown_Vtbl {
		&self.base
	}
}

#[repr(C)]
struct AudioRenderClientVtable {
	base:           IUnknown_Vtbl,
	get_buffer:     unsafe extern "system" fn(*mut c_void, u32, *mut *mut u8) -> HRESULT,
	release_buffer: unsafe extern "system" fn(*mut c_void, u32, u32) -> HRESULT,
}

impl ComVtable for AudioRenderClientVtable {
	fn unknown(&self) -> &IUnknown_Vtbl {
		&self.base
	}
}

#[repr(C)]
struct AudioCaptureClientVtable {
	base:                 IUnknown_Vtbl,
	get_buffer: unsafe extern "system" fn(
		*mut c_void,
		*mut *mut u8,
		*mut u32,
		*mut u32,
		*mut u64,
		*mut u64,
	) -> HRESULT,
	release_buffer:       unsafe extern "system" fn(*mut c_void, u32) -> HRESULT,
	get_next_packet_size: unsafe extern "system" fn(*mut c_void, *mut u32) -> HRESULT,
}

impl ComVtable for AudioCaptureClientVtable {
	fn unknown(&self) -> &IUnknown_Vtbl {
		&self.base
	}
}

struct ComPtr<V: ComVtable> {
	ptr: *mut RawComInterface<V>,
}

impl<V: ComVtable> ComPtr<V> {
	fn new(raw: *mut c_void, what: &str) -> VoiceResult<Self> {
		if raw.is_null() {
			Err(format!("{what} returned a null COM interface"))
		} else {
			Ok(Self { ptr: raw.cast() })
		}
	}

	const fn as_void(&self) -> *mut c_void {
		self.ptr.cast()
	}

	fn vtable(&self) -> &V {
		// SAFETY: `ptr` was returned as a live COM interface, and each concrete
		// interface pointer begins with a pointer to its corresponding vtable.
		unsafe { &*(*self.ptr).vtable }
	}
}

impl<V: ComVtable> Drop for ComPtr<V> {
	fn drop(&mut self) {
		let release = self.vtable().unknown().Release;
		// SAFETY: this object owns one reference to the live COM interface.
		unsafe { release(self.as_void()) };
	}
}

#[derive(Clone, Copy)]
struct EventHandle(HANDLE);

// SAFETY: Windows event handles may be used from any thread, and reference
// counting keeps the owning handle open while either side can access it.
unsafe impl Send for EventHandle {}
// SAFETY: `SetEvent` and waits on a Windows event handle are thread-safe.
unsafe impl Sync for EventHandle {}

struct OwnedEvent(EventHandle);

impl OwnedEvent {
	fn create() -> VoiceResult<Arc<Self>> {
		// SAFETY: null security attributes and name request a private auto-reset,
		// initially nonsignaled event.
		let raw = unsafe { CreateEventW(null(), 0, 0, null()) };
		if raw.is_null() {
			Err("CreateEventW failed".to_owned())
		} else {
			Ok(Arc::new(Self(EventHandle(raw))))
		}
	}

	const fn handle(&self) -> EventHandle {
		self.0
	}

	fn signal(&self) {
		// SAFETY: every caller owns an `Arc` that keeps this handle open.
		let _ = unsafe { SetEvent(self.0.0) };
	}
}

impl Drop for OwnedEvent {
	fn drop(&mut self) {
		// SAFETY: this is the sole owner and closes the valid event handle once.
		unsafe { CloseHandle(self.0.0) };
	}
}

struct ComApartment;

impl ComApartment {
	fn initialize() -> VoiceResult<Self> {
		// SAFETY: this dedicated worker has not initialized COM yet; the reserved
		// pointer is required to be null.
		let hr = unsafe { CoInitializeEx(null(), COINIT_MULTITHREADED as u32) };
		check_hresult(hr, "CoInitializeEx")?;
		Ok(Self)
	}
}

impl Drop for ComApartment {
	fn drop(&mut self) {
		// SAFETY: paired with the successful `CoInitializeEx` on this same thread.
		unsafe { CoUninitialize() };
	}
}

struct BaseStream {
	client:      ComPtr<AudioClientVtable>,
	_device:     ComPtr<MmDeviceVtable>,
	_enumerator: ComPtr<MmDeviceEnumeratorVtable>,
	event:       Arc<OwnedEvent>,
	buffer_size: u32,
	_apartment:  ComApartment,
}

impl BaseStream {
	fn open(
		config: DeviceConfig,
		data_flow: i32,
		event: Option<Arc<OwnedEvent>>,
	) -> VoiceResult<Self> {
		let apartment = ComApartment::initialize()?;

		let mut enumerator_raw = null_mut();
		// SAFETY: all pointers are valid for the call, and `enumerator_raw` is an
		// out parameter for the requested interface.
		let hr = unsafe {
			CoCreateInstance(
				&CLSID_MMDEVICE_ENUMERATOR,
				null_mut(),
				CLSCTX_ALL,
				&IID_IMMDEVICE_ENUMERATOR,
				&mut enumerator_raw,
			)
		};
		check_hresult(hr, "CoCreateInstance(MMDeviceEnumerator)")?;
		let enumerator: ComPtr<MmDeviceEnumeratorVtable> =
			ComPtr::new(enumerator_raw, "CoCreateInstance(MMDeviceEnumerator)")?;

		let mut device_raw = null_mut();
		// SAFETY: the enumerator is live and the output pointer is writable.
		let hr = unsafe {
			(enumerator.vtable().get_default_audio_endpoint)(
				enumerator.as_void(),
				data_flow,
				eConsole,
				&mut device_raw,
			)
		};
		check_hresult(hr, "IMMDeviceEnumerator::GetDefaultAudioEndpoint")?;
		let device: ComPtr<MmDeviceVtable> =
			ComPtr::new(device_raw, "IMMDeviceEnumerator::GetDefaultAudioEndpoint")?;

		let mut client_raw = null_mut();
		// SAFETY: the device is live, activation parameters are optional and null,
		// and `client_raw` receives the requested interface.
		let hr = unsafe {
			(device.vtable().activate)(
				device.as_void(),
				&IID_IAUDIO_CLIENT,
				CLSCTX_ALL,
				null(),
				&mut client_raw,
			)
		};
		check_hresult(hr, "IMMDevice::Activate(IAudioClient)")?;
		let client: ComPtr<AudioClientVtable> =
			ComPtr::new(client_raw, "IMMDevice::Activate(IAudioClient)")?;

		let bytes_per_second = config
			.sample_rate
			.checked_mul(4)
			.ok_or_else(|| "WASAPI sample rate is too large".to_owned())?;
		let format = WAVEFORMATEX {
			wFormatTag:      WAVE_FORMAT_IEEE_FLOAT as u16,
			nChannels:       1,
			nSamplesPerSec:  config.sample_rate,
			nAvgBytesPerSec: bytes_per_second,
			nBlockAlign:     4,
			wBitsPerSample:  32,
			cbSize:          0,
		};
		let stream_flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK
			| AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
			| AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY;
		let buffer_duration = i64::from(config.period_ms) * 3 * 10_000;
		// SAFETY: the client is live and `format` remains valid for the duration
		// of this synchronous initialization call.
		let hr = unsafe {
			(client.vtable().initialize)(
				client.as_void(),
				AUDCLNT_SHAREMODE_SHARED,
				stream_flags,
				buffer_duration,
				0,
				&format,
				null(),
			)
		};
		check_hresult(hr, "IAudioClient::Initialize")?;

		let event = match event {
			Some(event) => event,
			None => OwnedEvent::create()?,
		};
		let raw_event = event.handle().0;

		// SAFETY: the client and event are live for the remainder of the stream.
		let hr = unsafe { (client.vtable().set_event_handle)(client.as_void(), raw_event) };
		if let Err(error) = check_hresult(hr, "IAudioClient::SetEventHandle") {
			drop(client);
			drop(device);
			drop(enumerator);
			drop(event);
			drop(apartment);
			return Err(error);
		}

		let mut buffer_size = 0;
		// SAFETY: the initialized client is live and the output pointer is valid.
		let hr = unsafe { (client.vtable().get_buffer_size)(client.as_void(), &mut buffer_size) };
		if let Err(error) = check_hresult(hr, "IAudioClient::GetBufferSize") {
			drop(client);
			drop(device);
			drop(enumerator);
			drop(event);
			drop(apartment);
			return Err(error);
		}
		if buffer_size == 0 {
			drop(client);
			drop(device);
			drop(enumerator);
			drop(event);
			drop(apartment);
			return Err("IAudioClient::GetBufferSize returned zero frames".to_owned());
		}

		Ok(Self {
			client,
			_device: device,
			_enumerator: enumerator,
			event,
			buffer_size,
			_apartment: apartment,
		})
	}

	fn event_handle(&self) -> EventHandle {
		self.event.handle()
	}

	fn start(&self) -> VoiceResult<()> {
		// SAFETY: the client is fully initialized and its event handle is set.
		let hr = unsafe { (self.client.vtable().start)(self.client.as_void()) };
		check_hresult(hr, "IAudioClient::Start")
	}

	fn stop(&self) {
		// SAFETY: the client remains live and may be stopped during teardown.
		let _ = unsafe { (self.client.vtable().stop)(self.client.as_void()) };
	}
}

struct PlaybackStream {
	render:        ComPtr<AudioRenderClientVtable>,
	base:          BaseStream,
	period_frames: u32,
	started:       bool,
}

impl PlaybackStream {
	fn open(config: DeviceConfig, event: Option<Arc<OwnedEvent>>) -> VoiceResult<Self> {
		let base = BaseStream::open(config, eRender, event)?;
		let period_frames = u32::try_from(config.period_samples())
			.map_err(|_| "WASAPI playback period is too large".to_owned())?;
		if period_frames > base.buffer_size {
			return Err(format!(
				"WASAPI endpoint buffer ({} frames) is smaller than one playback period \
				 ({period_frames} frames)",
				base.buffer_size
			));
		}
		let mut render_raw = null_mut();
		// SAFETY: the initialized client is live and `render_raw` receives the
		// requested service interface.
		let hr = unsafe {
			(base.client.vtable().get_service)(
				base.client.as_void(),
				&IID_IAUDIO_RENDER_CLIENT,
				&mut render_raw,
			)
		};
		check_hresult(hr, "IAudioClient::GetService(IAudioRenderClient)")?;
		let render = ComPtr::new(render_raw, "IAudioClient::GetService(IAudioRenderClient)")?;
		let mut stream = Self { render, base, period_frames, started: false };
		stream.base.start()?;
		stream.started = true;
		Ok(stream)
	}
}

impl Drop for PlaybackStream {
	fn drop(&mut self) {
		if self.started {
			self.base.stop();
		}
	}
}

struct CaptureStream {
	capture: ComPtr<AudioCaptureClientVtable>,
	base:    BaseStream,
	started: bool,
}

impl CaptureStream {
	fn open(config: DeviceConfig, event: Option<Arc<OwnedEvent>>) -> VoiceResult<Self> {
		let base = BaseStream::open(config, eCapture, event)?;
		let mut capture_raw = null_mut();
		// SAFETY: the initialized client is live and `capture_raw` receives the
		// requested service interface.
		let hr = unsafe {
			(base.client.vtable().get_service)(
				base.client.as_void(),
				&IID_IAUDIO_CAPTURE_CLIENT,
				&mut capture_raw,
			)
		};
		check_hresult(hr, "IAudioClient::GetService(IAudioCaptureClient)")?;
		let capture = ComPtr::new(capture_raw, "IAudioClient::GetService(IAudioCaptureClient)")?;
		let mut stream = Self { capture, base, started: false };
		stream.base.start()?;
		stream.started = true;
		Ok(stream)
	}
}

impl Drop for CaptureStream {
	fn drop(&mut self) {
		if self.started {
			self.base.stop();
		}
	}
}

pub struct PlaybackDevice {
	stop:   Arc<AtomicBool>,
	event:  Arc<OwnedEvent>,
	thread: Option<JoinHandle<VoiceResult<()>>>,
}

impl PlaybackDevice {
	/// Open and start shared-mode playback on the default console endpoint.
	pub fn start(config: DeviceConfig, fill: PlaybackFill) -> VoiceResult<Self> {
		let stop = Arc::new(AtomicBool::new(false));
		let worker_stop = Arc::clone(&stop);
		let (startup_tx, startup_rx) = mpsc::channel();
		let thread = thread::Builder::new()
			.name("pi-voice-wasapi-playback".to_owned())
			.spawn(move || playback_thread(config, fill, worker_stop, startup_tx))
			.map_err(|error| format!("failed to spawn WASAPI playback thread: {error}"))?;

		match startup_rx.recv() {
			Ok(Ok(event)) => Ok(Self { stop, event, thread: Some(thread) }),
			Ok(Err(error)) => {
				let _ = thread.join();
				Err(error)
			},
			Err(_) => match thread.join() {
				Ok(Err(error)) => Err(error),
				Ok(Ok(())) => Err("WASAPI playback thread exited during startup".to_owned()),
				Err(_) => Err("WASAPI playback thread panicked during startup".to_owned()),
			},
		}
	}

	/// Stop playback and wait until its worker can no longer invoke `fill`.
	pub fn stop(&mut self) -> VoiceResult<()> {
		stop_worker(&self.stop, &self.event, &mut self.thread, "playback")
	}
}

impl Drop for PlaybackDevice {
	fn drop(&mut self) {
		let _ = self.stop();
	}
}

pub struct CaptureDevice {
	stop:   Arc<AtomicBool>,
	event:  Arc<OwnedEvent>,
	thread: Option<JoinHandle<VoiceResult<()>>>,
}

impl CaptureDevice {
	/// Open and start shared-mode capture on the default console endpoint.
	pub fn start(config: DeviceConfig, sink: CaptureSink) -> VoiceResult<Self> {
		let stop = Arc::new(AtomicBool::new(false));
		let worker_stop = Arc::clone(&stop);
		let (startup_tx, startup_rx) = mpsc::channel();
		let thread = thread::Builder::new()
			.name("pi-voice-wasapi-capture".to_owned())
			.spawn(move || capture_thread(config, sink, worker_stop, startup_tx))
			.map_err(|error| format!("failed to spawn WASAPI capture thread: {error}"))?;

		match startup_rx.recv() {
			Ok(Ok(event)) => Ok(Self { stop, event, thread: Some(thread) }),
			Ok(Err(error)) => {
				let _ = thread.join();
				Err(error)
			},
			Err(_) => match thread.join() {
				Ok(Err(error)) => Err(error),
				Ok(Ok(())) => Err("WASAPI capture thread exited during startup".to_owned()),
				Err(_) => Err("WASAPI capture thread panicked during startup".to_owned()),
			},
		}
	}

	/// Stop capture and wait until its worker can no longer invoke `sink`.
	pub fn stop(&mut self) -> VoiceResult<()> {
		stop_worker(&self.stop, &self.event, &mut self.thread, "capture")
	}
}

impl Drop for CaptureDevice {
	fn drop(&mut self) {
		let _ = self.stop();
	}
}

enum RunError {
	DeviceInvalidated,
	Other(String),
}

fn playback_thread(
	config: DeviceConfig,
	mut fill: PlaybackFill,
	stop: Arc<AtomicBool>,
	startup: Sender<VoiceResult<Arc<OwnedEvent>>>,
) -> VoiceResult<()> {
	let mut stream = match PlaybackStream::open(config, None) {
		Ok(stream) => stream,
		Err(error) => {
			let _ = startup.send(Err(error.clone()));
			return Err(error);
		},
	};
	let event = Arc::clone(&stream.base.event);
	startup
		.send(Ok(Arc::clone(&event)))
		.map_err(|_| "WASAPI playback startup receiver was dropped".to_owned())?;

	loop {
		match run_playback(&stream, &stop, &mut fill) {
			Ok(()) => return Ok(()),
			Err(RunError::Other(error)) => return Err(error),
			Err(RunError::DeviceInvalidated) => {
				drop(stream);
				let Some(reopened) = reopen_playback(config, &event, &stop)? else {
					return Ok(());
				};
				stream = reopened;
			},
		}
	}
}

fn run_playback(
	stream: &PlaybackStream,
	stop: &AtomicBool,
	fill: &mut PlaybackFill,
) -> Result<(), RunError> {
	loop {
		if stop.load(Ordering::Acquire) {
			return Ok(());
		}
		let event_signaled = wait_for_event(stream.base.event_handle()).map_err(RunError::Other)?;
		if stop.load(Ordering::Acquire) {
			return Ok(());
		}

		let mut padding = 0;
		// SAFETY: the client is started and the output pointer is valid.
		let hr = unsafe {
			(stream.base.client.vtable().get_current_padding)(
				stream.base.client.as_void(),
				&mut padding,
			)
		};
		check_run_hresult(hr, "IAudioClient::GetCurrentPadding")?;
		if !event_signaled {
			continue;
		}
		let max_padding = stream
			.period_frames
			.saturating_mul(2)
			.min(stream.base.buffer_size);
		if padding
			.checked_add(stream.period_frames)
			.is_none_or(|queued| queued > max_padding)
		{
			continue;
		}

		let frames = stream.period_frames;
		let mut data = null_mut();
		// SAFETY: the render client is live and `data` receives one logical
		// period of writable frames.
		let hr =
			unsafe { (stream.render.vtable().get_buffer)(stream.render.as_void(), frames, &mut data) };
		check_run_hresult(hr, "IAudioRenderClient::GetBuffer")?;
		if data.is_null() {
			// SAFETY: release balances the successful buffer acquisition.
			let _ = unsafe {
				(stream.render.vtable().release_buffer)(
					stream.render.as_void(),
					frames,
					AUDCLNT_BUFFERFLAGS_SILENT as u32,
				)
			};
			return Err(RunError::Other("IAudioRenderClient::GetBuffer returned null".to_owned()));
		}
		if stop.load(Ordering::Acquire) {
			// SAFETY: release balances the successful acquisition; silent
			// prevents uninitialized samples from being rendered.
			let hr = unsafe {
				(stream.render.vtable().release_buffer)(
					stream.render.as_void(),
					frames,
					AUDCLNT_BUFFERFLAGS_SILENT as u32,
				)
			};
			check_run_hresult(hr, "IAudioRenderClient::ReleaseBuffer")?;
			return Ok(());
		}

		// SAFETY: WASAPI returned exactly `frames` writable mono IEEE-float
		// samples for the format used to initialize this client.
		let output = unsafe { slice::from_raw_parts_mut(data.cast::<f32>(), frames as usize) };
		fill(output);
		// SAFETY: release balances the successful acquisition after `fill`
		// initialized the complete fixed-quantum buffer.
		let hr =
			unsafe { (stream.render.vtable().release_buffer)(stream.render.as_void(), frames, 0) };
		check_run_hresult(hr, "IAudioRenderClient::ReleaseBuffer")?;
	}
}

fn capture_thread(
	config: DeviceConfig,
	mut sink: CaptureSink,
	stop: Arc<AtomicBool>,
	startup: Sender<VoiceResult<Arc<OwnedEvent>>>,
) -> VoiceResult<()> {
	let mut stream = match CaptureStream::open(config, None) {
		Ok(stream) => stream,
		Err(error) => {
			let _ = startup.send(Err(error.clone()));
			return Err(error);
		},
	};
	let event = Arc::clone(&stream.base.event);
	startup
		.send(Ok(Arc::clone(&event)))
		.map_err(|_| "WASAPI capture startup receiver was dropped".to_owned())?;

	loop {
		match run_capture(&stream, &stop, &mut sink) {
			Ok(()) => return Ok(()),
			Err(RunError::Other(error)) => return Err(error),
			Err(RunError::DeviceInvalidated) => {
				drop(stream);
				let Some(reopened) = reopen_capture(config, &event, &stop)? else {
					return Ok(());
				};
				stream = reopened;
			},
		}
	}
}

fn run_capture(
	stream: &CaptureStream,
	stop: &AtomicBool,
	sink: &mut CaptureSink,
) -> Result<(), RunError> {
	let silent = vec![0.0_f32; stream.base.buffer_size as usize];
	'events: loop {
		if stop.load(Ordering::Acquire) {
			return Ok(());
		}
		wait_for_event(stream.base.event_handle()).map_err(RunError::Other)?;
		if stop.load(Ordering::Acquire) {
			return Ok(());
		}

		loop {
			if stop.load(Ordering::Acquire) {
				break 'events;
			}
			let mut packet_size = 0;
			// SAFETY: the capture service is live and the output pointer is valid.
			let hr = unsafe {
				(stream.capture.vtable().get_next_packet_size)(
					stream.capture.as_void(),
					&mut packet_size,
				)
			};
			check_run_hresult(hr, "IAudioCaptureClient::GetNextPacketSize")?;
			if packet_size == 0 {
				break;
			}

			let mut data = null_mut();
			let mut frames = 0;
			let mut flags = 0;
			// SAFETY: all outputs are valid and device/QPC positions are optional.
			let hr = unsafe {
				(stream.capture.vtable().get_buffer)(
					stream.capture.as_void(),
					&mut data,
					&mut frames,
					&mut flags,
					null_mut(),
					null_mut(),
				)
			};
			check_run_hresult(hr, "IAudioCaptureClient::GetBuffer")?;

			if stop.load(Ordering::Acquire) {
				// SAFETY: release balances the successful buffer acquisition.
				let hr = unsafe {
					(stream.capture.vtable().release_buffer)(stream.capture.as_void(), frames)
				};
				check_run_hresult(hr, "IAudioCaptureClient::ReleaseBuffer")?;
				break 'events;
			}

			if frames != 0 {
				if flags & AUDCLNT_BUFFERFLAGS_SILENT as u32 != 0 {
					let Some(samples) = silent.get(..frames as usize) else {
						// SAFETY: release balances the successful buffer acquisition.
						let _ = unsafe {
							(stream.capture.vtable().release_buffer)(stream.capture.as_void(), frames)
						};
						return Err(RunError::Other(
							"WASAPI capture packet exceeds the endpoint buffer".to_owned(),
						));
					};
					sink(samples);
				} else {
					if data.is_null() {
						// SAFETY: release balances the successful buffer acquisition.
						let _ = unsafe {
							(stream.capture.vtable().release_buffer)(stream.capture.as_void(), frames)
						};
						return Err(RunError::Other(
							"IAudioCaptureClient::GetBuffer returned null".to_owned(),
						));
					}
					// SAFETY: WASAPI returned `frames` readable mono IEEE-float samples
					// for the format used to initialize this client.
					let samples = unsafe { slice::from_raw_parts(data.cast::<f32>(), frames as usize) };
					sink(samples);
				}
			}

			// SAFETY: release balances the successful buffer acquisition.
			let hr =
				unsafe { (stream.capture.vtable().release_buffer)(stream.capture.as_void(), frames) };
			check_run_hresult(hr, "IAudioCaptureClient::ReleaseBuffer")?;
		}
	}
	Ok(())
}

// We deliberately omit `IMMNotificationClient`: a live endpoint stays selected
// across default-device changes. Device invalidation is the unambiguous point
// at which these retries reopen whichever endpoint is currently the default.
fn reopen_playback(
	config: DeviceConfig,
	event: &Arc<OwnedEvent>,
	stop: &AtomicBool,
) -> VoiceResult<Option<PlaybackStream>> {
	let mut last_error = "default endpoint remained unavailable".to_owned();
	for attempt in 0..REOPEN_ATTEMPTS {
		if stop.load(Ordering::Acquire) {
			return Ok(None);
		}
		if attempt != 0 {
			thread::sleep(REOPEN_BACKOFF);
			if stop.load(Ordering::Acquire) {
				return Ok(None);
			}
		}
		match PlaybackStream::open(config, Some(Arc::clone(event))) {
			Ok(stream) => return Ok(Some(stream)),
			Err(error) => last_error = error,
		}
	}
	Err(format!(
		"WASAPI playback endpoint recovery failed after {REOPEN_ATTEMPTS} attempts: {last_error}"
	))
}

fn reopen_capture(
	config: DeviceConfig,
	event: &Arc<OwnedEvent>,
	stop: &AtomicBool,
) -> VoiceResult<Option<CaptureStream>> {
	let mut last_error = "default endpoint remained unavailable".to_owned();
	for attempt in 0..REOPEN_ATTEMPTS {
		if stop.load(Ordering::Acquire) {
			return Ok(None);
		}
		if attempt != 0 {
			thread::sleep(REOPEN_BACKOFF);
			if stop.load(Ordering::Acquire) {
				return Ok(None);
			}
		}
		match CaptureStream::open(config, Some(Arc::clone(event))) {
			Ok(stream) => return Ok(Some(stream)),
			Err(error) => last_error = error,
		}
	}
	Err(format!(
		"WASAPI capture endpoint recovery failed after {REOPEN_ATTEMPTS} attempts: {last_error}"
	))
}

fn wait_for_event(event: EventHandle) -> VoiceResult<bool> {
	// SAFETY: a reference-counted owner keeps this handle live throughout waits.
	let result = unsafe { WaitForSingleObject(event.0, WAIT_TIMEOUT_MS) };
	match result {
		WAIT_OBJECT_0 => Ok(true),
		WAIT_TIMEOUT => Ok(false),
		code => Err(format!("WaitForSingleObject failed (result 0x{code:08X})")),
	}
}

fn stop_worker(
	stop: &AtomicBool,
	event: &OwnedEvent,
	thread: &mut Option<JoinHandle<VoiceResult<()>>>,
	direction: &str,
) -> VoiceResult<()> {
	stop.store(true, Ordering::Release);
	event.signal();
	if thread
		.as_ref()
		.is_some_and(|worker| worker.thread().id() == thread::current().id())
	{
		// Callback-thread stop cannot wait for its own frame to unwind. The
		// callback-thread carve-out accepts that; the flag prevents another
		// delivery, and retaining the handle still permits a later external join.
		return Ok(());
	}
	let Some(thread) = thread.take() else {
		return Ok(());
	};
	match thread.join() {
		Ok(result) => result,
		Err(_) => Err(format!("WASAPI {direction} thread panicked")),
	}
}

fn check_hresult(hr: HRESULT, what: &str) -> VoiceResult<()> {
	if hr < 0 {
		Err(format!("{what} failed (HRESULT 0x{:08X})", hr as u32))
	} else {
		Ok(())
	}
}

fn check_run_hresult(hr: HRESULT, what: &str) -> Result<(), RunError> {
	if hr == AUDCLNT_E_DEVICE_INVALIDATED {
		Err(RunError::DeviceInvalidated)
	} else {
		check_hresult(hr, what).map_err(RunError::Other)
	}
}
