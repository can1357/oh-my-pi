//! Embedded lowest-priority TypeScript, Rust, and Go modernization rules.

use strum::{Display, EnumString, IntoStaticStr};

/// Language family targeted by one embedded rule.
#[derive(Clone, Copy, Debug, Display, EnumString, Eq, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "kebab-case", ascii_case_insensitive)]
pub enum BuiltinRuleLanguage {
	/// TypeScript and JavaScript source.
	TypeScript,
	/// Rust source.
	Rust,
	/// Go source.
	Go,
}

/// One immutable bundled rule declaration.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct BuiltinRuleAsset {
	/// Stable rule name.
	pub name:     &'static str,
	/// Language pack.
	pub language: BuiltinRuleLanguage,
	/// Full Markdown declaration including frontmatter.
	pub source:   &'static str,
}

/// All 27 modernization rules. They are parsed and glob-matched like authored
/// rules, never appended unconditionally.
pub const BUILTIN_RULES: &[BuiltinRuleAsset] = &[
	BuiltinRuleAsset {
		name:     "go-add-cleanup",
		language: BuiltinRuleLanguage::Go,
		source:   include_str!("builtin/go-add-cleanup.md"),
	},
	BuiltinRuleAsset {
		name:     "go-bench-loop",
		language: BuiltinRuleLanguage::Go,
		source:   include_str!("builtin/go-bench-loop.md"),
	},
	BuiltinRuleAsset {
		name:     "go-exp-promoted",
		language: BuiltinRuleLanguage::Go,
		source:   include_str!("builtin/go-exp-promoted.md"),
	},
	BuiltinRuleAsset {
		name:     "go-ioutil",
		language: BuiltinRuleLanguage::Go,
		source:   include_str!("builtin/go-ioutil.md"),
	},
	BuiltinRuleAsset {
		name:     "go-join-hostport",
		language: BuiltinRuleLanguage::Go,
		source:   include_str!("builtin/go-join-hostport.md"),
	},
	BuiltinRuleAsset {
		name:     "go-new-expr",
		language: BuiltinRuleLanguage::Go,
		source:   include_str!("builtin/go-new-expr.md"),
	},
	BuiltinRuleAsset {
		name:     "go-rand-v2",
		language: BuiltinRuleLanguage::Go,
		source:   include_str!("builtin/go-rand-v2.md"),
	},
	BuiltinRuleAsset {
		name:     "go-range-int",
		language: BuiltinRuleLanguage::Go,
		source:   include_str!("builtin/go-range-int.md"),
	},
	BuiltinRuleAsset {
		name:     "rs-box-leak",
		language: BuiltinRuleLanguage::Rust,
		source:   include_str!("builtin/rs-box-leak.md"),
	},
	BuiltinRuleAsset {
		name:     "rs-future-prelude",
		language: BuiltinRuleLanguage::Rust,
		source:   include_str!("builtin/rs-future-prelude.md"),
	},
	BuiltinRuleAsset {
		name:     "rs-lazylock",
		language: BuiltinRuleLanguage::Rust,
		source:   include_str!("builtin/rs-lazylock.md"),
	},
	BuiltinRuleAsset {
		name:     "rs-match-ergonomics",
		language: BuiltinRuleLanguage::Rust,
		source:   include_str!("builtin/rs-match-ergonomics.md"),
	},
	BuiltinRuleAsset {
		name:     "rs-parking-lot",
		language: BuiltinRuleLanguage::Rust,
		source:   include_str!("builtin/rs-parking-lot.md"),
	},
	BuiltinRuleAsset {
		name:     "rs-result-type",
		language: BuiltinRuleLanguage::Rust,
		source:   include_str!("builtin/rs-result-type.md"),
	},
	BuiltinRuleAsset {
		name:     "ts-bare-catch",
		language: BuiltinRuleLanguage::TypeScript,
		source:   include_str!("builtin/ts-bare-catch.md"),
	},
	BuiltinRuleAsset {
		name:     "ts-import-type",
		language: BuiltinRuleLanguage::TypeScript,
		source:   include_str!("builtin/ts-import-type.md"),
	},
	BuiltinRuleAsset {
		name:     "ts-no-any",
		language: BuiltinRuleLanguage::TypeScript,
		source:   include_str!("builtin/ts-no-any.md"),
	},
	BuiltinRuleAsset {
		name:     "ts-no-deprecated-leftovers",
		language: BuiltinRuleLanguage::TypeScript,
		source:   include_str!("builtin/ts-no-deprecated-leftovers.md"),
	},
	BuiltinRuleAsset {
		name:     "ts-no-dynamic-import",
		language: BuiltinRuleLanguage::TypeScript,
		source:   include_str!("builtin/ts-no-dynamic-import.md"),
	},
	BuiltinRuleAsset {
		name:     "ts-no-inline-cast-access",
		language: BuiltinRuleLanguage::TypeScript,
		source:   include_str!("builtin/ts-no-inline-cast-access.md"),
	},
	BuiltinRuleAsset {
		name:     "ts-no-local-is-record",
		language: BuiltinRuleLanguage::TypeScript,
		source:   include_str!("builtin/ts-no-local-is-record.md"),
	},
	BuiltinRuleAsset {
		name:     "ts-no-return-type",
		language: BuiltinRuleLanguage::TypeScript,
		source:   include_str!("builtin/ts-no-return-type.md"),
	},
	BuiltinRuleAsset {
		name:     "ts-no-test-timers",
		language: BuiltinRuleLanguage::TypeScript,
		source:   include_str!("builtin/ts-no-test-timers.md"),
	},
	BuiltinRuleAsset {
		name:     "ts-no-tiny-functions",
		language: BuiltinRuleLanguage::TypeScript,
		source:   include_str!("builtin/ts-no-tiny-functions.md"),
	},
	BuiltinRuleAsset {
		name:     "ts-promise-with-resolvers",
		language: BuiltinRuleLanguage::TypeScript,
		source:   include_str!("builtin/ts-promise-with-resolvers.md"),
	},
	BuiltinRuleAsset {
		name:     "ts-redundant-clear-guard",
		language: BuiltinRuleLanguage::TypeScript,
		source:   include_str!("builtin/ts-redundant-clear-guard.md"),
	},
	BuiltinRuleAsset {
		name:     "ts-set-map",
		language: BuiltinRuleLanguage::TypeScript,
		source:   include_str!("builtin/ts-set-map.md"),
	},
];

const _: () = assert!(BUILTIN_RULES.len() == 27, "the built-in rule pack must remain complete");
