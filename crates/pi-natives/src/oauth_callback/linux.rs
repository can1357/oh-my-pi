use std::{
	collections::BTreeSet,
	fs,
	os::unix::fs::PermissionsExt,
	path::{Component, Path, PathBuf},
};

use anyhow::{Context as _, bail};
use serde::{Deserialize, Serialize};

use super::context::{Context, atomic_write};

const SNAPSHOT_VERSION: u32 = 1;
const DESKTOP_ID_PREFIX: &str = "dev.omp.oauth-callback.";
const DESKTOP_SOURCE_NAME: &str = "linux-callback.desktop";
const DEFAULT_APPLICATIONS_SECTION: &str = "Default Applications";
const DEFAULT_APPLICATIONS_HEADER: &str = "[Default Applications]";
const XDG_MIME: &str = "xdg-mime";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct DefaultEntry {
	present: bool,
	value:   String,
}

#[derive(Debug)]
struct PreferenceState {
	content:                 String,
	default_section_present: bool,
	entry:                   DefaultEntry,
	exists:                  bool,
	mode:                    u32,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum FileOwnership {
	Missing,
	Ours,
	Other,
}

/// State required to safely reverse a Linux user MIME registration.
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Snapshot {
	version: u32,
	id: String,
	scheme: String,
	mime_type: String,
	config_home: PathBuf,
	data_home: PathBuf,
	applications_directory: PathBuf,
	preference_path: PathBuf,
	desktop_id: String,
	desktop_path: PathBuf,
	desktop_source_path: PathBuf,
	callback_path: PathBuf,
	helper_path: PathBuf,
	preference_file_existed: bool,
	preference_ended_with_newline: bool,
	default_section_existed: bool,
	original_default: DefaultEntry,
	original_effective: String,
}

struct ExpectedPaths {
	mime_type:              String,
	config_home:            PathBuf,
	data_home:              PathBuf,
	applications_directory: PathBuf,
	preference_path:        PathBuf,
	desktop_id:             String,
	desktop_path:           PathBuf,
	desktop_source_path:    PathBuf,
	callback_path:          PathBuf,
	helper_path:            PathBuf,
}

fn has_only_normal_absolute_components(path: &Path) -> bool {
	path.is_absolute()
		&& path
			.components()
			.all(|component| matches!(component, Component::RootDir | Component::Normal(_)))
}

fn validate_context(context: &Context) -> anyhow::Result<()> {
	if context.id.len() != 32
		|| !context
			.id
			.bytes()
			.all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
	{
		bail!("invalid Linux OAuth callback transaction identifier");
	}
	let mut scheme = context.scheme.bytes();
	if !scheme.next().is_some_and(|byte| byte.is_ascii_lowercase())
		|| !scheme.all(|byte| {
			byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'+' | b'.' | b'-')
		}) {
		bail!("invalid Linux OAuth callback scheme");
	}
	if !has_only_normal_absolute_components(&context.home) || context.home.parent().is_none() {
		bail!("Linux OAuth callback HOME must be an absolute user directory");
	}
	if !has_only_normal_absolute_components(&context.directory)
		|| context.directory.parent().is_none()
	{
		bail!("Linux OAuth callback directory must be an absolute directory");
	}
	if context.callback_path != context.directory.join("callback.url")
		|| context.helper_path != context.directory.join("callback-helper")
	{
		bail!("Linux OAuth callback files must use the private transaction directory");
	}
	Ok(())
}

fn xdg_home(context: &Context, variable: &str, fallback: &Path) -> anyhow::Result<PathBuf> {
	let configured = context
		.env
		.get(variable)
		.map(|value| value.trim())
		.filter(|value| !value.is_empty());
	let path = configured.map_or_else(|| context.home.join(fallback), PathBuf::from);
	if !has_only_normal_absolute_components(&path) || path.parent().is_none() {
		bail!("{variable} must be an absolute directory");
	}
	Ok(path)
}

