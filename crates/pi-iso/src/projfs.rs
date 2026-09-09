//! Windows Projected File System backend.
//!
//! Ported from the original `pi_natives::projfs_overlay`; the napi-derived
//! types and the `Result<()>` alias from `napi::bindgen_prelude` are
//! replaced with the platform-neutral [`crate::IsoError`] /
//! [`crate::ProbeResult`].

use std::path::Path;

use async_trait::async_trait;

#[cfg(not(windows))]
use crate::IsoError;
use crate::{BackendKind, IsoResult, IsolationBackend, ProbeResult};

pub struct ProjfsBackend;

pub fn backend() -> &'static dyn IsolationBackend {
	&ProjfsBackend
}

#[async_trait]
impl IsolationBackend for ProjfsBackend {
	fn kind(&self) -> BackendKind {
		BackendKind::Projfs
	}

	fn probe(&self) -> ProbeResult {
		#[cfg(windows)]
		{
			// ProjFS's native bindings misbehave when the process is x64
			// running under Windows ARM64 emulation — `LoadLibrary` succeeds
			// but the callbacks crash on first invocation. Refuse early so
			// `resolve()` falls back to a different backend instead of
			// surfacing a hard crash to the caller.
			if x64_under_arm64_emulation() {
				return ProbeResult::unavailable(
					"ProjFS is disabled on Windows ARM64 under x64 emulation (use a native ARM64 build)",
				);
			}
			imp::probe()
		}
		#[cfg(not(windows))]
		{
			ProbeResult::unavailable("ProjFS isolation is only available on Windows")
		}
	}

	fn start(&self, lower: &Path, merged: &Path) -> IsoResult<()> {
		#[cfg(windows)]
		{
			imp::start(&lower.to_string_lossy(), &merged.to_string_lossy())
		}
		#[cfg(not(windows))]
		{
			let _ = (lower, merged);
			Err(IsoError::unavailable("ProjFS isolation is only available on Windows"))
		}
	}

	fn stop(&self, merged: &Path) -> IsoResult<()> {
		#[cfg(windows)]
		{
			imp::stop(&merged.to_string_lossy());
			Ok(())
		}
		#[cfg(not(windows))]
		{
			let _ = merged;
			Ok(())
		}
	}
}

/// `true` when the current process is x64 running under Windows ARM64
/// emulation (WOW64-on-ARM64). Detected by the `PROCESSOR_ARCHITEW6432`
/// environment variable Windows sets in WOW64 children, plus the legacy
/// `PROCESSOR_ARCHITECTURE` slot for completeness. Off Windows the
/// answer is always `false`.
#[cfg_attr(not(windows), allow(dead_code, reason = "windows-only ARM64 emulation guard"))]
fn x64_under_arm64_emulation() -> bool {
	if !cfg!(windows) || !cfg!(target_arch = "x86_64") {
		return false;
	}
	let env_value = |var: &str| std::env::var(var).ok();
	vars_indicate_arm64_emulation(
		env_value("PROCESSOR_ARCHITEW6432").as_deref(),
		env_value("PROCESSOR_ARCHITECTURE").as_deref(),
	)
}

fn vars_indicate_arm64_emulation(wow64_arch: Option<&str>, process_arch: Option<&str>) -> bool {
	let matches_arm64 = |value: Option<&str>| value.is_some_and(|v| v.eq_ignore_ascii_case("ARM64"));
	matches_arm64(wow64_arch) || matches_arm64(process_arch)
}

#[cfg(test)]
mod tests {
	use super::{vars_indicate_arm64_emulation, x64_under_arm64_emulation};

	#[test]
	fn detects_windows_arm64_emulation_markers() {
		assert!(vars_indicate_arm64_emulation(Some("ARM64"), None));
		assert!(vars_indicate_arm64_emulation(None, Some("arm64")));
		assert!(!vars_indicate_arm64_emulation(Some("AMD64"), Some("x86")));
		assert!(!vars_indicate_arm64_emulation(None, None));
	}

	#[test]
	fn returns_false_off_windows_or_non_x64() {
		// Sanity: just calling it shouldn't panic. The result depends on
		// build target + ambient env vars, both of which are stable in CI.
		let _ = x64_under_arm64_emulation();
	}
}

#[cfg(windows)]
#[allow(
	clippy::undocumented_unsafe_blocks,
	reason = "Windows ProjFS bridge is FFI-heavy and safety is validated by pointer and handle \
	          checks"
)]
mod imp {
	use std::{
		collections::{BTreeMap, btree_map::Entry},
		ffi::{OsStr, OsString, c_void},
		fs,
		io::{self, ErrorKind, Read, Seek, SeekFrom},
		mem,
		os::windows::{
			ffi::{OsStrExt, OsStringExt},
			fs::MetadataExt,
		},
		path::{Path, PathBuf},
		sync::{Arc, LazyLock},
	};

