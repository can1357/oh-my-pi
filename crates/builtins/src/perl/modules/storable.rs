//! Native Storable API with an interpreter-private graph format (Storable POD).

use std::{collections::HashMap, io::{self, Read as _, Write as _}, rc::Rc};

use omp_vfs::OpenOptions;

use crate::perl::{
	interp::{Cx, Interp, PResult, Ret},
	limits::check_len,
	io::Io,
	regex::{Charset, Regex, RxFlags},
	value::{Dual, HKey, Num, PStr, Ref, Sv, Value, new_av, new_hv, new_rx, new_sv},
};

use super::{arg, constant, define, export, version};

const MAGIC: &[u8; 8] = b"piSTR\0\x01\0";
const HEADER: usize = MAGIC.len() + 1 + 8;
const MAX_DEPTH: usize = 512;
const MAX_HASH_DEPTH: usize = 256;
const INVALID: &str = "Corrupted storable data";

/// Install Storable's native entry points, version, and exports.
pub(super) fn load(interp: &mut Interp<'_>, module: &str) -> PResult<()> {
	define(interp, module, &[
		("store", store), ("nstore", nstore), ("retrieve", retrieve),
		("store_fd", store_fd), ("nstore_fd", nstore_fd), ("fd_retrieve", fd_retrieve),
		("retrieve_fd", fd_retrieve), ("freeze", freeze), ("nfreeze", nfreeze), ("thaw", thaw),
		("dclone", dclone), ("lock_store", lock_store), ("lock_nstore", lock_nstore),
		("lock_retrieve", lock_retrieve), ("file_magic", file_magic), ("read_magic", read_magic),
	]);
	for (name, value) in [("BLESS_OK", 2), ("TIE_OK", 4), ("FLAGS_COMPAT", 6),
		("stack_depth", MAX_DEPTH as i64), ("stack_depth_hash", MAX_HASH_DEPTH as i64)] {
		constant(interp, &format!("{module}::{name}"), Value::Int(value));
	}
	interp.sv("Storable::flags").set(Value::Int(6));
	version(interp, module, "3.23");
	export(interp, module, &["store", "retrieve"], &[
		"nstore", "store_fd", "nstore_fd", "fd_retrieve", "freeze", "nfreeze", "thaw", "dclone",
		"retrieve_fd", "lock_store", "lock_nstore", "lock_retrieve", "file_magic", "read_magic",
		"BLESS_OK", "TIE_OK", "FLAGS_COMPAT", "stack_depth", "stack_depth_hash",
	]);
	Ok(())
}

fn storable_ref<'v>(value: &'v Value, message: &'static str) -> Result<&'v Ref, &'static str> {
	if let Value::Ref(reference) = value { Ok(reference) } else { Err(message) }
}

