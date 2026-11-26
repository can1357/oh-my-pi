//! Perl picture fields, formline, and paginated write (perlform, perlfunc, perlvar).

use std::{iter, rc::Rc};

use crate::perl::{
	ast::{Builtin, Call, Format}, interp::{Flow, FormatArgs, Interp, PResult, Ret},
	io::Io, value::{PStr, Sv, Value},
};

use super::{args, fail, global, handles, io_name, one, output, set_global, yes};

/// A compiled format: picture rows with their argument closures.
pub(in crate::perl) struct Definition { rows: Vec<Row> }
struct Row { picture: Picture, values: Option<FormatArgs> }
struct Picture { fields: usize, items: Vec<Item>, suppress: bool, repeat: bool, newline: bool }
enum Item { Literal(PStr), Field(Field) }
struct Field { kind: FieldKind, width: usize, caret: bool }
enum FieldKind {
	Text { align: usize, ellipsis: bool }, Numeric { precision: usize, point: bool, zero: bool }, Lines,
}

/// Per-handle pagination state; `top_set` records an explicit `$^`, whose format must exist.
pub(super) struct Page { body: PStr, top: PStr, top_set: bool, len: i64, left: i64, number: i64 }

fn page<'i>(interp: &'i mut Interp<'_>, handle: &Io) -> &'i mut Page {
	let key = io_name(handle);
	if !interp.sys.pages.get(&key).is_some_and(|(io, _)| io.strong_count() != 0) {
		let (_, name) = handles::identity(interp, handle);
		interp.sys.pages.retain(|_, (io, _)| io.strong_count() != 0);
		let name = if name.is_empty() { "$__ANONIO__" } else { &name };
		interp.sys.pages.insert(key, (Rc::downgrade(handle), Page {
			body: PStr::from_str(name), top: PStr::from_str(&format!("{name}_TOP")), top_set: false, len: 60, left: 0, number: 0,
		}));
	}
	// A live reference to the handle keeps its entry unique even after reentrant writes.
	&mut interp.sys.pages.entry(key).or_insert_with(|| (Rc::downgrade(handle), Page {
		body: PStr::default(), top: PStr::default(), top_set: false, len: 60, left: 0, number: 0,
	})).1
}

/// Read a selected handle's perlform variables.
pub(in crate::perl) fn format_var(interp: &mut Interp<'_>, name: &str) -> Value {
	let io = interp.selected();
	let page = page(interp, &io);
	match name {
		"~" => Value::Str(page.body.clone()), "^" => Value::Str(page.top.clone()),
		"=" => Value::Int(page.len), "-" => Value::Int(page.left), "%" => Value::Int(page.number),
		_ => Value::Undef,
	}
}

/// Assign a selected handle's perlform variables.
pub(in crate::perl) fn set_format_var(interp: &mut Interp<'_>, name: &str, value: Value) -> PResult<()> {
	let io = interp.selected();
	match name {
		"~" | "^" => {
			let v = interp.stringify(&value)?;
			let page = page(interp, &io);
			if name == "~" { page.body = v; } else { page.top = v; page.top_set = true; }
		},
		"=" => page(interp, &io).len = value.to_i64(),
		"-" => page(interp, &io).left = value.to_i64().max(0),
		"%" => page(interp, &io).number = value.to_i64(),
		_ => {},
	}
	Ok(())
}

/// Compile a perlform declaration's picture and Perl argument expressions.
/// A format whose argument lines fail to compile is not created; Err is the
/// diagnostic for the enclosing compilation.
pub(in crate::perl) fn define_format(interp: &mut Interp<'_>, format: &Format) -> Result<(), String> {
	let pkg = interp.package();
	let name: Rc<str> = if format.name.contains("::") { format.name.clone() } else { format!("{pkg}::{}", format.name).into() };
	let loc = interp.location();
	let rows = compile(interp, &format.lines, &loc.file, loc.line)?;
	interp.sys.formats.insert(name, Rc::new(Definition { rows }));
	Ok(())
}

