use std::{
	alloc::{Layout, alloc_zeroed, dealloc, handle_alloc_error},
	ffi::{CStr, c_char, c_void},
	mem::{self, offset_of},
	panic::{AssertUnwindSafe, catch_unwind},
	ptr::{self, null, null_mut},
	result,
	sync::{
		Arc, LazyLock,
		atomic::{AtomicPtr, Ordering},
	},
	time::Duration,
};

use flume::Receiver;
use omp_core::{Str, sf};
use parking_lot::{Condvar, Mutex};
use tokio_util::sync::CancellationToken;

use super::{
	AppleFmAvailability, AppleFmError, AppleFmErrorCode, AppleFmGeneration, AppleFmOptions,
	CONTEXT_SIZE, Result,
};

const FRAMEWORK_PATH: &CStr =
	c"/System/Library/Frameworks/FoundationModels.framework/FoundationModels";
const UTF8: u32 = 0x0800_0100;
const TASK_ENQUEUE_JOB: usize = 1 << 12;
// The closure context is a raw Rust allocation, not a Swift object.
const TASK_IS_FUNCTION_CONSUMED: usize = 1 << 15;
const TASK_FLAGS: usize = TASK_ENQUEUE_JOB | TASK_IS_FUNCTION_CONSUMED;
const RECEIVE_INTERVAL: Duration = Duration::from_millis(25);

const MODEL_DEFAULT: &CStr = c"$s16FoundationModels19SystemLanguageModelC7defaultACvgZ";
const MODEL_METADATA: &CStr = c"$s16FoundationModels19SystemLanguageModelCMa";
const MODEL_AVAILABILITY: &CStr =
	c"$s16FoundationModels19SystemLanguageModelC12availabilityAC12AvailabilityOvg";
const AVAILABILITY_METADATA: &CStr = c"$s16FoundationModels19SystemLanguageModelC12AvailabilityOMa";
const UNAVAILABLE_REASON_METADATA: &CStr =
	c"$s16FoundationModels19SystemLanguageModelC12AvailabilityO17UnavailableReasonOMa";
const DEVICE_NOT_ELIGIBLE: &CStr = c"$s16FoundationModels19SystemLanguageModelC12AvailabilityO17UnavailableReasonO17deviceNotEligibleyA2GmFWC";
const INTELLIGENCE_NOT_ENABLED: &CStr = c"$s16FoundationModels19SystemLanguageModelC12AvailabilityO17UnavailableReasonO27appleIntelligenceNotEnabledyA2GmFWC";
const MODEL_NOT_READY: &CStr = c"$s16FoundationModels19SystemLanguageModelC12AvailabilityO17UnavailableReasonO13modelNotReadyyA2GmFWC";
const USE_CASE_METADATA: &CStr = c"$s16FoundationModels19SystemLanguageModelC7UseCaseVMa";
const USE_CASE_GENERAL: &CStr = c"$s16FoundationModels19SystemLanguageModelC7UseCaseV7generalAEvgZ";
const GUARDRAILS_METADATA: &CStr = c"$s16FoundationModels19SystemLanguageModelC10GuardrailsVMa";
const GUARDRAILS_DEFAULT: &CStr =
	c"$s16FoundationModels19SystemLanguageModelC10GuardrailsV7defaultAEvgZ";
const GUARDRAILS_PERMISSIVE: &CStr =
	c"$s16FoundationModels19SystemLanguageModelC10GuardrailsV32permissiveContentTransformationsAEvgZ";
const MODEL_INIT: &CStr =
	c"$s16FoundationModels19SystemLanguageModelC7useCase10guardrailsA2C03UseG0V_AC10GuardrailsVtcfC";
const SESSION_METADATA: &CStr = c"$s16FoundationModels20LanguageModelSessionCMa";
const SESSION_INIT: &CStr = c"$s16FoundationModels20LanguageModelSessionC5model5tools12instructionsAcA06SystemcD0C_SayAA4Tool_pGSSSgtcfC";
const SAMPLING_METADATA: &CStr = c"$s16FoundationModels17GenerationOptionsV12SamplingModeVMa";
const OPTIONS_METADATA: &CStr = c"$s16FoundationModels17GenerationOptionsVMa";
const OPTIONS_INIT: &CStr = c"$s16FoundationModels17GenerationOptionsV8sampling11temperature21maximumResponseTokensA2C12SamplingModeVSg_SdSgSiSgtcfC";
const STREAM_RESPONSE: &CStr = c"$s16FoundationModels20LanguageModelSessionC14streamResponse2to7optionsAC0G6StreamVy_SSGSS_AA17GenerationOptionsVtF";
const MAKE_ITERATOR: &CStr =
	c"$s16FoundationModels20LanguageModelSessionC14ResponseStreamV17makeAsyncIteratorAE0iJ0Vy_x_GyF";
const NEXT: &CStr = c"$s16FoundationModels20LanguageModelSessionC14ResponseStreamV13AsyncIteratorV4next9isolationAE8SnapshotVy_x_GSgScA_pSgYi_tYaKF";
const NEXT_DESCRIPTOR: &CStr = c"$s16FoundationModels20LanguageModelSessionC14ResponseStreamV13AsyncIteratorV4next9isolationAE8SnapshotVy_x_GSgScA_pSgYi_tYaKFTu";
const SNAPSHOT_CONTENT: &CStr = c"$s16FoundationModels20LanguageModelSessionC14ResponseStreamV8SnapshotV7content18PartiallyGeneratedQzvg";
const GENERATION_ERROR_METADATA: &CStr =
	c"$s16FoundationModels20LanguageModelSessionC15GenerationErrorOMa";
const CONTEXT_OVERFLOW: &CStr = c"$s16FoundationModels20LanguageModelSessionC15GenerationErrorO25exceededContextWindowSizeyA2E0I0VcAEmFWC";
const ASSETS_UNAVAILABLE: &CStr = c"$s16FoundationModels20LanguageModelSessionC15GenerationErrorO17assetsUnavailableyA2E7ContextVcAEmFWC";
const GUARDRAIL_VIOLATION: &CStr = c"$s16FoundationModels20LanguageModelSessionC15GenerationErrorO18guardrailViolationyA2E7ContextVcAEmFWC";
const REFUSAL: &CStr = c"$s16FoundationModels20LanguageModelSessionC15GenerationErrorO7refusalyA2E7RefusalV_AE7ContextVtcAEmFWC";
const UNSUPPORTED_GUIDE: &CStr = c"$s16FoundationModels20LanguageModelSessionC15GenerationErrorO16unsupportedGuideyA2E7ContextVcAEmFWC";
const UNSUPPORTED_LOCALE: &CStr = c"$s16FoundationModels20LanguageModelSessionC15GenerationErrorO011unsupportedC8OrLocaleyA2E7ContextVcAEmFWC";
const DECODING_FAILURE: &CStr = c"$s16FoundationModels20LanguageModelSessionC15GenerationErrorO15decodingFailureyA2E7ContextVcAEmFWC";
const RATE_LIMITED: &CStr = c"$s16FoundationModels20LanguageModelSessionC15GenerationErrorO11rateLimitedyA2E7ContextVcAEmFWC";
const CONCURRENT_REQUESTS: &CStr = c"$s16FoundationModels20LanguageModelSessionC15GenerationErrorO18concurrentRequestsyA2E7ContextVcAEmFWC";

const STREAM_METADATA_NAME: &[u8] =
	b"16FoundationModels20LanguageModelSessionC14ResponseStreamVy_SSG";
const ITERATOR_METADATA_NAME: &[u8] =
	b"16FoundationModels20LanguageModelSessionC14ResponseStreamV13AsyncIteratorVy_SS_G";
const SNAPSHOT_METADATA_NAME: &[u8] =
	b"16FoundationModels20LanguageModelSessionC14ResponseStreamV8SnapshotVy_SS_G";
