//! Lexically scoped pragmas, as specified in perllexwarn, warnings and feature.

use super::PStr;

const CATEGORIES: &[(&str, &str)] = &[
	("all", ""), ("closure", ""), ("deprecated", ""), ("exiting", ""),
	("experimental", ""), ("experimental::alpha_assertions", "experimental"),
	("experimental::bitwise", "experimental"), ("experimental::const_attr", "experimental"),
	("experimental::declared_refs", "experimental"), ("experimental::isa", "experimental"),
	("experimental::lexical_subs", "experimental"), ("experimental::postderef", "experimental"),
	("experimental::private_use", "experimental"), ("experimental::re_strict", "experimental"),
	("experimental::refaliasing", "experimental"), ("experimental::regex_sets", "experimental"),
	("experimental::script_run", "experimental"), ("experimental::signatures", "experimental"),
	("experimental::smartmatch", "experimental"), ("experimental::try", "experimental"),
	("experimental::uniprop_wildcards", "experimental"), ("experimental::vlb", "experimental"),
	("experimental::win32_perlio", "experimental"), ("glob", ""), ("imprecision", ""),
	("io", ""), ("closed", "io"), ("exec", "io"), ("layer", "io"), ("newline", "io"),
	("pipe", "io"), ("syscalls", "io"), ("unopened", "io"), ("locale", ""), ("misc", ""),
	("missing", ""), ("numeric", ""), ("once", ""), ("overflow", ""), ("pack", ""),
	("portable", ""), ("recursion", ""), ("redefine", ""), ("redundant", ""), ("regexp", ""),
	("severe", ""), ("debugging", "severe"), ("inplace", "severe"), ("internal", "severe"),
	("malloc", "severe"), ("shadow", ""), ("signal", ""), ("substr", ""), ("syntax", ""),
	("ambiguous", "syntax"), ("bareword", "syntax"), ("digit", "syntax"),
	("illegalproto", "syntax"), ("parenthesis", "syntax"), ("precedence", "syntax"),
	("printf", "syntax"), ("prototype", "syntax"), ("qw", "syntax"), ("reserved", "syntax"),
	("semicolon", "syntax"), ("taint", ""), ("threads", ""), ("uninitialized", ""),
	("unpack", ""), ("untie", ""), ("utf8", ""), ("non_unicode", "utf8"),
	("nonchar", "utf8"), ("surrogate", "utf8"), ("void", ""),
];

fn category_bits(category: &str) -> u128 {
	if category.is_empty() { return 0; }
	CATEGORIES.iter().enumerate().filter(|&(_, &(name, parent))| {
		category == "all" || category == name || category == parent
	}).fold(0, |mask, (i, _)| mask | (1 << i))
}

fn category_bit(category: &str) -> u128 {
	CATEGORIES.iter().position(|&(name, _)| name == category).map_or(1, |i| 1 << i)
}

/// Independent warning and fatal bits, with parent categories acting on their descendants.
#[derive(Clone, Copy, Debug, Default)]
pub(in crate::perl) struct Warnings { on: u128, fatal: u128, specified: u128 }
impl Warnings {
	/// Disable all lexical categories; warnings remain governed by `$^W` if unspecified.
	pub fn none() -> Self { Self::default() }
	/// Enable the selected category and its descendants.
	pub fn enable(&mut self, category: &str, fatal: bool) -> bool {
		let bits = category_bits(category);
		self.on |= bits;
		self.specified |= bits;
		if fatal { self.fatal |= bits; } else { self.fatal &= !bits; }
		bits != 0
	}
	/// Disable the selected category and its descendants.
	pub fn disable(&mut self, category: &str) -> bool {
		let bits = category_bits(category);
		self.on &= !bits;
		self.fatal &= !bits;
		self.specified |= bits;
		bits != 0
	}
	/// Whether the category is enabled in the lexical warning bits.
	pub fn enabled(&self, category: &str) -> bool { self.on != 0 && self.on & category_bit(category) != 0 }
	/// Whether the category is fatal in the lexical warning bits.
	pub fn fatal(&self, category: &str) -> bool { self.fatal != 0 && self.fatal & category_bit(category) != 0 }
	pub(super) fn specified(&self, category: &str) -> bool { self.specified != 0 && self.specified & category_bit(category) != 0 }

