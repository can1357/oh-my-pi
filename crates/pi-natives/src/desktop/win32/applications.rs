//! Installed Windows applications, independent of capture and input access.
//!
//! ShellExecute's show state is advisory: an application or shortcut target can
//! activate itself despite SW_SHOWNOACTIVATE. Protected processes and shell/DDE
//! handoffs may not expose a verifiable running PID. Packaged applications come
//! from AppsFolder metadata and are matched to processes by their actual AUMID.

use std::{
	collections::{HashMap, HashSet},
	ffi::{OsStr, OsString},
	fs, io,
	mem::size_of,
	os::windows::{
		ffi::{OsStrExt, OsStringExt},
		fs::MetadataExt,
	},
	path::{Path, PathBuf},
	ptr::{null, null_mut},
};

use windows::{
	Win32::{
		Storage::EnhancedStorage::PKEY_AppUserModel_ID,
		System::Com::{CLSCTX_INPROC_SERVER, CoCreateInstance, IPersistFile, STGM_READ},
		UI::Shell::{
			AO_NOERRORUI, ApplicationActivationManager, BHID_EnumItems, FOLDERID_AppsFolder,
			IApplicationActivationManager, IEnumShellItems, IShellItem, IShellItem2, IShellLinkW,
			KF_FLAG_DEFAULT, SHCreateItemInKnownFolder, SHGetIDListFromObject, SIGDN_NORMALDISPLAY,
			ShellLink,
		},
	},
	core::{Interface, PCWSTR, PWSTR},
};
use windows_sys::{
	Win32::{
		Foundation::{CloseHandle, HANDLE, INVALID_HANDLE_VALUE, RPC_E_CHANGED_MODE, WAIT_TIMEOUT},
		Storage::{
			FileSystem::FILE_ATTRIBUTE_REPARSE_POINT,
			Packaging::Appx::{
				APPLICATION_USER_MODEL_ID_MAX_LENGTH, GetApplicationUserModelId,
				ParseApplicationUserModelId,
			},
		},
		System::{
			Com::{COINIT_APARTMENTTHREADED, CoInitializeEx, CoTaskMemFree, CoUninitialize},
			Diagnostics::ToolHelp::{
				CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW,
				TH32CS_SNAPPROCESS,
			},
			Environment::ExpandEnvironmentStringsW,
			Threading::{
				GetProcessId, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
				QueryFullProcessImageNameW, WaitForSingleObject,
			},
		},
		UI::{
			Shell::{
				FOLDERID_CommonPrograms, FOLDERID_Programs, SEE_MASK_FLAG_NO_UI, SEE_MASK_INVOKEIDLIST,
				SEE_MASK_NOASYNC, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW, SHGetKnownFolderPath,
				ShellExecuteExW,
			},
			WindowsAndMessaging::{SW_SHOWNOACTIVATE, SW_SHOWNORMAL},
		},
	},
	core::GUID,
};
use winreg::{
	RegKey,
	enums::{
		HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, KEY_WOW64_32KEY, KEY_WOW64_64KEY,
		REG_EXPAND_SZ, REG_SZ,
	},
};

use super::{
	super::error::{CoreResult, DesktopError},
	Application,
};

const APP_PATHS: &str = r"Software\Microsoft\Windows\CurrentVersion\App Paths";
const APPS_FOLDER_PREFIX: &str = r"shell:AppsFolder\";

struct OwnedHandle(HANDLE);

impl Drop for OwnedHandle {
	fn drop(&mut self) {
		// SAFETY: every instance owns a non-null, non-invalid handle.
		unsafe { CloseHandle(self.0) };
	}
}

struct Apartment(bool);

impl Apartment {
	fn enter() -> CoreResult<Self> {
		// SAFETY: null is required for the reserved parameter.
		let status = unsafe { CoInitializeEx(null(), COINIT_APARTMENTTHREADED as u32) };
		if status >= 0 {
			Ok(Self(true))
		} else if status == RPC_E_CHANGED_MODE {
			// The caller already initialized COM; do not change or release it.
			Ok(Self(false))
		} else {
			Err(hresult_error("initialize COM for application launch", status))
		}
	}
}

impl Drop for Apartment {
	fn drop(&mut self) {
		if self.0 {
			// SAFETY: balances this thread's successful CoInitializeEx call.
			unsafe { CoUninitialize() };
		}
	}
}