/// Split a format body into picture rows, compiling each argument line in the
/// declaring lexical scope (formats close over lexicals like named subs).
fn compile(interp: &mut Interp<'_>, src: &PStr, file: &str, start: u32) -> Result<Vec<Row>, String> {
	let mut rows = Vec::new();
	let mut lines = src.bytes.split_inclusive(|&b| b == b'\n').enumerate();
	while let Some((i, bytes)) = lines.next() {
		if bytes.starts_with(b"#") { continue; }
		let picture = picture(bytes, src.utf8);
		let values = if picture.fields == 0 { None } else {
			let (_, args) = lines.next().ok_or("Format not terminated")?;
			let args = args.trim_ascii();
			let mut value = PStr::new(args.to_vec(), src.utf8);
			let line = start.saturating_add(i as u32 + 2);
			if args.is_empty() { return Err(format!("Missing format arguments on line {}", line.saturating_sub(1))); }
			if args.starts_with(b"{") {
				// A braced argument block runs to its matching brace, possibly over
				// several lines (even holding a nested format), and is evaluated as a block.
				let depth = |bytes: &[u8]| bytes.iter().fold(0i64, |d, &b| d + i64::from(b == b'{') - i64::from(b == b'}'));
				let mut open = depth(args);
				while open > 0 {
					let (_, more) = lines.next().ok_or("Format not terminated")?;
					if !value.bytes.ends_with(b"\n") { value.bytes.push(b'\n'); }
					value.bytes.extend_from_slice(more);
					open += depth(more);
				}
				let mut block = b"do ".to_vec();
				block.append(&mut value.bytes);
				value.bytes = block;
			}
			// An argument line continues while it holds an unfinished construct
			// (a string or `${ ... }` running onto the next line).
			let args = loop {
				let mut source = value.clone();
				source.bytes.push(b';');
				match interp.compile_format_args(&source, file, line) {
					Ok(args) => break args,
					Err(message) if incomplete(&message) => {
						let Some((_, more)) = lines.next() else { return Err(message) };
						if !value.bytes.ends_with(b"\n") { value.bytes.push(b'\n'); }
						value.bytes.extend_from_slice(more);
					},
					Err(message) => return Err(message),
				}
			};
			Some(args)
		};
		rows.push(Row { picture, values });
	}
	Ok(rows)
}

/// Whether a parse error only says the source ended inside a construct.
fn incomplete(message: &str) -> bool {
	message.contains("Can't find string terminator") || message.contains("Missing right curly") || message.contains("at EOF")
}

fn picture(bytes: &[u8], utf8: bool) -> Picture {
	let newline = bytes.ends_with(b"\n");
	let bytes = bytes.strip_suffix(b"\n").unwrap_or(bytes);
	let bytes = bytes.strip_suffix(b"\r").unwrap_or(bytes);
	let mut items = Vec::new();
	let (mut fields, mut at, mut lit) = (0, 0, 0);
	let (mut suppress, mut repeat) = (false, false);
	while let Some(&b) = bytes.get(at) {
		if matches!(b, b'@' | b'^' | b'~') {
			if lit != at { items.push(Item::Literal(PStr::new(bytes[lit..at].to_vec(), utf8))); }
			if b == b'~' {
				suppress = true;
				let n = if bytes.get(at + 1) == Some(&b'~') { repeat = true; 2 } else { 1 };
				items.push(Item::Literal(PStr::new(vec![b' '; n], utf8)));
				at += n;
			} else {
				let caret = b == b'^';
				let (kind, width, end) = field(bytes, at);
				items.push(Item::Field(Field { kind, width, caret }));
				fields += 1;
				at = end;
			}
			lit = at;
		} else { at += 1; }
	}
	if lit != bytes.len() { items.push(Item::Literal(PStr::new(bytes[lit..].to_vec(), utf8))); }
	Picture { fields, items, suppress, repeat, newline }
}