	pub(super) fn packed(&self) -> Option<PStr> {
		if self.specified == 0 { return None; }
		// The Perl warning-mask ABI uses two bits per category, numbered by
		// introduction order rather than their position in the warning hierarchy.
		const ORDER: &[&str] = &[
			"all", "closure", "deprecated", "exiting", "glob", "io", "closed", "exec", "layer", "newline",
			"pipe", "unopened", "misc", "numeric", "once", "overflow", "pack", "portable", "recursion", "redefine",
			"regexp", "severe", "debugging", "inplace", "internal", "malloc", "signal", "substr", "syntax",
			"ambiguous", "bareword", "digit", "parenthesis", "precedence", "printf", "prototype", "qw",
			"reserved", "semicolon", "taint", "threads", "uninitialized", "unpack", "untie", "utf8", "void",
			"imprecision", "illegalproto", "non_unicode", "nonchar", "surrogate", "experimental",
			"experimental::lexical_subs", "experimental::regex_sets", "experimental::smartmatch", "experimental::postderef",
			"experimental::signatures", "syscalls", "experimental::bitwise", "experimental::const_attr", "experimental::re_strict",
			"experimental::refaliasing", "experimental::win32_perlio", "locale", "missing", "redundant",
			"experimental::declared_refs", "experimental::alpha_assertions", "experimental::script_run", "shadow",
			"experimental::private_use", "experimental::uniprop_wildcards", "experimental::vlb", "experimental::isa",
			"experimental::try",
		];
		let mut out = [0; 19];
		if self.on == category_bits("all") { out.fill(0x55); }
		for (n, &name) in ORDER.iter().enumerate() {
			let bit = category_bit(name);
			let enabled = u8::from(self.on & bit != 0);
			let fatal = u8::from(self.fatal & bit != 0);
			out[n / 4] |= (enabled | (fatal << 1)) << (2 * (n % 4));
		}
		Some(PStr::from_bytes(&out))
	}
}

