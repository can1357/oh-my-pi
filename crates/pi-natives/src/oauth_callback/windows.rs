use std::{
	borrow::Cow,
	ffi::{OsStr, OsString},
	io,
	os::windows::ffi::{OsStrExt, OsStringExt},
	path::{Component, Path},
	ptr,
};

use anyhow::{Context as _, Result, bail};
use serde::{Deserialize, Serialize};
use windows_sys::Win32::{
	Foundation::ERROR_DIR_NOT_EMPTY,
	UI::Shell::{
		ASSOCF_IS_PROTOCOL, ASSOCF_NOFIXUPS, ASSOCF_VERIFY, ASSOCSTR_COMMAND, AssocQueryStringW,
		SHCNE_ASSOCCHANGED, SHCNF_FLUSH, SHCNF_IDLIST, SHChangeNotify,
	},
};
use winreg::{
	HKCU, RegValue,
	enums::{
		KEY_READ, KEY_WRITE, REG_BINARY, REG_DWORD, REG_DWORD_BIG_ENDIAN, REG_EXPAND_SZ,
		REG_FULL_RESOURCE_DESCRIPTOR, REG_LINK, REG_MULTI_SZ, REG_NONE, REG_QWORD, REG_RESOURCE_LIST,
		REG_RESOURCE_REQUIREMENTS_LIST, REG_SZ, RegType,
	},
};

use super::context::Context;

const SNAPSHOT_VERSION: u32 = 1;
const MARKER_NAME: &str = "omp OAuth Callback Transaction";
const DEFAULT_VALUE: &str = "";

/// Complete pre-registration state for the HKCU values touched by this backend.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Snapshot {
	version:   u32,
	scheme:    String,
	root_path: String,
	id:        String,
	keys:      Vec<KeySnapshot>,
	values:    Vec<ValueSnapshot>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct KeySnapshot {
	path:    String,
	present: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ValueSnapshot {
	path:  String,
	name:  String,
	value: Option<RawValue>,
}

#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct RawValue {
	value_type: u32,
	bytes:      Vec<u8>,
}

struct Layout {
	root:   String,
	paths:  [String; 4],
	values: [(String, String); 4],
}

/// Capture the exact user-registry state before a transactional registration.
pub(super) fn prepare(context: &Context) -> Result<Snapshot> {
	context.check()?;
	validate_identity(context)?;
	refuse_protected_default(&context.scheme)?;

	let layout = Layout::new(&context.scheme);
	let keys = layout
		.paths
		.iter()
		.map(|path| {
			context.check()?;
			Ok(KeySnapshot { path: path.clone(), present: key_exists(path)? })
		})
		.collect::<Result<Vec<_>>>()?;
	let values = layout
		.values
		.iter()
		.map(|(path, name)| {
			context.check()?;
			Ok(ValueSnapshot {
				path:  path.clone(),
				name:  name.clone(),
				value: read_value(path, name)?,
			})
		})
		.collect::<Result<Vec<_>>>()?;
	let snapshot = Snapshot {
		version: SNAPSHOT_VERSION,
		scheme: context.scheme.clone(),
		root_path: layout.root,
		id: context.id.clone(),
		keys,
		values,
	};
	validate_snapshot(context, &snapshot)?;
	if snapshot.values[3].value == Some(marker_value(&context.id)) {
		bail!("HKCU\\{} already contains this OAuth callback transaction nonce", snapshot.root_path);
	}
	Ok(snapshot)
}

/// Install the callback protocol under HKCU after the caller has journaled
/// `snapshot`.
pub(super) fn activate(context: &Context, snapshot: &Snapshot) -> Result<()> {
	context.check()?;
	validate_snapshot(context, snapshot)?;
	refuse_protected_default(&context.scheme)?;

	for key in &snapshot.keys {
		context.check()?;
		if key_exists(&key.path)? != key.present {
			bail!("HKCU\\{} changed while OAuth callback registration was being prepared", key.path);
		}
	}
	for value in &snapshot.values {
		context.check()?;
		if read_value(&value.path, &value.name)? != value.value {
			bail!(
				"HKCU\\{} value {:?} changed while OAuth callback registration was being prepared",
				value.path,
				value.name
			);
		}
	}

	let command = relay_command(&context.helper_path, &context.callback_path)?;
	let owned = owned_values(context, &command);
	// The nonce is installed first. A crash after any later write is therefore
	// distinguishable from both untouched state and another program's state.
	for (index, desired) in owned.iter().enumerate().rev() {
		context.check()?;
		let before = &snapshot.values[index];
		if read_value(&before.path, &before.name)? != before.value {
			bail!(
				"HKCU\\{} value {:?} changed during OAuth callback registration",
				before.path,
				before.name
			);
		}
		write_value(&before.path, &before.name, desired)?;
	}

	refuse_protected_default(&context.scheme)?;
	notify_association_changed();
	let effective = effective_command(&context.scheme)?;
	if effective != command {
		bail!(
			"Windows did not select this transaction's handler for the {:?} protocol",
			context.scheme
		);
	}
	Ok(())
}

