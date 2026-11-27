//! The environment a PTY child starts with: this process's (on Windows with
//! the registry's system and then user variables over it), the caller's
//! overrides on top.

use std::ffi::{OsStr, OsString};

/// A child environment, each variable present once.
pub(super) struct Env(Vec<(OsString, OsString)>);

impl Env {
	/// This process's environment, as a terminal program inherits it.
	pub(super) fn inherited() -> Self {
		#[cfg(unix)]
		let vars = std::env::vars_os().collect();
		#[cfg(windows)]
		let vars = registry::base_environment();
		Self(vars)
	}

	/// The variables, as `execve` or `CreateProcessW` takes them.
	pub(super) fn entries(&self) -> &[(OsString, OsString)] {
		&self.0
	}

	/// The value of `key`.
	pub(super) fn get(&self, key: &str) -> Option<&OsStr> {
		self
			.0
			.iter()
			.find(|(name, _)| same_name(name, key))
			.map(|(_, value)| value.as_os_str())
	}

	/// Sets `key` to `value`, replacing the variable of that name and taking
	/// `key`'s spelling.
	pub(super) fn set(&mut self, key: &str, value: &str) {
		if let Some((name, previous)) = self.0.iter_mut().find(|(name, _)| same_name(name, key)) {
			if name != key {
				OsStr::new(key).clone_into(name);
			}
			OsStr::new(value).clone_into(previous);
		} else {
			self.0.push((key.into(), value.into()));
		}
	}

	/// Removes every variable named in `keys`.
	pub(super) fn remove(&mut self, keys: &[&str]) {
		self
			.0
			.retain(|(name, _)| !keys.iter().any(|key| same_name(name, key)));
	}
}

/// Whether variable `name` is `key`: exactly on Unix, without case on
/// Windows.
fn same_name(name: &OsStr, key: &str) -> bool {
	#[cfg(windows)]
	{
		if name.as_encoded_bytes().is_ascii() && key.is_ascii() {
			return name.eq_ignore_ascii_case(key);
		}
		fold(name) == fold(OsStr::new(key))
	}
	#[cfg(unix)]
	{
		name == key
	}
}

/// Variable name `name` as Windows compares names: lowercase when it is
/// Unicode, else as it is.
#[cfg(windows)]
pub(super) fn fold(name: &OsStr) -> OsString {
	name
		.to_str()
		.map_or_else(|| name.to_owned(), |name| name.to_lowercase().into())
}

/// The environment a Windows program inherits from the system: the registry's
/// variables over this process's, as Explorer would start it.
#[cfg(windows)]
mod registry {
	use std::{collections::BTreeMap, ffi::OsString, os::windows::ffi::OsStringExt as _, ptr};

	use windows_sys::{
		Win32::{
			Foundation::{ERROR_MORE_DATA, ERROR_SUCCESS},
			System::{
				Environment::ExpandEnvironmentStringsW,
				Registry::{
					HKEY, HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE, KEY_READ, REG_EXPAND_SZ, REG_MULTI_SZ,
					REG_SZ, RegCloseKey, RegEnumValueW, RegOpenKeyExW,
				},
			},
		},
		core::{PCWSTR, w},
	};

	use super::fold;

	/// This process's variables with the machine's and then the user's
	/// registry settings over them (the user's `Path` after the machine's),
	/// each in the spelling set last.
	pub(super) fn base_environment() -> Vec<(OsString, OsString)> {
		let mut env: BTreeMap<_, _> = std::env::vars_os()
			.map(|(name, value)| (fold(&name), (name, value)))
			.collect();
		registry_vars(
			HKEY_LOCAL_MACHINE,
			w!("System\\CurrentControlSet\\Control\\Session Manager\\Environment"),
			|name, value| {
				// The machine's USERNAME is SYSTEM, not the current user.
				if !name.eq_ignore_ascii_case("USERNAME") {
					env.insert(fold(&name), (name, value));
				}
			},
		);
		registry_vars(HKEY_CURRENT_USER, w!("Environment"), |name, value| {
			let key = fold(&name);
			if name.eq_ignore_ascii_case("PATH")
				&& let Some((spelling, path)) = env.get_mut(&key)
			{
				*spelling = name;
				path.push(";");
				path.push(value);
			} else {
				env.insert(key, (name, value));
			}
		});
		env.into_values().collect()
	}

	/// Visits the string values of registry key `path` under `root`, without
	/// their trailing NULs; `REG_EXPAND_SZ` references are expanded against
	/// this process's environment.
	fn registry_vars(root: HKEY, path: PCWSTR, mut visit: impl FnMut(OsString, OsString)) {
		let mut key: HKEY = ptr::null_mut();
		// SAFETY: a predefined root, a NUL-terminated path and an out-parameter.
		if unsafe { RegOpenKeyExW(root, path, 0, KEY_READ, &raw mut key) } != ERROR_SUCCESS {
			return;
		}
		let (mut name, mut data) = (vec![0_u16; 2048], vec![0_u16; 1024]);
		let mut index = 0;
		loop {
			let mut name_len = u32::try_from(name.len()).unwrap_or(u32::MAX);
			// Reserve a NUL beyond the data: even REG_EXPAND_SZ may lack one.
			let mut bytes = u32::try_from((data.len() - 1) * 2).unwrap_or(u32::MAX);
			let mut kind = 0;
			// SAFETY: an open key, buffers of the lengths given and
			// out-parameters.
			let status = unsafe {
				RegEnumValueW(
					key,
					index,
					name.as_mut_ptr(),
					&raw mut name_len,
					ptr::null(),
					&raw mut kind,
					data.as_mut_ptr().cast(),
					&raw mut bytes,
				)
			};
			match status {
				ERROR_SUCCESS => {},
				// Names run to 16383 characters; `bytes` is the data's size.
				ERROR_MORE_DATA => {
					name.resize(16_384, 0);
					data.resize((bytes as usize).div_ceil(2) + 1, 0);
					continue;
				},
				_ => break,
			}
			index += 1;
			let end = bytes as usize / 2;
			let value = match kind {
				REG_EXPAND_SZ => {
					data[end] = 0;
					let Some(value) = expand(&data[..=end]) else {
						continue;
					};
					value
				},
				REG_SZ | REG_MULTI_SZ => OsString::from_wide(trim_nuls(&data[..end])),
				_ => continue,
			};
			visit(OsString::from_wide(&name[..name_len as usize]), value);
		}
		// SAFETY: opened above, closed once.
		unsafe { RegCloseKey(key) };
	}

	/// NUL-terminated `text` with its `%NAME%` references replaced from this
	/// process's environment.
	fn expand(text: &[u16]) -> Option<OsString> {
		let mut expanded = vec![0_u16; text.len()];
		loop {
			let room = u32::try_from(expanded.len()).ok()?;
			// SAFETY: a NUL-terminated source and a buffer of `room` units.
			let needed =
				unsafe { ExpandEnvironmentStringsW(text.as_ptr(), expanded.as_mut_ptr(), room) };
			if needed == 0 {
				return None;
			}
			if needed <= room {
				return Some(OsString::from_wide(&expanded[..needed as usize - 1]));
			}
			expanded.resize(needed as usize, 0);
		}
	}

	/// `words` without its trailing NULs.
	const fn trim_nuls(mut words: &[u16]) -> &[u16] {
		while let [rest @ .., 0] = words {
			words = rest;
		}
		words
	}
}