fn field(bytes: &[u8], at: usize) -> (FieldKind, usize, usize) {
	let mut end = at + 1;
	match bytes.get(end).copied() {
		Some(b'*') => (FieldKind::Lines, 0, end + 1),
		// `@#`, `@.#` and `@0#` start numeric fields; a lone `0` or `.` is literal text.
		Some(b'#') | Some(b'.' | b'0') if bytes.get(end) == Some(&b'#') || bytes.get(end + 1) == Some(&b'#') => {
			let zero = bytes.get(end) == Some(&b'0');
			if zero { end += 1; }
			while bytes.get(end) == Some(&b'#') { end += 1; }
			let point = bytes.get(end) == Some(&b'.');
			let mut precision = 0;
			if point {
				end += 1;
				while bytes.get(end) == Some(&b'#') { end += 1; precision += 1; }
			}
			(FieldKind::Numeric { precision, point, zero }, end - at, end)
		},
		next => {
			let align = match next { Some(b'|') => 1, Some(b'>') => 2, _ => 0 };
			let pad = [b'<', b'|', b'>'][align];
			while bytes.get(end) == Some(&pad) { end += 1; }
			let width = end - at;
			let ellipsis = bytes.get(end..).is_some_and(|s| s.starts_with(b"..."));
			(FieldKind::Text { align, ellipsis }, width, end + if ellipsis { 3 } else { 0 })
		},
	}
}

pub(super) fn call(interp: &mut Interp<'_>, b: Builtin, call: &Call) -> PResult<Ret> {
	if b == Builtin::Write { return write(interp, call); }
	let Some(expr) = &call.args else { return Err(interp.die_msg("Not enough arguments for formline")); };
	let values = interp.eval_aliases(expr)?;
	let Some((first, values)) = values.split_first() else { return Err(interp.die_msg("Not enough arguments for formline")); };
	let first = interp.read_sv(first)?;
	let mut source = interp.stringify(&first)?;
	// Under `use bytes` the picture is its encoded bytes.
	if interp.hints().bytes { source.utf8 = false; }
	let mut dest = global(interp, "main::^A")?.to_pstr();
	let mut offset = 0usize;
	for line in source.bytes.split_inclusive(|&b| b == b'\n') {
		let picture = picture(line, source.utf8);
		let end = offset.saturating_add(picture.fields).min(values.len());
		let args = values.get(offset..end).unwrap_or_default();
		loop {
			let Some((text, consumed)) = render(interp, &picture, args)? else { break; };
			dest.push(&text);
			if !picture.repeat { break; }
			if !consumed { return Err(interp.die_msg("Repeated format line will never terminate")); }
		}
		offset = end;
	}
	set_global(interp, "main::^A", Value::Str(dest))?;
	Ok(yes())
}

fn definition(interp: &mut Interp<'_>, name: &PStr, handle: &Io) -> Option<Rc<Definition>> {
	let name = name.to_string_lossy();
	if name.contains("::") { return interp.sys.formats.get(name.as_ref()).cloned(); }
	let (identity, _) = handles::identity(interp, handle);
	let package = match &identity {
		Value::Str(s) => s.to_string_lossy().rsplit_once("::").map(|(pkg, _)| Rc::<str>::from(pkg)),
		Value::Ref(crate::perl::value::Ref::Glob(g)) => Some(g.pkg.clone()),
		_ => None,
	};
	let pkg = package.unwrap_or_else(|| interp.package());
	let qualified = format!("{pkg}::{name}");
	interp.sys.formats.get(qualified.as_str()).cloned().or_else(|| {
		let qualified = format!("{}::{name}", interp.package());
		interp.sys.formats.get(qualified.as_str()).cloned()
	})
}