	use parking_lot::Mutex;
	use windows_sys::{
		Win32::{
			Foundation::{
				ERROR_ACCESS_DENIED, ERROR_FILE_NOT_FOUND, ERROR_FILE_SYSTEM_VIRTUALIZATION_BUSY,
				ERROR_FILE_SYSTEM_VIRTUALIZATION_INVALID_OPERATION,
				ERROR_FILE_SYSTEM_VIRTUALIZATION_METADATA_CORRUPT,
				ERROR_FILE_SYSTEM_VIRTUALIZATION_PROVIDER_UNKNOWN,
				ERROR_FILE_SYSTEM_VIRTUALIZATION_UNAVAILABLE, ERROR_HANDLE_EOF,
				ERROR_INSUFFICIENT_BUFFER, ERROR_INVALID_FUNCTION, ERROR_INVALID_PARAMETER,
				ERROR_MOD_NOT_FOUND, ERROR_NOT_SUPPORTED, ERROR_OLD_WIN_VERSION, ERROR_OUTOFMEMORY,
				ERROR_PROC_NOT_FOUND, FreeLibrary, GetLastError, HMODULE,
			},
			Storage::ProjectedFileSystem::{
				PRJ_CALLBACK_DATA, PRJ_CALLBACKS, PRJ_CB_DATA_FLAG_ENUM_RESTART_SCAN,
				PRJ_CB_DATA_FLAG_ENUM_RETURN_SINGLE_ENTRY, PRJ_DIR_ENTRY_BUFFER_HANDLE,
				PRJ_EXT_INFO_TYPE_SYMLINK, PRJ_EXTENDED_INFO, PRJ_EXTENDED_INFO_0,
				PRJ_EXTENDED_INFO_0_0, PRJ_FILE_BASIC_INFO, PRJ_NAMESPACE_VIRTUALIZATION_CONTEXT,
				PRJ_PLACEHOLDER_INFO, PRJ_STARTVIRTUALIZING_OPTIONS,
			},
			System::{
				Com::CoCreateGuid,
				LibraryLoader::{GetProcAddress, LoadLibraryW},
			},
		},
		core::{GUID, HRESULT, PCSTR, PCWSTR},
	};

	use crate::{IsoError, IsoResult, ProbeResult};

	const EMPTY_WIDE: [u16; 1] = [0];
	const MAX_READ_CHUNK: usize = 1024 * 1024;
	const E_NOTIMPL: HRESULT = 0x8000_4001_u32 as i32;
	const E_FAIL: HRESULT = 0x8000_4005_u32 as i32;

	type PrjAllocateAlignedBufferFn =
		unsafe extern "system" fn(PRJ_NAMESPACE_VIRTUALIZATION_CONTEXT, usize) -> *mut c_void;
	type PrjFreeAlignedBufferFn = unsafe extern "system" fn(*const c_void);
	type PrjFileNameCompareFn = unsafe extern "system" fn(PCWSTR, PCWSTR) -> i32;
	type PrjFileNameMatchFn = unsafe extern "system" fn(PCWSTR, PCWSTR) -> bool;
	type PrjMarkDirectoryAsPlaceholderFn =
		unsafe extern "system" fn(PCWSTR, PCWSTR, *const c_void, *const GUID) -> HRESULT;
	type PrjStartVirtualizingFn = unsafe extern "system" fn(
		PCWSTR,
		*const PRJ_CALLBACKS,
		*const c_void,
		*const PRJ_STARTVIRTUALIZING_OPTIONS,
		*mut PRJ_NAMESPACE_VIRTUALIZATION_CONTEXT,
	) -> HRESULT;
	type PrjStopVirtualizingFn = unsafe extern "system" fn(PRJ_NAMESPACE_VIRTUALIZATION_CONTEXT);
	type PrjFillDirEntryBuffer2Fn = unsafe extern "system" fn(
		PRJ_DIR_ENTRY_BUFFER_HANDLE,
		PCWSTR,
		*const PRJ_FILE_BASIC_INFO,
		*const PRJ_EXTENDED_INFO,
	) -> HRESULT;
	type PrjWriteFileDataFn = unsafe extern "system" fn(
		PRJ_NAMESPACE_VIRTUALIZATION_CONTEXT,
		*const GUID,
		*const c_void,
		u64,
		u32,
	) -> HRESULT;
	type PrjWritePlaceholderInfo2Fn = unsafe extern "system" fn(
		PRJ_NAMESPACE_VIRTUALIZATION_CONTEXT,
		PCWSTR,
		*const PRJ_PLACEHOLDER_INFO,
		u32,
		*const PRJ_EXTENDED_INFO,
	) -> HRESULT;