/// Restore only values that are still provably owned by this transaction.
pub(super) fn restore(context: &Context, snapshot: &Snapshot) -> Result<()> {
	context.check()?;
	let layout = validate_snapshot(context, snapshot)?;
	let command = relay_command(&context.helper_path, &context.callback_path)?;
	let owned = owned_values(context, &command);
	let marker_before = &snapshot.values[3].value;
	let marker_owned = &owned[3];
	let marker_current = read_value(&layout.root, MARKER_NAME)?;

	if marker_current == *marker_before {
		#[allow(
			clippy::needless_range_loop,
			reason = "indexes both snapshot.values and owned concurrently"
		)]
		for index in 0..3 {
			let current = read_value(&snapshot.values[index].path, &snapshot.values[index].name)?;
			if current == Some(owned[index].clone()) && current != snapshot.values[index].value {
				bail!(
					"Windows OAuth callback ownership marker is absent while HKCU\\{} still has this \
					 transaction's value {:?}",
					snapshot.values[index].path,
					snapshot.values[index].name
				);
			}
		}
		cleanup_created_keys(context, snapshot)?;
		notify_association_changed();
		return Ok(());
	}
	if marker_current != Some(marker_owned.clone()) {
		bail!(
			"Windows OAuth callback ownership marker changed; recovery left HKCU\\{} untouched",
			layout.root
		);
	}

	let mut conflicts = Vec::new();
	#[allow(
		clippy::needless_range_loop,
		reason = "indexes both snapshot.values and owned concurrently"
	)]
	for index in 0..3 {
		context.check()?;
		let entry = &snapshot.values[index];
		let current = read_value(&entry.path, &entry.name)?;
		if current == Some(owned[index].clone()) {
			restore_value(entry)?;
		} else if current != entry.value {
			conflicts.push(format!("HKCU\\{} value {:?}", entry.path, entry.name));
		}
	}
	if !conflicts.is_empty() {
		notify_association_changed();
		bail!(
			"Windows OAuth callback recovery preserved externally changed {}; the ownership journal \
			 was retained",
			conflicts.join(", ")
		);
	}

	context.check()?;
	if read_value(&layout.root, MARKER_NAME)? != Some(marker_owned.clone()) {
		bail!("Windows OAuth callback ownership marker changed during recovery");
	}
	restore_value(&snapshot.values[3])?;
	cleanup_created_keys(context, snapshot)?;
	notify_association_changed();
	Ok(())
}

impl Layout {
	fn new(scheme: &str) -> Self {
		let root = format!("Software\\Classes\\{scheme}");
		let shell = format!("{root}\\shell");
		let open = format!("{shell}\\open");
		let command = format!("{open}\\command");
		Self {
			root:   root.clone(),
			paths:  [root.clone(), shell, open, command.clone()],
			values: [
				(root.clone(), DEFAULT_VALUE.to_owned()),
				(root.clone(), "URL Protocol".to_owned()),
				(command, DEFAULT_VALUE.to_owned()),
				(root, MARKER_NAME.to_owned()),
			],
		}
	}
}

fn validate_identity(context: &Context) -> Result<()> {
	let mut scheme = context.scheme.bytes();
	if !matches!(scheme.next(), Some(b'a'..=b'z'))
		|| !scheme
			.all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"+.-".contains(&byte))
	{
		bail!("invalid OAuth callback scheme {:?}", context.scheme);
	}
	if context.id.len() != 32
		|| !context
			.id
			.bytes()
			.all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
	{
		bail!("invalid OAuth callback transaction nonce");
	}
	if !context.directory.is_absolute()
		|| context
			.directory
			.components()
			.any(|component| matches!(component, Component::ParentDir))
		|| context.callback_path != context.directory.join("callback.url")
		|| context.helper_path != context.directory.join("callback-helper.exe")
	{
		bail!("invalid Windows OAuth callback transaction paths");
	}
	Ok(())
}

