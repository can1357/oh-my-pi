//! macOS default-device audio backend using `AudioToolbox` Audio Queues.

use std::{
	ffi::{c_char, c_void},
	mem::size_of,
	ptr, slice,
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicUsize, Ordering},
	},
	thread,
};

use block2::RcBlock;
use objc2::{
	msg_send,
	runtime::{AnyClass, AnyObject, Bool},
};
use omp_core::Str;

use super::{
	AudioDevice, CaptureSink, DeviceConfig, DeviceSnapshot, MicrophonePermission, PlaybackFill,
};
use crate::device::BackendResult as VoiceResult;

const BUFFER_COUNT: usize = 3;
const LINEAR_PCM: u32 = u32::from_be_bytes(*b"lpcm");
const FORMAT_FLAGS: u32 = 0x9;
const SYSTEM_OBJECT: u32 = 1;
const HARDWARE_DEVICES: u32 = u32::from_be_bytes(*b"dev#");
const DEFAULT_INPUT_DEVICE: u32 = u32::from_be_bytes(*b"dIn ");
const DEFAULT_OUTPUT_DEVICE: u32 = u32::from_be_bytes(*b"dOut");
const DEVICE_STREAMS: u32 = u32::from_be_bytes(*b"stm#");
const DEVICE_UID: u32 = u32::from_be_bytes(*b"uid ");
const DEVICE_NAME: u32 = u32::from_be_bytes(*b"lnam");
const SCOPE_GLOBAL: u32 = u32::from_be_bytes(*b"glob");
const SCOPE_INPUT: u32 = u32::from_be_bytes(*b"inpt");
const SCOPE_OUTPUT: u32 = u32::from_be_bytes(*b"outp");
const MAIN_ELEMENT: u32 = 0;
const AUDIO_QUEUE_CURRENT_DEVICE: u32 = u32::from_be_bytes(*b"aqcd");
const UTF8_ENCODING: u32 = 0x0800_0100;

type AudioDeviceId = u32;
type AudioObjectId = u32;
type CFIndex = isize;
type CFStringRef = *const c_void;

type AudioQueueRef = *mut AudioQueueOpaque;
type AudioTimeStamp = c_void;
type AudioStreamPacketDescription = c_void;

#[repr(C)]
struct AudioQueueOpaque {
	_private: [u8; 0],
}

#[repr(C)]
#[derive(Clone, Copy)]
struct AudioObjectPropertyAddress {
	selector: u32,
	scope:    u32,
	element:  u32,
}

struct QueueHandle(AudioQueueRef);

// SAFETY: AudioQueue control functions explicitly support calls from arbitrary
// threads.
unsafe impl Send for QueueHandle {}

impl QueueHandle {
	fn stop_and_dispose(self) -> VoiceResult<()> {
		// SAFETY: This handle owns a live queue; an immediate stop waits for queue
		// activity.
		let stop_status = unsafe { AudioQueueStop(self.0, 1) };
		// SAFETY: The synchronous stop completed, and this handle exclusively owns the
		// queue.
		let dispose_status = unsafe { AudioQueueDispose(self.0, 1) };
		if stop_status != 0 {
			return Err(format!("CoreAudio queue stop failed (OSStatus {stop_status})"));
		}
		if dispose_status != 0 {
			return Err(format!("CoreAudio queue dispose failed (OSStatus {dispose_status})"));
		}
		Ok(())
	}
}

#[repr(C)]
#[allow(non_snake_case, reason = "fields must match the CoreAudio C ABI")]
struct AudioStreamBasicDescription {
	mSampleRate:       f64,
	mFormatID:         u32,
	mFormatFlags:      u32,
	mBytesPerPacket:   u32,
	mFramesPerPacket:  u32,
	mBytesPerFrame:    u32,
	mChannelsPerFrame: u32,
	mBitsPerChannel:   u32,
	mReserved:         u32,
}

