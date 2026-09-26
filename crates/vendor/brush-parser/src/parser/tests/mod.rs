//! Test harness for comparing Peg and Winnow parser implementations.
//!
//! This module provides utilities to test both parser implementations
//! and verify they produce equivalent results.

mod and_or_lists;
mod assignments;
mod complex;
mod compound_commands;
mod extended_test;
mod functions;
mod here_docs;
mod pipelines;
mod redirections;
mod simple_commands;

use crate::ast::Program;
use crate::error::ParseError;
use crate::parser::{Parser, ParserImpl, ParserOptions};
use anyhow::Result;
#[cfg(feature = "winnow-parser")]
use serde_json::Value;

/// Wrapper struct for serializing parse results with input context
#[derive(serde::Serialize)]
pub struct ParseResult<'a, T> {
    pub input: &'a str,
    pub result: &'a T,
}

/// Macro to assert snapshots with location information redacted.
/// This makes snapshots stable across parser changes that only affect source locations.
#[macro_export]
macro_rules! assert_snapshot_redacted {
    ($value:expr) => {{
        let mut settings = insta::Settings::clone_current();
        settings.add_redaction(".**.loc", "[location]");
        settings.bind(|| {
            insta::assert_ron_snapshot!($value);
        });
    }};
}

/// Recursively redact location fields from a JSON value.
/// This normalizes AST representations for comparison by removing source location info.
#[cfg(feature = "winnow-parser")]
fn redact_locations(value: &mut Value) {
    match value {
        Value::Object(map) => {
            // Remove location-related fields
            map.remove("loc");
            // Also handle tuple structs that store SourceSpan as positional element
            // These appear as arrays with SourceSpan objects

            // Recursively process remaining fields
            for (_, v) in map.iter_mut() {
                // If this value is a SourceSpan object, normalize it
                if is_source_span(v) {
                    normalize_source_span(v);
                } else {
                    redact_locations(v);
                }
            }
        }
        Value::Array(arr) => {
            // Check if this array looks like a tuple struct containing SourceSpan at the end
            // SourceSpan has: start: SourcePosition, end: SourcePosition
            // SourcePosition has: index, line, column
            if let Some(last) = arr.last() {
                if is_source_span(last) {
                    arr.pop();
                }
            }

            for item in arr.iter_mut() {
                redact_locations(item);
            }
        }
        _ => {}
    }
}

/// Check if a value looks like a `SourceSpan` object
#[cfg(feature = "winnow-parser")]
fn is_source_span(value: &Value) -> bool {
    if let Value::Object(map) = value {
        map.contains_key("start") && map.contains_key("end") && map.len() == 2
    } else {
        false
    }
}

/// Normalize a `SourceSpan` object by replacing its positions with placeholder values.
/// This allows comparing ASTs without position differences.
#[cfg(feature = "winnow-parser")]
fn normalize_source_span(value: &mut Value) {
    if let Value::Object(map) = value {
        let placeholder_pos = serde_json::json!({
            "index": 0,
            "line": 0,
            "column": 0
        });
        map.insert("start".to_string(), placeholder_pos.clone());
        map.insert("end".to_string(), placeholder_pos);
    }
}

/// Convert a Program to a normalized JSON value with locations redacted
#[cfg(feature = "winnow-parser")]
#[allow(clippy::expect_used)]
fn normalize_ast(program: &Program) -> Value {
    let mut value = serde_json::to_value(program).expect("Failed to serialize Program to JSON");
    redact_locations(&mut value);
    value
}

/// A named parser configuration for test output clarity
#[derive(Debug, Clone)]
pub struct ParserConfig {
    pub name: &'static str,
    pub parser_impl: ParserImpl,
}

/// Returns all available parser implementations for testing.
/// - Without `winnow-parser`: returns only Peg
/// - With `winnow-parser`: returns both Peg and Winnow
pub fn parser_configs() -> Vec<ParserConfig> {
    #[allow(unused_mut)]
    let mut configs = vec![ParserConfig {
        name: "peg",
        parser_impl: ParserImpl::Peg,
    }];

    #[cfg(feature = "winnow-parser")]
    configs.push(ParserConfig {
        name: "winnow",
        parser_impl: ParserImpl::Winnow,
    });

    configs
}

