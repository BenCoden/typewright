# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub instead: open the repository's **Security** tab and choose **Report a vulnerability**. Include what you found, how to reproduce it, and what an attacker could do with it.

You should get an acknowledgement within a week. Once a fix is ready, it will be released and the report credited unless you prefer otherwise.

## Scope

Typewright is designed to run locally for one person. The areas most worth testing are:

- **URL import.** The server fetches pages you paste. It must never reach loopback, private, link-local, or cloud-metadata addresses, including through redirects.
- **Imported content.** Books and web pages are untrusted input. Nothing in them should run script in the reader or become a live `javascript:` or `data:` link.
- **File import and asset serving.** Uploads and extracted figures must not allow path traversal outside `./data`.