#[repr(C)]
#[allow(non_snake_case, reason = "fields must match the AudioQueue C ABI")]
struct AudioQueueBuffer {
	mAudioDataBytesCapacity:    u32,
	mAudioData:                 *mut c_void,
	mAudioDataByteSize:         u32,
	mUserData:                  *mut c_void,
	mPacketDescriptionCapacity: u32,
	mPacketDescriptions:        *mut c_void,
	mPacketDescriptionCount:    u32,
}

#[link(name = "AudioToolbox", kind = "framework")]
unsafe extern "C" {
	fn AudioQueueNewOutput(
		format: *const AudioStreamBasicDescription,
		callback: unsafe extern "C" fn(*mut c_void, AudioQueueRef, *mut AudioQueueBuffer),
		user_data: *mut c_void,
		callback_run_loop: *const c_void,
		callback_run_loop_mode: *const c_void,
		flags: u32,
		queue: *mut AudioQueueRef,
	) -> i32;
	fn AudioQueueNewInput(
		format: *const AudioStreamBasicDescription,
		callback: unsafe extern "C" fn(
			*mut c_void,
			AudioQueueRef,
			*mut AudioQueueBuffer,
			*const AudioTimeStamp,
			u32,
			*const AudioStreamPacketDescription,
		),
		user_data: *mut c_void,
		callback_run_loop: *const c_void,
		callback_run_loop_mode: *const c_void,
		flags: u32,
		queue: *mut AudioQueueRef,
	) -> i32;
	fn AudioQueueAllocateBuffer(
		queue: AudioQueueRef,
		buffer_byte_size: u32,
		buffer: *mut *mut AudioQueueBuffer,
	) -> i32;
	fn AudioQueueEnqueueBuffer(
		queue: AudioQueueRef,
		buffer: *mut AudioQueueBuffer,
		packet_description_count: u32,
		packet_descriptions: *const AudioStreamPacketDescription,
	) -> i32;
	fn AudioQueueStart(queue: AudioQueueRef, start_time: *const AudioTimeStamp) -> i32;
	fn AudioQueueStop(queue: AudioQueueRef, immediate: u8) -> i32;
	fn AudioQueueDispose(queue: AudioQueueRef, immediate: u8) -> i32;
	fn AudioQueueSetProperty(
		queue: AudioQueueRef,
		property: u32,
		data: *const c_void,
		data_size: u32,
	) -> i32;
}

#[link(name = "CoreAudio", kind = "framework")]
unsafe extern "C" {
	fn AudioObjectGetPropertyDataSize(
		object: AudioObjectId,
		address: *const AudioObjectPropertyAddress,
		qualifier_size: u32,
		qualifier_data: *const c_void,
		data_size: *mut u32,
	) -> i32;
	fn AudioObjectGetPropertyData(
		object: AudioObjectId,
		address: *const AudioObjectPropertyAddress,
		qualifier_size: u32,
		qualifier_data: *const c_void,
		data_size: *mut u32,
		data: *mut c_void,
	) -> i32;
}

#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
	fn CFStringGetLength(value: CFStringRef) -> CFIndex;
	fn CFStringGetMaximumSizeForEncoding(length: CFIndex, encoding: u32) -> CFIndex;
	fn CFStringGetCString(
		value: CFStringRef,
		buffer: *mut c_char,
		buffer_size: CFIndex,
		encoding: u32,
	) -> u8;
	fn CFStringCreateWithBytes(
		allocator: *const c_void,
		bytes: *const u8,
		length: CFIndex,
		encoding: u32,
		is_external_representation: u8,
	) -> CFStringRef;
	fn CFRelease(value: *const c_void);
}

#[link(name = "AVFoundation", kind = "framework")]
unsafe extern "C" {
	static AVMediaTypeAudio: *mut AnyObject;
}

unsafe extern "C" {
	fn pthread_self() -> usize;
}