#[allow(
	clippy::suspicious_operation_groupings,
	reason = "layout fields are paths and values, not keys"
)]
fn validate_snapshot(context: &Context, snapshot: &Snapshot) -> Result<Layout> {
	validate_identity(context)?;
	let layout = Layout::new(&context.scheme);
	if snapshot.version != SNAPSHOT_VERSION
		|| snapshot.scheme != context.scheme
		|| snapshot.root_path != layout.root
		|| snapshot.id != context.id
	{
		bail!("invalid Windows OAuth callback registry snapshot identity");
	}
	if snapshot.keys.len() != layout.paths.len() || snapshot.values.len() != layout.values.len() {
		bail!("invalid Windows OAuth callback registry snapshot size");
	}
	for (index, (entry, expected)) in snapshot.keys.iter().zip(layout.paths.iter()).enumerate() {
		if entry.path != *expected
			|| (entry.present && snapshot.keys[..index].iter().any(|parent| !parent.present))
		{
			bail!("invalid Windows OAuth callback registry key snapshot");
		}
	}
	for (index, (entry, (expected_path, expected_name))) in
		snapshot.values.iter().zip(layout.values.iter()).enumerate()
	{
		let key_index = if index == 2 { 3 } else { 0 };
		if entry.path != *expected_path
			|| entry.name != *expected_name
			|| (entry.value.is_some() && !snapshot.keys[key_index].present)
		{
			bail!("invalid Windows OAuth callback registry value snapshot");
		}
		if let Some(value) = &entry.value {
			reg_type(value.value_type)?;
		}
	}
	Ok(layout)
}

fn owned_values(context: &Context, command: &OsStr) -> [RawValue; 4] {
	[
		reg_sz(OsStr::new(&format!("URL:{} Protocol", context.scheme))),
		reg_sz(OsStr::new("")),
		reg_sz(command),
		marker_value(&context.id),
	]
}

fn marker_value(id: &str) -> RawValue {
	reg_sz(OsStr::new(id))
}

fn key_exists(path: &str) -> Result<bool> {
	match HKCU.open_subkey_with_flags(path, KEY_READ) {
		Ok(_) => Ok(true),
		Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
		Err(error) => Err(error).with_context(|| format!("failed to inspect HKCU\\{path}")),
	}
}

fn read_value(path: &str, name: &str) -> Result<Option<RawValue>> {
	let key = match HKCU.open_subkey_with_flags(path, KEY_READ) {
		Ok(key) => key,
		Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
		Err(error) => return Err(error).with_context(|| format!("failed to open HKCU\\{path}")),
	};
	match key.get_raw_value(name) {
		Ok(value) => Ok(Some(RawValue {
			value_type: value.vtype.clone() as u32,
			bytes:      value.bytes.into_owned(),
		})),
		Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
		Err(error) => {
			Err(error).with_context(|| format!("failed to read HKCU\\{path} value {name:?}"))
		},
	}
}

fn write_value(path: &str, name: &str, value: &RawValue) -> Result<()> {
	let (key, _) = HKCU
		.create_subkey_with_flags(path, KEY_READ | KEY_WRITE)
		.with_context(|| format!("failed to create HKCU\\{path}"))?;
	let value = RegValue { bytes: Cow::Borrowed(&value.bytes), vtype: reg_type(value.value_type)? };
	key.set_raw_value(name, &value)
		.with_context(|| format!("failed to write HKCU\\{path} value {name:?}"))
}

fn restore_value(entry: &ValueSnapshot) -> Result<()> {
	if let Some(value) = &entry.value {
		return write_value(&entry.path, &entry.name, value);
	}
	let key = match HKCU.open_subkey_with_flags(&entry.path, KEY_READ | KEY_WRITE) {
		Ok(key) => key,
		Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
		Err(error) => {
			return Err(error).with_context(|| format!("failed to open HKCU\\{}", entry.path));
		},
	};
	match key.delete_value(&entry.name) {
		Ok(()) => Ok(()),
		Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
		Err(error) => Err(error)
			.with_context(|| format!("failed to remove HKCU\\{} value {:?}", entry.path, entry.name)),
	}
}