fn image(value: &Value, network: bool, file: bool, canonical: bool, bad_ref: &'static str) -> Result<Vec<u8>, &'static str> {
	let reference = storable_ref(value, bad_ref)?;
	let mut w = Writer { bytes: Vec::new(), seen: HashMap::new(), canonical };
	w.bytes.extend_from_slice(MAGIC);
	w.bytes.push(u8::from(network) | (u8::from(file) << 1));
	w.word(0);
	w.object(reference, 0, 0)?;
	let size = (w.bytes.len() - HEADER) as u64;
	w.bytes[MAGIC.len() + 1..HEADER].copy_from_slice(&size.to_be_bytes());
	Ok(w.bytes)
}

fn header(bytes: &[u8]) -> Option<(bool, bool, usize)> {
	let tail = bytes.strip_prefix(MAGIC)?;
	let (&flags, tail) = tail.split_first()?;
	if flags & !3 != 0 { return None; }
	let length = usize::try_from(u64::from_be_bytes(tail.first_chunk::<8>().copied()?)).ok()?;
	Some((flags & 1 != 0, flags & 2 != 0, length))
}

fn restore(bytes: &[u8], bless: bool, file: bool) -> Result<Value, String> {
	let (_, _, length) = header(bytes).filter(|&(_, f, _)| f == file).ok_or(
		if file { "Magic number checking on storable file failed" } else { "Magic number checking on storable string failed" },
	)?;
	let payload = bytes.get(HEADER..).and_then(|rest| rest.get(..length)).ok_or(INVALID)?;
	let mut r = Reader { rest: payload, objects: Vec::new(), bless };
	let result = r.object(0, 0).and_then(|v| if r.rest.is_empty() { Ok(v) } else { Err(INVALID.into()) });
	if result.is_err() { clear_graph(r.objects.iter()); }
	result.map(Value::Ref)
}

struct Writer {
	bytes: Vec<u8>,
	seen: HashMap<usize, usize>,
	canonical: bool,
}

impl Writer {
	fn word(&mut self, n: u64) { self.bytes.extend_from_slice(&n.to_be_bytes()); }
	fn data(&mut self, bytes: &[u8]) {
		self.word(bytes.len() as u64);
		self.bytes.extend_from_slice(bytes);
	}
	fn string(&mut self, s: &PStr) {
		self.bytes.push(u8::from(s.utf8));
		self.data(&s.bytes);
	}
	fn value(&mut self, v: &Value, depth: usize, hashes: usize) -> Result<(), &'static str> {
		match v {
			Value::Undef => self.bytes.push(0),
			Value::Int(n) => { self.bytes.push(1); self.word(*n as u64); }
			Value::UInt(n) => { self.bytes.push(2); self.word(*n); }
			Value::Num(n) => { self.bytes.push(3); self.word(n.to_bits()); }
			Value::Str(s) => { self.bytes.push(4); self.string(s); }
			Value::Dual(dual) => {
				self.bytes.push(5);
				match dual.num {
					Num::Int(n) => { self.bytes.push(1); self.word(n as u64); }
					Num::UInt(n) => { self.bytes.push(2); self.word(n); }
					Num::Float(n) => { self.bytes.push(3); self.word(n.to_bits()); }
				}
				self.string(&dual.str);
			}
			Value::Ref(reference) => { self.bytes.push(6); self.object(reference, depth, hashes)?; }
			Value::Glob(_) => return Err("Can't store GLOB items"),
		}
		Ok(())
	}
	fn object(&mut self, reference: &Ref, depth: usize, hashes: usize) -> Result<(), &'static str> {
		if let Some(&id) = self.seen.get(&reference.addr()) {
			self.bytes.push(0);
			self.word(id as u64);
			return Ok(());
		}
		if depth >= MAX_DEPTH || hashes >= MAX_HASH_DEPTH { return Err("Max. recursion depth with nested structures exceeded"); }
		let tag = match reference {
			Ref::Scalar(_) => 1, Ref::Array(_) => 2, Ref::Hash(_) => 3, Ref::Regexp(_) => 4,
			Ref::Glob(_) => return Err("Can't store GLOB items"),
			Ref::Code(_) => return Err("Can't store CODE items"),
			Ref::Io(_) => return Err("Can't store IO items"),
		};
		self.seen.insert(reference.addr(), self.seen.len());
		self.bytes.push(tag);
		if let Some(class) = reference.blessed() { self.data(class.as_bytes()); } else { self.word(0); }
		match reference {
			Ref::Scalar(cell) => self.value(&cell.get(), depth + 1, hashes)?,
			Ref::Array(array) => {
				let elems = array.elems();
				self.word(elems.len() as u64);
				for cell in &*elems { self.object(&Ref::Scalar(Rc::clone(cell)), depth + 1, hashes)?; }
			}
			Ref::Hash(hash) => {
				let map = hash.entries();
				self.word(map.len() as u64);
				if self.canonical {
					let mut entries: Vec<_> = map.iter().map(|(key, cell)| (key.to_pstr(), cell)).collect();
					entries.sort_unstable_by(|(a, _), (b, _)| a.cmp(b));
					for (key, cell) in entries {
						self.string(&key);
						self.object(&Ref::Scalar(Rc::clone(cell)), depth + 1, hashes + 1)?;
					}
				} else {
					for (key, cell) in &*map {
						self.string(&key.to_pstr());
						self.object(&Ref::Scalar(Rc::clone(cell)), depth + 1, hashes + 1)?;
					}
				}
			}
			Ref::Regexp(re) => {
				self.string(re.regex.source());
				let f = re.regex.flags();
				self.bytes.push(u8::from(f.i) | (u8::from(f.m) << 1) | (u8::from(f.s) << 2) |
					(u8::from(f.x) << 3) | (u8::from(f.xx) << 4) | (u8::from(f.n) << 5) | (u8::from(f.p) << 6));
				self.bytes.push(match f.charset {
					Charset::Depends => 0, Charset::Unicode => 1, Charset::Ascii => 2,
					Charset::AsciiStrict => 3, Charset::Locale => 4,
				});
			}
			_ => return Err(INVALID),
		}
		Ok(())
	}
}

