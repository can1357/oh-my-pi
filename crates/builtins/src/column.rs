//! `column` builtin: columnate lists, or lay input out as a table.
//!
//! util-linux `column` (2.41) behavior, implemented here rather than ported:
//! macOS ships BSD `column`, which rejects every table option scripts reach
//! for (`-N`, `-R`, `-O`, `-J`, …). Fill mode (`-c`, `-x`, `-S`) lays entries
//! out in tab- or space-separated columns. Table mode (`-t`) cuts lines into
//! cells and pads each column to its widest cell, with headers, hidden,
//! reordered and right-aligned columns, JSON output (`-J`), and trees
//! (`-r`/`-i`/`-p`).
//!
//! Like util-linux, a table is fitted to the output width (`-c`, else the
//! terminal's, `COLUMNS`, or 80) even when piped. Only columns marked `-T`
//! (truncate), `-W` (wrap) or `-E` (no extremes; by default the last column)
//! shrink, never below their header: the widest goes first, one cell at a
//! time. util-linux ranks them by width statistics instead, so a shrunk
//! table's widths can differ from its by a few cells. Widths ignore ANSI
//! escape sequences; invalid UTF-8 input bytes print as `\xHH`.

use std::{
	borrow::Cow,
	cmp::Reverse,
	collections::HashMap,
	ffi::OsString,
	fmt::Write as _,
	io::{Read, Write},
	iter,
};

use clap::Parser;

use crate::{
	host::{Host, Utility, format_usage, strip_errno},
	locale,
};

/// Cells between tab stops.
const TAB: usize = 8;

/// Parsed `column` invocation.
#[derive(Parser)]
#[command(
	name = "column",
	version = "2.41",
	about = "Columnate lists.",
	override_usage = format_usage("column [options] [<file>...]"),
	args_override_self = true,
	infer_long_args = true
)]
pub(crate) struct Column {
	/// create a table
	#[arg(short, long)]
	table:               bool,
	/// table name for JSON output
	#[arg(short = 'n', long, value_name = "name", allow_hyphen_values = true)]
	table_name:          Option<String>,
	/// specify order of output columns
	#[arg(short = 'O', long, value_name = "columns", allow_hyphen_values = true)]
	table_order:         Option<String>,
	/// define column
	#[arg(
		short = 'C',
		long,
		value_name = "properties",
		allow_hyphen_values = true,
		conflicts_with = "table_columns"
	)]
	table_column:        Vec<String>,
	/// comma separated columns names
	#[arg(short = 'N', long, value_name = "names", allow_hyphen_values = true)]
	table_columns:       Option<String>,
	/// maximal number of input columns
	#[arg(short = 'l', long, value_name = "num", allow_hyphen_values = true)]
	table_columns_limit: Option<String>,
	/// don't count long text from the columns to column width
	#[arg(short = 'E', long, value_name = "columns", allow_hyphen_values = true)]
	table_noextreme:     Option<String>,
	/// don't print header
	#[arg(short = 'd', long)]
	table_noheadings:    bool,
	/// fill all available space
	#[arg(short = 'm', long)]
	table_maxout:        bool,
	/// repeat header for each page
	#[arg(short = 'e', long)]
	table_header_repeat: bool,
	/// don't print the columns
	#[arg(short = 'H', long, value_name = "columns", allow_hyphen_values = true)]
	table_hide:          Option<String>,
	/// right align text in these columns
	#[arg(short = 'R', long, value_name = "columns", allow_hyphen_values = true)]
	table_right:         Option<String>,
	/// truncate text in the columns when necessary
	#[arg(short = 'T', long, value_name = "columns", allow_hyphen_values = true)]
	table_truncate:      Option<String>,
	/// wrap text in the columns when necessary
	#[arg(short = 'W', long, value_name = "columns", allow_hyphen_values = true)]
	table_wrap:          Option<String>,
	/// don't ignore empty lines
	#[arg(short = 'L', long, alias = "table-empty-lines")]
	keep_empty_lines:    bool,
	/// use JSON output format for table
	#[arg(short = 'J', long, conflicts_with = "fillrows")]
	json:                bool,
	/// column to use tree-like output for the table
	#[arg(short = 'r', long, value_name = "column", allow_hyphen_values = true)]
	tree:                Option<String>,
	/// line ID to specify child-parent relation
	#[arg(short = 'i', long, value_name = "column", allow_hyphen_values = true)]
	tree_id:             Option<String>,
	/// parent to specify child-parent relation
	#[arg(short = 'p', long, value_name = "column", allow_hyphen_values = true)]
	tree_parent:         Option<String>,
	/// width of output in number of characters
	#[arg(short = 'c', long, alias = "columns", value_name = "width", allow_hyphen_values = true)]
	output_width:        Option<String>,
	/// columns separator for table output (default is two spaces)
	#[arg(short = 'o', long, value_name = "string", allow_hyphen_values = true)]
	output_separator:    Option<String>,
	/// possible table delimiters
	#[arg(short = 's', long, value_name = "string", allow_hyphen_values = true)]
	separator:           Option<String>,
	/// fill rows before columns
	#[arg(short = 'x', long, conflicts_with = "table")]
	fillrows:            bool,
	/// minimal whitespaces between columns (no tabs)
	#[arg(short = 'S', long, value_name = "number", allow_hyphen_values = true)]
	use_spaces:          Option<String>,
	/// files to read, else standard input
	#[arg(value_name = "file")]
	files:               Vec<OsString>,
}

impl Utility for Column {
	/// Every util-linux option is implemented; BSD `column` has no others.
	const DEFERS_TO_PATH: bool = false;
	const NAME: &'static str = "column";

	fn run(self, host: &mut Host) -> i32 {
		let mut out = Vec::new();
		if let Err(message) = self.render(host, &mut out) {
			host.error(message, 1);
			return 1;
		}
		let written = {
			let mut stdout = host.stdout_writer();
			stdout.write_all(&out).and_then(|()| stdout.flush())
		};
		if let Err(err) = written {
			host.error(strip_errno(&err), 1);
			return 1;
		}
		host.exit_code()
	}
}

impl Column {
	/// Validates the options, reads every input, and renders the result
	/// into `out`. Errors are fatal diagnostics; an unreadable operand is
	/// reported on the spot and skipped.
	fn render(&self, host: &mut Host, out: &mut Vec<u8>) -> Result<(), String> {
		let width = match self.output_width.as_deref() {
			Some("unlimited") => 0,
			Some(value) => parse_count(value, "invalid columns argument")?,
			None => terminal_extent(host, |(columns, _)| columns, "COLUMNS").unwrap_or(80),
		};
		// 0 (`unlimited`) leaves the output width unrestricted.
		let width = (width > 0).then_some(width);
		let limit = match self.table_columns_limit.as_deref() {
			Some(value) => match parse_count(value, "invalid columns limit argument")? {
				0 => return Err("columns limit must be greater than zero".to_owned()),
				limit => Some(limit),
			},
			None => None,
		};
		let gap = self
			.use_spaces
			.as_deref()
			.map(|value| parse_count(value, "invalid spaces argument"))
			.transpose()?;

		if self.tree.is_some() && (self.tree_id.is_none() || self.tree_parent.is_none()) {
			return Err(
				"options --tree-id and --tree-parent are required for tree formatting".to_owned(),
			);
		}
		let table = self.table || self.json || self.tree.is_some();
		let table_only = [
			&self.table_order,
			&self.table_name,
			&self.table_wrap,
			&self.table_hide,
			&self.table_truncate,
			&self.table_noextreme,
			&self.table_right,
			&self.table_columns,
		];
		if !table
			&& (table_only.iter().any(|option| option.is_some()) || !self.table_column.is_empty())
		{
			return Err("option --table required for all --table-*".to_owned());
		}
		if self.json && self.table_columns.is_none() && self.table_column.is_empty() {
			return Err("option --table-columns or --table-column required for --json".to_owned());
		}

		let lines = read_lines(host, &self.files)?;
		if table {
			self.render_table(host, &lines, width, limit, out)
		} else {
			let entries: Vec<&str> = lines
				.iter()
				.filter_map(|line| match line {
					Some(text) => Some(text.as_str()),
					None => self.keep_empty_lines.then_some(""),
				})
				.collect();
			let order = if self.fillrows {
				Fill::Rows
			} else {
				Fill::Columns
			};
			fill(&entries, width, order, gap, out);
			Ok(())
		}
	}

