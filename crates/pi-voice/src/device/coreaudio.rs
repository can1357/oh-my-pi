//! macOS default-device audio backend using `AudioToolbox` Audio Queues.

use std::{
	ffi::c_void,
	mem::size_of,
	ptr, slice,
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicUsize, Ordering},
	},
};

use super::{CaptureSink, DeviceConfig, PlaybackFill};
use crate::VoiceResult;

const BUFFER_COUNT: usize = 3;
const LINEAR_PCM: u32 = 0x6c70_636d;
const FORMAT_FLAGS: u32 = 0x9;

type AudioQueueRef = *mut AudioQueueOpaque;
type AudioTimeStamp = c_void;
type AudioStreamPacketDescription = c_void;

#[repr(C)]
struct AudioQueueOpaque {
	_private: [u8; 0],
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
}

unsafe extern "C" {
	fn pthread_self() -> usize;
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

fn buffer_size(config: DeviceConfig) -> VoiceResult<u32> {
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

/// Running `CoreAudio` default-speaker queue.
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
	/// Open and start the default speaker queue.
	pub fn start(config: DeviceConfig, fill: PlaybackFill) -> VoiceResult<Self> {
		let byte_size = buffer_size(config)?;
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
			drop(std::thread::spawn(move || {
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

/// Running `CoreAudio` default-microphone queue.
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
	/// Open and start the default microphone queue.
	pub fn start(config: DeviceConfig, sink: CaptureSink) -> VoiceResult<Self> {
		let byte_size = buffer_size(config)?;
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
			drop(std::thread::spawn(move || {
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
