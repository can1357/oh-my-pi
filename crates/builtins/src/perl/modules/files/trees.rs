//! Recursive filesystem changes and File::Find's dynamically scoped callbacks.

use std::{collections::HashSet, io, path::{Path, PathBuf}};

use omp_vfs::{DirOptions, FileId, Metadata, Permissions};

use super::{cwd, one, option, os, path_value};
use crate::perl::{
	func::sys::cache_stat,
	interp::{Cx, Flow, Interp, PResult, Ret},
	modules::{arg, define, export, list, version},
	value::{Cv, HKey, Hv, PStr, Ref, Sv, Value, new_av, new_hv, new_sv},
};

/// Install the recursive path or directory search API.
pub(super) fn load(interp: &mut Interp<'_>, module: &str) -> PResult<()> {
	if module == "File::Path" {
		version(interp, module, "2.18");
		define(interp, module, &[
			("mkpath", |i, a, c| path_operation(i, a, c, true, true)),
			("make_path", |i, a, c| path_operation(i, a, c, true, false)),
			("rmtree", |i, a, c| path_operation(i, a, c, false, true)),
			("remove_tree", |i, a, c| path_operation(i, a, c, false, false)),
		]);
		export(interp, module, &["mkpath", "rmtree"], &["make_path", "remove_tree"]);
	} else {
		version(interp, module, "1.39");
		define(interp, module, &[("find", |i, a, _| find(i, a, false)), ("finddepth", |i, a, _| find(i, a, true))]);
		export(interp, module, &["find", "finddepth"], &[]);
	}
	Ok(())
}

fn error_text(error: &io::Error) -> String {
	let mut text = error.to_string();
	if let Some(end) = text.rfind(" (os error ") { text.truncate(end); }
	text
}

#[derive(Default)]
struct PathOptions {
	verbose: bool,
	safe: bool,
	keep_root: bool,
	mode: u32,
	chmod: Option<u32>,
	uid: Option<u32>,
	gid: Option<u32>,
	errors: Option<Sv>,
	results: Option<Sv>,
}

impl PathOptions {
	fn from_hash(interp: &mut Interp<'_>, hash: &Hv, create: bool) -> PResult<Self> {
		let mut unknown: Vec<_> = hash.entries().keys().map(|key| key.to_pstr()).filter(|key| {
			!if create {
				matches!(key.bytes.as_slice(), b"verbose" | b"mode" | b"mask" | b"chmod" | b"error" | b"owner" | b"user" | b"uid" | b"group" | b"gid")
			} else { matches!(key.bytes.as_slice(), b"verbose" | b"safe" | b"keep_root" | b"error" | b"result") }
		}).collect();
		if !unknown.is_empty() {
			unknown.sort();
			let names: Vec<_> = unknown.iter().map(PStr::to_string_lossy).collect();
			let functions = if create { "mkpath() or make_path()" } else { "rmtree() or remove_tree()" };
			interp.warn(format!("Unrecognized option(s) passed to {functions}: {}", names.join(", ")));
		}
		let first = |interp: &mut Interp<'_>, names: &[&[u8]]| -> PResult<Value> {
			for name in names {
				let value = option(interp, hash, name)?;
				if !value.is_undef() { return Ok(value); }
			}
			Ok(Value::Undef)
		};
		let mode = first(interp, &[b"mode", b"mask"])?;
		let chmod = option(interp, hash, b"chmod")?;
		let uid = first(interp, &[b"owner", b"user", b"uid"])?;
		let gid = first(interp, &[b"group", b"gid"])?;
		let errors = option(interp, hash, b"error")?;
		let errors = path_destination(interp, errors)?;
		let results = if create {
			None
		} else {
			let value = option(interp, hash, b"result")?;
			path_destination(interp, value)?
		};
		Ok(Self {
			verbose: option(interp, hash, b"verbose")?.truthy(),
			safe: option(interp, hash, b"safe")?.truthy(),
			keep_root: option(interp, hash, b"keep_root")?.truthy(),
			mode: if mode.is_undef() { 0o777 } else { mode.to_i64() as u32 },
			chmod: (!chmod.is_undef()).then(|| chmod.to_i64() as u32),
			uid: identity(interp, &uid, true), gid: identity(interp, &gid, false), errors, results,
		})
	}
}

