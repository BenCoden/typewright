# Contributing to Typewright

Thanks for taking a look. Bug fixes, new site adapters, importer improvements, and accessibility work are all welcome.

## Getting set up

You need Node.js 20.19 or newer (Vite 7 requires it).

```bash
git clone https://github.com/BenCoden/typewright.git
cd typewright
npm install
npm run dev        # http://localhost:5000 — Express API and Vite on one port
```

Data is written to `./data` (SQLite plus extracted figures). It is git-ignored, and deleting it gives you a fresh, empty app.

Docker works too: `docker compose up -d --build`.

## Before you open a pull request

Both of these must pass:

```bash
npm run check      # TypeScript, no errors
npm run build      # production client and server bundle
```

Then try your change in the running app. If it affects layout, check it at a phone width (375px) as well as desktop — the reader is used on both.

## Making a change easy to review

- **Keep a PR to one change.** A bug fix and an unrelated refactor are two PRs.
- **Explain the why.** Say what was broken or missing, how you reproduced it, and how you checked the fix.
- **Add screenshots** for anything visual.
- **Match the surrounding code.** Comments explain intent and edge cases, not what the next line does.

## Where things live

| Area | Files |
| --- | --- |
| File import (EPUB, PDF, Markdown, HTML, text) | `server/import.ts` |
| URL import and site adapters | `server/web-import.ts` |
| API routes and validation | `server/routes.ts` |
| Database schema and queries | `shared/schema.ts`, `server/storage.ts` |
| Typing engine and scoring (pure functions) | `client/src/lib/typing.ts` |
| Reader rendering | `client/src/components/reader.tsx` |
| Typing page, keyboard, per-block results | `client/src/pages/typing.tsx` |

The [README](README.md#how-it-is-put-together) explains the two core design decisions: books are ordered blocks rather than a character stream, and text is normalised once at import.

## Adding a site adapter

Adapters in `server/web-import.ts` turn a known site into clean blocks. A new one should:

1. Detect the site cheaply from the URL or the fetched HTML, and return `null` when it does not match, so the next adapter runs.
2. Use the site's own API or source format when it has one. This is far more reliable than scraping rendered HTML.
3. Fetch only through the existing `request` / `fetchText` / `fetchBinary` helpers. They enforce the guards against private and internal addresses and re-check every redirect. Never call `fetch` directly on a URL that came from page content.

## Database changes

The schema is created at startup in `server/storage.ts`. Existing installs must keep working, so add new columns with `ensureColumn(...)` rather than editing a `CREATE TABLE` statement on its own.

## Reporting bugs and suggesting features

Open an issue. For bugs, include the browser, the steps to reproduce, and — for import problems — the URL or file type you were importing.

Security issues should not be reported as public issues. See [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the [Apache License 2.0](LICENSE), the same license as the project.
