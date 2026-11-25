//! MIME, digest and text encoding modules (MIME::Base64, MIME::QuotedPrint, Digest::MD5, Digest::SHA, Encode POD).

use std::{borrow::Cow, io::Read as _, rc::Rc};

use base64::{Engine as _, engine::general_purpose::{STANDARD_NO_PAD, URL_SAFE_NO_PAD}};
use md5::{Digest, Md5};
use sha1::Sha1;
use sha2::{Sha224, Sha256, Sha384, Sha512, Sha512_224, Sha512_256};

use crate::perl::{
	interp::{Cx, Interp, PResult, Ret},
	io::Io,
	value::{Num, PStr, Ref, Sv, Value, new_sv},
};

use super::{arg, define, export, text, version};

mod digest_state;
mod encode;

use digest_state::State;

/// Install the selected native codec, digest or encoding module.
pub(super) fn load(i: &mut Interp<'_>, module: &str) -> PResult<()> {
	match module {
		"MIME::Base64" => {
			for (name, f, proto) in [
				("encode_base64", b64_encode as crate::perl::interp::NativeFn, "$;$"), ("decode_base64", b64_decode, "$"),
				("encode_base64url", b64_url_encode, "$"), ("decode_base64url", b64_url_decode, "$"),
				("encoded_base64_length", b64_encoded_length, "$;$"), ("decoded_base64_length", b64_decoded_length, "$"),
			] { i.define_native_proto(&format!("{module}::{name}"), f, proto); }
			export(i, module, &["encode_base64", "decode_base64"], &[
				"encode_base64url", "decode_base64url", "encoded_base64_length", "decoded_base64_length",
			]);
			version(i, module, "3.16");
		}
		"MIME::QuotedPrint" => {
			i.define_native_proto("MIME::QuotedPrint::encode_qp", qp_encode, "$;$$");
			i.define_native_proto("MIME::QuotedPrint::decode_qp", qp_decode, "$");
			export(i, module, &["encode_qp", "decode_qp"], &[]);
			version(i, module, "3.16");
		}
		"Digest::MD5" | "Digest::SHA" => load_digest(i, module),
		_ => return encode::load(i, module),
	}
	Ok(())
}