fn desktop_names(context: &Context) -> Vec<String> {
	let mut seen = BTreeSet::new();
	context
		.env
		.get("XDG_CURRENT_DESKTOP")
		.map(String::as_str)
		.unwrap_or_default()
		.split(':')
		.filter_map(|raw| {
			let name = raw.trim().to_ascii_lowercase();
			if name.is_empty()
				|| !name.bytes().all(|byte| {
					byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'_' | b'-')
				}) || !seen.insert(name.clone())
			{
				None
			} else {
				Some(name)
			}
		})
		.collect()
}

fn expected_paths(context: &Context) -> anyhow::Result<ExpectedPaths> {
	validate_context(context)?;
	let config_home = xdg_home(context, "XDG_CONFIG_HOME", Path::new(".config"))?;
	let data_home = xdg_home(context, "XDG_DATA_HOME", Path::new(".local/share"))?;
	let applications_directory = data_home.join("applications");
	let desktop_id = format!("{DESKTOP_ID_PREFIX}{}.desktop", context.id);
	let preference_name = desktop_names(context)
		.first()
		.map_or_else(|| "mimeapps.list".to_owned(), |desktop| format!("{desktop}-mimeapps.list"));
	let preference_path = config_home.join(preference_name);
	Ok(ExpectedPaths {
		mime_type: format!("x-scheme-handler/{}", context.scheme),
		config_home,
		data_home,
		applications_directory: applications_directory.clone(),
		preference_path,
		desktop_path: applications_directory.join(&desktop_id),
		desktop_id,
		desktop_source_path: context.directory.join(DESKTOP_SOURCE_NAME),
		callback_path: context.callback_path.clone(),
		helper_path: context.helper_path.clone(),
	})
}

fn parse_default_entry(content: &str, mime_type: &str) -> anyhow::Result<(bool, DefaultEntry)> {
	let mut in_defaults = false;
	let mut default_section_present = false;
	let mut value = None;
	for raw_line in content.split('\n') {
		let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
		let trimmed = line.trim();
		if let Some(section) = trimmed
			.strip_prefix('[')
			.and_then(|value| value.strip_suffix(']'))
		{
			in_defaults = section == DEFAULT_APPLICATIONS_SECTION;
			default_section_present |= in_defaults;
			continue;
		}
		if !in_defaults || trimmed.starts_with('#') || trimmed.starts_with(';') {
			continue;
		}
		let Some((key, candidate)) = line.split_once('=') else {
			continue;
		};
		if key.trim() != mime_type {
			continue;
		}
		if value.is_some() {
			bail!("ambiguous duplicate {mime_type} defaults");
		}
		value = Some(candidate.trim().to_owned());
	}
	Ok((
		default_section_present,
		value.map_or_else(
			|| DefaultEntry { present: false, value: String::new() },
			|value| DefaultEntry { present: true, value },
		),
	))
}

fn read_preference(path: &Path, mime_type: &str) -> anyhow::Result<PreferenceState> {
	match fs::read_to_string(path) {
		Ok(content) => {
			let mode = fs::metadata(path)
				.with_context(|| format!("failed to stat {}", path.display()))?
				.permissions()
				.mode() & 0o777;
			let (default_section_present, entry) = parse_default_entry(&content, mime_type)?;
			Ok(PreferenceState { content, default_section_present, entry, exists: true, mode })
		},
		Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(PreferenceState {
			content:                 String::new(),
			default_section_present: false,
			entry:                   DefaultEntry { present: false, value: String::new() },
			exists:                  false,
			mode:                    0o600,
		}),
		Err(error) => Err(error).with_context(|| format!("failed to read {}", path.display())),
	}
}