const fn property_address(selector: u32, scope: u32) -> AudioObjectPropertyAddress {
	AudioObjectPropertyAddress { selector, scope, element: MAIN_ELEMENT }
}

fn property_size(object: AudioObjectId, address: &AudioObjectPropertyAddress) -> VoiceResult<u32> {
	let mut size = 0;
	// SAFETY: address and output size remain valid for the duration of the call.
	let status =
		unsafe { AudioObjectGetPropertyDataSize(object, address, 0, ptr::null(), &mut size) };
	if status != 0 {
		return Err(format!("CoreAudio property size query failed (OSStatus {status})"));
	}
	Ok(size)
}

fn scalar_property<T: Copy>(
	object: AudioObjectId,
	address: &AudioObjectPropertyAddress,
) -> VoiceResult<T> {
	let mut value = std::mem::MaybeUninit::<T>::uninit();
	let mut size = size_of::<T>() as u32;
	// SAFETY: output points to exactly `size_of::<T>()` writable bytes.
	let status = unsafe {
		AudioObjectGetPropertyData(
			object,
			address,
			0,
			ptr::null(),
			&mut size,
			value.as_mut_ptr().cast(),
		)
	};
	if status != 0 || size as usize != size_of::<T>() {
		return Err(format!("CoreAudio property query failed (OSStatus {status}, size {size})"));
	}
	// SAFETY: CoreAudio reported success and initialized the complete scalar.
	Ok(unsafe { value.assume_init() })
}

fn cf_string_property(
	object: AudioObjectId,
	address: &AudioObjectPropertyAddress,
) -> VoiceResult<Str> {
	let value = scalar_property::<CFStringRef>(object, address)?;
	if value.is_null() {
		return Err("CoreAudio returned a null device string".to_owned());
	}
	// SAFETY: the property returned a valid CFString for the duration of this call.
	let length = unsafe { CFStringGetLength(value) };
	// SAFETY: `value` is a live CFString and UTF-8 is a supported CoreFoundation
	// encoding.
	let capacity = unsafe { CFStringGetMaximumSizeForEncoding(length, UTF8_ENCODING) }
		.checked_add(1)
		.filter(|capacity| *capacity > 0)
		.ok_or_else(|| "CoreAudio device string is too large".to_owned())?;
	let capacity_usize =
		usize::try_from(capacity).map_err(|_| "CoreAudio device string is too large".to_owned())?;
	let mut buffer = vec![0_u8; capacity_usize];
	// SAFETY: buffer has the advertised writable capacity and `value` is a live
	// CFString.
	let copied =
		unsafe { CFStringGetCString(value, buffer.as_mut_ptr().cast(), capacity, UTF8_ENCODING) };
	if copied == 0 {
		return Err("CoreAudio device string is not valid UTF-8".to_owned());
	}
	let length = buffer
		.iter()
		.position(|byte| *byte == 0)
		.unwrap_or(buffer.len());
	let text = std::str::from_utf8(&buffer[..length])
		.map_err(|_| "CoreAudio device string is not valid UTF-8".to_owned())?;
	Ok(Str::from(text))
}

fn default_device(selector: u32) -> VoiceResult<AudioDeviceId> {
	scalar_property(SYSTEM_OBJECT, &property_address(selector, SCOPE_GLOBAL))
}

