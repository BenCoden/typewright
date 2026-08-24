# Typewright

A local-first typing trainer for the books you already own. It reads EPUB, PDF, Markdown, HTML, and plain text, and turns each one into a typing session that keeps the book's structure intact:

- **Prose** is normalised and split into sentence-sized runs
- **Code listings** are typed verbatim — indentation, braces, and newlines included
- **Figures** are extracted from the file, stored locally, and shown inline as you type past them

Nothing leaves your machine. There is no account, no sync, and no outbound network call at runtime.

## Quick start

```bash
docker compose up -d --build
```

Then open <http://localhost:5000>.

On Windows there is a launcher that also opens a dedicated app window:

```powershell
.\Start-Typewright.ps1            # start and open
.\Start-Typewright.ps1 -Rebuild   # rebuild the image first
.\Start-Typewright.ps1 -Stop      # shut down
```

App mode (`chrome.exe --app=...`) matters more than it sounds: it removes the tab strip and with it the browser shortcuts that would otherwise fire mid-sentence. `Ctrl+W` cannot be intercepted by a web page, so the launcher removes the tab it would close.

### Without Docker

```bash
npm install
npm run dev     # http://localhost:5000, Express + Vite on one port
```

## Importing

Drag files onto the library page, or drop them in `./books` and click them in the **Watched folder** panel — that directory is mounted read-only into the container.

| Format | Prose | Code listings | Figures | Notes |
| --- | --- | --- | --- | --- |
| **EPUB** | Yes | Yes, exact | Yes, with captions | The best source. Structure is explicit in the markup. |
| **PDF** | Yes | Approximate | Yes | Text is reconstructed from glyph positions, so listing boundaries and indentation are guesses. |
| **Markdown** | Yes | Yes, from fenced blocks | No | Language tags on fences are used directly. |
| **HTML** | Yes | Yes, from `<pre>` | No | External images are not fetched. |
| **TXT** | Yes | Indent-detected | No | Project Gutenberg boilerplate is stripped automatically. |

Import both formats of the same book if you like — prefer the EPUB. On a Manning MEAP, the EPUB yields exact `<pre>` listings with their `Listing 10.1 …` captions and annotation legends, while the same PDF splits some listings and mixes annotation text into the flow.

Scanned PDFs with no text layer are rejected with an explanation rather than imported as gibberish.

## Typing

| Key | Behaviour |
| --- | --- |
| Printable keys | Compared against the expected character |
| `Enter` | A real character inside a listing — the `⏎` marker shows where it is expected |
| `Tab` | Consumes expected indentation, up to 8 spaces |
| `Backspace` | Steps back, and steps over auto-filled indentation in one move |
| `Esc` | Pause and resume |

**Strict mode** (default) holds the cursor on a mistake until you type the right character. Turned off, mistakes are marked and the cursor moves on.

**Auto-indent** (default) fills in the next line's leading whitespace after you press `Enter` in a listing, the way an editor would. Those characters are not counted as keystrokes, so they neither help nor hurt your speed.

Figures are never typed. The cursor walks past them while they stay on screen above the text that references them. Code can be skipped too, from Settings, if you want a prose-only pass.

Speed is reported separately for prose and code, because they are different skills and mixing them hides both.

## Where your data lives

```
data/
  typewright.db        SQLite: books, blocks, sessions, settings
  typewright.db-wal    write-ahead log
  assets/<bookId>/     figures extracted from that book
```

Back up `./data` and you have backed up everything. Delete it and the app starts empty. Sessions shorter than a second or five keystrokes are discarded rather than polluting your averages.

## How it is put together

```
shared/schema.ts     Data model shared by client and server
server/import.ts     File -> ordered blocks. Format parsers, normalisation, segmentation
server/storage.ts    SQLite access, schema creation, statistics
server/routes.ts     JSON API
client/src/lib/typing.ts        Typing engine — pure functions, no React
client/src/components/reader.tsx  Renders prose, listings, and figures
client/src/pages/typing.tsx     Cursor, keyboard, metrics, windowed loading
```

Two decisions are worth knowing about if you extend it:

**Blocks, not a character stream.** A book is an ordered list of `prose | heading | code | image` blocks. That single choice is what lets code be typed verbatim while prose gets normalised, and lets figures sit in the flow without being typed.

**Normalise once, at import.** Curly quotes, em dashes, ellipses, non-breaking spaces, ligatures, and soft hyphens are folded to characters a keyboard can produce, and the result is what gets stored. The typing engine then compares keystrokes to exactly what is on screen. Inside listings, curly quotes are always straightened — no real source file contains them — while everything else stays byte-exact.

Long books stay responsive because the typing view only ever holds a 60-block window in memory, refetching as the cursor moves.

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/books` | Library |
| `GET` | `/api/books/:id/blocks?from&count` | A window of blocks |
| `GET` | `/api/books/:id/outline` | Chapter and section headings |
| `POST` | `/api/import` | Multipart upload |
| `POST` | `/api/import/text` | Paste a passage or snippet |
| `GET` | `/api/library` | Files in the watched folder |
| `POST` | `/api/library/import` | Import from the watched folder |
| `GET` | `/api/assets/:id` | An extracted figure |
| `POST` | `/api/sessions` | Record a session |
| `GET` | `/api/stats` | Aggregates, daily series, worst keys |
| `GET`/`PATCH` | `/api/settings` | Preferences |

## Licence

Yours. The books you import stay yours too — they never leave the machine.