fn cleanup_created_keys(context: &Context, snapshot: &Snapshot) -> Result<()> {
	for entry in snapshot.keys.iter().rev().filter(|entry| !entry.present) {
		context.check()?;
		delete_key_if_empty(&entry.path)?;
	}
	Ok(())
}

fn delete_key_if_empty(path: &str) -> Result<()> {
	let key = match HKCU.open_subkey_with_flags(path, KEY_READ | KEY_WRITE) {
		Ok(key) => key,
		Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
		Err(error) => return Err(error).with_context(|| format!("failed to inspect HKCU\\{path}")),
	};
	let info = key
		.query_info()
		.with_context(|| format!("failed to inspect HKCU\\{path}"))?;
	if info.sub_keys != 0 || info.values != 0 {
		return Ok(());
	}
	drop(key);
	let (parent_path, child_name) = path
		.rsplit_once('\\')
		.filter(|(parent, child)| !parent.is_empty() && !child.is_empty())
		.ok_or_else(|| anyhow::anyhow!("refusing to remove invalid registry path {path:?}"))?;
	let parent = match HKCU.open_subkey_with_flags(parent_path, KEY_READ | KEY_WRITE) {
		Ok(parent) => parent,
		Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
		Err(error) => {
			return Err(error).with_context(|| format!("failed to open HKCU\\{parent_path}"));
		},
	};
	match parent.delete_subkey(child_name) {
		Ok(()) => Ok(()),
		Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
		// A concurrent writer made the key non-empty. Preserve it rather than
		// escalating to recursive deletion.
		Err(error) if error.raw_os_error() == Some(ERROR_DIR_NOT_EMPTY as i32) => Ok(()),
		Err(error) => Err(error).with_context(|| format!("failed to remove empty HKCU\\{path}")),
	}
}

fn refuse_protected_default(scheme: &str) -> Result<()> {
	let path = format!(
		"Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\{scheme}\\UserChoice"
	);
	let key = match HKCU.open_subkey_with_flags(&path, KEY_READ) {
		Ok(key) => key,
		Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
		Err(error) => {
			return Err(error)
				.context("failed to inspect the protected Windows default-app selection");
		},
	};
	let prog_id = key
		.get_raw_value("ProgId")
		.ok()
		.and_then(|value| decode_reg_sz(&value))
		.map(|value| format!(" ({})", value.to_string_lossy()))
		.unwrap_or_default();
	bail!(
		"Windows has a protected default-app selection for {scheme:?}{prog_id}; use manual callback \
		 input or change the default app in Windows Settings"
	)
}

fn relay_command(helper: &Path, callback: &Path) -> Result<OsString> {
	if helper.as_os_str().encode_wide().any(|unit| unit == 0)
		|| callback.as_os_str().encode_wide().any(|unit| unit == 0)
	{
		bail!("Windows OAuth callback paths cannot contain NUL");
	}
	let mut units = quote_windows_argument(helper.as_os_str());
	units.push(b' ' as u16);
	units.extend(quote_windows_argument(callback.as_os_str()));
	units.push(b' ' as u16);
	units.extend(quote_windows_argument(OsStr::new("%1")));
	if units.len() >= 32_767 {
		bail!("Windows OAuth callback command exceeds the CreateProcessW limit");
	}
	Ok(OsString::from_wide(&units))
}

fn quote_windows_argument(value: &OsStr) -> Vec<u16> {
	let mut output = vec![b'"' as u16];
	let mut backslashes = 0usize;
	for unit in value.encode_wide() {
		if unit == b'\\' as u16 {
			backslashes += 1;
			continue;
		}
		if unit == b'"' as u16 {
			output.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2 + 1));
		} else {
			output.extend(std::iter::repeat_n(b'\\' as u16, backslashes));
		}
		output.push(unit);
		backslashes = 0;
	}
	output.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2));
	output.push(b'"' as u16);
	output
}

fn reg_sz(value: &OsStr) -> RawValue {
	let mut bytes = Vec::new();
	for unit in value.encode_wide().chain(std::iter::once(0)) {
		bytes.extend_from_slice(&unit.to_le_bytes());
	}
	RawValue { value_type: REG_SZ.clone() as u32, bytes }
}

fn decode_reg_sz(value: &RegValue<'_>) -> Option<OsString> {
	if value.vtype != REG_SZ && value.vtype != REG_EXPAND_SZ || !value.bytes.len().is_multiple_of(2)
	{
		return None;
	}
	let mut units = value
		.bytes
		.as_chunks::<2>()
		.0
		.iter()
		.map(|&[b0, b1]| u16::from_le_bytes([b0, b1]))
		.collect::<Vec<_>>();
	while units.last() == Some(&0) {
		units.pop();
	}
	Some(OsString::from_wide(&units))
}