const OPTIONAL_SNAPSHOT_METADATA_NAME: &[u8] =
	b"16FoundationModels20LanguageModelSessionC14ResponseStreamV8SnapshotVy_SS_GSg";
const ERROR_PROTOCOL: &CStr = c"$ss5ErrorMp";

#[derive(Debug)]
struct BridgeFailure {
	code:    &'static str,
	message: String,
}

impl BridgeFailure {
	#[cold]
	fn runtime(message: impl Into<String>) -> Self {
		Self { code: "runtime_error", message: message.into() }
	}

	fn cancelled() -> Self {
		Self {
			code:    "cancelled",
			message: "Apple Foundation Models generation was cancelled".into(),
		}
	}
}

#[repr(transparent)]
struct Runtime {
	handle: *mut c_void,
}

// SAFETY: The framework handle is process-global and dlsym is thread-safe.
unsafe impl Send for Runtime {}
// SAFETY: Runtime only exposes immutable symbol lookup through the
// process-global handle.
unsafe impl Sync for Runtime {}

impl Runtime {
	fn load() -> result::Result<Self, BridgeFailure> {
		// SAFETY: FRAMEWORK_PATH is a permanent NUL-terminated path and flags are valid
		// for dlopen.
		let handle =
			unsafe { libc::dlopen(FRAMEWORK_PATH.as_ptr(), libc::RTLD_NOW | libc::RTLD_GLOBAL) };
		if handle.is_null() {
			return Err(BridgeFailure::runtime(format!(
				"Could not load FoundationModels: {}",
				dl_error()
			)));
		}
		Ok(Self { handle })
	}

	unsafe fn symbol<T: Copy>(&self, name: &'static CStr) -> result::Result<T, BridgeFailure> {
		// SAFETY: Both handles are valid for dlsym; callers provide the exact ABI type
		// for each symbol.
		let mut pointer = unsafe { libc::dlsym(self.handle, name.as_ptr()) };
		if pointer.is_null() {
			// SAFETY: RTLD_DEFAULT searches the already-loaded dependency closure.
			pointer = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
		}
		if pointer.is_null() {
			return Err(BridgeFailure::runtime(format!(
				"Foundation Models symbol {} is unavailable: {}",
				name.to_string_lossy(),
				dl_error()
			)));
		}
		// SAFETY: The size assertion and caller-supplied function/data type make this a
		// pointer bit-copy.
		Ok(unsafe { pointer_value(pointer) })
	}

	fn metadata(&self, name: &[u8]) -> result::Result<*const c_void, BridgeFailure> {
		// SAFETY: The runtime function type matches
		// swift_getTypeByMangledNameInContext2.
		let resolve: MetadataResolver =
			unsafe { self.symbol(c"swift_getTypeByMangledNameInContext2")? };
		// SAFETY: name remains live for the call and this type has no generic context
		// arguments.
		let metadata = unsafe { resolve(name.as_ptr(), name.len(), null(), null()) };
		if metadata.is_null() {
			return Err(BridgeFailure::runtime(format!(
				"Swift metadata {} is unavailable",
				String::from_utf8_lossy(name)
			)));
		}
		Ok(metadata)
	}

	fn error_metadata(&self) -> result::Result<*const c_void, BridgeFailure> {
		// Swift's Error existential mangling uses an indirect symbolic reference to
		// the protocol descriptor, matching Swift's C++ interop overlay.
		let mut name = ErrorMetadataName {
			bytes:    [2, 0, 0, 0, 0, b'_', b'p', 0],
			// SAFETY: ERROR_PROTOCOL resolves to the permanent Swift Error protocol descriptor.
			protocol: unsafe { self.symbol(ERROR_PROTOCOL)? },
		};
		name.bytes[1..5].copy_from_slice(&7_i32.to_ne_bytes());
		let resolve: MetadataResolver =
			// SAFETY: The resolver symbol has the declared Swift metadata ABI.
			unsafe { self.symbol(c"swift_getTypeByMangledNameInContext")? };
		// SAFETY: bytes encodes a seven-byte symbolic protocol reference whose
		// relative pointer targets the adjacent, live protocol slot.
		let metadata = unsafe { resolve(name.bytes.as_ptr(), 7, null(), null()) };
		if metadata.is_null() {
			return Err(BridgeFailure::runtime("Swift Error existential metadata is unavailable"));
		}
		Ok(metadata)
	}

	fn metadata_accessor(
		&self,
		name: &'static CStr,
	) -> result::Result<*const c_void, BridgeFailure> {
		// SAFETY: Foundation Models metadata accessors accept a MetadataRequest in x0.
		let accessor: MetadataAccessor = unsafe { self.symbol(name)? };
		// SAFETY: Zero requests complete metadata, which is sufficient for value
		// witnesses and calls.
		let metadata = unsafe { accessor(0) };
		if metadata.is_null() {
			return Err(BridgeFailure::runtime(format!(
				"Swift metadata accessor {} returned null",
				name.to_string_lossy()
			)));
		}
		Ok(metadata)
	}

	fn case_tag(&self, name: &'static CStr) -> result::Result<u32, BridgeFailure> {
		// SAFETY: Enum case descriptor symbols point to a stable 32-bit case tag.
		let pointer: *const u32 = unsafe { self.symbol(name)? };
		// SAFETY: dlsym returned the address of the case descriptor's aligned tag word.
		Ok(unsafe { pointer.read() })
	}
}

static RUNTIME: LazyLock<result::Result<Runtime, BridgeFailure>> = LazyLock::new(Runtime::load);
#[unsafe(no_mangle)]
static APPLE_FM_ACTIVE_REQUEST: AtomicPtr<Request> = AtomicPtr::new(null_mut());

fn runtime() -> result::Result<&'static Runtime, BridgeFailure> {
	match &*RUNTIME {
		Ok(runtime) => Ok(runtime),
		Err(failure) => {
			Err(BridgeFailure { code: failure.code, message: failure.message.clone() })
		},
	}
}

fn dl_error() -> String {
	// SAFETY: dlerror returns either null or a process-owned NUL-terminated
	// diagnostic.
	let pointer = unsafe { libc::dlerror() };
	if pointer.is_null() {
		"unknown dynamic loader error".to_owned()
	} else {
		// SAFETY: A non-null dlerror result is a valid C string until the next loader
		// call.
		unsafe { CStr::from_ptr(pointer) }
			.to_string_lossy()
			.into_owned()
	}
}

unsafe fn pointer_value<T: Copy>(pointer: *mut c_void) -> T {
	assert_eq!(mem::size_of::<T>(), mem::size_of::<*mut c_void>());
	// SAFETY: The caller establishes that T is the function or data pointer type
	// exported by dlsym.
	unsafe { mem::transmute_copy(&pointer) }
}

type MetadataAccessor = unsafe extern "C" fn(usize) -> *const c_void;
type MetadataResolver =
	unsafe extern "C" fn(*const u8, usize, *const c_void, *const *const c_void) -> *const c_void;
type ModelDefault = unsafe extern "C" fn() -> *mut c_void;
type SwiftRelease = unsafe extern "C" fn(*mut c_void);
type SwiftBridgeRelease = unsafe extern "C" fn(*mut c_void);
type SwiftErrorRetain = unsafe extern "C" fn(*mut c_void) -> *mut c_void;
type SwiftTaskCancel = unsafe extern "C" fn(*mut c_void);
type SwiftDynamicCast =
	unsafe extern "C" fn(*mut c_void, *mut c_void, *const c_void, *const c_void, u32) -> bool;
