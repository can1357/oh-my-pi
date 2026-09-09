//! Shared fixtures for inference integration-test targets.

#![allow(dead_code, reason = "each test target exercises a subset of the shared modules")]

pub mod auth;
pub mod descriptors;
pub mod oracle;
pub mod refresh;
pub mod route_factory;