fn reg_type(value_type: u32) -> Result<RegType> {
	Ok(match value_type {
		0 => REG_NONE,
		1 => REG_SZ,
		2 => REG_EXPAND_SZ,
		3 => REG_BINARY,
		4 => REG_DWORD,
		5 => REG_DWORD_BIG_ENDIAN,
		6 => REG_LINK,
		7 => REG_MULTI_SZ,
		8 => REG_RESOURCE_LIST,
		9 => REG_FULL_RESOURCE_DESCRIPTOR,
		10 => REG_RESOURCE_REQUIREMENTS_LIST,
		11 => REG_QWORD,
		_ => bail!("unsupported registry value type {value_type}"),
	})
}

fn notify_association_changed() {
	// SAFETY: SHChangeNotify with SHCNE_ASSOCCHANGED and null pointers safely
	// notifies the Windows shell of file association changes without dereferencing
	// invalid memory.
	unsafe {
		SHChangeNotify(
			SHCNE_ASSOCCHANGED as i32,
			SHCNF_IDLIST | SHCNF_FLUSH,
			ptr::null(),
			ptr::null(),
		);
	}
}

fn effective_command(scheme: &str) -> Result<OsString> {
	let association = OsStr::new(scheme)
		.encode_wide()
		.chain(std::iter::once(0))
		.collect::<Vec<_>>();
	let mut output = vec![0u16; 32_768];
	let mut length = output.len() as u32;
	// SAFETY: `association` is null-terminated, `output` is allocated with `length`
	// capacity, and AssocQueryStringW writes within the bounds specified by `&mut
	// length`.
	let result = unsafe {
		AssocQueryStringW(
			ASSOCF_IS_PROTOCOL | ASSOCF_NOFIXUPS | ASSOCF_VERIFY,
			ASSOCSTR_COMMAND,
			association.as_ptr(),
			ptr::null(),
			output.as_mut_ptr(),
			&mut length,
		)
	};
	if result < 0 {
		bail!(
			"Windows could not resolve the effective protocol handler (HRESULT {:#010x})",
			result as u32
		);
	}
	let used = usize::try_from(length)
		.unwrap_or(output.len())
		.min(output.len());
	let end = output[..used]
		.iter()
		.position(|unit| *unit == 0)
		.unwrap_or(used);
	Ok(OsString::from_wide(&output[..end]))
}

#[cfg(test)]
mod tests {
	use std::{
		collections::BTreeMap,
		fs,
		sync::atomic::{AtomicU64, Ordering},
		time::{SystemTime, UNIX_EPOCH},
	};

	use super::*;
	use crate::task::CancelToken;

	static TEST_SEQUENCE: AtomicU64 = AtomicU64::new(1);

	struct DisposableScheme {
		scheme:    String,
		directory: std::path::PathBuf,
	}

	impl DisposableScheme {
		fn new() -> (Self, Context) {
			let unique = format!(
				"{}-{}-{}",
				std::process::id(),
				SystemTime::now()
					.duration_since(UNIX_EPOCH)
					.unwrap()
					.as_nanos(),
				TEST_SEQUENCE.fetch_add(1, Ordering::Relaxed)
			);
			let scheme = format!("omp-oauth-test-{unique}");
			let directory = std::env::temp_dir().join(format!("omp oauth callback {unique}"));
			fs::create_dir_all(&directory).unwrap();
			let context = Context::new(
				directory.clone(),
				directory.clone(),
				scheme.clone(),
				"0123456789abcdef0123456789abcdef".to_owned(),
				BTreeMap::new(),
				CancelToken::default(),
			);
			fs::copy(std::env::current_exe().unwrap(), &context.helper_path).unwrap();
			(Self { scheme, directory }, context)
		}
	}

	impl Drop for DisposableScheme {
		fn drop(&mut self) {
			let _ = HKCU.delete_subkey_all(format!("Software\\Classes\\{}", self.scheme));
			let _ = fs::remove_dir_all(&self.directory);
		}
	}