fn bytes_result(bytes: Vec<u8>) -> Ret { Ret::One(Value::Str(PStr::new(bytes, false))) }
fn byte_view(s: &PStr) -> Option<Cow<'_, [u8]>> {
	if !s.utf8 || s.bytes.is_ascii() { Some(Cow::Borrowed(&s.bytes)) }
	else { s.downgraded().map(Cow::Owned) }
}
fn width(i: &mut Interp<'_>, name: &str) -> crate::perl::interp::Flow { i.die_msg(format!("Wide character in {name}")) }
fn eol(i: &mut Interp<'_>, args: &[Sv]) -> PResult<PStr> {
	let val = arg(args, 1);
	if val.is_undef() { Ok(PStr::from_bytes(b"\n")) } else { i.stringify(&val) }
}
fn b64_encode(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	use base64::engine::general_purpose::STANDARD;
	let source = i.stringify(&arg(&args, 0))?;
	let src = byte_view(&source).ok_or_else(|| width(i, "subroutine entry"))?;
	let eol = eol(i, &args)?;
	if eol.is_empty() { return Ok(bytes_result(STANDARD.encode(src).into_bytes())); }
	let mut result = PStr::default();
	let mut line = [0u8; 76];
	for chunk in src.chunks(57) {
		let len = STANDARD.encode_slice(chunk, &mut line).map_err(|e| i.die_msg(e.to_string()))?;
		result.bytes.extend_from_slice(&line[..len]);
		result.push(&eol);
	}
	Ok(Ret::One(Value::Str(result)))
}
fn b64_url_encode(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let source = i.stringify(&arg(&args, 0))?;
	let src = byte_view(&source).ok_or_else(|| width(i, "subroutine entry"))?;
	Ok(bytes_result(URL_SAFE_NO_PAD.encode(src).into_bytes()))
}
fn sextets(bytes: &[u8], url: bool) -> impl Iterator<Item = u8> + '_ {
	bytes.iter().take_while(|&&b| b != b'=').filter_map(move |&b| Some(match b {
		b'A'..=b'Z' => b - b'A', b'a'..=b'z' => b - b'a' + 26, b'0'..=b'9' => b - b'0' + 52,
		b'+' => 62, b'/' => 63, b'-' if url => 62, b'_' if url => 63, _ => return None,
	}))
}
fn b64_decode_inner(i: &mut Interp<'_>, args: Vec<Sv>, url: bool) -> PResult<Ret> {
	let s = i.stringify(&arg(&args, 0))?;
	let bytes = byte_view(&s).ok_or_else(|| width(i, "subroutine entry"))?;
	let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
	let mut count = 0;
	let mut acc = 0u32;
	for v in sextets(&bytes, url) {
		acc = (acc << 6) | u32::from(v);
		count += 6;
		if count >= 8 { count -= 8; out.push((acc >> count) as u8); }
	}
	Ok(bytes_result(out))
}
fn b64_decode(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { b64_decode_inner(i, a, false) }
fn b64_url_decode(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { b64_decode_inner(i, a, true) }
fn b64_encoded_length(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let s = i.stringify(&arg(&args, 0))?;
	let size = byte_view(&s).ok_or_else(|| width(i, "subroutine entry"))?.len();
	let sep = eol(i, &args)?.bytes.len();
	Ok(Ret::One(Value::Int((size.div_ceil(3) * 4 + size.div_ceil(57) * sep) as i64)))
}
fn b64_decoded_length(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let s = i.stringify(&arg(&args, 0))?;
	let bytes = byte_view(&s).ok_or_else(|| width(i, "subroutine entry"))?;
	Ok(Ret::One(Value::Int((sextets(&bytes, false).count() * 6 / 8) as i64)))
}

fn qp_encode(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	const HEX: &[u8; 16] = b"0123456789ABCDEF";
	let s = i.stringify(&arg(&args, 0))?;
	let bytes = byte_view(&s).ok_or_else(|| width(i, "subroutine entry"))?;
	let sep = eol(i, &args)?;
	let wrapping = !sep.is_empty();
	let binary = arg(&args, 2).truthy() || !wrapping;
	let mut out = PStr::default();
	let mut line_len = 0;
	let mut rest = bytes.as_ref();
	while !rest.is_empty() {
		let end = if binary { rest.len() } else { memchr::memchr(b'\n', rest).unwrap_or(rest.len()) };
		let (line, suffix) = rest.split_at(end);
		let hard = !suffix.is_empty();
		let trimmed = line.iter().rposition(|&b| !matches!(b, b' ' | b'\t')).map_or(0, |n| n + 1);
		for (n, &b) in line.iter().enumerate() {
			let quoted = !matches!(b, b'!'..=b'<' | b'>'..=b'~') && !(matches!(b, b'\t' | b' ') && n < trimmed);
			let width = if quoted { 3 } else { 1 };
			let limit = if hard && n + 1 == line.len() { 76 } else { 75 };
			if wrapping && line_len + width > limit {
				out.bytes.push(b'=');
				out.push(&sep);
				line_len = 0;
			}
			if quoted { out.bytes.extend_from_slice(&[b'=', HEX[(b >> 4) as usize], HEX[(b & 15) as usize]]); }
			else { out.bytes.push(b); }
			line_len += width;
		}
		if hard { out.push(&sep); line_len = 0; rest = &suffix[1..]; }
		else { rest = suffix; }
	}
	if wrapping && line_len != 0 { out.bytes.push(b'='); out.push(&sep); }
	Ok(Ret::One(Value::Str(out)))
}
fn qp_decode(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let s = i.stringify(&arg(&args, 0))?;
	let bytes = byte_view(&s).ok_or_else(|| width(i, "subroutine entry"))?;
	let mut out = Vec::with_capacity(bytes.len());
	let mut rest = bytes.as_ref();
	while !rest.is_empty() {
		let n = memchr::memchr(b'\n', rest).unwrap_or(rest.len());
		let (mut line, suffix) = rest.split_at(n);
		let has_nl = !suffix.is_empty();
		if has_nl {
			line = line.strip_suffix(b"\r").unwrap_or(line);
			let len = line.iter().rposition(|&b| !matches!(b, b' ' | b'\t')).map_or(0, |i| i + 1);
			line = &line[..len];
		}
		let soft = has_nl && line.ends_with(b"=");
		if soft { line = &line[..line.len() - 1]; }
		while let Some((&b, tail)) = line.split_first() {
			if b == b'=' && let Some(&[h, l]) = tail.first_chunk::<2>()
				&& let (Some(h), Some(l)) = (char::from(h).to_digit(16), char::from(l).to_digit(16)) {
				out.push(((h << 4) | l) as u8); line = &tail[2..]; continue;
			}
			out.push(b); line = tail;
		}
		if has_nl && !soft { out.push(b'\n'); }
		rest = if has_nl { &suffix[1..] } else { suffix };
	}
	Ok(bytes_result(out))
}

#[derive(Clone, Copy)]
enum Algo { Md5, Sha1, Sha224, Sha256, Sha384, Sha512, Sha512224, Sha512256 }
impl Algo {
	fn from_num(n: i64) -> Option<Self> {
		Some(match n {
			5 => Self::Md5, 1 => Self::Sha1, 224 => Self::Sha224, 256 => Self::Sha256, 384 => Self::Sha384,
			512 => Self::Sha512, 512224 => Self::Sha512224, 512256 => Self::Sha512256, _ => return None,
		})
	}
	fn number(self) -> i64 {
		match self { Self::Md5 => 5, Self::Sha1 => 1, Self::Sha224 => 224, Self::Sha256 => 256,
			Self::Sha384 => 384, Self::Sha512 => 512, Self::Sha512224 => 512224, Self::Sha512256 => 512256 }
	}
	fn size(self) -> i64 { match self { Self::Md5 => 128, Self::Sha1 => 160, Self::Sha512224 => 224, Self::Sha512256 => 256, _ => self.number() } }
	fn block(self) -> usize { if matches!(self, Self::Sha384 | Self::Sha512 | Self::Sha512224 | Self::Sha512256) { 128 } else { 64 } }
}
#[derive(Clone, Copy)]
enum Output { Raw, Hex, Base64 }
fn result(bytes: &[u8], encoding: Output) -> Ret {
	match encoding {
		Output::Raw => Ret::One(Value::bytes(bytes)),
		Output::Base64 => bytes_result(STANDARD_NO_PAD.encode(bytes).into_bytes()),
		Output::Hex => {
			const DIGITS: &[u8; 16] = b"0123456789abcdef";
			let mut out = Vec::with_capacity(bytes.len() * 2);
			for &b in bytes { out.extend_from_slice(&[DIGITS[(b >> 4) as usize], DIGITS[(b & 15) as usize]]); }
			bytes_result(out)
		}
	}
}
fn calculate<D: Digest>(mut stream: D, key: Option<&[u8]>, block: usize, data: impl FnOnce(&mut D) -> PResult<()>, out: Output) -> PResult<Ret> {
	if let Some(key) = key {
		let mut buf = [0u8; 128];
		let buf = &mut buf[..block];
		let hashed;
		let key = if key.len() > block { hashed = D::digest(key); hashed.as_slice() } else { key };
		buf[..key.len()].copy_from_slice(key);
		for b in &mut *buf { *b ^= 0x36; }
		stream.update(&*buf);
		data(&mut stream)?;
		let inner = stream.finalize();
		let mut outer = D::new();
		for b in &mut *buf { *b ^= 0x36 ^ 0x5c; }
		outer.update(buf);
		outer.update(inner);
		Ok(result(&outer.finalize(), out))
	} else {
		data(&mut stream)?;
		Ok(result(&stream.finalize(), out))
	}
}
fn functional(i: &mut Interp<'_>, mut args: Vec<Sv>, alg: Algo, hmac: bool, out: Output) -> PResult<Ret> {
	let key = if hmac {
		let key = match args.pop() { Some(cell) => i.read_sv(&cell)?, None => Value::Undef };
		Some(i.stringify(&key)?)
	} else { None };
	let key = if let Some(key) = &key { Some(byte_view(key).ok_or_else(|| width(i, "subroutine entry"))?) } else { None };
	macro_rules! hash {
		($d:ty) => { calculate(<$d>::new(), key.as_deref(), alg.block(), |stream| {
			for arg in &args {
				let value = i.read_sv(arg)?;
				let text = i.stringify(&value)?;
				let bytes = byte_view(&text).ok_or_else(|| width(i, "subroutine entry"))?;
				stream.update(bytes);
			}
			Ok(())
		}, out) };
	}
	match alg {
		Algo::Md5 => hash!(Md5), Algo::Sha1 => hash!(Sha1), Algo::Sha224 => hash!(Sha224),
		Algo::Sha256 => hash!(Sha256), Algo::Sha384 => hash!(Sha384), Algo::Sha512 => hash!(Sha512),
		Algo::Sha512224 => hash!(Sha512_224), Algo::Sha512256 => hash!(Sha512_256),
	}
}
fn load_digest(i: &mut Interp<'_>, module: &str) {
	let is_md5 = module == "Digest::MD5";
	define(i, module, &[
		("new", digest_new), ("reset", digest_reset), ("add", digest_add), ("addfile", digest_addfile),
		("add_bits", digest_add_bits), ("clone", digest_clone), ("digest", digest_raw),
		("hexdigest", digest_hex), ("b64digest", digest_b64),
	]);
	macro_rules! funcs {
		($($fn:ident => ($alg:ident, $key:expr, $out:ident)),* $(,)?) => {{
			$(fn $fn(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> { functional(i, args, Algo::$alg, $key, Output::$out) })*
			$(if is_md5 { i.define_native(concat!("Digest::MD5::", stringify!($fn)), $fn); }
			else { i.define_native_proto(concat!("Digest::SHA::", stringify!($fn)), $fn, ";@"); })*
			export(i, module, &[], &[$(stringify!($fn)),*]);
		}};
	}
	if is_md5 {
		funcs!(md5 => (Md5, false, Raw), md5_hex => (Md5, false, Hex), md5_base64 => (Md5, false, Base64));
		define(i, module, &[("context", digest_context)]);
		version(i, module, "2.58");
	} else {
		funcs!(
			sha1 => (Sha1, false, Raw), sha1_hex => (Sha1, false, Hex), sha1_base64 => (Sha1, false, Base64),
			sha224 => (Sha224, false, Raw), sha224_hex => (Sha224, false, Hex), sha224_base64 => (Sha224, false, Base64),
			sha256 => (Sha256, false, Raw), sha256_hex => (Sha256, false, Hex), sha256_base64 => (Sha256, false, Base64),
			sha384 => (Sha384, false, Raw), sha384_hex => (Sha384, false, Hex), sha384_base64 => (Sha384, false, Base64),
			sha512 => (Sha512, false, Raw), sha512_hex => (Sha512, false, Hex), sha512_base64 => (Sha512, false, Base64),
			sha512224 => (Sha512224, false, Raw), sha512224_hex => (Sha512224, false, Hex), sha512224_base64 => (Sha512224, false, Base64),
			sha512256 => (Sha512256, false, Raw), sha512256_hex => (Sha512256, false, Hex), sha512256_base64 => (Sha512256, false, Base64),
			hmac_sha1 => (Sha1, true, Raw), hmac_sha1_hex => (Sha1, true, Hex), hmac_sha1_base64 => (Sha1, true, Base64),
			hmac_sha224 => (Sha224, true, Raw), hmac_sha224_hex => (Sha224, true, Hex), hmac_sha224_base64 => (Sha224, true, Base64),
			hmac_sha256 => (Sha256, true, Raw), hmac_sha256_hex => (Sha256, true, Hex), hmac_sha256_base64 => (Sha256, true, Base64),
			hmac_sha384 => (Sha384, true, Raw), hmac_sha384_hex => (Sha384, true, Hex), hmac_sha384_base64 => (Sha384, true, Base64),
			hmac_sha512 => (Sha512, true, Raw), hmac_sha512_hex => (Sha512, true, Hex), hmac_sha512_base64 => (Sha512, true, Base64),
			hmac_sha512224 => (Sha512224, true, Raw), hmac_sha512224_hex => (Sha512224, true, Hex), hmac_sha512224_base64 => (Sha512224, true, Base64),
			hmac_sha512256 => (Sha512256, true, Raw), hmac_sha512256_hex => (Sha512256, true, Hex), hmac_sha512256_base64 => (Sha512256, true, Base64),
		);
		define(i, module, &[("algorithm", digest_algorithm), ("hashsize", digest_size),
			("getstate", digest_getstate), ("putstate", digest_putstate), ("dump", digest_dump), ("load", digest_load)]);
		i.av("Digest::SHA::EXPORT_OK").elems_mut().push(new_sv(Value::str("$errmsg")));
		version(i, module, "6.02");
	}
}

fn state(v: &Value) -> Option<(Sv, State)> {
	let Value::Ref(Ref::Scalar(data)) = v else { return None; };
	let Value::Str(bytes) = data.get() else { return None; };
	Some((Rc::clone(data), State::decode(&bytes.bytes)?))
}
fn state_arg(i: &mut Interp<'_>, args: &[Sv]) -> PResult<(Value, Sv, State)> {
	let v = arg(args, 0);
	let (cell, state) = state(&v).ok_or_else(|| i.die_msg("Not a digest object"))?;
	Ok((v, cell, state))
}
fn save(cell: &Sv, state: &State) {
	let value = match cell.replace(Value::Undef) {
		Value::Str(mut data) => {
			state.encode(&mut data.bytes);
			Value::Str(data)
		}
		_ => payload(state),
	};
	cell.set(value);
}
fn payload(state: &State) -> Value {
	let mut bytes = Vec::new();
	state.encode(&mut bytes);
	Value::Str(PStr::new(bytes, false))
}
fn class(value: &Value) -> Rc<str> {
	match value {
		Value::Ref(r) => r.blessed().unwrap_or_else(|| Rc::from("Digest::SHA")),
		_ => Rc::from(value.to_pstr().to_string_lossy().as_ref()),
	}
}
fn digest_object(class: Rc<str>, state: &State) -> Value {
	let r = Ref::Scalar(new_sv(payload(state)));
	r.bless(class);
	Value::Ref(r)
}
fn choose(args: &[Sv], old: Algo) -> Option<Algo> {
	if args.len() < 2 { return Some(old); }
	let text = text(args, 1);
	let mut digits = 0i64;
	for b in text.bytes().filter(u8::is_ascii_digit) { digits = digits.checked_mul(10)?.checked_add(i64::from(b - b'0'))?; }
	Algo::from_num(digits).filter(|n| !matches!(n, Algo::Md5))
}
fn digest_new(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let v = arg(&args, 0);
	if matches!(v, Value::Ref(_)) { return digest_reset(i, args, Cx::Scalar); }
	let class = class(&v);
	let Some(alg) = (if class.as_ref() == "Digest::MD5" || i.find_method(&class, "hashsize").is_none() {
		Some(Algo::Md5)
	} else { choose(&args, Algo::Sha1) }) else { return Ok(Ret::One(Value::Undef)); };
	Ok(Ret::One(digest_object(class, &State::new(alg))))
}
fn digest_reset(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let (v, cell, old) = state_arg(i, &args)?;
	let Some(alg) = (if matches!(old.alg, Algo::Md5) { Some(old.alg) } else { choose(&args, old.alg) }) else { return Ok(Ret::One(Value::Undef)); };
	save(&cell, &State::new(alg));
	Ok(Ret::One(v))
}
fn digest_add(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let (v, cell, mut state) = state_arg(i, &args)?;
	for arg in args.iter().skip(1) {
		let v = i.read_sv(arg)?;
		let s = i.stringify(&v)?;
		let bytes = byte_view(&s).ok_or_else(|| width(i, "subroutine entry"))?;
		state.append(&bytes);
	}
	save(&cell, &state);
	Ok(Ret::One(v))
}
fn digest_clone(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let (v, _, state) = state_arg(i, &args)?;
	Ok(Ret::One(digest_object(class(&v), &state)))
}
fn digest_result(i: &mut Interp<'_>, args: Vec<Sv>, encoding: Output) -> PResult<Ret> {
	let (_, cell, state) = state_arg(i, &args)?;
	save(&cell, &State::new(state.alg));
	let (out, len) = state.finish();
	Ok(result(&out[..len], encoding))
}
fn digest_raw(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { digest_result(i, a, Output::Raw) }
fn digest_hex(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { digest_result(i, a, Output::Hex) }
fn digest_b64(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { digest_result(i, a, Output::Base64) }
fn digest_algorithm(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { Ok(Ret::One(Value::Int(state_arg(i, &a)?.2.alg.number()))) }
fn digest_size(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { Ok(Ret::One(Value::Int(state_arg(i, &a)?.2.alg.size()))) }

fn bit_chars(state: &mut State, data: impl Iterator<Item = u8>) {
	let mut packed = [0; 128];
	let mut n = 0;
	for bit in data {
		if bit & 1 != 0 { packed[n / 8] |= 0x80 >> (n % 8); }
		n += 1;
		if n == 1024 {
			state.append(&packed);
			packed.fill(0);
			n = 0;
		}
	}
	state.append_bits(&packed, n);
}
fn digest_add_bits(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let (v, data, mut state) = state_arg(i, &args)?;
	let s = i.stringify(&arg(&args, 1))?;
	let bytes = byte_view(&s).ok_or_else(|| width(i, "subroutine entry"))?;
	let count = if args.len() > 2 { usize::try_from(arg(&args, 2).to_i64()).unwrap_or(0).min(bytes.len().saturating_mul(8)) }
	else { bytes.len() };
	if matches!(state.alg, Algo::Md5) && count % 8 != 0 {
		return Err(i.die_msg("Number of bits must be multiple of 8 for this algorithm"));
	}
	if args.len() > 2 { state.append_bits(&bytes, count); }
	else { bit_chars(&mut state, bytes.iter().copied()); }
	save(&data, &state);
	Ok(Ret::One(v))
}
fn digest_handle(i: &mut Interp<'_>, value: &Value) -> Option<Io> {
	match value {
		Value::Ref(Ref::Io(io)) => Some(Rc::clone(io)),
		Value::Glob(g) | Value::Ref(Ref::Glob(g)) => g.io.borrow().clone(),
		Value::Str(s) => { let name = i.qualify(&s.to_string_lossy()); i.handle(&name, false) }
		_ => None,
	}
}
fn digest_addfile(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let (v, data, mut state) = state_arg(i, &args)?;
	let file = arg(&args, 1);
	if let Some(io) = digest_handle(i, &file) {
		loop {
			if i.is_cancelled() { return Err(crate::perl::interp::Flow::Cancelled); }
			let s = io.borrow_mut().read(64 * 1024).map_err(|e| i.die_msg(format!("Read failed: {e}")))?;
			if s.is_empty() { break; }
			let bytes = byte_view(&s).ok_or_else(|| width(i, "subroutine entry"))?;
			state.append(&bytes);
		}
	} else {
		let file = file.to_pstr();
		if matches!(state.alg, Algo::Md5) { return Err(i.die_msg(format!("Bad filehandle: {}", file.to_string_lossy()))); }
		if file.bytes == b"-" {
			let io = i.handle("main::STDIN", false).ok_or_else(|| i.die_msg("Bad filehandle: STDIN"))?;
			loop {
				if i.is_cancelled() { return Err(crate::perl::interp::Flow::Cancelled); }
				let bytes = io.borrow_mut().read(16 * 1024).map_err(|e| i.die_msg(format!("Read failed: {e}")))?;
				if bytes.is_empty() { break; }
				state.append(&bytes.bytes);
			}
		} else {
			let path = i.resolve_path(&file.bytes);
			let mut input = i.host().fs().open(&path).map_err(|e| i.die_msg(format!("Open failed: {e}")))?;
			let mode = text(&args, 2);
			let mut buf = [0; 16 * 1024];
			let mut cr = false;
			let mut normalize = mode == "U";
			let mut first = true;
			loop {
				if i.is_cancelled() { return Err(crate::perl::interp::Flow::Cancelled); }
				let n = input.read(&mut buf).map_err(|e| i.die_msg(format!("Read failed: {e}")))?;
				if n == 0 { break; }
				let block = &buf[..n];
				if first && normalize {
					let sample = &block[..block.len().min(512)];
					normalize = !sample.contains(&0) && (std::str::from_utf8(sample).is_ok() ||
						sample.iter().filter(|&&b| !matches!(b, 7..=13 | 27 | 32..=126)).count() * 3 <= sample.len());
				}
				first = false;
				if mode == "0" {
					bit_chars(&mut state, block.iter().copied().filter(|b| matches!(b, b'0' | b'1')));
				} else if normalize {
					let mut rest = block;
					if cr && rest.first() == Some(&b'\n') { rest = &rest[1..]; }
					cr = false;
					while let Some(at) = memchr::memchr(b'\r', rest) {
						state.append(&rest[..at]);
						state.append(b"\n");
						rest = &rest[at + 1..];
						if rest.is_empty() { cr = true; }
						else if rest[0] == b'\n' { rest = &rest[1..]; }
					}
					state.append(rest);
				} else { state.append(block); }
			}
		}
	}
	save(&data, &state);
	Ok(Ret::One(v))
}

fn digest_context(i: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let (value, cell, state) = state_arg(i, &args)?;
	if args.len() > 1 {
		let h = arg(&args, 2).to_pstr();
		let b = arg(&args, 3).to_pstr();
		if let Some(h) = byte_view(&h) && let Some(b) = byte_view(&b)
			&& let Some(state) = State::from_md5_fields(arg(&args, 1).to_u64(), &h, &b) {
			save(&cell, &state);
		}
		Ok(Ret::One(value))
	} else {
		let (blocks, hash, block) = state.md5_fields();
		Ok(if cx == Cx::List {
			Ret::Many(vec![Num::UInt(blocks).into_value(), Value::bytes(&hash), Value::bytes(block)])
		} else { Ret::One(Value::bytes(block)) })
	}
}
fn digest_getstate(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let (_, _, state) = state_arg(i, &args)?;
	Ok(bytes_result(state.sha_text().into_bytes()))
}
fn restore_state(invocant: Value, bytes: &[u8]) -> Option<Value> {
	let state = State::from_sha_text(std::str::from_utf8(bytes).ok()?)?;
	if let Value::Ref(Ref::Scalar(cell)) = &invocant {
		save(cell, &state);
		Some(invocant)
	} else { Some(digest_object(class(&invocant), &state)) }
}
fn digest_putstate(_: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	Ok(Ret::One(restore_state(arg(&args, 0), &arg(&args, 1).to_pstr().bytes).unwrap_or(Value::Undef)))
}
fn digest_dump(i: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let name = arg(&args, 1).to_pstr();
	let v = arg(&args, 0);
	let image = digest_getstate(i, args, cx)?.scalar().to_pstr();
	if name.is_empty() || name.bytes == b"-" {
		let Some(stdout) = i.handle("main::STDOUT", false) else { return Ok(Ret::One(Value::Undef)); };
		if stdout.borrow_mut().write(&image).is_err() { return Ok(Ret::One(Value::Undef)); }
	} else {
		let path = i.resolve_path(&name.bytes);
		if i.host().fs().write(&path, &image.bytes).is_err() { return Ok(Ret::One(Value::Undef)); }
	}
	Ok(Ret::One(v))
}
fn digest_load(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let name = arg(&args, 1).to_pstr();
	let bytes = if name.is_empty() || name.bytes == b"-" {
		let Some(stdin) = i.handle("main::STDIN", false) else { return Ok(Ret::One(Value::Undef)); };
		let mut data = Vec::new();
		loop {
			let Ok(piece) = stdin.borrow_mut().read(8192) else { return Ok(Ret::One(Value::Undef)); };
			if piece.is_empty() { break; }
			data.extend_from_slice(&piece.bytes);
		}
		data
	} else {
		let path = i.resolve_path(&name.bytes);
		let Ok(data) = i.host().fs().read(&path) else { return Ok(Ret::One(Value::Undef)); };
		data
	};
	Ok(Ret::One(restore_state(arg(&args, 0), &bytes).unwrap_or(Value::Undef)))
}