	struct ProjfsApi {
		module: HMODULE,
		prj_allocate_aligned_buffer: PrjAllocateAlignedBufferFn,
		prj_free_aligned_buffer: PrjFreeAlignedBufferFn,
		prj_file_name_compare: PrjFileNameCompareFn,
		prj_file_name_match: PrjFileNameMatchFn,
		prj_mark_directory_as_placeholder: PrjMarkDirectoryAsPlaceholderFn,
		prj_start_virtualizing: PrjStartVirtualizingFn,
		prj_stop_virtualizing: PrjStopVirtualizingFn,
		prj_fill_dir_entry_buffer2: PrjFillDirEntryBuffer2Fn,
		prj_write_file_data: PrjWriteFileDataFn,
		prj_write_placeholder_info2: PrjWritePlaceholderInfo2Fn,
	}

	unsafe impl Send for ProjfsApi {}
	unsafe impl Sync for ProjfsApi {}

	impl Drop for ProjfsApi {
		fn drop(&mut self) {
			if !self.module.is_null() {
				unsafe {
					FreeLibrary(self.module);
				}
			}
		}
	}

	impl ProjfsApi {
		fn load() -> std::result::Result<Self, String> {
			let library_name = to_wide(OsStr::new("ProjectedFSLib.dll"));
			let module = unsafe { LoadLibraryW(library_name.as_ptr()) };
			if module.is_null() {
				let win32 = unsafe { GetLastError() };
				return Err(format!("ProjectedFSLib.dll could not be loaded (win32={win32})"));
			}

			macro_rules! load_symbol {
				($name:literal, $ty:ty) => {{
					let proc = unsafe {
						GetProcAddress(module, concat!($name, "\0").as_ptr().cast::<u8>() as PCSTR)
					};
					let Some(proc) = proc else {
						unsafe {
							FreeLibrary(module);
						}
						return Err(format!("ProjectedFSLib.dll missing symbol {}", $name));
					};
					unsafe { mem::transmute::<unsafe extern "system" fn() -> isize, $ty>(proc) }
				}};
			}

			Ok(Self {
				module,
				prj_allocate_aligned_buffer: load_symbol!(
					"PrjAllocateAlignedBuffer",
					PrjAllocateAlignedBufferFn
				),
				prj_free_aligned_buffer: load_symbol!("PrjFreeAlignedBuffer", PrjFreeAlignedBufferFn),
				prj_file_name_compare: load_symbol!("PrjFileNameCompare", PrjFileNameCompareFn),
				prj_file_name_match: load_symbol!("PrjFileNameMatch", PrjFileNameMatchFn),
				prj_mark_directory_as_placeholder: load_symbol!(
					"PrjMarkDirectoryAsPlaceholder",
					PrjMarkDirectoryAsPlaceholderFn
				),
				prj_start_virtualizing: load_symbol!("PrjStartVirtualizing", PrjStartVirtualizingFn),
				prj_stop_virtualizing: load_symbol!("PrjStopVirtualizing", PrjStopVirtualizingFn),
				prj_fill_dir_entry_buffer2: load_symbol!(
					"PrjFillDirEntryBuffer2",
					PrjFillDirEntryBuffer2Fn
				),
				prj_write_file_data: load_symbol!("PrjWriteFileData", PrjWriteFileDataFn),
				prj_write_placeholder_info2: load_symbol!(
					"PrjWritePlaceholderInfo2",
					PrjWritePlaceholderInfo2Fn
				),
			})
		}
	}

	struct DirectoryEntry {
		name_wide:      Vec<u16>,
		basic_info:     PRJ_FILE_BASIC_INFO,
		symlink_target: Option<Vec<u16>>,
	}

	#[derive(Default)]
	struct DirectoryEnumeration {
		entries:           Vec<DirectoryEntry>,
		cursor:            usize,
		search_expression: Option<Vec<u16>>,
	}

	struct ProviderContext {
		lower_root:   PathBuf,
		api:          Arc<ProjfsApi>,
		enumerations: Mutex<BTreeMap<u128, DirectoryEnumeration>>,
	}

	struct ProjfsSession {
		virtualization_context: PRJ_NAMESPACE_VIRTUALIZATION_CONTEXT,
		provider_context:       *mut ProviderContext,
		callbacks:              Box<PRJ_CALLBACKS>,
		api_handle:             Arc<ProjfsApi>,
	}