	fn render_table(
		&self,
		host: &Host,
		lines: &[Option<String>],
		width: Option<usize>,
		limit: Option<usize>,
		out: &mut Vec<u8>,
	) -> Result<(), String> {
		let mut table = Table::new(self);
		let split = Splitter { separators: self.separator.as_deref(), limit };
		for line in lines {
			match line {
				Some(text) => table.add_line(split.cells(text))?,
				None if self.keep_empty_lines => table.rows.push(Row::default()),
				None => {},
			}
		}
		if table.rows.is_empty() {
			return Ok(());
		}
		table.modify(self)?;

		if self.json {
			table.print_json(self.table_name.as_deref().unwrap_or("table"), out);
			return Ok(());
		}
		let symbols = if locale::ctype_is_utf8(host) {
			&UTF8_SYMBOLS
		} else {
			&ASCII_SYMBOLS
		};
		let arts: Vec<String> = (0..table.rows.len())
			.map(|row| table.art(row, symbols))
			.collect();
		let separator = self.output_separator.as_deref().unwrap_or("  ");
		table.measure(&arts, width);
		if let Some(width) = width {
			table.fit(width, text_width(separator));
		}
		// Pages exist only on a sized output; a tree prints its header once.
		let page = (self.table_header_repeat && width.is_some() && !table.is_tree())
			.then(|| terminal_extent(host, |(_, rows)| rows, "LINES").unwrap_or(24));
		let mut printer = Printer {
			table: &table,
			arts: &arts,
			symbols,
			visible: table.visible().collect(),
			separator,
			out,
			lines: 0,
		};
		printer.print(&table.order(), page);
		Ok(())
	}
}

/// A count option's value (`-c`, `-l`, `-S`), or `<what>: '<value>'`.
fn parse_count(value: &str, what: &str) -> Result<usize, String> {
	value
		.parse::<u32>()
		.map(|count| count as usize)
		.map_err(|_| format!("{what}: '{value}'"))
}

/// One extent of the terminal on stdout, else the positive integer in
/// environment variable `var`: util-linux's `get_terminal_dimension`.
fn terminal_extent(host: &Host, pick: fn((u16, u16)) -> u16, var: &str) -> Option<usize> {
	host
		.stdout
		.window_size()
		.map(|size| usize::from(pick(size)))
		.filter(|&extent| extent > 0)
		.or_else(|| {
			host
				.var(var)?
				.trim_start_matches(|c: char| c.is_ascii_whitespace())
				.parse::<i32>()
				.ok()
				.filter(|&extent| extent > 0)
				.map(|extent| extent as usize)
		})
}

/// Every input line — of the operands, else of stdin — as util-linux reads
/// it: cut at a NUL, invalid UTF-8 bytes spelled `\xHH`, and `None` when
/// blank. An operand that cannot be opened is reported and skipped; a read
/// error is fatal.
fn read_lines(host: &mut Host, files: &[OsString]) -> Result<Vec<Option<String>>, String> {
	let read_failed = |err: std::io::Error| format!("read failed: {}", strip_errno(&err));
	let mut lines = Vec::new();
	let mut buf = Vec::new();
	if files.is_empty() {
		host.stdin.read_to_end(&mut buf).map_err(read_failed)?;
		split_lines(&buf, &mut lines);
	}
	for name in files {
		match host.fs().open(host.resolve(name)) {
			Ok(mut file) => {
				buf.clear();
				file.read_to_end(&mut buf).map_err(read_failed)?;
				split_lines(&buf, &mut lines);
			},
			Err(err) => host.error(format!("{}: {}", name.display(), strip_errno(&err)), 1),
		}
	}
	Ok(lines)
}

fn split_lines(buf: &[u8], lines: &mut Vec<Option<String>>) {
	for line in buf.split_inclusive(|&byte| byte == b'\n') {
		let line = line.strip_suffix(b"\n").unwrap_or(line);
		let line = line
			.iter()
			.position(|&byte| byte == 0)
			.map_or(line, |nul| &line[..nul]);
		let blank = line.iter().all(|byte| b" \t\n\x0b\x0c\r".contains(byte));
		lines.push((!blank).then(|| decode(line)));
	}
}

/// `bytes` as text, each byte of an invalid UTF-8 sequence spelled `\xHH`.
fn decode(bytes: &[u8]) -> String {
	let mut text = String::with_capacity(bytes.len());
	for chunk in bytes.utf8_chunks() {
		text.push_str(chunk.valid());
		for byte in chunk.invalid() {
			let _ = write!(text, "\\x{byte:02x}");
		}
	}
	text
}

/// Terminal cells `text` takes, ANSI escape sequences excluded.
fn text_width(text: &str) -> usize {
	xutf::width_ansi_str(text)
}

/// The longest prefix of `text` at most `max` cells wide, and its width. ANSI
/// escape sequences take no cells and stay whole.
fn truncate(text: &str, max: usize) -> (&str, usize) {
	let (mut end, mut used) = (0, 0);
	while end < text.len() {
		let rest = &text[end..];
		let plain = rest.find('\x1b').unwrap_or(rest.len());
		let (run, run_width) = xutf::truncate_measured_str(&rest[..plain], max - used);
		end += run.len();
		used += run_width;
		if run.len() < plain || plain == rest.len() {
			break;
		}
		end += escape_len(&rest[plain..]);
	}
	(&text[..end], used)
}

/// Bytes of the escape sequence `text` starts with: a CSI (`ESC [ … final`),
/// an OSC (`ESC ] …` up to BEL or `ESC \`), or ESC and one character.
fn escape_len(text: &str) -> usize {
	let bytes = text.as_bytes();
	match bytes.get(1) {
		Some(b'[') => {
			let params = bytes[2..]
				.iter()
				.take_while(|byte| (0x20..=0x3f).contains(*byte))
				.count();
			let end = 2 + params;
			end + usize::from(
				bytes
					.get(end)
					.is_some_and(|byte| (0x40..=0x7e).contains(byte)),
			)
		},
		Some(b']') => (2..bytes.len())
			.find_map(|at| match bytes[at] {
				0x07 => Some(at + 1),
				b'\\' if bytes[at - 1] == 0x1b => Some(at + 1),
				_ => None,
			})
			.unwrap_or(bytes.len()),
		Some(_) => 1 + text[1..].chars().next().map_or(0, char::len_utf8),
		None => 1,
	}
}

/// The order fill mode places entries in.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Fill {
	/// Down each column (the default).
	Columns,
	/// Across each row (`-x`).
	Rows,
}