fn io_error(action: &str, error: io::Error) -> DesktopError {
	let message = format!("Cannot {action}: {error}");
	if error.raw_os_error() == Some(740) {
		return DesktopError::permission_denied(format!(
			"{message}. This application requires elevation; use an appropriately privileged session."
		));
	}
	if error.raw_os_error() == Some(1260) {
		return DesktopError::permission_denied(format!(
			"{message}. Windows policy blocks this application; contact the system administrator."
		));
	}
	match error.kind() {
		io::ErrorKind::PermissionDenied => DesktopError::permission_denied(format!(
			"{message}. Check the application's file/registry permissions and Windows security \
			 policy."
		)),
		io::ErrorKind::NotFound => DesktopError::invalid_target(format!(
			"{message}. The application may have been moved or uninstalled; refresh the application \
			 list."
		)),
		_ => DesktopError::internal(message),
	}
}

fn hresult_error(action: &str, status: i32) -> DesktopError {
	if status as u32 == 0x8003_0005 {
		io_error(action, io::Error::from(io::ErrorKind::PermissionDenied))
	} else if status as u32 & 0xffff_0000 == 0x8007_0000 {
		io_error(action, io::Error::from_raw_os_error(status & 0xffff))
	} else {
		DesktopError::internal(format!("Cannot {action}: HRESULT 0x{:08x}", status as u32))
	}
}

fn has_extension(path: &Path, extension: &str) -> bool {
	path
		.extension()
		.and_then(OsStr::to_str)
		.is_some_and(|value| value.eq_ignore_ascii_case(extension))
}

/// Shell paths use ordinary drive/UNC syntax, not Rust's verbatim canonical
/// form.
fn path_string(path: &Path) -> CoreResult<String> {
	let value = path.to_str().ok_or_else(|| {
		DesktopError::invalid_target("Application path cannot be represented as Unicode")
	})?;
	if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
		Ok(format!(r"\\{unc}"))
	} else {
		Ok(value.strip_prefix(r"\\?\").unwrap_or(value).to_owned())
	}
}

fn path_key(path: &str) -> String {
	path.replace('/', "\\").to_lowercase()
}

fn describe_path(path: &Path) -> CoreResult<Application> {
	if !path.is_absolute() || !(has_extension(path, "exe") || has_extension(path, "lnk")) {
		return Err(DesktopError::invalid_target(
			"Windows applications require an absolute path to an existing .exe or .lnk file",
		));
	}
	let metadata = fs::metadata(path)
		.map_err(|error| io_error(&format!("inspect application {}", path.display()), error))?;
	if !metadata.is_file() {
		return Err(DesktopError::invalid_target(format!(
			"Application is not a file: {}",
			path.display()
		)));
	}
	let name = path
		.file_stem()
		.and_then(OsStr::to_str)
		.ok_or_else(|| {
			DesktopError::invalid_target("Application filename cannot be represented as Unicode")
		})?
		.to_owned();
	let canonical = fs::canonicalize(path)
		.map_err(|error| io_error(&format!("resolve application {}", path.display()), error))?;
	let path = path_string(&canonical)?;
	Ok(Application { id: path.clone(), name, path, running: false, pid: None })
}

fn programs_folder(id: &GUID) -> CoreResult<Option<PathBuf>> {
	let mut pointer = null_mut();
	// SAFETY: the output pointer is writable and the folder GUID is valid.
	let status = unsafe { SHGetKnownFolderPath(id, 0, null_mut(), &mut pointer) };
	if status < 0 {
		// A profile or common Programs directory need not exist yet.
		if matches!(status as u32, 0x8007_0002 | 0x8007_0003) {
			return Ok(None);
		}
		return Err(hresult_error("locate Windows Start-menu Programs directory", status));
	}
	if pointer.is_null() {
		return Err(DesktopError::internal("Windows returned an empty Start-menu directory pointer"));
	}
	// SAFETY: success returns a NUL-terminated COM allocation, freed below.
	let path = unsafe {
		let mut length = 0;
		while *pointer.add(length) != 0 {
			length += 1;
		}
		let path = PathBuf::from(OsString::from_wide(std::slice::from_raw_parts(pointer, length)));
		CoTaskMemFree(pointer.cast());
		path
	};
	Ok(Some(path))
}

struct ShortcutReader {
	link: IShellLinkW,
	file: IPersistFile,
}

impl ShortcutReader {
	fn new() -> CoreResult<Self> {
		// SAFETY: the caller owns an initialized COM apartment. ShellLink is an
		// in-process Windows COM class; no shortcut target is executed.
		let link: IShellLinkW =
			unsafe { CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER) }
				.map_err(|error| hresult_error("create Windows shortcut reader", error.code().0))?;
		let file = link
			.cast::<IPersistFile>()
			.map_err(|error| hresult_error("access Windows shortcut persistence", error.code().0))?;
		Ok(Self { link, file })
	}

	fn target(&self, path: &Path) -> CoreResult<Option<String>> {
		let source: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
		// SAFETY: source is a terminated filename and Load only reads the link.
		if let Err(error) = unsafe { self.file.Load(PCWSTR(source.as_ptr()), STGM_READ) } {
			if matches!(error.code().0 as u32, 0x8007_0005 | 0x8003_0005) {
				return Err(hresult_error(
					&format!("read shortcut {}", path.display()),
					error.code().0,
				));
			}
			// Corrupt, removed and non-filesystem shortcuts are not applications.
			return Ok(None);
		}
		let mut target = [0u16; 32768];
		// SAFETY: the output slice is writable; find-data is optional. GetPath
		// reads stored target metadata. We deliberately do not call Resolve,
		// which can search for moved targets or display shell UI.
		if let Err(error) = unsafe { self.link.GetPath(&mut target, null_mut(), 0) } {
			if matches!(error.code().0 as u32, 0x8007_0005 | 0x8003_0005) {
				return Err(hresult_error("read shortcut executable target", error.code().0));
			}
			return Ok(None);
		}
		let length = target
			.iter()
			.position(|unit| *unit == 0)
			.unwrap_or(target.len());
		let target = PathBuf::from(OsString::from_wide(&target[..length]));
		if !target.is_absolute() || !has_extension(&target, "exe") {
			return Ok(None);
		}
		match fs::metadata(&target) {
			Ok(metadata) if metadata.is_file() => {},
			Ok(_) => return Ok(None),
			Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
			Err(error) => {
				return Err(io_error(&format!("inspect shortcut target {}", target.display()), error));
			},
		}
		let target = fs::canonicalize(&target).map_err(|error| {
			io_error(&format!("resolve shortcut target {}", target.display()), error)
		})?;
		path_string(&target).map(Some)
	}
}

