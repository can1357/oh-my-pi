//! The shared engine: configuration and the compiled-unit cache.

use std::{
	collections::{HashMap, VecDeque},
	sync::Arc,
};

use bstr::BString;
use parking_lot::Mutex;

use crate::bash::{
	ids::{ModeId, Platform, UnitId, Vpid},
	ir::{self, Unit},
	syntax::{CompleteCommand, Features, NO_ALIASES, TextMode},
	vm::{ArithCache, PatternCache, TextKind, ZshPatternCache},
};

/// Text parsed at run time did not parse (or uses a construct this engine
/// cannot run yet).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TextError {
	/// Line within the text.
	pub line: u32,
	/// bash's message.
	pub msg:  BString,
}

/// Engine-wide settings.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EngineConfig {
	/// Budget of the compiled-unit cache in bytes (default 32 MiB).
	pub unit_cache_bytes: usize,
	/// Hard limit on shell-level call depth (`FUNCNEST` defaults to unlimited
	/// below it; default 10 000).
	pub max_call_depth:   u32,
	/// First vpid (default 2^30).
	pub vpid_base:        u32,
	/// Platform semantics (default: the build target).
	pub platform:         Platform,
	/// End the in-engine work of a subshell's background jobs once the
	/// subshell exits (default `false`: they run on as orphans, as in bash).
	/// An orphaned job is ended, with its pipeline stages and subshells, as
	/// an untrapped `TERM` ends it as soon as any of them is in a shell loop
	/// (even one waiting on an external), runs a native task or waits in
	/// `wait`; its own background jobs are judged the same way in turn. A
	/// job that is just its external program (`(server >log &)`, also after
	/// builtins such as `cd` on the way to it) and a detached (`nohup`) tree
	/// run on.
	pub end_orphan_jobs:  bool,
}

impl Default for EngineConfig {
	fn default() -> Self {
		Self {
			unit_cache_bytes: 32 << 20,
			max_call_depth:   10_000,
			vpid_base:        Vpid::BASE,
			platform:         Platform::current(),
			end_orphan_jobs:  false,
		}
	}
}

/// Shared per runtime or process: the compiled-unit cache keyed by content
/// address. `Send + Sync`; every [`Shell`](crate::bash::Shell) holds an `Arc`
/// to it.
pub struct Engine {
	cfg:          EngineConfig,
	units:        Mutex<UnitCache>,
	/// Units of text parsed at run time (here-document bodies, arithmetic).
	texts:        Mutex<HashMap<(TextKind, ModeId, BString), Arc<Unit>>>,
	/// Compiled arithmetic expressions by text (bounded; see
	/// [`ArithCache::get`]).
	arith:        ArithCache,
	/// Compiled shell patterns by text and options (bounded; see
	/// [`PatternCache::get`]).
	patterns:     PatternCache,
	/// Compiled zsh patterns (bounded; see [`ZshPatternCache`]).
	zsh_patterns: ZshPatternCache,
}

#[derive(Default)]
struct UnitCache {
	map:   HashMap<UnitId, Arc<Unit>>,
	order: VecDeque<UnitId>,
	bytes: usize,
}

impl Engine {
	/// New engine with `cfg`.
	pub fn new(cfg: EngineConfig) -> Arc<Self> {
		Arc::new(Self {
			cfg,
			units: Mutex::new(UnitCache::default()),
			texts: Mutex::new(HashMap::new()),
			arith: ArithCache::default(),
			patterns: PatternCache::default(),
			zsh_patterns: ZshPatternCache::default(),
		})
	}

	/// The compiled-arithmetic cache.
	pub(crate) const fn arith(&self) -> &ArithCache {
		&self.arith
	}

	/// The compiled-pattern cache.
	pub(crate) const fn patterns(&self) -> &PatternCache {
		&self.patterns
	}

	/// The compiled zsh-pattern cache.
	pub(crate) const fn zsh_patterns(&self) -> &ZshPatternCache {
		&self.zsh_patterns
	}

	/// The configuration.
	pub const fn config(&self) -> &EngineConfig {
		&self.cfg
	}