fn write(interp: &mut Interp<'_>, call: &Call) -> PResult<Ret> {
	let handle = match args(call).first() {
		Some(e) => match handles::from_expr(interp, e)? { Some(io) => io, None => return Ok(fail(interp, libc::EBADF)) },
		None => interp.selected(),
	};
	let body_name = page(interp, &handle).body.clone();
	let body = definition(interp, &body_name, &handle).ok_or_else(|| interp.die_msg(format!("Undefined format \"{}\" called", body_name.to_string_lossy())))?;
	let mut dest = global(interp, "main::^A")?.to_pstr();
	match execute(interp, &body, &mut dest) {
		// `return` in an argument line leaves the format: nothing is written and write is false.
		Err(Flow::Return(_)) => return Ok(one(super::bool_value(false))),
		r => r?,
	}
	let mut left = line_count(&dest);
	let mut rest = dest.bytes.as_slice();
	while !rest.is_empty() {
		if interp.is_cancelled() { return Err(Flow::Cancelled); }
		let (space, top, top_set) = { let p = page(interp, &handle); (p.left, p.top.clone(), p.top_set) };
		if left > space {
			let header = definition(interp, &top, &handle);
			if header.is_none() && top_set {
				return Err(interp.die_msg(format!("Undefined top format \"{}\" called", top.to_string_lossy())));
			}
			if let Some(header) = header {
				let p = page(interp, &handle);
				let continued = p.number != 0;
				p.number = p.number.saturating_add(1);
				p.left = p.len;
				if continued {
					let ff = global(interp, "main::^L")?;
					let ff = interp.stringify(&ff)?;
					if !output::write(interp, &handle, &ff, "write")? { return Ok(one(Value::Undef)); }
				}
				let mut text = PStr::default();
				execute(interp, &header, &mut text)?;
				if !output::write(interp, &handle, &text, "write")? { return Ok(one(Value::Undef)); }
				let p = page(interp, &handle);
				p.left = p.left.saturating_sub(line_count(&text));
			} else {
				let p = page(interp, &handle);
				p.left = if space <= 0 { p.len } else { space };
			}
		}
		let available = page(interp, &handle).left.max(1);
		let end = if available >= left { rest.len() } else {
			memchr::memchr_iter(b'\n', rest).nth(available as usize - 1).map_or(rest.len(), |at| at + 1)
		};
		let bytes = &rest[..end];
		let count = if end == rest.len() { left } else { available };
		let written = if bytes.len() == dest.bytes.len() {
			output::write(interp, &handle, &dest, "write")?
		} else {
			output::write(interp, &handle, &PStr::new(bytes.to_vec(), dest.utf8), "write")?
		};
		if !written { return Ok(one(Value::Undef)); }
		let p = page(interp, &handle);
		p.left = p.left.saturating_sub(count).max(0);
		left = left.saturating_sub(count);
		rest = &rest[end..];
	}
	set_global(interp, "main::^A", Value::Str(PStr::default()))?;
	Ok(yes())
}

fn line_count(text: &PStr) -> i64 {
	memchr::memchr_iter(b'\n', &text.bytes).count() as i64 + i64::from(!text.is_empty() && !text.bytes.ends_with(b"\n"))
}

fn execute(interp: &mut Interp<'_>, def: &Definition, out: &mut PStr) -> PResult<()> {
	for row in &def.rows {
		loop {
			if interp.is_cancelled() { return Err(Flow::Cancelled); }
			let values = match &row.values { Some(args) => interp.eval_format_args(args)?, None => Vec::new() };
			let Some((line, _)) = render(interp, &row.picture, &values)? else { break; };
			out.push(&line);
			if !row.picture.repeat { break; }
		}
	}
	Ok(())
}