fn path_destination(interp: &mut Interp<'_>, value: Value) -> PResult<Option<Sv>> {
	match value {
		Value::Undef => Ok(None),
		Value::Ref(Ref::Scalar(cell)) => Ok(Some(cell)),
		_ => Err(interp.die_msg("Not a SCALAR reference")),
	}
}

fn identity(interp: &mut Interp<'_>, value: &Value, user: bool) -> Option<u32> {
	if value.is_undef() { return None; }
	let s = value.to_pstr();
	let name = s.to_string_lossy();
	if let Ok(id) = name.parse() { return Some(id); }
	#[cfg(unix)]
	{
		let id = if user { nix::unistd::User::from_name(&name).ok().flatten().map(|v| v.uid.as_raw()) }
		else { nix::unistd::Group::from_name(&name).ok().flatten().map(|v| v.gid.as_raw()) };
		if id.is_some() { return id; }
	}
	let (id, property) = if user { ("uid", "ownership") } else { ("gid", "group ownership") };
	interp.warn(format!("unable to map {name} to a {id}, {property} not changed: No such file or directory"));
	None
}

struct Change {
	options: PathOptions,
	errors: Vec<Value>,
	changed: Vec<Value>,
	count: i64,
}

impl Change {
	fn new(interp: &mut Interp<'_>, options: PathOptions) -> PResult<Self> {
		for slot in [&options.errors, &options.results].into_iter().flatten() {
			interp.write_sv(slot, Value::Ref(Ref::Array(new_av(Vec::new()))))?;
		}
		Ok(Self { options, errors: Vec::new(), changed: Vec::new(), count: 0 })
	}

	fn error(&mut self, interp: &mut Interp<'_>, path: &PStr, action: &str, error: io::Error, fatal: bool) -> PResult<()> {
		interp.set_errno(&error);
		let error = error_text(&error);
		let name = path.to_string_lossy();
		if self.options.errors.is_some() {
			let report = new_hv();
			let message = if action.is_empty() { error } else { format!("{action}: {error}") };
			report.entries_mut().insert(HKey::new(path), new_sv(Value::str(&message)));
			self.errors.push(Value::Ref(Ref::Hash(report)));
		} else if fatal {
			let action = if action.is_empty() { "mkdir" } else { action };
			return Err(interp.die_msg(format!("{action} {name}: {error}")));
		} else if action.is_empty() {
			interp.warn(format!("{name}: {error}"));
		} else {
			interp.warn(format!("{action} {name}: {error}"));
		}
		Ok(())
	}

	fn done(&mut self, interp: &mut Interp<'_>, path: &PStr, action: &str, record: bool, report: bool) -> PResult<()> {
		self.count += 1;
		if record { self.changed.push(Value::Str(path.clone())); }
		if self.options.verbose {
			let mut line = PStr::from_str(action);
			line.push_bytes(b" ");
			line.push(path);
			line.push_bytes(b"\n");
			let _ = interp.selected().borrow_mut().write(&line);
		}
		if report && let Some(destination) = &self.options.results
			&& let Value::Ref(Ref::Array(array)) = interp.read_sv(destination)?
		{
			array.elems_mut().push(new_sv(Value::Str(path.clone())));
		}
		Ok(())
	}
}