fn executable_target(app: &Application) -> CoreResult<String> {
	if has_extension(Path::new(&app.path), "exe") {
		return Ok(app.path.clone());
	}
	let _apartment = Apartment::enter()?;
	let shortcuts = ShortcutReader::new()?;
	shortcuts.target(Path::new(&app.path))?.ok_or_else(|| {
		DesktopError::invalid_target(format!(
			"Shortcut {} does not reference an existing filesystem .exe. Document, directory and \
			 opaque packaged-app shortcuts are not supported.",
			app.path
		))
	})
}

fn shortcuts(
	root: PathBuf,
	apps: &mut Vec<Application>,
	reader: &ShortcutReader,
	processes: &HashMap<String, u32>,
) -> CoreResult<()> {
	let mut pending = vec![root];
	while let Some(directory) = pending.pop() {
		let entries = match fs::read_dir(&directory) {
			Ok(entries) => entries,
			Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
			Err(error) => {
				return Err(io_error(
					&format!("read Start-menu directory {}", directory.display()),
					error,
				));
			},
		};
		for entry in entries {
			let entry = entry.map_err(|error| io_error("enumerate Start-menu shortcuts", error))?;
			let path = entry.path();
			let metadata = match fs::symlink_metadata(&path) {
				Ok(metadata) => metadata,
				Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
				Err(error) => {
					return Err(io_error(
						&format!("inspect Start-menu entry {}", path.display()),
						error,
					));
				},
			};
			// Junctions/reparse directories can lead out of the menu or form cycles.
			if metadata.is_dir() && metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0 {
				pending.push(path);
			} else if metadata.is_file() && has_extension(&path, "lnk") {
				if let Some(target) = reader.target(&path)? {
					let mut app = describe_path(&path)?;
					set_running(&mut app, &target, processes);
					apps.push(app);
				}
			}
		}
	}
	Ok(())
}