fn render(interp: &mut Interp<'_>, picture: &Picture, values: &[Sv]) -> PResult<Option<(PStr, bool)>> {
	let mut out = PStr::default();
	let mut active = false;
	let mut consumed = false;
	let mut vals = values.iter();
	for item in &picture.items {
		let field = match item { Item::Literal(s) => { out.push(s); continue; }, Item::Field(f) => f };
		let sv = vals.next();
		let value = match sv { Some(sv) => interp.read_sv(sv)?, None => Value::Undef };
		let (text, before, after) = match field.kind {
			FieldKind::Numeric { precision, point, zero } => {
				if field.caret && value.is_undef() {
					(PStr::default(), field.width, 0)
				} else {
					if picture.repeat && !field.caret { return Err(interp.die_msg("Repeated format line will never terminate (~~ and @#)")); }
					let num = interp.numify(&value)?.to_f64();
					let text = if point && precision == 0 { format!("{num:.0}.") } else { format!("{num:.precision$}") };
					let text = if text.len() > field.width { "#".repeat(field.width) }
					else if zero { format!("{num:0width$.precision$}", width = field.width) }
					else { text };
					let pad = field.width.saturating_sub(text.len());
					(PStr::new(text.into_bytes(), false), pad, 0)
				}
			},
			FieldKind::Lines => {
				let mut text = interp.stringify(&value)?;
				if field.caret {
					let at = memchr::memchr(b'\n', &text.bytes).unwrap_or(text.bytes.len());
					let end = at + usize::from(at < text.bytes.len());
					active |= end != 0;
					if let Some(sv) = sv {
						consumed |= end != 0;
						interp.write_sv(sv, Value::Str(PStr::new(text.bytes[end..].to_vec(), text.utf8)))?;
					}
					text.bytes.truncate(at);
				} else if text.bytes.ends_with(b"\n") { text.bytes.pop(); }
				(text, 0, 0)
			},
			FieldKind::Text { align, ellipsis } => {
				let mut text = interp.stringify(&value)?;
				// The `...` columns belong to the field: text fills them unless more
				// remains, in which case the last three columns turn into dots.
				let full = field.width + if ellipsis { 3 } else { 0 };
				let trunc = if field.caret {
					let breaks = global(interp, "main:::")?.to_pstr();
					let (take, skip) = split(&text, full, &breaks);
					let trunc = text.bytes.get(skip..).is_some_and(|s| !s.trim_ascii().is_empty());
					if let Some(sv) = sv {
						consumed |= skip != 0;
						interp.write_sv(sv, Value::Str(PStr::new(text.bytes[skip..].to_vec(), text.utf8)))?;
					}
					text.bytes.truncate(take);
					trunc
				} else {
					let end = memchr::memchr(b'\n', &text.bytes).unwrap_or(text.bytes.len());
					let cut = text.char_to_byte(full).min(end);
					let trunc = text.bytes.get(cut..).is_some_and(|s| !s.trim_ascii().is_empty());
					text.bytes.truncate(cut);
					trunc
				};
				for b in &mut text.bytes { if *b < b' ' || *b == 127 { *b = b' '; } }
				if ellipsis && trunc {
					let len = text.char_len();
					text.bytes.extend(iter::repeat_n(b' ', full.saturating_sub(len)));
					let mut keep = text.char_to_byte(full - 3);
					if text.bytes[keep..].starts_with(b"   ") {
						while keep > 0 && text.bytes[keep - 1].is_ascii_whitespace() { keep -= 1; }
					}
					text.bytes.truncate(keep);
					text.push_bytes(b"...");
				}
				let pad = full.saturating_sub(text.char_len());
				let before = match align { 1 => pad / 2, 2 => pad, _ => 0 };
				(text, before, pad - before)
			},
		};
		active |= !text.bytes.trim_ascii().is_empty();
		out.bytes.extend(iter::repeat_n(b' ', before));
		out.push(&text);
		out.bytes.extend(iter::repeat_n(b' ', after));
	}
	if picture.suppress && !active { return Ok(None); }
	// As in perl's formline, only a line ending in a newline loses its trailing spaces.
	if picture.newline {
		while out.bytes.last() == Some(&b' ') { out.bytes.pop(); }
		out.bytes.push(b'\n');
	}
	Ok(Some((out, consumed)))
}

fn split(text: &PStr, width: usize, breaks: &PStr) -> (usize, usize) {
	let limit = text.char_to_byte(width);
	let first_cr = memchr::memchr(b'\r', &text.bytes);
	if let Some(cr) = first_cr.filter(|&i| i <= limit) { return (cr, cr + 1); }
	if limit == text.bytes.len() { return (limit, limit); }
	let end = text.bytes.get(limit).copied();
	let mut split = limit;
	if end.is_some_and(|b| !b.is_ascii_whitespace()) {
		let prefix = &text.bytes[..limit];
		if let Some(i) = prefix.iter().rposition(|&b| breaks.chars().any(|cp| cp == u32::from(b))) {
			if i != 0 { split = if prefix[i].is_ascii_whitespace() { i } else { i + 1 }; }
		}
	}
	let mut skip = split;
	while text.bytes.get(skip).is_some_and(u8::is_ascii_whitespace) { skip += 1; }
	(split, skip)
}