fn change_default(
	content: &str,
	mime_type: &str,
	desired: &DefaultEntry,
) -> anyhow::Result<String> {
	let newline = if content.contains("\r\n") {
		"\r\n"
	} else {
		"\n"
	};
	let carriage = if newline == "\r\n" { "\r" } else { "" };
	let mut lines: Vec<String> = content.split('\n').map(ToOwned::to_owned).collect();
	let mut section_start = None;
	let mut section_end = lines.len();
	let mut entry_index = None;
	let mut in_defaults = false;

	for (index, raw_line) in lines.iter().enumerate() {
		let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
		let trimmed = line.trim();
		if let Some(section) = trimmed
			.strip_prefix('[')
			.and_then(|value| value.strip_suffix(']'))
		{
			if in_defaults && section_end == lines.len() {
				section_end = index;
			}
			in_defaults = section == DEFAULT_APPLICATIONS_SECTION;
			if in_defaults && section_start.is_none() {
				section_start = Some(index);
			}
			continue;
		}
		if !in_defaults || trimmed.starts_with('#') || trimmed.starts_with(';') {
			continue;
		}
		let Some((key, _)) = line.split_once('=') else {
			continue;
		};
		if key.trim() == mime_type {
			if entry_index.replace(index).is_some() {
				bail!("ambiguous duplicate {mime_type} defaults");
			}
		}
	}

	if !desired.present {
		if let Some(index) = entry_index {
			lines.remove(index);
		}
		return Ok(lines.join("\n"));
	}

	let replacement = format!("{mime_type}={}{carriage}", desired.value);
	if let Some(index) = entry_index {
		lines[index] = replacement;
		return Ok(lines.join("\n"));
	}
	if section_start.is_some() {
		if section_end == lines.len() && lines.last().is_some_and(String::is_empty) {
			section_end -= 1;
		}
		lines.insert(section_end, replacement);
		return Ok(lines.join("\n"));
	}

	let mut result = content.to_owned();
	if !result.is_empty() && !result.ends_with('\n') {
		result.push_str(newline);
	}
	let has_blank_separator = if newline == "\r\n" {
		result.ends_with("\r\n\r\n")
	} else {
		result.ends_with("\n\n")
	};
	if !result.is_empty() && !has_blank_separator {
		result.push_str(newline);
	}
	result.push_str(&format!(
		"[{DEFAULT_APPLICATIONS_SECTION}]{newline}{mime_type}={}{newline}",
		desired.value
	));
	Ok(result)
}

fn default_section_ordinal_for_entry(content: &str, mime_type: &str) -> Option<usize> {
	let mut current_ordinal = None;
	let mut next_ordinal = 0;
	for raw_line in content.split('\n') {
		let line = raw_line.strip_suffix('\r').unwrap_or(raw_line);
		let trimmed = line.trim();
		if let Some(section) = trimmed
			.strip_prefix('[')
			.and_then(|value| value.strip_suffix(']'))
		{
			if section == DEFAULT_APPLICATIONS_SECTION {
				current_ordinal = Some(next_ordinal);
				next_ordinal += 1;
			} else {
				current_ordinal = None;
			}
			continue;
		}
		if current_ordinal.is_some()
			&& !trimmed.starts_with('#')
			&& !trimmed.starts_with(';')
			&& line
				.split_once('=')
				.is_some_and(|(key, _)| key.trim() == mime_type)
		{
			return current_ordinal;
		}
	}
	None
}

fn remove_generated_empty_section(
	content_before: &str,
	content_after: &str,
	mime_type: &str,
	restore_trailing_newline: bool,
) -> String {
	let Some(target_ordinal) = default_section_ordinal_for_entry(content_before, mime_type) else {
		return content_after.to_owned();
	};
	let mut lines: Vec<String> = content_after.split('\n').map(ToOwned::to_owned).collect();
	let mut ordinal = 0;
	for index in 0..lines.len() {
		let line = lines[index].strip_suffix('\r').unwrap_or(&lines[index]);
		if line.trim() != DEFAULT_APPLICATIONS_HEADER {
			continue;
		}
		if ordinal != target_ordinal {
			ordinal += 1;
			continue;
		}
		let mut end = index + 1;
		while end < lines.len() {
			let candidate = lines[end].strip_suffix('\r').unwrap_or(&lines[end]);
			if candidate.trim().starts_with('[') && candidate.trim().ends_with(']') {
				break;
			}
			if !candidate.trim().is_empty() {
				return content_after.to_owned();
			}
			end += 1;
		}
		let start = if index > 0 && lines[index - 1].trim().is_empty() {
			index - 1
		} else {
			index
		};
		lines.drain(start..end);
		let mut restored = lines.join("\n");
		if restore_trailing_newline && !restored.is_empty() && !restored.ends_with('\n') {
			restored.push_str(if content_after.contains("\r\n") {
				"\r\n"
			} else {
				"\n"
			});
		}
		return restored;
	}
	content_after.to_owned()
}