type SwiftStringFromNSString = unsafe extern "C" fn(*mut c_void) -> SwiftString;
type SwiftStringToNSString = unsafe extern "C" fn(SwiftString) -> *mut c_void;
type ConvertErrorToNSError = unsafe extern "C" fn(*mut c_void) -> *mut c_void;
type CFStringCreateWithBytes =
	unsafe extern "C" fn(*const c_void, *const u8, isize, u32, bool) -> *mut c_void;
type CFStringGetLength = unsafe extern "C" fn(*const c_void) -> isize;
type CFStringGetMaximumSizeForEncoding = unsafe extern "C" fn(isize, u32) -> isize;
type CFStringGetCString = unsafe extern "C" fn(*const c_void, *mut c_char, isize, u32) -> bool;
type CFRelease = unsafe extern "C" fn(*const c_void);
type SelRegisterName = unsafe extern "C" fn(*const c_char) -> *const c_void;
type ObjcMessageId = unsafe extern "C" fn(*mut c_void, *const c_void) -> *mut c_void;
type ObjcRelease = unsafe extern "C" fn(*mut c_void);
type ValueDestroy = unsafe extern "C" fn(*mut c_void, *const c_void);
type ValueStoreExtraInhabitant = unsafe extern "C" fn(*mut c_void, u32, u32, *const c_void);
type ValueGetExtraInhabitant = unsafe extern "C" fn(*mut c_void, u32, *const c_void) -> u32;
type ValueInitializeWithTake =
	unsafe extern "C" fn(*mut c_void, *mut c_void, *const c_void) -> *mut c_void;
type ValueGetEnumTag = unsafe extern "C" fn(*mut c_void, *const c_void) -> u32;

#[repr(C)]
#[derive(Clone, Copy)]
struct SwiftString {
	first:  usize,
	object: usize,
}

struct OwnedSwiftString {
	raw:     SwiftString,
	release: SwiftBridgeRelease,
}

impl OwnedSwiftString {
	const fn new(raw: SwiftString, release: SwiftBridgeRelease) -> Self {
		Self { raw, release }
	}

	const fn raw(&self) -> SwiftString {
		self.raw
	}

	const fn into_raw(self) -> SwiftString {
		let raw = self.raw;
		mem::forget(self);
		raw
	}
}

impl Drop for OwnedSwiftString {
	fn drop(&mut self) {
		if self.raw.object != 0 {
			// SAFETY: raw contains a caller-owned Swift String bridge object.
			unsafe { (self.release)(ptr::with_exposed_provenance_mut(self.raw.object)) };
		}
	}
}

#[repr(C)]
struct ErrorMetadataName {
	bytes:    [u8; 8],
	protocol: *const c_void,
}

const _: () = assert!(offset_of!(ErrorMetadataName, protocol) == 8);

struct SwiftValue {
	pointer:     *mut c_void,
	metadata:    *const c_void,
	layout:      Layout,
	initialized: bool,
}

impl SwiftValue {
	fn new(metadata: *const c_void) -> result::Result<Self, BridgeFailure> {
		if metadata.is_null() {
			return Err(BridgeFailure::runtime("Cannot allocate a Swift value without metadata"));
		}
		// SAFETY: Complete Swift type metadata stores its value-witness table one word
		// before metadata.
		let witnesses = unsafe { *metadata.cast::<*const usize>().sub(1) };
		if witnesses.is_null() {
			return Err(BridgeFailure::runtime("Swift type metadata has no value witnesses"));
		}
		// SAFETY: Value-witness entries 8 and 10 are size and flags, respectively.
		let size = unsafe { *witnesses.add(8) };
		// SAFETY: Value-witness flags encode alignment minus one in the low byte.
		let flags = unsafe { *witnesses.add(10) };
		let alignment = (flags & 0xff).saturating_add(1);
		let layout = Layout::from_size_align(size.max(1), alignment)
			.map_err(|error| BridgeFailure::runtime(format!("Invalid Swift value layout: {error}")))?;
		// SAFETY: layout is non-zero and valid.
		let pointer = unsafe { alloc_zeroed(layout) }.cast::<c_void>();
		if pointer.is_null() {
			handle_alloc_error(layout);
		}
		Ok(Self { pointer, metadata, layout, initialized: false })
	}

	fn initialize_optional_none(&mut self) {
		// SAFETY: Witness entry 7 stores a single-payload enum tag; 1 denotes
		// Optional.none.
		let store: ValueStoreExtraInhabitant = unsafe { self.witness(7) };
		// SAFETY: The buffer has this payload's layout and is currently uninitialized.
		unsafe { store(self.pointer, 1, 1, self.metadata) };
		self.initialized = true;
	}

	fn single_payload_tag(&self, buffer: *mut c_void) -> u32 {
		// SAFETY: Witness entry 6 reads a single-payload enum tag without consuming it.
		let get: ValueGetExtraInhabitant = unsafe { self.witness(6) };
		// SAFETY: buffer contains Optional<Self> using this payload's value witnesses.
		unsafe { get(buffer, 1, self.metadata) }
	}

	fn enum_tag(&self) -> u32 {
		// SAFETY: self is initialized as the enum represented by metadata.
		unsafe { self.enum_tag_at(self.pointer) }
	}

	unsafe fn enum_tag_at(&self, pointer: *mut c_void) -> u32 {
		// SAFETY: Flags and extra-inhabitant count share one pointer-sized slot, so
		// enum value-witness entry 11 reads the active case without consuming it.
		let get: ValueGetEnumTag = unsafe { self.witness(11) };
		// SAFETY: The caller provides an initialized enum value with this metadata.
		unsafe { get(pointer, self.metadata) }
	}

	fn initialize_with_take(&mut self, source: &mut Self) {
		// SAFETY: Witness entry 4 moves an initialized value into uninitialized
		// storage.
		let take: ValueInitializeWithTake = unsafe { self.witness(4) };
		// SAFETY: Optional.some payload uses the same representation as this concrete
		// value.
		unsafe { take(self.pointer, source.pointer, self.metadata) };
		self.initialized = true;
		source.initialized = false;
	}

	fn destroy(&mut self) {
		if !self.initialized {
			return;
		}
		// SAFETY: Witness entry 1 destroys an initialized value of this metadata.
		let destroy: ValueDestroy = unsafe { self.witness(1) };
		// SAFETY: initialized tracks successful initialization and consuming moves.
		unsafe { destroy(self.pointer, self.metadata) };
		self.initialized = false;
	}

	unsafe fn witness<T: Copy>(&self, index: usize) -> T {
		// SAFETY: metadata is complete and remains live for the framework lifetime.
		let witnesses = unsafe { *self.metadata.cast::<*const usize>().sub(1) };
		// SAFETY: Callers request a valid witness-table entry with its exact ABI type.
		let raw = unsafe { *witnesses.add(index) };
		let pointer = ptr::with_exposed_provenance_mut::<c_void>(raw);
		// SAFETY: The requested witness type matches the indexed table entry.
		unsafe { pointer_value(pointer) }
	}
}

impl Drop for SwiftValue {
	fn drop(&mut self) {
		self.destroy();
		// SAFETY: pointer was allocated with this exact layout and has been destroyed
		// if needed.
		unsafe { dealloc(self.pointer.cast::<u8>(), self.layout) };
	}
}

struct SwiftObject {
	pointer: *mut c_void,
	release: SwiftRelease,
}

impl SwiftObject {
	fn new(
		pointer: *mut c_void,
		release: SwiftRelease,
		kind: &str,
	) -> result::Result<Self, BridgeFailure> {
		if pointer.is_null() {
			Err(BridgeFailure::runtime(format!("Foundation Models returned a null {kind}")))
		} else {
			Ok(Self { pointer, release })
		}
	}
}

impl Drop for SwiftObject {
	fn drop(&mut self) {
		if !self.pointer.is_null() {
			// SAFETY: The object is a +1 Swift class reference returned by a
			// constructor/getter.
			unsafe { (self.release)(self.pointer) };
		}
	}
}