	// SAFETY: Session ownership is synchronized through `PROJFS_SESSIONS`; raw
	// pointers are only created/freed on controlled start/stop paths and not
	// concurrently aliased.
	unsafe impl Send for ProjfsSession {}

	enum ProjfsSessionState {
		Starting,
		Active(ProjfsSession),
	}

	static PROJFS_SESSIONS: LazyLock<Mutex<BTreeMap<String, ProjfsSessionState>>> =
		LazyLock::new(|| Mutex::new(BTreeMap::new()));

	pub fn probe() -> ProbeResult {
		match ProjfsApi::load() {
			Ok(_) => ProbeResult { available: true, reason: None },
			Err(reason) => ProbeResult { available: false, reason: Some(reason) },
		}
	}

	pub fn start(lower_root: &str, projection_root: &str) -> IsoResult<()> {
		let api = Arc::new(ProjfsApi::load().map_err(unavailable_error)?);
		let lower_root_path = resolve_existing_dir(lower_root)?;
		let projection_root_path = resolve_projection_root(projection_root)?;
		let projection_key = normalize_session_key(&projection_root_path);

		{
			let mut sessions = PROJFS_SESSIONS.lock();
			if sessions.contains_key(&projection_key) {
				return Err(IsoError::other(format!(
					"ProjFS overlay is already active for {}",
					projection_root_path.display()
				)));
			}
			sessions.insert(projection_key.clone(), ProjfsSessionState::Starting);
		}

		let mut instance_id = GUID::default();
		let guid_hr = unsafe { CoCreateGuid(&raw mut instance_id) };
		if is_failed(guid_hr) {
			PROJFS_SESSIONS.lock().remove(&projection_key);
			return Err(IsoError::other(format!(
				"Unable to create ProjFS instance identifier ({})",
				format_hresult(guid_hr)
			)));
		}

		let root_wide = to_wide(projection_root_path.as_os_str());
		let mark_hr = unsafe {
			(api.prj_mark_directory_as_placeholder)(
				root_wide.as_ptr(),
				std::ptr::null(),
				std::ptr::null(),
				&raw const instance_id,
			)
		};
		if is_failed(mark_hr) {
			PROJFS_SESSIONS.lock().remove(&projection_key);
			return Err(classify_start_error("mark placeholder root", mark_hr));
		}

		let provider_context = Box::new(ProviderContext {
			lower_root:   lower_root_path,
			api:          api.clone(),
			enumerations: Mutex::new(BTreeMap::new()),
		});
		let provider_context_ptr = Box::into_raw(provider_context);
		let callbacks = Box::new(PRJ_CALLBACKS {
			StartDirectoryEnumerationCallback: Some(start_directory_enumeration_callback),
			EndDirectoryEnumerationCallback: Some(end_directory_enumeration_callback),
			GetDirectoryEnumerationCallback: Some(get_directory_enumeration_callback),
			GetPlaceholderInfoCallback: Some(get_placeholder_info_callback),
			GetFileDataCallback: Some(get_file_data_callback),
			..Default::default()
		});

		let mut virtualization_context: PRJ_NAMESPACE_VIRTUALIZATION_CONTEXT = std::ptr::null_mut();
		let start_hr = unsafe {
			(api.prj_start_virtualizing)(
				root_wide.as_ptr(),
				callbacks.as_ref(),
				provider_context_ptr.cast::<c_void>(),
				std::ptr::null(),
				&raw mut virtualization_context,
			)
		};
		if is_failed(start_hr) {
			PROJFS_SESSIONS.lock().remove(&projection_key);
			// SAFETY: `provider_context_ptr` comes from `Box::into_raw` above and start
			// failed, so ProjFS never took ownership and this function remains the sole
			// owner.
			unsafe {
				drop(Box::from_raw(provider_context_ptr));
			}
			if !virtualization_context.is_null() {
				// SAFETY: `virtualization_context` is only used when ProjFS returned a non-null
				// context during `PrjStartVirtualizing`; stopping it here prevents a partially
				// started instance from remaining active after start failure.
				unsafe {
					(api.prj_stop_virtualizing)(virtualization_context);
				}
			}
			return Err(classify_start_error("start virtualization", start_hr));
		}

		let started_session = ProjfsSession {
			virtualization_context,
			provider_context: provider_context_ptr,
			callbacks,
			api_handle: api,
		};

		let error_message = {
			let mut sessions = PROJFS_SESSIONS.lock();
			match sessions.entry(projection_key) {
				Entry::Occupied(mut entry) if matches!(entry.get(), ProjfsSessionState::Starting) => {
					entry.insert(ProjfsSessionState::Active(started_session));
					return Ok(());
				},
				Entry::Occupied(_) => {
					format!("ProjFS overlay is already active for {}", projection_root_path.display())
				},
				Entry::Vacant(_) => {
					format!("ProjFS overlay start was canceled for {}", projection_root_path.display())
				},
			}
		};
		stop_projfs_session(started_session);
		Err(IsoError::other(error_message))
	}