/// Helper to parse input with a specific parser configuration
pub fn parse_with_config(input: &str, config: &ParserConfig) -> Result<Program, ParseError> {
    let options = ParserOptions {
        parser_impl: config.parser_impl,
        ..Default::default()
    };

    let mut parser = Parser::new(std::io::Cursor::new(input), &options);
    parser.parse_program()
}

/// Verify all parser implementations produce the same result.
///
/// This function parses the input with each available parser and verifies
/// they all produce structurally equivalent ASTs. Returns an error if
/// parsing fails or if the results differ.
#[cfg(feature = "winnow-parser")]
#[allow(dead_code)]
pub fn test_all_parsers_match(input: &str) -> Result<()> {
    let configs = parser_configs();

    // Parse with each configuration
    let mut results: Vec<(&str, Program)> = Vec::new();

    for config in &configs {
        let result = parse_with_config(input, config).map_err(|e| {
            anyhow::anyhow!(
                "Parser '{}' failed to parse input: {}\nInput: {}",
                config.name,
                e,
                input
            )
        })?;
        results.push((config.name, result));
    }

    // Compare all results against the first (peg) implementation
    // Normalize ASTs by redacting location info before comparison
    if results.len() > 1 {
        let (base_name, base_result) = &results[0];
        let base_normalized = normalize_ast(base_result);
        for (name, result) in results.iter().skip(1) {
            let result_normalized = normalize_ast(result);
            pretty_assertions::assert_eq!(
                base_normalized,
                result_normalized,
                "Parser outputs differ between '{}' and '{}'.\nInput: {}",
                base_name,
                name,
                input
            );
        }
    }

    Ok(())
}

/// Run a test and create snapshot for peg parser (canonical implementation).
///
/// This function parses the input with the peg parser and returns the result
/// for snapshot testing. When the winnow-parser feature is enabled, it also
/// verifies that winnow produces the same result.
pub fn test_with_snapshot(input: &str) -> Result<Program> {
    // Always parse with peg (canonical implementation)
    let peg_config = ParserConfig {
        name: "peg",
        parser_impl: ParserImpl::Peg,
    };
    let peg_result = parse_with_config(input, &peg_config)
        .map_err(|e| anyhow::anyhow!("Peg parser failed: {e}\nInput: {input}"))?;

    // When winnow is enabled, verify it matches (ignoring location differences)
    #[cfg(feature = "winnow-parser")]
    {
        let winnow_config = ParserConfig {
            name: "winnow",
            parser_impl: ParserImpl::Winnow,
        };
        let winnow_result = parse_with_config(input, &winnow_config)
            .map_err(|e| anyhow::anyhow!("Winnow parser failed: {e}\nInput: {input}"))?;

        // Normalize both ASTs by redacting location info before comparison
        let peg_normalized = normalize_ast(&peg_result);
        let winnow_normalized = normalize_ast(&winnow_result);

        pretty_assertions::assert_eq!(
            peg_normalized,
            winnow_normalized,
            "Parser outputs differ between 'peg' and 'winnow'.\nInput: {}",
            input
        );
    }

    Ok(peg_result)
}

#[cfg(test)]
mod harness_tests {
    use super::*;

    #[test]
    fn test_parser_configs_includes_peg() {
        let configs = parser_configs();
        assert!(!configs.is_empty());
        assert_eq!(configs[0].name, "peg");
    }

    #[test]
    #[cfg(feature = "winnow-parser")]
    fn test_parser_configs_includes_winnow() {
        let configs = parser_configs();
        assert!(configs.len() >= 2);
        assert!(configs.iter().any(|c| c.name == "winnow"));
    }

    #[test]
    fn test_parse_with_config_basic() {
        let config = ParserConfig {
            name: "peg",
            parser_impl: ParserImpl::Peg,
        };
        let result = parse_with_config("echo hello", &config);
        assert!(result.is_ok());
    }
}