fn path_operation(interp: &mut Interp<'_>, mut args: Vec<Sv>, cx: Cx, create: bool, legacy: bool) -> PResult<Ret> {
	let hash = match args.last().map(|arg| interp.read_sv(arg)).transpose()? {
		Some(Value::Ref(Ref::Hash(hash))) => { args.pop(); Some(hash) },
		_ => None,
	};
	let options = if let Some(hash) = &hash { PathOptions::from_hash(interp, hash, create)? }
	else if legacy {
		let mode = arg(&args, 2);
		PathOptions { verbose: arg(&args, 1).truthy(), safe: !create && mode.truthy(),
			mode: if create && !mode.is_undef() { mode.to_i64() as u32 } else { 0o777 }, ..PathOptions::default() }
	} else { PathOptions { mode: 0o777, ..PathOptions::default() } };
	let limit = if legacy && hash.is_none() { 1 } else { args.len() };
	let mut paths = Vec::new();
	for slot in args.iter().take(limit) {
		let value = interp.read_sv(slot)?;
		if legacy && let Value::Ref(Ref::Array(array)) = value {
			let len = array.elems().len();
			for index in 0..len {
				let slot = array.elems().get(index).cloned();
				if let Some(slot) = slot { paths.push(interp.read_sv(&slot)?.to_pstr()); }
			}
		} else if !value.is_undef() {
			paths.push(interp.stringify(&value)?);
		}
	}
	if !create && paths.is_empty() && !legacy { interp.warn("No root path(s) specified\n"); }
	let mut change = Change::new(interp, options)?;
	let mut result = Ok(());
	for path in paths.into_iter().filter(|p| !p.is_empty()) {
		result = if create { make(interp, &mut change, &path, cx == Cx::List) }
		else {
			let resolved = interp.resolve_path(&path.bytes);
			let here = cwd(interp);
			let fs = interp.host().fs();
			let blocks_cwd = fs.symlink_metadata(&resolved).is_ok_and(|m| m.is_dir())
				&& fs.canonicalize(&resolved).is_ok_and(|root| here.starts_with(root));
			if blocks_cwd && !change.options.keep_root && path.bytes != b"." {
				change.error(interp, &path, "cannot remove path when cwd is inside it", io::ErrorKind::InvalidInput.into(), false)
			} else { remove(interp, &mut change, &resolved, &path, true) }
		};
		if result.is_err() { break; }
	}
	if let Some(destination) = change.options.errors {
		interp.write_sv(&destination, Value::Ref(Ref::Array(new_av(change.errors))))?;
	}
	result?;
	if create && cx == Cx::List { Ok(list(change.changed, cx)) } else { one(Value::Int(change.count)) }
}

fn make(interp: &mut Interp<'_>, change: &mut Change, name: &PStr, record: bool) -> PResult<()> {
	// Collect the missing ancestors iteratively (a script-supplied path may have any number of components),
	// as prefix lengths of `name` so memory stays linear, then create them outermost first.
	let mut pending = Vec::new();
	let mut len = name.bytes.len();
	loop {
		if interp.is_cancelled() { return Err(Flow::Cancelled); }
		while len > 1 && name.bytes[len - 1] == b'/' { len -= 1; }
		let current = &name.bytes[..len];
		let path = interp.resolve_path(current);
		if interp.host().fs().metadata(&path).is_ok_and(|meta| meta.is_dir()) { break; }
		pending.push(len);
		let spelling = os(current);
		let raw = Path::new(&*spelling);
		let parent = omp_vfs::parent_path(raw).filter(|p| !p.as_os_str().is_empty() && *p != raw)
			.map(|parent| parent.as_os_str().as_encoded_bytes())
			.filter(|parent| parent.len() < len && current.starts_with(parent))
			.map(<[u8]>::len);
		let Some(parent) = parent else { break };
		len = parent;
	}
	for len in pending.into_iter().rev() {
		let prefix = PStr::new(name.bytes[..len].to_vec(), name.utf8);
		let path = interp.resolve_path(&prefix.bytes);
		make_one(interp, change, &prefix, &path, record)?;
	}
	Ok(())
}

fn make_one(interp: &mut Interp<'_>, change: &mut Change, name: &PStr, path: &Path, record: bool) -> PResult<()> {
	if interp.is_cancelled() { return Err(Flow::Cancelled); }
	let options = DirOptions::new().mode(change.options.mode);
	match interp.host().fs().create_dir_with(path, &options) {
		Ok(()) => {},
		Err(error) => {
			if error.kind() == io::ErrorKind::AlreadyExists && interp.host().fs().metadata(path).is_ok_and(|m| m.is_dir()) {
				return Ok(());
			}
			return change.error(interp, name, "", error, true);
		},
	}
	change.done(interp, name, "mkdir", record, false)?;
	if let Some(mode) = change.options.chmod
		&& let Err(error) = interp.host().fs().set_permissions(path, Permissions::from_mode(mode))
	{
		change.error(interp, name, "cannot change permissions", error, false)?;
	}
	if (change.options.uid.is_some() || change.options.gid.is_some())
		&& let Err(error) = interp.host().fs().chown(path, change.options.uid, change.options.gid, true)
	{
		change.error(interp, name, "cannot change ownership", error, false)?;
	}
	Ok(())
}