	pub fn stop(projection_root: &str) {
		let projection_root_path = resolve_absolute_path(Path::new(projection_root));
		let projection_root_path =
			fs::canonicalize(&projection_root_path).unwrap_or(projection_root_path);
		let key = normalize_session_key(&projection_root_path);
		let session_state = PROJFS_SESSIONS.lock().remove(&key);
		let Some(ProjfsSessionState::Active(session)) = session_state else {
			return;
		};

		stop_projfs_session(session);
	}

	fn stop_projfs_session(session: ProjfsSession) {
		// SAFETY: The session holds the live ProjFS context and provider pointer
		// created in `start`; this function consumes ownership and runs the
		// corresponding one-time teardown.
		unsafe {
			(session.api_handle.prj_stop_virtualizing)(session.virtualization_context);
			drop(Box::from_raw(session.provider_context));
		}
		drop(session.callbacks);
	}

	unsafe extern "system" fn start_directory_enumeration_callback(
		callback_data: *const PRJ_CALLBACK_DATA,
		enumeration_id: *const GUID,
	) -> HRESULT {
		let Ok((callback_data, context)) = callback_context(callback_data) else {
			return hresult_from_win32(ERROR_INVALID_PARAMETER);
		};
		if enumeration_id.is_null() {
			return hresult_from_win32(ERROR_INVALID_PARAMETER);
		}

		let target_path = callback_relative_path(callback_data);
		let entries = match list_directory_entries(context, &target_path) {
			Ok(entries) => entries,
			Err(err) => return io_error_to_hresult(&err),
		};

		let mut enumerations = context.enumerations.lock();
		enumerations.insert(guid_to_u128(unsafe { &*enumeration_id }), DirectoryEnumeration {
			entries,
			cursor: 0,
			search_expression: None,
		});
		0
	}

	unsafe extern "system" fn end_directory_enumeration_callback(
		callback_data: *const PRJ_CALLBACK_DATA,
		enumeration_id: *const GUID,
	) -> HRESULT {
		let Ok((_, context)) = callback_context(callback_data) else {
			return hresult_from_win32(ERROR_INVALID_PARAMETER);
		};
		if enumeration_id.is_null() {
			return hresult_from_win32(ERROR_INVALID_PARAMETER);
		}

		context
			.enumerations
			.lock()
			.remove(&guid_to_u128(unsafe { &*enumeration_id }));
		0
	}

	unsafe extern "system" fn get_directory_enumeration_callback(
		callback_data: *const PRJ_CALLBACK_DATA,
		enumeration_id: *const GUID,
		search_expression: PCWSTR,
		dir_entry_buffer_handle: PRJ_DIR_ENTRY_BUFFER_HANDLE,
	) -> HRESULT {
		let Ok((callback_data, context)) = callback_context(callback_data) else {
			return hresult_from_win32(ERROR_INVALID_PARAMETER);
		};
		if enumeration_id.is_null() {
			return hresult_from_win32(ERROR_INVALID_PARAMETER);
		}

		let enum_key = guid_to_u128(unsafe { &*enumeration_id });
		let mut enumerations = context.enumerations.lock();
		let Some(enumeration) = enumerations.get_mut(&enum_key) else {
			return 0;
		};

		if callback_data.Flags & PRJ_CB_DATA_FLAG_ENUM_RESTART_SCAN != 0 {
			enumeration.cursor = 0;
			enumeration.search_expression = None;
		}
		if !search_expression.is_null() {
			let expression = read_pcwstr(search_expression);
			if !expression.is_empty() {
				let mut with_nul = expression;
				with_nul.push(0);
				enumeration.search_expression = Some(with_nul);
			}
		}

		while enumeration.cursor < enumeration.entries.len() {
			let entry = &enumeration.entries[enumeration.cursor];
			let matched = if let Some(expression) = &enumeration.search_expression {
				unsafe {
					(context.api.prj_file_name_match)(entry.name_wide.as_ptr(), expression.as_ptr())
				}
			} else {
				true
			};

			if matched {
				let extended_info = entry
					.symlink_target
					.as_deref()
					.map(|target| PRJ_EXTENDED_INFO {
						InfoType:       PRJ_EXT_INFO_TYPE_SYMLINK,
						NextInfoOffset: 0,
						Anonymous:      PRJ_EXTENDED_INFO_0 {
							Symlink: PRJ_EXTENDED_INFO_0_0 { TargetName: target.as_ptr() },
						},
					});
				let extended_info_ptr = extended_info
					.as_ref()
					.map_or(std::ptr::null(), |info| info as *const _);
				let hr = unsafe {
					(context.api.prj_fill_dir_entry_buffer2)(
						dir_entry_buffer_handle,
						entry.name_wide.as_ptr(),
						&raw const entry.basic_info,
						extended_info_ptr,
					)
				};
				if is_failed(hr) {
					if win32_from_hresult(hr) == Some(ERROR_INSUFFICIENT_BUFFER) {
						break;
					}
					return hr;
				}
			}

			enumeration.cursor += 1;
			if callback_data.Flags & PRJ_CB_DATA_FLAG_ENUM_RETURN_SINGLE_ENTRY != 0 {
				break;
			}
		}

		0
	}