/// Fill mode: `entries` in as many columns as fit `width` (one per line when
/// none does), filled down each column (or across each row with `-x`), and
/// separated by tabs (or by spaces, at least `gap` of them, with `-S`).
fn fill(
	entries: &[&str],
	width: Option<usize>,
	order: Fill,
	gap: Option<usize>,
	out: &mut Vec<u8>,
) {
	let widths: Vec<usize> = entries.iter().map(|entry| text_width(entry)).collect();
	let widest = widths.iter().copied().max().unwrap_or(0);
	let Some(width) = width.filter(|&width| widest < width) else {
		for entry in entries {
			out.extend_from_slice(entry.as_bytes());
			out.push(b'\n');
		}
		return;
	};
	// Cells per column: the widest entry and its gap, or the next tab stop.
	let slot = match gap {
		Some(gap) => widest + gap,
		None => (widest + TAB) & !(TAB - 1),
	}
	.max(1);
	// The last column needs no gap after it.
	let columns = ((width + gap.unwrap_or(0)) / slot).max(1);
	// Advances `used` cells to column edge `end`.
	let pad = |out: &mut Vec<u8>, used: &mut usize, end: usize| match gap {
		Some(_) => {
			out.extend(iter::repeat_n(b' ', end.saturating_sub(*used)));
			*used = (*used).max(end);
		},
		None => loop {
			let stop = (*used + TAB) & !(TAB - 1);
			if stop > end {
				break;
			}
			out.push(b'\t');
			*used = stop;
		},
	};

	if order == Fill::Rows {
		let (mut column, mut used, mut end) = (0, 0, slot);
		for (at, entry) in entries.iter().enumerate() {
			out.extend_from_slice(entry.as_bytes());
			used += widths[at];
			if at + 1 == entries.len() {
				break;
			}
			column += 1;
			if column == columns {
				out.push(b'\n');
				(column, used, end) = (0, 0, slot);
			} else {
				pad(out, &mut used, end);
				end += slot;
			}
		}
		if used > 0 {
			out.push(b'\n');
		}
	} else {
		let rows = entries.len().div_ceil(columns);
		for row in 0..rows {
			let (mut used, mut end) = (0, slot);
			let mut at = row;
			loop {
				out.extend_from_slice(entries[at].as_bytes());
				used += widths[at];
				at += rows;
				if at >= entries.len() {
					break;
				}
				pad(out, &mut used, end);
				end += slot;
			}
			out.push(b'\n');
		}
	}
}

/// How table mode cuts a line into cells.
struct Splitter<'a> {
	/// `-s`: every one of these characters ends a cell, so adjacent ones
	/// leave empty cells. `None` splits on runs of blanks.
	separators: Option<&'a str>,
	/// `-l`: the last cell takes the rest of the line.
	limit:      Option<usize>,
}

impl Splitter<'_> {
	fn cells<'t>(&self, line: &'t str) -> Vec<&'t str> {
		if let Some(separators) = self.separators {
			let split = |c: char| separators.contains(c);
			return match self.limit {
				Some(limit) => line.splitn(limit, split).collect(),
				None => line.split(split).collect(),
			};
		}
		let blank = |c: char| c == ' ' || c == '\t';
		let mut cells = Vec::new();
		let mut rest = line.trim_start_matches(blank);
		while !rest.is_empty() {
			if self.limit == Some(cells.len() + 1) {
				cells.push(rest);
				break;
			}
			let end = rest.find(blank).unwrap_or(rest.len());
			cells.push(&rest[..end]);
			rest = rest[end..].trim_start_matches(blank);
		}
		cells
	}
}

/// The JSON type of a column's values (`-C json=…`).
#[derive(Clone, Copy, Default, PartialEq, Eq)]
enum JsonType {
	#[default]
	String,
	Number,
	Float,
	ArrayString,
	ArrayNumber,
	Boolean,
}

/// A column flag that a `-H`/`-R`/`-T`/`-E`/`-W` list sets.
#[derive(Clone, Copy)]
enum Flag {
	Hidden,
	Right,
	Trunc,
	NoExtremes,
	Wrap,
}

/// A table column: named by `-N`/`-C`, or added for an extra input cell.
#[derive(Default)]
struct Col {
	name:        Option<String>,
	/// Index of this column's cell in every row: its creation order. `-O`
	/// reorders [`Table::cols`], not the cells.
	cell:        usize,
	hidden:      bool,
	right:       bool,
	trunc:       bool,
	wrap:        bool,
	/// `-C wrapnl`/`wrapzero`: wrapped at line breaks or NULs, which input
	/// lines never hold, so never chunked by width.
	wrap_custom: bool,
	noextremes:  bool,
	/// `-C strictwidth`: never widened to the header.
	strict:      bool,
	tree:        bool,
	json:        JsonType,
	/// `-C width=`: cells when at least 1, else a share of the output width
	/// (with `-m`).
	hint:        f64,
	width:       usize,
	/// The narrowest it may shrink to: the header's width, at least 1.
	min:         usize,
}

impl Col {
	fn new(cell: usize, name: Option<String>) -> Self {
		Self { cell, name, ..Self::default() }
	}

	fn set(&mut self, flag: Flag) {
		match flag {
			Flag::Hidden => self.hidden = true,
			Flag::Right => self.right = true,
			Flag::Trunc => self.trunc = true,
			Flag::NoExtremes => self.noextremes = true,
			Flag::Wrap => self.wrap = true,
		}
	}

	/// Whether fitting the table to the output width may narrow it.
	fn shrinks(&self) -> bool {
		!self.hidden
			&& self.width > self.min
			&& (self.trunc || self.noextremes || (self.wrap && !self.wrap_custom))
	}

	/// Applies a `-C` property list such as `name=SIZE,right,json=number`.
	/// Like util-linux, names (and `json` types) may be abbreviated to any
	/// prefix, the first match winning; an unparsable `width` drops the
	/// list's flags.
	fn apply_properties(&mut self, list: &str) {
		let mut flags = Self::default();
		let mut rest = list;
		while let Some((name, value)) = next_property(&mut rest) {
			let is = |keyword: &str| keyword.starts_with(name);
			if is("trunc") {
				flags.trunc = true;
			} else if is("tree") {
				flags.tree = true;
			} else if is("right") {
				flags.right = true;
			} else if is("strictwidth") {
				flags.strict = true;
			} else if is("noextremes") {
				flags.noextremes = true;
			} else if is("hidden") {
				flags.hidden = true;
			} else if is("wrap") {
				flags.wrap = true;
			} else if is("wrapnl") || is("wrapzero") {
				flags.wrap = true;
				flags.wrap_custom = true;
			} else if let Some(value) = value
				&& is("json")
			{
				let types = [
					("string", JsonType::String),
					("number", JsonType::Number),
					("float", JsonType::Float),
					("array-string", JsonType::ArrayString),
					("array-number", JsonType::ArrayNumber),
					("boolean", JsonType::Boolean),
				];
				if let Some(&(_, json)) = types.iter().find(|(keyword, _)| keyword.starts_with(value)) {
					self.json = json;
				}
			} else if let Some(value) = value
				&& is("width")
			{
				match leading_float(value) {
					Some(hint) => self.hint = hint,
					None => return,
				}
			} else if value.is_some() && is("color") {
				// `column` never colors its output.
			} else if let Some(value) = value
				&& is("name")
			{
				self.name = Some(value.to_owned());
			}
		}
		self.trunc |= flags.trunc;
		self.tree |= flags.tree;
		self.right |= flags.right;
		self.strict |= flags.strict;
		self.noextremes |= flags.noextremes;
		self.hidden |= flags.hidden;
		self.wrap |= flags.wrap;
		self.wrap_custom |= flags.wrap_custom;
	}
}