fn registered_path(value: &str) -> Option<&Path> {
	let value = value.trim();
	let value = value
		.strip_prefix('"')
		.and_then(|value| value.strip_suffix('"'))
		.unwrap_or(value);
	if value.contains(['"', '\0']) {
		return None;
	}
	let path = Path::new(value);
	(path.is_absolute() && has_extension(path, "exe")).then_some(path)
}

fn expand_environment(value: &str) -> CoreResult<String> {
	let source: Vec<u16> = OsStr::new(value).encode_wide().chain(Some(0)).collect();
	// Windows environment expansion is not command/shell interpretation.
	let mut buffer = vec![0u16; 32768];
	// SAFETY: source is terminated and buffer is writable for its declared size.
	let length = unsafe {
		ExpandEnvironmentStringsW(source.as_ptr(), buffer.as_mut_ptr(), buffer.len() as u32)
	};
	if length == 0 {
		return Err(io_error("expand registered application path", io::Error::last_os_error()));
	}
	if length as usize > buffer.len() {
		return Err(DesktopError::invalid_target(
			"Expanded application path exceeds the Windows path limit",
		));
	}
	String::from_utf16(&buffer[..length as usize - 1])
		.map_err(|_| DesktopError::invalid_target("Registered application path is not valid Unicode"))
}

fn registered_applications(apps: &mut Vec<Application>) -> CoreResult<()> {
	for (hive, hive_name) in [(HKEY_CURRENT_USER, "HKCU"), (HKEY_LOCAL_MACHINE, "HKLM")] {
		let root = RegKey::predef(hive);
		for (view, view_name) in [(KEY_WOW64_64KEY, "64"), (KEY_WOW64_32KEY, "32")] {
			let key = match root.open_subkey_with_flags(APP_PATHS, KEY_READ | view) {
				Ok(key) => key,
				Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
				Err(error) => {
					return Err(io_error(
						&format!("read {hive_name} {view_name}-bit App Paths registry"),
						error,
					));
				},
			};
			for entry in key.enum_keys() {
				let entry = entry.map_err(|error| io_error("enumerate registered App Paths", error))?;
				let registration = match key.open_subkey_with_flags(&entry, KEY_READ | view) {
					Ok(key) => key,
					Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
					Err(error) => {
						return Err(io_error(&format!("read application registration {entry}"), error));
					},
				};
				let value = match registration.get_raw_value("") {
					Ok(value) => value,
					Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
					Err(error) => {
						return Err(io_error(&format!("read registered path for {entry}"), error));
					},
				};
				if !matches!(value.vtype, REG_SZ | REG_EXPAND_SZ) || value.bytes.len() % 2 != 0 {
					continue;
				}
				let wide: Vec<u16> = value
					.bytes
					.chunks_exact(2)
					.map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
					.collect();
				let Ok(value_text) = String::from_utf16(&wide) else {
					continue;
				};
				let text = value_text.trim_end_matches('\0');
				let expanded;
				let text = if value.vtype == REG_EXPAND_SZ {
					expanded = expand_environment(text)?;
					&expanded
				} else {
					text
				};
				let Some(path) = registered_path(text) else {
					continue;
				};
				match fs::metadata(path) {
					Ok(metadata) if metadata.is_file() => {},
					Ok(_) => continue,
					Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
					Err(error) => {
						return Err(io_error(
							&format!("inspect registered application {}", path.display()),
							error,
						));
					},
				}
				let mut app = describe_path(path)?;
				app.id = format!("app-path:{hive_name}:{view_name}:{entry}");
				apps.push(app);
			}
		}
	}
	Ok(())
}

/// Consumes the COM-allocated strings returned by shell metadata methods.
fn take_shell_string(pointer: PWSTR) -> CoreResult<String> {
	if pointer.is_null() {
		return Ok(String::new());
	}
	// SAFETY: shell string results are terminated CoTaskMem allocations.
	let value = unsafe { pointer.to_string() };
	unsafe { CoTaskMemFree(pointer.0.cast()) };
	value.map_err(|_| {
		DesktopError::invalid_target("Windows application metadata is not valid Unicode")
	})
}