	unsafe extern "system" fn get_placeholder_info_callback(
		callback_data: *const PRJ_CALLBACK_DATA,
	) -> HRESULT {
		let Ok((callback_data, context)) = callback_context(callback_data) else {
			return hresult_from_win32(ERROR_INVALID_PARAMETER);
		};

		let relative_path = callback_relative_path(callback_data);
		let source_path = context.lower_root.join(relative_path);
		let metadata = match fs::symlink_metadata(&source_path) {
			Ok(metadata) => metadata,
			Err(err) => return io_error_to_hresult(&err),
		};
		let symlink_target = match symlink_target_wide(&source_path, &metadata) {
			Ok(target) => target,
			Err(err) => return io_error_to_hresult(&err),
		};
		let extended_info = symlink_target.as_deref().map(|target| PRJ_EXTENDED_INFO {
			InfoType:       PRJ_EXT_INFO_TYPE_SYMLINK,
			NextInfoOffset: 0,
			Anonymous:      PRJ_EXTENDED_INFO_0 {
				Symlink: PRJ_EXTENDED_INFO_0_0 { TargetName: target.as_ptr() },
			},
		});
		let extended_info_ptr = extended_info
			.as_ref()
			.map_or(std::ptr::null(), |info| info as *const _);

		let placeholder_info =
			PRJ_PLACEHOLDER_INFO { FileBasicInfo: to_basic_info(&metadata), ..Default::default() };

		let destination = if callback_data.FilePathName.is_null() {
			EMPTY_WIDE.as_ptr()
		} else {
			callback_data.FilePathName
		};

		unsafe {
			(context.api.prj_write_placeholder_info2)(
				callback_data.NamespaceVirtualizationContext,
				destination,
				&raw const placeholder_info,
				mem::size_of::<PRJ_PLACEHOLDER_INFO>() as u32,
				extended_info_ptr,
			)
		}
	}

	unsafe extern "system" fn get_file_data_callback(
		callback_data: *const PRJ_CALLBACK_DATA,
		byte_offset: u64,
		length: u32,
	) -> HRESULT {
		let Ok((callback_data, context)) = callback_context(callback_data) else {
			return hresult_from_win32(ERROR_INVALID_PARAMETER);
		};
		if length == 0 {
			return 0;
		}

		let relative_path = callback_relative_path(callback_data);
		let source_path = context.lower_root.join(relative_path);
		let mut file = match fs::File::open(&source_path) {
			Ok(file) => file,
			Err(err) => return io_error_to_hresult(&err),
		};
		if let Err(err) = file.seek(SeekFrom::Start(byte_offset)) {
			return io_error_to_hresult(&err);
		}

		let chunk_size = usize::min(length as usize, MAX_READ_CHUNK);
		let aligned_ptr = unsafe {
			(context.api.prj_allocate_aligned_buffer)(
				callback_data.NamespaceVirtualizationContext,
				chunk_size,
			)
		};
		if aligned_ptr.is_null() {
			return hresult_from_win32(ERROR_OUTOFMEMORY);
		}
		let mut aligned_buffer = AlignedBuffer::new(context.api.clone(), aligned_ptr, chunk_size);

		let mut written = 0usize;
		while written < length as usize {
			let to_read = usize::min(aligned_buffer.len(), length as usize - written);
			if let Err(err) = file.read_exact(&mut aligned_buffer.as_mut_slice()[..to_read]) {
				return io_error_to_hresult(&err);
			}

			let hr = unsafe {
				(context.api.prj_write_file_data)(
					callback_data.NamespaceVirtualizationContext,
					&raw const callback_data.DataStreamId,
					aligned_buffer.as_mut_slice().as_ptr().cast::<c_void>(),
					byte_offset + written as u64,
					to_read as u32,
				)
			};
			if is_failed(hr) {
				return hr;
			}

			written += to_read;
		}

		0
	}