fn display_join(dir: &PStr, name: &[u8]) -> PStr {
	let mut path = dir.clone();
	if !path.is_empty() && !path.bytes.ends_with(b"/") { path.push_bytes(b"/"); }
	path.bytes.extend_from_slice(name);
	path
}

fn remove(interp: &mut Interp<'_>, change: &mut Change, path: &Path, name: &PStr, root: bool) -> PResult<()> {
	if interp.is_cancelled() { return Err(Flow::Cancelled); }
	let meta = match interp.host().fs().symlink_metadata(path) {
		Ok(meta) => meta,
		Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
		Err(error) => return change.error(interp, name, "cannot stat", error, false),
	};
	if !meta.is_dir() {
		return match interp.host().fs().remove_file(path) {
			Ok(()) => change.done(interp, name, "unlink", false, true),
			Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(()),
			Err(err) => change.error(interp, name, "cannot unlink file", err, false),
		};
	}
	let mode = meta.mode() & 0o7777;
	let mut restore_mode = false;
	let mut listing = interp.host().fs().read_dir(path);
	if !change.options.safe && (listing.as_ref().is_err_and(|err| err.kind() == io::ErrorKind::PermissionDenied) || mode & 0o300 != 0o300)
		&& interp.host().fs().set_permissions(path, Permissions::from_mode(mode | 0o700)).is_ok()
	{
		restore_mode = true;
		listing = interp.host().fs().read_dir(path);
	}
	let result: PResult<bool> = (|| {
		let entries = match listing {
			Ok(entries) => entries,
			Err(err) => { change.error(interp, name, "cannot read directory", err, false)?; return Ok(false); },
		};
		for entry in entries {
			match entry {
				Ok(entry) => {
					let file_name = entry.file_name();
					let next = PStr::from_bytes(file_name.as_encoded_bytes());
					// One native frame per directory level: grow the stack for deep trees.
					stacker::maybe_grow(128 * 1024, 2 * 1024 * 1024, || remove(interp, change, &entry.path(), &next, false))?;
				},
				Err(err) => change.error(interp, name, "cannot read directory", err, false)?,
			}
		}
		if root && change.options.keep_root { return Ok(false); }
		if root && name.bytes == b"." {
			change.error(interp, name, "cannot remove directory", io::Error::from_raw_os_error(libc::EINVAL), false)?;
			return Ok(false);
		}
		match interp.host().fs().remove_dir(path) {
			Ok(()) => {
				restore_mode = false;
				change.done(interp, name, "rmdir", false, true)?;
				Ok(true)
			},
			Err(err) if err.kind() == io::ErrorKind::NotFound => Ok(true),
			Err(err) => { change.error(interp, name, "cannot remove directory", err, false)?; Ok(false) },
		}
	})();
	if restore_mode && !matches!(result, Ok(true))
		&& let Err(err) = interp.host().fs().set_permissions(path, Permissions::from_mode(mode))
	{
		change.error(interp, name, "cannot restore permissions", err, false)?;
	}
	result.map(|_| ())
}

struct Find {
	wanted: Cv,
	preprocess: Option<Cv>,
	postprocess: Option<Cv>,
	dangling: Value,
	no_chdir: bool,
	depth: bool,
	follow: bool,
	fast: bool,
	follow_skip: i64,
	seen: HashSet<Identity>,
	ancestors: HashSet<Identity>,
	last_topic: PStr,
}

#[derive(Clone, Eq, Hash, PartialEq)]
enum Identity { File(FileId), Path(PathBuf) }

struct Found {
	lstat: Metadata,
	is_dir: bool,
	target: Option<(PathBuf, Option<FileId>)>,
}

