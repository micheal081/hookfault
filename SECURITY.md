# Security policy

Security fixes target the latest released 0.1.x version. Hookfault sends real HTTP requests; use isolated test applications and synthetic payloads.

Do not post exploit details, credentials, or sensitive reports in public issues. Use GitHub's private vulnerability reporting on this repository (Security → Report a vulnerability). If that control is unavailable, contact the maintainer through the contact information on [@micheal081's profile](https://github.com/micheal081) and request a private reporting channel before sharing details.

Include the affected version, a minimal reproduction, impact, and proposed mitigation if known. Reports are handled by the sole maintainer; there is no guaranteed response time or bug bounty.

Relevant security boundaries include remote-target opt-in, redirect handling, bounded responses, timeouts, signing secrets, and report redaction. Reports may contain application response data; redaction cannot recognize arbitrary personal information or transformed secrets. Protect and expire CI artifacts accordingly.