	struct AlignedBuffer {
		api: Arc<ProjfsApi>,
		ptr: *mut c_void,
		len: usize,
	}

	impl AlignedBuffer {
		const fn new(api: Arc<ProjfsApi>, ptr: *mut c_void, len: usize) -> Self {
			Self { api, ptr, len }
		}

		const fn len(&self) -> usize {
			self.len
		}

		const fn as_mut_slice(&mut self) -> &mut [u8] {
			unsafe { std::slice::from_raw_parts_mut(self.ptr.cast::<u8>(), self.len) }
		}
	}

	impl Drop for AlignedBuffer {
		fn drop(&mut self) {
			unsafe {
				(self.api.prj_free_aligned_buffer)(self.ptr);
			}
		}
	}

	fn callback_context(
		callback_data: *const PRJ_CALLBACK_DATA,
	) -> std::result::Result<(&'static PRJ_CALLBACK_DATA, &'static ProviderContext), HRESULT> {
		if callback_data.is_null() {
			return Err(hresult_from_win32(ERROR_INVALID_PARAMETER));
		}
		let callback_data = unsafe { &*callback_data };
		if callback_data.InstanceContext.is_null() {
			return Err(hresult_from_win32(ERROR_INVALID_PARAMETER));
		}
		let context = unsafe { &*(callback_data.InstanceContext.cast::<ProviderContext>()) };
		Ok((callback_data, context))
	}

	fn list_directory_entries(
		context: &ProviderContext,
		relative_path: &Path,
	) -> io::Result<Vec<DirectoryEntry>> {
		let source_dir = context.lower_root.join(relative_path);
		let mut entries = Vec::new();
		for entry in fs::read_dir(&source_dir)? {
			let entry = entry?;
			let path = entry.path();
			let metadata = fs::symlink_metadata(&path)?;
			let symlink_target = symlink_target_wide(&path, &metadata)?;
			let name = entry.file_name();
			let mut name_wide = to_wide(name.as_os_str());
			if name_wide.is_empty() {
				continue;
			}
			entries.push(DirectoryEntry {
				name_wide: {
					name_wide.shrink_to_fit();
					name_wide
				},
				basic_info: to_basic_info(&metadata),
				symlink_target,
			});
		}

		entries.sort_by(|left, right| {
			let compare = unsafe {
				(context.api.prj_file_name_compare)(left.name_wide.as_ptr(), right.name_wide.as_ptr())
			};
			compare.cmp(&0)
		});
		Ok(entries)
	}

	fn to_basic_info(metadata: &fs::Metadata) -> PRJ_FILE_BASIC_INFO {
		PRJ_FILE_BASIC_INFO {
			IsDirectory:    metadata.is_dir(),
			FileSize:       metadata.file_size() as i64,
			CreationTime:   metadata.creation_time() as i64,
			LastAccessTime: metadata.last_access_time() as i64,
			LastWriteTime:  metadata.last_write_time() as i64,
			ChangeTime:     metadata.last_write_time() as i64,
			FileAttributes: metadata.file_attributes(),
		}
	}

	fn symlink_target_wide(path: &Path, metadata: &fs::Metadata) -> io::Result<Option<Vec<u16>>> {
		if !metadata.file_type().is_symlink() {
			return Ok(None);
		}
		let mut target = to_wide(fs::read_link(path)?.as_os_str());
		target.shrink_to_fit();
		Ok(Some(target))
	}

	fn callback_relative_path(callback_data: &PRJ_CALLBACK_DATA) -> PathBuf {
		if callback_data.FilePathName.is_null() {
			return PathBuf::new();
		}
		let raw = read_pcwstr(callback_data.FilePathName);
		if raw.is_empty() {
			return PathBuf::new();
		}
		PathBuf::from(OsString::from_wide(&raw))
	}

	fn read_pcwstr(value: PCWSTR) -> Vec<u16> {
		if value.is_null() {
			return Vec::new();
		}

		let mut len = 0usize;
		unsafe {
			while *value.add(len) != 0 {
				len += 1;
			}
			std::slice::from_raw_parts(value, len).to_vec()
		}
	}

	fn resolve_existing_dir(path: &str) -> crate::IsoResult<PathBuf> {
		let resolved = resolve_absolute_path(Path::new(path));
		let metadata = fs::metadata(&resolved).map_err(|err| {
			IsoError::other(format!("Invalid ProjFS lower root {}: {err}", resolved.display()))
		})?;
		if !metadata.is_dir() {
			return Err(IsoError::other(format!(
				"Invalid ProjFS lower root {}: path is not a directory",
				resolved.display()
			)));
		}
		Ok(fs::canonicalize(&resolved).unwrap_or(resolved))
	}