fn packaged_applications(
	apps: &mut Vec<Application>,
	processes: &HashMap<String, u32>,
) -> CoreResult<()> {
	// SAFETY: caller has initialized COM; null selects the actual AppsFolder.
	let folder: IShellItem =
		unsafe { SHCreateItemInKnownFolder(&FOLDERID_AppsFolder, KF_FLAG_DEFAULT, PCWSTR::null()) }
			.map_err(|error| hresult_error("open registered Windows AppsFolder", error.code().0))?;
	// SAFETY: the shell owns the enumerator and its registered child items.
	let items: IEnumShellItems =
		unsafe { folder.BindToHandler(None, &BHID_EnumItems) }.map_err(|error| {
			hresult_error("enumerate registered Windows applications", error.code().0)
		})?;
	loop {
		let mut batch = [None];
		let mut fetched = 0;
		// SAFETY: the output slice and count outlive the synchronous COM call.
		unsafe { items.Next(&mut batch, Some(&mut fetched)) }
			.map_err(|error| hresult_error("read registered Windows application", error.code().0))?;
		if fetched == 0 {
			break;
		}
		let Some(item) = batch[0].take() else {
			continue;
		};
		let item2: IShellItem2 = item.cast().map_err(|error| {
			hresult_error("read registered application properties", error.code().0)
		})?;
		// Desktop shell items need not have an AppUserModel ID.
		let identity = match unsafe { item2.GetString(&PKEY_AppUserModel_ID) } {
			Ok(value) => take_shell_string(value)?,
			Err(error) if matches!(error.code().0 as u32, 0x8007_0005 | 0x8003_0005) => {
				return Err(hresult_error("read registered application identity", error.code().0));
			},
			Err(_) => continue,
		};
		let wide: Vec<u16> = identity.encode_utf16().chain(Some(0)).collect();
		let mut family = [0u16; APPLICATION_USER_MODEL_ID_MAX_LENGTH as usize + 1];
		let mut relative = [0u16; APPLICATION_USER_MODEL_ID_MAX_LENGTH as usize + 1];
		let mut family_length = family.len() as u32;
		let mut relative_length = relative.len() as u32;
		// SAFETY: buffers and lengths are valid. Native parsing distinguishes
		// packaged AUMIDs from arbitrary desktop application IDs.
		if unsafe {
			ParseApplicationUserModelId(
				wide.as_ptr(),
				&mut family_length,
				family.as_mut_ptr(),
				&mut relative_length,
				relative.as_mut_ptr(),
			)
		} != 0
		{
			continue;
		}
		// SAFETY: GetDisplayName returns a COM-owned string consumed below.
		let name = take_shell_string(
			unsafe { item.GetDisplayName(SIGDN_NORMALDISPLAY) }
				.map_err(|error| hresult_error("read packaged application name", error.code().0))?,
		)?;
		let pid = processes.get(&format!("aumid:{identity}")).copied();
		apps.push(Application {
			path: format!("{APPS_FOLDER_PREFIX}{identity}"),
			id: identity,
			name,
			running: pid.is_some(),
			pid,
		});
	}
	Ok(())
}

fn open_packaged(mut app: Application, activate: bool) -> CoreResult<Application> {
	let _apartment = Apartment::enter()?;
	let identity: Vec<u16> = app.id.encode_utf16().chain(Some(0)).collect();
	if activate {
		// SAFETY: an initialized apartment creates the native activation manager.
		let manager: IApplicationActivationManager =
			unsafe { CoCreateInstance(&ApplicationActivationManager, None, CLSCTX_INPROC_SERVER) }
				.map_err(|error| {
					hresult_error("create packaged application activation manager", error.code().0)
				})?;
		// ActivateApplication explicitly activates; its output is the actual
		// contract-handling application's PID, not Explorer's or a shell broker's.
		let pid = unsafe {
			manager.ActivateApplication(PCWSTR(identity.as_ptr()), PCWSTR::null(), AO_NOERRORUI)
		}
		.map_err(|error| {
			hresult_error(&format!("activate packaged application {}", app.id), error.code().0)
		})?;
		app.pid = (pid != 0).then_some(pid);
		app.running = app.pid.is_some();
		return Ok(app);
	}
	// ActivateApplication has no normal no-activate option. Invoke the actual
	// registered shell item instead, passing the native advisory noactivate show
	// state. Packaged activation/brokers can still ignore that request.
	let item: IShellItem = unsafe {
		SHCreateItemInKnownFolder(&FOLDERID_AppsFolder, KF_FLAG_DEFAULT, PCWSTR(identity.as_ptr()))
	}
	.map_err(|error| {
		hresult_error(&format!("locate packaged application {}", app.id), error.code().0)
	})?;
	let item_id = unsafe { SHGetIDListFromObject(&item) }
		.map_err(|error| hresult_error("read packaged application shell identity", error.code().0))?;
	let mut execute = SHELLEXECUTEINFOW {
		cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
		fMask: SEE_MASK_INVOKEIDLIST | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
		lpIDList: item_id.cast(),
		nShow: SW_SHOWNOACTIVATE,
		..Default::default()
	};
	// SAFETY: the PIDL remains alive throughout the shell call. NOASYNC is
	// advisory/ignored for namespace items, so process appearance can lag return.
	let success = unsafe { ShellExecuteExW(&mut execute) } != 0;
	let error = (!success).then(io::Error::last_os_error);
	unsafe { CoTaskMemFree(item_id.cast()) };
	if let Some(error) = error {
		return Err(io_error(&format!("open packaged application {}", app.id), error));
	}
	// Do not use a shell/Explorer/activation-broker PID as application evidence.
	app.pid = running_processes()
		.get(&format!("aumid:{}", app.id))
		.copied();
	app.running = app.pid.is_some();
	Ok(app)
}