/// The next `name[=value]` item of a util-linux option string, advancing
/// `rest` past it: commas end items unless quoted or backslash-escaped, and
/// both quotes and backslashes stay in the text. `None` at the end, at an
/// item starting with `=`, or inside an unterminated quote.
fn next_property<'a>(rest: &mut &'a str) -> Option<(&'a str, Option<&'a str>)> {
	let list = rest.trim_start_matches(',');
	if list.is_empty() || list.starts_with('=') {
		return None;
	}
	let bytes = list.as_bytes();
	let (mut quoted, mut equals, mut end) = (false, None, None);
	for (at, &byte) in bytes.iter().enumerate() {
		if byte == b'"' {
			quoted = !quoted;
		}
		if quoted {
			continue;
		}
		if equals.is_none() && at > 0 && byte == b'=' {
			equals = Some(at);
		}
		if byte == b',' && bytes[at - 1] != b'\\' {
			end = Some(at);
			break;
		}
	}
	if end.is_none() && quoted {
		return None;
	}
	let end = end.unwrap_or(list.len());
	let item = &list[..end];
	*rest = list.get(end + 1..).unwrap_or_default();
	Some(match equals {
		Some(at) => (&item[..at], Some(&item[at + 1..])),
		None => (item, None),
	})
}

/// The number `text` starts with, `strtod`-style:
/// `[blanks][sign]digits[.digits][e[sign]digits]`.
fn leading_float(text: &str) -> Option<f64> {
	let text = text.trim_start_matches(|c: char| c.is_ascii_whitespace());
	let bytes = text.as_bytes();
	let digits = |from: usize| {
		bytes[from..]
			.iter()
			.take_while(|byte| byte.is_ascii_digit())
			.count()
	};
	let mut end = usize::from(matches!(bytes.first(), Some(b'+' | b'-')));
	let whole = digits(end);
	end += whole;
	let mut fraction = 0;
	if bytes.get(end) == Some(&b'.') {
		fraction = digits(end + 1);
		end += 1 + fraction;
	}
	if whole + fraction == 0 {
		return None;
	}
	if matches!(bytes.get(end), Some(b'e' | b'E')) {
		let sign = usize::from(matches!(bytes.get(end + 1), Some(b'+' | b'-')));
		let exponent = digits(end + 1 + sign);
		if exponent > 0 {
			end += 1 + sign + exponent;
		}
	}
	text[..end].parse().ok()
}

/// `-H` names unnamed columns (`-`), so the columns extra cells add start
/// hidden.
fn has_unnamed(list: &str) -> bool {
	list == "-" || (list.contains(',') && list.split(',').any(|item| item == "-"))
}

/// Items of a comma-separated list, empty ones skipped.
fn list_items(list: &str) -> impl Iterator<Item = &str> {
	list.split(',').filter(|item| !item.is_empty())
}

/// `strtol`: `[blanks][sign]digits`, and the text after them; `None` without
/// digits or on overflow.
fn leading_int(text: &str) -> Option<(i64, &str)> {
	let text = text.trim_start_matches(|c: char| c.is_ascii_whitespace());
	let sign = usize::from(text.starts_with(['+', '-']));
	let digits = text[sign..].bytes().take_while(u8::is_ascii_digit).count();
	if digits == 0 {
		return None;
	}
	let end = sign + digits;
	text[..end].parse().ok().map(|value| (value, &text[end..]))
}

/// A column range of a `-H`/`-R`/… list, util-linux's `ul_parse_range`:
/// `M-N`, `M:N`, `M:` and `:N` (an open end is 0), or a lone `M` followed by
/// anything else.
fn parse_range(item: &str) -> Option<(i64, i64)> {
	if let Some(upper) = item.strip_prefix(':') {
		return leading_int(upper)
			.filter(|(_, rest)| rest.is_empty())
			.map(|(upper, _)| (0, upper));
	}
	let (lower, rest) = leading_int(item)?;
	if rest == ":" {
		return Some((lower, 0));
	}
	match rest.strip_prefix(['-', ':']) {
		Some(upper) => leading_int(upper)
			.filter(|(_, rest)| rest.is_empty())
			.map(|(upper, _)| (lower, upper)),
		None => Some((lower, lower)),
	}
}

/// `name` as a shell variable name, as util-linux matches column names a
/// second time: a leading `_` unless it starts with a letter, every other
/// byte `_`, and a trailing `%` spelled `_PCT`.
fn shellvar(name: &str) -> Option<String> {
	let first = *name.as_bytes().first()?;
	let mut var = String::with_capacity(name.len() + 4);
	if !first.is_ascii_alphabetic() {
		var.push('_');
	}
	var.extend(name.bytes().map(|byte| {
		if byte.is_ascii_alphanumeric() {
			char::from(byte)
		} else {
			'_'
		}
	}));
	if name.ends_with('%') {
		var.push_str("PCT");
	}
	Some(var)
}

/// One table line: its cells by [`Col::cell`], and its place in a tree.
#[derive(Default)]
struct Row {
	cells:    Vec<String>,
	parent:   Option<usize>,
	children: Vec<usize>,
}

impl Row {
	fn cell(&self, cell: usize) -> Option<&str> {
		self.cells.get(cell).map(String::as_str)
	}
}

/// Tree-drawing strings.
struct Symbols {
	branch:   &'static str,
	vertical: &'static str,
	corner:   &'static str,
}

/// Line-drawing tree art, used in a UTF-8 locale.
const UTF8_SYMBOLS: Symbols = Symbols { branch: "├─", vertical: "│ ", corner: "└─" };
const ASCII_SYMBOLS: Symbols = Symbols { branch: "|-", vertical: "| ", corner: "`-" };

/// What a row's cells past the last column add.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Unnamed {
	Shown,
	/// `-H -`: hidden columns.
	Hidden,
	/// `-J`: an error, since JSON keys are column names.
	Refused,
}

struct Table {
	/// In display order.
	cols:     Vec<Col>,
	rows:     Vec<Row>,
	headings: bool,
	unnamed:  Unnamed,
	/// `-m`: fill the output width, padding the last column too.
	maxout:   bool,
}

impl Table {
	fn new(opts: &Column) -> Self {
		let cols: Vec<Col> = if opts.table_column.is_empty() {
			opts.table_columns.as_deref().map_or_default(|names| {
				list_items(names)
					.enumerate()
					.map(|(cell, name)| Col::new(cell, Some(name.to_owned())))
					.collect()
			})
		} else {
			opts
				.table_column
				.iter()
				.enumerate()
				.map(|(cell, properties)| {
					let mut col = Col::new(cell, None);
					col.apply_properties(properties);
					col
				})
				.collect()
		};
		let named = opts.table_columns.is_some() || !opts.table_column.is_empty();
		let unnamed = if opts.table_hide.as_deref().is_some_and(has_unnamed) {
			Unnamed::Hidden
		} else if opts.json {
			Unnamed::Refused
		} else {
			Unnamed::Shown
		};
		Self {
			cols,
			rows: Vec::new(),
			headings: named && !opts.table_noheadings,
			unnamed,
			maxout: opts.table_maxout,
		}
	}

