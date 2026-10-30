/**
 * Synthetic bridge name reserved for the artifact readiness question, across
 * both runtimes.
 *
 * In a module of its own because the worker runtime asks the question and the
 * host answers it: importing the answer's module into the worker would bring
 * the session manager with it.
 */
export const EVAL_ARTIFACTS_READY_BRIDGE_NAME = "__artifacts_ready__";