#[repr(C)]
struct StreamCall {
	iterator:          *mut c_void,
	iterator_metadata: *const c_void,
	optional_snapshot: *mut c_void,
	next:              *const c_void,
	next_descriptor:   *const u8,
	task_allocate:     *const c_void,
	task_deallocate:   *const c_void,
}

const _: () = assert!(offset_of!(StreamCall, iterator) == 0);
const _: () = assert!(offset_of!(StreamCall, iterator_metadata) == 8);
const _: () = assert!(offset_of!(StreamCall, optional_snapshot) == 16);
const _: () = assert!(offset_of!(StreamCall, next) == 24);
const _: () = assert!(offset_of!(StreamCall, next_descriptor) == 32);
const _: () = assert!(offset_of!(StreamCall, task_allocate) == 40);
const _: () = assert!(offset_of!(StreamCall, task_deallocate) == 48);

#[repr(C)]
struct Request {
	call:              StreamCall,
	runtime:           &'static Runtime,
	snapshot_content:  *const c_void,
	snapshot_strings:  SnapshotStringBridge,
	task_create:       *const c_void,
	unit_metadata:     *const c_void,
	control:           Arc<TaskControl>,
	sender:            flume::Sender<StreamMessage>,
	session:           SwiftObject,
	_options:          SwiftValue,
	iterator:          SwiftValue,
	optional_snapshot: SwiftValue,
	snapshot:          SwiftValue,
}

#[derive(Clone, Copy)]
struct SnapshotStringBridge {
	to_ns_string:   SwiftStringToNSString,
	release:        ObjcRelease,
	bridge_release: SwiftBridgeRelease,
	length:         CFStringGetLength,
	maximum:        CFStringGetMaximumSizeForEncoding,
	copy:           CFStringGetCString,
}

impl SnapshotStringBridge {
	fn load(runtime: &Runtime) -> result::Result<Self, BridgeFailure> {
		Ok(Self {
			// SAFETY: Each symbol is resolved with its declared Foundation or runtime ABI.
			to_ns_string:   unsafe {
				runtime.symbol(c"$sSS10FoundationE19_bridgeToObjectiveCSo8NSStringCyF")?
			},
			// SAFETY: objc_release has the declared Objective-C ABI.
			release:        unsafe { runtime.symbol(c"objc_release")? },
			// SAFETY: swift_bridgeObjectRelease has the declared Swift ABI.
			bridge_release: unsafe { runtime.symbol(c"swift_bridgeObjectRelease")? },
			// SAFETY: CFStringGetLength has the declared CoreFoundation ABI.
			length:         unsafe { runtime.symbol(c"CFStringGetLength")? },
			// SAFETY: CFStringGetMaximumSizeForEncoding has the declared CoreFoundation ABI.
			maximum:        unsafe { runtime.symbol(c"CFStringGetMaximumSizeForEncoding")? },
			// SAFETY: CFStringGetCString has the declared CoreFoundation ABI.
			copy:           unsafe { runtime.symbol(c"CFStringGetCString")? },
		})
	}

	fn to_rust(self, value: SwiftString) -> result::Result<String, BridgeFailure> {
		let value = OwnedSwiftString::new(value, self.bridge_release);
		// SAFETY: value is an initialized Swift String returned by the snapshot getter.
		let ns_string = unsafe { (self.to_ns_string)(value.raw()) };
		if ns_string.is_null() {
			Err(BridgeFailure::runtime("Could not bridge generated text to NSString"))
		} else {
			let result = ns_string_to_rust_with(ns_string, self.length, self.maximum, self.copy);
			// SAFETY: The bridge returns a +1 NSString consumed after conversion.
			unsafe { (self.release)(ns_string) };
			result
		}
	}
}

const _: () = assert!(offset_of!(Request, call) == 0);

struct TaskControl {
	state:   Mutex<TaskState>,
	changed: Condvar,
	cancel:  SwiftTaskCancel,
	release: SwiftRelease,
}

struct TaskState {
	launching: bool,
	task:      *mut c_void,
	cancelled: bool,
}

// SAFETY: task is only read or changed while state is locked, and Swift task
// operations are thread-safe.
unsafe impl Send for TaskState {}

impl TaskControl {
	fn new(cancel: SwiftTaskCancel, release: SwiftRelease) -> Self {
		Self {
			state: Mutex::new(TaskState { launching: false, task: null_mut(), cancelled: false }),
			changed: Condvar::new(),
			cancel,
			release,
		}
	}

	fn begin_launch(&self) -> result::Result<(), BridgeFailure> {
		let mut state = self.state.lock();
		if state.launching || !state.task.is_null() {
			return Err(BridgeFailure::runtime(
				"Foundation Models task launch overlapped an active task",
			));
		}
		state.launching = true;
		Ok(())
	}

	fn finish_launch(&self, task: *mut c_void) {
		let mut state = self.state.lock();
		state.launching = false;
		state.task = task;
		if state.cancelled {
			// SAFETY: The state lock prevents the completion callback from releasing
			// the live task while cancellation uses it.
			unsafe { (self.cancel)(task) };
		}
		self.changed.notify_all();
	}

	fn fail_launch(&self) {
		let mut state = self.state.lock();
		state.launching = false;
		self.changed.notify_all();
	}

	fn complete_task(&self) -> *mut c_void {
		let mut state = self.state.lock();
		while state.launching {
			self.changed.wait(&mut state);
		}
		mem::replace(&mut state.task, null_mut())
	}

	fn request_cancel(&self) {
		let mut state = self.state.lock();
		state.cancelled = true;
		if !state.task.is_null() {
			// SAFETY: The state lock prevents the completion callback from releasing
			// the live task while cancellation uses it.
			unsafe { (self.cancel)(state.task) };
		}
	}

	fn is_cancelled(&self) -> bool {
		self.state.lock().cancelled
	}
}

enum StreamMessage {
	Snapshot(Str),
	Complete(result::Result<(), BridgeFailure>),
}

enum NextAction {
	Continue,
	Complete(result::Result<(), BridgeFailure>),
}

#[repr(C)]
struct TaskAndContext {
	task:     *mut c_void,
	_context: *mut c_void,
}

unsafe extern "C" {
	fn apple_fm_task_create(
		flags: usize,
		result_metadata: *const c_void,
		request: *mut c_void,
		function: *const c_void,
	) -> TaskAndContext;
	fn apple_fm_value_get(output: *mut c_void, function: *const c_void);
	fn apple_fm_availability_get(output: *mut c_void, model: *mut c_void, function: *const c_void);
	fn apple_fm_model_init(
		use_case: *mut c_void,
		guardrails: *mut c_void,
		metadata: *const c_void,
		function: *const c_void,
	) -> *mut c_void;
	fn apple_fm_session_init(
		model: *mut c_void,
		instructions_first: usize,
		instructions_object: usize,
		metadata: *const c_void,
		empty_tools: *const c_void,
		function: *const c_void,
	) -> *mut c_void;
	fn apple_fm_options_init(
		output: *mut c_void,
		sampling: *mut c_void,
		temperature_bits: usize,
		temperature_tag: usize,
		maximum_tokens: isize,
		maximum_tokens_tag: usize,
		function: *const c_void,
	);
	fn apple_fm_stream_response(
		output: *mut c_void,
		session: *mut c_void,
		prompt_first: usize,
		prompt_object: usize,
		options: *mut c_void,
		function: *const c_void,
	);
	fn apple_fm_make_iterator(
		output: *mut c_void,
		stream: *mut c_void,
		metadata: *const c_void,
		function: *const c_void,
	);
	fn apple_fm_snapshot_content(
		snapshot: *mut c_void,
		metadata: *const c_void,
		output: *mut SwiftString,
		function: *const c_void,
	);
}