	fn untouched_snapshot(context: &Context) -> Snapshot {
		let layout = Layout::new(&context.scheme);
		Snapshot {
			version:   SNAPSHOT_VERSION,
			scheme:    context.scheme.clone(),
			root_path: layout.root,
			id:        context.id.clone(),
			keys:      layout
				.paths
				.into_iter()
				.map(|path| KeySnapshot { path, present: false })
				.collect(),
			values:    layout
				.values
				.into_iter()
				.map(|(path, name)| ValueSnapshot { path, name, value: None })
				.collect(),
		}
	}

	#[test]
	fn command_quotes_native_paths_and_url_as_data() {
		let helper = Path::new(r#"C:\Program Files\omp\callback "helper".exe"#);
		let callback = Path::new(r"C:\OAuth callbacks\pending\");
		let command = relay_command(helper, callback).unwrap();
		assert_eq!(
			command,
			OsString::from(
				r#""C:\Program Files\omp\callback \"helper\".exe" "C:\OAuth callbacks\pending\\" "%1""#
			)
		);
	}

	#[test]
	fn command_preserves_non_utf8_windows_path_units() {
		let helper = std::path::PathBuf::from(OsString::from_wide(&[
			b'C' as u16,
			b':' as u16,
			b'\\' as u16,
			0xd800,
			b'.' as u16,
			b'e' as u16,
			b'x' as u16,
			b'e' as u16,
		]));
		let command = relay_command(&helper, Path::new(r"C:\callback.url")).unwrap();
		assert!(command.encode_wide().any(|unit| unit == 0xd800));
	}

	#[test]
	fn snapshot_validation_rejects_other_registry_paths_and_nonces() {
		let (_guard, context) = DisposableScheme::new();
		let mut snapshot = untouched_snapshot(&context);
		snapshot.values[0].path = "Software\\Classes\\another-scheme".to_owned();
		assert!(validate_snapshot(&context, &snapshot).is_err());
		snapshot.values[0].path = snapshot.root_path.clone();
		snapshot.id = "ffffffffffffffffffffffffffffffff".to_owned();
		assert!(validate_snapshot(&context, &snapshot).is_err());
	}

	#[test]
	fn registration_restores_raw_values_and_keeps_unrelated_values() {
		let (_guard, context) = DisposableScheme::new();
		let layout = Layout::new(&context.scheme);
		let prior =
			RawValue { value_type: REG_BINARY.clone() as u32, bytes: vec![0, 0xff, 7, 3] };
		write_value(&layout.root, DEFAULT_VALUE, &prior).unwrap();
		let unrelated = reg_sz(OsStr::new("leave me"));
		write_value(&layout.root, "Unrelated", &unrelated).unwrap();

		let snapshot = prepare(&context).unwrap();
		activate(&context, &snapshot).unwrap();
		restore(&context, &snapshot).unwrap();

		assert_eq!(read_value(&layout.root, DEFAULT_VALUE).unwrap(), Some(prior));
		assert_eq!(read_value(&layout.root, "Unrelated").unwrap(), Some(unrelated));
		assert_eq!(read_value(&layout.root, "URL Protocol").unwrap(), None);
		assert_eq!(read_value(&layout.root, MARKER_NAME).unwrap(), None);
	}

	#[test]
	fn recovery_preserves_external_command_and_retains_ownership_marker() {
		let (_guard, context) = DisposableScheme::new();
		let layout = Layout::new(&context.scheme);
		let snapshot = prepare(&context).unwrap();
		activate(&context, &snapshot).unwrap();
		let external = reg_sz(OsStr::new(r#""C:\Other App\other.exe" "%1""#));
		write_value(&layout.paths[3], DEFAULT_VALUE, &external).unwrap();

		let error = restore(&context, &snapshot).unwrap_err().to_string();
		assert!(error.contains("externally changed"));
		assert_eq!(read_value(&layout.paths[3], DEFAULT_VALUE).unwrap(), Some(external));
		assert_eq!(read_value(&layout.root, MARKER_NAME).unwrap(), Some(marker_value(&context.id)));
	}

	#[test]
	fn recovery_rolls_back_an_activation_that_only_installed_its_nonce() {
		let (_guard, context) = DisposableScheme::new();
		let layout = Layout::new(&context.scheme);
		let snapshot = prepare(&context).unwrap();
		write_value(&layout.root, MARKER_NAME, &marker_value(&context.id)).unwrap();

		restore(&context, &snapshot).unwrap();

		assert!(!key_exists(&layout.root).unwrap());
	}
}