fn contains_invalid_text(value: &str) -> bool {
	value
		.chars()
		.any(|character| matches!(character, '\n' | '\r' | '\0'))
}

fn desktop_exec_argument(value: &Path) -> anyhow::Result<String> {
	let value = value
		.to_str()
		.context("Linux OAuth callback path is not valid UTF-8")?;
	if contains_invalid_text(value) {
		bail!("Linux OAuth callback path contains an invalid character");
	}
	let mut escaped = String::with_capacity(value.len() + 2);
	escaped.push('"');
	for character in value.chars() {
		match character {
			'\\' | '"' | '`' | '$' => {
				escaped.push('\\');
				escaped.push(character);
			},
			'%' => escaped.push_str("%%"),
			_ => escaped.push(character),
		}
	}
	escaped.push('"');
	Ok(escaped)
}

fn desktop_file(snapshot: &Snapshot) -> anyhow::Result<String> {
	Ok([
		"[Desktop Entry]".to_owned(),
		"Type=Application".to_owned(),
		"Name=omp OAuth Callback".to_owned(),
		"NoDisplay=true".to_owned(),
		"Terminal=false".to_owned(),
		format!(
			"Exec={} {} %u",
			desktop_exec_argument(&snapshot.helper_path)?,
			desktop_exec_argument(&snapshot.callback_path)?
		),
		format!("MimeType={};", snapshot.mime_type),
		"StartupNotify=false".to_owned(),
		String::new(),
	]
	.join("\n"))
}

fn validate_entry(entry: &DefaultEntry) -> bool {
	(entry.present || entry.value.is_empty()) && !contains_invalid_text(&entry.value)
}

fn validate_snapshot(context: &Context, snapshot: &Snapshot) -> anyhow::Result<()> {
	let expected = expected_paths(context)?;
	if snapshot.version != SNAPSHOT_VERSION
		|| snapshot.id != context.id
		|| snapshot.scheme != context.scheme
		|| snapshot.mime_type != expected.mime_type
		|| snapshot.config_home != expected.config_home
		|| snapshot.data_home != expected.data_home
		|| snapshot.applications_directory != expected.applications_directory
		|| snapshot.preference_path != expected.preference_path
		|| snapshot.desktop_id != expected.desktop_id
		|| snapshot.desktop_path != expected.desktop_path
		|| snapshot.desktop_source_path != expected.desktop_source_path
		|| snapshot.callback_path != expected.callback_path
		|| snapshot.helper_path != expected.helper_path
		|| !validate_entry(&snapshot.original_default)
		|| (!snapshot.preference_file_existed
			&& (snapshot.preference_ended_with_newline
				|| snapshot.default_section_existed
				|| snapshot.original_default.present))
		|| (snapshot.original_default.present && !snapshot.default_section_existed)
		|| contains_invalid_text(&snapshot.original_effective)
		|| snapshot.original_effective == snapshot.desktop_id
		|| (snapshot.original_default.present
			&& snapshot
				.original_default
				.value
				.split(';')
				.any(|id| id == snapshot.desktop_id))
	{
		bail!("invalid Linux OAuth callback recovery snapshot");
	}
	Ok(())
}

fn effective_default(context: &Context, mime_type: &str) -> anyhow::Result<String> {
	context.run(Path::new(XDG_MIME), &[
		"query".to_owned(),
		"default".to_owned(),
		mime_type.to_owned(),
	])
}

fn file_ownership(path: &Path, expected: &[u8]) -> anyhow::Result<FileOwnership> {
	match fs::read(path) {
		Ok(content) if content == expected => Ok(FileOwnership::Ours),
		Ok(_) => Ok(FileOwnership::Other),
		Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(FileOwnership::Missing),
		Err(error) => Err(error).with_context(|| format!("failed to read {}", path.display())),
	}
}

fn remove_if_exists(path: &Path) -> anyhow::Result<()> {
	match fs::remove_file(path) {
		Ok(()) => Ok(()),
		Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
		Err(error) => Err(error).with_context(|| format!("failed to remove {}", path.display())),
	}
}