	/// Appends a row, adding columns for cells past the last one as
	/// [`Table::unnamed`] says.
	fn add_line(&mut self, cells: Vec<&str>) -> Result<(), String> {
		if cells.len() > self.cols.len() {
			if self.unnamed == Unnamed::Refused {
				return Err(format!(
					"line {}: for JSON the name of the column {} is required",
					self.rows.len() + 1,
					self.cols.len() + 1
				));
			}
			for cell in self.cols.len()..cells.len() {
				let mut col = Col::new(cell, None);
				col.hidden = self.unnamed == Unnamed::Hidden;
				self.cols.push(col);
			}
		}
		self
			.rows
			.push(Row { cells: cells.into_iter().map(str::to_owned).collect(), ..Row::default() });
		Ok(())
	}

	/// Applies the column options, in util-linux's order: flags, the
	/// default no-extremes last column, the tree, then the order.
	fn modify(&mut self, opts: &Column) -> Result<(), String> {
		let lists = [
			(&opts.table_hide, Flag::Hidden),
			(&opts.table_right, Flag::Right),
			(&opts.table_truncate, Flag::Trunc),
			(&opts.table_noextreme, Flag::NoExtremes),
			(&opts.table_wrap, Flag::Wrap),
		];
		for (list, flag) in lists {
			if let Some(list) = list {
				self.flag_list(list, flag)?;
			}
		}
		if opts.table_noextreme.is_none()
			&& let Some(last) = self.last_visible(0)
		{
			self.cols[last].noextremes = true;
		}
		if let (Some(tree), Some(id), Some(parent)) = (&opts.tree, &opts.tree_id, &opts.tree_parent) {
			self.build_tree(tree, id, parent)?;
		}
		if let Some(order) = &opts.table_order {
			self.reorder(order)?;
		}
		Ok(())
	}

	/// Sets `flag` on the columns of `list`: names, 1-based positions,
	/// ranges (negative counting back from the last visible column), `-`
	/// for every unnamed column, or a lone `0` for all of them.
	fn flag_list(&mut self, list: &str, flag: Flag) -> Result<(), String> {
		if list == "0" {
			self.cols.iter_mut().for_each(|col| col.set(flag));
			return Ok(());
		}
		let mut unnamed = false;
		for item in list_items(list) {
			if item == "-" {
				unnamed = true;
			} else if item.contains('-')
				&& let Some((lower, upper)) = parse_range(item)
			{
				let count = self.cols.len() as i64;
				for position in lower.max(-count)..=upper.min(count) {
					let target = match position {
						..0 => self.last_visible(position.unsigned_abs() as usize - 1),
						0 => None,
						_ => Some(position as usize - 1),
					};
					if let Some(target) = target {
						self.cols[target].set(flag);
					}
				}
			} else {
				let target = self.lookup(item)?;
				self.cols[target].set(flag);
			}
		}
		if unnamed {
			self
				.cols
				.iter_mut()
				.filter(|col| col.name.is_none())
				.for_each(|col| col.set(flag));
		}
		Ok(())
	}

	/// The column `name` refers to: a 1-based position, `-1` for the last
	/// visible one, or a name (also in its [`shellvar`] spelling).
	fn lookup(&self, name: &str) -> Result<usize, String> {
		let found = if !name.is_empty() && name.bytes().all(|byte| byte.is_ascii_digit()) {
			let position: u32 = name
				.parse()
				.map_err(|_| format!("failed to parse column: '{name}'"))?;
			(position as usize)
				.checked_sub(1)
				.filter(|&at| at < self.cols.len())
		} else if name == "-1" {
			self.last_visible(0)
		} else {
			self
				.cols
				.iter()
				.position(|col| col.name.as_deref() == Some(name))
				.or_else(|| {
					self
						.cols
						.iter()
						.position(|col| col.name.as_deref().and_then(shellvar).as_deref() == Some(name))
				})
		};
		found.ok_or_else(|| format!("undefined column name '{name}'"))
	}

	/// The `nth` visible column counting back from the last.
	fn last_visible(&self, nth: usize) -> Option<usize> {
		(0..self.cols.len())
			.rev()
			.filter(|&at| !self.cols[at].hidden)
			.nth(nth)
	}

	fn visible(&self) -> impl Iterator<Item = usize> {
		(0..self.cols.len()).filter(|&at| !self.cols[at].hidden)
	}

	fn is_tree(&self) -> bool {
		self.cols.iter().any(|col| col.tree)
	}

	/// `-r`/`-i`/`-p`: hangs every row under each row whose `id` cell equals
	/// its `parent` cell (the last such row winning), unless that would
	/// make it its own ancestor, and draws the tree in column `tree`.
	fn build_tree(&mut self, tree: &str, id: &str, parent: &str) -> Result<(), String> {
		let tree = self.lookup(tree)?;
		let parent = self.cols[self.lookup(parent)?].cell;
		let id = self.cols[self.lookup(id)?].cell;
		self.cols[tree].tree = true;

		let mut by_parent: HashMap<String, Vec<usize>> = HashMap::new();
		for (row, line) in self.rows.iter().enumerate() {
			if let Some(parent) = line.cell(parent) {
				by_parent.entry(parent.to_owned()).or_default().push(row);
			}
		}
		for row in 0..self.rows.len() {
			let Some(children) = self.rows[row].cell(id).and_then(|id| by_parent.get(id)) else {
				continue;
			};
			for &child in children {
				if self.is_ancestor(child, row) {
					continue;
				}
				if let Some(old) = self.rows[child].parent {
					self.rows[old].children.retain(|&sibling| sibling != child);
				}
				self.rows[row].children.push(child);
				self.rows[child].parent = Some(row);
			}
		}
		Ok(())
	}

	/// Whether `ancestor` is `row` or above it.
	fn is_ancestor(&self, ancestor: usize, row: usize) -> bool {
		iter::successors(Some(row), |&row| self.rows[row].parent).any(|row| row == ancestor)
	}

	/// `-O`: moves the listed columns to the front, in list order.
	fn reorder(&mut self, order: &str) -> Result<(), String> {
		let wanted = list_items(order)
			.map(|name| self.lookup(name).map(|at| self.cols[at].cell))
			.collect::<Result<Vec<_>, _>>()?;
		let mut previous = None;
		for cell in wanted {
			if previous == Some(cell) {
				continue;
			}
			let from = self
				.cols
				.iter()
				.position(|col| col.cell == cell)
				.expect("listed column exists");
			let col = self.cols.remove(from);
			let to = previous.map_or(0, |previous| {
				self
					.cols
					.iter()
					.position(|col| col.cell == previous)
					.expect("moved column exists")
					+ 1
			});
			self.cols.insert(to, col);
			previous = Some(cell);
		}
		Ok(())
	}

	fn is_last_child(&self, row: usize) -> bool {
		self.rows[row]
			.parent
			.is_some_and(|parent| self.rows[parent].children.last() == Some(&row))
	}

	/// The tree art before `row`'s text in a tree column: a branch, or a
	/// corner for a last child, behind [`Table::rails`] of its parent.
	fn art(&self, row: usize, symbols: &Symbols) -> String {
		let Some(parent) = self.rows[row].parent else {
			return String::new();
		};
		let mut art = self.rails(parent, symbols);
		art.push_str(if self.is_last_child(row) {
			symbols.corner
		} else {
			symbols.branch
		});
		art
	}