struct Reader<'a> {
	rest: &'a [u8],
	objects: Vec<Ref>,
	bless: bool,
}

impl<'a> Reader<'a> {
	fn take(&mut self, length: usize) -> Result<&'a [u8], &'static str> {
		let (data, rest) = self.rest.split_at_checked(length).ok_or(INVALID)?;
		self.rest = rest;
		Ok(data)
	}
	fn byte(&mut self) -> Result<u8, &'static str> { Ok(self.take(1)?[0]) }
	fn word(&mut self) -> Result<u64, &'static str> { Ok(u64::from_be_bytes(self.take(8)?.try_into().map_err(|_| INVALID)?)) }
	fn length(&mut self) -> Result<usize, &'static str> { usize::try_from(self.word()?).map_err(|_| INVALID) }
	fn data(&mut self) -> Result<&'a [u8], &'static str> { let n = self.length()?; self.take(n) }
	fn string(&mut self) -> Result<PStr, &'static str> {
		let flag = self.byte()?;
		if flag > 1 { return Err(INVALID); }
		Ok(PStr::new(self.data()?.to_vec(), flag != 0))
	}
	fn value(&mut self, depth: usize, hashes: usize) -> Result<Value, String> {
		Ok(match self.byte()? {
			0 => Value::Undef,
			1 => Value::Int(self.word()? as i64),
			2 => Value::UInt(self.word()?),
			3 => Value::Num(f64::from_bits(self.word()?)),
			4 => Value::Str(self.string()?),
			5 => {
				let num = match self.byte()? {
					1 => Num::Int(self.word()? as i64), 2 => Num::UInt(self.word()?),
					3 => Num::Float(f64::from_bits(self.word()?)), _ => return Err(INVALID.into()),
				};
				Value::Dual(Rc::new(Dual { num, str: self.string()? }))
			}
			6 => Value::Ref(self.object(depth, hashes)?),
			_ => return Err(INVALID.into()),
		})
	}
	fn cell(&mut self, depth: usize, hashes: usize) -> Result<Sv, String> {
		match self.object(depth, hashes)? {
			Ref::Scalar(cell) => Ok(cell), _ => Err(INVALID.into()),
		}
	}
	fn object(&mut self, depth: usize, hashes: usize) -> Result<Ref, String> {
		let tag = self.byte()?;
		if tag == 0 {
			let id = self.length()?;
			return self.objects.get(id).cloned().ok_or_else(|| INVALID.into());
		}
		if depth >= MAX_DEPTH || hashes >= MAX_HASH_DEPTH { return Err("Max. recursion depth with nested structures exceeded".into()); }
		let class = std::str::from_utf8(self.data()?).map_err(|_| INVALID)?;
		let reference = match tag {
			1 => Ref::Scalar(new_sv(Value::Undef)),
			2 => Ref::Array(new_av(Vec::new())),
			3 => Ref::Hash(new_hv()),
			4 => {
				let source = self.string()?;
				let opts = self.byte()?;
				let charset = match self.byte()? {
					0 => Charset::Depends, 1 => Charset::Unicode, 2 => Charset::Ascii,
					3 => Charset::AsciiStrict, 4 => Charset::Locale, _ => return Err(INVALID.into()),
				};
				let flags = RxFlags { i: opts & 1 != 0, m: opts & 2 != 0, s: opts & 4 != 0,
					x: opts & 8 != 0, xx: opts & 16 != 0, n: opts & 32 != 0, p: opts & 64 != 0, charset };
				Ref::Regexp(new_rx(Rc::new(Regex::new(&source, flags)?)))
			}
			_ => return Err(INVALID.into()),
		};
		if self.bless && !class.is_empty() { reference.bless(Rc::from(class)); }
		self.objects.push(reference.clone());
		match &reference {
			Ref::Scalar(cell) => cell.set(self.value(depth + 1, hashes)?),
			Ref::Array(array) => {
				let count = self.length()?;
				if count > self.rest.len() { return Err(INVALID.into()); }
				let mut items = array.elems_mut();
				items.try_reserve_exact(count).map_err(|_| INVALID)?;
				for _ in 0..count { items.push(self.cell(depth + 1, hashes)?); }
			}
			Ref::Hash(hash) => {
				let count = self.length()?;
				if count > self.rest.len() / 10 { return Err(INVALID.into()); }
				let mut map = hash.entries_mut();
				map.try_reserve(count).map_err(|_| INVALID)?;
				for _ in 0..count {
					let key = HKey::new(&self.string()?);
					if map.insert(key, self.cell(depth + 1, hashes + 1)?).is_some() { return Err(INVALID.into()); }
				}
			}
			_ => {},
		}
		Ok(reference)
	}
}

