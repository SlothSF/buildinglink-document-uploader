# BuildingLink Document Uploader

A desktop app that files property-management PDFs into [BuildingLink](https://www.buildinglink.com/) automatically — reading each document's unit, type, date, and occupant straight from its filename, uploading it to the right unit, and filing the original into the right network folder.

Built for a 800+ unit residential property where this was a manual, several-hours-a-week job.

![Electron](https://img.shields.io/badge/Electron-42-47848F?logo=electron&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-CommonJS-339933?logo=node.js&logoColor=white)
![Playwright](https://img.shields.io/badge/Playwright-1.60-2EAD33?logo=playwright&logoColor=white)
![Platform](https://img.shields.io/badge/platform-Windows-0078D6?logo=windows&logoColor=white)

---

## What it does

Drop a batch of scanned PDFs into a folder. The app reads each filename, works out what the document is, and does the rest:

```
2026 Unit Inspection 2-0216 05-22-2026.pdf
   │                  │      │
   │                  │      └─ document date
   │                  └──────── unit number
   └─────────────────────────── document type

  →  uploaded to BuildingLink as "2026 Unit Inspection & Compliance Checklist"
     type: Inspection · associated with the physical unit
  →  original moved to  \UNIT FILES\Building 2\Floor 02\Unit File #2-0216\
```

It recognises **28 document categories** — inspections, leases, pool passes, parking permits, storage bins, key receipts, move-in/move-out packets, water leaks, probate and ownership records, work orders, and a general correspondence bucket that's extended by adding a single keyword.

## Highlights

**Filename-driven classification.** No database, no manual tagging. A layered rule set extracts unit numbers (`2-0216`, `2-T-04`, `1-0118a`), dates in several formats, permit/bin numbers, occupant initials, and owner-vs-tenant markers. Parenthesised notes staff add for their own readability (`(Doe)`) are stripped before parsing, so they can never affect the result.

**Owner vs. tenant detection by pill colour.** BuildingLink renders an occupant's role badge with *identical markup* for owners and renters — only the parent chip's background colour differs. Since a renter's spouse and an owner's spouse both read `SPOUSE`, text matching misroutes them. The app climbs to the chip element, reads its computed background, converts to HSL, and classifies by hue. Every decision carries a `basis` string into the logs.

**Verification, not optimism.** Every mutating step confirms it actually happened:

- The document is only considered saved once its title's **occurrence count** in the unit's document list *increases* — presence alone would pass on a unit that already had that title.
- The title field silently truncates at 100 characters, so it's read back after filling and the verifier checks what was actually stored, not what was intended.
- Association radios are SVG elements with no `aria-checked` and no backing input; selection is confirmed by waiting for the component's re-render.

This matters because the failure mode is silent: a file that appears to upload, gets filed away, and simply isn't there.

**Interruptible mid-document.** Pause and Stop take effect in well under a second, *mid-upload*, without re-doing work. Pausing parks the async stack at the next checkpoint — the page, the open dialog and every local variable stay alive, so resuming continues mid-stride with no persistence layer. Genuinely unsafe windows (the save itself, the file move, multi-unit commits) are wrapped as critical sections where interrupts are recorded but deferred.

**Self-healing occupancy loads.** Reaching a unit by client-side navigation means BuildingLink never fetches the occupancy data the association options are built from — and the dialog is constructed once and never re-renders, so waiting longer doesn't help. The app detects the degenerate dialog, reloads the view, and retries with backoff, using the unit's own role map to distinguish "this unit really is empty" from "this data failed to load."

**Instrumentation.** Per-step timing (sorted by total cost across the run, since a 4-second step run 400× dwarfs a 20-second step run twice), plain-English error translation over a rules table, per-save diagnostics capturing form values, network traffic and before/after screenshots, and a detailed per-run log.

## Screenshots

Not included — every meaningful screen shows real resident names and unit numbers.

## Architecture

| File | Lines | Role |
|---|---:|---|
| `upload.js` | 6,732 | Engine — classification, browser automation, file placement, run control. Runs standalone as a CLI. |
| `index.html` | 1,332 | Renderer — live progress, per-type counters, run timer, summary. |
| `main.js` | 211 | Electron main process; bridges the engine's IO channels to IPC. |
| `preload.js` | 88 | Context-isolated bridge exposing `window.api`. |

The engine is deliberately UI-agnostic. `configureIO({ log, ask, askChoice, progress, logUpdate })` swaps the console for IPC, which is why the same file powers both the CLI and the desktop app, and why the whole thing is testable headlessly against mock pages.

## Running it

```bash
npm install
npm start          # desktop app
npm run cli        # CLI, test mode: one file per category
```

### CLI flags

| Flag | Effect |
|---|---|
| `--dry-run` | Offline plan only — no browser, no uploads, no file moves |
| `--all` | Process every qualifying file |
| `--types=a,b` | Restrict to given categories |
| `--limit=N` | Cap at N files, round-robin across categories |
| `--inspect-unit=X` | Dump a unit's occupant cards and role badges for debugging |

`--dry-run` prints the full plan — resolved title, document type, association, date and destination folder for every file — and is the right first move before any large batch.

### Building the installer

```bash
npx electron-builder --win
```

Produces a per-user NSIS installer in `dist\` — no admin rights required to install.

## Requirements

**To run the installed app** — what an end user needs:

- Windows
- Google Chrome (the automation drives real Chrome, not a bundled browser)
- Network access to the document share

Node.js is *not* required: the installer bundles its own runtime.

**To work on the source** — additionally:

- Node.js 18+

## Notes

This is domain-specific software written for one property's folder layout, filename conventions and BuildingLink configuration. It's published as a portfolio piece and a reference for anyone automating a similar stubborn, frames-based legacy web app — not as a drop-in tool.

Paths, category rules and keyword lists are all constants at the top of `upload.js`.

## License

ISC