pub(super) fn os_version() -> Option<Str> {
	let mut length = 0_usize;
	// SAFETY: the first sysctl call requests only the required buffer length.
	if unsafe {
		libc::sysctlbyname(c"kern.osproductversion".as_ptr(), null_mut(), &mut length, null_mut(), 0)
	} != 0
		|| length == 0
	{
		return None;
	}
	let mut bytes = vec![0_u8; length];
	// SAFETY: bytes has the capacity reported by the preceding sysctl call.
	if unsafe {
		libc::sysctlbyname(
			c"kern.osproductversion".as_ptr(),
			bytes.as_mut_ptr().cast(),
			&mut length,
			null_mut(),
			0,
		)
	} != 0
	{
		return None;
	}
	bytes.truncate(length);
	if bytes.last() == Some(&0) {
		bytes.pop();
	}
	String::from_utf8(bytes).ok().map(Into::into)
}

#[cfg(not(target_arch = "aarch64"))]
pub fn availability() -> AppleFmAvailability {
	AppleFmAvailability { available: false, reason: Some("unsupported_architecture".into()) }
}

#[cfg(target_arch = "aarch64")]
pub fn availability() -> AppleFmAvailability {
	match runtime().and_then(|runtime| {
		default_model(runtime).and_then(|model| availability_for_model(runtime, model.pointer))
	}) {
		Ok(availability) => availability,
		Err(failure) => {
			AppleFmAvailability { available: false, reason: Some(failure.message.into()) }
		},
	}
}

pub fn generate(
	options: AppleFmOptions,
	mut on_delta: impl FnMut(Str) -> bool,
	cancel: &CancellationToken,
) -> Result<AppleFmGeneration> {
	if cancel.is_cancelled() {
		return Err(AppleFmError::cancelled());
	}
	let AppleFmOptions { prompt, system_prompt, permissive, temperature, max_tokens } = options;
	let (sender, receiver) = flume::bounded(16);
	let control = start_generation(
		prompt.as_str(),
		system_prompt.as_deref(),
		permissive,
		temperature,
		max_tokens,
		sender,
	)
	.map_err(failure_result)?;
	let mut content = Str::default();

	loop {
		match receiver.recv_timeout(RECEIVE_INTERVAL) {
			Ok(StreamMessage::Snapshot(snapshot)) => {
				let delta = snapshot
					.strip_prefix(content.as_str())
					.unwrap_or_else(|| snapshot.clone());
				content = snapshot;
				if !delta.is_empty() && !on_delta(delta) {
					cancel_and_reap(&control, &receiver);
					return Err(AppleFmError::cancelled());
				}
			},
			Ok(StreamMessage::Complete(Ok(()))) => {
				return Ok(AppleFmGeneration {
					prompt_tokens_estimated: token_estimate_parts(
						prompt.as_str(),
						system_prompt.as_deref(),
					),
					completion_tokens_estimated: token_estimate(content.as_str()),
					content,
					context_size_documented: CONTEXT_SIZE,
				});
			},
			Ok(StreamMessage::Complete(Err(failure))) => {
				return Err(failure_result(failure));
			},
			Err(flume::RecvTimeoutError::Timeout) => {
				if cancel.is_cancelled() {
					cancel_and_reap(&control, &receiver);
					return Err(AppleFmError::cancelled());
				}
			},
			Err(flume::RecvTimeoutError::Disconnected) => {
				return Err(AppleFmError::runtime(
					"Foundation Models stream ended without a completion result",
				));
			},
		}
	}
}

fn cancel_and_reap(control: &TaskControl, receiver: &Receiver<StreamMessage>) {
	control.request_cancel();
	while let Ok(message) = receiver.recv() {
		if matches!(message, StreamMessage::Complete(_)) {
			break;
		}
	}
}

fn failure_result(failure: BridgeFailure) -> AppleFmError {
	AppleFmError::new(error_code(failure.code), failure.message)
}

fn error_code(code: &str) -> AppleFmErrorCode {
	code.parse().unwrap_or(AppleFmErrorCode::Runtime)
}

fn token_estimate(text: &str) -> u32 {
	let estimated = text.len().div_ceil(4).max(1);
	u32::try_from(estimated).unwrap_or(u32::MAX)
}

fn token_estimate_parts(prompt: &str, instructions: Option<&str>) -> u32 {
	let bytes = prompt
		.len()
		.saturating_add(instructions.map_or(0, str::len));
	let estimated = bytes.div_ceil(4).max(1);
	u32::try_from(estimated).unwrap_or(u32::MAX)
}

fn start_generation(
	prompt: &str,
	system_prompt: Option<&str>,
	permissive: bool,
	temperature: Option<f64>,
	max_tokens: Option<u32>,
	sender: flume::Sender<StreamMessage>,
) -> result::Result<Arc<TaskControl>, BridgeFailure> {
	let runtime = runtime()?;
	let model = if permissive {
		configured_model(runtime, true)?
	} else {
		default_model(runtime)?
	};
	let model_availability = availability_for_model(runtime, model.pointer)?;
	if !model_availability.available {
		let reason = model_availability
			.reason
			.unwrap_or_else(|| sf!("model_unavailable"));
		let code = match reason.as_str() {
			"device_not_eligible" => "device_not_eligible",
			"apple_intelligence_not_enabled" => "apple_intelligence_not_enabled",
			"model_not_ready" => "model_not_ready",
			_ => "model_unavailable",
		};
		return Err(BridgeFailure { code, message: reason.to_string() });
	}

	let session = create_session(runtime, model, system_prompt)?;
	let options = create_options(runtime, temperature, max_tokens)?;
	let mut stream = create_stream(runtime, session.pointer, prompt, options.pointer)?;
	let iterator_metadata = runtime.metadata(ITERATOR_METADATA_NAME)?;
	let mut iterator = SwiftValue::new(iterator_metadata)?;
	// SAFETY: The bridge sets x8/x20 for ResponseStream<String>.makeAsyncIterator.
	// SAFETY: stream is initialized and iterator is uninitialized storage for the
	// concrete iterator type.
	unsafe {
		apple_fm_make_iterator(
			iterator.pointer,
			stream.pointer,
			stream.metadata,
			runtime.symbol::<*const c_void>(MAKE_ITERATOR)?,
		);
	};
	iterator.initialized = true;
	stream.destroy();

	let optional_metadata = runtime.metadata(OPTIONAL_SNAPSHOT_METADATA_NAME)?;
	let optional_snapshot = SwiftValue::new(optional_metadata)?;
	let snapshot_metadata = runtime.metadata(SNAPSHOT_METADATA_NAME)?;
	let snapshot = SwiftValue::new(snapshot_metadata)?;
	// SAFETY: Each runtime symbol is resolved using its matching declared ABI.
	let cancel_task: SwiftTaskCancel = unsafe { runtime.symbol(c"swift_task_cancel")? };
	// SAFETY: swift_release uses the declared Swift reference-counting ABI.
	let release_task: SwiftRelease = unsafe { runtime.symbol(c"swift_release")? };
	// SAFETY: The snapshot accessor has the declared Foundation Models ABI.
	let snapshot_content = unsafe { runtime.symbol::<*const c_void>(SNAPSHOT_CONTENT)? };
	let snapshot_strings = SnapshotStringBridge::load(runtime)?;
	// SAFETY: swift_task_create_common has the declared Swift concurrency ABI.
	let task_create = unsafe { runtime.symbol::<*const c_void>(c"swift_task_create_common")? };
	// SAFETY: $sytN points at Swift's permanent unit metadata symbol.
	let unit_metadata: *const u8 = unsafe { runtime.symbol(c"$sytN")? };
	// SAFETY: Swift's unit metadata symbol points eight bytes before the complete
	// metadata object.
	let unit_metadata = unsafe { unit_metadata.add(8) }.cast::<c_void>();
	let control = Arc::new(TaskControl::new(cancel_task, release_task));
	let request = Box::new(Request {
		call: StreamCall {
			iterator: iterator.pointer,
			iterator_metadata,
			optional_snapshot: optional_snapshot.pointer,
			// SAFETY: Each task symbol is resolved with its declared Swift ABI.
			next: unsafe { runtime.symbol::<*const c_void>(NEXT)? },
			// SAFETY: The descriptor symbol has its declared static data ABI.
			next_descriptor: unsafe { runtime.symbol::<*const u8>(NEXT_DESCRIPTOR)? },
			// SAFETY: swift_task_alloc has its declared Swift concurrency ABI.
			task_allocate: unsafe { runtime.symbol::<*const c_void>(c"swift_task_alloc")? },
			// SAFETY: swift_task_dealloc has its declared Swift concurrency ABI.
			task_deallocate: unsafe { runtime.symbol::<*const c_void>(c"swift_task_dealloc")? },
		},
		runtime,
		snapshot_content,
		snapshot_strings,
		task_create,
		unit_metadata,
		control: Arc::clone(&control),
		sender,
		session,
		_options: options,
		iterator,
		optional_snapshot,
		snapshot,
	});
	let request = Box::into_raw(request);
	if APPLE_FM_ACTIVE_REQUEST
		.compare_exchange(null_mut(), request, Ordering::AcqRel, Ordering::Acquire)
		.is_err()
	{
		// SAFETY: compare_exchange failed, so no other thread can observe or own this
		// allocation.
		unsafe { drop(Box::from_raw(request)) };
		return Err(BridgeFailure {
			code:    "concurrent_requests",
			message: "Another on-device generation is already in progress".to_owned(),
		});
	}
	if let Err(failure) = launch_next(request) {
		let _ = APPLE_FM_ACTIVE_REQUEST.compare_exchange(
			request,
			null_mut(),
			Ordering::AcqRel,
			Ordering::Acquire,
		);
		// SAFETY: The active slot was cleared and no task was launched.
		unsafe { drop(Box::from_raw(request)) };
		return Err(failure);
	}
	Ok(control)
}