fn endpoints(scope: u32, default: AudioDeviceId) -> VoiceResult<Vec<AudioDevice>> {
	let address = property_address(HARDWARE_DEVICES, SCOPE_GLOBAL);
	let size = property_size(SYSTEM_OBJECT, &address)?;
	let count = size as usize / size_of::<AudioDeviceId>();
	let mut ids = vec![0; count];
	let mut written = size;
	// SAFETY: `ids` provides exactly the writable byte count passed to CoreAudio.
	let status = unsafe {
		AudioObjectGetPropertyData(
			SYSTEM_OBJECT,
			&address,
			0,
			ptr::null(),
			&mut written,
			ids.as_mut_ptr().cast(),
		)
	};
	if status != 0 {
		return Err(format!("CoreAudio device enumeration failed (OSStatus {status})"));
	}
	ids.truncate(written as usize / size_of::<AudioDeviceId>());
	let mut devices = Vec::new();
	for id in ids {
		let streams = property_address(DEVICE_STREAMS, scope);
		if property_size(id, &streams).unwrap_or_default() == 0 {
			continue;
		}
		let uid = cf_string_property(id, &property_address(DEVICE_UID, SCOPE_GLOBAL))?;
		let label = cf_string_property(id, &property_address(DEVICE_NAME, SCOPE_GLOBAL))?;
		devices.push(AudioDevice { id: uid, label, is_default: id == default });
	}
	devices.sort_by(|left, right| left.label.cmp(&right.label).then(left.id.cmp(&right.id)));
	Ok(devices)
}

pub(super) fn microphone_permission() -> MicrophonePermission {
	let Some(class) = AnyClass::get(c"AVCaptureDevice") else {
		return MicrophonePermission::Unknown;
	};
	// SAFETY: AVFoundation exports this process-lifetime media-type constant.
	let media_type = unsafe { AVMediaTypeAudio };
	if media_type.is_null() {
		return MicrophonePermission::Unknown;
	}
	// SAFETY: this stable AVFoundation class method accepts an AVMediaType
	// NSString.
	let status: isize = unsafe { msg_send![class, authorizationStatusForMediaType: media_type] };
	match status {
		0 => MicrophonePermission::Unknown,
		1 => MicrophonePermission::Restricted,
		2 => MicrophonePermission::Denied,
		3 => MicrophonePermission::Granted,
		_ => MicrophonePermission::Unknown,
	}
}

pub(super) async fn request_microphone_permission() -> VoiceResult<MicrophonePermission> {
	let current = microphone_permission();
	if current != MicrophonePermission::Unknown {
		return Ok(current);
	}
	let receiver = start_microphone_permission_request()?;
	let granted = receiver
		.recv_async()
		.await
		.map_err(|_| "AVFoundation microphone permission request was cancelled".to_owned())?;
	Ok(if granted {
		MicrophonePermission::Granted
	} else {
		match microphone_permission() {
			MicrophonePermission::Restricted => MicrophonePermission::Restricted,
			_ => MicrophonePermission::Denied,
		}
	})
}

fn start_microphone_permission_request() -> VoiceResult<flume::Receiver<bool>> {
	let class = AnyClass::get(c"AVCaptureDevice")
		.ok_or_else(|| "AVCaptureDevice is unavailable".to_owned())?;
	// SAFETY: AVFoundation exports this process-lifetime media-type constant.
	let media_type = unsafe { AVMediaTypeAudio };
	if media_type.is_null() {
		return Err("AVMediaTypeAudio is unavailable".to_owned());
	}
	let (sender, receiver) = flume::bounded(1);
	let completion = RcBlock::new(move |granted: Bool| {
		let _ = sender.send(granted.as_bool());
	});
	// SAFETY: this stable AVFoundation method copies the completion block before
	// returning.
	let (): () = unsafe {
		msg_send![
			class,
			requestAccessForMediaType: media_type,
			completionHandler: &*completion
		]
	};
	Ok(receiver)
}

pub(super) fn snapshot() -> VoiceResult<DeviceSnapshot> {
	let default_input = default_device(DEFAULT_INPUT_DEVICE)?;
	let default_output = default_device(DEFAULT_OUTPUT_DEVICE)?;
	Ok(DeviceSnapshot {
		input:                 endpoints(SCOPE_INPUT, default_input)?,
		output:                endpoints(SCOPE_OUTPUT, default_output)?,
		microphone_permission: microphone_permission(),
	})
}

struct OwnedCfString(CFStringRef);

