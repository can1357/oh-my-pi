# ADR 0045 Alternative F

- Recorded acceptance and the envd admission and containment boundary in the ADR status.
- Left existing containment and router code unchanged. No second daemon or reconnect policy was added.
- Test command: `OMP_REMOTE_KEYCHAIN_SERVICE=buildbuddy-omp2-trial scripts/remote-verify.sh remote-plain-test omp-env`, with remote `CARGO_BUILD_JOBS=2`.
- Result: 58 passed, 0 skipped on BuildBuddy. The runner emitted three existing `smallvec` deprecation warnings.
- An initial attempt used a nonexistent recipe and ran no tests; the command above is the successful retry.
- No commit or push.