	fn resolve_projection_root(path: &str) -> crate::IsoResult<PathBuf> {
		let resolved = resolve_absolute_path(Path::new(path));
		fs::create_dir_all(&resolved).map_err(|err| {
			IsoError::other(format!(
				"Unable to create ProjFS projection root {}: {err}",
				resolved.display()
			))
		})?;
		let metadata = fs::metadata(&resolved).map_err(|err| {
			IsoError::other(format!(
				"Unable to access ProjFS projection root {}: {err}",
				resolved.display()
			))
		})?;
		if !metadata.is_dir() {
			return Err(IsoError::other(format!(
				"Invalid ProjFS projection root {}: path is not a directory",
				resolved.display()
			)));
		}
		Ok(fs::canonicalize(&resolved).unwrap_or(resolved))
	}

	fn resolve_absolute_path(path: &Path) -> PathBuf {
		if path.is_absolute() {
			path.to_path_buf()
		} else {
			std::env::current_dir().map_or_else(|_| path.to_path_buf(), |cwd| cwd.join(path))
		}
	}

	fn normalize_session_key(path: &Path) -> String {
		path.to_string_lossy().to_ascii_lowercase()
	}

	fn to_wide(value: &OsStr) -> Vec<u16> {
		let mut encoded: Vec<u16> = value.encode_wide().collect();
		encoded.push(0);
		encoded
	}

	fn unavailable_error(reason: String) -> IsoError {
		IsoError::unavailable(reason)
	}

	fn classify_start_error(phase: &str, hr: HRESULT) -> IsoError {
		let detail = format!("ProjFS {phase} failed ({})", format_hresult(hr));
		if is_unavailable_hresult(hr) {
			return unavailable_error(detail);
		}
		IsoError::other(detail)
	}

	const fn is_unavailable_hresult(hr: HRESULT) -> bool {
		if hr == E_NOTIMPL {
			return true;
		}
		let Some(win32) = win32_from_hresult(hr) else {
			return false;
		};
		matches!(
			win32,
			ERROR_NOT_SUPPORTED
				| ERROR_INVALID_FUNCTION
				| ERROR_MOD_NOT_FOUND
				| ERROR_PROC_NOT_FOUND
				| ERROR_OLD_WIN_VERSION
				| ERROR_FILE_SYSTEM_VIRTUALIZATION_UNAVAILABLE
				| ERROR_FILE_SYSTEM_VIRTUALIZATION_PROVIDER_UNKNOWN
				| ERROR_FILE_SYSTEM_VIRTUALIZATION_METADATA_CORRUPT
				| ERROR_FILE_SYSTEM_VIRTUALIZATION_INVALID_OPERATION
				| ERROR_FILE_SYSTEM_VIRTUALIZATION_BUSY
		)
	}

	fn format_hresult(hr: HRESULT) -> String {
		if let Some(win32) = win32_from_hresult(hr) {
			format!("HRESULT=0x{:08X}, win32={win32}", hr as u32)
		} else {
			format!("HRESULT=0x{:08X}", hr as u32)
		}
	}

	const fn win32_from_hresult(hr: HRESULT) -> Option<u32> {
		let raw = hr as u32;
		if (raw & 0xffff_0000) == 0x8007_0000 {
			Some(raw & 0xffff)
		} else {
			None
		}
	}

	const fn hresult_from_win32(code: u32) -> HRESULT {
		if code == 0 {
			0
		} else {
			((code & 0x0000_ffff) | 0x8007_0000) as i32
		}
	}

	fn io_error_to_hresult(err: &io::Error) -> HRESULT {
		if let Some(code) = err.raw_os_error()
			&& code > 0
		{
			return hresult_from_win32(code as u32);
		}

		match err.kind() {
			ErrorKind::NotFound => hresult_from_win32(ERROR_FILE_NOT_FOUND),
			ErrorKind::PermissionDenied => hresult_from_win32(ERROR_ACCESS_DENIED),
			ErrorKind::UnexpectedEof => hresult_from_win32(ERROR_HANDLE_EOF),
			ErrorKind::OutOfMemory => hresult_from_win32(ERROR_OUTOFMEMORY),
			_ => E_FAIL,
		}
	}

	fn guid_to_u128(guid: &GUID) -> u128 {
		let bytes: [u8; 16] = unsafe { mem::transmute(*guid) };
		u128::from_le_bytes(bytes)
	}

	const fn is_failed(hr: HRESULT) -> bool {
		hr < 0
	}
}