impl OwnedCfString {
	fn new(value: &str) -> VoiceResult<Self> {
		let length = CFIndex::try_from(value.len())
			.map_err(|_| "CoreAudio device ID is too large".to_owned())?;
		// SAFETY: bytes remain live during construction and CoreFoundation copies them.
		let string =
			unsafe { CFStringCreateWithBytes(ptr::null(), value.as_ptr(), length, UTF8_ENCODING, 0) };
		if string.is_null() {
			return Err("CoreAudio could not encode the selected device ID".to_owned());
		}
		Ok(Self(string))
	}
}

impl Drop for OwnedCfString {
	fn drop(&mut self) {
		// SAFETY: this wrapper owns one create-rule CoreFoundation reference.
		unsafe { CFRelease(self.0) };
	}
}

fn select_queue_device(queue: AudioQueueRef, device_id: Option<&str>) -> VoiceResult<()> {
	let Some(device_id) = device_id else {
		return Ok(());
	};
	let device = OwnedCfString::new(device_id)?;
	let value = device.0;
	// SAFETY: queue is live and the property data points to one valid CFStringRef.
	let status = unsafe {
		AudioQueueSetProperty(
			queue,
			AUDIO_QUEUE_CURRENT_DEVICE,
			ptr::from_ref(&value).cast(),
			size_of::<CFStringRef>() as u32,
		)
	};
	if status != 0 {
		return Err(format!(
			"CoreAudio selected device `{device_id}` is unavailable (OSStatus {status})"
		));
	}
	Ok(())
}

struct PlaybackContext {
	fill:            PlaybackFill,
	stopped:         Arc<AtomicBool>,
	callback_thread: Arc<AtomicUsize>,
}

struct CaptureContext {
	sink:            CaptureSink,
	stopped:         Arc<AtomicBool>,
	callback_thread: Arc<AtomicUsize>,
}

fn stream_format(sample_rate: u32) -> AudioStreamBasicDescription {
	AudioStreamBasicDescription {
		mSampleRate:       f64::from(sample_rate),
		mFormatID:         LINEAR_PCM,
		mFormatFlags:      FORMAT_FLAGS,
		mBytesPerPacket:   size_of::<f32>() as u32,
		mFramesPerPacket:  1,
		mBytesPerFrame:    size_of::<f32>() as u32,
		mChannelsPerFrame: 1,
		mBitsPerChannel:   32,
		mReserved:         0,
	}
}

fn buffer_size(config: &DeviceConfig) -> VoiceResult<u32> {
	config
		.period_samples()
		.checked_mul(size_of::<f32>())
		.and_then(|bytes| u32::try_from(bytes).ok())
		.ok_or_else(|| "CoreAudio period buffer is too large".to_owned())
}

fn dispose_failed_start(queue: AudioQueueRef, operation: &str, status: i32) -> String {
	if !queue.is_null() {
		// SAFETY: `queue` was returned by AudioQueueNewInput/Output and has not been
		// disposed.
		unsafe { AudioQueueDispose(queue, 1) };
	}
	format!("CoreAudio {operation} failed (OSStatus {status})")
}

