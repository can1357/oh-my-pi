# Changelog

## [Unreleased]

## [16.3.0] - 2026-07-23

### Added

- Initial TypeScript port of [langchain-ai/open_deep_research](https://github.com/langchain-ai/open_deep_research) on the pi-ai client: clarify → research brief → supervisor loop with parallel researcher sub-agents → per-researcher compression → final report generation, with Tavily search and webpage summarization.
- Added `maxTotalTokens` run budget with graceful wind-down: when crossed, the supervisor stops delegating and researchers stop iterating, but compression and the final report still run so the caller gets a report from findings so far (`result.budgetExhausted`, `budget_exhausted` event). Near the limit (`cooldownThresholdRatio`, default 0.8), a `cooldownMs` pause (default 30s) is inserted before each model call to ease provider rate/credit pressure (`budget_cooldown` event).
