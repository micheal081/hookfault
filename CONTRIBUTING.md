# Contributing to Hookfault

Bug reports, documentation, tests, and focused features are welcome. For a substantial change, open an issue first to agree on behavior and compatibility.

1. Fork the repository and create a branch.
2. Install Node.js 20 or newer and run `npm ci`.
3. Make a focused change. Add behavioral tests using local ephemeral HTTP servers; do not depend on real SaaS accounts or internet access.
4. Run `npm run format` and `npm run check`.
5. Open a pull request explaining the problem, behavior, and validation.

Never include real signing secrets, authorization headers, customer payloads, or production endpoint addresses in issues, fixtures, or logs. Report vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

TypeScript ESM source lives in `src/`; Vitest tests in `tests/`. Keep networking, configuration, assertions, and presentation separate. Configuration changes must update the schema and reference documentation. Keep the npm lockfile; avoid unrelated dependency changes.

By contributing, you agree that your contributions are licensed under the MIT License and that you will follow the [Code of Conduct](CODE_OF_CONDUCT.md).

The repository owner, **@micheal081**, is the sole maintainer with merge authority. Contributors submit pull requests from forks and do not receive write access. Approval does not authorize another person or automation to merge. See [GOVERNANCE.md](GOVERNANCE.md).
