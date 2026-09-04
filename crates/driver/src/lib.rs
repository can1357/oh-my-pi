#![recursion_limit = "256"]

//! Journal-first production composition for OMP application modes.

pub mod auth_backend;
pub mod auth_flow;
pub mod bridges;
pub mod cfg;
pub mod cleanse;
pub mod collab;
pub mod commit;
pub mod compress;
pub mod discovery;
pub mod ext_updates;
pub mod headless;
pub mod prompt_input;
pub mod prompt_templates;
pub mod registry;
pub mod rules;
pub mod secrets;
pub mod sessions;
pub mod settings;
pub mod share;
pub mod subagent;
pub mod telemetry_upload;