unsafe extern "C" fn playback_callback(
	user_data: *mut c_void,
	queue: AudioQueueRef,
	buffer: *mut AudioQueueBuffer,
) {
	if user_data.is_null() || queue.is_null() || buffer.is_null() {
		return;
	}
	let context = user_data.cast::<PlaybackContext>();
	// SAFETY: AudioQueue passes the live context pointer supplied when the queue
	// was created.
	unsafe {
		(*context)
			.callback_thread
			.store(pthread_self(), Ordering::Release);
	};
	// SAFETY: The callback only projects the independently allocated atomic flag
	// from `context`.
	if unsafe { (*context).stopped.load(Ordering::Acquire) } {
		// SAFETY: The context remains live until synchronous queue disposal completes.
		unsafe { (*context).callback_thread.store(0, Ordering::Release) };
		return;
	}
	// SAFETY: AudioQueue passes one of its allocated buffers exclusively to this
	// callback.
	let buffer = unsafe { &mut *buffer };
	let sample_count = buffer.mAudioDataBytesCapacity as usize / size_of::<f32>();
	// SAFETY: AudioQueue allocated `mAudioData` with the reported capacity for
	// linear PCM data.
	let samples =
		unsafe { slice::from_raw_parts_mut(buffer.mAudioData.cast::<f32>(), sample_count) };
	// SAFETY: AudioQueue serializes callbacks, so only this callback borrows the
	// `fill` field.
	unsafe { ((*context).fill)(samples) };
	// SAFETY: The callback only projects the independently allocated atomic flag
	// from `context`.
	if !unsafe { (*context).stopped.load(Ordering::Acquire) } {
		buffer.mAudioDataByteSize = buffer.mAudioDataBytesCapacity;
		// SAFETY: The queue and buffer belong to this callback and remain live while it
		// returns.
		let _ = unsafe { AudioQueueEnqueueBuffer(queue, buffer, 0, ptr::null()) };
	}
	// SAFETY: The context remains live until synchronous queue disposal completes.
	unsafe { (*context).callback_thread.store(0, Ordering::Release) };
}

unsafe extern "C" fn capture_callback(
	user_data: *mut c_void,
	queue: AudioQueueRef,
	buffer: *mut AudioQueueBuffer,
	_start_time: *const AudioTimeStamp,
	_packet_count: u32,
	_packet_descriptions: *const AudioStreamPacketDescription,
) {
	if user_data.is_null() || queue.is_null() || buffer.is_null() {
		return;
	}
	let context = user_data.cast::<CaptureContext>();
	// SAFETY: AudioQueue passes the live context pointer supplied when the queue
	// was created.
	unsafe {
		(*context)
			.callback_thread
			.store(pthread_self(), Ordering::Release);
	};
	// SAFETY: The callback only projects the independently allocated atomic flag
	// from `context`.
	if unsafe { (*context).stopped.load(Ordering::Acquire) } {
		// SAFETY: The context remains live until synchronous queue disposal completes.
		unsafe { (*context).callback_thread.store(0, Ordering::Release) };
		return;
	}
	// SAFETY: AudioQueue passes one of its allocated buffers exclusively to this
	// callback.
	let buffer = unsafe { &mut *buffer };
	let byte_size = buffer.mAudioDataByteSize as usize;
	if byte_size != 0 && byte_size.is_multiple_of(size_of::<f32>()) {
		// SAFETY: AudioQueue filled `mAudioDataByteSize` bytes within this allocated
		// buffer.
		let samples = unsafe {
			slice::from_raw_parts(buffer.mAudioData.cast::<f32>(), byte_size / size_of::<f32>())
		};
		// SAFETY: AudioQueue serializes callbacks, so only this callback borrows the
		// `sink` field.
		unsafe { ((*context).sink)(samples) };
	}
	// SAFETY: The callback only projects the independently allocated atomic flag
	// from `context`.
	if !unsafe { (*context).stopped.load(Ordering::Acquire) } {
		// SAFETY: The queue and buffer belong to this callback and remain live while it
		// returns.
		let _ = unsafe { AudioQueueEnqueueBuffer(queue, buffer, 0, ptr::null()) };
	}
	// SAFETY: The context remains live until synchronous queue disposal completes.
	unsafe { (*context).callback_thread.store(0, Ordering::Release) };
}

/// Running `CoreAudio` speaker queue.
pub struct PlaybackDevice {
	queue:           Option<QueueHandle>,
	context:         Option<Box<PlaybackContext>>,
	stopped:         Arc<AtomicBool>,
	callback_thread: Arc<AtomicUsize>,
}

// SAFETY: AudioQueue control functions may be called from any thread, and the
// callback is `Send`.
unsafe impl Send for PlaybackDevice {}