/// Running state is best-effort evidence, never a prerequisite for discovery.
/// Protected processes and processes that exit during enumeration are skipped.
fn running_processes() -> HashMap<String, u32> {
	let mut running = HashMap::new();
	// SAFETY: process snapshots require no process id or caller-owned pointers.
	let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) };
	if snapshot == INVALID_HANDLE_VALUE || snapshot.is_null() {
		return running;
	}
	let snapshot = OwnedHandle(snapshot);
	let mut entry =
		PROCESSENTRY32W { dwSize: size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
	let mut image = [0u16; 32768];
	let mut identity = [0u16; APPLICATION_USER_MODEL_ID_MAX_LENGTH as usize + 1];
	// SAFETY: entry has the required size and the snapshot remains owned here.
	let mut more = unsafe { Process32FirstW(snapshot.0, &mut entry) } != 0;
	while more {
		// SAFETY: querying a PID does not borrow process memory.
		let process =
			unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, entry.th32ProcessID) };
		if !process.is_null() {
			let process = OwnedHandle(process);
			let mut identity_length = identity.len() as u32;
			// SAFETY: this process has query-limited rights and the output is
			// writable. Unpackaged/protected processes simply have no AUMID.
			if unsafe {
				GetApplicationUserModelId(process.0, &mut identity_length, identity.as_mut_ptr())
			} == 0 && identity_length > 1
				&& identity_length as usize <= identity.len()
			{
				if let Ok(id) = String::from_utf16(&identity[..identity_length as usize - 1]) {
					running
						.entry(format!("aumid:{id}"))
						.and_modify(|pid: &mut u32| *pid = (*pid).min(entry.th32ProcessID))
						.or_insert(entry.th32ProcessID);
				}
			}
			let mut length = image.len() as u32;
			// SAFETY: the process handle and writable output buffer are valid.
			if unsafe { QueryFullProcessImageNameW(process.0, 0, image.as_mut_ptr(), &mut length) }
				!= 0
			{
				if let Ok(path) = String::from_utf16(&image[..length as usize]) {
					if let Ok(path) = path_string(Path::new(&path)) {
						running
							.entry(path_key(&path))
							.and_modify(|pid: &mut u32| *pid = (*pid).min(entry.th32ProcessID))
							.or_insert(entry.th32ProcessID);
					}
				}
			}
		}
		// SAFETY: same initialized entry and live snapshot as above.
		more = unsafe { Process32NextW(snapshot.0, &mut entry) } != 0;
	}
	running
}

fn set_running(app: &mut Application, executable: &str, processes: &HashMap<String, u32>) {
	app.pid = processes.get(&path_key(executable)).copied();
	app.running = app.pid.is_some();
}

pub(super) fn list() -> CoreResult<Vec<Application>> {
	let _apartment = Apartment::enter()?;
	let reader = ShortcutReader::new()?;
	let processes = running_processes();
	let mut apps = Vec::new();
	registered_applications(&mut apps)?;
	for app in &mut apps {
		app.pid = processes.get(&path_key(&app.path)).copied();
		app.running = app.pid.is_some();
	}
	for folder in [&FOLDERID_Programs, &FOLDERID_CommonPrograms] {
		if let Some(root) = programs_folder(folder)? {
			shortcuts(root, &mut apps, &reader, &processes)?;
		}
	}
	packaged_applications(&mut apps, &processes)?;
	let mut seen = HashSet::new();
	apps.retain(|app| seen.insert(path_key(&app.path)));
	apps.sort_unstable_by(|left, right| {
		left
			.name
			.cmp(&right.name)
			.then_with(|| left.id.cmp(&right.id))
	});
	Ok(apps)
}