fn clear_graph<'a>(references: impl Iterator<Item = &'a Ref>) {
	// An incomplete graph can already contain cycles. Break its edges on failure.
	for reference in references {
		match reference {
			Ref::Scalar(cell) => cell.set(Value::Undef),
			Ref::Array(array) => array.elems_mut().clear(),
			Ref::Hash(hash) => hash.entries_mut().clear(),
			_ => {},
		}
	}
}

fn clone_cell(
	cell: &Sv, seen: &mut HashMap<usize, Ref>, depth: usize, hashes: usize,
) -> Result<Sv, &'static str> {
	match clone_object(&Ref::Scalar(Rc::clone(cell)), seen, depth, hashes)? {
		Ref::Scalar(cell) => Ok(cell), _ => Err(INVALID),
	}
}

fn clone_object(reference: &Ref, seen: &mut HashMap<usize, Ref>, depth: usize, hashes: usize) -> Result<Ref, &'static str> {
	let id = reference.addr();
	if let Some(value) = seen.get(&id) { return Ok(value.clone()); }
	if depth >= MAX_DEPTH || hashes >= MAX_HASH_DEPTH { return Err("Max. recursion depth with nested structures exceeded"); }
	let copy = match reference {
		Ref::Scalar(_) => Ref::Scalar(new_sv(Value::Undef)),
		Ref::Array(_) => Ref::Array(new_av(Vec::new())),
		Ref::Hash(_) => Ref::Hash(new_hv()),
		Ref::Regexp(r) => Ref::Regexp(new_rx(Rc::clone(&r.regex))),
		Ref::Glob(_) => return Err("Can't store GLOB items"),
		Ref::Code(_) => return Err("Can't store CODE items"),
		Ref::Io(_) => return Err("Can't store IO items"),
	};
	if let Some(class) = reference.blessed() { copy.bless(class); }
	seen.insert(id, copy.clone());
	match (reference, &copy) {
		(Ref::Scalar(source), Ref::Scalar(dest)) => {
			let value = match source.get() {
				Value::Ref(nested) => Value::Ref(clone_object(&nested, seen, depth + 1, hashes)?),
				Value::Glob(_) => return Err("Can't store GLOB items"),
				value => value,
			};
			dest.set(value);
		}
		(Ref::Array(source), Ref::Array(dest)) => {
			let source = source.elems();
			let mut dest = dest.elems_mut();
			dest.reserve_exact(source.len());
			for cell in source.iter() { dest.push(clone_cell(cell, seen, depth + 1, hashes)?); }
		}
		(Ref::Hash(source), Ref::Hash(dest)) => {
			let source = source.entries();
			let mut dest = dest.entries_mut();
			dest.reserve(source.len());
			for (key, cell) in source.iter() {
				dest.insert(key.clone(), clone_cell(cell, seen, depth + 1, hashes + 1)?);
			}
		}
		_ => {},
	}
	Ok(copy)
}