impl PlaybackDevice {
	/// Open and start the selected or default speaker queue.
	pub fn start(config: DeviceConfig, fill: PlaybackFill) -> VoiceResult<Self> {
		let byte_size = buffer_size(&config)?;
		let format = stream_format(config.sample_rate);
		let stopped = Arc::new(AtomicBool::new(false));
		let callback_thread = Arc::new(AtomicUsize::new(0));
		let mut context = Box::new(PlaybackContext {
			fill,
			stopped: Arc::clone(&stopped),
			callback_thread: Arc::clone(&callback_thread),
		});
		let user_data = ptr::from_mut(&mut *context).cast::<c_void>();
		let mut queue = ptr::null_mut();
		// SAFETY: All pointers are valid for the call; the boxed context outlives the
		// queue.
		let status = unsafe {
			AudioQueueNewOutput(
				&format,
				playback_callback,
				user_data,
				ptr::null(),
				ptr::null(),
				0,
				&mut queue,
			)
		};
		if status != 0 {
			return Err(dispose_failed_start(queue, "queue creation", status));
		}
		if let Err(error) = select_queue_device(queue, config.device_id.as_deref()) {
			// SAFETY: queue was created successfully and has not started.
			unsafe { AudioQueueDispose(queue, 1) };
			return Err(error);
		}

		for _ in 0..BUFFER_COUNT {
			let mut buffer = ptr::null_mut();
			// SAFETY: `queue` is live and `buffer` points to writable storage for the
			// result.
			let status = unsafe { AudioQueueAllocateBuffer(queue, byte_size, &mut buffer) };
			if status != 0 {
				return Err(dispose_failed_start(queue, "buffer allocation", status));
			}
			// SAFETY: AudioQueue returned a valid buffer with at least `byte_size` writable
			// bytes.
			let buffer_ref = unsafe { &mut *buffer };
			let sample_count = buffer_ref.mAudioDataBytesCapacity as usize / size_of::<f32>();
			// SAFETY: AudioQueue allocated the data pointer with the reported capacity.
			let samples =
				unsafe { slice::from_raw_parts_mut(buffer_ref.mAudioData.cast::<f32>(), sample_count) };
			(context.fill)(samples);
			buffer_ref.mAudioDataByteSize = buffer_ref.mAudioDataBytesCapacity;
			// SAFETY: `queue` and `buffer` are live, and PCM requires no packet
			// descriptions.
			let status = unsafe { AudioQueueEnqueueBuffer(queue, buffer, 0, ptr::null()) };
			if status != 0 {
				return Err(dispose_failed_start(queue, "buffer enqueue", status));
			}
		}

		// SAFETY: `queue` is live and null requests immediate start.
		let status = unsafe { AudioQueueStart(queue, ptr::null()) };
		if status != 0 {
			return Err(dispose_failed_start(queue, "queue start", status));
		}
		Ok(Self { queue: Some(QueueHandle(queue)), context: Some(context), stopped, callback_thread })
	}

	/// Stop playback and dispose the queue, handing off teardown from its
	/// callback thread.
	pub fn stop(&mut self) -> VoiceResult<()> {
		self.stopped.store(true, Ordering::Release);
		let Some(queue) = self.queue.take() else {
			return Ok(());
		};
		let Some(context) = self.context.take() else {
			self.queue = Some(queue);
			return Err("CoreAudio playback queue lost its callback context".to_owned());
		};
		// SAFETY: `pthread_self` returns the stable identifier for the calling thread.
		let current_thread = unsafe { pthread_self() };
		if current_thread != 0 && self.callback_thread.load(Ordering::Acquire) == current_thread {
			let stopped = Arc::clone(&self.stopped);
			drop(thread::spawn(move || {
				stopped.store(true, Ordering::Release);
				let _ = queue.stop_and_dispose();
				drop(context);
			}));
			return Ok(());
		}
		let result = queue.stop_and_dispose();
		drop(context);
		result
	}
}