fn default_model(runtime: &Runtime) -> result::Result<SwiftObject, BridgeFailure> {
	// SAFETY: These symbols have the SystemLanguageModel.default getter and
	// swift_release ABIs.
	let getter: ModelDefault = unsafe { runtime.symbol(MODEL_DEFAULT)? };
	// SAFETY: swift_release has the declared Swift reference-counting ABI.
	let release: SwiftRelease = unsafe { runtime.symbol(c"swift_release")? };
	// SAFETY: The getter returns a +1 SystemLanguageModel reference.
	SwiftObject::new(unsafe { getter() }, release, "system model")
}

fn configured_model(
	runtime: &Runtime,
	permissive: bool,
) -> result::Result<SwiftObject, BridgeFailure> {
	let use_case_metadata = runtime.metadata_accessor(USE_CASE_METADATA)?;
	let guardrails_metadata = runtime.metadata_accessor(GUARDRAILS_METADATA)?;
	let mut use_case = SwiftValue::new(use_case_metadata)?;
	let mut guardrails = SwiftValue::new(guardrails_metadata)?;
	// SAFETY: These local bridges and getter symbols use Swift's indirect-result
	// register convention.
	unsafe {
		apple_fm_value_get(use_case.pointer, runtime.symbol::<*const c_void>(USE_CASE_GENERAL)?);
		apple_fm_value_get(
			guardrails.pointer,
			runtime.symbol::<*const c_void>(if permissive {
				GUARDRAILS_PERMISSIVE
			} else {
				GUARDRAILS_DEFAULT
			})?,
		);
	}
	use_case.initialized = true;
	guardrails.initialized = true;
	let model_metadata = runtime.metadata_accessor(MODEL_METADATA)?;
	// SAFETY: The bridge adapts the consuming SystemLanguageModel initializer's x20
	// convention. SAFETY: Both inputs are initialized and consumed by the
	// initializer.
	let model = unsafe {
		apple_fm_model_init(
			use_case.pointer,
			guardrails.pointer,
			model_metadata,
			runtime.symbol::<*const c_void>(MODEL_INIT)?,
		)
	};
	use_case.initialized = false;
	guardrails.initialized = false;
	// SAFETY: swift_release matches the returned Swift class reference.
	let release: SwiftRelease = unsafe { runtime.symbol(c"swift_release")? };
	SwiftObject::new(model, release, "configured system model")
}

fn availability_for_model(
	runtime: &Runtime,
	model: *mut c_void,
) -> result::Result<AppleFmAvailability, BridgeFailure> {
	let availability_metadata = runtime.metadata_accessor(AVAILABILITY_METADATA)?;
	let mut availability = SwiftValue::new(availability_metadata)?;
	// SAFETY: The local bridge adapts the availability getter's x8/x20 convention.
	unsafe {
		apple_fm_availability_get(
			availability.pointer,
			model,
			runtime.symbol::<*const c_void>(MODEL_AVAILABILITY)?,
		);
	};
	availability.initialized = true;
	let reason_metadata = runtime.metadata_accessor(UNAVAILABLE_REASON_METADATA)?;
	let reason_value = SwiftValue::new(reason_metadata)?;
	if reason_value.single_payload_tag(availability.pointer) == 1 {
		return Ok(AppleFmAvailability { available: true, reason: None });
	}
	// SAFETY: An unavailable Availability stores an initialized UnavailableReason
	// directly in its payload buffer.
	let tag = unsafe { reason_value.enum_tag_at(availability.pointer) };
	let reason = if tag == runtime.case_tag(DEVICE_NOT_ELIGIBLE)? {
		"device_not_eligible"
	} else if tag == runtime.case_tag(INTELLIGENCE_NOT_ENABLED)? {
		"apple_intelligence_not_enabled"
	} else if tag == runtime.case_tag(MODEL_NOT_READY)? {
		"model_not_ready"
	} else {
		"model_unavailable"
	};
	Ok(AppleFmAvailability { available: false, reason: Some(Str::new(reason)) })
}

fn create_session(
	runtime: &'static Runtime,
	mut model: SwiftObject,
	system_prompt: Option<&str>,
) -> result::Result<SwiftObject, BridgeFailure> {
	let metadata = runtime.metadata_accessor(SESSION_METADATA)?;
	// SAFETY: These symbols have the session initializer's declared Swift ABI.
	let empty_tools = unsafe { runtime.symbol::<*const c_void>(c"_swiftEmptyArrayStorage")? };
	// SAFETY: SESSION_INIT resolves to the compiled session initializer.
	let initialize = unsafe { runtime.symbol::<*const c_void>(SESSION_INIT)? };
	// SAFETY: swift_release has the declared Swift reference-counting ABI.
	let release: SwiftRelease = unsafe { runtime.symbol(c"swift_release")? };
	let instructions = system_prompt
		.map(|value| to_swift_string(runtime, value))
		.transpose()?;
	let (first, object) = instructions.map_or((0, 0), |value| {
		let value = value.into_raw();
		(value.first, value.object)
	});
	// SAFETY: `swiftc -emit-sil` lowers this exact initializer as
	// `@convention(method) (@owned SystemLanguageModel, @owned Array<any Tool>,
	// @owned Optional<String>, @thick LanguageModelSession.Type)`: the call
	// consumes the model, the tools array, and the instructions string at +1,
	// so no release follows (unlike the borrowing `streamResponse` method in
	// `create_stream`, whose SIL takes its arguments `@guaranteed`). The -O
	// assembly of the same call confirms caller-side retains before the call
	// and no releases after. Metadata is complete.
	let session = unsafe {
		apple_fm_session_init(model.pointer, first, object, metadata, empty_tools, initialize)
	};
	model.pointer = null_mut();
	SwiftObject::new(session, release, "language model session")
}