fn canonical(interp: &mut Interp<'_>) -> bool { interp.sv("Storable::canonical").get().truthy() }
fn bless_flag(interp: &mut Interp<'_>, args: &[Sv], index: usize) -> PResult<bool> {
	let flags = match args.get(index) {
		Some(s) => interp.read_sv(s)?,
		None => interp.sv("Storable::flags").get(),
	};
	Ok(flags.to_i64() & 2 != 0)
}
fn freeze_network(interp: &mut Interp<'_>, args: Vec<Sv>, network: bool) -> PResult<Ret> {
	let value = arg(&args, 0);
	let bytes = image(&value, network, false, canonical(interp), "not a reference").map_err(|e| interp.die_msg(e))?;
	Ok(Ret::One(Value::Str(PStr::new(bytes, false))))
}
fn freeze(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> { freeze_network(i, args, false) }
fn nfreeze(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> { freeze_network(i, args, true) }
fn thaw(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let input = arg(&args, 0);
	if input.is_undef() { return Ok(Ret::One(Value::Undef)); }
	let input = input.to_pstr();
	if input.is_empty() { return Ok(Ret::One(Value::Undef)); }
	let allowed = bless_flag(i, &args, 1)?;
	restore(&input.bytes, allowed, false).map(Ret::One).map_err(|e| i.die_msg(e))
}
fn dclone(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let value = arg(&args, 0);
	let reference = storable_ref(&value, "Not a reference").map_err(|e| i.die_msg(e))?;
	let mut seen = HashMap::new();
	match clone_object(reference, &mut seen, 0, 0) {
		Ok(copy) => Ok(Ret::One(Value::Ref(copy))),
		Err(e) => { clear_graph(seen.values()); Err(i.die_msg(e)) }
	}
}

fn file_error(i: &mut Interp<'_>, operation: &str, path: &PStr, err: io::Error) -> crate::perl::interp::Flow {
	i.set_errno(&err);
	i.die_msg(format!("Can't {operation} '{}': {err}", path.to_string_lossy()))
}
fn write_file(i: &mut Interp<'_>, args: Vec<Sv>, network: bool, lock: bool) -> PResult<Ret> {
	let value = arg(&args, 0);
	let name = i.stringify(&arg(&args, 1))?;
	let bytes = image(&value, network, true, canonical(i), "not a reference").map_err(|e| i.die_msg(e))?;
	let path = i.resolve_path(&name.bytes);
	let result = (|| {
		let fs = i.host().fs();
		let mut file = if lock {
			let mut options = OpenOptions::new();
			options.write(true).create(true);
			let file = fs.open_with(&path, &options)?;
			file.native().ok_or(io::ErrorKind::Unsupported)?.lock()?;
			file.set_len(0)?;
			file
		} else { fs.create(&path)? };
		file.write_all(&bytes)?;
		file.flush()
	})();
	result.map_err(|e| file_error(i, "store", &name, e))?;
	Ok(Ret::One(Value::Int(1)))
}
fn store(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> { write_file(i, args, false, false) }
fn nstore(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> { write_file(i, args, true, false) }
fn lock_store(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> { write_file(i, args, false, true) }
fn lock_nstore(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> { write_file(i, args, true, true) }

fn read_file(i: &mut Interp<'_>, args: Vec<Sv>, lock: bool) -> PResult<Ret> {
	let name = i.stringify(&arg(&args, 0))?;
	let path = i.resolve_path(&name.bytes);
	let allowed = bless_flag(i, &args, 1)?;
	let result = (|| {
		let mut file = i.host().fs().open(&path)?;
		if lock { file.native().ok_or(io::ErrorKind::Unsupported)?.lock_shared()?; }
		let mut bytes = Vec::new();
		file.read_to_end(&mut bytes)?;
		Ok::<_, io::Error>(bytes)
	})();
	let bytes = result.map_err(|e| file_error(i, "open", &name, e))?;
	restore(&bytes, allowed, true).map(Ret::One).map_err(|e| i.die_msg(e))
}
fn retrieve(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> { read_file(i, args, false) }
fn lock_retrieve(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> { read_file(i, args, true) }

fn handle(i: &mut Interp<'_>, value: &Value) -> Option<Io> {
	match value {
		Value::Ref(Ref::Io(io)) => Some(Rc::clone(io)),
		Value::Glob(g) | Value::Ref(Ref::Glob(g)) => g.io.borrow().clone(),
		Value::Str(s) => {
			let name = s.to_string_lossy();
			let name = i.qualify(&name);
			i.handle(&name, false)
		}
		_ => None,
	}
}
fn write_fd(i: &mut Interp<'_>, args: Vec<Sv>, network: bool) -> PResult<Ret> {
	let value = arg(&args, 0);
	let bytes = image(&value, network, true, canonical(i), "not a reference").map_err(|e| i.die_msg(e))?;
	let io = handle(i, &arg(&args, 1)).ok_or_else(|| i.die_msg("not a valid file descriptor"))?;
	// Release the handle borrow before dying so a $SIG{__DIE__} handler may use the handle.
	let written = (|| -> Result<(), String> {
		let mut io = io.borrow_mut();
		io.binmode(b":raw")?;
		io.write(&PStr::new(bytes, false)).and_then(|_| io.flush()).map_err(|e| e.to_string())
	})();
	written.map_err(|e| i.die_msg(e))?;
	Ok(Ret::One(Value::Int(1)))
}
fn store_fd(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> { write_fd(i, args, false) }
fn nstore_fd(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> { write_fd(i, args, true) }
fn fd_retrieve(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let io = handle(i, &arg(&args, 0)).ok_or_else(|| i.die_msg("not a valid file descriptor"))?;
	// The handle borrow ends before any die, so a $SIG{__DIE__} handler may use the handle.
	let read = (|| -> Result<Option<Vec<u8>>, String> {
		let mut io = io.borrow_mut();
		io.binmode(b":raw")?;
		let mut bytes = io.read(HEADER).map_err(|e| e.to_string())?.bytes;
		if bytes.is_empty() { return Ok(None); }
		let (_, _, mut left) = header(&bytes).filter(|&(_, file, _)| file)
			.ok_or_else(|| "Magic number checking on storable file failed".to_owned())?;
		check_len(bytes.len().saturating_add(left), "string")?;
		while left != 0 {
			let piece = io.read(left.min(64 * 1024)).map_err(|e| e.to_string())?;
			if piece.is_empty() || piece.bytes.len() > left { return Err(INVALID.to_owned()); }
			left -= piece.bytes.len();
			bytes.extend_from_slice(&piece.bytes);
		}
		Ok(Some(bytes))
	})();
	let Some(bytes) = read.map_err(|e| i.die_msg(e))? else { return Ok(Ret::One(Value::Undef)) };
	let allowed = bless_flag(i, &args, 1)?;
	restore(&bytes, allowed, true).map(Ret::One).map_err(|e| i.die_msg(e))
}

fn metadata(bytes: &[u8], name: Option<PStr>, require_file: bool) -> Ret {
	let Some((network, file, _)) = header(bytes) else { return Ret::One(Value::Undef); };
	if require_file && !file { return Ret::One(Value::Undef); }
	let hash = new_hv();
	let mut fields = hash.entries_mut();
	for (key, value) in [("major", Value::Int(1)), ("minor", Value::Int(0)), ("version", Value::str("1.0")),
		("version_nv", Value::str("1.000")), ("hdrsize", Value::Int(HEADER as i64)), ("netorder", Value::Int(i64::from(network)))] {
		fields.insert(HKey::new(&PStr::from_str(key)), new_sv(value));
	}
	if file {
		let name = name.map_or(Value::Int(1), Value::Str);
		fields.insert(HKey::new(&PStr::from_str("file")), new_sv(name));
	}
	if !network {
		let pointer = std::mem::size_of::<usize>();
		let order = match (pointer, cfg!(target_endian = "little")) {
			(8, true) => "12345678", (8, false) => "87654321",
			(_, true) => "1234", (_, false) => "4321",
		};
		for (key, value) in [
			("byteorder", Value::str(order)),
			("intsize", Value::Int(std::mem::size_of::<std::ffi::c_int>() as i64)),
			("longsize", Value::Int(std::mem::size_of::<std::ffi::c_long>() as i64)),
			("ptrsize", Value::Int(pointer as i64)), ("nvsize", Value::Int(8)),
		] { fields.insert(HKey::new(&PStr::from_str(key)), new_sv(value)); }
	}
	drop(fields);
	Ret::One(Value::Ref(Ref::Hash(hash)))
}
fn read_magic(_: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	Ok(metadata(&arg(&args, 0).to_pstr().bytes, None, arg(&args, 1).truthy()))
}
fn file_magic(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let name = i.stringify(&arg(&args, 0))?;
	let path = i.resolve_path(&name.bytes);
	let mut file = i.host().fs().open(path).map_err(|e| file_error(i, "open", &name, e))?;
	let mut bytes = [0; HEADER];
	match file.read_exact(&mut bytes) {
		Ok(()) => Ok(metadata(&bytes, Some(name), true)),
		Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => Ok(Ret::One(Value::Undef)),
		Err(e) => Err(file_error(i, "read", &name, e)),
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn image_preserves_cycles_and_scalar_cell_aliases() {
		let array = new_av(vec![Value::Int(12)]);
		{
			let mut elements = array.elems_mut();
			let first = Rc::clone(&elements[0]);
			elements.push(new_sv(Value::Ref(Ref::Scalar(first))));
			elements.push(new_sv(Value::Ref(Ref::Array(Rc::clone(&array)))));
		}
		let original = Value::Ref(Ref::Array(Rc::clone(&array)));
		let bytes = image(&original, true, false, false, "bad reference").expect("serialize graph");
		let Ok(Value::Ref(Ref::Array(copy))) = restore(&bytes, true, false) else { panic!("restore array"); };
		let elems = copy.elems();
		{
			let Value::Ref(Ref::Scalar(cell)) = elems[1].get() else { panic!("restore scalar alias"); };
			assert!(Rc::ptr_eq(&elems[0], &cell));
			let Value::Ref(Ref::Array(cycle)) = elems[2].get() else { panic!("restore back-edge"); };
			assert!(Rc::ptr_eq(&copy, &cycle));
		}
		assert!(!Rc::ptr_eq(&copy, &array));
		elems[2].set(Value::Undef);
		array.elems()[2].set(Value::Undef);
	}
}