	/// One rail per row on the path from the root down to `row` (the root
	/// excluded): blank where that row is a last child.
	fn rails(&self, row: usize, symbols: &Symbols) -> String {
		let path: Vec<usize> = iter::successors(Some(row), |&row| self.rows[row].parent)
			.take_while(|&row| self.rows[row].parent.is_some())
			.collect();
		path
			.iter()
			.rev()
			.map(|&row| {
				if self.is_last_child(row) {
					"  "
				} else {
					symbols.vertical
				}
			})
			.collect()
	}

	/// Rows in print order: input order, or depth first from each root.
	fn order(&self) -> Vec<usize> {
		if !self.is_tree() {
			return (0..self.rows.len()).collect();
		}
		let mut order = Vec::with_capacity(self.rows.len());
		let mut stack = Vec::new();
		for root in (0..self.rows.len()).filter(|&row| self.rows[row].parent.is_none()) {
			stack.push(root);
			while let Some(row) = stack.pop() {
				order.push(row);
				stack.extend(self.rows[row].children.iter().rev());
			}
		}
		order
	}

	/// Sets each visible column's width to its widest text (tree art
	/// included), widened to its header and its `-C width=` hint, and its
	/// shrink limit.
	fn measure(&mut self, arts: &[String], width: Option<usize>) {
		let last = self.last_visible(0);
		for at in self.visible().collect::<Vec<_>>() {
			let col = &self.cols[at];
			let mut min = 0;
			if self.maxout
				&& let Some(width) = width
				&& col.hint < 1.0
			{
				// A share of the width, minus the separator's cell.
				min = (col.hint * width as f64) as usize;
				if min > 0 && last != Some(at) {
					min -= 1;
				}
			}
			let header = self
				.headings
				.then_some(col.name.as_deref())
				.flatten()
				.map(text_width);
			min = min.max(header.unwrap_or(0)).max(1);
			let widest = self
				.rows
				.iter()
				.zip(arts)
				.map(|(row, art)| {
					let art = if col.tree { text_width(art) } else { 0 };
					art + row.cell(col.cell).map_or(0, text_width)
				})
				.max()
				.unwrap_or(0);
			let hint = col.hint as usize;
			let mut width = widest;
			if width < min && !col.strict {
				width = min;
			} else if col.hint >= 1.0 && width < hint && min < hint {
				width = hint;
			}
			// A column with neither header nor text takes no cells.
			if widest == 0 && header.is_none() && min == 1 && width <= 1 {
				(width, min) = (0, 0);
			}
			let col = &mut self.cols[at];
			col.width = width;
			col.min = min;
		}
	}

	/// Narrows the shrinkable columns — widest first, rightmost among equals
	/// — until the table fits `width`; with `-m`, then widens them evenly to
	/// fill it.
	fn fit(&mut self, width: usize, separator: usize) {
		let visible: Vec<usize> = self.visible().collect();
		let gaps = separator * visible.len().saturating_sub(1);
		let mut total = gaps + visible.iter().map(|&at| self.cols[at].width).sum::<usize>();
		if self.maxout {
			// Headers wider than the whole output lose a cell each.
			let mut floor = gaps + visible.iter().map(|&at| self.cols[at].min).sum::<usize>();
			for &at in &visible {
				if floor <= width {
					break;
				}
				if self.cols[at].min > 0 {
					self.cols[at].min -= 1;
					floor -= 1;
				}
			}
		}
		while total > width {
			let Some(widest) = visible
				.iter()
				.copied()
				.filter(|&at| self.cols[at].shrinks())
				.max_by_key(|&at| self.cols[at].width)
			else {
				break;
			};
			let next = visible
				.iter()
				.filter(|&&at| at != widest && self.cols[at].shrinks())
				.map(|&at| self.cols[at].width)
				.max()
				.unwrap_or(0);
			let col = &mut self.cols[widest];
			let floor = next.max(col.min);
			let step = if col.width > floor {
				(col.width - floor).min(total - width)
			} else {
				1
			};
			col.width -= step;
			total -= step;
		}
		if self.maxout && total < width && !visible.is_empty() {
			// Even shares; the cells left over go to the widest columns.
			let extra = width - total;
			let (share, left) = (extra / visible.len(), extra % visible.len());
			let mut widest = visible;
			widest.sort_by_key(|&at| Reverse((self.cols[at].width, at)));
			for (rank, at) in widest.into_iter().enumerate() {
				self.cols[at].width += share + usize::from(rank < left);
			}
		}
	}

	/// `-J`: the rows as an array of objects named `name`, keyed by
	/// lowercased column names; a tree nests children under `children`.
	fn print_json(&self, name: &str, out: &mut Vec<u8>) {
		let mut json = Json { out, indent: 0, after_close: false };
		json.open(None, Node::Object);
		json.open(Some(name), Node::Array);
		let last_root = (0..self.rows.len()).rfind(|&row| self.rows[row].parent.is_none());
		for row in self.order() {
			json.open(None, Node::Object);
			for at in self.visible() {
				let col = &self.cols[at];
				json_value(&mut json, col, self.rows[row].cell(col.cell).unwrap_or_default());
			}
			if !self.rows[row].children.is_empty() {
				json.open(Some("children"), Node::Array);
				continue;
			}
			// Close this row and every ancestor it is the last row of.
			let mut node = Some(row);
			while let Some(row) = node {
				let parent = self.rows[row].parent;
				let last = match parent {
					Some(_) => self.is_last_child(row),
					None => last_root == Some(row),
				};
				json.close(Node::Object);
				if last && parent.is_some() {
					json.close(Node::Array);
				}
				node = parent.filter(|_| last);
			}
		}
		json.close(Node::Array);
		json.close(Node::Object);
	}
}

/// Writes `data` as the value of `col`, typed by `-C json=`.
fn json_value(json: &mut Json<'_>, col: &Col, data: &str) {
	let name = col.name.as_deref();
	match col.json {
		JsonType::String => json.value(name, Value::Str(data)),
		JsonType::Number | JsonType::Float => json.value(name, Value::Raw(data)),
		JsonType::Boolean => {
			json.value(name, Value::Bool(!(data.is_empty() || data.starts_with(['0', 'N', 'n']))));
		},
		JsonType::ArrayString | JsonType::ArrayNumber if data.is_empty() => json.empty_array(name),
		JsonType::ArrayString | JsonType::ArrayNumber => {
			json.open(name, Node::Array);
			// Only a custom-wrapped column yields unquoted numbers.
			let raw = col.json == JsonType::ArrayNumber && col.wrap_custom;
			json.value(
				None,
				if raw {
					Value::Raw(data)
				} else {
					Value::Str(data)
				},
			);
			json.close(Node::Array);
		},
	}
}

#[derive(Clone, Copy)]
enum Node {
	Object,
	Array,
	Value,
}

/// A JSON scalar; empty text is `null`.
enum Value<'a> {
	Str(&'a str),
	Raw(&'a str),
	Bool(bool),
}

/// util-linux's JSON writer: three-space indents, and `},{` between
/// sibling objects.
struct Json<'o> {
	out:         &'o mut Vec<u8>,
	indent:      usize,
	after_close: bool,
}