impl Drop for PlaybackDevice {
	fn drop(&mut self) {
		let _ = self.stop();
	}
}

/// Running `CoreAudio` microphone queue.
pub struct CaptureDevice {
	queue:           Option<QueueHandle>,
	context:         Option<Box<CaptureContext>>,
	stopped:         Arc<AtomicBool>,
	callback_thread: Arc<AtomicUsize>,
}

// SAFETY: AudioQueue control functions may be called from any thread, and the
// callback is `Send`.
unsafe impl Send for CaptureDevice {}

impl CaptureDevice {
	/// Open and start the selected or default microphone queue.
	pub fn start(config: DeviceConfig, sink: CaptureSink) -> VoiceResult<Self> {
		let byte_size = buffer_size(&config)?;
		let format = stream_format(config.sample_rate);
		let stopped = Arc::new(AtomicBool::new(false));
		let callback_thread = Arc::new(AtomicUsize::new(0));
		let mut context = Box::new(CaptureContext {
			sink,
			stopped: Arc::clone(&stopped),
			callback_thread: Arc::clone(&callback_thread),
		});
		let user_data = ptr::from_mut(&mut *context).cast::<c_void>();
		let mut queue = ptr::null_mut();
		// SAFETY: All pointers are valid for the call; the boxed context outlives the
		// queue.
		let status = unsafe {
			AudioQueueNewInput(
				&format,
				capture_callback,
				user_data,
				ptr::null(),
				ptr::null(),
				0,
				&mut queue,
			)
		};
		if status != 0 {
			return Err(dispose_failed_start(queue, "queue creation", status));
		}
		if let Err(error) = select_queue_device(queue, config.device_id.as_deref()) {
			// SAFETY: queue was created successfully and has not started.
			unsafe { AudioQueueDispose(queue, 1) };
			return Err(error);
		}

		for _ in 0..BUFFER_COUNT {
			let mut buffer = ptr::null_mut();
			// SAFETY: `queue` is live and `buffer` points to writable storage for the
			// result.
			let status = unsafe { AudioQueueAllocateBuffer(queue, byte_size, &mut buffer) };
			if status != 0 {
				return Err(dispose_failed_start(queue, "buffer allocation", status));
			}
			// SAFETY: `queue` and `buffer` are live, and input PCM requires no packet
			// descriptions.
			let status = unsafe { AudioQueueEnqueueBuffer(queue, buffer, 0, ptr::null()) };
			if status != 0 {
				return Err(dispose_failed_start(queue, "buffer enqueue", status));
			}
		}

		// SAFETY: `queue` is live and null requests immediate start.
		let status = unsafe { AudioQueueStart(queue, ptr::null()) };
		if status != 0 {
			return Err(dispose_failed_start(queue, "queue start", status));
		}
		Ok(Self { queue: Some(QueueHandle(queue)), context: Some(context), stopped, callback_thread })
	}

	/// Stop capture and dispose the queue, handing off teardown from its
	/// callback thread.
	pub fn stop(&mut self) -> VoiceResult<()> {
		self.stopped.store(true, Ordering::Release);
		let Some(queue) = self.queue.take() else {
			return Ok(());
		};
		let Some(context) = self.context.take() else {
			self.queue = Some(queue);
			return Err("CoreAudio capture queue lost its callback context".to_owned());
		};
		// SAFETY: `pthread_self` returns the stable identifier for the calling thread.
		let current_thread = unsafe { pthread_self() };
		if current_thread != 0 && self.callback_thread.load(Ordering::Acquire) == current_thread {
			let stopped = Arc::clone(&self.stopped);
			drop(thread::spawn(move || {
				stopped.store(true, Ordering::Release);
				let _ = queue.stop_and_dispose();
				drop(context);
			}));
			return Ok(());
		}
		let result = queue.stop_and_dispose();
		drop(context);
		result
	}
}

impl Drop for CaptureDevice {
	fn drop(&mut self) {
		let _ = self.stop();
	}
}