fn callback(value: Value) -> Option<Cv> {
	if let Value::Ref(Ref::Code(code)) = value { Some(code) } else { None }
}

fn find(interp: &mut Interp<'_>, args: Vec<Sv>, depth: bool) -> PResult<Ret> {
	let (opts, want) = match arg(&args, 0) {
		Value::Ref(Ref::Hash(hash)) => {
			let want = option(interp, &hash, b"wanted")?;
			(Some(hash), want)
		},
		other => (None, other),
	};
	let get = |interp: &mut Interp<'_>, key: &[u8]| opts.as_ref().map_or(Ok(Value::Undef), |hash| option(interp, hash, key));
	let Some(wanted) = callback(want) else { return Err(interp.die_msg("no &wanted subroutine given")); };
	let follow_skip = get(interp, b"follow_skip")?;
	let mut walk = Find {
		wanted, preprocess: callback(get(interp, b"preprocess")?), postprocess: callback(get(interp, b"postprocess")?),
		dangling: get(interp, b"dangling_symlinks")?, no_chdir: get(interp, b"no_chdir")?.truthy(),
		depth: depth || get(interp, b"bydepth")?.truthy(),
		follow: get(interp, b"follow")?.truthy(), fast: get(interp, b"follow_fast")?.truthy(),
		follow_skip: if follow_skip.is_undef() { 1 } else { follow_skip.to_i64() },
		seen: HashSet::new(), ancestors: HashSet::new(), last_topic: PStr::default(),
	};
	let slots = ["name", "dir", "prune", "fullname"].map(|name| interp.sv(&format!("File::Find::{name}")));
	let saved = slots.each_ref().map(|sv| sv.get());
	let start = cwd(interp);
	let result: PResult<()> = (|| {
		for slot in args.iter().skip(1) {
			let value = interp.read_sv(slot)?;
			let mut name = interp.stringify(&value)?;
			while name.bytes.len() > 1 && name.bytes.ends_with(b"/") && !name.bytes.ends_with(b"://") { name.bytes.pop(); }
			if name.is_empty() { continue; }
			let path = interp.resolve_path(&name.bytes);
			interp.sv("File::Find::name").set(Value::bytes(b""));
			walk.visit(interp, &path, &name, None, None)?;
			if !walk.no_chdir { interp.set_cwd(start.clone()); }
		}
		Ok(())
	})();
	if !walk.no_chdir { interp.set_cwd(start); }
	for (slot, value) in slots.into_iter().zip(saved) { slot.set(value); }
	result?;
	one(Value::Undef)
}

impl Find {
	fn follows(&self) -> bool { self.follow || self.fast }