pub(super) fn from_path(path: &Path) -> CoreResult<Application> {
	let mut app = describe_path(path)?;
	let target = executable_target(&app)?;
	set_running(&mut app, &target, &running_processes());
	Ok(app)
}

pub(super) fn open(mut app: Application, activate: bool) -> CoreResult<Application> {
	if app.path.starts_with(APPS_FOLDER_PREFIX) {
		return open_packaged(app, activate);
	}
	// Revalidate in case an application was removed after discovery.
	let metadata = fs::metadata(&app.path)
		.map_err(|error| io_error(&format!("inspect application {}", app.path), error))?;
	if !metadata.is_file() {
		return Err(DesktopError::invalid_target(format!("Application is not a file: {}", app.path)));
	}
	let _apartment = Apartment::enter()?;
	let target = executable_target(&app)?;
	let path: Vec<u16> = OsStr::new(&app.path).encode_wide().chain(Some(0)).collect();
	let verb = [b'o' as u16, b'p' as u16, b'e' as u16, b'n' as u16, 0];
	let mut execute = SHELLEXECUTEINFOW {
		cbSize: size_of::<SHELLEXECUTEINFOW>() as u32,
		fMask: SEE_MASK_NOCLOSEPROCESS | SEE_MASK_NOASYNC | SEE_MASK_FLAG_NO_UI,
		lpVerb: verb.as_ptr(),
		lpFile: path.as_ptr(),
		nShow: if activate {
			SW_SHOWNORMAL
		} else {
			SW_SHOWNOACTIVATE
		},
		..Default::default()
	};
	// SAFETY: all strings remain alive through this synchronous shell operation.
	// No command-line string, guessed executable or shell interpolation is used.
	if unsafe { ShellExecuteExW(&mut execute) } == 0 {
		return Err(io_error(&format!("open application {}", app.path), io::Error::last_os_error()));
	}
	app.pid = None;
	app.running = false;
	if !execute.hProcess.is_null() {
		let process = OwnedHandle(execute.hProcess);
		// SAFETY: ShellExecuteEx supplied an owned process handle. A zero wait
		// tests liveness without blocking or assuming a launcher remains alive.
		if unsafe { WaitForSingleObject(process.0, 0) } == WAIT_TIMEOUT {
			let mut image = [0u16; 32768];
			let mut length = image.len() as u32;
			// A shell process handle can describe a broker. Only expose its PID
			// when its image is the actual registered executable/link target.
			if unsafe { QueryFullProcessImageNameW(process.0, 0, image.as_mut_ptr(), &mut length) }
				!= 0
			{
				if let Ok(image) = String::from_utf16(&image[..length as usize]) {
					if path_string(Path::new(&image))
						.is_ok_and(|image| path_key(&image) == path_key(&target))
					{
						// SAFETY: this is the verified target's process handle.
						let pid = unsafe { GetProcessId(process.0) };
						app.pid = (pid != 0).then_some(pid);
						app.running = true;
					}
				}
			}
		}
	}
	if !app.running {
		set_running(&mut app, &target, &running_processes());
	}
	Ok(app)
}

#[cfg(test)]
mod tests {
	use std::path::Path;

	use super::registered_path;

	#[test]
	fn registered_paths_are_files_not_command_lines() {
		assert_eq!(
			registered_path(r#" "C:\Program Files\Editor\editor.exe" "#),
			Some(Path::new(r"C:\Program Files\Editor\editor.exe"))
		);
		assert_eq!(
			registered_path(r"C:\Editor\editor.exe"),
			Some(Path::new(r"C:\Editor\editor.exe"))
		);
		for value in [
			r"editor.exe",
			r#""C:\Editor\editor.exe" --new-window"#,
			r"C:\Editor\editor.exe --new-window",
			r"C:\Editor\open.cmd",
			"C:\\Editor\\editor.exe\0ignored",
		] {
			assert!(registered_path(value).is_none(), "{value:?}");
		}
	}
}