impl Json<'_> {
	fn indent(&mut self) {
		for _ in 0..self.indent {
			self.out.extend_from_slice(b"   ");
		}
	}

	fn name(&mut self, name: Option<&str>) {
		match name {
			Some(name) => {
				if self.after_close {
					self.out.extend_from_slice(b",\n");
				}
				self.indent();
				self.quote(name, true);
			},
			None if self.after_close => self.out.push(b','),
			None => self.indent(),
		}
	}

	fn open(&mut self, name: Option<&str>, node: Node) {
		self.name(name);
		let opener: &[u8] = match (node, name.is_some()) {
			(Node::Object, true) => b": {\n",
			(Node::Object, false) => b"{\n",
			(Node::Array, true) => b": [\n",
			(Node::Array, false) => b"[\n",
			(Node::Value, true) => b": ",
			(Node::Value, false) => b" ",
		};
		self.out.extend_from_slice(opener);
		if !matches!(node, Node::Value) {
			self.indent += 1;
		}
		self.after_close = false;
	}

	fn close(&mut self, node: Node) {
		let closer = match node {
			Node::Object => b'}',
			Node::Array => b']',
			Node::Value => {
				self.after_close = true;
				return;
			},
		};
		self.indent -= 1;
		self.out.push(b'\n');
		self.indent();
		self.out.push(closer);
		if self.indent == 0 {
			self.out.push(b'\n');
		}
		self.after_close = true;
	}

	fn empty_array(&mut self, name: Option<&str>) {
		self.name(name);
		self
			.out
			.extend_from_slice(if name.is_some() { b": []" } else { b"[]" });
		self.after_close = true;
	}

	fn value(&mut self, name: Option<&str>, value: Value<'_>) {
		self.open(name, Node::Value);
		match value {
			Value::Str("") | Value::Raw("") => self.out.extend_from_slice(b"null"),
			Value::Str(text) => self.quote(text, false),
			Value::Raw(text) => self.out.extend_from_slice(text.as_bytes()),
			Value::Bool(true) => self.out.extend_from_slice(b"true"),
			Value::Bool(false) => self.out.extend_from_slice(b"false"),
		}
		self.close(Node::Value);
	}

	/// `text` as a JSON string; `lower` lowercases ASCII (keys).
	fn quote(&mut self, text: &str, lower: bool) {
		self.out.push(b'"');
		for &byte in text.as_bytes() {
			match byte {
				b'"' | b'\\' => self.out.extend_from_slice(&[b'\\', byte]),
				0x08 => self.out.extend_from_slice(b"\\b"),
				b'\t' => self.out.extend_from_slice(b"\\t"),
				b'\n' => self.out.extend_from_slice(b"\\n"),
				0x0c => self.out.extend_from_slice(b"\\f"),
				b'\r' => self.out.extend_from_slice(b"\\r"),
				..0x20 => {
					let _ = write!(self.out, "\\u00{byte:02x}");
				},
				_ if lower => self.out.push(byte.to_ascii_lowercase()),
				_ => self.out.push(byte),
			}
		}
		self.out.push(b'"');
	}
}

/// Human-readable table output.
struct Printer<'a> {
	table:     &'a Table,
	arts:      &'a [String],
	symbols:   &'a Symbols,
	/// Visible columns, in display order.
	visible:   Vec<usize>,
	separator: &'a str,
	out:       &'a mut Vec<u8>,
	/// Lines ended so far, which pages the `-e` header.
	lines:     usize,
}

impl<'a> Printer<'a> {
	/// The header (repeated every `page` lines with `-e`), then the rows in
	/// `order`.
	fn print(&mut self, order: &[usize], page: Option<usize>) {
		let mut next_header = None;
		if self.table.headings {
			self.header();
			next_header = page.map(|page| self.lines + page);
		}
		for (at, &row) in order.iter().enumerate() {
			self.row(row);
			if at + 1 == order.len() {
				break;
			}
			self.newline();
			if next_header.is_some_and(|next| self.lines >= next) {
				self.header();
				next_header = page.map(|page| self.lines + page);
			}
		}
		self.out.push(b'\n');
	}

	fn is_last(&self, at: usize) -> bool {
		self.visible.last() == Some(&at)
	}

	fn newline(&mut self) {
		self.out.push(b'\n');
		self.lines += 1;
	}

	fn pad(&mut self, cells: usize) {
		self.out.extend(iter::repeat_n(b' ', cells));
	}

	fn header(&mut self) {
		let table = self.table;
		for slot in 0..self.visible.len() {
			let at = self.visible[slot];
			// A header that does not fit is cut, never continued.
			let _ = self.cell(at, None, table.cols[at].name.as_deref().unwrap_or_default());
		}
		self.newline();
	}

	/// `row`'s cells, then continuation lines while a wrapped cell has text
	/// left.
	fn row(&mut self, row: usize) {
		let texts: Vec<Cow<'a, str>> = self.visible.iter().map(|&at| self.text(row, at)).collect();
		let mut pending: Vec<Option<&str>> = Vec::with_capacity(texts.len());
		for (slot, text) in texts.iter().enumerate() {
			let rest = self.cell(self.visible[slot], Some(row), text);
			pending.push(rest);
		}
		while pending.iter().any(Option::is_some) {
			self.newline();
			for slot in 0..pending.len() {
				let at = self.visible[slot];
				match pending[slot].take() {
					Some(text) => pending[slot] = self.continuation(at, row, text),
					None => self.empty(at, Some(row)),
				}
			}
		}
	}