	fn visit(&mut self, interp: &mut Interp<'_>, path: &Path, name: &PStr, parent: Option<(&Path, &PStr)>, lstat: Option<Metadata>) -> PResult<()> {
		if interp.is_cancelled() { return Err(Flow::Cancelled); }
		let found = match lstat {
			Some(lstat) => Found { is_dir: lstat.is_dir(), lstat, target: None },
			None => match self.metadata(interp, path, name, parent)? { Some(found) => found, None => return Ok(()) },
		};
		let mut descend = found.is_dir;
		let real = found.target.as_ref().map(|(real, _)| real.as_path());
		let identity = found.target.as_ref().map(|(real, id)| id.map_or_else(|| Identity::Path(real.clone()), Identity::File));
		if let Some(id) = &identity {
			if self.fast && self.ancestors.contains(id) {
				if self.follow_skip < 2 {
					return Err(interp.die_msg(format!("{} is a recursive symbolic link", path.display())));
				}
				descend = false;
			}
			if (self.follow || found.lstat.is_symlink()) && !self.seen.insert(id.clone()) {
				if self.follow_skip == 0 || (self.follow_skip == 1 && found.is_dir) {
					return Err(interp.die_msg(format!("{} encountered a second time", path.display())));
				}
				descend &= !found.is_dir;
			}
		}
		let shown;
		let name = if parent.is_none() && !found.is_dir {
			if self.follows() {
				shown = path_value(path).to_pstr();
				&shown
			} else if !name.bytes.contains(&b'/') {
				shown = display_join(&PStr::from_bytes(b"."), &name.bytes);
				&shown
			} else { name }
		} else { name };
		let base = name.bytes.rsplit(|b| *b == b'/').next().unwrap_or_default();
		let standalone_dir;
		let (callback_dir, callback_path, topic) = if let Some((path, dir)) = parent {
			(dir, path, if self.no_chdir { name.clone() } else { PStr::new(base.to_vec(), name.utf8) })
		} else if found.is_dir {
			(name, path, if self.no_chdir { name.clone() } else { PStr::from_bytes(b".") })
		} else {
			let end = name.bytes.len().saturating_sub(base.len());
			standalone_dir = PStr::new(name.bytes[..end].to_vec(), name.utf8);
			(&standalone_dir, omp_vfs::parent_path(path).unwrap_or(path), if self.no_chdir { name.clone() } else { PStr::new(base.to_vec(), name.utf8) })
		};
		let real = if parent.is_none() && !found.is_dir { None } else { real };
		if !self.depth || !descend {
			self.wanted(interp, callback_path, callback_dir, name, topic.clone(), real, found.lstat.clone())?;
			if !descend { return Ok(()); }
			let prune = interp.sv("File::Find::prune");
			if interp.read_sv(&prune)?.truthy() { return Ok(()); }
		}
		if let Some(id) = &identity { self.ancestors.insert(id.clone()); }
		self.children(interp, path, name, &topic)?;
		if let Some(id) = &identity { self.ancestors.remove(id); }
		if self.depth {
			self.wanted(interp, callback_path, callback_dir, name, topic, real, found.lstat)?;
		}
		Ok(())
	}

	fn wanted(&mut self, interp: &mut Interp<'_>, path: &Path, dir: &PStr, name: &PStr, topic: PStr, real: Option<&Path>, metadata: Metadata) -> PResult<()> {
		if !self.no_chdir { interp.set_cwd(path.to_path_buf()); }
		self.fields(interp, dir, name, real);
		cache_stat(interp, metadata, false);
		interp.sv("File::Find::prune").set(Value::Int(0));
		let topic = new_sv(Value::Str(topic));
		interp.with_topic(topic.clone(), |interp| interp.call_sub(&self.wanted, Vec::new(), Cx::Void))?;
		if self.depth { self.last_topic = interp.read_sv(&topic)?.to_pstr(); }
		Ok(())
	}

	fn children(&mut self, interp: &mut Interp<'_>, path: &Path, name: &PStr, topic: &PStr) -> PResult<()> {
		let listing = match interp.host().fs().read_dir(path) {
			Ok(listing) => listing,
			Err(err) => { self.warn(interp, name, "Can't opendir", err); return Ok(()); }
		};
		let mut entries = Vec::new();
		for entry in listing {
			match entry {
				Ok(entry) => entries.push(entry.file_name()),
				Err(err) => self.warn(interp, name, "Can't read", err),
			}
		}
		let mut dirs = Vec::new();
		if !self.follows() && let Some(preprocess) = &self.preprocess {
			if !self.no_chdir { interp.set_cwd(path.to_path_buf()); }
			let topic = if self.depth {
				interp.sv("File::Find::dir").set(Value::Str(name.clone()));
				self.last_topic.clone()
			} else {
				self.fields(interp, name, name, None);
				topic.clone()
			};
			let values = entries.iter().map(|entry| Value::bytes(entry.as_encoded_bytes()));
			let inputs = [Value::bytes(b"."), Value::bytes(b"..")].into_iter().chain(values).map(new_sv).collect();
			let results = self.run_callback(interp, preprocess, topic, inputs, Cx::List)?.list();
			for entry in results { self.child(interp, path, name, &entry.to_pstr().bytes, &mut dirs)?; }
		} else {
			for entry in entries { self.child(interp, path, name, entry.as_encoded_bytes(), &mut dirs)?; }
		}
		for (child, full, meta) in dirs {
			// One native frame per directory level: grow the stack for deep trees.
			stacker::maybe_grow(128 * 1024, 2 * 1024 * 1024, || self.visit(interp, &child, &full, Some((path, name)), Some(meta)))?;
		}
		if !self.follows() && let Some(postprocess) = &self.postprocess {
			if !self.no_chdir { interp.set_cwd(path.to_path_buf()); }
			self.fields(interp, name, name, None);
			self.run_callback(interp, postprocess, PStr::from_bytes(b"."), Vec::new(), Cx::Void)?;
		}
		Ok(())
	}