	/// Identity of this engine build; frames from another build are refused.
	pub fn build_id() -> [u8; 32] {
		let mut h = blake3::Hasher::new();
		h.update(env!("CARGO_PKG_VERSION").as_bytes());
		h.update(&ir::IR_VERSION.to_le_bytes());
		h.update(&crate::bash::vm::FRAMES_VERSION.to_le_bytes());
		*h.finalize().as_bytes()
	}

	/// Compile one parsed top-level command of `src`; constructs not
	/// implemented yet become a unit that fails loudly.
	pub(crate) fn compile(
		&self,
		cc: &CompleteCommand,
		src: &[u8],
		mode: ModeId,
		features: Features,
	) -> Arc<Unit> {
		let unit = ir::lower_deferred(cc, src, mode, features).unwrap_or_else(|what| {
			ir::abort_unit(cc.span.slice(src), mode, features, cc.line, vec![what.into()], 0, 2)
		});
		self.intern(unit)
	}

	/// Share `unit` through the cache (an identical cached unit wins).
	pub(crate) fn intern(&self, unit: Unit) -> Arc<Unit> {
		let mut cache = self.units.lock();
		if let Some(hit) = cache.map.get(&unit.id) {
			return Arc::clone(hit);
		}
		let weight = unit.weight();
		let id = unit.id;
		let unit = Arc::new(unit);
		cache.map.insert(id, Arc::clone(&unit));
		cache.order.push_back(id);
		cache.bytes += weight;
		while cache.bytes > self.cfg.unit_cache_bytes && cache.order.len() > 1 {
			let Some(old) = cache.order.pop_front() else {
				break;
			};
			if let Some(u) = cache.map.remove(&old) {
				cache.bytes -= u.weight();
			}
		}
		unit
	}

	/// The unit of `text` parsed at run time as `kind`, cached by content.
	pub(crate) fn text_unit(
		&self,
		text: &[u8],
		kind: TextKind,
		mode: ModeId,
	) -> Result<Arc<Unit>, TextError> {
		let key = (kind, mode, BString::from(text));
		if let Some(u) = self.texts.lock().get(&key) {
			return Ok(Arc::clone(u));
		}
		let unsupported = |what: &str| TextError {
			line: 1,
			msg:  BString::from(format!("{what}: not supported by this engine yet")),
		};
		let unit = match kind {
			TextKind::Arith | TextKind::HereDoc => {
				let tmode = if kind == TextKind::Arith {
					TextMode::Arith
				} else {
					TextMode::HereDoc
				};
				let word = crate::bash::syntax::parse_text(text, Features::NONE, tmode)
					.map_err(|e| TextError { line: e.line, msg: BString::from(e.bash_msg()) })?;
				ir::lower_text(&word, text, mode, Features::NONE).map_err(unsupported)?
			},
			TextKind::Compound => {
				// bash parses the text as words with the shell parser
				// (`parse_string_to_word_list`); here it is the list of a
				// declaration argument, so the elements lower as written
				// ones do.
				let mut src = Vec::with_capacity(text.len() + 14);
				src.extend_from_slice(b"declare __=(");
				src.extend_from_slice(text);
				src.extend_from_slice(b")\n");
				let mut parser = crate::bash::syntax::Parser::new(&src, Features::NONE, NO_ALIASES);
				let cc = match parser.next_command() {
					Some(Ok(cc)) => cc,
					Some(Err(e)) => {
						return Err(TextError { line: e.line, msg: BString::from(e.bash_msg()) });
					},
					None => return Err(unsupported("an empty compound array value")),
				};
				if parser.next_command().is_some() {
					return Err(unsupported("a compound array value that is not one word list"));
				}
				ir::lower_compound(&cc, &src, mode, Features::NONE).map_err(unsupported)?
			},
		};
		let unit = Arc::new(unit);
		let mut texts = self.texts.lock();
		if texts.len() > 4096 {
			texts.clear();
		}
		texts.insert(key, Arc::clone(&unit));
		Ok(unit)
	}

	/// A cached unit.
	pub(crate) fn cached(&self, id: &UnitId) -> Option<Arc<Unit>> {
		self.units.lock().map.get(id).cloned()
	}
}