fn create_options(
	runtime: &Runtime,
	temperature: Option<f64>,
	max_tokens: Option<u32>,
) -> result::Result<SwiftValue, BridgeFailure> {
	let sampling_metadata = runtime.metadata_accessor(SAMPLING_METADATA)?;
	let mut sampling = SwiftValue::new(sampling_metadata)?;
	sampling.initialize_optional_none();
	let options_metadata = runtime.metadata_accessor(OPTIONS_METADATA)?;
	let mut options = SwiftValue::new(options_metadata)?;
	// SAFETY: The local bridge adapts the GenerationOptions indirect initializer.
	let temperature_bits = temperature.unwrap_or_default().to_bits();
	let temperature_tag = usize::from(temperature.is_none());
	let maximum = isize::try_from(max_tokens.unwrap_or_default())
		.map_err(|error| BridgeFailure::runtime(format!("Invalid maximum token count: {error}")))?;
	let maximum_tag = usize::from(max_tokens.is_none());
	// SAFETY: options is uninitialized output storage. The initializer consumes
	// the initialized Optional.none in sampling.
	unsafe {
		apple_fm_options_init(
			options.pointer,
			sampling.pointer,
			usize::try_from(temperature_bits).unwrap_or(usize::MAX),
			temperature_tag,
			maximum,
			maximum_tag,
			runtime.symbol::<*const c_void>(OPTIONS_INIT)?,
		);
	};
	sampling.initialized = false;
	options.initialized = true;
	Ok(options)
}

fn create_stream(
	runtime: &Runtime,
	session: *mut c_void,
	prompt: &str,
	options: *mut c_void,
) -> result::Result<SwiftValue, BridgeFailure> {
	let stream_metadata = runtime.metadata(STREAM_METADATA_NAME)?;
	let mut stream = SwiftValue::new(stream_metadata)?;
	// SAFETY: STREAM_RESPONSE resolves to the compiled synchronous method.
	let stream_response = unsafe { runtime.symbol::<*const c_void>(STREAM_RESPONSE)? };
	let prompt = to_swift_string(runtime, prompt)?;
	let prompt_value = prompt.raw();
	// SAFETY: The local bridge adapts streamResponse's x8/x20 convention.
	// SAFETY: session/options/prompt are initialized and stream is matching
	// uninitialized output storage. The prompt is guaranteed for this call.
	unsafe {
		apple_fm_stream_response(
			stream.pointer,
			session,
			prompt_value.first,
			prompt_value.object,
			options,
			stream_response,
		);
	};
	stream.initialized = true;
	Ok(stream)
}

fn to_swift_string(
	runtime: &Runtime,
	value: &str,
) -> result::Result<OwnedSwiftString, BridgeFailure> {
	// SAFETY: These symbols match their CoreFoundation and Swift Foundation ABIs.
	let create: CFStringCreateWithBytes = unsafe { runtime.symbol(c"CFStringCreateWithBytes")? };
	// SAFETY: The Swift bridge symbol has the declared Foundation ABI.
	let bridge: SwiftStringFromNSString = unsafe {
		runtime
			.symbol(c"$sSS10FoundationE36_unconditionallyBridgeFromObjectiveCySSSo8NSStringCSgFZ")?
	};
	// SAFETY: swift_bridgeObjectRelease has the declared Swift ABI.
	let bridge_release: SwiftBridgeRelease =
		unsafe { runtime.symbol(c"swift_bridgeObjectRelease")? };
	// SAFETY: CFRelease has the declared CoreFoundation ABI.
	let release: CFRelease = unsafe { runtime.symbol(c"CFRelease")? };
	let length = isize::try_from(value.len())
		.map_err(|error| BridgeFailure::runtime(format!("Prompt is too large: {error}")))?;
	// SAFETY: value is valid UTF-8 and remains live for the call.
	let ns_string = unsafe { create(null(), value.as_ptr(), length, UTF8, false) };
	if ns_string.is_null() {
		return Err(BridgeFailure::runtime("Could not bridge UTF-8 text to NSString"));
	}
	// SAFETY: ns_string is a live NSString and the bridge returns an owned Swift
	// String value.
	let result = unsafe { bridge(ns_string) };
	// SAFETY: CFStringCreateWithBytes returned a +1 object which the Swift bridge
	// has finished reading.
	unsafe { release(ns_string) };
	Ok(OwnedSwiftString::new(result, bridge_release))
}

fn ns_string_to_rust(
	runtime: &Runtime,
	value: *const c_void,
) -> result::Result<String, BridgeFailure> {
	// SAFETY: These symbols match CFString's toll-free bridged C ABI.
	// SAFETY: Each symbol matches CFString's toll-free bridged C ABI.
	let length: CFStringGetLength = unsafe { runtime.symbol(c"CFStringGetLength")? };
	// SAFETY: CFStringGetMaximumSizeForEncoding has the declared CoreFoundation
	// ABI.
	let maximum: CFStringGetMaximumSizeForEncoding =
		unsafe { runtime.symbol(c"CFStringGetMaximumSizeForEncoding")? };
	// SAFETY: CFStringGetCString has the declared CoreFoundation ABI.
	let copy: CFStringGetCString = unsafe { runtime.symbol(c"CFStringGetCString")? };
	ns_string_to_rust_with(value, length, maximum, copy)
}

fn ns_string_to_rust_with(
	value: *const c_void,
	length: CFStringGetLength,
	maximum: CFStringGetMaximumSizeForEncoding,
	copy: CFStringGetCString,
) -> result::Result<String, BridgeFailure> {
	// SAFETY: value is a live NSString/CFString.
	let utf16_length = unsafe { length(value) };
	// SAFETY: The returned bound excludes the trailing NUL byte.
	let capacity = unsafe { maximum(utf16_length, UTF8) }
		.checked_add(1)
		.ok_or_else(|| BridgeFailure::runtime("Generated text exceeds CFString limits"))?;
	let capacity_usize = usize::try_from(capacity)
		.map_err(|error| BridgeFailure::runtime(format!("Invalid CFString size: {error}")))?;
	let mut bytes = vec![0_u8; capacity_usize];
	// SAFETY: bytes has capacity bytes and value remains live for the copy.
	if !unsafe { copy(value, bytes.as_mut_ptr().cast::<c_char>(), capacity, UTF8) } {
		return Err(BridgeFailure::runtime("Could not encode Foundation Models output as UTF-8"));
	}
	let length = bytes
		.iter()
		.position(|byte| *byte == 0)
		.unwrap_or(bytes.len());
	bytes.truncate(length);
	String::from_utf8(bytes).map_err(|error| {
		BridgeFailure::runtime(format!("Foundation Models returned invalid UTF-8: {error}"))
	})
}

fn launch_next(request: *mut Request) -> result::Result<(), BridgeFailure> {
	// SAFETY: request belongs to APPLE_FM_ACTIVE_REQUEST until completion clears
	// it.
	let request_ref = unsafe { &*request };
	request_ref.control.begin_launch()?;
	let result = (|| {
		// SAFETY: request remains owned by APPLE_FM_ACTIVE_REQUEST, and the shim
		// creates a 48-byte root async context whose closure context is request.
		let created = unsafe {
			apple_fm_task_create(
				TASK_FLAGS,
				request_ref.unit_metadata,
				request.cast(),
				request_ref.task_create,
			)
		};
		if created.task.is_null() {
			return Err(BridgeFailure::runtime("Swift task creation returned null"));
		}
		request_ref.control.finish_launch(created.task);
		Ok(())
	})();
	if result.is_err() {
		request_ref.control.fail_launch();
	}
	result
}