	/// The text of `row` in column `at`: its cell, behind the tree art in a
	/// tree column.
	fn text(&self, row: usize, at: usize) -> Cow<'a, str> {
		let table = self.table;
		let col = &table.cols[at];
		let cell = table.rows[row].cell(col.cell).unwrap_or_default();
		match &self.arts[row] {
			art if col.tree && !art.is_empty() => Cow::Owned(format!("{art}{cell}")),
			_ => Cow::Borrowed(cell),
		}
	}

	/// The next piece of a wrapped cell in column `at` on a continuation
	/// line — under `row`'s tree rails in a tree column — then padding and
	/// the separator. Returns the text still left.
	fn continuation<'t>(&mut self, at: usize, row: usize, text: &'t str) -> Option<&'t str> {
		let col = &self.table.cols[at];
		let rails = if col.tree {
			self.rails(row)
		} else {
			String::new()
		};
		let used = text_width(&rails);
		let (chunk, chunk_width) = truncate(text, col.width.saturating_sub(used).max(1));
		let rest = (!chunk.is_empty() && chunk.len() < text.len()).then(|| &text[chunk.len()..]);
		self.out.extend_from_slice(rails.as_bytes());
		self.out.extend_from_slice(chunk.as_bytes());
		let last = self.is_last(at);
		if !last || self.table.maxout {
			self.pad(col.width.saturating_sub(used + chunk_width));
		}
		if !last {
			self.out.extend_from_slice(self.separator.as_bytes());
		}
		rest
	}

	/// The tree rails below `row`: its own branch continued, and the one
	/// down to its children.
	fn rails(&self, row: usize) -> String {
		let mut rails = self.table.rails(row, self.symbols);
		if !self.table.rows[row].children.is_empty() {
			rails.push_str(self.symbols.vertical);
		}
		rails
	}

	/// Prints `text` in column `at` (of `row`; `None` for the header) and
	/// what follows it: padding, then the separator — or, when the text
	/// overflows the column, a line break that re-aligns the next column.
	/// Returns the text a wrapped cell left for continuation lines.
	fn cell<'t>(&mut self, at: usize, row: Option<usize>, text: &'t str) -> Option<&'t str> {
		let col = &self.table.cols[at];
		let last = self.is_last(at);
		let mut text = text;
		let mut len = text_width(text);
		let mut width = col.width;
		if last && len < width && !self.table.maxout && !col.right {
			width = len;
		}
		if len > width && col.trunc {
			(text, len) = truncate(text, width);
		}
		let mut rest = None;
		if len > width && col.wrap && !col.wrap_custom {
			let (chunk, chunk_width) = truncate(text, width);
			if !chunk.is_empty() && chunk.len() < text.len() {
				rest = Some(&text[chunk.len()..]);
			}
			(text, len) = (chunk, chunk_width);
		}
		if !text.is_empty() {
			if col.right {
				self.pad(width.saturating_sub(len));
				len = width;
			}
			self.out.extend_from_slice(text.as_bytes());
		}
		if last && !self.table.maxout {
			return rest;
		}
		self.pad(width.saturating_sub(len));
		if len > width && !col.trunc {
			self.break_line(at, row);
		} else if !last {
			self.out.extend_from_slice(self.separator.as_bytes());
		}
		rest
	}

	/// An empty cell in column `at`: padding, the separator, and in a tree
	/// column the rails that continue `row`'s branch.
	fn empty(&mut self, at: usize, row: Option<usize>) {
		let table = self.table;
		let col = &table.cols[at];
		let mut used = 0;
		if let Some(row) = row
			&& col.tree
		{
			let rails = self.rails(row);
			used = text_width(&rails);
			self.out.extend_from_slice(rails.as_bytes());
		}
		let last = self.is_last(at);
		if last && !self.table.maxout {
			return;
		}
		self.pad(col.width.saturating_sub(used));
		if !last {
			self.out.extend_from_slice(self.separator.as_bytes());
		}
	}

	/// Ends the line after a cell overflowing column `at` and pads the next
	/// one out to where the following column starts.
	fn break_line(&mut self, at: usize, row: Option<usize>) {
		self.newline();
		for slot in 0..self.visible.len() {
			let column = self.visible[slot];
			self.empty(column, row);
			if column == at {
				break;
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use std::fs;

	use super::Column;
	use crate::host::run_util;

	fn column(args: &[&str], stdin: &str) -> (i32, String, String) {
		let dir = tempfile::tempdir().unwrap();
		let (code, capture) = run_util::<Column>(args, stdin, dir.path());
		(code, capture.out(), capture.err())
	}

	fn ok(args: &[&str], stdin: &str) -> String {
		let (code, out, err) = column(args, stdin);
		assert_eq!((code, err.as_str()), (0, ""), "column {args:?}");
		out
	}

	/// The reported failure: macOS's BSD `column` rejected `-N`.
	#[test]
	fn table_columns_name_a_header_row() {
		let out = ok(&["-t", "-N", "which,frames,cpu50"], "base 1200 1.234\nnew 980 2.5\n");
		assert_eq!(out, "which  frames  cpu50\nbase   1200    1.234\nnew    980     2.5\n");
	}

	#[test]
	fn columns_are_hidden_reordered_and_right_aligned() {
		let out = ok(&["-t", "-N", "x,y,n", "-H", "y", "-O", "n,x", "-R", "n"], "a b 1\nccc d 22\n");
		assert_eq!(out, " n  x\n 1  a\n22  ccc\n");
	}

	/// `-s` cuts at every separator, so adjacent ones leave empty cells, and
	/// the separator after a non-empty last column still pads.
	#[test]
	fn explicit_separators_keep_empty_cells() {
		assert_eq!(ok(&["-t", "-s", ",", "-o", "|"], ",a,,b,\nc\n"), " |a||b|\nc| || |\n");
		assert_eq!(ok(&["-t", "-l", "2"], "a b  c  d \ne f\n"), "a  b  c  d \ne  f\n");
	}

	#[test]
	fn fill_mode_tabs_down_columns_or_across_rows() {
		let input: String = (1..=7).map(|n| format!("{n}\n")).collect();
		assert_eq!(ok(&["-c", "24"], &input), "1\t4\t7\n2\t5\n3\t6\n");
		assert_eq!(ok(&["-x", "-c", "20"], &input), "1\t2\n3\t4\n5\t6\n7\n");
		assert_eq!(ok(&["-S", "1", "-c", "5"], &input), "1 4 7\n2 5\n3 6\n");
	}

	/// Columns marked `-T`/`-W` shrink to fit `-c`; the others never do.
	#[test]
	fn table_fits_the_output_width_by_truncating_or_wrapping() {
		let input = "id descr x\n1 aaaaaaaaaaaaaaaaaaaaaaaaaa y\n";
		assert_eq!(
			ok(&["-t", "-T", "2", "-c", "20"], input),
			"id  descr          x\n1   aaaaaaaaaaaaa  y\n"
		);
		assert_eq!(
			ok(&["-t", "-W", "2", "-c", "20"], input),
			"id  descr          x\n1   aaaaaaaaaaaaa  y\n    aaaaaaaaaaaaa  \n"
		);
		assert_eq!(
			ok(&["-t", "-c", "20"], input),
			"id  descr                       x\n1   aaaaaaaaaaaaaaaaaaaaaaaaaa  y\n"
		);
	}

	#[test]
	fn tree_hangs_rows_under_their_parent_ids() {
		let out = ok(
			&["-t", "-N", "id,parent,name", "-r", "name", "-i", "id", "-p", "parent"],
			"1 0 A\n2 1 AA\n3 2 AAA\n4 1 AB\n5 0 B\n",
		);
		assert_eq!(
			out,
			"id  parent  name\n1   0       A\n2   1       |-AA\n3   2       | `-AAA\n4   1       \
			 `-AB\n5   0       B\n"
		);
	}

	/// JSON keys are the lowercased names; types come from `-C json=`.
	#[test]
	fn json_objects_follow_column_types() {
		let out = ok(
			&[
				"-J",
				"-n",
				"Rows",
				"-C",
				"name=Name",
				"-C",
				"name=n,json=number",
				"-C",
				"name=ok,json=boolean",
			],
			"a 1 yes\nb  0\n",
		);
		assert_eq!(
			out,
			"{\n   \"rows\": [\n      {\n         \"name\": \"a\",\n         \"n\": 1,\n         \
			 \"ok\": true\n      },{\n         \"name\": \"b\",\n         \"n\": 0,\n         \
			 \"ok\": false\n      }\n   ]\n}\n"
		);
		let (code, _, err) = column(&["-J", "-N", "x"], "a b\n");
		assert_eq!(
			(code, err.as_str()),
			(1, "column: line 1: for JSON the name of the column 2 is required\n")
		);
	}

	#[test]
	fn table_options_need_a_table_and_known_columns() {
		assert_eq!(
			column(&["-N", "a"], "a\n"),
			(1, String::new(), "column: option --table required for all --table-*\n".to_owned())
		);
		assert_eq!(
			column(&["-t", "-R", "nope"], "a\n"),
			(1, String::new(), "column: undefined column name 'nope'\n".to_owned())
		);
	}

	/// A missing operand is reported, the rest still printed, and the status 1.
	#[test]
	fn unreadable_operand_is_skipped() {
		let dir = tempfile::tempdir().unwrap();
		fs::write(dir.path().join("a"), "x yy\nzzz w\n").unwrap();
		let (code, capture) = run_util::<Column>(&["-t", "missing", "a"], "", dir.path());
		assert_eq!(code, 1);
		assert_eq!(capture.out(), "x    yy\nzzz  w\n");
		assert_eq!(capture.err(), "column: missing: No such file or directory\n");
	}
}