/// Snapshot the current Linux handler state and create only private transaction
/// artifacts.
pub(super) fn prepare(context: &Context) -> anyhow::Result<Snapshot> {
	context.check()?;
	let expected = expected_paths(context)?;
	let preference = read_preference(&expected.preference_path, &expected.mime_type)?;
	let original_effective = effective_default(context, &expected.mime_type)?;
	if contains_invalid_text(&original_effective) {
		bail!("xdg-mime returned an invalid Linux OAuth callback handler");
	}
	let helper_metadata = fs::metadata(&expected.helper_path).with_context(|| {
		format!("Linux OAuth callback helper is missing at {}", expected.helper_path.display())
	})?;
	if !helper_metadata.is_file() {
		bail!("Linux OAuth callback helper is not a regular file");
	}
	let snapshot = Snapshot {
		version: SNAPSHOT_VERSION,
		id: context.id.clone(),
		scheme: context.scheme.clone(),
		mime_type: expected.mime_type,
		config_home: expected.config_home,
		data_home: expected.data_home,
		applications_directory: expected.applications_directory,
		preference_path: expected.preference_path,
		desktop_id: expected.desktop_id,
		desktop_path: expected.desktop_path,
		desktop_source_path: expected.desktop_source_path,
		callback_path: expected.callback_path,
		helper_path: expected.helper_path,
		preference_file_existed: preference.exists,
		preference_ended_with_newline: preference.content.ends_with('\n'),
		default_section_existed: preference.default_section_present,
		original_default: preference.entry,
		original_effective,
	};
	validate_snapshot(context, &snapshot)?;
	context.check()?;
	atomic_write(&snapshot.desktop_source_path, desktop_file(&snapshot)?.as_bytes(), 0o600)?;
	Ok(snapshot)
}

/// Install the prepared desktop entry and make it the effective scheme handler.
pub(super) fn activate(context: &Context, snapshot: &Snapshot) -> anyhow::Result<()> {
	context.check()?;
	validate_snapshot(context, snapshot)?;
	let expected_desktop = desktop_file(snapshot)?;
	if file_ownership(&snapshot.desktop_source_path, expected_desktop.as_bytes())?
		!= FileOwnership::Ours
	{
		bail!("Linux OAuth callback desktop entry is missing or was modified");
	}
	if !fs::metadata(&snapshot.helper_path).is_ok_and(|metadata| metadata.is_file()) {
		bail!("Linux OAuth callback helper is missing or invalid");
	}
	let preference = read_preference(&snapshot.preference_path, &snapshot.mime_type)?;
	let current_effective = effective_default(context, &snapshot.mime_type)?;
	if preference.entry != snapshot.original_default
		|| current_effective != snapshot.original_effective
	{
		bail!("Linux URL handler changed before activation; refusing to overwrite it");
	}

	match file_ownership(&snapshot.desktop_path, expected_desktop.as_bytes())? {
		FileOwnership::Other => {
			bail!("refusing to replace existing desktop entry {}", snapshot.desktop_path.display())
		},
		FileOwnership::Missing => {
			fs::create_dir_all(&snapshot.applications_directory).with_context(|| {
				format!("failed to create {}", snapshot.applications_directory.display())
			})?;
			context.check()?;
			atomic_write(&snapshot.desktop_path, expected_desktop.as_bytes(), 0o600)?;
		},
		FileOwnership::Ours => {},
	}

	let owned_default = DefaultEntry { present: true, value: format!("{};", snapshot.desktop_id) };
	fs::create_dir_all(&snapshot.config_home)
		.with_context(|| format!("failed to create {}", snapshot.config_home.display()))?;
	let changed = change_default(&preference.content, &snapshot.mime_type, &owned_default)?;
	context.check()?;
	atomic_write(&snapshot.preference_path, changed.as_bytes(), preference.mode)?;
	if effective_default(context, &snapshot.mime_type)? != snapshot.desktop_id {
		bail!("Linux desktop did not activate {} for {}", snapshot.desktop_id, snapshot.mime_type);
	}
	Ok(())
}