#[unsafe(no_mangle)]
unsafe extern "C" fn apple_fm_next_completed(request: *mut Request, error: *mut c_void) {
	if request.is_null() {
		return;
	}
	// SAFETY: The active request remains allocated until complete_request runs.
	let request_ref = unsafe { &mut *request };
	let task = request_ref.control.complete_task();
	let action =
		catch_unwind(AssertUnwindSafe(|| request_ref.advance(error))).unwrap_or_else(|_| {
			NextAction::Complete(Err(BridgeFailure::runtime(
				"Foundation Models completion callback panicked",
			)))
		});
	if !task.is_null() {
		// SAFETY: complete_task transferred the callback's retained root task
		// reference.
		unsafe { (request_ref.control.release)(task) };
	}
	match action {
		NextAction::Continue => {
			if let Err(failure) = launch_next(request) {
				complete_request(request, Err(failure));
			}
		},
		NextAction::Complete(result) => complete_request(request, result),
	}
}

impl Request {
	fn advance(&mut self, error: *mut c_void) -> NextAction {
		if !error.is_null() {
			return NextAction::Complete(Err(generation_failure(self.runtime, error)));
		}
		self.optional_snapshot.initialized = true;
		if self
			.snapshot
			.single_payload_tag(self.optional_snapshot.pointer)
			== 1
		{
			self.optional_snapshot.destroy();
			return NextAction::Complete(Ok(()));
		}
		self
			.snapshot
			.initialize_with_take(&mut self.optional_snapshot);
		let mut content = mem::MaybeUninit::<SwiftString>::uninit();
		// SAFETY: snapshot is initialized and content is matching uninitialized String
		// storage.
		unsafe {
			apple_fm_snapshot_content(
				self.snapshot.pointer,
				self.snapshot.metadata,
				content.as_mut_ptr(),
				self.snapshot_content,
			);
		};
		// SAFETY: The getter initialized content on return.
		let text = self
			.snapshot_strings
			.to_rust(unsafe { content.assume_init() })
			.map(Str::new);
		self.snapshot.destroy();
		match text {
			Ok(text) => loop {
				if self.control.is_cancelled() {
					break NextAction::Complete(Err(BridgeFailure::cancelled()));
				}
				match self
					.sender
					.send_timeout(StreamMessage::Snapshot(text.clone()), RECEIVE_INTERVAL)
				{
					Ok(()) => break NextAction::Continue,
					Err(flume::SendTimeoutError::Timeout(_)) => {},
					Err(flume::SendTimeoutError::Disconnected(_)) => {
						break NextAction::Complete(Err(BridgeFailure::runtime(
							"Apple Intelligence stream receiver closed",
						)));
					},
				}
			},
			Err(failure) => NextAction::Complete(Err(failure)),
		}
	}
}

fn complete_request(request: *mut Request, result: result::Result<(), BridgeFailure>) {
	// SAFETY: request is still the unique active allocation at this point.
	let request_ref = unsafe { &*request };
	let cleared = APPLE_FM_ACTIVE_REQUEST
		.compare_exchange(request, null_mut(), Ordering::AcqRel, Ordering::Acquire)
		.is_ok();
	if cleared {
		let mut message = StreamMessage::Complete(result);
		loop {
			match request_ref.sender.send_timeout(message, RECEIVE_INTERVAL) {
				Ok(()) | Err(flume::SendTimeoutError::Disconnected(_)) => break,
				Err(flume::SendTimeoutError::Timeout(returned)) => message = returned,
			}
		}
		// SAFETY: Clearing the active slot transfers the allocation's final ownership
		// here.
		unsafe { drop(Box::from_raw(request)) };
	}
}

fn generation_failure(runtime: &Runtime, error: *mut c_void) -> BridgeFailure {
	let code = classify_generation_error(runtime, error).unwrap_or("runtime_error");
	let message = error_message(runtime, error).unwrap_or_else(|failure| {
		format!("Foundation Models generation failed ({})", failure.message)
	});
	BridgeFailure { code, message }
}

fn classify_generation_error(
	runtime: &Runtime,
	error: *mut c_void,
) -> result::Result<&'static str, BridgeFailure> {
	let metadata = runtime.metadata_accessor(GENERATION_ERROR_METADATA)?;
	let mut generation_error = SwiftValue::new(metadata)?;
	let source_metadata = runtime.error_metadata()?;
	// SAFETY: The function type and flags match Swift's checked, consuming dynamic
	// cast ABI.
	let dynamic_cast: SwiftDynamicCast = unsafe { runtime.symbol(c"swift_dynamicCast")? };
	// SAFETY: swift_errorRetain has the declared Swift Error ABI.
	let retain: SwiftErrorRetain = unsafe { runtime.symbol(c"swift_errorRetain")? };
	// SAFETY: Retaining a copy lets swift_dynamicCast consume it while the async
	// task keeps its error.
	unsafe { retain(error) };
	let mut source = error;
	// SAFETY: source is a retained Error existential and destination has
	// GenerationError layout.
	if !unsafe {
		dynamic_cast(
			generation_error.pointer,
			ptr::addr_of_mut!(source).cast::<c_void>(),
			source_metadata,
			metadata,
			6,
		)
	} {
		return Ok("runtime_error");
	}
	generation_error.initialized = true;
	let tag = generation_error.enum_tag();
	let code = if tag == runtime.case_tag(CONTEXT_OVERFLOW)? {
		"context_overflow"
	} else if tag == runtime.case_tag(ASSETS_UNAVAILABLE)? {
		"model_unavailable"
	} else if tag == runtime.case_tag(GUARDRAIL_VIOLATION)? || tag == runtime.case_tag(REFUSAL)? {
		"guardrail_blocked"
	} else if tag == runtime.case_tag(UNSUPPORTED_GUIDE)? {
		"unsupported_guide"
	} else if tag == runtime.case_tag(UNSUPPORTED_LOCALE)? {
		"unsupported_locale"
	} else if tag == runtime.case_tag(DECODING_FAILURE)? {
		"decoding_failure"
	} else if tag == runtime.case_tag(RATE_LIMITED)? {
		"rate_limited"
	} else if tag == runtime.case_tag(CONCURRENT_REQUESTS)? {
		"concurrent_requests"
	} else {
		"runtime_error"
	};
	Ok(code)
}

fn error_message(runtime: &Runtime, error: *mut c_void) -> result::Result<String, BridgeFailure> {
	// SAFETY: These symbols match Swift Foundation and Objective-C runtime ABIs.
	let convert: ConvertErrorToNSError =
		unsafe { runtime.symbol(c"$s10Foundation22_convertErrorToNSErrorySo0E0Cs0C0_pF")? };
	// SAFETY: sel_registerName has the declared Objective-C runtime ABI.
	let selector: SelRegisterName = unsafe { runtime.symbol(c"sel_registerName")? };
	// SAFETY: objc_msgSend is cast to its exact `description` message ABI.
	let message: ObjcMessageId = unsafe { runtime.symbol(c"objc_msgSend")? };
	// SAFETY: objc_release has the declared Objective-C reference-counting ABI.
	let release: ObjcRelease = unsafe { runtime.symbol(c"objc_release")? };
	// SAFETY: error is live for the async return; conversion retains the NSError
	// result.
	let ns_error = unsafe { convert(error) };
	if ns_error.is_null() {
		return Err(BridgeFailure::runtime("Could not bridge Swift Error to NSError"));
	}
	// SAFETY: The selector is permanent and localizedDescription returns a borrowed
	// NSString.
	let description = unsafe { message(ns_error, selector(c"localizedDescription".as_ptr())) };
	let result = if description.is_null() {
		Err(BridgeFailure::runtime("NSError returned no localized description"))
	} else {
		ns_string_to_rust(runtime, description)
	};
	// SAFETY: convertErrorToNSError returned a +1 object.
	unsafe { release(ns_error) };
	result
}