	fn child(&mut self, interp: &mut Interp<'_>, path: &Path, name: &PStr, part: &[u8], dirs: &mut Vec<(PathBuf, PStr, Metadata)>) -> PResult<()> {
		if matches!(part, b"." | b".." | b"") { return Ok(()); }
		let child = omp_vfs::join_path(path, Path::new(&*os(part)));
		let full = display_join(name, part);
		let mut lstat = None;
		if !self.follows() {
			match interp.host().fs().symlink_metadata(&child) {
				Ok(meta) if meta.is_dir() => { dirs.push((child, full, meta)); return Ok(()); },
				Ok(meta) => lstat = Some(meta),
				Err(err) => { self.warn(interp, &full, "Can't stat", err); return Ok(()); },
			}
		}
		stacker::maybe_grow(128 * 1024, 2 * 1024 * 1024, || self.visit(interp, &child, &full, Some((path, name)), lstat))
	}

	fn metadata(&self, interp: &mut Interp<'_>, path: &Path, name: &PStr, parent: Option<(&Path, &PStr)>) -> PResult<Option<Found>> {
		let lstat = match interp.host().fs().symlink_metadata(path) {
			Ok(meta) => meta,
			Err(err) => { self.warn(interp, name, "Can't stat", err); return Ok(None); },
		};
		if !self.follows() {
			return Ok(Some(Found { is_dir: lstat.is_dir(), lstat, target: None }));
		}
		let (is_dir, id) = if lstat.is_symlink() {
			match interp.host().fs().metadata(path) {
				Ok(meta) => (meta.is_dir(), meta.file_id()),
				Err(err) if err.kind() == io::ErrorKind::NotFound => {
					if let Value::Ref(Ref::Code(code)) = &self.dangling {
						if let Some((path, _)) = parent && !self.no_chdir { interp.set_cwd(path.to_path_buf()); }
						let base = name.bytes.rsplit(|b| *b == b'/').next().unwrap_or_default();
						let mut dir = parent.map_or_else(PStr::default, |(_, dir)| dir.clone());
						if !dir.is_empty() && !dir.bytes.ends_with(b"/") { dir.push_bytes(b"/"); }
						let value = Value::Str(PStr::new(base.to_vec(), name.utf8));
						interp.call_sub(code, vec![new_sv(value), new_sv(Value::Str(dir))], Cx::Void)?;
					} else if self.dangling.truthy() { self.warn(interp, name, "Dangling symlink", err); }
					return Ok(Some(Found { is_dir: false, lstat, target: None }));
				},
				Err(err) => { self.warn(interp, name, "Can't stat", err); return Ok(None); },
			}
		} else { (lstat.is_dir(), lstat.file_id()) };
		let real = interp.host().fs().canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
		Ok(Some(Found { lstat, is_dir, target: Some((real, id)) }))
	}

	fn fields(&self, interp: &mut Interp<'_>, dir: &PStr, name: &PStr, real: Option<&Path>) {
		interp.sv("File::Find::dir").set(Value::Str(dir.clone()));
		interp.sv("File::Find::name").set(Value::Str(name.clone()));
		interp.sv("File::Find::fullname").set(real.map_or(Value::Undef, path_value));
	}

	fn warn(&self, interp: &mut Interp<'_>, name: &PStr, action: &str, err: io::Error) {
		interp.set_errno(&err);
		if interp.warn_on("misc") { interp.warn(format!("{action} {}: {}", name.to_string_lossy(), error_text(&err))); }
	}

	fn run_callback(&self, interp: &mut Interp<'_>, code: &Cv, topic: PStr, args: Vec<Sv>, cx: Cx) -> PResult<Ret> {
		interp.with_topic(new_sv(Value::Str(topic)), |interp| interp.call_sub(code, args, cx))
	}
}
