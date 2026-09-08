# Governance and maintainer guide

Hookfault is maintained by @micheal081. Outside contributions are welcome through issues and fork-based pull requests. Only the repository owner personally merges changes. No collaborators are granted write access, and automatic merging remains disabled.

The owner reviews scope, correctness, tests, security implications, and compatibility before merging. CODEOWNERS identifies the owner for all files. Branch protection should require pull requests, owner review, passing `quality` CI, resolved conversations, and prohibit force pushes and deletion. Read back settings after changes; plan/API limitations must be documented rather than assumed away.

With a single maintainer and required owner review, an owner-authored pull request cannot approve itself. Keep the rule: external contributions can be reviewed and merged by the owner; owner-authored changes need a deliberately reviewed governance decision instead of silently bypassing protection. Administrators can always change repository policy; no GitHub configuration can prevent its owner from changing their own settings.

Before a release, run `npm ci`, `npm run check`, review `npm pack --dry-run`, update the changelog, verify remote CI, and inspect package contents. npm publishing and GitHub Releases require an explicit maintainer decision. Package metadata requests provenance; this does not itself produce an attestation. Use a supported trusted publishing workflow when npm publication is introduced.
