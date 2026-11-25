//! Native path, filesystem, and filehandle modules (their module PODs and `perlfunc`).

mod glob;
mod handles;
mod paths;
mod temp;
mod transfer;
mod trees;

use std::{borrow::Cow, ffi::OsStr, io, path::Path};

use super::{Interp, PResult, Ret, Value, export_tag, isa};
use crate::perl::value::{HKey, Hv, PStr};

pub(super) use glob::GlobState;

/// Install one of the filesystem-related core modules.
pub(super) fn load(interp: &mut Interp<'_>, module: &str) -> PResult<()> {
	match module {
		"Cwd" | "FindBin" | "File::Basename" | "File::Spec" | "File::Spec::Unix"
		| "File::Spec::Functions" => paths::load(interp, module),
		"File::Path" | "File::Find" => trees::load(interp, module),
		"File::Temp" => temp::load(interp),
		"File::Copy" | "File::Compare" | "File::stat" => transfer::load(interp, module),
		"File::Glob" => glob::load(interp, module),
		_ => handles::load(interp, module),
	}
}

/// Register `Internals::getcwd`, which perl provides without loading Cwd.
pub(super) fn install_core(interp: &mut Interp<'_>) {
	interp.define_native("Internals::getcwd", paths::getcwd);
}

fn os(bytes: &[u8]) -> Cow<'_, OsStr> {
	#[cfg(unix)]
	{
		use std::os::unix::ffi::OsStrExt as _;
		Cow::Borrowed(OsStr::from_bytes(bytes))
	}
	#[cfg(not(unix))]
	{
		match String::from_utf8_lossy(bytes) {
			Cow::Borrowed(s) => Cow::Borrowed(OsStr::new(s)),
			Cow::Owned(s) => Cow::Owned(s.into()),
		}
	}
}

fn path_value(path: &Path) -> Value {
	Value::bytes(path.as_os_str().as_encoded_bytes())
}

fn cwd(interp: &Interp<'_>) -> std::path::PathBuf {
	interp.resolve_path(b".")
}

fn one(value: Value) -> PResult<Ret> {
	Ok(Ret::One(value))
}

fn failure(interp: &mut Interp<'_>, error: io::Error) -> PResult<Ret> {
	interp.set_errno(&error);
	one(Value::Undef)
}

fn option(interp: &mut Interp<'_>, hash: &Hv, name: &[u8]) -> PResult<Value> {
	let slot = hash.entries().get(&HKey::new(&PStr::from_bytes(name))).cloned();
	slot.map_or(Ok(Value::Undef), |sv| interp.read_sv(&sv))
}

fn env(interp: &mut Interp<'_>, name: &[u8]) -> PResult<PStr> {
	let hash = interp.hv("main::ENV");
	Ok(option(interp, &hash, name)?.to_pstr())
}