/// Remove only registrations still owned by this transaction and restore its
/// prior entry.
pub(super) fn restore(context: &Context, snapshot: &Snapshot) -> anyhow::Result<()> {
	context.check()?;
	validate_snapshot(context, snapshot)?;
	let expected_desktop = desktop_file(snapshot)?;
	let installed = file_ownership(&snapshot.desktop_path, expected_desktop.as_bytes())?;
	let preference = read_preference(&snapshot.preference_path, &snapshot.mime_type)?;
	let owned_default = DefaultEntry { present: true, value: format!("{};", snapshot.desktop_id) };
	let setting_is_ours = preference.entry == owned_default;
	let effective = effective_default(context, &snapshot.mime_type)?;

	if setting_is_ours && installed != FileOwnership::Ours {
		bail!("Linux OAuth callback owned desktop entry was removed or modified");
	}
	if setting_is_ours && effective != snapshot.desktop_id {
		bail!("Linux OAuth callback ownership is uncertain; refusing to overwrite current settings");
	}
	if !setting_is_ours && effective == snapshot.desktop_id {
		bail!("Linux OAuth callback remains effective through an unknown preference entry");
	}

	if setting_is_ours {
		let mut restored =
			change_default(&preference.content, &snapshot.mime_type, &snapshot.original_default)?;
		if !snapshot.default_section_existed && !snapshot.original_default.present {
			restored = remove_generated_empty_section(
				&preference.content,
				&restored,
				&snapshot.mime_type,
				snapshot.preference_ended_with_newline,
			);
		}
		if !snapshot.preference_file_existed && restored.trim().is_empty() {
			remove_if_exists(&snapshot.preference_path)?;
		} else {
			fs::create_dir_all(&snapshot.config_home)
				.with_context(|| format!("failed to create {}", snapshot.config_home.display()))?;
			context.check()?;
			atomic_write(&snapshot.preference_path, restored.as_bytes(), preference.mode)?;
		}
	}

	if effective_default(context, &snapshot.mime_type)? == snapshot.desktop_id {
		bail!("Linux OAuth callback handler remained active after preference restoration");
	}
	if installed == FileOwnership::Ours {
		context.check()?;
		remove_if_exists(&snapshot.desktop_path)?;
	}
	if effective_default(context, &snapshot.mime_type)? == snapshot.desktop_id {
		bail!("Linux OAuth callback handler remained active after desktop cleanup");
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use std::{
		collections::BTreeMap,
		sync::{
			Arc,
			atomic::{AtomicU64, Ordering},
		},
	};

	use super::*;
	use crate::task::CancelToken;

	static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

	struct TempDir(PathBuf);

	impl TempDir {
		fn new() -> Self {
			let serial = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
			let path = std::env::temp_dir()
				.join(format!("pi-native-linux-oauth-{}-{serial}", std::process::id()));
			let _ = fs::remove_dir_all(&path);
			fs::create_dir_all(&path).unwrap();
			Self(path)
		}
	}

	impl Drop for TempDir {
		fn drop(&mut self) {
			let _ = fs::remove_dir_all(&self.0);
		}
	}

	fn context(root: &TempDir, desktop: &str, inherited: &str) -> Context {
		let home = root.0.join("home");
		let directory = home.join("transaction");
		let config = home.join("xdg-config");
		let data = home.join("xdg-data");
		fs::create_dir_all(&directory).unwrap();
		fs::write(directory.join("callback-helper"), b"helper").unwrap();
		let mut env = BTreeMap::new();
		env.insert("XDG_CONFIG_HOME".to_owned(), config.to_string_lossy().into_owned());
		env.insert("XDG_DATA_HOME".to_owned(), data.to_string_lossy().into_owned());
		env.insert("XDG_CURRENT_DESKTOP".to_owned(), desktop.to_owned());
		let mut context = Context::new(
			home,
			directory,
			"omp-auth".to_owned(),
			"0123456789abcdef0123456789abcdef".to_owned(),
			env,
			CancelToken::default(),
		);
		let preference = config.join("kde-mimeapps.list");
		let inherited = inherited.to_owned();
		context.runner = Some(Arc::new(move |program, args| {
			assert_eq!(program, Path::new(XDG_MIME));
			assert_eq!(args.len(), 3);
			assert_eq!(args[0], "query");
			assert_eq!(args[1], "default");
			assert_eq!(args[2], "x-scheme-handler/omp-auth");
			let current = fs::read_to_string(&preference).unwrap_or_default();
			let (_, entry) = parse_default_entry(&current, "x-scheme-handler/omp-auth")?;
			Ok(if entry.present {
				entry.value.split(';').next().unwrap_or_default().to_owned()
			} else {
				inherited.clone()
			})
		}));
		context
	}

	#[test]
	fn edits_only_target_default_and_preserves_crlf() {
		let original = "[Default Applications]\r\ntext/plain=editor.desktop;\r\nx-scheme-handler/\
		                test=old.desktop;\r\n\r\n[Added \
		                Associations]\r\nimage/png=viewer.desktop;\r\n";
		let desired = DefaultEntry { present: true, value: "new.desktop;".to_owned() };
		let changed = change_default(original, "x-scheme-handler/test", &desired).unwrap();
		assert!(changed.contains("text/plain=editor.desktop;\r\n"));
		assert!(changed.contains("x-scheme-handler/test=new.desktop;\r\n"));
		assert!(changed.contains("image/png=viewer.desktop;\r\n"));
		assert_eq!(
			parse_default_entry(&changed, "x-scheme-handler/test")
				.unwrap()
				.1,
			desired
		);
	}

	#[test]
	fn removes_only_the_generated_default_section_that_owned_the_entry() {
		let before = "[Default Applications]\ntext/plain=editor.desktop;\n\n[Other]\nkey=value\n\\
		              n[Default Applications]\nx-scheme-handler/test=owned.desktop;\n";
		let without_entry = change_default(before, "x-scheme-handler/test", &DefaultEntry {
			present: false,
			value:   String::new(),
		})
		.unwrap();
		let restored =
			remove_generated_empty_section(before, &without_entry, "x-scheme-handler/test", true);
		assert_eq!(
			restored,
			"[Default Applications]\ntext/plain=editor.desktop;\n\n[Other]\nkey=value\n"
		);
	}

	#[test]
	fn rejects_ambiguous_duplicate_defaults() {
		let content = "[Default Applications]\nx-scheme-handler/test=a.desktop;\nx-scheme-handler/\
		               test=b.desktop;\n";
		assert!(parse_default_entry(content, "x-scheme-handler/test").is_err());
		assert!(
			change_default(content, "x-scheme-handler/test", &DefaultEntry {
				present: false,
				value:   String::new(),
			})
			.is_err()
		);
	}

	#[test]
	fn chooses_first_valid_current_desktop_for_highest_user_precedence() {
		let root = TempDir::new();
		let context = context(&root, " INVALID! :KDE:GNOME:KDE", "inherited.desktop");
		let expected = expected_paths(&context).unwrap();
		assert_eq!(expected.preference_path, context.home.join("xdg-config/kde-mimeapps.list"));
		assert_eq!(expected.applications_directory, context.home.join("xdg-data/applications"));

		let no_desktop = context(&root, "", "inherited.desktop");
		assert_eq!(
			expected_paths(&no_desktop).unwrap().preference_path,
			no_desktop.home.join("xdg-config/mimeapps.list")
		);
	}

	#[test]
	fn accepts_absolute_xdg_locations_outside_home() {
		let root = TempDir::new();
		let mut context = context(&root, "KDE", "inherited.desktop");
		let config = root.0.join("external-config");
		let data = root.0.join("external-data");
		context
			.env
			.insert("XDG_CONFIG_HOME".to_owned(), config.to_string_lossy().into_owned());
		context
			.env
			.insert("XDG_DATA_HOME".to_owned(), data.to_string_lossy().into_owned());

		let expected = expected_paths(&context).unwrap();

		assert_eq!(expected.preference_path, config.join("kde-mimeapps.list"));
		assert_eq!(expected.applications_directory, data.join("applications"));
	}

	#[test]
	fn desktop_exec_escapes_literals_but_leaves_field_code_unquoted() {
		let root = TempDir::new();
		let context = context(&root, "KDE", "inherited.desktop");
		let preference = read_preference(
			&expected_paths(&context).unwrap().preference_path,
			"x-scheme-handler/omp-auth",
		)
		.unwrap();
		let mut snapshot = prepare(&context).unwrap();
		snapshot.helper_path = PathBuf::from("/tmp/a %/$`\\\" helper");
		snapshot.callback_path = PathBuf::from("/tmp/c %/$`\\\" dir/callback.url");
		let desktop = desktop_file(&snapshot).unwrap();
		assert!(
			desktop
				.lines()
				.find(|line| line.starts_with("Exec="))
				.unwrap()
				.ends_with(" %u")
		);
		assert!(!desktop.contains("\"%u\""));
		assert!(!desktop.contains("/bin/sh"));
		assert!(desktop.contains("%%"));
		assert!(!preference.exists);
	}

	#[test]
	fn activation_and_restore_preserve_unrelated_concurrent_edits() {
		let root = TempDir::new();
		let context = context(&root, "KDE:GNOME", "inherited.desktop");
		let preference_path = expected_paths(&context).unwrap().preference_path;
		fs::create_dir_all(preference_path.parent().unwrap()).unwrap();
		fs::write(
			&preference_path,
			"[Default Applications]\nx-scheme-handler/omp-auth=previous.desktop;\ntext/html=browser.\
			 desktop;\n",
		)
		.unwrap();
		let snapshot = prepare(&context).unwrap();
		activate(&context, &snapshot).unwrap();
		let mut preference = fs::read_to_string(&snapshot.preference_path).unwrap();
		preference.push_str("text/plain=external-editor.desktop;\n");
		fs::write(&snapshot.preference_path, preference).unwrap();
		restore(&context, &snapshot).unwrap();

		let restored = fs::read_to_string(&snapshot.preference_path).unwrap();
		assert!(restored.contains("x-scheme-handler/omp-auth=previous.desktop;"));
		assert!(restored.contains("text/html=browser.desktop;"));
		assert!(restored.contains("text/plain=external-editor.desktop;"));
		assert!(!restored.contains(&snapshot.desktop_id));
		assert!(!snapshot.desktop_path.exists());
	}

	#[test]
	fn restore_preserves_external_scheme_choice() {
		let root = TempDir::new();
		let context = context(&root, "KDE", "inherited.desktop");
		let snapshot = prepare(&context).unwrap();
		activate(&context, &snapshot).unwrap();
		let current = fs::read_to_string(&snapshot.preference_path).unwrap();
		let external = change_default(&current, &snapshot.mime_type, &DefaultEntry {
			present: true,
			value:   "external.desktop;".to_owned(),
		})
		.unwrap();
		fs::write(&snapshot.preference_path, external).unwrap();
		restore(&context, &snapshot).unwrap();

		let restored = fs::read_to_string(&snapshot.preference_path).unwrap();
		assert!(restored.contains("x-scheme-handler/omp-auth=external.desktop;"));
		assert!(!snapshot.desktop_path.exists());
	}

	#[test]
	fn restore_rejects_a_modified_owned_desktop_entry() {
		let root = TempDir::new();
		let context = context(&root, "KDE", "inherited.desktop");
		let snapshot = prepare(&context).unwrap();
		activate(&context, &snapshot).unwrap();
		fs::write(&snapshot.desktop_path, b"externally modified").unwrap();
		assert!(restore(&context, &snapshot).is_err());
		assert!(snapshot.preference_path.exists());
	}

	#[test]
	fn restoration_returns_to_inherited_default_and_removes_generated_file() {
		let root = TempDir::new();
		let context = context(&root, "KDE", "inherited.desktop");
		let snapshot = prepare(&context).unwrap();
		assert!(!snapshot.preference_file_existed);
		assert_eq!(snapshot.original_effective, "inherited.desktop");
		activate(&context, &snapshot).unwrap();
		restore(&context, &snapshot).unwrap();
		assert!(!snapshot.preference_path.exists());
		assert_eq!(effective_default(&context, &snapshot.mime_type).unwrap(), "inherited.desktop");
	}

	#[test]
	fn snapshot_validation_rejects_unrelated_paths() {
		let root = TempDir::new();
		let context = context(&root, "KDE", "inherited.desktop");
		let mut snapshot = prepare(&context).unwrap();
		snapshot.desktop_path = context.home.join("unrelated.desktop");
		assert!(validate_snapshot(&context, &snapshot).is_err());
	}
}