macro_rules! features {
	($($name:literal => $field:ident = $default:literal),+ $(,)?) => {
		/// Perl feature flags in a lexical compile context.
		#[derive(Clone, Copy, Debug, PartialEq, Eq)]
		pub(in crate::perl) struct Features { $(#[doc = concat!("Availability of `", $name, "`.")] pub $field: bool,)+ }
		impl Default for Features {
			fn default() -> Self { Self { $($field: $default,)+ } }
		}
		impl Features {
			/// Enable or disable a feature, returning false for unknown names.
			pub fn set(&mut self, name: &str, on: bool) -> bool {
				match name { $($name => self.$field = on,)+ _ => return false }
				true
			}
			/// Return whether the named feature is enabled.
			pub fn enabled(&self, name: &str) -> bool { match name { $($name => self.$field,)+ _ => false } }
		}
	};
}

features! {
	"say" => say = false, "state" => state = false, "switch" => switch = false,
	"fc" => fc = false, "signatures" => signatures = false, "bitwise" => bitwise = false,
	"unicode_strings" => unicode_strings = false, "unicode_eval" => unicode_eval = false,
	"postderef_qq" => postderef_qq = false, "current_sub" => current_sub = false,
	"evalbytes" => evalbytes = false, "isa" => isa = false, "try" => try_catch = false,
	"indirect" => indirect = true, "multidimensional" => multidimensional = true,
	"bareword_filehandles" => bareword_filehandles = true, "refaliasing" => refaliasing = false,
	"declared_refs" => declared_refs = false, "lexical_subs" => lexical_subs = true,
	"array_base" => array_base = false, "postderef" => postderef = true,
}

impl Features {
	/// Replace the feature set with the given Perl version bundle.
	pub fn bundle(&mut self, major: u32, minor: u32) {
		*self = Self::default();
		// Development versions (odd minor) select the following stable bundle (feature.pm: 5.27 → :5.28).
		let minor = minor + minor % 2;
		let at = |n| (major, minor) >= (5, n);
		self.say = at(10);
		self.state = at(10);
		self.switch = at(10) && !at(36);
		self.unicode_strings = at(12);
		self.fc = at(16);
		self.current_sub = at(16);
		self.unicode_eval = at(16);
		self.evalbytes = at(16);
		self.postderef_qq = at(24);
		self.bitwise = at(28);
		self.isa = at(32);
		self.indirect = !at(36);
		self.multidimensional = !at(36);
		self.signatures = at(36);
		self.bareword_filehandles = !at(38);
	}

	pub(super) fn from_version(&mut self, version: &[u8]) {
		let version = version.strip_prefix(b"v").unwrap_or(version);
		let parse = |part: &[u8]| std::str::from_utf8(part).ok()?.parse::<u32>().ok();
		let mut parts = version.split(|&b| b == b'.');
		let major = parts.next().and_then(parse).unwrap_or(0);
		let minor = parts.next().map_or(0, |p| {
			if p.len() >= 3 { parse(&p[..3]).unwrap_or(0) } else { parse(p).unwrap_or(0) }
		});
		self.bundle(major, minor);
	}
}

/// Parse and runtime pragmas inherited by nested scopes.
#[derive(Clone, Debug, Default)]
pub(in crate::perl) struct Hints {
	/// Reject symbolic scalar, array and hash references.
	pub strict_refs: bool,
	/// Require declarations or qualified variable names.
	pub strict_vars: bool,
	/// Reject ambiguous barewords.
	pub strict_subs: bool,
	/// Use integer arithmetic for applicable operators.
	pub integer: bool,
	/// Use byte operations on character strings.
	pub bytes: bool,
	/// Decode source text as UTF-8.
	pub utf8: bool,
	/// Lexically enabled and fatal warning categories.
	pub warnings: Warnings,
	/// Lexically enabled language features.
	pub features: Features,
	/// Additional lexical regex modifier bytes.
	pub re_mods: Vec<u8>,
	/// Permit evaluation in dynamically interpolated regex code groups.
	pub re_eval: bool,
	/// Lexical literal-constructor overload handlers.
	pub constant_overloads: std::collections::HashMap<String, super::Value>,
	/// Default input and output layers for open.
	pub open_layers: Option<(PStr, PStr)>,
	/// Names subject to lexical autodie.
	pub autodie: Vec<String>,
	/// Lexically active resource preferences from `use less`.
	pub less: Vec<String>,
	/// Package-defined warning categories enabled for this lexical scope.
	pub registered_warnings: std::collections::HashMap<String, (bool, bool)>,
}

impl Hints {
	pub(super) fn bitmask(&self, outer: bool) -> i64 {
		let mut bits = if outer { 0x100 } else { 0 };
		for (on, mask) in [
			(self.integer, 1), (self.strict_refs, 0x22), (self.strict_subs, 0x240),
			(self.strict_vars, 0x480), (self.bytes, 8), (self.utf8, 0x800000),
		] { if on { bits |= mask; } }
		if self.features != Features::default() { bits |= 0x3c02_0100; }
		bits
	}

	pub(super) fn lexical_entries(&self) -> Vec<(String, super::Value)> {
		let mut entries = Vec::new();
		if self.features != Features::default() {
			for name in ["say", "state", "switch", "fc", "signatures", "bitwise", "unicode_strings", "unicode_eval", "postderef_qq",
				"current_sub", "evalbytes", "isa", "try", "indirect", "multidimensional", "bareword_filehandles", "refaliasing", "declared_refs"] {
				if self.features.enabled(name) { entries.push((format!("feature_{name}"), super::Value::Int(1))); }
			}
		}
		if let Some((input, output)) = &self.open_layers {
			entries.push(("open_IN".into(), super::Value::Str(input.clone())));
			entries.push(("open_OUT".into(), super::Value::Str(output.clone())));
		}
		entries
	}
}
