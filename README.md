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
| `Enter` | A real character inside a listing — a faint `⏎` marks where it is due |
| `Tab` | Fills in expected indentation, up to 8 spaces |
| `Backspace` | Steps back, clearing auto-filled indentation in one move |

### Shortcuts

Typing consumes every printable key, so commands sit on modifiers. `Ctrl+/` shows this list in-session.

| Shortcut | Does |
| --- | --- |
| `Ctrl+M` | Switch in and out of reading mode |
| `Ctrl+/` | Show the shortcut list |
| `Esc` | Pause and resume |
| `Ctrl+↓` | Skip the rest of the current line |
| `Ctrl+→` | Skip this paragraph, listing, or figure |
| `Ctrl+←` | Back to the previous paragraph |
| `Ctrl+Shift+→` / `Ctrl+Shift+←` | Jump between section headings |
| `Ctrl+Backspace` | Start this block over |

**Reading mode** is a read-only pass over the same page at its own text size and leading — nothing is scored, and the HUD gets out of the way. Because no keystrokes are being graded there, the bare keys are free for navigation:

| Key | Does |
| --- | --- |
| `↓` / `J`, `↑` / `K` | Move a block forward or back |
| `Shift+→` / `Shift+←` | Next or previous section heading |
| `Space` | Scroll normally |
| `Enter` | Start typing from here |

### Typing settings

| Setting | Options | Notes |
| --- | --- | --- |
| **On a mistake** | Block / Mark / Fix | Block holds the cursor until you type the right character. Mark leaves it visible and moves on. Fix repairs the character so the page stays readable — the error still counts and the repair earns no credit. |
| **After finishing a block** | Move on / Wait for Enter | Whether the cursor advances by itself or you set the pace. |
| **Ignore capitalisation in prose** | On / Off | Prose only. Listings always compare exactly, because case matters in code. |
| **Auto-indent code** | On / Off | Fills the next line's leading whitespace after `Enter`. Those characters are not counted as keystrokes, so they neither help nor hurt your speed. |
| **Skip code listings** | On / Off | Read listings instead of typing them. |
| **Caret style** | Line / Block / Underline | Plus a separate blink toggle. |
| **Show newline markers** | On / Off | The `⏎` at each line end inside a listing. |
| **Keep active line in position** | On / Off | Pins the line you are typing instead of scrolling the page under you. |
| **Mark incorrect words** | On / Off | Underlines the whole mistyped word, not just the missed character. |
| **Auto-pause** | 2s / 5s / 10s / Never | Idle longer than this and the session parks itself. The same threshold stops the clock, so the timer and the screen always agree about whether you are working. |
| **Tone on a mistake** | On / Off | Synthesised, not a downloaded asset. |

Reading mode has its own text size and line height, separate from the typing prompt.

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
client/src/components/shortcuts.tsx  One shortcut list, shared by the overlay and settings
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
