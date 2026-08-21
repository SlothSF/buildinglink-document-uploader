const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const readline = require('readline');

// ═══════════════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════════════
const FILES_DIR  = 'S:\\Unsorted files';
const DEST_ROOT  = 'S:\\UNIT FILES';
const SEARCH_URL = 'https://buildinglink.com/v2/mgmt/UnitProfile/Searchunit.aspx';

// ── Common Area work orders (building-level, NOT unit-level) ───────────────
// Unlike every other category, these do not live in the root of FILES_DIR —
// they sit in a per-building SUBFOLDER of it:
//   S:\Unsorted files\bldg 1 common area work orders\
//   S:\Unsorted files\bldg 2 common area work orders\
//   S:\Unsorted files\bldg 3 common area work order\     ← note: no "s"
// The folder names are typed by hand and already drift ("areas"/"area",
// "orders"/"order"), so a folder is recognized by its three PARTS in any order
// and either plurality rather than by an exact name.
//
// ⚠️ The BUILDING comes from the FOLDER, never from the filename. A common area
// work order names no unit at all ("Work Order #16669 07-23-2026.pdf"), which is
// also what keeps these apart from REGULAR unit work orders: those sit in the
// root of FILES_DIR and carry a unit number, and classifyFile decides on the
// folder FIRST — before the filename "work order" keyword is ever consulted —
// so the two can never be confused in either direction.
const COMMON_AREA_BLDG_RE = /\bbldg\.?\s*(\d)\b/i;
const COMMON_AREA_AREA_RE = /\bcommon\s*-?\s*areas?\b/i;
const COMMON_AREA_WORK_RE = /\bwork\s*-?\s*orders?\b/i;

// Building number for a common-area source folder, or null when the folder is
// not one. Accepts a full path or a bare folder name; anything without all three
// parts (bldg <n> + common area + work order) is not one of these folders.
function commonAreaBuildingOf(folder) {
  if (!folder) return null;
  const name = path.basename(String(folder));
  if (!COMMON_AREA_AREA_RE.test(name)) return null;
  if (!COMMON_AREA_WORK_RE.test(name)) return null;
  const m = name.match(COMMON_AREA_BLDG_RE);
  return m ? m[1] : null;
}

// ═══════════════════════════════════════════════════════════════
// FILENAME PARSING
// ═══════════════════════════════════════════════════════════════

// Text in parentheses is a human-readable note — usually the occupant's name, as
// in "Lease Agreement for 1-0113 (Doe) Expires 05-31-2027 06-01-2026.pdf".
// Workers add these so files are identifiable when browsing folders, so they may
// appear in ANY file type, anywhere in the name, and must never affect parsing.
// Every extractor below runs on this normalized stem, which:
//   • drops the ".pdf" extension (case-insensitively, unlike path.basename's
//     exact-match second argument, so a stray ".PDF" can't break end-anchored
//     patterns),
//   • removes every parenthesized run — repeatedly, so nested "( a (b) )" goes
//     too — replacing each with a space so neighbouring tokens never fuse,
//   • collapses the leftover whitespace, which is what lets the end-anchored
//     patterns (trailing date, O/T flag, initials) still match when the note
//     sits at the end of the name.
// An unbalanced "(" is left alone: discarding the rest of the name would throw
// away real fields, and a lone bracket harms none of the patterns below.
function parseBase(filename) {
  let s = String(filename).replace(/\.pdf$/i, '');
  let prev;
  do { prev = s; s = s.replace(/\([^()]*\)/g, ' '); } while (s !== prev);
  return s.replace(/\s+/g, ' ').trim();
}

// Miscellaneous correspondence — documents with no title convention of their own,
// recognized purely by keyword. Every one of them is handled identically (upload
// as Correspondence, associated with the physical unit, filed under Unit Owner
// Delete-Able Files\Correspondence), so they share ONE category instead of each
// getting its own handler. To add a new kind of correspondence, add its keyword
// here — nothing else needs to change.
//
// This list is checked LAST in classifyFile (immediately before 'unknown'), so it
// can only ever narrow the unknown bucket: a keyword added here can never steal a
// file from an existing category, no matter how generic it is.
//
// Strings are plain substring matches against the lowercased, paren-stripped stem.
// Regexes cover spelling variation — "shut off", "shutoff" and "shut-off" are all
// written in the wild, so both shutoff phrasings are matched either way.
const CORRESPONDENCE_KEYWORDS = [
  'death certificate',
  'final notice',
  'returned mail',
  // The word itself — "Closing Correspondence", "Resale Package Correspondence",
  // anything else that says what it is. Spelled with an "a" about as often as
  // with an "e".
  /correspond[ae]nce/,
  // "Questionnaire" is misspelled constantly — the doubled "n" and the "ai" are
  // both routinely dropped. Tolerated: questionnaire / questionaire /
  // questionnare / questionnair (and "condominium" for the "condo" half).
  /condo\w*\s*-?\s*questionn?ai?re?/,
  /water\s*shut\s*-?\s*off/,
  /shut\s*-?\s*off\s*notice/,
  // "Complaint Form" and "Complaint Letter", plus complain/complaints.
  /complain\w*\s*-?\s*(form|letter)/,
  // "Vacation Notice" — vaction/vacaton and friends all start "vac".
  /vac\w*\s*-?\s*notice/,
  // Key-related correspondence. These are NOT key receipts; isKeyLogName
  // explicitly refuses them so the keylog rule (which runs earlier) can't take
  // one whose name happens to include "receipt".
  /permission\s*to\s*release/,
  /mail\s*-?\s*box\s*keys?/,
  /tennis/,
  // "Authorize Tenant", "Authorized Tenant", "Authorization for Tenant".
  /authoriz\w*\s*(for\s*)?tenants?/,
  // "Add Occupant" also covers "Remove and Add Occupant"; the second pattern
  // catches a removal written on its own.
  /\badd\s*occupants?/,
  /\bremove\s*(and\s*)?(add\s*)?occupants?/,
  // "Payment for Thermostat" / "Thermostat Payment" — either word order, and the
  // word "thermostat" appears in nothing else we file.
  /thermostat/,
  /\bhoa\b[\s-]*dues?/,
  // "Vehicle Registration Renewal". The parking rules run earlier and require
  // "parking permit", so this can never collide with them.
  /vehicle\s*registration/,
  // "PROBATE DOCUMENTS for 1-0101 05-04-2026" — estate paperwork filed after an
  // owner's death, which arrives under many names ("Probate Documents", "Probate
  // Court Order", "Letters of Administration - Probate"). Only the word "probate"
  // identifies it and nothing else we file contains it, so match on that alone.
  //
  // ⚠️ Probate packets often ENCLOSE a deed or a power of attorney, and the
  // ownership rule (OWNERSHIP_KEYWORDS) runs one step earlier — so a name that
  // says both ("Probate Deed") files as 'ownership' under Permanent Files, not
  // here. That is the intended precedence: the deed is the stronger claim.
  /probate/,
  // ── Fuzzy-matched types ──────────────────────────────────────────────────
  // The three below are matched on their core distinguishing word rather than
  // on a phrase, the same tolerance resolveFolderName applies to folder names:
  // real filenames vary in word order, plurality and spelling, and a phrase
  // match would drop every variation into 'unknown'.
  //
  // "Notice of Foreclosure Sale", "Foreclosure Sale Notice", "Notice of
  // Forclosure Sale" — only "foreclosure" identifies the document, and the "e"
  // after "for" is dropped about as often as it is typed. Also tolerates a
  // space or hyphen ("Fore-Closure"). Nothing else we file contains "closur".
  /\bfore?\s*-?\s*closur\w*/,
  // "Resident Transaction Report", either order ("Report of Resident
  // Transactions"), and with the "i" dropped from "transaction" — a common typo.
  // "resident" is deliberately NOT required: it is the generic half of the name
  // and appears in plenty of other documents, while "transaction report" appears
  // in nothing else.
  /transact\w*\s*-?\s*reports?|reports?\s*-?\s*(of\s+)?(resident\s+)?transact\w*/,
  // "Rental Approval for Meeting Room", "Meeting Room Rental Approval",
  // "Approval for Rental of Meeting Room", or just "Rental Approval" — the room
  // half varies and is optional, so only "rental" + "approval" is required, in
  // either order. "ap+rov" tolerates the routinely-dropped second "p"
  // ("Aproval"). The lease rules run earlier and require "lease agreement" /
  // "lease addendum", so "rental" here can never take one of theirs; the meeting
  // room CONTRACT rule likewise guards itself against the approval wording (see
  // classifyFile), which is what lets the second word order reach this list.
  /rent\w*\s*-?\s*ap+rov\w*|ap+rov\w*\s*(for\s+)?(the\s+)?rent\w*/,
];

function isCorrespondenceKeyword(l) {
  return CORRESPONDENCE_KEYWORDS.some(k => (typeof k === 'string' ? l.includes(k) : k.test(l)));
}

// Proof-of-ownership documents — deeds and powers of attorney. Same shape as the
// correspondence group above (no title convention, no occupant to match, read
// only the unit and the date), but they are Proof of Ownership documents and file
// under Permanent Files, so they get their own category rather than joining it.
//
// Checked immediately BEFORE the correspondence group, i.e. second-to-last, so
// like that group it can only ever narrow the 'unknown' bucket. ALTA settlement
// statements are also proof of ownership but have a real title convention of
// their own, so they keep their earlier, more specific rule.
//
// Word-boundary matched: "deed" must be the word, not a fragment of another one,
// and "poa" must not fire on a longer word that happens to contain those letters.
const OWNERSHIP_KEYWORDS = [
  /\bdeeds?\b/,
  /\bpoas?\b/,
  /power\s*of\s*attorney/,
];

function isOwnershipKeyword(l) {
  return OWNERSHIP_KEYWORDS.some(k => k.test(l));
}

// ── Key logs (Emergency & Convenience Key Receipt / Emergency Key Control Log) ──
//
// These names are typed by hand and vary more than any other category:
// "Convinence"/"Convenience", "Reciept"/"Receipt", an optional "#" log number,
// "for"/"on" filler words, sometimes a trailing O/T. NONE of it matters —
// uploadKeyLog reads only the unit and the date. The title is fixed, and the
// destination is always Unit Owner → Correspondence, so an O/T flag carries no
// meaning here at all.
//
// So the classifier only has to RECOGNISE the document, not parse it: the word
// "key" plus any single word that identifies this form, spelling tolerated. That
// is what keeps extra text from ever turning into an error — there is nothing
// left for the extra text to break.
//
// ⚠️ Other documents mention a key without being this form, and every one of
// them is classified LATER than the keylog rule — so each must be excluded here
// explicitly. Otherwise "Key FOB Receipt" or "Tennis Court Key Receipt" would be
// swallowed by this rule (key + receipt) before their own rule is ever reached.
// Rule ordering alone does NOT protect them; this list is what does.
const NOT_KEYLOG = [
  /\bkey\s*fobs?\b|\bkeyfobs?\b/,   // 'keyfob' category
  /\btennis\b/,                     // tennis court key → correspondence
  /\bmail\s*-?\s*box\b/,            // mailbox key → correspondence
  /permission\s*to\s*release/,      // permission to release key → correspondence
];

const KEYLOG_QUALIFIERS = [
  /emerg/,           // emergency, emergancy
  /conv\w*nce/,      // convenience, convinence, convienence
  /control/,
  /r[ei]c[ei]+pt/,   // receipt, reciept, recipt, reciet
];

function isKeyLogName(l) {
  if (!/\bkeys?\b/.test(l)) return false;
  if (NOT_KEYLOG.some(p => p.test(l))) return false; // a key, but a different document
  return KEYLOG_QUALIFIERS.some(p => p.test(l));
}

// Classify a file into a processing category. Runs on the paren-stripped stem so
// a name like "(Poole)" can't trip the "pool" keyword below.
function classifyFile(filename) {
  // ── The SOURCE FOLDER wins, ahead of every filename rule ───────────────────
  // Common area work orders are identified by the per-building subfolder they
  // came from, not by their name (see commonAreaBuildingOf). Deciding here — in
  // particular BEFORE the plain "work order" rule below — is what stops them
  // being taken for regular unit work orders, which would then fail hunting for
  // a unit number that a common area document never has. Files scanned from the
  // root of FILES_DIR have no directory part, so this can never fire on one.
  if (commonAreaBuildingOf(path.dirname(String(filename)))) return 'commonarea';
  const l = parseBase(filename).toLowerCase();
  if (l.includes('building account'))                        return 'skip';
  // ── Cancellations override everything ──────────────────────────────────────
  // A cancelled document is no longer the thing it cancels: a cancelled guest
  // room reservation reserves nothing, a cancelled meeting room contract grants
  // no rental. None of the per-category handlers below would be right for one —
  // they build titles that assert the document is in force, match occupants and
  // file into Registrations/Reservations. So a cancellation is filed as plain
  // correspondence against the physical unit, and this check runs FIRST, ahead
  // of every category rule, so the wording wins no matter which category the
  // rest of the name looks like.
  //
  // Spelling tolerated: canceled / cancelled / cancellation / cancelation —
  // the doubled "l" is dropped about as often as it is typed. NOTE: the bare
  // verb "Cancel" (and "Cancels"/"Cancelling") is NOT matched — every alternative
  // here requires an "e" or "ation" after the stem.
  //
  // ⚠️ Storage bins are the ONE exception: "Cancelled Storage Bin #2-9-392" is
  // a document uploadStorageBin already handles on purpose — it titles it
  // "Cancelled Storage Bin <bins>" (vs "Storage Bin Assignment <bins>"), keeps
  // the Registration type and the occupancy association, and files it beside the
  // normal ones under Tenant Registrations (see destFolder). That is deliberate
  // and better than what this rule would do, so it is excluded here rather than
  // being quietly retired.
  //
  // NOT matched: "deactivated". Deactivated parking permits are a different word
  // and a different document; they keep whatever rule they hit below (today the
  // regular 'parking' rule, since only the literal "returned" reaches
  // 'returnedparking').
  if (/cancel+ed?|cancell?ation/.test(l) &&
      !l.includes('storage bin'))                            return 'correspondence';
  // Move In / Move Out / BuildingLink registration forms (3 variations).
  // Checked before the generic rules below so their "Move In" keyword wins.
  if (l.includes('move in & buildinglink form'))             return 'movein1';
  if (l.includes('move in & move out') || l.includes('move in and move out') ||
      l.includes('move in and out')   || l.includes('move in & out'))         return 'movein2';
  if (l.includes('move in application') || l.includes('move in form'))         return 'movein3';
  // Move-out-only forms ("Move Out Form for 2-0438 JM 03-16-2026"). Handled
  // exactly like the Move In Application (movein3) with move-out wording.
  //
  // ⚠️ "move out" is SHARED with "Move In & Move Out" (movein2), a different
  // document (two units, two documents, always Tenant). That rule runs a few
  // lines above, AND the explicit "move in" guard here makes the separation
  // independent of rule order — same two-defenses pattern as blform/movein1. A
  // move-in/move-out phrasing movein2 does not recognize therefore falls through
  // to 'unknown' for manual handling rather than being misfiled as a move-out.
  if (/\bmove\s*-?\s*out\b/.test(l) && !/\bmove\s*-?\s*in\b/.test(l)) return 'moveout';
  // Standalone BuildingLink Form. This keyword is SHARED with "Move In &
  // BuildingLink Form" (movein1), which is a different document with a different
  // title, association and destination folder — it is claimed by the movein1 rule
  // a few lines above. The explicit "move in" guard here makes the separation
  // independent of rule order, so a phrasing movein1 does not recognize
  // ("Move In and BuildingLink Form") still can never be misfiled as a standalone
  // form; it falls through to 'unknown' and is surfaced for manual handling.
  if (l.includes('buildinglink form') && !/\bmove\s*-?\s*in\b/.test(l)) return 'blform';
  // Meeting Room Rental CONTRACT (or Agreement). "Meeting Room Rental APPROVAL"
  // is a different document — correspondence, associated with the physical unit,
  // filename as the title — but its name contains this keyword, so it would be
  // swallowed here and uploaded as a Reservation retitled "Meeting Room Rental
  // Contract (year)". Worse, uploadMeetingRoom requires occupant initials before
  // the date and approval filenames rarely carry them, so it would usually stop
  // at an error pause instead. The approval wording is therefore refused
  // explicitly — the same two-defenses pattern used by movein1/blform and
  // returnedparking/parking, where a guard rather than rule order is what keeps
  // two documents sharing a keyword apart. That is what lets the rental-approval
  // keyword at the bottom of CORRESPONDENCE_KEYWORDS claim these names in ANY
  // word order.
  if (l.includes('meeting room rental') && !/ap+rov\w*/.test(l)) return 'meetingroom';
  if (l.includes('guest room reservation'))                  return 'guestroom';
  if (l.includes('delivery form'))                           return 'delivery';
  if (l.includes('work order'))                              return 'workorder';
  if (l.includes('inspection'))                              return 'inspection';
  if (l.includes('window replacement'))                      return 'windowreplacement';
  if (l.includes('alta settlement'))                         return 'alta';
  if (l.includes('storage bin'))                             return 'storagebin';
  if (l.includes('yard sale'))                               return 'yardsale';
  if (l.includes('water leak'))                              return 'waterleak';
  if (isKeyLogName(l))                                       return 'keylog';
  if (l.includes('lease addendum'))                          return 'addendum';
  if (l.includes('lease agreement'))                         return 'lease';
  if (l.includes('pool pass') || l.includes('pool'))         return 'poolpass';
  // Returned permits must win over the generic parking rule below — their name
  // also contains "parking permit". Both phrasings are matched ("Returned Parking
  // Permit" and "Returned Vehicle Parking Permit"), and the regular rule then
  // refuses anything carrying "returned" so the two can never overlap.
  if (l.includes('returned parking permit') ||
      l.includes('returned vehicle parking permit'))           return 'returnedparking';
  if (l.includes('bicycle registration') || l.includes('bike registration')) return 'bicycle';
  if (l.includes('insurance'))                               return 'insurance';
  // "Resale Package Correspondence" is intentionally excluded here → it falls
  // through to the correspondence rule at the bottom.
  if (l.includes('resale package') && !l.includes('correspondence')) return 'resale';
  if (!l.includes('returned') &&
      (l.includes('vehicle parking permit') || l.includes('parking permit'))) return 'parking';
  if (l.includes('key fob') || l.includes('keyfob'))         return 'keyfob';
  // Deeds and powers of attorney (see OWNERSHIP_KEYWORDS). Second-to-last, so it
  // can only narrow 'unknown'. Ahead of correspondence purely so a name carrying
  // both ("Deed Correspondence") files as the deed, which is the stronger claim.
  if (isOwnershipKeyword(l))                                 return 'ownership';
  // Miscellaneous correspondence — checked last (see CORRESPONDENCE_KEYWORDS), so
  // it only ever catches what would otherwise be 'unknown'. The resale rule above
  // already refuses any name carrying "correspondence", so "Resale Package
  // Correspondence" reaches here (via the bare "correspondence" keyword)
  // regardless of the word order in the filename.
  if (isCorrespondenceKeyword(l))                            return 'correspondence';
  return 'unknown';
}

// Normalize a raw unit match: uppercase the structural part (building digit and
// the "T" floor marker) so "1-t-13" → "1-T-13", but keep an optional trailing
// letter suffix LOWERCASE to match the folder naming convention (folders are
// named e.g. "Unit File #1-T-13b", not "...13B"). A trailing letter only counts
// as a suffix when the character before it is a digit, so the "T" in "2-T-05"
// is never mistaken for a suffix.
//   "1-T-13b" → "1-T-13b"   "2-0216A" → "2-0216a"   "2-T-05" → "2-T-05"
function normalizeUnit(raw) {
  const m = raw.match(/^(.*\d)([a-z])$/i);
  return m ? m[1].toUpperCase() + m[2].toLowerCase() : raw.toUpperCase();
}

// Blank out every "#<number>" token before scanning for a unit. Permit, fob and
// bin numbers are dash-joined ("#1-0626", "#2-9-392"), which makes them shaped
// exactly like a unit number — so whichever came first in the name used to win,
// and a "#" value sitting ahead of the real unit was silently filed as the unit.
// Each masked span becomes a single space (never an empty string) so neighbouring
// tokens can't fuse, the same reason parseBase replaces parenthesized runs with a
// space. Scanning simply continues past the masked span to the real unit.
//
// This affects UNIT scanning only: extractHashNumber / extractPermitNumber /
// extractBinNumber all run on the unmasked stem, so the "#" value keeps its own
// meaning for the title.
//
// Example: "Vehicle Parking Permit #1-0626 for 1-0118 JM 05-15-2026"
//       →  "Vehicle Parking Permit   for 1-0118 JM 05-15-2026"   → unit 1-0118
function maskHashNumbers(base) {
  return base.replace(/#\s*\d+(?:-\d+)*[a-z]?/gi, ' ');
}

// The stem every unit scanner below works from: paren-stripped (parseBase) and
// then "#"-masked, so all three agree on what is eligible to BE a unit.
function unitScanBase(filename) {
  return maskHashNumbers(parseBase(filename));
}

// Extract unit number (e.g. "2-0216", "2-T-04", "2-0216a", "1-T-13b") from
// filename. An optional single trailing letter (unit suffix) is kept as part of
// the unit so it routes to the right folder and searches correctly. A value
// attached to a "#" is never eligible — see maskHashNumbers.
function extractUnit(filename) {
  const m = unitScanBase(filename).match(/\b(\d-(?:T-\d+|\d{4})[a-z]?)\b/i);
  return m ? normalizeUnit(m[1]) : null;
}

// Extract every unit number in the filename, in order. Move In & Move Out
// transfer files carry two: "from <old unit> to <new unit>".
function extractUnits(filename) {
  return [...unitScanBase(filename).matchAll(/\b(\d-(?:T-\d+|\d{4})[a-z]?)\b/gi)].map(m => normalizeUnit(m[1]));
}

// Unit anchored on the "for X-XXXX" portion of the name — used by insurance,
// whose dash-laden policy numbers would otherwise be mistaken for the unit.
// Returns null when there is no "for <unit>", letting callers fall back to
// extractUnit. Shared by the live run and the dry-run preview so both anchor
// identically.
function extractUnitAfterFor(filename) {
  const m = unitScanBase(filename).match(/\bfor\s+(\d-(?:T-\d+|\d{4})[a-z]?)\b/i);
  return m ? normalizeUnit(m[1]) : null;
}

// Extract date from filename tail in MM-DD-YY or MM-DD-YYYY format → MM/DD/YYYY.
// Both year widths are accepted; a 2-digit year expands to 20xx. The year group
// tries 4 digits before 2 so "05-22-2026" never matches as the year "20".
// Handles optional trailing " O" or " T" for pool passes.
// Example: "2026 Unit Inspection 2-0216 05-22-26.pdf"   → "05/22/2026"
//          "2026 Unit Inspection 2-0216 05-22-2026.pdf" → "05/22/2026"
function extractDateFromFilename(filename) {
  const base = parseBase(filename);
  const m = base.match(/(\d{1,2})-(\d{1,2})-(\d{4}|\d{2})(?:\s+[OT])?$/i);
  if (!m) return null;
  const [, mm, dd, yy] = m;
  const yyyy = yy.length === 4 ? yy : `20${yy}`;
  return `${mm.padStart(2, '0')}/${dd.padStart(2, '0')}/${yyyy}`;
}

// Extract Owner (O) or Tenant (T) flag from end of pool-pass filename.
function extractOwnerTenant(filename) {
  const base = parseBase(filename);
  const m = base.match(/\s([OT])$/i);
  return m ? m[1].toUpperCase() : null;
}

// Extract Owner (O) / Tenant (T) flag that sits just before the trailing date
// (yard-sale format: "Yard Sale Registration 2-0216 O 06-06-2026"). Distinct
// from extractOwnerTenant, which expects the flag at the very end of the name.
function extractOwnerTenantBeforeDate(filename) {
  const base = parseBase(filename);
  const m = base.match(/\s([OT])\s+\d{1,2}-\d{1,2}-\d{2,4}$/i);
  return m ? m[1].toUpperCase() : null;
}

// EVERY "#" value in the filename, in order of appearance — permit #, fob #, bin
// #. Dash groups are kept ("#1-0626", "#2-9-392") because permit and bin numbers
// carry them; the run ends at the first character that is not another "-<digits>",
// so a date following the number ("#1234 05-15-2026") is never absorbed.
//
// A single file often carries SEVERAL: two permits issued or returned together, a
// pair of fobs. All of them belong in the document title (see formatHashNumbers),
// and NONE of them is ever the unit number — maskHashNumbers blanks every one of
// them out before the unit scan, so a "#" value can never be read as a unit no
// matter how many of them sit ahead of the real one.
//
// Example: "Returned Parking Permit #1-0626 #1-0627 for 1-0118 05-15-2026.pdf"
//       →  ["1-0626", "1-0627"]   (and the unit still resolves to 1-0118)
function extractHashNumbers(filename) {
  return [...parseBase(filename).matchAll(/#\s*(\d+(?:-\d+)*)/g)].map(m => m[1]);
}

// The first "#" value, or null when the name carries none. Used by the handlers
// that only ever need one, and as the presence check for the rest.
// Example: "Vehicle Parking Permit 2-0216 #1-0376 YH 05-22-2026.pdf" → "1-0376"
function extractHashNumber(filename) {
  const all = extractHashNumbers(filename);
  return all.length ? all[0] : null;
}

// Bin and permit numbers are the same "#" values read by the same rules; the
// separate names survive because the call sites talk about bins and permits
// rather than "hash numbers".
const extractBinNumber    = extractHashNumber;
const extractPermitNumber = extractHashNumber;

// Render "#" values for a document title: "#1-0626" on its own, or
// "#1-0626, #1-0627" when the file covers more than one.
function formatHashNumbers(nums) {
  return nums.map(n => `#${n}`).join(', ');
}

// Extract occupant initials: the two letters just before the trailing date.
// First letter = first name initial, second letter = last-last-name initial.
// (The regex still tolerates a legacy O/T flag between initials and date, but
// the current parking-permit format no longer carries one.)
// Example: "...#1234 YH 05-22-26.pdf"   → "YH"
//          "...#1234 YH O 05-22-26.pdf" → "YH"  (legacy)
function extractInitials(filename) {
  const base = parseBase(filename);
  const m = base.match(/\b([A-Za-z]{2})\s+(?:[OT]\s+)?\d{1,2}-\d{1,2}-\d{2,4}$/i);
  return m ? m[1].toUpperCase() : null;
}

// (extractInitialsAtEnd was removed when returned parking permits switched to
// physical-unit association — nothing parses trailing initials any more. Any
// initials still present in a returned-permit filename are simply ignored.)

// Extract every MM-DD-YY (or MM-DD-YYYY) date in the filename → [MM/DD/YYYY, ...]
// in the order they appear. Used by lease agreements (two dates: expiration first,
// date-signed last). The unit number (e.g. "2-0216") has only one dash so it never
// matches this two-dash date pattern.
function extractAllDates(filename) {
  const base = parseBase(filename);
  return [...base.matchAll(/(\d{1,2})-(\d{1,2})-(\d{4}|\d{2})/g)].map(([, mm, dd, yy]) => {
    const yyyy = yy.length === 4 ? yy : `20${yy}`;
    return `${mm.padStart(2, '0')}/${dd.padStart(2, '0')}/${yyyy}`;
  });
}

// Building number = first segment before the first dash (e.g. "2-0216" → "2").
function buildingOf(unit) {
  return unit.split('-')[0];
}

// Floor = first TWO digits of the 4-digit unit segment (the segment is FFUU:
// two-digit floor + two-digit unit-on-floor), or "T" for T-units. Taking the
// first two digits handles floors 10+ correctly — e.g. "1037" is floor 10, not
// floor 0. A unit may carry an optional trailing letter suffix (e.g. "2-0216a",
// "1-T-13b"), which does not affect the floor.
// "2-0216"  → parts[1]="0216"  → "02" → folder "Floor 02"
// "2-1037"  → parts[1]="1037"  → "10" → folder "Floor 10"
// "2-0216a" → parts[1]="0216A" → "02" → folder "Floor 02"
// "2-T-04"  → parts[1]="T"     → "T"  → folder "Floor T"
function floorOf(unit) {
  const parts = unit.split('-');
  if (parts[1] && parts[1].toUpperCase() === 'T') return 'T';
  if (parts[1] && /^\d{4}[a-z]?$/i.test(parts[1])) return parts[1].slice(0, 2);
  return null;
}

// Today as MM/DD/YYYY (used for key-log dates).
function todayDate() {
  const d  = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getFullYear()}`;
}

// Full local timestamp "YYYY-MM-DD HH:MM:SS" for per-file log entries.
function nowStamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
         `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// Name of the per-day log file: upload_log_MM-DD-YYYY.txt (in outputDir).
function logFilePath() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return path.join(outputDir, `upload_log_${p(d.getMonth() + 1)}-${p(d.getDate())}-${d.getFullYear()}.txt`);
}

// Folder naming is not consistent across units: 1-0405 has "Registration"
// where most units have "Registrations", and the same singular/plural drift
// shows up on other folders (Reservation/Reservations, Damage Report/Reports…).
// Resolve one folder name against what's actually on disk: exact match first,
// then a case-insensitive match, then the singular/plural variant (toggling the
// trailing "s", which is the pluralized word in every folder name we use).
// Returns the canonical name when nothing matches, so a genuinely missing
// folder still errors with the expected path.
function resolveFolderName(parentDir, name) {
  if (fs.existsSync(path.join(parentDir, name))) return name;
  let entries;
  try { entries = fs.readdirSync(parentDir, { withFileTypes: true }); }
  catch { return name; }  // parent missing/unreadable — let the caller report it
  const dirs = entries.filter(e => e.isDirectory()).map(e => e.name);
  const variants = [name, /s$/i.test(name) ? name.slice(0, -1) : `${name}s`];
  for (const v of variants) {
    const hit = dirs.find(d => d.toLowerCase() === v.toLowerCase());
    if (hit) return hit;
  }
  return name;
}

// path.join, but each segment is resolved against the folder names actually
// present (see resolveFolderName) so per-unit naming variations still land in
// the right place.
function joinFolders(base, ...segments) {
  let dir = base;
  for (const seg of segments) dir = path.join(dir, resolveFolderName(dir, seg));
  return dir;
}

// Build the destination folder path for a file after upload.
function destFolder(unit, category, ownerTenant) {
  const floor = floorOf(unit);
  const floorPadded = floor === 'T' ? 'T' : floor.padStart(2, '0');
  const base = joinFolders(DEST_ROOT, `Building ${buildingOf(unit)}`, `Floor ${floorPadded}`, `Unit File #${unit}`);
  switch (category) {
    case 'inspection':
      return joinFolders(base, 'Permanent Files', 'Approved Unit Inspections');
    case 'alta':
    case 'ownership':
      return joinFolders(base, 'Permanent Files', 'Proof of Ownership');
    case 'resale':
      return joinFolders(base, 'Permanent Files', 'Resale Certificates');
    case 'windowreplacement':
      return joinFolders(base, 'Permanent Files', 'Approved Perm Alterations');
    case 'poolpass':
    case 'parking':
    case 'bicycle':
    case 'movein1':
    case 'yardsale':
    case 'blform':
      return ownerTenant === 'O'
        ? joinFolders(base, 'Delete-Able Files', 'Unit Owner Delete-Able Files', 'Registrations')
        : joinFolders(base, 'Delete-Able Files', 'Tenant Delete-Able Files', 'Registrations');
    case 'movein2':
      // Move In & Move Out is always a tenant situation → always Tenant Reservations.
      return joinFolders(base, 'Delete-Able Files', 'Tenant Delete-Able Files', 'Reservations');
    case 'moveout':
      // Associated with the physical unit, not an occupant (the mover-out is
      // often already off the occupant list), so there is no matched occupant to
      // read a role from — and a move-out is by nature a tenant event. Always
      // files under the Tenant Reservations folder.
      return joinFolders(base, 'Delete-Able Files', 'Tenant Delete-Able Files', 'Reservations');
    case 'movein3':
    case 'meetingroom':
      return ownerTenant === 'O'
        ? joinFolders(base, 'Delete-Able Files', 'Unit Owner Delete-Able Files', 'Reservations')
        : joinFolders(base, 'Delete-Able Files', 'Tenant Delete-Able Files', 'Reservations');
    case 'guestroom':
      // Guest room reservations are occupancy-associated and always filed under
      // the unit owner's Reservations folder.
      return joinFolders(base, 'Delete-Able Files', 'Unit Owner Delete-Able Files', 'Reservations');
    case 'delivery':
      // Filed under the matched occupant's Correspondence folder.
      return ownerTenant === 'O'
        ? joinFolders(base, 'Delete-Able Files', 'Unit Owner Delete-Able Files', 'Correspondence')
        : joinFolders(base, 'Delete-Able Files', 'Tenant Delete-Able Files', 'Correspondence');
    case 'returnedparking':
      // Associated with the physical unit, not an occupant (the permit holder has
      // usually moved out), so there is no matched occupant to read a role from —
      // these always file under the Unit Owner's Correspondence folder.
    case 'keylog':
    case 'insurance':
    case 'correspondence':
    case 'unknownupload':
    case 'unknownmove':
      return joinFolders(base, 'Delete-Able Files', 'Unit Owner Delete-Able Files', 'Correspondence');
    case 'waterleak':
      // Damage Reports must already exist — never auto-created (see placeWaterLeakFile).
      return joinFolders(base, 'Delete-Able Files', 'Unit Owner Delete-Able Files', 'Damage Reports');
    case 'workorder':
      // Only this category may have its leaf folder auto-created (most units
      // won't have a "Work Orders" folder yet) — see moveFileTo createIfMissing.
      return joinFolders(base, 'Delete-Able Files', 'Unit Owner Delete-Able Files', 'Work Orders');
    case 'lease':
    case 'addendum':
      // Lease agreements and addendums share one folder — the units' own filing
      // keeps both in "Lease And Addendum" (verified present, identically named,
      // in all 830 units that have a Tenant Delete-Able Files folder). These two
      // used to stop at the parent and land in the generic Tenant Delete-Able
      // Files folder alongside the per-purpose subfolders.
      return joinFolders(base, 'Delete-Able Files', 'Tenant Delete-Able Files', 'Lease And Addendum');
    case 'keyfob':
    case 'storagebin':
      // Both uploaded as type Registration against the occupancy, and neither
      // carries an owner/tenant flag (uploadKeyFob and the storage-bin handlers
      // return ownerTenant: null), so there is no role to split on — always the
      // Tenant Registrations folder. Covers normal and cancelled storage-bin docs.
      return joinFolders(base, 'Delete-Able Files', 'Tenant Delete-Able Files', 'Registrations');
    case 'commonarea':
      // Building-level: there is no unit, so no path can be built from one.
      // organizeCommonAreaWorkOrder returns its destination directly (as
      // result.destDir, from commonAreaDestFolder) and never reaches here —
      // this case exists so a future caller gets a useful message instead of the
      // generic "unknown category".
      throw new Error('Common area work orders are not filed under a unit — see commonAreaDestFolder');
    default:
      throw new Error(`Unknown category: ${category}`);
  }
}

// Destination for a COMMON AREA work order: the building's Common Area folder,
// with one subfolder per year taken from the date in the filename —
//   S:\UNIT FILES\Building 2\Common Area\2026 Work Orders
// so a 2025-dated order lands in "2025 Work Orders" and a 2026 one in "2026
// Work Orders". No unit and no owner/tenant split is involved.
//
// Like unit work orders, the leaf "<year> Work Orders" folder may be created
// when missing (each new year needs a new one) — but ONLY that leaf, and only
// when the building's "Common Area" folder already exists; see moveFileTo's
// createIfMissing, which refuses to build a tree.
function commonAreaDestFolder(building, year) {
  return joinFolders(DEST_ROOT, `Building ${building}`, 'Common Area', `${year} Work Orders`);
}

// Move src file into an existing destDir — throws if folder does not exist.
// Retries up to 5 times for EBUSY (browser may hold the file briefly after upload).
// createIfMissing (work orders only) creates the LEAF folder when absent, but
// still requires its parent to exist — so a misparsed unit can't fabricate a
// whole new folder tree; it only adds the one expected "Work Orders" folder.
async function moveFileTo(srcPath, destDir, createIfMissing = false) {
  if (!fs.existsSync(destDir)) {
    if (!createIfMissing) throw new Error(`Destination folder does not exist: ${destDir}`);
    const parent = path.dirname(destDir);
    if (!fs.existsSync(parent)) throw new Error(`Parent folder does not exist (not creating tree): ${parent}`);
    fs.mkdirSync(destDir);
    log(`  📁 Created folder: ${destDir}`);
  }
  const destPath = path.join(destDir, path.basename(srcPath));
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      fs.renameSync(srcPath, destPath);
      return destPath;
    } catch (err) {
      if (attempt === 5 || err.code !== 'EBUSY') throw err;
      await new Promise(r => setTimeout(r, attempt * 1500));
    }
  }
}

// Retry an EBUSY-prone fs op up to 5 times (browser may briefly hold the file).
async function retryEbusy(fn) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try { return fn(); }
    catch (err) {
      if (attempt === 5 || err.code !== 'EBUSY') throw err;
      await new Promise(r => setTimeout(r, attempt * 1500));
    }
  }
}

// Place one PDF into every unit folder it belongs to. Despite the name it is the
// shared multi-unit placer for THREE categories now — water leaks (Damage
// Reports), multi-unit inspections, and multi-unit correspondence — so it takes
// the destination list already built by the caller and knows nothing about which
// category it is serving.
// One unit  → move (rename) the file into that folder.
// Multiple  → the same report must live under every affected unit, so it is
//             COPIED into each of the secondary units and the ORIGINAL is MOVED
//             into the first/primary unit's folder.
//
// ⚠️ ORDER MATTERS, and the original is NEVER deleted. Every copy is made first;
// only once they have all succeeded is the original moved. So a failure part-way
// through leaves the original sitting in the source folder (the run flags it and
// it can simply be re-run), and there is no point in time at which the file
// exists only as copies. The earlier version deleted the original after copying
// it everywhere — same end state on the happy path, but it destroyed the one
// authoritative copy to get there.
//
// Folders are never created — a missing destination throws (verify manually).
// Validates ALL destinations up front so the file is never half-placed.
async function placeWaterLeakFile(srcPath, destDirs) {
  for (const d of destDirs) {
    if (!fs.existsSync(d)) throw new Error(`Destination folder does not exist: ${d}`);
  }
  if (destDirs.length === 1) return [await moveFileTo(srcPath, destDirs[0])];

  // Copy into the secondary units first. A throw here aborts before the move, so
  // the original stays put in the source folder.
  const copies = [];
  for (const d of destDirs.slice(1)) {
    const destPath = path.join(d, path.basename(srcPath));
    await retryEbusy(() => fs.copyFileSync(srcPath, destPath));
    copies.push(destPath);
  }
  // Every copy landed — now the original can move into the primary unit's folder.
  const primary = await moveFileTo(srcPath, destDirs[0]);
  return [primary, ...copies];
}

// Was the PDF successfully placed into its unit folder(s)? The status strings are
// operator-facing prose ('Moved', 'Moved + Copied'), so every check goes through
// here rather than comparing literals in four different places.
function filePlaced(moveStatus) {
  return moveStatus === 'Moved' || moveStatus === 'Copied' || moveStatus === 'Moved + Copied';
}

// ═══════════════════════════════════════════════════════════════
// SCAN FILES
// ═══════════════════════════════════════════════════════════════
function scanFiles() {
  const entries = fs.readdirSync(FILES_DIR, { withFileTypes: true });
  const files = entries
    .filter(e => e.isFile() && e.name.toLowerCase().endsWith('.pdf'))
    .map(e => e.name);
  const out = { inspection: [], windowreplacement: [], keylog: [], poolpass: [], parking: [], returnedparking: [], bicycle: [], keyfob: [], lease: [], addendum: [], movein1: [], movein2: [], movein3: [], meetingroom: [], guestroom: [], delivery: [], moveout: [], workorder: [], commonarea: [], waterleak: [], alta: [], ownership: [], storagebin: [], yardsale: [], blform: [], insurance: [], resale: [], correspondence: [], skip: [], unknown: [] };
  for (const f of files) out[classifyFile(f)].push(f);

  // ── One level down: the per-building common area work order folders ────────
  // Only folders matching "bldg <n> + common area + work order" are descended
  // into; any other subfolder of FILES_DIR is left completely alone.
  //
  // Their files are recorded as paths RELATIVE to FILES_DIR — e.g.
  // "bldg 1 common areas work orders\Work Order #16669 07-23-2026.pdf" — so
  // path.join(FILES_DIR, filename) still resolves everywhere downstream, while
  // the folder that identifies the building travels with the file. classifyFile
  // reads the building back out of that directory part.
  for (const d of entries) {
    if (!d.isDirectory() || !commonAreaBuildingOf(d.name)) continue;
    let sub;
    // An unreadable folder must not take the whole scan down with it — the rest
    // of the run is still perfectly filable.
    try { sub = fs.readdirSync(path.join(FILES_DIR, d.name)); }
    catch { continue; }
    for (const f of sub) {
      if (f.toLowerCase().endsWith('.pdf')) out.commonarea.push(path.join(d.name, f));
    }
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════
// ── Injectable IO ──────────────────────────────────────────────
// log(), ask() and askChoice() are the ONLY channels the handlers use for
// output and operator prompts. They're live `let` bindings (not function
// declarations) so the Electron app can swap in UI-backed versions via
// configureIO() without touching any call site. The CLI leaves the defaults
// below in place.
//
// Default CLI implementations: console for output, readline for prompts.
function defaultAsk(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => rl.question(question, a => { rl.close(); resolve(a.trim()); }));
}
function defaultLog(msg) { console.log(msg); }

// Structured choice prompt. Callers pass a spec; the CLI renders it as the
// familiar numbered list and reads a line, returning the RAW answer string so
// the caller's existing validation/parsing is unchanged. Electron replaces this
// (via configureIO) with clickable buttons that resolve to the same value
// strings. spec = {
//   kind: 'choice' | 'select' | 'continue',
//   title?, filename?, unit?, message?,
//   options: [{ value, label, description? }],   // value = what the caller parses
//   multi?:    true → caller accepts number(s)/"all"  (select kind),
//   allowAll?: true → an "all" answer is offered,
//   allowSkip?:true → an "s" (skip) answer is offered,
// }
async function defaultAskChoice(spec) {
  const s = spec || {};
  if (s.title)    log(`\n  ⚠️  ${s.title}`);
  if (s.filename) log(`     File: ${s.filename}`);
  if (s.unit)     log(`     Unit: ${s.unit}`);
  if (s.message)  log(`  ${s.message}`);
  // Raw technical text behind a plain-English message (the UI hides this behind
  // "Show details"; the CLI just prints it under the message).
  if (s.details)  log(`     Details: ${s.details}`);
  if (s.kind === 'continue') return await ask('  Press Enter to continue...');

  (s.options || []).forEach(o =>
    log(`    ${o.value}. ${o.label}${o.description ? ' — ' + o.description : ''}`));
  if (s.allowAll)  log(`    all. Select everyone listed`);
  if (s.allowSkip) log(`    s. Skip this file (handle manually)`);

  const hint = s.multi
    ? `  Enter number(s) (e.g. 1 or 1,3)${s.allowAll ? ', "all"' : ''}${s.allowSkip ? ', "s" to skip' : ''}: `
    : `  Enter your choice: `;
  return await ask(hint);
}

let ask = defaultAsk;
let log = defaultLog;
let askChoice = defaultAskChoice;

// Optional "updatable log line" channel, used only for step timings. A step's
// line is printed the moment the step STARTS (so a stall is visible while it is
// happening), then the elapsed time is appended to that same line once the step
// finishes. Only a UI host can rewrite a line it already showed, so this is null
// for the CLI — which falls back to a "↳ took 2.1s" follow-up line instead.
//   logUpdate({ id, text })    → show a new line, remembered under `id`
//   logUpdate({ id, append })  → append to the line already shown as `id`
let logUpdate = null;

// Structured progress events for a UI host. The CLI ignores them entirely (the
// default is a no-op), so nothing about a `node upload.js` run changes. The
// Electron app swaps in a sender via configureIO so the header counts, status
// line and run timer can update live instead of only at the end.
// Payloads: { phase: 'batch-start', total, byType, folderCounts }
//           { phase: 'file-start',  type, filename, index, total }
//           { phase: 'file-end',    type, filename, index, total, ok, moved,
//                                   error, plainError }
//           { phase: 'batch-end',   processed, durationMs, pausedMs }
let progress = () => {};
function emitProgress(payload) {
  try { progress(payload); } catch {}
}

// Directory for run logs + debug screenshots. Defaults to the script folder
// (correct for the CLI). The packaged Electron app overrides this via
// configureIO, because its __dirname lives inside the read-only app.asar — so
// the main process points it at a writable location (app userData).
let outputDir = __dirname;

// Inject alternative IO. Pass { log, ask, askChoice, progress, outputDir } (any
// subset). Anything omitted or of the wrong type keeps its current value.
// Electron's main process calls this before main() to route output to the
// renderer, plain prompts over IPC, structured choices to button modals,
// progress events to the live counters, and file output to a writable folder.
function configureIO(io = {}) {
  if (typeof io.log === 'function') log = io.log;
  if (typeof io.logUpdate === 'function') logUpdate = io.logUpdate;
  if (typeof io.ask === 'function') ask = io.ask;
  if (typeof io.askChoice === 'function') askChoice = io.askChoice;
  if (typeof io.progress === 'function') progress = io.progress;
  if (typeof io.outputDir === 'string' && io.outputDir) outputDir = io.outputDir;
}

// ═══════════════════════════════════════════════════════════════
// PLAIN-ENGLISH ERRORS
// Every failure in this file surfaces to a property manager, not a developer.
// A raw message like
//     Timeout (15000ms) finding: a:text-is("Documents"), button:text-is(...)
// says nothing about what to DO. humanizeError() maps the failures we actually
// see onto one sentence of plain English that names the cause and the next
// step; the raw text is always returned alongside it (the UI hides it behind
// "Show details", the run log keeps both) so nothing is lost for debugging.
//
// Rules are tried in order — put the specific ones first. An unmatched error
// falls through to its own raw text, so a new failure mode is never swallowed,
// it just isn't prettified yet.
// ═══════════════════════════════════════════════════════════════

// Which element was being waited for? Our own findAcrossFrames() reports
// "finding: <selector list>"; Playwright's locator.waitFor() reports
// "waiting for locator('<selector list>')". Both are mined for keywords.
function selectorTextOf(raw) {
  const ours = /finding:\s*([\s\S]+)$/.exec(raw);
  if (ours) return ours[1];
  const pw = /locator\((['"`])([\s\S]*?)\1\)/.exec(raw);
  if (pw) return pw[2];
  return '';
}

function isTimeoutError(raw) {
  return /Timeout\s*\(?\d+\s*m?s\)?\s*(exceeded|finding)|Timeout \d+ms exceeded|timed out/i.test(raw);
}

const ERROR_RULES = [
  // ── Run lifecycle & operator choices ────────────────────────────
  { match: /^Interrupted:\s*([\s\S]+)$/,
    say: (raw, m) => `${m[1]} — this file was interrupted partway through and left in the source folder. Nothing was filed for it; just run again.` },

  { when: r => /No occupant matched initials/i.test(r) && /skipped by operator/i.test(r),
    say: 'No occupant matched the initials in the filename, and you chose to skip — the file was left in the source folder.' },

  { when: r => /skipped by operator/i.test(r),
    say: 'You chose to skip this file, so it was left in the source folder for manual handling.' },

  { when: r => /Target (page|closed|crashed)|(page|context|browser) (has been|was) closed|Execution context was destroyed|Protocol error/i.test(r),
    say: 'The browser session ended before this file finished — nothing was uploaded, and the file was left in place. Start the run again.' },

  { when: r => /net::ERR|ERR_(NAME_NOT_RESOLVED|CONNECTION|INTERNET_DISCONNECTED|TIMED_OUT)/i.test(r),
    say: 'Could not reach BuildingLink — the site may be down or the connection dropped. Check the browser window, then run again.' },

  // Every reload attempt spent and the occupancy data still never loaded.
  { when: r => r.includes(OCCUPANCY_EXHAUSTED_MARKER),
    say: 'BuildingLink would not load this unit\'s occupancy data — the Add Document form kept opening with only "The physical unit", which it then refuses. Nothing was filled in or uploaded and the file was left in place; it was retried automatically at the end of the run. If it failed there too, add this one by hand.' },

  // The degenerate single-option dialog — caught before the upload is spent.
  { when: r => /offered only "The physical unit"/i.test(r),
    say: 'BuildingLink only offered "The physical unit" for this unit and would not accept it — the Add Document form loaded without the unit\'s occupancy data. Nothing was uploaded and the file was left in place; add this one by hand.' },

  // ── Filename parsing (nothing was even attempted online) ────────
  { when: r => /Cannot extract unit number/i.test(r),
    say: 'No unit number could be read from the filename — it needs a unit like "1-0105" in the name.' },

  { when: r => /Cannot extract date from filename/i.test(r),
    say: r => `No date could be read from the end of the filename — it should end with the document date (${/MM-DD-YYYY/.test(r) ? 'MM-DD-YYYY' : 'MM-DD-YY'}).` },

  { when: r => /Cannot determine Owner\/Tenant/i.test(r),
    say: 'The filename does not say whether this is the owner or the tenant — it needs an "O" or a "T" before the date.' },

  { when: r => /Cannot extract occupant initials/i.test(r),
    say: 'No occupant initials could be read from the filename — it needs the two-letter initials (e.g. "JS") in the usual position.' },

  { when: r => /Cannot extract permit number/i.test(r),
    say: 'No permit number could be read from the filename — it needs the permit like "#1234" in the name.' },

  { when: r => /Cannot extract fob number/i.test(r),
    say: 'No fob number could be read from the filename — it needs the fob like "#1234" in the name.' },

  { when: r => /Cannot extract bin number/i.test(r),
    say: 'No storage-bin number could be read from the filename — it needs the bin like "#2-9-392" in the name.' },

  { when: r => /needs two dates/i.test(r),
    say: 'A lease agreement filename needs two dates — the expiration date and the signed date.' },

  { when: r => /^Unknown category/i.test(r),
    say: 'This file type has no destination folder rule yet, so there was nowhere to file it.' },

  // ── Destination folders ─────────────────────────────────────────
  { match: /Destination folder does not exist:\s*([\s\S]+)$/,
    say: (raw, m) => `The destination folder does not exist for this unit — it may need to be created, or this unit uses a different folder structure. Expected: ${m[1].trim()}` },

  { match: /Parent folder does not exist \(not creating tree\):\s*([\s\S]+)$/,
    say: (raw, m) => `The unit's folder tree does not exist, so the file was not moved — the parent folder has to be created first. Expected: ${m[1].trim()}` },

  { when: r => /\bEBUSY\b|\bEPERM\b|being used by another process|resource busy or locked/i.test(r),
    say: 'The PDF is open somewhere else (a preview window or another program) and could not be moved. Close it and run again.' },

  { when: r => /\bENOENT\b/i.test(r),
    say: 'The file or folder was not found on the S: drive — check that the drive is connected and the file is still there.' },

  { when: r => /\bEACCES\b|access is denied/i.test(r),
    say: 'Windows denied access to that folder — you may not have permission to write to it.' },

  // ── Occupants ───────────────────────────────────────────────────
  { match: /No occupant matched initials "([^"]*)" in unit ([^\s—]+)/i,
    say: (raw, m) => `Could not find an occupant matching the initials "${m[1]}" in unit ${m[2]} — check the initials in the filename, or the unit may be listed under different names.` },

  { when: r => /No occupant checkboxes found/i.test(r),
    say: 'BuildingLink listed no occupants for this unit, so there was nobody to attach the document to — the unit may be vacant, or the occupant list did not load.' },

  // ── Document Type dropdown ──────────────────────────────────────
  { match: /No Document Type option matched "([^"]*)"\.\s*Options offered:\s*([\s\S]+)$/,
    say: (raw, m) => `BuildingLink's Document Type list has no "${m[1]}" option, so nothing was filed — the type may have been renamed. It offered: ${m[2]}` },

  { when: r => /Document Type listbox rendered no options/i.test(r),
    say: 'The Document Type dropdown opened but never loaded its options, so nothing was selected. This is usually a slow page — try this file again.' },

  { when: r => /Could not identify the Document Type listbox/i.test(r),
    say: 'The upload form showed several dropdowns and none could be confirmed as Document Type, so nothing was clicked rather than risk filing under the wrong type.' },

  // ── Date field ──────────────────────────────────────────────────
  { match: /Date field would not accept ([^\s]+)/,
    say: (raw, m) => `BuildingLink's date box kept rejecting the date ${m[1]} from the filename — enter this one manually and check the date is valid.` },

  // ── Rejected by BuildingLink's API ──────────────────────────────
  { when: r => /rejected the save with HTTP \d+.*document association is required/i.test(r),
    say: 'BuildingLink refused to save because no "who is this document for" option was selected — the association radio did not register. The file was left in the source folder.' },

  { match: /BuildingLink rejected the save with HTTP (\d+)(?::\s*([^(]+))?/,
    say: (raw, m) => `BuildingLink refused to save this document (error ${m[1]})${m[2] ? `: ${m[2].trim()}` : ''}. Nothing was filed and the PDF was left in the source folder.` },

  // ── Post-save verification ──────────────────────────────────────
  { match: /Save appeared to succeed but the document is NOT in unit ([^\s']+)'s document list/,
    say: (raw, m) => `BuildingLink accepted the Save but the document never appeared in unit ${m[1]}'s document list, so it was NOT filed — the PDF was left in the source folder. Check the unit in BuildingLink, then run this file again.` },

  // ── Attachment ──────────────────────────────────────────────────
  { when: r => /No file input and no "Add file" button found|Clicked "Add file" but no file input appeared/i.test(r),
    say: 'The upload form never showed its file-attachment control, so the PDF could not be attached. Try this file again.' },

  // ── Clicks ──────────────────────────────────────────────────────
  { match: /All click strategies failed on ([^:]+):/,
    say: (raw, m) => `Found "${m[1].trim()}" on the page but could not click it — something (usually a dialog left open) was covering it.` },

  // ── Element timeouts — identified by WHAT was being waited for ──
  { when: isTimeoutError,
    say: raw => {
      const sel = selectorTextOf(raw);
      if (/Quick Search|quickSearch/i.test(sel))
        return 'Could not find this unit in BuildingLink quick search — check that the unit number in the filename is correct and exists in BuildingLink.';
      if (/Add (new|a New) [Dd]ocument/i.test(sel))
        return 'Could not find the "Add new document" button — the unit\'s Documents page may not have finished loading.';
      if (/Documents|Unit\/Apt/i.test(sel))
        return 'Could not find the Documents tab — the unit may not have loaded, or this unit number may not exist in BuildingLink.';
      if (/listbox|DocumentType|doctype/i.test(sel))
        return 'The Document Type dropdown never appeared on the upload form — the form may not have finished loading.';
      if (/Title|title/.test(sel))
        return 'The Document Title box never appeared on the upload form — the form may not have finished loading.';
      if (/date|Date/.test(sel))
        return 'The date box never appeared on the upload form — the form may not have finished loading.';
      if (/Rdo(PhysicalUnitBin|AssignUser|AssignUnit)|Occupant/i.test(sel))
        return 'The "who is this document for" options never appeared on the upload form — the form may not have finished loading.';
      if (/Save|Submit/i.test(sel))
        return 'The Save button never appeared on the upload form, so the document was not saved.';
      return 'A part of the BuildingLink page never appeared in time, so this file was skipped. BuildingLink may have been slow — try this file again.';
    } },
];

// Translate a raw error into one plain-English sentence, keeping the original.
// → { plain, raw }. Never throws.
function humanizeError(rawErr) {
  const raw = String(
    rawErr && rawErr.message ? rawErr.message : (rawErr == null ? '' : rawErr),
  ).trim();
  if (!raw) return { plain: 'This file could not be processed.', raw: '' };

  // "File move failed: <cause>" — the upload SUCCEEDED, so lead with that and
  // explain the move failure underneath it.
  const moveFail = /^File move failed:\s*([\s\S]+)$/.exec(raw);
  if (moveFail) {
    const inner = humanizeError(moveFail[1]);
    return {
      plain: `Uploaded to BuildingLink successfully, but the PDF could not be moved out of the source folder. ${inner.plain}`,
      raw,
    };
  }

  for (const rule of ERROR_RULES) {
    let m = null;
    if (rule.match) {
      m = rule.match.exec(raw);
      if (!m) continue;
    } else if (rule.when && !rule.when(raw)) {
      continue;
    }
    const plain = typeof rule.say === 'function' ? rule.say(raw, m) : rule.say;
    if (plain) return { plain, raw };
  }
  // No rule matched — show the raw text rather than a vague placeholder.
  return { plain: raw, raw };
}

// ═══════════════════════════════════════════════════════════════
// DURATION FORMATTING  ("42 minutes 18 seconds", "1h 04m 12s")
// ═══════════════════════════════════════════════════════════════
function formatDuration(ms) {
  const total = Math.max(0, Math.round((ms || 0) / 1000));
  const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
  const parts = [];
  if (h) parts.push(`${h} hour${h === 1 ? '' : 's'}`);
  if (m) parts.push(`${m} minute${m === 1 ? '' : 's'}`);
  if (s || parts.length === 0) parts.push(`${s} second${s === 1 ? '' : 's'}`);
  return parts.join(' ');
}

// Files per minute over an elapsed span. Returns 0 when there's nothing
// meaningful to divide by, so callers never print Infinity or NaN.
function filesPerMinute(count, elapsedMs) {
  if (!count || !elapsedMs || elapsedMs < 1000) return 0;
  return (count / (elapsedMs / 60000));
}

// ═══════════════════════════════════════════════════════════════
// STEP TIMING
// Every numbered step a file goes through ([1] Quick Search … [7] Saving, plus
// the file move) is timed, so a slow run can be traced to the step responsible
// instead of guessed at. Two outputs:
//   • per file — the elapsed time is appended to that step's own log line, then
//     a "Total:" line for the file;
//   • per run  — an average/total breakdown across every file, sorted by the
//     time each step COST OVERALL. That ordering is the point: a 4s step run
//     466 times matters far more than a 20s step that ran twice.
//
// Steps are strictly sequential — starting one closes the one before it — so
// no step can double-count another's time, and a step interrupted by an error
// is still recorded (whatever it had spent up to the failure).
// ═══════════════════════════════════════════════════════════════

// Display order for steps that tie on cost; also the canonical label source.
const STEP_ORDER = ['search', 'profile', 'roles', 'docstab', 'adddoc', 'overlay', 'form', 'attach', 'save', 'move'];

const stepTimer = {
  fileStartMs: 0,
  current: null,     // { key, label, startMs, anchorId } — the open step
  entries: [],       // steps finished for the CURRENT file
  lineSeq: 0,        // ids handed to logUpdate
};

// Run-level accumulator: key → { label, totalMs, count }.
let stepTotals = new Map();

// "1.2s" · "4.0s" · "1m 05s" — seconds are the useful unit for a single step.
function fmtSecs(ms) {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return s.toFixed(1) + 's';
  const m = Math.floor(s / 60);
  return `${m}m ${String(Math.round(s - m * 60)).padStart(2, '0')}s`;
}

// Log a line that belongs to the open step. With a logUpdate channel the line
// is remembered so its duration can be appended in place; otherwise it's an
// ordinary log line.
function stepLine(text) {
  if (!stepTimer.current || !logUpdate) { log(text); return; }
  const id = ++stepTimer.lineSeq;
  stepTimer.current.anchorId = id;
  try { logUpdate({ id, text: String(text) }); }
  catch { log(text); }
}

// Start a step, closing whichever step was open. `text` is that step's log line
// (omit it when the step logs its own line later via stepLine).
function stepBegin(key, label, text) {
  stepEnd();
  stepTimer.current = { key, label, startMs: Date.now(), anchorId: null };
  if (text != null) stepLine(text);
}

// Close the open step and record what it took. Safe to call when none is open.
function stepEnd() {
  const c = stepTimer.current;
  if (!c) return;
  stepTimer.current = null;
  const ms = Date.now() - c.startMs;
  stepTimer.entries.push({ key: c.key, label: c.label, ms });
  if (logUpdate && c.anchorId != null) {
    try { logUpdate({ id: c.anchorId, append: ` (${fmtSecs(ms)})` }); } catch {}
  } else {
    log(`         ↳ ${c.label} took ${fmtSecs(ms)}`);
  }
}

// Begin timing a new file.
function stepReset() {
  stepTimer.current = null;
  stepTimer.entries = [];
  stepTimer.fileStartMs = Date.now();
}

// Close the current file: fold its steps into the run totals and hand back the
// per-file breakdown plus the file's wall-clock total.
function stepFinish() {
  stepEnd();
  const entries = stepTimer.entries;
  stepTimer.entries = [];
  for (const e of entries) {
    const t = stepTotals.get(e.key) || { label: e.label, totalMs: 0, count: 0 };
    t.totalMs += e.ms;
    t.count += 1;
    stepTotals.set(e.key, t);
  }
  return { entries, totalMs: Date.now() - stepTimer.fileStartMs };
}

function resetStepTotals() { stepTotals = new Map(); }

// Run-level breakdown, most expensive step FIRST by total time spent.
// → [{ key, label, count, totalMs, avgMs, share }]
function stepAverages() {
  const rows = [];
  const seen = new Set();
  for (const key of STEP_ORDER) {
    const t = stepTotals.get(key);
    if (!t || !t.count) continue;
    seen.add(key);
    rows.push({ key, label: t.label, count: t.count, totalMs: t.totalMs, avgMs: t.totalMs / t.count });
  }
  // Anything recorded under a key not listed in STEP_ORDER still gets reported.
  for (const [key, t] of stepTotals) {
    if (seen.has(key) || !t.count) continue;
    rows.push({ key, label: t.label, count: t.count, totalMs: t.totalMs, avgMs: t.totalMs / t.count });
  }
  rows.sort((a, b) => b.totalMs - a.totalMs);
  const grand = rows.reduce((sum, r) => sum + r.totalMs, 0);
  for (const r of rows) r.share = grand ? r.totalMs / grand : 0;
  return rows;
}

// ═══════════════════════════════════════════════════════════════
// RUN CONTROL — pause / stop / abort
// ═══════════════════════════════════════════════════════════════
// Pause and Stop take effect MID-FILE, within a fraction of a second, and a
// paused file resumes exactly where it left off. Three pieces make that work:
//
//   1. gate()  — the parking spot. Called from every polling loop in the file
//                pipeline (and between files). On pause it PARKS THE STACK: the
//                await simply doesn't resolve until Resume, so the browser, the
//                open dialog and every local variable stay exactly as they were
//                and the step continues from where it stopped. Nothing is
//                re-done, nothing is persisted. On stop it THROWS RunInterrupted,
//                unwinding the file cleanly.
//   2. waitInterruptible() — every wait in the pipeline wakes the instant a
//                pause or stop is requested, so the next gate() is reached in
//                milliseconds instead of at the end of a 5s poll interval. This
//                is what makes the buttons feel instant.
//   3. runCritical() — the exception. Inside a critical section a pause or stop
//                is RECORDED but NOT ACTED ON until the section completes. Used
//                for attach → save → verify → file-move, which must never be cut
//                in half: interrupting between "Save clicked" and "verified in
//                BuildingLink" leaves the document in an unknown state, and
//                interrupting between "saved" and "moved" is precisely the
//                v1.7.0 bug that silently lost 25 documents. Bounded by the save
//                path's own timeouts (a few seconds), and the UI says
//                "finishing the current upload" while it runs.
//
//   pause  → parks mid-file; Resume continues the same file, same step
//   stop   → abandons the file in flight (nothing uploaded is left half-done —
//            see runCritical), then the summary + run log still run so the
//            operator sees what was done
//   abort  → hard kill (app window closed, or Chrome disappeared). Same as stop
//            AND terminates the browser, because every remaining Playwright call
//            would otherwise error instantly against a dead session — the
//            "keeps trying to process files" failure mode.
//
// The CLI never touches any of this; its runs behave exactly as before, because
// nothing ever requests a pause or a stop.
const runControl = {
  paused: false,          // pause requested
  waiting: false,         // actually parked at a gate ('paused' vs 'pausing')
  stopRequested: false,
  aborted: false,
  abortReason: null,
  browser: null,          // the run's live browser, so abortRun() can kill it
  closingBrowser: false,  // set around our OWN close, so it isn't read as a crash
  waiters: [],            // resolvers parked inside gate()
  wakers: [],             // resolvers inside waitInterruptible(), woken on request
  pausedMs: 0,            // total time parked at a gate, excluded from the rate
  criticalDepth: 0,       // >0 = an uninterruptible section is running
  criticalLabel: null,    // what it is, for the UI/log
  pauseNotice: null,      // describes where the run parked, for the resume log
};
let onRunState = null;

function runState() {
  if (runControl.aborted)       return 'aborted';
  // A pause or stop asked for during a critical section is already decided; the
  // run is just finishing the one thing that must not be cut in half.
  if (runControl.criticalDepth > 0 && (runControl.stopRequested || runControl.paused)) return 'finishing';
  if (runControl.stopRequested) return 'stopping';
  if (runControl.waiting)       return 'paused';
  if (runControl.paused)        return 'pausing';
  return 'running';
}
function emitRunState() {
  if (typeof onRunState !== 'function') return;
  try {
    onRunState({
      state: runState(),
      reason: runControl.abortReason,
      // Only set in the 'finishing' state: what the run is completing before it
      // will honour the pause/stop, so the UI can say WHY it is not stopping yet.
      finishing: runControl.criticalLabel,
      // Where the run parked, so the UI can show the step alongside "Paused".
      step: runControl.waiting ? currentStepLabel() : null,
    });
  } catch {}
}
// The Electron main process registers a listener so the UI can show Paused /
// Stopping. Pass null (or nothing) to clear it.
function setRunStateListener(fn) { onRunState = typeof fn === 'function' ? fn : null; }

function releaseWaiters() {
  for (const resolve of runControl.waiters.splice(0)) { try { resolve(); } catch {} }
}

// Wake every in-flight waitInterruptible() so the run reaches its next gate()
// straight away instead of sitting out the rest of a poll interval. This is the
// difference between a button that responds in milliseconds and one that
// responds "sometime in the next few seconds".
function wakeWaits() {
  for (const resolve of runControl.wakers.splice(0)) { try { resolve(); } catch {} }
}

function requestPause() {
  if (runControl.paused || runControl.stopRequested) return;
  runControl.paused = true;
  wakeWaits();
  emitRunState();
}
function requestResume() {
  if (!runControl.paused) return;
  runControl.paused = false;
  runControl.waiting = false;
  releaseWaiters();
  emitRunState();
}
function requestStop() {
  if (runControl.stopRequested) return;
  runControl.stopRequested = true;
  runControl.paused = false;
  runControl.waiting = false;
  releaseWaiters();            // a paused run must not stay parked
  wakeWaits();
  emitRunState();
}

// Close the run's browser, marking the close as ours so the 'disconnected'
// handler below doesn't mistake it for a crash. Never throws.
async function closeRunBrowser() {
  const b = runControl.browser;
  runControl.browser = null;
  if (!b) return;
  runControl.closingBrowser = true;
  try { await b.close(); } catch {}
}

// Hard abort + browser teardown. Safe to call repeatedly; always resolves.
async function abortRun(reason = 'Run aborted') {
  if (!runControl.aborted) {
    runControl.aborted = true;
    runControl.abortReason = reason;
    runControl.stopRequested = true;
    runControl.paused = false;
    runControl.waiting = false;
    releaseWaiters();
    wakeWaits();
    emitRunState();
  }
  await closeRunBrowser();
}

function isRunAborted()   { return runControl.aborted; }
function isStopRequested() { return runControl.stopRequested || runControl.aborted; }
function runAbortReason()  { return runControl.abortReason; }

// Track the run's browser so abortRun() can terminate it, and treat an
// UNEXPECTED disconnect (operator closed Chrome, or the app window took the
// session down with it) as an abort.
function registerRunBrowser(browser) {
  runControl.browser = browser;
  browser.on('disconnected', () => {
    if (runControl.closingBrowser) return;   // our own orderly shutdown
    runControl.browser = null;
    if (runControl.aborted) return;
    runControl.aborted = true;
    runControl.abortReason = 'The browser session ended';
    runControl.stopRequested = true;
    runControl.paused = false;
    runControl.waiting = false;
    releaseWaiters();
    wakeWaits();
    emitRunState();
  });
}

// Reset before every run, so a previous stop/abort can't leak into the next one.
function resetRunControl() {
  runControl.paused = false;
  runControl.waiting = false;
  runControl.stopRequested = false;
  runControl.aborted = false;
  runControl.abortReason = null;
  runControl.browser = null;
  runControl.closingBrowser = false;
  runControl.pausedMs = 0;
  runControl.criticalDepth = 0;
  runControl.criticalLabel = null;
  runControl.pauseNotice = null;
  releaseWaiters();
  wakeWaits();
}

// Time the operator spent with the run paused. Subtracted from elapsed time so
// the files-per-minute rate reflects actual working speed, not a coffee break.
function runPausedMs() { return runControl.pausedMs; }

// ── The interrupt ──────────────────────────────────────────────
// Thrown by gate() to unwind the file currently being processed when the
// operator presses Stop (or the run aborts). Carries its own marker so
// processOne can tell "the operator ended the run" apart from "this file
// failed" — an interrupted file is NOT an error, must not be screenshotted,
// prompted about, or queued for the auto-retry pass.
class RunInterrupted extends Error {
  constructor(reason) {
    super(reason || 'Run ended by the operator');
    this.name = 'RunInterrupted';
    this.isRunInterrupt = true;
  }
}
function isRunInterrupt(err) { return !!(err && err.isRunInterrupt); }

// ── Critical sections ──────────────────────────────────────────
// Work that must not be cut in half. While one is open, gate() and
// waitInterruptible() ignore pause and stop entirely — the request is kept and
// acted on the moment the section ends.
//
//   ⚠️  This is a SAFETY property, not a convenience. The window from "Save
//   clicked" through "verified present in BuildingLink" through "PDF moved off
//   the S: drive" is exactly where v1.7.0 silently lost 25 documents by letting
//   the file move race the upload. An instant Stop in that window would
//   reintroduce it in a new form: the document uploaded, the source file still
//   sitting there, and a re-run duplicating it.
function isCritical() { return runControl.criticalDepth > 0; }

function beginCritical(label) {
  runControl.criticalDepth++;
  runControl.criticalLabel = label;
  // Only tell the UI if there is actually something to wait out.
  if (runControl.paused || runControl.stopRequested) emitRunState();
}

function endCritical() {
  if (runControl.criticalDepth === 0) return;
  runControl.criticalDepth--;
  if (runControl.criticalDepth > 0) return;
  runControl.criticalLabel = null;
  // A pause or stop that arrived mid-section now takes effect. Waking the waits
  // here means the next gate() is hit immediately rather than after the
  // following poll interval.
  if (runControl.paused || runControl.stopRequested) { wakeWaits(); emitRunState(); }
}

async function runCritical(label, fn) {
  beginCritical(label);
  try {
    return await fn();
  } finally {
    endCritical();
  }
}

// What the run is finishing off, for the UI's "finishing" state.
function criticalLabel() { return runControl.criticalLabel; }

// ── Multi-unit files: never leave one half-uploaded ────────────
// Inspections, water leaks and multi-unit correspondence upload ONE DOCUMENT
// PER UNIT out of a single PDF. Stopping between two of those units is the
// worst outcome available: some units have the document, the PDF is still in
// the source folder, and a re-run adds a SECOND copy to every unit already
// done. That is exactly the duplicate the handlers' own error text warns about,
// and an instant Stop would otherwise make it easy to trigger on purpose.
//
// So the FIRST successful save commits the file: from that point until the last
// unit is finished, pause and stop are deferred the same way they are during a
// save. The operator's Stop is honoured the moment the file is complete.
//
// Single-unit files are unaffected — there is nothing to leave half-done, so
// they stay fully interruptible right up to their one save.
function multiUnitCommit(state, units) {
  if (state.committed || !units || units.length < 2) return;
  state.committed = true;
  beginCritical(`the remaining unit(s) of this ${units.length}-unit document`);
}
function multiUnitRelease(state) {
  if (!state || !state.committed) return;
  state.committed = false;
  endCritical();
}

// True when the run should stop or park at the next gate. Always false inside a
// critical section, which is what defers the request rather than dropping it.
function interruptPending() {
  if (isCritical()) return false;
  return runControl.paused || isStopRequested();
}

// ── The gate ───────────────────────────────────────────────────
// The one place a run parks or unwinds. Call it from any loop that polls.
//
//   Stop / abort → throws RunInterrupted (the file unwinds; nothing half-done,
//                  because anything that couldn't be half-done ran inside
//                  runCritical).
//   Pause        → PARKS THE STACK here. The await does not resolve until
//                  Resume, so every caller's local state — the page, the open
//                  dialog, the loop's own variables — is untouched and the step
//                  picks up mid-stride. Returns the number of milliseconds it
//                  was parked so a caller polling against a deadline can extend
//                  it by the same amount (see waitInterruptible's callers): a
//                  20-minute pause must not consume a 12-second budget.
//
// `where` describes the parking spot for the log ("step [3] Documents tab").
async function gate(where = null) {
  if (isCritical()) return 0;
  if (isStopRequested()) throw new RunInterrupted(runAbortReason() || 'Run ended by the operator');
  if (!runControl.paused) return 0;

  runControl.waiting = true;
  emitRunState();
  // `where` is an explicit description (the between-files checkpoint passes
  // one); otherwise name the step the file is on, which is the whole point of a
  // mid-file pause — the operator should see exactly where it stopped.
  const step = currentStepLabel();
  const at = where || (step ? `mid-file, at ${step}` : null);
  log(`\n  ⏸  Paused${at ? ` — ${at}` : ''}. Resume picks up right here.`);
  const pausedAt = Date.now();
  while (runControl.paused && !isStopRequested()) {
    await new Promise(resolve => runControl.waiters.push(resolve));
  }
  const parkedMs = Date.now() - pausedAt;
  runControl.pausedMs += parkedMs;
  runControl.waiting = false;

  if (isStopRequested()) throw new RunInterrupted(runAbortReason() || 'Run ended by the operator');
  log(`  ▶  Resumed${at ? ` at ${at}` : ''} after ${formatDuration(parkedMs)}.\n`);
  // A long park can outlive BuildingLink's own session. Nothing is uploaded yet
  // at any gate (the save runs inside runCritical), so the worst case is that
  // the next step fails and the file is left in the source folder for a re-run —
  // but say so, because that error would otherwise look mysterious.
  if (parkedMs >= PAUSE_STALE_WARN_MS) {
    log(`     ⚠️  That was a long pause — if BuildingLink timed the session out,`);
    log(`         this file will error and stay in the source folder for a re-run.`);
  }
  emitRunState();
  return parkedMs;
}

// How long a pause has to run before the resume warns about a stale session.
const PAUSE_STALE_WARN_MS = 10 * 60 * 1000;

// The step the run is on right now, for the pause/resume log lines.
function currentStepLabel() {
  const c = stepTimer.current;
  return c ? `step [${c.label}]` : null;
}

// ── Interruptible waiting ──────────────────────────────────────
// Drop-in replacement for page.waitForTimeout(ms) inside the file pipeline.
// Identical behaviour during a normal run; the moment a pause or stop is
// requested it returns EARLY so the caller reaches its next gate() straight
// away. It never parks and never throws — deciding what to do is gate()'s job,
// and keeping those separate is what lets a caller extend its own deadline by
// the parked time.
async function waitInterruptible(page, ms) {
  const wait = Math.max(0, ms | 0);
  // ⚠️  Inside a critical section this must behave EXACTLY like a plain wait.
  // The waits in there (ATTACH_SETTLE_WAIT, SAVE_SETTLE_WAIT) are the fixed
  // floors that stop the PDF being moved while BuildingLink is still reading it.
  // Letting a pause request cut one short would re-create the v1.7.0 data loss
  // through the back door, so no waker is registered and no early return exists.
  if (isCritical()) { if (wait > 0) await page.waitForTimeout(wait); return; }
  if (interruptPending()) return;
  if (wait === 0) return;
  let waker = null;
  try {
    await Promise.race([
      page.waitForTimeout(wait),
      new Promise(resolve => { waker = resolve; runControl.wakers.push(resolve); }),
    ]);
  } finally {
    // Don't leak a resolver into the next wait's wake-up.
    if (waker) {
      const at = runControl.wakers.indexOf(waker);
      if (at >= 0) runControl.wakers.splice(at, 1);
    }
  }
}

// Called between files. Returns 'continue' or 'stop'. Kept as its own entry
// point because the batch loop wants a return value rather than an exception —
// between files there is no file to unwind.
async function runCheckpoint() {
  if (isStopRequested()) return 'stop';
  try {
    await gate('the gap between files');
  } catch (err) {
    if (isRunInterrupt(err)) return 'stop';
    throw err;
  }
  return isStopRequested() ? 'stop' : 'continue';
}

// Best-effort debug screenshot. Never throws — a screenshot failure (e.g. an
// unwritable folder) must not abort the run that called it from an error path.
async function screenshot(page, label) {
  try {
    const f = path.join(outputDir, `debug-${label}-${Date.now()}.png`);
    await page.screenshot({ path: f, fullPage: false });
    log(`  📸 ${f}`);
    return f;
  } catch (e) {
    log(`  ⚠️  Could not save screenshot: ${e.message}`);
    return null;
  }
}

// Find the first visible element matching any of the CSS selectors,
// searching across the main page and all iframes.
async function findAcrossFrames(page, selectors, timeout = 30000) {
  const combined = selectors.join(', ');
  let deadline = Date.now() + timeout;
  // Poll fast at first, then back off. Most elements show up within a few
  // hundred ms of the page settling, and a flat 400ms interval spent up to
  // 400ms per lookup doing nothing — on a page with ~14 frames that is real
  // time, several times per file. Backing off keeps a genuinely slow wait from
  // hammering the browser for the full timeout.
  let wait = 100;
  while (Date.now() < deadline) {
    // Pause parks here; Stop unwinds from here. Time spent parked is added back
    // to the deadline, so a pause can never eat this lookup's budget and make
    // it time out the moment the operator resumes.
    deadline += await gate();
    for (const frame of page.frames()) {
      try {
        const loc = frame.locator(combined).first();
        if (await loc.count() > 0 && await loc.isVisible()) return { loc, ctx: frame };
      } catch {}
    }
    await waitInterruptible(page, Math.min(wait, Math.max(0, deadline - Date.now())));
    wait = Math.min(500, Math.round(wait * 1.4));
  }
  throw new Error(`Timeout (${timeout}ms) finding: ${combined}`);
}

// Find element within a known frame context.
async function findIn(ctx, selectors, timeout = 15000) {
  const loc = ctx.locator(selectors.join(', ')).first();
  await loc.waitFor({ state: 'visible', timeout });
  return loc;
}

// Same idea as findAcrossFramesPreferred, but within a frame context that is
// already known. The primary is only waited on when it EXISTS (count is an
// instant check), so a page without it drops straight through to the fallbacks
// instead of burning the primary's timeout on every file.
// Returns { loc, usedFallback }.
async function findInPreferred(ctx, primary, fallbacks, timeout = 15000) {
  const p = ctx.locator(primary).first();
  if (await p.count().catch(() => 0) > 0) {
    try {
      await p.waitFor({ state: 'visible', timeout: Math.min(timeout, 5000) });
      return { loc: p, usedFallback: false };
    } catch {}
  }
  return { loc: await findIn(ctx, fallbacks, timeout), usedFallback: true };
}

// Find `primary` first, falling back to `fallbacks` only when it is nowhere on
// the page.
//
//   ⚠️  This exists because a selector ARRAY does not express priority.
//   findIn/findAcrossFrames join their array into one CSS query and take
//   .first(), and a CSS list resolves in DOM ORDER — so a loose text match
//   sitting earlier in the page beats an exact selector listed before it. The
//   only way to make an exact selector actually win is a separate, earlier
//   lookup, which is what this does.
//
// Both are tried on every poll iteration (primary first), so the exact selector
// costs nothing extra on the happy path and the fallbacks still cover a unit on
// the legacy UI without a separate waiting period.
// Returns { loc, ctx, usedFallback }.
async function findAcrossFramesPreferred(page, primary, fallbacks, timeout = 30000) {
  const fb = (fallbacks || []).join(', ');
  let deadline = Date.now() + timeout;
  let wait = 100;
  while (Date.now() < deadline) {
    deadline += await gate();   // pause parks / stop unwinds; parked time is refunded
    for (const sel of [primary, fb]) {
      if (!sel) continue;
      for (const frame of page.frames()) {
        try {
          const loc = frame.locator(sel).first();
          if (await loc.count() > 0 && await loc.isVisible()) {
            return { loc, ctx: frame, usedFallback: sel !== primary };
          }
        } catch {}
      }
    }
    await waitInterruptible(page, Math.min(wait, Math.max(0, deadline - Date.now())));
    wait = Math.min(500, Math.round(wait * 1.4));
  }
  throw new Error(`Timeout (${timeout}ms) finding: ${primary}${fb ? ` (fallbacks: ${fb})` : ''}`);
}

// ═══════════════════════════════════════════════════════════════
// UNIT OVERVIEW ROLE MAP  (name → OWNER / RENTER / SPOUSE / OTHER OCCUPANT)
//
// The Unit Overview tab lists each occupancy in a card carrying a role badge:
//   <... data-testid="occupancy-occupant-type">RENTER</...>
// Reading it BEFORE opening the Add Document form gives an authoritative
// name → role map, which every file type then uses for owner-vs-tenant routing
// instead of the fragile red "Renter" span inside the upload form.
//
// Classification is by PILL COLOR, not badge text. SPOUSE and CHILD occur on
// both sides — the spouse of a renter is a tenant, the spouse of an owner is
// not — so the text alone cannot decide:
//   yellow / orange pill → TENANT side
//   green / teal / blue  → OWNER side
//
// The color is NOT on the badge element. Confirmed live on 2-0718, the badge
// <div> is byte-identical for a renter and an owner (same classes, same inline
// `color: rgb(9, 49, 85)` navy TEXT color); the pill background lives on the
// parent v-chip span:
//   <span class="bl-mt-2 v-chip theme--light v-size--small hold">     ← yellow
//     <span class="v-chip__content">
//       <div data-testid="occupancy-occupant-type" style="color: rgb(9,49,85)">RENTER</div>
//   <span class="bl-mt-2 v-chip theme--light v-size--small green2">   ← green
//       ... >OFFSITE OWNER</div>
// So: walk up to the pill and read its COMPUTED background color, then classify
// by hue. The `hold`/`green2` theme classes are kept only as a fallback, since
// they are BuildingLink theme names that could be renamed.
//
// Observed on 2-0718 (a rented unit): RENTER, SPOUSE, CHILD all `hold`/yellow
// → all tenants; OFFSITE OWNER, PROPERTY MANAGER `green2` → owner side.
//
// The card is <div class="bl-flex bl-justify-between bl-items-center ..."> and
// has NO data-testid of its own, so badge↔name pairing must stay positional.
// Never key on the data-v-* attributes — they are Vue scoped-style hashes that
// change on every BuildingLink build.
// ═══════════════════════════════════════════════════════════════
const OCCUPANT_TYPE_SELECTOR = '[data-testid="occupancy-occupant-type"]';

// Name element inside an occupancy card, most specific first. The first
// selector that matches a non-empty element wins; if none do, the card's own
// text is parsed as a last resort. Run `node upload.js --inspect-unit=2-0718`
// to re-dump the real card HTML if BuildingLink changes the markup.
// CONFIRMED live (1-0105, 2-0718) — the first entry is the real one:
//   <span data-testid="occupancy-occupant-name"
//         class="bl-type-large-bold bl-text-masblue">Example Sample  Name</span>
// Note the DOUBLE space where a middle name is absent; scrapeOccupantCards
// collapses whitespace, so keys still compare equal.
const OCCUPANT_NAME_SELECTORS = [
  '[data-testid="occupancy-occupant-name"]',
  '[data-testid="occupancy-occupant-full-name"]',
  '[data-testid*="occupant-name" i]',
  '[data-testid*="occupant" i][data-testid*="name" i]',
  'a[href*="OccupantId" i]',
  'a[href*="occupant" i]',
  '[data-testid="link-text"]',
];

// Tabs that show the occupancy cards. The unit profile usually lands here
// already, so the click is best-effort (skipped when badges are already up).
const UNIT_OVERVIEW_TAB_SELECTORS = [
  'a:text-is("Unit Overview")',
  'button:text-is("Unit Overview")',
  '[role="tab"]:has-text("Unit Overview")',
  'a:text-is("Overview")',
  '[role="tab"]:has-text("Overview")',
];

// Populated by readUnitRoleMap() on every openAddDocForm() call; scoped to one
// unit at a time (move-in/move-out visits two units and re-reads for each).
let unitRoleMap     = new Map(); // nameKey → { name, role, isTenant, ambiguous }
let unitRoleMapUnit = null;
// How that read went. This is what makes an empty map interpretable: 'ok' with
// occupants is positive evidence the unit HAS occupancy, which in turn is what
// lets openAddDocForm tell a genuinely single-option unit (nobody lives there)
// from a dialog that was built before its occupancy data arrived.
//   'ok'        → the Unit Overview was read; unitRoleMap is what it says
//   'no-badges' → the tab rendered no occupant badges (may or may not be empty)
//   'error'     → the read threw
//   'skipped'   → --skip-role-map
//   null        → not read yet
let unitRoleMapStatus = null;

// Does this unit definitely have occupancy behind it? Only 'ok' + at least one
// occupant counts as a yes; every other state is an honest "cannot tell", which
// callers must treat as unknown rather than as a no.
function unitHasKnownOccupants() {
  return unitRoleMapStatus === 'ok' && unitRoleMap.size > 0;
}

// Test seam: let the harness put the role map into a known state without a
// browser. Never called by the run itself.
function setRoleMapForTest(status, names = []) {
  unitRoleMapStatus = status;
  unitRoleMap = new Map(names.map(n => [n, { name: n, role: 'OWNER', isTenant: false, ambiguous: false }]));
  unitRoleMapUnit = 'TEST';
}

// Pill theme classes seen live, used only when the computed color is unusable
// (element not rendered, etc.). true = tenant side.
const PILL_CLASS_TENANT = {
  hold:   true,   // amber/yellow — renter and their household
  yellow: true,
  orange: true,
  amber:  true,
  green2: false,  // green — owner side
  green:  false,
  teal:   false,
  blue:   false,
};

// "rgb(255, 193, 7)" / "rgba(255,193,7,0.9)" → { r, g, b, a } (null if absent).
function parseCssColor(s) {
  const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?/i.exec(s || '');
  if (!m) return null;
  let a = 1;
  if (m[4] != null) a = m[4].endsWith('%') ? parseFloat(m[4]) / 100 : parseFloat(m[4]);
  return { r: +m[1], g: +m[2], b: +m[3], a };
}

// Hue in degrees + saturation/lightness 0..1.
function rgbToHsl({ r, g, b }) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r)      h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else                h = (r - g) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

// Classify a pill background color. Returns true (tenant) / false (owner) /
// null when the color can't decide (transparent, greyscale, or an unexpected
// hue) and the caller should fall back.
function colorIsTenant(cssColor) {
  const rgb = parseCssColor(cssColor);
  if (!rgb || rgb.a < 0.1) return null;         // transparent → no pill color here
  const { h, s } = rgbToHsl(rgb);
  if (s < 0.15) return null;                    // white/grey/black → undecidable
  if (h >= 15 && h < 75)  return true;          // orange → yellow  = tenant
  if (h >= 75 && h < 270) return false;         // green → teal → blue = owner
  return null;                                  // red/pink/purple → unexpected
}

// Decide owner vs tenant for one occupancy card, in order of trustworthiness:
//   1. computed pill background color  (what the operator actually sees)
//   2. known pill theme class          (hold / green2 …)
//   3. badge text                      (last resort: only RENTER → tenant)
// Returns { isTenant, basis } — basis is carried into logs so a run makes it
// obvious WHY someone was routed as a tenant.
function occupantIsTenant(card) {
  const byColor = colorIsTenant(card && card.pillBg);
  if (byColor !== null) return { isTenant: byColor, basis: `pill ${card.pillBg}` };

  const classes = ((card && card.pillClass) || '').split(/\s+/);
  for (const c of classes) {
    if (Object.prototype.hasOwnProperty.call(PILL_CLASS_TENANT, c.toLowerCase())) {
      return { isTenant: PILL_CLASS_TENANT[c.toLowerCase()], basis: `pill class "${c}"` };
    }
  }

  return { isTenant: /\brenter\b/i.test((card && card.role) || ''), basis: 'badge text (no pill color)' };
}

// Strip role words, trailing numeric columns and punctuation so names coming
// from the overview cards and from the upload form's occupant list compare
// equal. Returns an UPPERCASE bare name.
function normalizeOccupantName(name) {
  return (name || '')
    .replace(/\b(other\s+occupant|owner|renter|tenant|spouse|child|resident|occupant|primary|secondary)\b/ig, ' ')
    .split(/\d/)[0]                    // cut at first digit → drop phone/unit/date columns
    .replace(/[^A-Za-z\s,'’-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

// Order-insensitive key so "Jane Doe" and "Doe, Jane" match, and single
// letters (middle initials) don't break a comparison.
function occupantNameKey(name) {
  const tokens = normalizeOccupantName(name)
    .replace(/,/g, ' ')
    .split(/[\s-]+/)
    .filter(t => t.length > 1);
  return tokens.slice().sort().join(' ');
}

// Look a form-list name up in the overview role map.
// Exact key first, then a unique subset match (the form list sometimes carries
// extra words/columns around the name). Ambiguous or missing → null, and the
// caller falls back to the legacy red-"Renter"-span detection.
function lookupOccupantRole(name) {
  if (unitRoleMap.size === 0) return null;
  const key = occupantNameKey(name);
  if (!key) return null;

  const exact = unitRoleMap.get(key);
  if (exact) return exact.ambiguous ? null : exact;

  const keyTokens = key.split(' ');
  let hit = null, hits = 0;
  for (const [k, val] of unitRoleMap) {
    const t = k.split(' ');
    const [shorter, longer] = t.length <= keyTokens.length ? [t, keyTokens] : [keyTokens, t];
    if (shorter.length && shorter.every(x => longer.includes(x))) { hit = val; hits++; }
  }
  return hits === 1 && !hit.ambiguous ? hit : null;
}

// Human-readable role for logs/prompts: the real badge text when the overview
// map supplied it, otherwise the legacy Renter/Owner guess.
function roleLabelOf(c) {
  if (c && c.role) return `${c.role} → ${c.isRenter ? 'tenant' : 'owner'}`;
  return c && c.isRenter ? 'Renter' : 'Owner';
}

// Find the frame holding the occupancy cards (they may live in an iframe).
async function findOccupantTypeFrame(page, timeout = 10000) {
  let deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    deadline += await gate();
    for (const frame of page.frames()) {
      try {
        if (await frame.locator(OCCUPANT_TYPE_SELECTOR).count() > 0) return frame;
      } catch {}
    }
    await waitInterruptible(page, 400);
  }
  return null;
}

// Scrape every occupancy card: role badge + occupant name (+ raw HTML when
// dumping). Pure DOM work, no clicking — safe to run on every unit.
async function scrapeOccupantCards(frame, { dump = false } = {}) {
  return await frame.evaluate(({ typeSel, nameSels, dump }) => {
    return Array.from(document.querySelectorAll(typeSel)).map(badge => {
      // Card boundary = the TIGHTEST ancestor holding this badge AND a name
      // element. Climbing stops early at any ancestor holding a second badge
      // (that's the list, not a card).
      //   ⚠️  Don't climb on the ">1 badge" rule alone: a unit with a single
      //   occupancy has no second badge anywhere, so that walk runs to <html>.
      let node = badge.parentElement, card = badge, cardWithName = null;
      while (node && node !== document.documentElement) {
        if (node.querySelectorAll(typeSel).length > 1) break; // reached the list
        card = node;
        for (const s of nameSels) {
          try { if (node.querySelector(s)) { cardWithName = node; break; } } catch {}
        }
        if (cardWithName) break;
        node = node.parentElement;
      }
      card = cardWithName || card;

      const role = (badge.textContent || '').replace(/\s+/g, ' ').trim();

      let name = '', nameSelector = '', nameHtml = '';
      for (const s of nameSels) {
        let el = null;
        try { el = card.querySelector(s); } catch {}
        if (el && (el.textContent || '').trim()) {
          name = el.textContent.replace(/\s+/g, ' ').trim();
          nameSelector = s;
          nameHtml = el.outerHTML;
          break;
        }
      }

      if (!name) {
        // Fallback: first line of card text that reads like a person's name.
        const lines = (card.innerText || card.textContent || '')
          .split('\n').map(t => t.replace(/\s+/g, ' ').trim()).filter(Boolean)
          .filter(t => t.toUpperCase() !== role.toUpperCase());
        name = lines.find(t => /^[A-Za-z][A-Za-z .,'’-]{2,60}$/.test(t)
                            && !/^(unit|occupanc|move|lease|phone|email|address|since|status)/i.test(t))
             || lines[0] || '';
        nameSelector = '(fallback: card text)';
      }

      // The PILL carries the owner/tenant color, not the badge. Prefer the
      // nearest .v-chip ancestor; otherwise the nearest ancestor (badge
      // included) that actually paints a background.
      let pill = null;
      let el = badge, hops = 0;
      while (el && hops < 6) {
        if (el.classList && el.classList.contains('v-chip')) { pill = el; break; }
        el = el.parentElement; hops++;
      }
      if (!pill) {
        el = badge; hops = 0;
        while (el && hops < 6) {
          const bg = getComputedStyle(el).backgroundColor;
          const m  = /rgba?\(\s*[\d.]+[\s,]+[\d.]+[\s,]+[\d.]+(?:[\s,/]+([\d.]+))?/i.exec(bg || '');
          if (m && (m[1] == null || parseFloat(m[1]) >= 0.1)) { pill = el; break; }
          el = el.parentElement; hops++;
        }
      }

      return {
        name, role, nameSelector, nameHtml,
        pillClass:  pill ? (pill.getAttribute('class') || '') : '',
        pillBg:     pill ? getComputedStyle(pill).backgroundColor : '',
        pillHtml:   dump && pill ? pill.outerHTML.slice(0, 1500) : '',
        badgeClass: badge.getAttribute('class') || '',
        badgeStyle: badge.getAttribute('style') || '',
        cardTestId: card.getAttribute('data-testid') || '',
        cardHtml: dump ? card.outerHTML.slice(0, 6000) : '',
      };
    });
  }, { typeSel: OCCUPANT_TYPE_SELECTOR, nameSels: OCCUPANT_NAME_SELECTORS, dump });
}

// Read the Unit Overview tab and (re)build the name → role map for `unit`.
// Never throws: an empty map just means every selector falls back to the legacy
// red-"Renter"-span detection, i.e. the previous behavior.
async function readUnitRoleMap(page, unit) {
  unitRoleMap       = new Map();
  unitRoleMapUnit   = unit;
  unitRoleMapStatus = 'error'; // upgraded below; a throw leaves it here

  try {
    // The profile normally opens on Unit Overview; only click if no badge is up.
    let frame = await findOccupantTypeFrame(page, 4000);
    if (!frame) {
      try {
        const { loc: tab } = await findAcrossFrames(page, UNIT_OVERVIEW_TAB_SELECTORS, 4000);
        await tab.click();
        try { await page.waitForLoadState('load', { timeout: 10000 }); } catch {}
        await page.waitForTimeout(1000);
      } catch {}
      frame = await findOccupantTypeFrame(page, 8000);
    }
    if (!frame) {
      log(`  ⚠️  No "${OCCUPANT_TYPE_SELECTOR}" badges on the Unit Overview — falling back to in-form role detection.`);
      unitRoleMapStatus = 'no-badges';
      return unitRoleMap;
    }

    const cards = await scrapeOccupantCards(frame);
    for (const c of cards) {
      const key = occupantNameKey(c.name);
      if (!key) continue;
      const { isTenant, basis } = occupantIsTenant(c);
      const entry = { name: c.name, role: c.role, isTenant, basis, ambiguous: false };
      const prev  = unitRoleMap.get(key);
      // Two occupants whose names normalize the same with DIFFERENT roles →
      // unusable for routing; mark it so lookups fall back instead of guessing.
      if (prev && prev.isTenant !== entry.isTenant) prev.ambiguous = true;
      else if (!prev) unitRoleMap.set(key, entry);
    }

    const summary = cards
      .map(c => `${c.name || '[no name]'} = ${c.role} [${occupantIsTenant(c).isTenant ? 'tenant' : 'owner'}]`)
      .join(', ');
    unitRoleMapStatus = 'ok';
    stepLine(`  [2b] Unit Overview roles (${cards.length}): ${summary || 'none found'}`);
    const noColor = cards.filter(c => colorIsTenant(c.pillBg) === null);
    if (noColor.length) {
      log(`       ⚠️  No usable pill color for ${noColor.length} of ${cards.length} occupant(s) — fell back to class/text. Run --inspect-unit=${unit} to check.`);
    }
    if (cards.length && cards.every(c => c.nameSelector === '(fallback: card text)')) {
      log(`       ⚠️  Names came from card text, not a name element — run  node upload.js --inspect-unit=${unit}  to pin the selector.`);
    }
  } catch (e) {
    log(`  ⚠️  Could not read Unit Overview roles (${e.message}) — falling back to in-form role detection.`);
  }
  return unitRoleMap;
}

// ═══════════════════════════════════════════════════════════════
// MODAL OVERLAY (Add Document dialog)
// The dialog renders a full-viewport backdrop:
//   <div data-testid="bl-dialog-close-div" class="bl-fixed bl-inset-0 dialog-overlay" aria-hidden="true">
// While it is up it swallows pointer events, so clicking the Document Type
// listbox button (or any other field) fails with an intercepted-click error.
// Normally it clears once the dialog's open transition finishes — hence the
// longer settle wait before we touch anything.
//
//   ⚠️  The element is the dialog's CLOSE target, not just a backdrop. Clicking
//   it is a last resort: it usually closes the Add Document dialog outright.
//   That is why dismissal is followed by a form-survival check and a re-open.
// ═══════════════════════════════════════════════════════════════
const DIALOG_OVERLAY_SELECTOR = '[data-testid="bl-dialog-close-div"]';

// How long to let the dialog finish rendering before touching any field, and
// how long to wait for the backdrop to clear on its own.
//
//   MEASURED (run log 2026-07-29): this backdrop is PERSISTENT — Playwright
//   retried a click against it for a full 30s and it never cleared. So waiting
//   it out is futile; the wait is kept short only for units/legacy UI where it
//   really is transitional. clickResilient() bypasses it regardless.
// How long to wait for the Add Document dialog to render before giving up and
// letting the first field lookup report the failure. This is a CAP, not a
// delay — waitForFormReady() returns the moment a real form field appears
// (typically a few hundred ms), so a slow BuildingLink still gets its time.
const FORM_READY_TIMEOUT    = 12000;
// Settle time after the form's first field appears, for the dialog's open
// transition to finish before anything is clicked.
const FORM_SETTLE_WAIT      = 250;
// Cap on waiting for the modal backdrop to clear. The backdrop is USUALLY
// persistent (clicks are dispatched straight through it by clickResilient), so
// this timeout is normally spent in full and buys nothing — keep it short.
const OVERLAY_CLEAR_TIMEOUT = 1200;

// Count overlays that are actually CAPABLE OF BLOCKING clicks.
//
//   ⚠️  Do NOT judge this by visibility or by aria-hidden. Playwright's
//   isVisible() ignores aria-hidden entirely (it only tests for a non-empty box
//   and visibility!=hidden), and `aria-hidden="true"` is an accessibility hint
//   that has no effect on hit-testing — an aria-hidden overlay still eats
//   clicks. What actually decides whether it blocks is the computed style:
//   `pointer-events: none` (or display:none / zero box) → harmless.
//
// So: an overlay counts as blocking only when it is laid out AND its computed
// pointer-events is not "none".
async function countVisibleOverlays(page) {
  let blocking = 0;
  for (const frame of page.frames()) {
    try {
      const n = await frame.locator(DIALOG_OVERLAY_SELECTOR).count();
      if (n === 0) continue;
      blocking += await frame.evaluate((sel) => {
        let count = 0;
        for (const el of document.querySelectorAll(sel)) {
          const cs = getComputedStyle(el);
          if (cs.display === 'none' || cs.visibility === 'hidden') continue;
          if (cs.pointerEvents === 'none') continue;   // present but click-through
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          count++;
        }
        return count;
      }, DIALOG_OVERLAY_SELECTOR).catch(() => 0);
    } catch {}
  }
  return blocking;
}

// Poll until no overlay is visible, or the timeout expires.
async function waitForOverlayGone(page, timeout = OVERLAY_CLEAR_TIMEOUT) {
  let deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    deadline += await gate();
    if (await countVisibleOverlays(page) === 0) return true;
    await waitInterruptible(page, 150);
  }
  return false;
}

// Did the backdrop for the CURRENTLY open dialog refuse to clear? Set by
// clearDialogOverlay when the form is opened, so later steps don't re-wait for
// something already measured as persistent on this very dialog.
//   true  → it persists; waiting again is pure dead time
//   false → it cleared
//   null  → not checked yet for this dialog
let overlayPersistsForDialog = null;

// Any association option, whichever ones this unit has.
const ASSOCIATION_OPTION_SELECTOR = '[data-testid^="radio-button-"]';
// Budgets for letting the dialog finish loading before the form is touched.
const DIALOG_DATA_TIMEOUT   = 12000;   // cap on the dialog's own fetches
const DIALOG_QUIET_MS       = 600;     // no new requests for this long = settled
const ASSOC_OPTIONS_TIMEOUT = 10000;   // cap on waiting for the options to appear
const ASSOC_OPTIONS_QUIET   = 800;     // option count unchanged for this long = complete
// First look for the options when the dialog opens. Short on purpose: the page
// was reloaded before the form was opened, so a correctly built dialog has them
// all immediately and returns on the first poll. This budget is only ever spent
// when something is wrong — and even then the poll returns after
// ASSOC_OPTIONS_QUIET once the count is stable, not at the cap.
const ASSOC_OPTIONS_FAST    = 1500;
// …and give up on that first look at once if NOTHING has rendered. An empty
// association section is not a "still filling in" state the quick look can
// resolve — it means the slow path is needed — so polling it out is dead time.
const ASSOC_OPTIONS_EMPTY_BAIL = 400;
// How long to let an association control redraw before deciding a click did not
// register. Vue re-renders on nextTick, so reading the DOM in the same tick as
// the click reports the pre-click markup — see waitForRadioEffect.
const RADIO_EFFECT_TIMEOUT  = 1500;

// ── Occupancy-load retry policy (v2.14.0) ──────────────────────
// The single failure mode that survived every earlier fix: the Add Document
// dialog is built before/without its occupancy data and offers only "The
// physical unit", which renders pre-selected but is inert — every save against
// it is refused with 400 "A document association is required".
//
// The dialog is built ONCE and never re-renders, and a dialog reopen reuses the
// same page state, so the ONLY known cure is a full page reload followed by a
// fresh open. That used to be tried once; now it is tried up to
// OCCUPANCY_MAX_ATTEMPTS times with a growing pause between attempts, because
// the operator's failures were units that came good on a later try.
//
// Reliability over speed: these budgets are deliberately generous. They are only
// ever spent on a unit that is ALREADY failing — a dialog that builds correctly
// takes the fast path and never reaches any of them.
const OCCUPANCY_MAX_ATTEMPTS = 5;
// A 'suspect' dialog (one option, occupancy unconfirmable) gets FEWER tries than
// a known-broken one. It is the shape a genuinely empty unit also has, and that
// unit will never improve no matter how many times the page is reloaded — so
// spending the full budget on every one of them would tax the innocent case. Two
// spare reloads still cover the load race; fillAssociation's click verification
// is the real backstop, and it stops before anything is attached.
const OCCUPANCY_SUSPECT_ATTEMPTS = 3;
// Pause before attempts 2..5. Growing, because an instant retry tends to hit the
// same cold/slow backend state that lost the race in the first place.
const OCCUPANCY_RETRY_BACKOFF_MS = [0, 2500, 4500, 7000, 10000];
// Budget for the occupancy fetch after a reload. The FIRST load gets the longest
// one: giving BuildingLink time to produce the data naturally is always better
// than reloading on top of a load that was merely slow.
const OCCUPANCY_FIRST_LOAD_CAP = 20000;
const OCCUPANCY_RETRY_LOAD_CAP = 15000;
// One last, longer look for options before an attempt is written off. The normal
// budgets assume a healthy dialog; this is the "are you sure?" pass.
const ASSOC_OPTIONS_LAST_LOOK = 5000;

// Judge a set of association options against what the unit is known to have.
//   'ok'      → usable: more than just the physical unit, so the occupancy data
//               is demonstrably in.
//   'broken'  → nothing rendered, or only the physical unit for a unit we KNOW
//               has occupants. Never fill this form; retry the reload.
//   'suspect' → only the physical unit, and we cannot confirm whether this unit
//               has occupancy (role map skipped/unreadable). Worth retrying, but
//               a genuinely empty unit looks exactly like this — so after the
//               retries are spent it is handed to fillAssociation, whose
//               click-verification decides (it throws before attaching if the
//               lone option will not register).
function judgeAssocOptions(opts) {
  if (!Array.isArray(opts) || opts.length === 0) return 'broken';
  if (!assocOptionsAreDegenerate(opts)) return 'ok';
  return unitHasKnownOccupants() ? 'broken' : 'suspect';
}

// The message that ends a file when the occupancy data never loaded. Matched by
// isOccupancyLoadFailure() to drive the end-of-run auto-retry, and by an
// ERROR_RULES entry for the plain-English version — so the exact wording is
// load-bearing in three places and must not drift.
const OCCUPANCY_EXHAUSTED_MARKER = 'occupancy data never loaded';

// Did this error come from the occupancy-loading problem? These are the failures
// worth re-attempting automatically at the end of a run: nothing was uploaded,
// the file is still in the source folder, and a later try often just works.
function isOccupancyLoadFailure(err) {
  const s = typeof err === 'string' ? err : (err && err.message) || '';
  return s.includes(OCCUPANCY_EXHAUSTED_MARKER) ||
         /offered only "The physical unit"/i.test(s) ||
         /A document association is required/i.test(s);
}

// Wait for the dialog's OWN data fetches to finish.
//
//   ⚠️  The Add Document dialog renders its static fields (title, type, date)
//   immediately, then fills in the association options from occupancy data
//   fetched afterwards. Proceeding as soon as the first field appears means
//   filling a half-built form: only "The physical unit" exists, the occupancy
//   and specific-occupant options are still in flight, and the component's
//   association model is never initialised — so the document posts with no
//   association and BuildingLink answers 400.
//
//   ⚠️  `since` is deliberately NOT the moment the dialog was opened. The
//   occupancy fetch is started by the Documents PAGE as it loads — before the
//   Add button is ever clicked — so a window opening at the click filters out
//   the one request that matters and the wait returns instantly. Measured: with
//   the window starting at the click, a 4s occupancy fetch was invisible and
//   the dialog was still built half-empty. Pass 0 to mean "whatever the page is
//   still fetching right now".
//
// Only xhr/fetch traffic counts. Images, scripts and long-lived connections
// (websocket/eventsource) must never hold the run up.
async function waitForDialogDataReady(page, since, cap = DIALOG_DATA_TIMEOUT) {
  let deadline = Date.now() + cap;
  let wait = 120;
  while (Date.now() < deadline) {
    deadline += await gate();
    const pending = [...netState.inFlight.values()].filter(v =>
      v.t >= since &&
      Date.now() - v.t < 30000 &&
      (v.rtype === 'xhr' || v.rtype === 'fetch'));
    const quietFor = Date.now() - Math.max(netState.lastRequestAt, since);
    if (pending.length === 0 && quietFor >= DIALOG_QUIET_MS) return true;
    await waitInterruptible(page, Math.min(wait, Math.max(0, deadline - Date.now())));
    wait = Math.min(400, Math.round(wait * 1.3));
  }
  return false;
}

// Don't call the network "idle" before the reloaded app has had a chance to ask
// for anything — a fresh page is briefly quiet simply because it has not
// started yet, and returning there is the same class of bug as an observation
// window that opens too late.
const OCCUPANCY_MIN_OBSERVE = 500;
// How long to keep waiting when the reloaded page has made NO data request at
// all yet. An app that boots its fetches a beat after DOMContentLoaded looks
// exactly like an app that has finished, and only time tells them apart.
//
//   MEASURED (harness, occupancy fetch issued 2s after load): without this the
//   wait ended at 0.6s "network idle", the dialog was built before the data
//   arrived, and the save came back 400 — the very failure the reload fixes.
//   This is a CAP on a bad case, not a delay: a page that fetches immediately
//   never reaches it.
const OCCUPANCY_NO_XHR_GRACE = 3000;

// Wait for the occupancy data behind the association options to actually be IN.
//
// This replaces "wait for the whole page to go quiet" with "wait for the one
// request that matters, and stop the instant it lands". Three ways to finish,
// whichever comes first:
//
//   occupancy-fetch → an occupancy-shaped xhr/fetch FINISHED (body downloaded).
//                     This is the real signal and usually ends the wait early.
//   network-idle    → nothing in flight and quiet for DIALOG_QUIET_MS. Exactly
//                     the old condition, kept so an unmatched URL pattern can
//                     never make this slower than the wait it replaced.
//   timeout         → the cap, same as before.
//
// Never slower than waitForDialogDataReady, because network-idle is still one
// of its exit conditions; only faster when the occupancy fetch is identified.
async function waitForOccupancyData(page, since, cap = DIALOG_DATA_TIMEOUT) {
  const started = Date.now();
  let deadline = started + cap;
  // Time spent parked at a pause. Held separately from `started` because the two
  // are used for different things: `started` must stay real wall-clock so an
  // occupancy fetch that landed DURING a pause still counts as having arrived,
  // while every "how long have we been watching" judgement below has to exclude
  // the pause or a resumed run would instantly conclude "no data traffic".
  let parked = 0;
  let wait = 100;
  while (Date.now() < deadline) {
    const p = await gate();
    deadline += p; parked += p;
    // 1. The signal we actually want: the occupancy body has been received.
    if (netState.occupancyDoneAt >= since && netState.occupancyDoneAt >= started) {
      return { ready: true, via: 'occupancy-fetch', ms: Date.now() - started - parked };
    }
    // 2. Fallback: the old network-idle condition, but only once there is
    //    positive evidence the page really has fetched its data.
    //
    //    ⚠️  "Nothing in flight" is NOT the same as "finished" on a page that
    //    has not started yet. An app that issues its occupancy fetch a moment
    //    after DOMContentLoaded is silent at first, and accepting that silence
    //    builds the dialog before the data lands — a 400 on save. So idle
    //    counts only after an xhr/fetch has actually been SEEN since the
    //    reload; until then we keep waiting, bounded by the grace below so a
    //    page that legitimately fetches nothing cannot hang the run.
    const pending = [...netState.inFlight.values()].filter(v =>
      v.t >= since &&
      Date.now() - v.t < 30000 &&
      (v.rtype === 'xhr' || v.rtype === 'fetch'));
    const quietFor = Date.now() - Math.max(netState.lastRequestAt, since);
    const sawData  = netState.lastXhrAt >= since;
    const observed = Date.now() - started - parked;
    if (observed >= OCCUPANCY_MIN_OBSERVE && pending.length === 0 && quietFor >= DIALOG_QUIET_MS &&
        (sawData || observed >= OCCUPANCY_NO_XHR_GRACE)) {
      return {
        ready: true,
        via: sawData ? 'network-idle' : 'no-data-traffic',
        ms: Date.now() - started - parked,
      };
    }
    await waitInterruptible(page, Math.min(wait, Math.max(0, deadline - Date.now())));
    wait = Math.min(400, Math.round(wait * 1.3));
  }
  return { ready: false, via: 'timeout', ms: Date.now() - started - parked };
}

// The complete set of association options BuildingLink can offer. Seeing all of
// them means the list is finished by definition and cannot grow further — the
// one case where waiting out a quiet period buys nothing at all.
//
//   ⚠️  This is a short-circuit, NOT a requirement. Units genuinely exist with
//   fewer options, and demanding a count would hang them; anything short of the
//   full set still falls through to the "stopped growing" logic below.
const ALL_ASSOCIATION_OPTION_IDS = [
  'radio-button-unitId',        // The physical unit
  'radio-button-occupancyId',   // The occupancy
  'radio-button-userId',        // Only specific occupants
];

// Wait until the association options stop appearing, and report which ones the
// unit ended up with. A unit legitimately may have only one, so this never
// insists on a particular count — it waits for the list to stop GROWING.
//
// `bailIfEmptyAfter` gives up early when NOTHING has rendered yet. Used by the
// quick first look: no options at all means the dialog has not built its
// association section, which the slow path (wait for the data, then look again)
// handles properly — so there is nothing to gain from polling out this budget.
async function waitForAssociationOptions(page, timeout = ASSOC_OPTIONS_TIMEOUT, { bailIfEmptyAfter = 0 } = {}) {
  let started = Date.now();
  let deadline = started + timeout;
  let best = [], stableSince = Date.now(), wait = 150;
  for (;;) {
    // Pause parks here. Every clock in this loop is relative — "has the list
    // stopped growing", "how long since we started" — so they all shift forward
    // by the parked time together and the judgements stay exactly as intended.
    const parked = await gate();
    if (parked) { started += parked; deadline += parked; stableSince += parked; }
    const found = [];
    for (const frame of page.frames()) {
      try {
        const ids = await frame.evaluate(sel => Array.from(document.querySelectorAll(sel))
          .filter(el => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
          .map(el => el.getAttribute('data-testid')), ASSOCIATION_OPTION_SELECTOR);
        for (const id of ids) if (id && !found.includes(id)) found.push(id);
      } catch {}
      // The dialog lives in one frame; once it has yielded the full set there is
      // nothing another frame could add, so stop scanning the remaining ~13.
      if (ALL_ASSOCIATION_OPTION_IDS.every(id => found.includes(id))) break;
    }
    if (found.length > best.length) { best = found; stableSince = Date.now(); }
    // Every option there is → the list is complete, so proceed at once rather
    // than sitting out a quiet period waiting for growth that cannot happen.
    if (ALL_ASSOCIATION_OPTION_IDS.every(id => best.includes(id))) return best;
    if (best.length > 0 && Date.now() - stableSince >= ASSOC_OPTIONS_QUIET) return best;
    if (bailIfEmptyAfter && best.length === 0 && Date.now() - started >= bailIfEmptyAfter) return best;
    if (Date.now() >= deadline) return best;
    await waitInterruptible(page, Math.min(wait, Math.max(0, deadline - Date.now())));
    wait = Math.min(400, Math.round(wait * 1.3));
  }
}

// Wait for the Add Document dialog to actually render a field, rather than
// sleeping a fixed "it's probably up by now" interval. Returns true when a form
// field appeared. The caller carries on either way — if the form really isn't
// there, the first field lookup produces a far better error than a blind wait.
async function waitForFormReady(page, timeout = FORM_READY_TIMEOUT) {
  let deadline = Date.now() + timeout;
  let wait = 100;
  while (Date.now() < deadline) {
    deadline += await gate();
    if (await addDocFormIsOpen(page)) return true;
    await waitInterruptible(page, Math.min(wait, Math.max(0, deadline - Date.now())));
    wait = Math.min(400, Math.round(wait * 1.4));
  }
  return false;
}

// Is the Add Document form actually on screen? Used to tell "overlay dismissed"
// from "whole dialog closed".
async function addDocFormIsOpen(page) {
  const markers = [
    '[data-testid="bl-textfield-value-input"]',
    '[data-testid="listbox-button"]',
    'input[name*="Title" i]',
    'select[name*="DocumentType" i]',
  ];
  for (const frame of page.frames()) {
    for (const s of markers) {
      try {
        const loc = frame.locator(s).first();
        if (await loc.count() > 0 && await loc.isVisible().catch(() => false)) return true;
      } catch {}
    }
  }
  return false;
}

// Give a transitional backdrop a brief chance to clear, then get on with it.
//
//   ⚠️  Deliberately does NOT click the overlay to dismiss it. The element is
//   the dialog's CLOSE target — clicking it closes the Add Document form we
//   just opened. That was worth attempting back when the backdrop was believed
//   transitional, but the run log proved it persistent, and clickResilient()
//   now hit-tests and dispatches events straight through it. So dismissing it
//   buys nothing and costs a dialog close + re-open on every single file.
//
// Returns true if the backdrop is gone, false if it persists (not an error —
// the clicks bypass it). Never throws.
async function clearDialogOverlay(page) {
  overlayPersistsForDialog = null;
  if (await waitForOverlayGone(page)) { overlayPersistsForDialog = false; return true; }
  overlayPersistsForDialog = true;

  const n = await countVisibleOverlays(page);
  log(`  ℹ️  Dialog backdrop persists (${n}) — clicks will be dispatched directly through it.`);

  // Sanity check: the backdrop is expected, a missing form is not.
  if (!(await addDocFormIsOpen(page))) {
    log(`  ⚠️  The Add Document form does not appear to be open — verify manually.`);
  }
  return false;
}

// ═══════════════════════════════════════════════════════════════
// RESILIENT CLICK — survives the dialog backdrop intercepting pointer events.
//
// Strategy is chosen by HIT-TESTING the element, not by catching exceptions:
//   covered by something else → synthetic JS dispatch (the only thing that works)
//   not covered              → normal click, with force as the retry
//
//   ⚠️  MEASURED, do not "simplify" this back to force:true. force only skips
//   Playwright's own actionability checks — the click it issues is still a REAL
//   mouse event at the element's coordinates, so the browser delivers it to
//   whatever is topmost (the overlay). Against a covering overlay, force
//   RESOLVES SUCCESSFULLY WHILE THE TARGET RECEIVES NOTHING — verified in a
//   headless-Chromium harness: handler fired 0 times, no exception raised. An
//   exception-driven chain therefore stops at force and never recovers.
//   A synthetic dispatch goes straight to the node with no hit-testing, so it
//   is the one that lands. It also fires pointerdown/mousedown/mouseup around
//   the click, since Vue/HeadlessUI listboxes often open on mousedown.
//
// Temporarily make the modal backdrop click-through, so a REAL mouse click can
// reach the control underneath it.
//
//   ⚠️  This is what a human's click does and a synthetic dispatch does not.
//   MEASURED 2026-07-31: the association radio (an <svg role="radiobutton">)
//   ignored synthetic events entirely — it never became selected, the payload
//   went out with no association, and BuildingLink answered
//   "A document association is required." A <button> survives a synthetic click
//   because it has a native .click(); an SVG has no such activation behaviour.
//
// The backdrop is only made click-through, never clicked — clicking it is what
// closes the dialog. Always restored in a finally block.
async function suppressOverlays(page) {
  let n = 0;
  for (const frame of page.frames()) {
    try {
      n += await frame.evaluate(sel => {
        let c = 0;
        for (const el of document.querySelectorAll(sel)) {
          if (el.hasAttribute('data-bl-pe-saved')) continue;
          el.setAttribute('data-bl-pe-saved', el.style.pointerEvents || '');
          el.style.pointerEvents = 'none';
          c++;
        }
        return c;
      }, DIALOG_OVERLAY_SELECTOR);
    } catch {}
  }
  return n;
}

async function restoreOverlays(page) {
  for (const frame of page.frames()) {
    try {
      await frame.evaluate(() => {
        for (const el of document.querySelectorAll('[data-bl-pe-saved]')) {
          el.style.pointerEvents = el.getAttribute('data-bl-pe-saved');
          el.removeAttribute('data-bl-pe-saved');
        }
      });
    } catch {}
  }
}

// Returns which strategy ran ('normal' | 'force' | 'js' | 'real-through-overlay'),
// or throws if all fail.
async function clickResilient(locator, label = 'element', { preferJs = false } = {}) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});

  // Is this element the actual hit target at its own center point?
  //   false → a real mouse click will reach it
  //   true  → something (the dialog backdrop) is on top; only a synthetic
  //           dispatch can reach it
  //   null  → couldn't tell (zero-size box, detached); treat as not covered
  const covered = await locator.evaluate(el => {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!top) return null;
    return !(el === top || el.contains(top));
  }).catch(() => null);

  const jsClick = async () => {
    await locator.evaluate(el => {
      const opts = { bubbles: true, cancelable: true, view: window };
      el.dispatchEvent(new PointerEvent('pointerdown', opts));
      el.dispatchEvent(new MouseEvent('mousedown', opts));
      el.dispatchEvent(new PointerEvent('pointerup', opts));
      el.dispatchEvent(new MouseEvent('mouseup', opts));
      if (typeof el.click === 'function') el.click();
      else el.dispatchEvent(new MouseEvent('click', opts));
    });
  };

  // preferJs: dispatch straight at the element reference, never a coordinate
  // click. Used for controls where clicking the wrong thing is costly (the
  // Document Type listbox — the page has other HeadlessUI listboxes).
  if (preferJs) {
    await jsClick();
    return 'js';
  }

  if (covered === true) {
    // Prefer a REAL click with the backdrop made click-through — a trusted
    // event, exactly like a human's. Synthetic dispatch is the last resort
    // because some controls (SVG radios) silently ignore it.
    const pg = typeof locator.page === 'function' ? locator.page() : null;
    if (pg) {
      const n = await suppressOverlays(pg);
      try {
        await locator.click({ timeout: 5000 });
        return 'real-through-overlay';
      } catch (e) {
        log(`         (${label}: real click through the overlay failed — ${e.message.split('\n')[0]})`);
      } finally {
        await restoreOverlays(pg);
      }
    }
    log(`         (${label} is covered by an overlay — dispatching JS click)`);
    await jsClick();
    return 'js';
  }

  try {
    await locator.click({ timeout: 8000 });
    return 'normal';
  } catch (e1) {
    // Not covered, so force genuinely helps here (animation, transient
    // instability, an element Playwright considers not-yet-stable).
    log(`         (click failed on ${label} — retrying with force)`);
    try {
      await locator.click({ force: true, timeout: 5000 });
      return 'force';
    } catch (e2) {
      log(`         (force click failed on ${label} — dispatching JS click)`);
      try {
        await jsClick();
        return 'js';
      } catch (e3) {
        throw new Error(`All click strategies failed on ${label}: ${e3.message} (force: ${e2.message}) (normal: ${e1.message})`);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// NAVIGATION: search → unit profile → Documents tab → Add form
// Returns the frame context (ctx) that contains the Add Document form.
// ═══════════════════════════════════════════════════════════════
// The unit profile's Documents tab. CONFIRMED live 2026-07-31:
//   <a data-testid="tab-item-documents" href="javascript:void(0)">Documents</a>
// Used both to verify the unit profile loaded (step 2) and to open the tab
// (step 3).
const DOCS_TAB_SELECTOR = '[data-testid="tab-item-documents"]';

// Backup only, for a unit still on the legacy UI or if the testid is renamed.
//
//   ⚠️  Do NOT merge these into one array with DOCS_TAB_SELECTOR. A joined CSS
//   list resolves in DOM order, so `a:has-text("Documents")` — which matches any
//   anchor merely CONTAINING the word, including "Unit/Apt. Documents" or a
//   breadcrumb — could win over the exact testid. findAcrossFramesPreferred
//   queries them as two ordered lookups, which is what makes the testid
//   authoritative. These text selectors are also the ones that produced the
//   recurring "Could not find the Documents tab" timeouts.
const DOCS_TAB_FALLBACK_SELECTORS = [
  'a:text-is("Documents")',
  'button:text-is("Documents")',
  '[role="tab"]:has-text("Documents")',
  'a:has-text("Unit/Apt. Documents")',
  'a:has-text("Unit/Apt")',
  'a:has-text("Documents")',
];

const ADD_DOC_BUTTON_SELECTORS = [
  'button:has([data-testid="button-text"]:has-text("Add new document"))',
  '[data-testid="button-text"]:has-text("Add new document")',
  'button:has-text("Add new document")',
  'a:has-text("Add a New Document")',
  'button:has-text("Add a New Document")',
  'input[value*="Add a New Document" i]',
];

// Force a full page load of the unit's Documents view.
//
//   ⚠️  THIS IS THE FIX for the missing association options. Arriving at the
//   unit through Quick Search enters the Vue app by client-side navigation, and
//   in that path the occupancy data behind the "occupancy" and "specific
//   occupants" options is never fetched — the Add Document dialog is then built
//   with only "The physical unit". Reopening the DIALOG does not help, because
//   it reuses the same already-loaded page state. A real browser refresh does,
//   because it re-bootstraps the app from the URL (which carries UnitId and
//   PhysicalUnitId). MEASURED by the operator 2026-08-03: refresh then open →
//   all three options; reopen without refresh → still one.
//
// Returns true if the view was actually reloaded.
async function reloadUnitDocumentsView(page, occupancyCap = OCCUPANCY_FIRST_LOAD_CAP) {
  const url = page.url();
  // Only reload when the address bar really is the documents view — reloading
  // some other URL would silently take us somewhere else.
  if (!/unit-documents|documents/i.test(url)) {
    log(`         ⚠️  Not reloading: the address bar is not the Documents view (${url.slice(0, 120)}).`);
    return false;
  }
  const since = Date.now();
  markNetWindow();
  try {
    // 'domcontentloaded', not 'load': the occupancy fetch fires as the app
    // boots, and waiting for every image/font/iframe on top of it just delays
    // the thing we actually care about. The real gate is the wait below.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
  } catch (e) {
    log(`         ⚠️  Reload failed (${e.message.split('\n')[0]}) — continuing with the page as it is.`);
    return false;
  }
  // Stop the moment the occupancy data is IN, rather than sitting through a
  // fixed settle. Falls back to the old network-idle condition, so an
  // unrecognised endpoint costs nothing.
  // A generous budget here is the cheapest reliability there is: waiting for the
  // data to arrive naturally always beats reloading on top of a slow load.
  const r = await waitForOccupancyData(page, since, occupancyCap);
  if (r.via === 'occupancy-fetch') {
    log(`         ✓ Occupancy data loaded in ${(r.ms / 1000).toFixed(1)}s — proceeding immediately.`);
  } else if (r.via === 'network-idle') {
    // Worth reporting: it means OCCUPANCY_URL_RE did not recognise the fetch,
    // and the URLs below are what it should have matched.
    log(`         Documents view settled in ${(r.ms / 1000).toFixed(1)}s (network idle; no occupancy request recognised).`);
    if (netState.windowUrls.length) {
      log(`         (data URLs seen on reload: ${netState.windowUrls.slice(0, 6).map(shortUrl).join(', ')})`);
    }
  } else if (r.via === 'no-data-traffic') {
    log(`         ⚠️  The reloaded Documents view made no data request in ${(r.ms / 1000).toFixed(1)}s — continuing; the association options are checked when the form opens.`);
  } else {
    log(`         ⚠️  Occupancy data not confirmed within ${(r.ms / 1000).toFixed(1)}s — continuing; the association options are checked when the form opens.`);
  }
  return true;
}

// Trim a URL to host + path for logging — query strings here are long GUIDs.
function shortUrl(u) {
  try { const p = new URL(u); return p.host + p.pathname; } catch { return String(u).slice(0, 80); }
}

// Open the Add Document dialog on whatever Documents view is currently loaded,
// and report which association options it ended up building.
//
// Shared by the first attempt and every retry, so a retried open is identical to
// the original in every respect — there is no second, weaker code path that
// could behave differently on the attempt that finally succeeds.
//
// Also (re)takes the pendingUpload snapshot: the page has usually just been
// reloaded, so the "before" document-list text that saveForm verifies against
// must be re-read for the page that is actually on screen.
async function openDialogAndReadOptions(page, unit) {
  const { loc: addBtn, ctx } = await findAcrossFrames(page, ADD_DOC_BUTTON_SELECTORS, 20000);

  // Snapshot the unit's document list BEFORE the form opens — saveForm compares
  // against this to prove the new document really landed. Taken here, at the
  // last possible moment: the Add button existing means the list has rendered,
  // so the "before" count can't be short just because the page was still
  // loading (which would make the check pass when it shouldn't).
  pendingUpload = { unit, title: null, beforeText: await readAllFrameText(page) };

  await addBtn.click();
  try { await page.waitForLoadState('load', { timeout: 15000 }); } catch {}
  // Wait for the dialog to actually render a field instead of sleeping a fixed
  // 3.5s and hoping. Returns as soon as a real form field is on screen (usually
  // a few hundred ms), and still allows far longer than the old fixed wait when
  // BuildingLink is genuinely slow. The short settle afterwards covers the
  // dialog's open transition.
  if (!(await waitForFormReady(page))) {
    log(`  ⚠️  The Add Document form did not render within ${Math.round(FORM_READY_TIMEOUT / 1000)}s — continuing; the next field lookup will report what is missing.`);
  }
  await waitInterruptible(page, FORM_SETTLE_WAIT);
  await gate();

  // The first field appearing is NOT the form being ready — the association
  // options are built from occupancy data that lands later, and filling the form
  // before they exist is what produced documents with no association.
  //
  // Check for the OPTIONS THEMSELVES first. They are the actual requirement, so
  // when the full set is already rendered (the normal case now that the page is
  // reloaded first) this proceeds immediately, with no network wait and no
  // quiet period. Anything short of the full set falls back to the original
  // path — network settle, then the full option budget.
  // since=0: the occupancy fetch that populates the options is started by the
  // Documents page, not by the Add click.
  let settled = null;
  let options = await waitForAssociationOptions(
    page, ASSOC_OPTIONS_FAST, { bailIfEmptyAfter: ASSOC_OPTIONS_EMPTY_BAIL });
  const fastPath = ALL_ASSOCIATION_OPTION_IDS.every(id => options.includes(id));
  if (!fastPath) {
    settled = await waitForDialogDataReady(page, 0);
    // Once the dialog's network has gone quiet, options that have not appeared
    // are not going to — so don't sit through the full budget. That budget
    // exists for a page still fetching, not for a form that genuinely has none.
    options = await waitForAssociationOptions(page, settled ? 3000 : ASSOC_OPTIONS_TIMEOUT);
    // One last, longer look before this attempt is written off and the whole
    // page is reloaded. Reloading costs several seconds and throws away a dialog
    // that might have been one slow render away from being fine.
    if (judgeAssocOptions(options) !== 'ok') {
      const lastLook = await waitForAssociationOptions(page, ASSOC_OPTIONS_LAST_LOOK);
      if (lastLook.length > options.length) {
        log(`         (a longer look found ${lastLook.length} option(s) — the dialog was still building)`);
        options = lastLook;
      }
    }
  }
  return { options, ctx, fastPath, settled };
}

async function openAddDocForm(page, unit) {
  // 1. Quick Search
  stepBegin('search', 'Quick Search', `  [1] Quick Search → ${unit}...`);
  await page.goto(SEARCH_URL);
  try { await page.waitForLoadState('load', { timeout: 15000 }); } catch {}
  // No fixed settle here: findAcrossFrames polls for the search box across every
  // frame and returns the moment it is visible, which is the same condition the
  // old 1.5s sleep was guessing at.
  const { loc: searchInput, ctx: searchCtx } = await findAcrossFrames(page, [
    'input[placeholder*="Quick Search" i]',
    'input[placeholder*="quick" i]',
    'input[id*="quickSearch" i]',
    'input[id*="QuickSearch" i]',
  ]);
  await searchInput.click();
  await searchInput.fill(unit);

  const autocomplete = searchCtx.locator([
    'ul.ui-autocomplete li a',
    '[class*="autocomplete" i] li a',
    '[class*="suggest" i] a',
  ].join(', ')).first();

  // Wait briefly for the suggestion list; fall back to Enter if it never shows.
  try {
    await autocomplete.waitFor({ state: 'visible', timeout: 2500 });
    await autocomplete.click();
  } catch {
    await searchInput.press('Enter');
  }
  try { await page.waitForLoadState('load', { timeout: 15000 }); } catch {}

  // 2. Confirm unit profile loaded (Documents tab visible). The tab label was
  // shortened from "Unit/Apt. Documents" to just "Documents" in the new UI —
  // exact "Documents" matches are tried first, with the old labels kept as
  // fallbacks so units still on the legacy UI keep working.
  stepBegin('profile', 'Unit profile', `  [2] Verifying unit profile...`);
  const { loc: docsTabLoc, ctx: profileCtx, usedFallback } =
    await findAcrossFramesPreferred(page, DOCS_TAB_SELECTOR, DOCS_TAB_FALLBACK_SELECTORS, 15000);
  if (usedFallback) {
    log(`         (no ${DOCS_TAB_SELECTOR} on this unit — matched the Documents tab by its label instead)`);
  }

  // 2b. Read the Unit Overview tab FIRST — builds the name → role map that all
  // owner-vs-tenant decisions later in this file use. Best-effort by design.
  // readUnitRoleMap logs its own [2b] line (it reports what it found), so the
  // step is opened with no line of its own and picks that one up as its anchor.
  stepBegin('roles', 'Unit Overview roles');
  if (skipRoleMap) {
    unitRoleMap = new Map();
    unitRoleMapUnit = unit;
    unitRoleMapStatus = 'skipped';
    stepLine(`  [2b] Unit Overview roles SKIPPED (test switch) — owner/tenant routing falls back to in-form detection.`);
  } else {
    await readUnitRoleMap(page, unit);
  }

  // 3. Click Documents tab
  // Everything from here until the dialog is ready is the FORM-OPEN window —
  // captured for the diagnostics, because whether an occupancy fetch happens
  // (and when) is only visible here, not in the save window.
  const formOpenAt = Date.now();

  stepBegin('docstab', 'Documents tab', `  [3] Opening Documents tab...`);
  // Reuse the element step [2] already located — Playwright locators re-resolve
  // when used, so this is a fresh query against the live DOM, just without a
  // second search. If the page moved under us, look it up again the same
  // (testid-first) way rather than falling straight to the loose selectors.
  let docsTab = docsTabLoc;
  try {
    await docsTab.waitFor({ state: 'visible', timeout: 5000 });
  } catch {
    ({ loc: docsTab } = await findAcrossFramesPreferred(
      page, DOCS_TAB_SELECTOR, DOCS_TAB_FALLBACK_SELECTORS, 10000));
  }
  await docsTab.click();
  try { await page.waitForLoadState('load', { timeout: 15000 }); } catch {}

  // Re-bootstrap the page from its URL. Clicking the tab is a client-side route
  // change; the occupancy data the association options are built from is only
  // fetched on a real page load. See reloadUnitDocumentsView.
  const reloaded = await reloadUnitDocumentsView(page);
  log(`         ${reloaded ? '↻ Reloaded the Documents view so the occupancy data is fetched.'
                           : '(Documents view was not reloaded — see the warning above.)'}`);
  // The old 1.5s settle here was covering the same ground as step [4]'s own
  // poll for the "Add new document" button — which waits up to 20s and returns
  // as soon as the button is really there.

  // 4. Click "Add new document". The new UI renders the label inside a
  // <span data-testid="button-text">Add new document</span> within a <button>,
  // so target the button that contains that span (clicking the button is more
  // reliable than the inner span). Old-UI "Add a New Document" link/button/input
  // selectors are kept as fallbacks for units still on the legacy interface.
  stepBegin('adddoc', 'Add new document', `  [4] Clicking "Add new document"...`);

  // ── Open the dialog, and keep reloading until its occupancy data is really in ──
  //
  // A dialog built before/without its occupancy data offers only "The physical
  // unit", drawn as selected but inert: every save against it is refused. The
  // dialog is built ONCE and never re-renders, and a reopen reuses the same page
  // state — so the only cure is a full reload followed by a fresh open, and the
  // only safe response to a bad dialog is to throw it away and load again.
  //
  // NOTHING IS TYPED INTO THE FORM UNTIL THIS LOOP IS SATISFIED, so a discarded
  // attempt costs only time. The loop ends one of three ways:
  //   ok       → usable options; carry on and fill the form.
  //   suspect  → only the physical unit, but this unit's occupancy could not be
  //              confirmed, so it may genuinely have none. Handed to
  //              fillAssociation, which verifies the click registers and throws
  //              before attaching if it does not.
  //   broken   → still unusable after every attempt → throw HERE, before a
  //              single field is filled and before the PDF is attached. The file
  //              stays in the source folder and is picked up by the end-of-run
  //              auto-retry.
  let formCtx = null, assocOptions = [], verdict = 'broken';
  const attemptLog = [];
  for (let attempt = 1; attempt <= OCCUPANCY_MAX_ATTEMPTS; attempt++) {
    // The top of an attempt is a natural place to park: nothing has been typed
    // into the form yet, so a stop here costs nothing at all.
    await gate();
    if (attempt > 1) {
      const pause = OCCUPANCY_RETRY_BACKOFF_MS[Math.min(attempt - 1, OCCUPANCY_RETRY_BACKOFF_MS.length - 1)];
      log(`  ↻ Attempt ${attempt} of ${OCCUPANCY_MAX_ATTEMPTS}: pausing ${(pause / 1000).toFixed(1)}s, then reloading the Documents view so the occupancy data is fetched again...`);
      // The longest blind wait in the pipeline (up to 10s). Interruptible, so
      // Pause/Stop during a backoff lands immediately instead of sitting it out.
      await waitInterruptible(page, pause);
      await gate();
      const reloadedAgain = await reloadUnitDocumentsView(page, OCCUPANCY_RETRY_LOAD_CAP);
      if (!reloadedAgain) {
        log(`         ⚠️  Could not reload for attempt ${attempt} — opening the dialog against the page as it is.`);
      }
    }

    let r;
    try {
      r = await openDialogAndReadOptions(page, unit);
    } catch (e) {
      // A failed OPEN is retryable in exactly the same way as a bad dialog —
      // unless this was the last attempt, in which case the real error is the
      // most useful thing we can report.
      if (attempt === OCCUPANCY_MAX_ATTEMPTS) throw e;
      log(`         ⚠️  Attempt ${attempt} could not open the form (${e.message.split('\n')[0]}) — retrying.`);
      attemptLog.push(`#${attempt}: open failed`);
      continue;
    }

    assocOptions = r.options;
    formCtx = r.ctx || formCtx;
    verdict = judgeAssocOptions(assocOptions);
    attemptLog.push(`#${attempt}: ${assocOptions.length} option(s) → ${verdict}`);

    log(`         Association options loaded (${assocOptions.length}): ` +
        `${assocOptions.length ? assocOptions.join(', ') : 'NONE FOUND'}` +
        `${r.fastPath ? ' — complete set, no further wait' : ''}` +
        `${r.settled === false ? ' — dialog network never went quiet' : ''}`);

    if (verdict === 'ok') {
      if (attempt > 1) log(`  ✓ Attempt ${attempt} produced usable association options — the earlier attempt(s) had simply not loaded the occupancy data.`);
      break;
    }

    // Not usable. Say exactly why, so the log explains itself.
    const why = assocOptions.length === 0
      ? 'the dialog rendered no association options at all'
      : `the dialog offered only "The physical unit"${unitHasKnownOccupants()
          ? ` even though the Unit Overview lists ${unitRoleMap.size} occupant(s) for ${unit}`
          : ' and this unit\'s occupancy could not be confirmed'}`;
    // A unit whose occupancy we cannot confirm stops early — see
    // OCCUPANCY_SUSPECT_ATTEMPTS. It may simply have nobody living in it, in
    // which case no number of reloads will ever add an option.
    const budget = verdict === 'suspect' ? OCCUPANCY_SUSPECT_ATTEMPTS : OCCUPANCY_MAX_ATTEMPTS;
    if (attempt < budget) {
      log(`  ⚠️  Attempt ${attempt} unusable — ${why}. Nothing has been filled in; reloading and trying again.`);
    } else {
      log(`  ⚠️  Attempt ${attempt} unusable — ${why}. No attempts left.`);
      break;
    }
  }

  // Every attempt spent and the dialog is still one dead option — stop cleanly.
  // Filling and saving this form would guarantee a 400 and burn the upload, so
  // the file is left untouched in the source folder for the auto-retry pass.
  if (verdict === 'broken') {
    throw new Error(
      `The Add Document form for ${unit} ${OCCUPANCY_EXHAUSTED_MARKER} after ${OCCUPANCY_MAX_ATTEMPTS} reload attempts ` +
      `(${attemptLog.join('; ')}). BuildingLink kept building the dialog with only "The physical unit", which it then refuses ` +
      `with "A document association is required". Nothing was filled in, nothing was uploaded, and the file was left in the ` +
      `source folder — it will be retried automatically at the end of this run.`);
  }
  if (verdict === 'suspect') {
    log(`  ℹ️  Proceeding with only "The physical unit" — this unit's occupancy could not be confirmed, so it may genuinely have none. ` +
        `The association click is verified before anything is attached; if it does not register, the file is stopped there.`);
  }

  if (pendingUpload) {
    pendingUpload.assocOptions = assocOptions;
    pendingUpload.assocAttempts = attemptLog;
    // Snapshot the form-open network so the diagnostic can show whether an
    // occupancy/occupant fetch was ever made, and whether it finished in time.
    pendingUpload.openNet = saveDiag.net
      .filter(e => e.t >= formOpenAt)
      .map(e => ({ dt: e.t - formOpenAt, kind: e.kind, method: e.method, status: e.status, url: e.url }));
    pendingUpload.openConsole = saveDiag.console
      .filter(e => e.t >= formOpenAt)
      .map(e => ({ dt: e.t - formOpenAt, type: e.type, text: String(e.text).split('\n')[0].slice(0, 200) }));
  }

  // 5. Note the modal backdrop. It usually persists; the field clicks are
  // dispatched straight through it by clickResilient().
  stepBegin('overlay', 'Overlay check', `  [5] Checking the dialog overlay...`);
  await clearDialogOverlay(page);

  return formCtx;
}

// ═══════════════════════════════════════════════════════════════
// FORM FIELD: Document Title
// ═══════════════════════════════════════════════════════════════
// ★★ BuildingLink's title box SILENTLY TRUNCATES at TITLE_MAX_LEN characters.
// Confirmed live 2026-08-17 from save-diagnostics: a 111-char correspondence
// title was accepted by the form, and the POST went out carrying exactly the
// first 100 characters — HTTP 204, document saved fine, trailing " 06-24-2022"
// simply gone. Nothing warns you; the field just stops accepting input.
//
// ⚠️ THE DAMAGE WAS TO VERIFICATION, NOT THE UPLOAD. verifyDocumentSaved counts
// the title in the unit's document list; it was counting the 111-char string we
// MEANT to type, while the list showed the 100-char string that was actually
// saved — 0 occurrences, so a perfectly good save was reported as
// "Save appeared to succeed but the document is NOT in unit X's document list",
// the file was left in the source folder, and re-running it added ANOTHER copy
// to BuildingLink each time. Long titles were therefore a silent duplicate
// factory. (Same family as the v1.7.0 lesson: a verifier must observe the thing
// that actually happened, not the thing that was intended.)
//
// Two defenses, both needed:
//   1. cap the title here, so what we type is what the field can hold; and
//   2. READ THE FIELD BACK and verify against that, so if BuildingLink ever
//      changes the limit the check follows it instead of breaking again.
const TITLE_MAX_LEN = 100;

async function fillTitle(formCtx, title) {
  const f = await findIn(formCtx, [
    '[data-testid="bl-textfield-value-input"]', // new UI (title is the first such field)
    'input[name*="DocumentTitle" i]',
    'input[name*="Title" i]',
    'input[id*="title" i]',
    'input[placeholder*="title" i]',
  ]);
  const wanted = String(title);
  const capped = wanted.length > TITLE_MAX_LEN
    ? wanted.slice(0, TITLE_MAX_LEN).trimEnd()
    : wanted;
  await f.fill(capped);

  // What the field ACTUALLY holds now — the authority for verification. Falls
  // back to `capped` only if the value can't be read.
  let committed = capped;
  try {
    const v = await f.inputValue();
    if (typeof v === 'string' && v.length) committed = v;
  } catch {}

  // Remember what we are filing, so saveForm can look for it in the unit's
  // document list afterwards. This must be the COMMITTED text, never `title`.
  if (pendingUpload) {
    pendingUpload.title = committed;
    pendingUpload.requestedTitle = wanted;
  }
  if (committed !== wanted) {
    log(`         Title: "${committed}"`);
    log(`         ⚠️  Title shortened to ${committed.length} chars (BuildingLink's limit) — dropped: "${wanted.slice(committed.length)}"`);
  } else {
    log(`         Title: "${committed}"`);
  }
}

// ═══════════════════════════════════════════════════════════════
// FORM FIELD: Document Type
// New UI: a custom listbox — click [data-testid="listbox-button"] to open it,
// then click the option whose text contains the keyword. Legacy UI: a native
// <select> dropdown (kept as a fallback for units still on the old interface).
// ═══════════════════════════════════════════════════════════════
// Compare option labels forgivingly: entity-decode, treat "&" and "and" as the
// same word, drop punctuation/case/extra whitespace.
//   "Signed Documents & Waivers"   → "signed documents and waivers"
//   "Signed Documents and Waivers" → "signed documents and waivers"
//   "Proof Of Ownership"           → "proof of ownership"
// textContent already decodes &amp; → &, but the explicit replace covers a
// double-escaped label surviving as the literal text "&amp;".
function normalizeTypeLabel(s) {
  return (s || '')
    .replace(/&amp;/gi, '&')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

// Find THE DOCUMENT TYPE listbox button — not the page's other HeadlessUI
// listboxes (the header carries its own, e.g. the language selector, with the
// SAME data-testid). Taking .first() in the frame is what opened the wrong
// dropdown: the header's button precedes the dialog's in the DOM.
//
// Confirmed markup:
//   <button data-testid="listbox-button" aria-haspopup="listbox"
//           aria-labelledby="headlessui-listbox-label-16 headlessui-listbox-button-17">
//     <div>Document type</div>
//   </button>
// so identify it by its own text (the placeholder shown before a value is
// chosen) or by the text of the elements aria-labelledby points at.
//
// Returns { btn, note } or null when it cannot be identified — the caller then
// errors out rather than clicking an unknown dropdown.
async function findDocTypeListbox(formCtx) {
  const all = await formCtx.locator('[data-testid="listbox-button"]').all();
  if (all.length === 0) return null;

  const labelOf = async (btn) => await btn.evaluate(el => {
    let text = (el.textContent || '');
    for (const id of (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
      const n = document.getElementById(id);
      if (n) text += ' ' + (n.textContent || '');
    }
    return text.replace(/\s+/g, ' ').trim().toLowerCase();
  }).catch(() => '');

  for (const btn of all) {
    if ((await labelOf(btn)).includes('document type')) {
      return { btn, note: all.length > 1 ? `identified by label among ${all.length} listboxes` : null };
    }
  }

  // Only one listbox in the frame and it isn't labelled — almost certainly the
  // form's (label markup changed). Use it, but say so.
  if (all.length === 1) {
    return { btn: all[0], note: `no "Document type" label found; using the only listbox in the form` };
  }

  return null; // several listboxes, none identifiable → refuse to guess
}

async function fillType(formCtx, typeKeyword) {
  // ── New UI: custom listbox ──────────────────────────────────────
  const found = await findDocTypeListbox(formCtx);
  if (found && found.note) log(`         (Document Type listbox: ${found.note})`);
  if (!found && await formCtx.locator('[data-testid="listbox-button"]').count() > 0) {
    throw new Error(
      'Could not identify the Document Type listbox among several listboxes on the page — ' +
      'refusing to click an unknown dropdown.');
  }
  const listBtn = found ? found.btn : formCtx.locator('[data-testid="listbox-button"]').first();
  if (await listBtn.count() > 0) {
    // This click is the one the dialog backdrop intercepts — but it is issued
    // with preferJs, which dispatches straight at the element reference and is
    // unaffected by anything covering it. So waiting for the backdrop here only
    // ever helped by accident.
    //
    //   ⚠️  This used to wait up to 5s on EVERY file. openAddDocForm has just
    //   finished measuring this same backdrop; when it found it persistent (the
    //   normal case), waiting again is 5s of guaranteed dead time per file —
    //   the single largest cost in the form-fill step. Only wait when the
    //   backdrop looked clearable, and then only briefly.
    if (overlayPersistsForDialog !== true) {
      try {
        const pg = typeof formCtx.page === 'function' ? formCtx.page() : null;
        if (pg) await waitForOverlayGone(pg, 1200);
      } catch {}
    }
    // preferJs: dispatch on the resolved element reference so the click can
    // never land on a neighbouring control via coordinates.
    await clickResilient(listBtn, 'Document Type listbox button', { preferJs: true });

    // Options are <li data-testid="listbox-option" role="option"><span>Name</span></li>
    // (8 of them, confirmed live). HeadlessUI mounts them asynchronously and may
    // portal them to the document root — still within this frame. POLL rather
    // than taking one snapshot: a single .all() a fixed time after the click
    // races the list being populated, which produced the old "option matching
    // Registration not found" warning. Re-open the listbox once if it never
    // expanded.
    const optionSel = '[data-testid="listbox-option"], [data-testid*="listbox-option"], li[role="option"], [role="option"]';
    const deadline  = Date.now() + 10000;
    const wanted    = normalizeTypeLabel(typeKeyword);
    let seenTexts = [], everOpened = false, retried = false;

    // Scope the options to the panel THIS button controls. HeadlessUI sets
    // aria-controls on the button to the open panel's id; without that scope a
    // different open listbox's options would be read (and clicked).
    const optionsIn = async () => {
      const controls = await listBtn.getAttribute('aria-controls').catch(() => null);
      if (controls) {
        const panel = formCtx.locator(`[id="${controls.replace(/"/g, '\\"')}"]`);
        if (await panel.count() > 0) return panel.locator(optionSel);
      }
      return formCtx.locator(optionSel);
    };

    while (Date.now() < deadline) {
      const visible = [];
      for (const opt of await (await optionsIn()).all()) {
        if (await opt.isVisible().catch(() => false)) visible.push(opt);
      }

      if (visible.length) {
        everOpened = true;
        seenTexts = [];
        for (const opt of visible) {
          // The label lives in the option's inner <span>; fall back to the
          // option's own text if the markup ever changes.
          const t = await opt.evaluate(el => {
            const span = el.querySelector('span');
            return ((span ? span.textContent : el.textContent) || '');
          }).catch(() => '');
          seenTexts.push(t.replace(/\s+/g, ' ').trim());
        }

        // Exact match on the normalized label.
        let i = seenTexts.findIndex(t => normalizeTypeLabel(t) === wanted);

        // No exact hit → accept a substring match ONLY when it is unambiguous,
        // so a renamed option still works but two candidates never coin-flip.
        if (i < 0) {
          const partial = seenTexts
            .map((t, idx) => ({ idx, n: normalizeTypeLabel(t) }))
            .filter(o => o.n.includes(wanted) || wanted.includes(o.n));
          if (partial.length === 1) {
            i = partial[0].idx;
            log(`         (no exact match for "${typeKeyword}" — using closest unique option "${seenTexts[i]}")`);
          }
        }

        if (i >= 0) {
          await clickResilient(visible[i], `Document Type option "${seenTexts[i]}"`);
          if (pendingUpload) pendingUpload.docType = seenTexts[i];
          log(`         Type: "${seenTexts[i]}"`);
          return;
        }
      }

      // Never expanded → the open click didn't take. Try once more.
      if (!everOpened && !retried) {
        const expanded = await listBtn.getAttribute('aria-expanded').catch(() => null);
        if (expanded === 'false' || expanded === null) {
          retried = true;
          log(`         (listbox did not expand — clicking it again)`);
          await clickResilient(listBtn, 'Document Type listbox button (retry)');
        }
      }
      // HeadlessUI mounts its options within a frame or two of the click, so
      // check back quickly — the old 300ms tick spent up to a third of a second
      // per file waiting on a list that was already there.
      await new Promise(r => setTimeout(r, 120));
    }

    // No match — close the list and STOP. Uploading with the wrong (or no)
    // document type files the PDF incorrectly in BuildingLink, which is worse
    // than erroring out with the file left in place for a human.
    await formCtx.locator('body').press('Escape').catch(() => {});
    if (seenTexts.length) {
      throw new Error(
        `No Document Type option matched "${typeKeyword}". Options offered: ${seenTexts.map(t => `"${t}"`).join(', ')}`);
    }
    const expanded = await listBtn.getAttribute('aria-expanded').catch(() => null);
    throw new Error(
      `Document Type listbox rendered no options within 10s (aria-expanded=${expanded}) — nothing selected.`);
  }

  // ── Legacy UI: native <select> ──────────────────────────────────
  const sel = formCtx.locator([
    'select[name*="DocumentType" i]',
    'select[name*="Type" i]',
    'select[id*="doctype" i]',
    'select[id*="type" i]',
  ].join(', ')).first();
  if (await sel.count() === 0) return;
  const options = await sel.locator('option').all();
  for (const opt of options) {
    const text = (await opt.textContent() || '').trim();
    if (text.toLowerCase().includes(typeKeyword.toLowerCase())) {
      await sel.selectOption({ label: text });
      log(`         Type: "${text}"`);
      return;
    }
  }
  // Exact fallback
  await sel.selectOption({ label: typeKeyword });
  log(`         Type: "${typeKeyword}"`);
}

// ═══════════════════════════════════════════════════════════════
// FORM FIELD: Association radio buttons.
// New UI: the radios are SVG elements (svg[role="radiobutton"]) identified by
// aria-describedby; we click the SVG directly.
//   mode = 'unit'      → "The physical unit"        → aria-describedby="The physical unit-description"
//   mode = 'occupancy' → "The [name] occupancy"     → aria-describedby*="occupancy-description" (name is dynamic → partial match)
//   mode = 'specific'  → "Only specific occupants"  → aria-describedby="Only specific occupants-description"
// Legacy UI: standard <input type="radio"> keyed by value (RdoPhysicalUnitBin /
// RdoAssignUnit / RdoAssignUser) — kept as a fallback. Both reveal follow-up
// fields on click.
// ═══════════════════════════════════════════════════════════════
// The association radios' real click targets. CONFIRMED live 2026-08-03:
//
//   <div data-testid="radio-button-unitId" class="...cursor-pointer">
//     <div><svg role="radiobutton" name="The physical unit">...</svg></div>
//     <label>The physical unit</label>
//   </div>
//
//   ⚠️  The <svg> is DECORATION. It carries no click handler at all; the
//   wrapper div is what updates the form state. Clicking the SVG looked like it
//   worked (no error, and clickResilient reported success) while the form stayed
//   unselected — the document then posted with no association and BuildingLink
//   rejected it 400 "A document association is required."
const ASSOCIATION_WRAPPER_SELECTORS = {
  unit:      '[data-testid="radio-button-unitId"]',
  occupancy: '[data-testid="radio-button-occupancyId"]',
  specific:  '[data-testid="radio-button-userId"]',
};

// Everything that could indicate a radio's selected state. aria-checked is the
// proper signal, but these controls do not always carry it — so the element's
// own rendering is captured too: the component redraws the SVG (fill, path,
// class) when it becomes selected, and that change is evidence the click landed.
// Works whether `loc` is the wrapper div or the inner SVG.
async function radioSnapshot(loc) {
  return await loc.evaluate(el => {
    const inner = el.matches('[role="radiobutton"], [role="radio"]')
      ? el : el.querySelector('[role="radiobutton"], [role="radio"]');
    const box = el.closest('label, div');
    const input = el.querySelector('input[type="radio"]') ||
                  (box && box.querySelector('input[type="radio"]'));
    const target = inner || el;
    return {
      aria: target.getAttribute('aria-checked'),
      dataChecked: target.getAttribute('data-checked') || target.getAttribute('data-state'),
      cls: el.getAttribute('class') || '',
      innerCls: inner ? (inner.getAttribute('class') || '') : '',
      html: (el.innerHTML || '').slice(0, 600),
      nativeChecked: input ? !!input.checked : null,
    };
  }).catch(() => ({ aria: null, dataChecked: null, cls: '', innerCls: '', html: '', nativeChecked: null }));
}

// Did the click actually select it? Any positive signal counts; failing that, a
// change in how the control renders means the component reacted.
function radioTookEffect(before, after) {
  if (after.aria === 'true' || after.nativeChecked === true) return true;
  if (/\b(checked|selected|is-checked|is-selected)\b/i.test(after.dataChecked || '')) return true;
  if (after.aria === 'false' || after.nativeChecked === false) return false;  // definitely not selected
  // It redrew → the component reacted.
  return after.html !== before.html || after.cls !== before.cls || after.innerCls !== before.innerCls;
}

// Wait for the control to actually redraw before judging whether the click took.
//
// ⚠️ Reading the DOM in the same tick as the click is a RACE, and it was losing.
// Vue re-renders on nextTick, so the snapshot taken immediately after the click
// almost always still showed the PRE-click markup — radioTookEffect saw "no
// change" and reported failure for a click that had in fact worked. Measured in
// the 2026-08-12 diagnostics: CLICK STRATEGY was "js" on ALL SEVEN saves,
// including the six that saved perfectly, i.e. every single file was falling
// through to the synthetic retry and the "verified click" safeguard this project
// depends on was reporting nothing useful.
//
// Polling for the redraw makes the verification mean something again and spares
// the control a redundant second click. The cap is small — a component that has
// not reacted within it has genuinely not reacted.
async function waitForRadioEffect(loc, before, timeout = RADIO_EFFECT_TIMEOUT) {
  const deadline = Date.now() + timeout;
  let after = await radioSnapshot(loc);
  while (!radioTookEffect(before, after) && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 100));
    after = await radioSnapshot(loc);
  }
  return after;
}

// Click an association target and confirm the selection registered, retrying
// once with a synthetic dispatch if the real click did not take.
async function clickAssociationTarget(loc, label) {
  const before = await radioSnapshot(loc);
  let how = await clickResilient(loc, label);
  let after = await waitForRadioEffect(loc, before);
  if (!radioTookEffect(before, after)) {
    log(`         (${label} did not register via "${how}" — retrying with a synthetic dispatch)`);
    how = await clickResilient(loc, `${label} (retry)`, { preferJs: true });
    after = await waitForRadioEffect(loc, before);
  }
  return { how, took: radioTookEffect(before, after), aria: after.aria };
}

// ── The single-option dialog that cannot be selected ──────────────────────────
// Observed live 2026-08-12 on a correspondence upload:
// the Add Document dialog offered ONLY "The physical unit", drawn as already
// selected — the pre-save screenshot shows a filled radio — and BuildingLink
// still answered the save with 400 "A document association is required."
//
// This is the inert-dialog state described at reloadUnitDocumentsView: the radio
// is PAINTED selected but the component's association model was never
// initialised, so there is nothing for a click to change. A click on an
// already-selected radio is a no-op, which is why clicking it harder never fixed
// it. The page reload AND the reopen safeguard both ran on this file and both
// still produced exactly one option.
//
// Every other file in that same run rendered all three options and saved
// normally through this identical code path, so the trigger is the degenerate
// dialog — not the association code and not the calling handler.
function assocOptionsAreDegenerate(opts) {
  return Array.isArray(opts) && opts.length === 1 && opts[0] === 'radio-button-unitId';
}

function associationDialogIsDegenerate() {
  return assocOptionsAreDegenerate(pendingUpload && pendingUpload.assocOptions);
}

// Last-ditch attempt to make an unconfirmed selection register: a REAL trusted
// click — the kind that works on these SVG controls — on the label, then the
// SVG, then the wrapper, re-verifying after each. Deliberately reached ONLY for
// the degenerate dialog above, so the normal path keeps its existing click
// behaviour untouched.
async function retryAssociationClick(page, frame, wrapperSel, r) {
  for (const sel of [`${wrapperSel} label`, `${wrapperSel} svg[role="radiobutton"]`, wrapperSel]) {
    const el = frame.locator(sel).first();
    if (await el.count() === 0) continue;
    const before = await radioSnapshot(el);
    await suppressOverlays(page);
    let clicked = true;
    try { await el.click({ timeout: 4000 }); }
    catch { clicked = false; }
    finally { await restoreOverlays(page); }
    if (!clicked) continue;
    const after = await waitForRadioEffect(el, before);
    if (radioTookEffect(before, after)) {
      log(`         ✓ Association registered after a real click on ${sel}.`);
      return { how: 'real-retry', took: true, aria: after.aria };
    }
  }
  return r;
}

async function fillAssociation(page, formCtx, mode) {
  const svgSelector = mode === 'specific'  ? 'svg[role="radiobutton"][aria-describedby="Only specific occupants-description"]'
                    : mode === 'occupancy' ? 'svg[role="radiobutton"][aria-describedby*="occupancy-description"]'
                    :                        'svg[role="radiobutton"][aria-describedby="The physical unit-description"]';
  const radioValue  = mode === 'specific'  ? 'RdoAssignUser'
                    : mode === 'occupancy' ? 'RdoAssignUnit'
                    :                        'RdoPhysicalUnitBin';
  const label       = mode === 'specific'  ? 'Only specific occupant(s)'
                    : mode === 'occupancy' ? 'Occupancy'
                    :                        'Physical Unit';

  const wrapperSel = ASSOCIATION_WRAPPER_SELECTORS[mode] || ASSOCIATION_WRAPPER_SELECTORS.unit;

  // Report the outcome consistently however the control was reached.
  const finish = (r, via) => {
    if (pendingUpload) {
      pendingUpload.association =
        `${label} (mode=${mode}, via=${via}, click=${r.how}, selected=${r.took ? 'yes' : 'UNCONFIRMED'})`;
    }
    if (!r.took) {
      log(`  ⚠️  Could not confirm the "${label}" association was selected (aria-checked=${r.aria}, via ${via}). ` +
          `If BuildingLink rejects the save, this is why.`);
    }
    log(`         Association: ${label}${r.took ? '' : ' (UNCONFIRMED)'}`);
  };

  // The control may live in any frame — scan all of them.
  for (const frame of page.frames()) {
    // 1. The wrapper div: the element that actually carries the click handler.
    const wrapper = frame.locator(wrapperSel).first();
    if (await wrapper.count() > 0) {
      let r = await clickAssociationTarget(wrapper, `association "${label}"`);
      // Only the known-degenerate dialog gets the extra real-click recovery and
      // the hard stop — a normal dialog whose selection merely could not be
      // CONFIRMED keeps behaving exactly as before (warn, carry on, let the
      // post-save verification be the judge).
      if (!r.took && associationDialogIsDegenerate()) {
        r = await retryAssociationClick(page, frame, wrapperSel, r);
        if (!r.took) {
          finish(r, wrapperSel);
          // Stop HERE, before the PDF is attached and saved. The save is going
          // to be refused, so spending the upload on it only turns a clear
          // failure into a confusing one 20s later.
          throw new Error(
            `BuildingLink offered only "The physical unit" for this unit and that option would not register. ` +
            `The dialog was built without its occupancy data, so the radio is drawn as selected but is inert — ` +
            `saving would be rejected with "A document association is required". ` +
            `Stopped before uploading; the file was left in the source folder. ` +
            `Upload this one by hand, or re-run it once the unit's occupancy shows up in BuildingLink.`);
        }
      }
      finish(r, wrapperSel);
      return;
    }

    // 2. Fallback: the inner SVG. Kept only in case the testid is renamed —
    //    on the current UI this is decoration and clicking it does nothing, so
    //    say plainly that we are on the unreliable path.
    const svg = frame.locator(svgSelector).first();
    if (await svg.count() > 0) {
      log(`         ⚠️  ${wrapperSel} not found — falling back to the SVG, which may not register the selection.`);
      finish(await clickAssociationTarget(svg, `association radio "${label}" (SVG fallback)`), 'svg');
      return;
    }
    const radio = frame.locator(`input[type="radio"][value="${radioValue}"]`).first();
    if (await radio.count() > 0) {
      await clickResilient(radio, `association radio "${label}" (legacy)`);
      log(`         Association: ${label}`);
      return;
    }
  }

  log(`  ⚠️  Association radio (${label}) not found — verify manually`);
}

// ═══════════════════════════════════════════════════════════════
// OCCUPANT LIST — shared collection used by all three occupant selectors
// (by-role, by-initials, move-in). Returns [{ cb, name, isRenter }].
//
// Occupant checkbox selectors. NEW UI: each occupant is an SVG checkbox
//   <svg role="checkbox" name="Jane Doe" aria-describedby="Jane Doe-description">
// — the occupant's NAME is read from the "name" attribute (reliable; no row-text
// parsing needed). LEGACY UI: Telerik RadGrid rows with <input id="...CbOccupant">
// and a red "Renter" span — kept as fallbacks.
//   ⚠️  If occupant selection ever misbehaves again, this one helper is the only
//   place that needs to change.
const OCCUPANT_CHECKBOX_SELECTORS = [
  'svg[role="checkbox"]',                       // new UI — name in the "name" attr
  'input[id*="CbOccupant"]',                    // legacy Telerik grid
  '[data-testid*="occupant"] [role="checkbox"]',// new UI (extra fallback)
  '[data-testid*="checkbox"]',                  // new UI (extra fallback)
];

// Is this occupant control already checked? Clicking an SVG checkbox TOGGLES it,
// so we must know its state before clicking (unlike a native input, where
// .check() is idempotent). role="checkbox" elements expose aria-checked per the
// ARIA spec; we also accept common data-*/class "checked" markers as a fallback.
// Returns true / false, or null when the state can't be determined.
async function occupantCheckedState(cb) {
  return await cb.evaluate(el => {
    const aria = el.getAttribute('aria-checked');
    if (aria === 'true')  return true;
    if (aria === 'false') return false;
    const ds = el.getAttribute('data-checked') || el.getAttribute('data-state') ||
               el.getAttribute('data-selected') || '';
    if (/\b(true|checked|selected|on)\b/i.test(ds))    return true;
    if (/\b(false|unchecked|unselected|off)\b/i.test(ds)) return false;
    const cls = el.getAttribute('class') || '';
    if (/\b(checked|selected|is-checked|is-selected)\b/i.test(cls)) return true;
    return null; // unknown
  }).catch(() => null);
}

// Check an occupant control (idempotent — never leaves it unchecked).
// Native <input> → .check() (idempotent by itself). SVG/custom role=checkbox →
// click only when not already checked; then verify, and re-click if the click
// toggled an already-checked box off, so the occupant always ends up selected.
async function checkOccupant(cb) {
  const tag = await cb.evaluate(el => el.tagName.toLowerCase()).catch(() => '');
  if (tag === 'input') {
    try { await cb.check(); return; } catch {}
  }
  if ((await occupantCheckedState(cb)) === true) return; // already selected
  await clickResilient(cb, 'occupant checkbox');
  // If it now reads unchecked, the click toggled an already-selected box off
  // (state was mis-read as not-checked) — click once more to leave it selected.
  if ((await occupantCheckedState(cb)) === false) {
    await clickResilient(cb, 'occupant checkbox (re-check)');
  }
}

// Collect every occupant row across frames (the list may live in its own frame).
async function collectOccupantCandidates(page) {
  const sel = OCCUPANT_CHECKBOX_SELECTORS.join(', ');
  // Wait for the list to render (appears after the association radio click)
  // instead of a blind sleep — returns as soon as the first row is present.
  try {
    await findAcrossFrames(page, OCCUPANT_CHECKBOX_SELECTORS, 8000);
  } catch {
    // Nothing appeared in 8s — the unit genuinely may have no occupants. One
    // short last beat before reading an empty list (the 8s poll above has
    // already given a slow page every chance).
    await waitInterruptible(page, 800);
  }

  const candidates = []; // { cb, name, isRenter }
  for (const frame of page.frames()) {
    const all = await frame.locator(sel).all();
    if (all.length === 0) continue;

    // ── Dedupe pass 1: nested controls ────────────────────────────
    // The selector list is broad on purpose (new SVG + legacy input + two loose
    // fallbacks). ONE occupant can therefore match TWICE — measured: a wrapper
    // <div data-testid="...checkbox"> around the real <svg role="checkbox">
    // yields 4 candidates for 2 occupants. Both are genuine elements, so a CSS
    // list returns both; clicking both TOGGLES the occupant on and back off.
    // (Note the legacy `input[id*="CbOccupant"]` selector is NOT the cause — a
    // CSS selector list never returns the same element twice, so it can stay
    // for units still on the old interface.)
    // Keep the innermost control: drop any element that contains another match.
    const handles = [];
    for (const cb of all) handles.push(await cb.elementHandle().catch(() => null));
    let keep = all.map(() => true);
    try {
      keep = await frame.evaluate(
        els => els.map((el, i) =>
          !(el && els.some((other, j) => j !== i && other && el !== other && el.contains(other)))),
        handles,
      );
    } catch {}

    const checkboxes = all.filter((_, i) => keep[i]);
    if (checkboxes.length < all.length) {
      log(`         (${all.length - checkboxes.length} wrapper element(s) dropped — kept the inner checkbox controls)`);
    }

    for (const cb of checkboxes) {
      // Read name + renter in one pass on the element itself. The renter check
      // MUST be scoped to the occupant's own row, not a shared ancestor (the
      // list container holds every occupant's spans, so an ancestor-wide search
      // would mark everyone a renter). The row is the largest ancestor that
      // still contains only THIS checkbox; we look for the red "Renter" span
      // inside it. Works for the new SVG list and the legacy Telerik grid alike.
      const info = await cb.evaluate(el => {
        // Name: the checkbox's own "name" attr (new UI), then aria-describedby.
        let name = el.getAttribute('name');
        if (!name) {
          const d = el.getAttribute('aria-describedby');
          if (d) name = d.replace(/-description$/i, '');
        }
        // Walk up to the row boundary: stop at the first ancestor that holds
        // more than one occupant checkbox (that's the list, not the row).
        let node = el.parentElement, row = el;
        while (node) {
          const boxes = node.querySelectorAll('[role="checkbox"], input[id*="CbOccupant"]');
          if (boxes.length > 1) break;
          row = node;
          node = node.parentElement;
        }
        // Renter iff the row has a red "Renter" span.
        let isRenter = false;
        for (const s of row.querySelectorAll('span')) {
          if (/color:\s*red/i.test(s.getAttribute('style') || '') && /renter/i.test(s.textContent || '')) {
            isRenter = true; break;
          }
        }
        const rowText = (row.textContent || '').replace(/\s+/g, ' ').trim();
        if (!name) name = rowText;                                   // legacy name fallback
        if (!isRenter && /\b(renter|tenant)\b/i.test(rowText)) isRenter = true;
        return { name: (name || '').replace(/\s+/g, ' ').trim(), isRenter };
      }).catch(() => ({ name: '', isRenter: false }));

      // The Unit Overview role map (read in openAddDocForm) is authoritative:
      // RENTER → tenant, OWNER/SPOUSE/OTHER OCCUPANT → owner side. It only
      // yields when the name matches unambiguously; otherwise the legacy red
      // "Renter" span result above stands.
      const mapped = lookupOccupantRole(info.name);
      if (!mapped && unitRoleMap.size > 0) {
        log(`         ⚠️  "${info.name || '[row]'}" not matched in the ${unitRoleMapUnit} Unit Overview roles — using in-form detection (${info.isRenter ? 'Renter' : 'Owner'}).`);
      }

      candidates.push({
        cb,
        name:     info.name,
        isRenter: mapped ? mapped.isTenant : info.isRenter,
        role:     mapped ? mapped.role : null,           // real badge text when known
      });
    }
    break; // list found in this frame — don't scan further frames
  }

  // ── Dedupe pass 2: same person, two unrelated elements ──────────
  // Pass 1 only catches nesting. If a person is somehow matched by two
  // sibling elements, keep the first — selecting the same occupant twice
  // toggles them back off.
  const seen = new Set();
  const unique = [];
  for (const c of candidates) {
    const key = occupantNameKey(c.name);
    if (key && seen.has(key)) {
      log(`         (duplicate control for "${c.name}" ignored)`);
      continue;
    }
    if (key) seen.add(key);
    unique.push(c);
  }
  return unique;
}

// ═══════════════════════════════════════════════════════════════
// FORM FIELD: Occupant checkboxes (pool pass — after selecting "specific")
// role = 'owner'  → check occupants that are NOT tenants
// role = 'renter' → check occupants that ARE tenants
// ═══════════════════════════════════════════════════════════════
async function selectOccupantsByRole(page, formCtx, role) {
  const candidates = await collectOccupantCandidates(page);
  const selectedNames = []; // names of the occupants actually checked (for the log)

  for (const c of candidates) {
    const shouldCheck = role === 'renter' ? c.isRenter : !c.isRenter;
    if (!shouldCheck) continue;
    let name = c.name;
    if (name.length > 60) name = name.slice(0, 60) + '…';
    await checkOccupant(c.cb);
    log(`         ✓ Selected (${roleLabelOf(c)}): ${name || '[row]'}`);
    selectedNames.push(name || '[row]');
  }

  if (candidates.length === 0) {
    log(`  ⚠️  No occupant checkboxes found — verify manually in the browser`);
  } else if (selectedNames.length === 0) {
    log(`  ⚠️  Found ${candidates.length} occupant(s) but none matched role "${role}" — verify manually`);
  }
  return selectedNames;
}

// ═══════════════════════════════════════════════════════════════
// OCCUPANT NAME MATCHING (vehicle parking permit)
// True when the occupant's first name starts with initials[0] AND the final
// word of their last name starts with initials[1].
//   "Yasmin Abu-El-Hawa" + "YH" → first "Yasmin"(Y), last-last "Hawa"(H) → true
// Handles "First Last" and "Last, First" display orders. Role words and any
// trailing numeric columns (phone, unit, dates) are stripped before parsing,
// since names never contain digits.
// ═══════════════════════════════════════════════════════════════
function occupantMatchesInitials(name, initials) {
  const first = initials[0].toUpperCase();
  const last  = initials[1].toUpperCase();

  let n = (name || '')
    .replace(/\b(renter|owner|tenant|resident|occupant|primary|secondary)\b/ig, ' ')
    .split(/\d/)[0]              // cut at first digit → drop phone/unit/date columns
    .replace(/[|()\[\]]/g, ' ')  // drop separators/brackets (e.g. leftover "(Renter)")
    .replace(/\s+/g, ' ')
    .trim();
  if (!n) return false;

  let firstName, lastName;
  if (n.includes(',')) {
    const parts = n.split(',');     // "Last, First"
    lastName  = (parts[0] || '').trim();
    firstName = (parts[1] || '').trim();
  } else {
    const tokens = n.split(' ');    // "First ... Last"
    firstName = tokens[0] || '';
    lastName  = tokens[tokens.length - 1] || '';
  }

  // "last last name" → final chunk of a hyphenated/multi-part surname.
  const lastChunks = lastName.split(/[\s-]+/).filter(Boolean);
  const lastWord   = lastChunks[lastChunks.length - 1] || '';

  return firstName.charAt(0).toUpperCase() === first
      && lastWord.charAt(0).toUpperCase()  === last;
}

// ═══════════════════════════════════════════════════════════════
// FORM FIELD: Occupant selection by initials (vehicle parking permit —
// after selecting "Only specific occupant(s)").
// Initials-only matching with the same numbered manual-selection prompt used by
// the move-in / meeting-room forms:
//   - 1 occupant matches the initials      → auto-select
//   - 2+ match (any mix of owners/tenants) → numbered prompt, wait for input
//   - none match                           → no-match prompt (pick one / occupancy / skip)
// Returns { isRenter, names } for folder routing + the run log.
// (Also throws if the operator skips a prompt.)
// ═══════════════════════════════════════════════════════════════
async function selectOccupantByInitials(page, formCtx, initials, unit) {
  const first = initials[0].toUpperCase();
  const last  = initials[1].toUpperCase();

  // Collect every occupant row across frames (see collectOccupantCandidates).
  const candidates = await collectOccupantCandidates(page);
  if (candidates.length === 0) {
    throw new Error('No occupant checkboxes found — cannot match initials; verify manually.');
  }

  // Match on both initials.
  const matches = candidates.filter(c => occupantMatchesInitials(c.name, initials));

  if (matches.length === 0) {
    // No initials match → ask the operator (pick one / occupancy / skip) instead
    // of throwing. "Occupancy" switches the association and routes to the owner
    // folder (the safe default, since no specific occupant role is known).
    const res = await promptNoInitialsMatch(candidates, initials, unit);
    if (res.kind === 'occupancy') {
      await fillAssociation(page, formCtx, 'occupancy');
      return { isRenter: false, names: [] };
    }
    await checkOccupant(res.candidate.cb);
    log(`         ✓ Selected (${roleLabelOf(res.candidate)}): ${res.candidate.name || '[row]'}`);
    return { isRenter: res.candidate.isRenter, names: [res.candidate.name || '[row]'] };
  }

  // One match → take them; 2+ sharing the initials (any mix of owners/tenants)
  // → numbered selection prompt, same manual-pick behavior as the move-in /
  // meeting-room forms.
  const chosen = matches.length === 1 ? matches : await promptOccupantSelection(matches, initials);

  for (const c of chosen) {
    await checkOccupant(c.cb);
    log(`         ✓ Selected (${roleLabelOf(c)}): ${c.name || '[row]'}`);
  }
  // Chosen rows may span roles only if the operator hand-picked a mix; every()
  // routes a uniform set to its folder (mixed → owner path, the safe default).
  return { isRenter: chosen.every(c => c.isRenter), names: chosen.map(c => c.name || '[row]') };
}

// Show a numbered list of same-role occupants who share the initials and wait
// for the operator to choose. Accepts a single number, comma/space-separated
// numbers (e.g. "1,3"), "all", or "s" to skip (throws, routing the file to the
// error/pause path). Loops until the input is valid. Returns the chosen subset.
async function promptOccupantSelection(pool, initials) {
  const spec = {
    kind: 'select',
    multi: true,
    allowAll: true,
    allowSkip: true,
    title: `${pool.length} occupants share initials "${initials}" — manual selection needed`,
    message: 'Select which occupant(s) this document belongs to.',
    options: pool.map((c, i) => ({
      value: String(i + 1),
      label: c.name || '[row]',
      description: roleLabelOf(c),
    })),
  };
  while (true) {
    const ans = (await askChoice(spec)).trim().toLowerCase();
    if (ans === 's' || ans === 'skip') {
      throw new Error(`Selection skipped by operator for initials "${initials}" — file left in place.`);
    }
    if (ans === 'all' || ans === 'a') return pool.slice();
    const nums = ans.split(/[ ,]+/).filter(Boolean).map(x => parseInt(x, 10));
    if (nums.length && nums.every(n => Number.isInteger(n) && n >= 1 && n <= pool.length)) {
      return [...new Set(nums)].map(n => pool[n - 1]);
    }
    log(`  ✗ Invalid input "${ans}" — enter list item number(s) 1–${pool.length}, "all", or "s".`);
  }
}

// Shown when NO occupant matches the filename initials (instead of throwing).
// Lists every occupant in the unit and lets the operator: pick one by number,
// associate with the occupancy instead ("A"), or skip the file ("X" → throws,
// file left in place). Loops until the input is valid. Returns the operator's
// decision; the caller acts on it (checks the box / switches association):
//   { kind: 'occupant', candidate }  — operator picked a numbered occupant
//   { kind: 'occupancy' }            — operator chose occupancy association
async function promptNoInitialsMatch(candidates, initials, unit) {
  const spec = {
    kind: 'choice',
    title: `No occupant matches initials "${initials}"`,
    unit,
    message: 'Pick the correct occupant, associate with the occupancy, or skip.',
    options: [
      ...candidates.map((c, i) => ({
        value: String(i + 1),
        label: c.name || '[row]',
        description: roleLabelOf(c),
      })),
      { value: 'a', label: 'Associate with the Occupancy Instead', description: 'File under the unit owner via the occupancy association — no specific occupant is selected.' },
      { value: 'x', label: 'Skip — Handle Manually', description: 'Leave the file in place. Nothing is uploaded or moved.' },
    ],
  };
  while (true) {
    const ans = (await askChoice(spec)).trim().toLowerCase();
    if (ans === 'x' || ans === 'skip') {
      throw new Error(`No occupant matched initials "${initials}" in unit ${unit} — skipped by operator, file left in place.`);
    }
    if (ans === 'a') {
      log(`         ▶ Operator chose: associate with occupancy instead`);
      return { kind: 'occupancy' };
    }
    const n = parseInt(ans, 10);
    if (/^\d+$/.test(ans) && Number.isInteger(n) && n >= 1 && n <= candidates.length) {
      const c = candidates[n - 1];
      log(`         ▶ Operator chose: #${n} ${c.name || '[row]'} (${roleLabelOf(c)})`);
      return { kind: 'occupant', candidate: c };
    }
    log(`  ✗ Invalid input "${ans}" — choose a listed occupant, "A", or "X".`);
  }
}

// ═══════════════════════════════════════════════════════════════
// FORM FIELD: Occupant selection for Move In / Move Out forms (after
// selecting "Only specific occupant(s)"). Matches occupants by initials only
// — there is no O/T flag in these filenames. Selection rules:
//   - exactly 1 match            → select that occupant automatically
//   - mix of owner + tenant      → the owner stays; consider the TENANT(s) only
//   - then, if the considered set has 2+ people sharing the initials (whether
//     all tenants or all owners) → show a numbered prompt and let the operator
//     pick which to select (same behavior across all three variations)
//   - no match                   → no-match prompt (pick one / occupancy / skip)
// Returns { isRenter } for folder routing (true → tenant, false → owner).
// May select multiple checkboxes.
// ═══════════════════════════════════════════════════════════════
async function selectOccupantsMoveIn(page, formCtx, initials, unit) {
  // Collect every occupant row across frames (see collectOccupantCandidates).
  const candidates = await collectOccupantCandidates(page);
  if (candidates.length === 0) {
    throw new Error('No occupant checkboxes found — cannot match initials; verify manually.');
  }

  const matches = candidates.filter(c => occupantMatchesInitials(c.name, initials));

  if (matches.length === 0) {
    // No initials match → ask the operator (pick one / occupancy / skip) instead
    // of throwing. "Occupancy" switches the association and routes to the owner
    // folder (the safe default, since no specific occupant role is known).
    const res = await promptNoInitialsMatch(candidates, initials, unit);
    if (res.kind === 'occupancy') {
      await fillAssociation(page, formCtx, 'occupancy');
      return { isRenter: false, names: [] };
    }
    await checkOccupant(res.candidate.cb);
    log(`         ✓ Selected (${roleLabelOf(res.candidate)}): ${res.candidate.name || '[row]'}`);
    return { isRenter: res.candidate.isRenter, names: [res.candidate.name || '[row]'] };
  }

  let chosen;
  if (matches.length === 1) {
    chosen = matches;
  } else {
    const owners  = matches.filter(c => !c.isRenter);
    const renters = matches.filter(c => c.isRenter);

    // Mixed owner + tenant share the initials → the tenant is the one moving;
    // the owner stays. Narrow to tenants. Otherwise the matches are all one role.
    let pool;
    if (owners.length && renters.length) {
      log(`         (initials "${initials}" matched ${owners.length} owner + ${renters.length} tenant — owner stays, considering tenant(s))`);
      pool = renters;
    } else {
      pool = matches;
    }

    // One person left → take them; 2+ sharing the initials → numbered prompt.
    chosen = pool.length === 1 ? pool : await promptOccupantSelection(pool, initials);
  }

  for (const c of chosen) {
    await checkOccupant(c.cb);
    log(`         ✓ Selected (${roleLabelOf(c)}): ${c.name || '[row]'}`);
  }
  // All chosen rows share the same role (single match, all-tenants, all-owners,
  // or tenant-from-mix), so every() gives the role for folder routing.
  return { isRenter: chosen.every(c => c.isRenter), names: chosen.map(c => c.name || '[row]') };
}

// Does what the date field currently reads match the date we meant to enter?
// The field renders mm/dd/yy, so a 2-digit year is expanded to 20xx before
// comparing; "6/04/20" (the truncation bug) correctly fails against 2026.
function dateFieldMatches(value, mm, dd, yyyy) {
  const m = String(value || '').match(/(\d{1,2})\D+(\d{1,2})\D+(\d{2,4})/);
  if (!m) return false;
  const [, vm, vd, vy] = m;
  if (vy.length === 3) return false;               // half-typed year — not committed yet
  const vyyyy = vy.length === 4 ? vy : `20${vy}`;
  return Number(vm) === Number(mm) && Number(vd) === Number(dd) && vyyyy === yyyy;
}

// Empty the date input before typing. The masked field ignores some clearing
// methods, so try select-all + Delete, then fill(''), then Backspace one key at
// a time. Returns true when the field ends up empty.
async function clearDateField(dp) {
  const valueOf = async () => ((await dp.inputValue().catch(() => '')) || '').trim();

  // A freshly opened form has an empty date box — the overwhelmingly common
  // case. Checking first costs one read and skips four round-trips of clearing
  // something that is already clear.
  if (await valueOf() === '') return true;

  // Triple click selects the value. An explicit short timeout matters here: this
  // field lives inside the dialog, and if the backdrop ever covers it Playwright
  // would retry actionability for its full 30s DEFAULT before the .catch() below
  // ever ran — a half-minute stall per file, hidden behind a swallowed error.
  // The keyboard fallbacks underneath do the job without a click.
  await dp.click({ clickCount: 3, timeout: 2000 }).catch(() => {});
  await dp.press('ControlOrMeta+a').catch(() => {});
  await dp.press('Delete').catch(() => {});
  let v = await valueOf();

  if (v) {
    try { await dp.fill(''); } catch {}
    v = await valueOf();
  }
  for (let i = 0; v && i < 12; i++) {
    await dp.press('Backspace').catch(() => {});
    v = await valueOf();
  }
  return v === '';
}

// ═══════════════════════════════════════════════════════════════
// FORM FIELD: Date
// New UI: a masked text input (placeholder "mm/dd/yy") identified by
// data-testid. It auto-formats while you type, so a bulk fill() of
// "06/04/2026" landed as "6/04/20" — the year got truncated. Type it one
// character at a time, read the value back, and retry with other formats until
// the field actually reads the date we meant. Legacy UI: a Telerik
// RadDatePicker (JS API, then visible input, then the hidden backing input) —
// kept as a fallback.
// ═══════════════════════════════════════════════════════════════
async function fillDate(formCtx, docDate) {
  // docDate normally arrives as MM/DD/YYYY (the filename parsers already expand
  // a 2-digit year), but accept MM/DD/YY too so a caller passing "06/04/26"
  // behaves identically to "06/04/2026".
  const [mm, dd, rawYear = ''] = String(docDate).split('/');
  const yyyy = rawYear.length === 2 ? `20${rawYear}` : rawYear;
  const yy   = yyyy.slice(-2);   // LAST two digits — 2026 → 26, never "20"

  // ── New UI: data-testid date input ──────────────────────────────
  const dp = formCtx.locator('[data-testid="datepicker-input"]').first();
  if (await dp.count() > 0) {
    await dp.scrollIntoViewIfNeeded().catch(() => {});

    // 2-digit year first (that is what the placeholder asks for); then digits
    // only, in case the mask inserts its own separators; then the 4-digit forms.
    const attempts = [
      `${mm}/${dd}/${yy}`,
      `${mm}${dd}${yy}`,
      `${mm}/${dd}/${yyyy}`,
      `${mm}${dd}${yyyy}`,
    ];

    let seen = '';
    for (const [attemptNo, text] of attempts.entries()) {
      await clearDateField(dp);
      // Type fast on the first try, and fall back to the original deliberate
      // pace on any retry. The field's value is read back and verified below,
      // so typing too fast can only ever cost a retry — never a wrong date —
      // while the fast path saves ~0.3s on the files that just work.
      const delay = attemptNo === 0 ? 55 : 90;   // ms per character
      await dp.pressSequentially(text, { delay });

      seen = ((await dp.inputValue().catch(() => '')) || '').trim();
      if (!dateFieldMatches(seen, mm, dd, yyyy)) {
        log(`         ⚠ Date field read "${seen}" after typing "${text}" — retrying`);
        continue;
      }

      await dp.press('Tab').catch(() => {});           // commit / blur
      // Blur can reformat one more time — confirm what actually stuck.
      const committed = ((await dp.inputValue().catch(() => '')) || '').trim();
      if (!dateFieldMatches(committed, mm, dd, yyyy)) {
        seen = committed;
        log(`         ⚠ Date field reformatted to "${committed}" on blur — retrying`);
        continue;
      }

      if (pendingUpload) pendingUpload.date = `${docDate} (field read back "${committed}")`;
      log(`         Date: ${docDate} (field shows "${committed}")`);
      return;
    }

    throw new Error(
      `Date field would not accept ${docDate} — it reads "${seen}" after ${attempts.length} attempts. ` +
      `Enter the date manually and verify before saving.`,
    );
  }

  // ── Legacy UI: Telerik RadDatePicker ────────────────────────────
  // Try Telerik JS API first ($find)
  const set = await formCtx.evaluate(([m, d, y]) => {
    try {
      const el = document.querySelector('[id*="RadDocumentDate"]');
      if (!el) return false;
      const ctrlId = el.id.replace(/_(?:dateInput|text).*/, '');
      const picker = typeof $find !== 'undefined' ? $find(ctrlId) : null;
      if (picker && picker.set_selectedDate) {
        picker.set_selectedDate(new Date(parseInt(y), parseInt(m) - 1, parseInt(d)));
        return true;
      }
    } catch {}
    return false;
  }, [mm, dd, yyyy]);

  if (!set) {
    // Fallback: type into the visible input (excludes the hidden backing element)
    const visible = formCtx.locator(
      'input[id*="RadDocumentDate"]:not(.rdfd_):not([title*="hidden" i]), ' +
      'input[id*="RadDocumentDate_dateInput"]:not(.rdfd_)',
    ).first();
    if (await visible.count() > 0) {
      await visible.click({ clickCount: 3 });
      await visible.fill(`${mm}/${dd}/${yyyy}`);
      await visible.press('Tab');
    } else {
      // Last resort: force-set the hidden backing input via JS
      await formCtx.evaluate(([m, d, y]) => {
        for (const inp of document.querySelectorAll('input[type="text"]')) {
          if (inp.id && inp.id.includes('RadDocumentDate')) {
            inp.value = `${m}/${d}/${y}`;
            inp.dispatchEvent(new Event('change', { bubbles: true }));
            break;
          }
        }
      }, [mm, dd, yyyy]);
    }
  }
  log(`         Date: ${docDate}`);
}

// ═══════════════════════════════════════════════════════════════
// FORM FIELD: Attach file
// Prefer a direct <input type="file"> (works even when hidden — no OS dialog).
// New UI: an "Add file" button ([data-testid="button-text"]) that either opens
// a native file chooser or reveals the hidden input — handle both.
// ═══════════════════════════════════════════════════════════════
// Settle time after handing the PDF to the form, before Save may be clicked.
//
//   ⚠️  RESTORED to a FIXED wait on 2026-07-31 after a regression. Polling for
//   the filename to appear and returning early looked safe, but the page can
//   render the name long before it has finished reading the bytes — Save then
//   fired against a half-attached file and 25 documents never landed in
//   BuildingLink while the PDFs were happily filed away. This is the one place
//   where "return as soon as it looks ready" is not good enough: the evidence
//   we can see does not prove the thing we need.
const ATTACH_SETTLE_WAIT = 1200;

// Extra grace, only used when the page has NOT acknowledged the file by the
// time ATTACH_SETTLE_WAIT is up.
const ATTACH_EXTRA_WAIT  = 800;

// Wait for the page to acknowledge the file (its name appearing in the dialog).
// Used as CONFIRMATION on top of the fixed settle above — never as a substitute.
async function waitForFileAccepted(page, formCtx, filePath, cap = 1200) {
  const base = path.basename(filePath);
  const deadline = Date.now() + cap;
  let wait = 80;
  // Always check at least once, so a cap of 0 means "check now, don't wait".
  for (;;) {
    const shown = await formCtx.evaluate(
      name => document.body && document.body.innerText.includes(name), base,
    ).catch(() => false);
    if (shown) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(Math.min(wait, Math.max(0, deadline - Date.now())));
    wait = Math.min(250, Math.round(wait * 1.5));
  }
}

// Hard cap on waiting for the upload to finish. Generous on purpose: a large
// PDF over a slow link is exactly the case this exists for, and the cost of
// waiting too long is a slow file, while the cost of not waiting long enough is
// a document that silently never exists.
const ATTACH_UPLOAD_MAX_WAIT = 45000;
// The page must ask for nothing new for this long before the network counts as
// idle — a single quiet moment mid-upload is not "finished".
const ATTACH_QUIET_MS = 700;
// The UI checks below are advisory (they depend on class names we have not
// confirmed), so they get their own smaller budget and never block the run.
const ATTACH_UI_MAX_WAIT = 10000;

// Is the dialog still visibly working on the upload?
async function attachmentUiBusy(formCtx) {
  return await formCtx.evaluate(() => {
    const sel = '[role="progressbar"],progress,[aria-busy="true"],' +
                '[class*="progress" i],[class*="uploading" i],[class*="spinner" i]';
    const visible = Array.from(document.querySelectorAll(sel)).filter(el => {
      const cs = getComputedStyle(el);
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    });
    const saveBtn = document.querySelector('[data-testid="dialog-primary-action"]');
    return {
      busyNodes: visible.length,
      saveDisabled: saveBtn ? !!(saveBtn.disabled || saveBtn.getAttribute('aria-disabled') === 'true') : false,
    };
  }).catch(() => ({ busyNodes: 0, saveDisabled: false }));
}

// Wait for the attachment to be COMPLETELY handled before Save may be clicked.
//
//   ⚠️  The filename appearing on screen does NOT mean the file has been
//   uploaded — the page renders the name the moment the input changes, long
//   before the bytes are on BuildingLink's server. Saving in that window posts a
//   document with no attachment behind it, which is how documents came back
//   "saved" and then did not exist.
//
// The authoritative signal is the NETWORK: BuildingLink fires a request when a
// file is selected, and the upload is only done when that request has finished
// and nothing new has been asked for since. That works without knowing any of
// their markup. The UI checks (progress bars, a disabled Save button) are a
// secondary confirmation with their own small budget, because they depend on
// class names that have not been confirmed live.
//
// Order: fixed floor → network idle → UI quiet. Never returns before the floor.
// `attachAt` MUST be captured before setInputFiles — BuildingLink fires its
// upload request from the input's change event, so a window starting after that
// call would filter out the very request we need to wait for. (Measured: with
// the window starting here, the upload was invisible and only the advisory UI
// check was holding the run back — which caps out at 10s and would have let a
// slower upload through.)
async function settleAfterAttach(page, formCtx, filePath, attachAt) {
  const started = Date.now();
  const windowFrom = (attachAt || started) - 250;   // slack for event ordering

  // 1. The original fixed floor, kept as-is.
  await page.waitForTimeout(ATTACH_SETTLE_WAIT);

  // 2. Network: wait for every request begun since the file was attached to
  //    finish, then for a quiet period with no new ones.
  const netDeadline = started + ATTACH_UPLOAD_MAX_WAIT;
  let sawUpload = false, uploadUrls = [];
  while (Date.now() < netDeadline) {
    // Ignore anything wedged open (long-polls, SSE) so one never stalls the run.
    const pending = [...netState.inFlight.values()]
      .filter(v => v.t >= windowFrom && Date.now() - v.t < 30000);
    const writes = pending.filter(v => v.method && v.method !== 'GET');
    if (writes.length) {
      sawUpload = true;
      for (const w of writes) if (!uploadUrls.includes(w.url)) uploadUrls.push(w.url);
    }
    const quietFor = Date.now() - Math.max(netState.lastRequestAt, windowFrom);
    if (pending.length === 0 && quietFor >= ATTACH_QUIET_MS) break;
    await page.waitForTimeout(120);
  }
  const netMs = Date.now() - started;
  if (netMs >= ATTACH_UPLOAD_MAX_WAIT) {
    log(`         ⚠️  Upload still had network activity after ${Math.round(ATTACH_UPLOAD_MAX_WAIT / 1000)}s — continuing anyway.`);
  }

  // 3. UI: give a progress indicator / disabled Save button a little longer to
  //    clear, but never let an unconfirmed selector block the run.
  const uiDeadline = Date.now() + ATTACH_UI_MAX_WAIT;
  let ui = await attachmentUiBusy(formCtx);
  while ((ui.busyNodes > 0 || ui.saveDisabled) && Date.now() < uiDeadline) {
    await page.waitForTimeout(150);
    ui = await attachmentUiBusy(formCtx);
  }
  if (ui.busyNodes > 0 || ui.saveDisabled) {
    log(`         ⚠️  Dialog still looks busy after ${Math.round(ATTACH_UI_MAX_WAIT / 1000)}s ` +
        `(indicators=${ui.busyNodes}, saveDisabled=${ui.saveDisabled}) — continuing anyway.`);
  }

  // 4. Confirmation only: has the filename rendered?
  const named = await waitForFileAccepted(page, formCtx, filePath, ATTACH_EXTRA_WAIT);

  log(`         Attachment settled in ${Date.now() - started}ms ` +
      `(upload request${sawUpload ? 's: ' + uploadUrls.map(u => u.replace(/^https?:\/\/[^/]+/, '')).join(', ') : 's: none seen'}; ` +
      `filename shown: ${named})`);
  if (!sawUpload) {
    log(`         ℹ️  No upload request was observed — this form may attach the file only when Save is pressed.`);
  }
}

async function attachFile(page, formCtx, filePath) {
  // Fast path: set a file input directly if one is present.
  const fi = formCtx.locator('input[type="file"]').first();
  if (await fi.count() > 0) {
    const attachAt = Date.now();          // BEFORE the change event fires
    await fi.setInputFiles(filePath);
    await settleAfterAttach(page, formCtx, filePath, attachAt);
    log(`         File: ${path.basename(filePath)}`);
    return;
  }

  // New UI: click the "Add file" button. It may open a native file chooser or
  // reveal a file input — race a filechooser event against the click to cover both.
  const addFileBtn = formCtx.locator(
    'button:has([data-testid="button-text"]:has-text("Add file")), [data-testid="button-text"]:has-text("Add file")'
  ).first();
  if (await addFileBtn.count() === 0) {
    throw new Error('No file input and no "Add file" button found — cannot attach file.');
  }
  const attachAt = Date.now();            // BEFORE the change event fires
  const [chooser] = await Promise.all([
    page.waitForEvent('filechooser', { timeout: 5000 }).catch(() => null),
    addFileBtn.click(),
  ]);
  if (chooser) {
    await chooser.setInputFiles(filePath);
  } else {
    // No dialog — the click likely revealed a hidden input; set it now.
    const revealed = formCtx.locator('input[type="file"]').first();
    if (await revealed.count() === 0) {
      throw new Error('Clicked "Add file" but no file input appeared — cannot attach file.');
    }
    await revealed.setInputFiles(filePath);
  }
  await settleAfterAttach(page, formCtx, filePath, attachAt);
  log(`         File: ${path.basename(filePath)}`);
}

// ═══════════════════════════════════════════════════════════════
// SAVE FORM + POST-SAVE VERIFICATION
//
// A save that "looked fine" is not proof the document reached BuildingLink.
// On 2026-07-31, 25 documents were reported uploaded — and filed away on the S:
// drive — while none of them actually landed. Nothing in the form's own
// behaviour revealed it; only opening BuildingLink did.
//
// So the run no longer trusts the Save click. It reads the unit's document list
// BEFORE opening the form, and after saving it requires that list to contain one
// MORE mention of the document's title than it did before. Only then may the PDF
// be moved off the source drive. If the count does not go up, the handler throws,
// the file stays put, and the operator gets told — which is exactly what should
// have happened instead of 25 silent losses.
// ═══════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════
// SAVE DIAGNOSTICS  (observation only — changes no behaviour)
//
// Records exactly what the page was doing at the moment of Save, so a failing
// save can be explained instead of guessed at:
//   • every field's committed value, read from the DOM immediately before Save
//   • whether the file input REALLY holds the file (name + byte size), not just
//     whether the filename appeared on screen
//   • whether the modal backdrop was blocking, and WHICH click strategy ran
//   • every network request/response around the save, with failure bodies
//   • console errors and uncaught page exceptions
//   • screenshots immediately before and after
// Written to save-diagnostics_MM-DD-YYYY.txt next to the run log.
// ═══════════════════════════════════════════════════════════════
// `pages` is a WeakSet, NOT a boolean.
//
//   ⚠️  A single `attached` flag meant the listeners bound to the FIRST page
//   only. The Electron app calls main() again for every run in the same
//   process, and each run builds a fresh browser + page — so from the second
//   run onwards nothing was tracked, and the attachment wait quietly fell back
//   to its advisory-only path. Caught by the attachment-race harness looping in
//   one process, which is exactly the shape of a repeat run.
const saveDiag = { net: [], console: [], pages: new WeakSet(), pendingBodies: [] };

// request object -> its buffered entry, so a response can be paired with the
// payload that produced it.
const netEntryFor = new WeakMap();

// Turn a raw request body into readable field = value lines. Handles the three
// encodings a form like this can use; anything else is dumped verbatim.
function decodePostBody(contentType, body) {
  if (body == null || body === '') return ['      (no body captured)'];
  const ct = String(contentType || '').toLowerCase();

  if (ct.includes('application/json')) {
    try {
      return JSON.stringify(JSON.parse(body), null, 2).split('\n').map(l => '      ' + l);
    } catch { /* fall through to raw */ }
  }

  if (ct.includes('x-www-form-urlencoded')) {
    return body.split('&').map(kv => {
      const i = kv.indexOf('=');
      const dec = s => { try { return decodeURIComponent(String(s).replace(/\+/g, ' ')); } catch { return s; } };
      const k = dec(i < 0 ? kv : kv.slice(0, i));
      const v = i < 0 ? '' : dec(kv.slice(i + 1));
      return `      ${k} = ${JSON.stringify(v)}`;
    });
  }

  if (ct.includes('multipart/form-data')) {
    //   ⚠️  Read the boundary from the ORIGINAL header, never the lowercased
    //   copy above. Boundaries are case-sensitive and typically mixed case
    //   ("----WebKitFormBoundaryAbC123"); lowercasing makes the split silently
    //   fail, returning the whole body as ONE part — which looked like a
    //   single mystery field rather than an error.
    const m = /boundary=([^;]+)/i.exec(String(contentType || ''));
    if (m) {
      const out = [];
      for (const part of body.split('--' + m[1].trim().replace(/^["']|["']$/g, ''))) {
        // Anchor on the attribute separator so `filename="x"` can never be
        // mistaken for the part's `name`.
        const nameM = /(?:^|[;\s])name="([^"]*)"/.exec(part);
        if (!nameM) continue;
        const fileM = /filename="([^"]*)"/.exec(part);
        const at = part.indexOf('\r\n\r\n');
        const val = at >= 0 ? part.slice(at + 4).replace(/\r\n$/, '') : '';
        out.push(fileM
          ? `      ${nameM[1]} = [FILE "${fileM[1]}", ${val.length} bytes of content]`
          : `      ${nameM[1]} = ${JSON.stringify(val.slice(0, 600))}`);
      }
      if (out.length) return out;
    }
  }

  return String(body).slice(0, 4000).split('\n').map(l => '      ' + l);
}

// Live view of the page's network, used to tell when an upload has ACTUALLY
// finished. `inFlight` holds requests that have started but not yet finished or
// failed; `lastRequestAt` is when the page last asked for anything at all.
//
// The occupancy fields exist so a wait can end on the ONE request that matters
// (see waitForOccupancyData) instead of on "everything the page might still be
// doing". `lastXhrAt` distinguishes "the app has started asking for its data"
// from "nothing has happened yet", so a momentary lull right after a reload is
// never mistaken for the page being finished.
const netState = {
  inFlight: new Map(),
  lastRequestAt: 0,
  lastXhrAt: 0,          // when an xhr/fetch last STARTED
  occupancyDoneAt: 0,    // when an occupancy-shaped xhr/fetch last FINISHED
  occupancyUrls: [],     // which URLs matched (bounded; for logs + diagnostics)
  windowUrls: [],        // xhr/fetch URLs seen since the last markNetWindow()
};

// URLs that carry the occupancy data the association options are built from.
//
//   ⚠️  This is a HINT, never a gate. Matching one lets the post-reload wait
//   finish early; NOT matching costs nothing, because the wait then falls
//   through to the same network-idle condition used before. A false positive is
//   contained too: the association options are still counted when the dialog
//   opens, and the reopen safeguard still runs if they are short. So this
//   pattern is allowed to be approximate.
//
// Kept deliberately broad — BuildingLink's endpoint names are not confirmed
// live. Every xhr/fetch seen while the Documents view reloads is recorded in
// `windowUrls` and reported when nothing matched, so a real run tells us the
// exact endpoint and this can be tightened.
const OCCUPANCY_URL_RE = /occupan|occupier|resident|householdmember|association|unit-?users|unitdocuments/i;

// Start a fresh observation window for the URLs a page load fetches.
function markNetWindow() {
  netState.windowUrls = [];
}

function saveDiagPath() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return path.join(outputDir, `save-diagnostics_${p(d.getMonth() + 1)}-${p(d.getDate())}-${d.getFullYear()}.txt`);
}

// Attach once per page. Buffers are bounded so a long run can't grow unbounded.
function attachDiagnostics(page) {
  if (!page || saveDiag.pages.has(page)) return;
  saveDiag.pages.add(page);
  // A new page means the old page's in-flight entries can never resolve; drop
  // them so a stale request can't hold up the attachment wait forever.
  netState.inFlight.clear();
  netState.lastRequestAt = 0;
  netState.lastXhrAt = 0;
  netState.occupancyDoneAt = 0;
  netState.occupancyUrls = [];
  netState.windowUrls = [];
  const keep = (arr, item) => { arr.push(item); if (arr.length > 600) arr.shift(); };

  page.on('request', r => {
    const entry = { t: Date.now(), kind: 'req', method: r.method(), url: r.url(), rtype: r.resourceType() };
    // Capture the payload of anything that changes state — this is the thing
    // that tells us WHICH field a 400 is complaining about.
    if (r.method() !== 'GET') {
      try {
        entry.headers = r.headers();
        let post = r.postData();
        if (post == null) {
          const buf = r.postDataBuffer();          // binary/multipart bodies
          post = buf ? buf.toString('utf8') : null;
        }
        // Keep enough to see every field; the file part gets summarised, not stored.
        entry.post = post == null ? null : String(post).slice(0, 60000);
      } catch (e) { entry.postError = e.message; }
    }
    keep(saveDiag.net, entry);
    netEntryFor.set(r, entry);
    netState.lastRequestAt = Date.now();
    const rtype = r.resourceType();
    netState.inFlight.set(r, { t: Date.now(), method: r.method(), url: r.url(), rtype });
    if (rtype === 'xhr' || rtype === 'fetch') {
      netState.lastXhrAt = Date.now();
      if (netState.windowUrls.length < 60) netState.windowUrls.push(r.url());
    }
  });
  // requestfinished fires once the response body is fully downloaded — that is
  // the real "this request is done", unlike 'response' (headers only). For the
  // occupancy fetch that distinction is the whole point: the association options
  // are built from the BODY, so headers arriving proves nothing.
  page.on('requestfinished', r => {
    const entry = netState.inFlight.get(r);
    netState.inFlight.delete(r);
    if (!entry) return;
    if (entry.rtype !== 'xhr' && entry.rtype !== 'fetch') return;
    if (!OCCUPANCY_URL_RE.test(entry.url)) return;
    netState.occupancyDoneAt = Date.now();
    if (netState.occupancyUrls.length < 20) netState.occupancyUrls.push(entry.url);
  });
  page.on('response', r => {
    const entry = { t: Date.now(), kind: 'res', status: r.status(), method: r.request().method(), url: r.url() };
    keep(saveDiag.net, entry);
    // Mirror the outcome back onto the REQUEST entry, so the payload and the
    // status it produced are reported together.
    const reqEntry = netEntryFor.get(r.request());
    if (reqEntry) reqEntry.status = r.status();
    // Capture the body of anything that failed — usually the real explanation.
    // Tracked as a promise so the report waits for it instead of racing it.
    if (r.status() >= 400) {
      const p = r.text()
        .then(b => { entry.body = String(b).slice(0, 3000); if (reqEntry) reqEntry.body = entry.body; })
        .catch(() => {});
      saveDiag.pendingBodies.push(p);
      if (saveDiag.pendingBodies.length > 50) saveDiag.pendingBodies.shift();
    }
  });
  page.on('requestfailed', r => {
    keep(saveDiag.net, {
      t: Date.now(), kind: 'FAILED', method: r.method(), url: r.url(),
      error: (r.failure() || {}).errorText,
    });
    netState.inFlight.delete(r);
  });
  page.on('console', m => {
    if (!/error|warning/i.test(m.type())) return;
    keep(saveDiag.console, { t: Date.now(), type: m.type(), text: m.text().slice(0, 500) });
  });
  page.on('pageerror', e => keep(saveDiag.console, {
    t: Date.now(), type: 'PAGE EXCEPTION', text: String((e && e.stack) || e).slice(0, 800),
  }));
}

// One single evaluate — deliberately, so this adds as little delay as possible
// between attaching the file and clicking Save. If the failure IS a race, extra
// diagnostic time here would mask it; captureMs records what it actually cost.
async function capturePreSaveState(page, formCtx) {
  const t0 = Date.now();
  const state = await formCtx.evaluate(() => {
    const q = s => document.querySelector(s);
    const val = el => (el ? el.value : null);
    const fileInputs = Array.from(document.querySelectorAll('input[type="file"]'));
    const files = [];
    for (const fi of fileInputs) {
      for (const f of Array.from(fi.files || [])) files.push({ name: f.name, size: f.size, type: f.type });
    }
    const saveBtn = q('[data-testid="dialog-primary-action"]');
    const text = document.body ? document.body.innerText : '';
    return {
      url: location.href,
      titleValue: val(q('[data-testid="bl-textfield-value-input"]')),
      dateValue:  val(q('[data-testid="datepicker-input"]')),
      // NB: the FIRST listbox on the page, which is not necessarily Document
      // Type (a language picker often precedes it). The INTENDED block below
      // carries the type actually chosen.
      firstListboxText: (q('[data-testid="listbox-button"]') || {}).innerText || null,
      fileInputCount: fileInputs.length,
      filesAttached: files,
      saveButtonFound: !!saveBtn,
      saveButtonDisabled: saveBtn ? !!(saveBtn.disabled || saveBtn.getAttribute('aria-disabled') === 'true') : null,
      radios: Array.from(document.querySelectorAll('svg[role="radiobutton"]'))
        .map(r => ({ for: r.getAttribute('aria-describedby'), checked: r.getAttribute('aria-checked') })),
      // The association wrappers still present at save time, with the full
      // outerHTML of the one we targeted — so a selection that never committed
      // can be told apart from one that was reset later.
      assocWrappers: Array.from(document.querySelectorAll('[data-testid^="radio-button-"]'))
        .map(el => ({
          testid: el.getAttribute('data-testid'),
          cls: (el.getAttribute('class') || '').slice(0, 120),
          html: el.outerHTML.slice(0, 700),
        })),
      occupants: Array.from(document.querySelectorAll('svg[role="checkbox"]'))
        .map(c => ({ name: c.getAttribute('name'), checked: c.getAttribute('aria-checked') })),
      validationText: Array.from(document.querySelectorAll('[role="alert"],[class*="error" i],[class*="invalid" i]'))
        .map(e => (e.innerText || '').trim()).filter(Boolean).slice(0, 8),
      dialogTextLength: text.length,
    };
  }).catch(e => ({ captureError: e.message }));
  state.overlaysBlocking = await countVisibleOverlays(page).catch(() => -1);
  state.captureMs = Date.now() - t0;
  return state;
}

// Everything the page did in the save window.
async function capturePostSaveState(page, formCtx, sinceMs) {
  const net = saveDiag.net.filter(e => e.t >= sinceMs);
  const cons = saveDiag.console.filter(e => e.t >= sinceMs);
  const dialogOpen = await addDocFormIsOpen(page).catch(() => null);
  const visible = await formCtx.evaluate(() => {
    const text = document.body ? document.body.innerText : '';
    return {
      alerts: Array.from(document.querySelectorAll('[role="alert"],[class*="toast" i],[class*="snackbar" i],[class*="error" i]'))
        .map(e => (e.innerText || '').trim()).filter(Boolean).slice(0, 8),
      // A list stuck on skeleton placeholders is itself a finding.
      skeletons: document.querySelectorAll('[class*="skeleton" i],[data-testid*="skeleton" i]').length,
      textSample: text.replace(/\s+/g, ' ').slice(0, 600),
    };
  }).catch(e => ({ evalError: e.message }));
  return { net, console: cons, dialogOpen, ...visible };
}

function writeSaveDiagnostics(block) {
  try {
    fs.appendFileSync(saveDiagPath(), block.join('\r\n') + '\r\n\r\n', 'utf8');
    return saveDiagPath();
  } catch { return null; }
}

// The dialog's Save button. CONFIRMED live 2026-07-31:
//   <button data-testid="dialog-primary-action">
//     <span data-testid="button-text">Save document</span>
//   </button>
// The testid is on the BUTTON itself, so this no longer depends on the label
// text — the last text-dependent click in the upload path.
const SAVE_BUTTON_SELECTOR = '[data-testid="dialog-primary-action"]';

// Backup only, for the legacy UI or a renamed testid.
//
//   ⚠️  Not merged into one list with the selector above — a joined CSS list
//   resolves in DOM ORDER, so `button:has-text("Save")` (a SUBSTRING match that
//   also catches "Save and add another", "Save draft") could win over the exact
//   testid. findInPreferred queries them as two ordered lookups.
const SAVE_BUTTON_FALLBACK_SELECTORS = [
  'button:has([data-testid="button-text"]:has-text("Save document"))',
  '[data-testid="button-text"]:has-text("Save document")',
  'button:has-text("Save")',
  'input[type="submit"][value*="Save" i]',
  'input[type="button"][value*="Save" i]',
  'a:has-text("Save")',
];

// How long to wait for the saved document to show up in the unit's list.
const VERIFY_TIMEOUT = 12000;
// Fixed settle after clicking Save, before anything else happens.
//
//   ⚠️  RESTORED to a FIXED wait on 2026-07-31. Exiting as soon as the dialog
//   looked closed let main() move the PDF out from under an upload that was
//   still in flight — the browser needs that file until the request completes.
const SAVE_SETTLE_WAIT = 2000;

// What the run is currently trying to file. Set by openAddDocForm (with the
// document list as it stood BEFORE the form was opened), the title added by
// fillTitle, and consumed by saveForm's verification.
let pendingUpload = null;

// Test switch: skip the [2b] Unit Overview read entirely, to A/B whether that
// step is what leaves the Add Document dialog missing its association options.
// Set per run from the UI checkbox or `--skip-role-map`.
let skipRoleMap = false;

// All visible text on the page, across every frame — markup-agnostic on purpose,
// so this keeps working when BuildingLink reshuffles its document-list markup.
async function readAllFrameText(page) {
  let out = '';
  for (const frame of page.frames()) {
    try {
      out += '\n' + await frame.evaluate(() => (document.body ? document.body.innerText : ''));
    } catch {}
  }
  return out;
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  const h = String(haystack).replace(/\s+/g, ' ').toLowerCase();
  const n = String(needle).replace(/\s+/g, ' ').toLowerCase();
  if (!n) return 0;
  let count = 0, i = 0;
  for (;;) {
    const at = h.indexOf(n, i);
    if (at === -1) return count;
    count++;
    i = at + n.length;
  }
}

// Confirm the document actually appears in the unit's list. Throws when it can
// be checked and the document is NOT there. Returns a note for the log otherwise.
async function verifyDocumentSaved(page, unit) {
  const p = pendingUpload;
  pendingUpload = null;

  // Unable to check (no snapshot / no title) — say so loudly rather than
  // pretending the upload was verified, but don't block the run on it.
  if (!p || !p.title || p.beforeText == null) {
    log(`  ⚠️  Could not verify the upload for ${unit} (no document-list snapshot) — treating as saved.`);
    return { verified: false, reason: 'no snapshot' };
  }

  const before = countOccurrences(p.beforeText, p.title);
  const deadline = Date.now() + VERIFY_TIMEOUT;
  let wait = 250, after = before;

  for (;;) {
    after = countOccurrences(await readAllFrameText(page), p.title);
    if (after > before) {
      log(`  ✓ Verified in BuildingLink: "${p.title}" now listed for ${unit}.`);
      return { verified: true, before, after };
    }
    if (Date.now() >= deadline) break;
    await page.waitForTimeout(Math.min(wait, Math.max(0, deadline - Date.now())));
    wait = Math.min(1000, Math.round(wait * 1.5));
  }

  await screenshot(page, `unverified_${String(unit).replace(/[^a-z0-9]/gi, '_')}`);
  // If the title had to be shortened, say so in the error: a mismatch between
  // what we searched for and what BuildingLink stored is exactly what produced
  // false "not in the list" failures before fillTitle started verifying against
  // the committed value.
  const shortened = p.requestedTitle && p.requestedTitle !== p.title
    ? ` (the title was shortened to BuildingLink's ${TITLE_MAX_LEN}-character limit before saving, so the search used "${p.title}")`
    : '';
  throw new Error(
    `Save appeared to succeed but the document is NOT in unit ${unit}'s document list ` +
    `after ${Math.round(VERIFY_TIMEOUT / 1000)}s — "${p.title}" was listed ${before} time(s) before saving ` +
    `and ${after} after${shortened}. The file has been left in the source folder.`);
}

// Saving is INDIVISIBLE. From the Save click through the post-save diagnostics
// to verifyDocumentSaved, a pause or stop is recorded but not acted on — see
// runCritical. Interrupting between "Save clicked" and "confirmed present in
// BuildingLink" would leave the document in a state nothing can report on: the
// upload may have landed, the PDF is still in the source folder, and the next
// run would duplicate it. That is the v2.19.0 duplicate-factory failure, and a
// mid-save Stop is a new way to reach it.
//
// The cost is bounded by the save path's own timeouts — a few seconds — and the
// UI shows "Finishing the current upload…" for the duration.
async function saveForm(page, formCtx, unit) {
  // THE LAST SAFE PLACE TO ABANDON THIS FILE. Everything up to here is
  // reversible — the form is filled and the PDF is attached, but BuildingLink
  // has no document and the source file is untouched, so walking away costs
  // nothing. One step later the save is committed and must run to completion.
  //
  // This gate is what stops a run uploading one more document after the
  // operator pressed Stop: attachFile's settle has no gate of its own (its fixed
  // waits are a data-safety floor), so without this the file in flight would be
  // saved and filed before the run noticed it had been asked to stop.
  await gate('just before saving — the last point this file can be abandoned');

  return runCritical('saving this document to BuildingLink',
    () => saveFormCritical(page, formCtx, unit));
}

async function saveFormCritical(page, formCtx, unit) {
  stepBegin('save', 'Save', `  [7] Saving...`);
  const { loc: saveBtn, usedFallback } =
    await findInPreferred(formCtx, SAVE_BUTTON_SELECTOR, SAVE_BUTTON_FALLBACK_SELECTORS);
  if (usedFallback) {
    log(`         (no ${SAVE_BUTTON_SELECTOR} in this dialog — matched the Save button by its label instead)`);
  }

  // Commit whatever field still has focus before saving. A real mouse click
  // moves focus and fires blur; a synthetic dispatch does not, and this form
  // has fields (the masked date box) that reformat on blur — so do it
  // explicitly rather than depending on the click to cause it.
  await formCtx.evaluate(() => {
    const el = document.activeElement;
    if (el && typeof el.blur === 'function') el.blur();
  }).catch(() => {});

  // ── Pre-save state, captured from the DOM (diagnostics only) ──
  const pre = await capturePreSaveState(page, formCtx);
  log(`         Pre-save: date="${pre.dateValue}"  files=${JSON.stringify(pre.filesAttached)}  ` +
      `saveDisabled=${pre.saveButtonDisabled}  overlaysBlocking=${pre.overlaysBlocking}  (read in ${pre.captureMs}ms)`);
  if (pre.validationText && pre.validationText.length) {
    log(`         ⚠️  Validation text already on the form: ${JSON.stringify(pre.validationText)}`);
  }
  const shotPre = await screenshot(page, `presave_${String(unit).replace(/[^a-z0-9]/gi, '_')}`);

  // preferJs: dispatch straight at the resolved element. The Save button lives
  // inside the dialog whose backdrop is persistent, and a coordinate click can
  // be swallowed by it — force:true is NOT a fix for that (see clickResilient's
  // note: it resolves successfully while the target receives nothing). The same
  // reasoning already applies to the Document Type listbox.
  const clickAt = Date.now();
  const strategy = await clickResilient(saveBtn, 'Save document button', { preferJs: true });
  log(`         Save clicked at ${new Date(clickAt).toISOString()} via "${strategy}" strategy.`);

  try { await page.waitForLoadState('load', { timeout: 15000 }); } catch {}
  // Full fixed settle — the upload request must be allowed to finish before
  // anything moves the PDF it is reading. See SAVE_SETTLE_WAIT.
  await page.waitForTimeout(SAVE_SETTLE_WAIT);
  log(`  ✓ Saved.`);

  // ── What the page actually did (diagnostics only) ─────────────
  // Let any error-body reads finish first, so the report never omits the very
  // explanation it exists to capture.
  await Promise.race([
    Promise.allSettled(saveDiag.pendingBodies.slice()),
    new Promise(r => setTimeout(r, 2500)),
  ]).catch(() => {});
  const post = await capturePostSaveState(page, formCtx, clickAt);
  // Only REQUEST entries are submissions. Response entries carry a method too,
  // so without the kind check every POST is reported twice — once as itself and
  // once as a bodyless phantom.
  const writes = post.net.filter(e => e.kind === 'req' && e.method && e.method !== 'GET');
  const failures = post.net.filter(e => e.kind === 'FAILED' || (e.kind === 'res' && e.status >= 400));
  log(`         Post-save: dialogOpen=${post.dialogOpen}  skeletons=${post.skeletons}  ` +
      `non-GET requests=${writes.length}  failures=${failures.length}  pageErrors=${post.console.length}`);
  failures.forEach(f => log(`         ⚠️  ${f.kind === 'FAILED' ? 'REQUEST FAILED' : f.status} ${f.method} ${f.url}${f.error ? ' — ' + f.error : ''}`));
  // Print the rejected submission's fields inline — the operator should not
  // have to open a file to see which value BuildingLink refused.
  for (const w of writes.filter(e => e.status >= 400)) {
    const ct = w.headers && (w.headers['content-type'] || w.headers['Content-Type']);
    log(`         ── Rejected submission: ${w.method} ${w.url} → HTTP ${w.status}`);
    decodePostBody(ct, w.post).slice(0, 40).forEach(l => log(`         ${l.trimEnd()}`));
    if (w.body) log(`         RESPONSE: ${String(w.body).replace(/\s+/g, ' ').slice(0, 500)}`);
  }
  post.console.forEach(c => log(`         ⚠️  ${c.type}: ${c.text.split('\n')[0]}`));
  const shotPost = await screenshot(page, `postsave_${String(unit).replace(/[^a-z0-9]/gi, '_')}`);

  const diagFile = writeSaveDiagnostics([
    // ASCII only in this file — it is read in Notepad, which renders UTF-8
    // punctuation from a BOM-less file as mojibake.
    '='.repeat(78),
    `  SAVE DIAGNOSTIC - unit ${unit} - ${new Date(clickAt).toISOString()}`,
    '='.repeat(78),
    `  Title            : ${pre.titleValue}`,
    `  Date field       : ${pre.dateValue}`,
    `  First listbox    : ${(pre.firstListboxText || '').replace(/\s+/g, ' ').trim()}  (may not be Document Type)`,
    `  File inputs      : ${pre.fileInputCount}`,
    `  Files ATTACHED   : ${JSON.stringify(pre.filesAttached)}`,
    `  Save btn found   : ${pre.saveButtonFound}   disabled: ${pre.saveButtonDisabled}`,
    `  Radios           : ${JSON.stringify(pre.radios)}`,
    `  Assoc options at form-open : ${JSON.stringify((pendingUpload && pendingUpload.assocOptions) || null)}`,
    `  Assoc wrappers at save     : ${((pre.assocWrappers || []).map(w => w.testid).join(', ')) || 'NONE'}`,
    ...(pre.assocWrappers || []).map(w => `      ${w.testid} :: ${w.html.replace(/\s+/g, ' ')}`),
    `  Occupants        : ${JSON.stringify(pre.occupants)}`,
    `  Validation before: ${JSON.stringify(pre.validationText)}`,
    `  Overlays blocking: ${pre.overlaysBlocking}`,
    `  Pre-capture cost : ${pre.captureMs}ms  (delay this added between attach and save)`,
    `  CLICK STRATEGY   : ${strategy}`,
    '',
    `  --- after save (${SAVE_SETTLE_WAIT}ms settle) ---`,
    `  Dialog still open: ${post.dialogOpen}`,
    `  Skeleton nodes   : ${post.skeletons}`,
    `  Alerts / toasts  : ${JSON.stringify(post.alerts)}`,
    '',
    '  --- FORM OPEN: what the page fetched while the dialog was being built ---',
    `  Association options at form-open  : ${JSON.stringify((pendingUpload && pendingUpload.assocOptions) || null)}`,
    // One entry per reload attempt — this is where a unit that needed several
    // tries (or never came good) shows its history.
    `  Occupancy load attempts           : ${JSON.stringify((pendingUpload && pendingUpload.assocAttempts) || 'n/a')}`,
    // Which URL ended the post-reload wait. If this says NONE the pattern needs
    // widening — the run still worked (it fell back to network idle), it just
    // waited longer than it had to.
    `  Occupancy fetch recognised by URL  : ${netState.occupancyUrls.length
        ? netState.occupancyUrls.slice(-3).map(shortUrl).join(', ')
        : 'NONE - OCCUPANCY_URL_RE matched nothing; see the data URLs below'}`,
    ...((pendingUpload && pendingUpload.openNet && pendingUpload.openNet.length)
      ? pendingUpload.openNet.map(e =>
          `    +${String(e.dt).padStart(6)}ms  ${e.kind.padEnd(7)} ${(e.method || '').padEnd(5)} ${e.status || ''} ${e.url}`)
      : ['    (no network activity captured during form open)']),
    ...((pendingUpload && pendingUpload.openConsole && pendingUpload.openConsole.length)
      ? ['    -- console --', ...pendingUpload.openConsole.map(c => `    +${c.dt}ms  ${c.type}: ${c.text}`)]
      : []),
    '',
    '  --- SUBMISSION PAYLOAD (every non-GET request in the save window) ---',
    `  What the script INTENDED to submit:`,
    `      title       = ${JSON.stringify((pendingUpload && pendingUpload.title) || pre.titleValue)}`,
    `      date        = ${JSON.stringify((pendingUpload && pendingUpload.date) || pre.dateValue)}`,
    `      docType     = ${JSON.stringify((pendingUpload && pendingUpload.docType) || null)}`,
    `      association = ${JSON.stringify((pendingUpload && pendingUpload.association) || null)}`,
    `      unit        = ${JSON.stringify(unit)}`,
    '',
    ...(writes.length ? writes.flatMap(e => [
      `  >>> ${e.method} ${e.url}`,
      `      -> HTTP ${e.status == null ? '(no response captured)' : e.status}` +
        `${e.status >= 400 ? '   *** THIS IS THE REJECTION ***' : ''}`,
      `      Content-Type: ${(e.headers && (e.headers['content-type'] || e.headers['Content-Type'])) || '(none)'}`,
      '      FIELDS SUBMITTED:',
      ...decodePostBody(e.headers && (e.headers['content-type'] || e.headers['Content-Type']), e.post),
      ...(e.postError ? [`      (payload unavailable: ${e.postError})`] : []),
      ...(e.body ? ['      RESPONSE BODY:', ...String(e.body).split('\n').map(l => '        ' + l)] : []),
      '',
    ]) : ['  (no non-GET request was made at all — the Save click produced no submission)']),
    '',
    '  --- network in the save window ---',
    ...(post.net.length ? post.net.map(e =>
      `    +${String(e.t - clickAt).padStart(6)}ms  ${e.kind.padEnd(7)} ${(e.method || '').padEnd(5)} ` +
      `${e.status || ''} ${e.url}${e.error ? '  ERROR: ' + e.error : ''}${e.body ? '\r\n        BODY: ' + e.body : ''}`)
      : ['    (NO network activity at all - the Save click produced no request)']),
    '',
    '  --- console / page errors in the save window ---',
    ...(post.console.length ? post.console.map(c => `    +${c.t - clickAt}ms  ${c.type}: ${c.text}`)
      : ['    (none)']),
    '',
    `  Screenshots: ${shotPre || 'n/a'}   ${shotPost || 'n/a'}`,
    `  Page text after save: ${String(post.textSample || '').slice(0, 400)}`,
  ]);
  if (diagFile) log(`         📋 Save diagnostic written: ${diagFile}`);

  // If BuildingLink's own API rejected the save, say so immediately and in its
  // own words — far better than waiting 12s for the document to not appear and
  // reporting a generic "not in the list".
  const rejected = writes.find(e => e.status >= 400 && /buildinglink\.com/i.test(e.url));
  if (rejected) {
    let detail = '';
    try {
      const j = JSON.parse(rejected.body || '{}');
      detail = j.detail || j.message || j.title || '';
    } catch { detail = String(rejected.body || '').replace(/\s+/g, ' ').slice(0, 200); }
    pendingUpload = null;
    throw new Error(
      `BuildingLink rejected the save with HTTP ${rejected.status}${detail ? `: ${detail}` : ''} ` +
      `(${rejected.method} ${rejected.url}). The file was left in the source folder.`);
  }

  // Prove it before the caller is allowed to move the file. Throws if not.
  await verifyDocumentSaved(page, unit);
  await screenshot(page, `saved_${unit.replace(/[^a-z0-9]/gi, '_')}`);
}

// ═══════════════════════════════════════════════════════════════
// UPLOAD HANDLERS
// ═══════════════════════════════════════════════════════════════

// Unit inspection. A single PDF may cover several units (filename lists them
// separated by "and" or "&", e.g. "...2-1034 and 2-1036 06-02-2026.pdf"). One
// document is uploaded per unit with the same title/type/date (physical-unit
// association). main then places the file like a water leak: one unit → move;
// many → copy into the secondary units' Approved Unit Inspections folders, then
// move the original into the first unit's (multiDest flag).
async function uploadInspection(page, filename) {
  const units   = extractUnits(filename); // every unit, in filename order
  const docDate = extractDateFromFilename(filename);
  if (units.length === 0) throw new Error(`Cannot extract unit number from filename: ${filename}`);
  if (!docDate)           throw new Error(`Cannot extract date from filename (expected MM-DD-YY at end): ${filename}`);

  const year    = docDate.split('/')[2];
  const title   = `${year} Unit Inspection & Compliance Checklist`;
  const filePath = path.join(FILES_DIR, filename);

  log(`\n${'─'.repeat(65)}`);
  log(`📋 INSPECTION`);
  log(`   File: ${filename}`);
  log(`   Unit(s): ${units.join(', ')}   Date: ${docDate}`);
  log(`${'─'.repeat(65)}`);

  // One document per unit — same title, physical-unit association.
  // Once the first unit is saved the file is part-uploaded, so the rest must
  // finish even if the operator stops the run — see multiUnitCommit.
  const commit = { committed: false };
  try {
    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      if (units.length > 1) log(`  ► Document ${i + 1} of ${units.length} (physical unit @ ${unit})`);
      const formCtx = await openAddDocForm(page, unit);
      stepBegin('form', 'Form fill', `  [5] Filling form...`);
      await fillTitle(formCtx, title);
      await fillType(formCtx, 'Inspection');
      await fillAssociation(page, formCtx, 'unit');
      await fillDate(formCtx, docDate);
      stepBegin('attach', 'Attach PDF', `  [6] Attaching PDF...`);
      await attachFile(page, formCtx, filePath);
      await saveForm(page, formCtx, unit);
      multiUnitCommit(commit, units);
    }
  } finally {
    multiUnitRelease(commit);
  }

  // multiDest tells main to place the file across every unit's folder (move for
  // a single unit; copies into the rest + the original moved into the first for
  // several — same as water leaks).
  return { unit: units[0], units, docDate, title, docType: 'Inspection', category: 'inspection', ownerTenant: null, occupants: null, multiDest: true };
}

async function uploadWindowReplacement(page, filename) {
  const unit    = extractUnit(filename);
  const docDate = extractDateFromFilename(filename); // trailing date
  if (!unit)    throw new Error(`Cannot extract unit number from filename: ${filename}`);
  if (!docDate) throw new Error(`Cannot extract date from filename (expected MM-DD-YY at end): ${filename}`);

  const year     = docDate.split('/')[2];
  const title    = `Window Replacement Request (${year})`;
  const filePath = path.join(FILES_DIR, filename);

  log(`\n${'─'.repeat(65)}`);
  log(`🪟 WINDOW REPLACEMENT REQUEST`);
  log(`   File: ${filename}`);
  log(`   Unit: ${unit}   Date: ${docDate}`);
  log(`${'─'.repeat(65)}`);

  const formCtx = await openAddDocForm(page, unit);
  stepBegin('form', 'Form fill', `  [5] Filling form...`);
  await fillTitle(formCtx, title);
  await fillType(formCtx, 'Correspondence');
  await fillAssociation(page, formCtx, 'unit');
  await fillDate(formCtx, docDate);
  stepBegin('attach', 'Attach PDF', `  [6] Attaching PDF...`);
  await attachFile(page, formCtx, filePath);
  await saveForm(page, formCtx, unit);

  return { unit, docDate, title, docType: 'Correspondence', category: 'windowreplacement', ownerTenant: null, occupants: null };
}

async function uploadAlta(page, filename) {
  const unit    = extractUnit(filename);
  const docDate = extractDateFromFilename(filename); // trailing date = settlement date
  if (!unit)    throw new Error(`Cannot extract unit number from filename: ${filename}`);
  if (!docDate) throw new Error(`Cannot extract date from filename (expected MM-DD-YY at end): ${filename}`);

  const year     = docDate.split('/')[2];
  const title    = `ALTA Settlement Statement (${year})`;
  const filePath = path.join(FILES_DIR, filename);

  log(`\n${'─'.repeat(65)}`);
  log(`🏠 ALTA SETTLEMENT STATEMENT`);
  log(`   File: ${filename}`);
  log(`   Unit: ${unit}   Settled: ${docDate}`);
  log(`${'─'.repeat(65)}`);

  const formCtx = await openAddDocForm(page, unit);
  stepBegin('form', 'Form fill', `  [5] Filling form...`);
  await fillTitle(formCtx, title);
  await fillType(formCtx, 'Proof of Ownership');
  await fillAssociation(page, formCtx, 'unit');
  await fillDate(formCtx, docDate);
  stepBegin('attach', 'Attach PDF', `  [6] Attaching PDF...`);
  await attachFile(page, formCtx, filePath);
  await saveForm(page, formCtx, unit);

  return { unit, docDate, title, docType: 'Proof of Ownership', category: 'alta', ownerTenant: null, occupants: null };
}

// Storage bin assignment + its Cancelled variant — identical logic, only the
// title differs. Bin number is the dash-joined value after "#" (building-room-
// box). Associated with the occupancy (RdoAssignUnit), filed under Tenant
// Registrations regardless of variant.
async function uploadStorageBin(page, filename) {
  const unit      = extractUnit(filename);
  const bins      = extractHashNumbers(filename); // one file may cover several bins
  const docDate   = extractDateFromFilename(filename); // trailing date = date of issuance
  const cancelled = parseBase(filename).toLowerCase().includes('cancelled');
  if (!unit)      throw new Error(`Cannot extract unit number from filename: ${filename}`);
  if (!bins.length) throw new Error(`Cannot extract bin number (expected "#2-9-392") from filename: ${filename}`);
  if (!docDate)   throw new Error(`Cannot extract date from filename (expected MM-DD-YY at end): ${filename}`);

  const binList  = formatHashNumbers(bins);
  const title    = cancelled ? `Cancelled Storage Bin ${binList}` : `Storage Bin Assignment ${binList}`;
  const filePath = path.join(FILES_DIR, filename);

  log(`\n${'─'.repeat(65)}`);
  log(`📦 STORAGE BIN${cancelled ? ' (CANCELLED)' : ' ASSIGNMENT'}`);
  log(`   File: ${filename}`);
  log(`   Unit: ${unit}   Bin: ${binList}   Date: ${docDate}`);
  log(`${'─'.repeat(65)}`);

  const formCtx = await openAddDocForm(page, unit);
  stepBegin('form', 'Form fill', `  [5] Filling form...`);
  await fillTitle(formCtx, title);
  await fillType(formCtx, 'Registration');
  await fillAssociation(page, formCtx, 'occupancy');
  await fillDate(formCtx, docDate);
  stepBegin('attach', 'Attach PDF', `  [6] Attaching PDF...`);
  await attachFile(page, formCtx, filePath);
  await saveForm(page, formCtx, unit);

  return { unit, docDate, title, docType: 'Registration', category: 'storagebin', ownerTenant: null, occupants: null };
}

async function uploadYardSale(page, filename) {
  const unit        = extractUnit(filename);
  const ownerTenant = extractOwnerTenantBeforeDate(filename); // O/T sits before the date
  const docDate     = extractDateFromFilename(filename);      // trailing date
  if (!unit)        throw new Error(`Cannot extract unit number from filename: ${filename}`);
  if (!ownerTenant) throw new Error(`Cannot determine Owner/Tenant (expected "O" or "T" before the date) from filename: ${filename}`);
  if (!docDate)     throw new Error(`Cannot extract date from filename (expected MM-DD-YYYY at end): ${filename}`);

  const year     = docDate.split('/')[2];
  const title    = `Yard Sale Registration (${year})`;
  const filePath = path.join(FILES_DIR, filename);

  log(`\n${'─'.repeat(65)}`);
  log(`🛍️ YARD SALE REGISTRATION (${ownerTenant === 'O' ? 'Owner' : 'Tenant'})`);
  log(`   File: ${filename}`);
  log(`   Unit: ${unit}   Date: ${docDate}`);
  log(`${'─'.repeat(65)}`);

  const formCtx = await openAddDocForm(page, unit);
  stepBegin('form', 'Form fill', `  [5] Filling form...`);
  await fillTitle(formCtx, title);
  await fillType(formCtx, 'Signed Documents & Waivers');
  await fillAssociation(page, formCtx, 'occupancy');
  await fillDate(formCtx, docDate);
  stepBegin('attach', 'Attach PDF', `  [6] Attaching PDF...`);
  await attachFile(page, formCtx, filePath);
  await saveForm(page, formCtx, unit);

  return { unit, docDate, title, docType: 'Signed Documents & Waivers', category: 'yardsale', ownerTenant, occupants: null };
}

// Standalone BuildingLink Form (registration for the BuildingLink portal itself).
// Format: "BuildingLink Form 2-0216 O 05-22-2026.pdf" — unit, an O/T flag, and the
// trailing date. Distinct from "Move In & BuildingLink Form" (movein1), which
// shares the keyword but is a different document; see the guard in classifyFile.
//
// Associated with the OCCUPANCY, so the O/T flag is used only to route the file
// (Unit Owner vs Tenant Registrations) — there is no occupant matching, hence no
// numbered prompts and no "no occupant match" failures.
//
// The flag is accepted either before the date (the documented format) or at the
// very end of the name, since it is written both ways in practice.
async function uploadBLForm(page, filename) {
  const unit        = extractUnit(filename);
  const ownerTenant = extractOwnerTenantBeforeDate(filename) || extractOwnerTenant(filename);
  const docDate     = extractDateFromFilename(filename);      // trailing date
  if (!unit)        throw new Error(`Cannot extract unit number from filename: ${filename}`);
  if (!ownerTenant) throw new Error(`Cannot determine Owner/Tenant (expected "O" or "T" before the date) from filename: ${filename}`);
  if (!docDate)     throw new Error(`Cannot extract date from filename (expected MM-DD-YYYY at end): ${filename}`);

  const title    = `BuildingLink Form (${docDate})`;
  const filePath = path.join(FILES_DIR, filename);

  log(`\n${'─'.repeat(65)}`);
  log(`📝 BUILDINGLINK FORM (${ownerTenant === 'O' ? 'Owner' : 'Tenant'})`);
  log(`   File: ${filename}`);
  log(`   Unit: ${unit}   Date: ${docDate}`);
  log(`${'─'.repeat(65)}`);

  const formCtx = await openAddDocForm(page, unit);
  stepBegin('form', 'Form fill', `  [5] Filling form...`);
  await fillTitle(formCtx, title);
  await fillType(formCtx, 'Registration');
  await fillAssociation(page, formCtx, 'occupancy');
  await fillDate(formCtx, docDate);
  stepBegin('attach', 'Attach PDF', `  [6] Attaching PDF...`);
  await attachFile(page, formCtx, filePath);
  await saveForm(page, formCtx, unit);

  return { unit, docDate, title, docType: 'Registration', category: 'blform', ownerTenant, occupants: null };
}

async function uploadPoolPass(page, filename) {
  const unit        = extractUnit(filename);
  const docDate     = extractDateFromFilename(filename);
  const ownerTenant = extractOwnerTenant(filename);
  if (!unit)        throw new Error(`Cannot extract unit number from filename: ${filename}`);
  if (!docDate)     throw new Error(`Cannot extract date from filename (expected MM-DD-YY at end): ${filename}`);
  if (!ownerTenant) throw new Error(`Cannot determine Owner/Tenant (expected "O" or "T" at end of filename): ${filename}`);

  const year    = docDate.split('/')[2];
  const title   = `${year} Pool Pass Application`;
  const role    = ownerTenant === 'O' ? 'owner' : 'renter';
  const filePath = path.join(FILES_DIR, filename);

  log(`\n${'─'.repeat(65)}`);
  log(`🏊 POOL PASS (${ownerTenant === 'O' ? 'Owner' : 'Tenant'})`);
  log(`   File: ${filename}`);
  log(`   Unit: ${unit}   Date: ${docDate}`);
  log(`${'─'.repeat(65)}`);

  const formCtx = await openAddDocForm(page, unit);
  stepBegin('form', 'Form fill', `  [5] Filling form...`);
  await fillTitle(formCtx, title);
  await fillType(formCtx, 'Registration');
  await fillAssociation(page, formCtx, 'specific');
  const occupants = await selectOccupantsByRole(page, formCtx, role);
  await fillDate(formCtx, docDate);
  stepBegin('attach', 'Attach PDF', `  [6] Attaching PDF...`);
  await attachFile(page, formCtx, filePath);
  await saveForm(page, formCtx, unit);

  return { unit, docDate, title, docType: 'Registration', category: 'poolpass', ownerTenant, occupants };
}

async function uploadParking(page, filename) {
  const unit      = extractUnit(filename);
  const permitNos = extractHashNumbers(filename); // one file may cover several permits
  const initials  = extractInitials(filename);
  const docDate   = extractDateFromFilename(filename);
  if (!unit)             throw new Error(`Cannot extract unit number from filename: ${filename}`);
  if (!permitNos.length) throw new Error(`Cannot extract permit number (expected "#1-0376") from filename: ${filename}`);
  if (!initials)         throw new Error(`Cannot extract occupant initials (expected two letters before the date) from filename: ${filename}`);
  if (!docDate)          throw new Error(`Cannot extract date from filename (expected MM-DD-YY at end): ${filename}`);

  const permitList = formatHashNumbers(permitNos);
  const title    = `Vehicle Parking Permit (${permitList})`;
  const filePath = path.join(FILES_DIR, filename);

  log(`\n${'─'.repeat(65)}`);
  log(`🚗 VEHICLE PARKING PERMIT`);
  log(`   File: ${filename}`);
  log(`   Unit: ${unit}   Permit: ${permitList}   Initials: ${initials}   Date: ${docDate}`);
  log(`${'─'.repeat(65)}`);

  const formCtx = await openAddDocForm(page, unit);
  stepBegin('form', 'Form fill', `  [5] Filling form...`);
  await fillTitle(formCtx, title);
  await fillType(formCtx, 'Registration');
  await fillAssociation(page, formCtx, 'specific');
  // Pauses for a numbered prompt if several occupants share the initials;
  // throws on no match / skipped prompt.
  const { isRenter, names } = await selectOccupantByInitials(page, formCtx, initials, unit);
  const ownerTenant  = isRenter ? 'T' : 'O'; // owner/tenant from the matched occupant
  await fillDate(formCtx, docDate);
  stepBegin('attach', 'Attach PDF', `  [6] Attaching PDF...`);
  await attachFile(page, formCtx, filePath);
  await saveForm(page, formCtx, unit);

  return { unit, docDate, title, docType: 'Registration', category: 'parking', ownerTenant, occupants: names && names.length ? names : null };
}

// Returned vehicle parking permit. Associated with the PHYSICAL UNIT, the way
// inspections are — NOT with an occupant. When a permit comes back the holder has
// usually already moved out (or was never listed), so matching by initials failed
// far more often than it worked; the unit is the one thing always known. The
// filename carries no date either, so we use today's.
//
// Consequence: with no matched occupant there is no Owner/Tenant role to read, so
// these always file under the Unit Owner's Correspondence folder (see destFolder).
// Initials in the filename are ignored — they are no longer required.
async function uploadReturnedParking(page, filename) {
  const unit      = extractUnit(filename);
  const permitNos = extractHashNumbers(filename); // several permits are often returned together
  if (!unit)             throw new Error(`Cannot extract unit number from filename: ${filename}`);
  if (!permitNos.length) throw new Error(`Cannot extract permit number (expected "#1-0376") from filename: ${filename}`);

  const permitList = formatHashNumbers(permitNos);
  const docDate  = todayDate(); // no date in filename — use today's
  const title    = `Returned Vehicle Parking Permit (${permitList})`;
  const filePath = path.join(FILES_DIR, filename);

  log(`\n${'─'.repeat(65)}`);
  log(`🚗 RETURNED VEHICLE PARKING PERMIT`);
  log(`   File: ${filename}`);
  log(`   Unit: ${unit}   Permit: ${permitList}   Date: ${docDate} (today)`);
  log(`${'─'.repeat(65)}`);

  const formCtx = await openAddDocForm(page, unit);
  stepBegin('form', 'Form fill', `  [5] Filling form...`);
  await fillTitle(formCtx, title);
  await fillType(formCtx, 'Registration');
  await fillAssociation(page, formCtx, 'unit');
  await fillDate(formCtx, docDate);
  stepBegin('attach', 'Attach PDF', `  [6] Attaching PDF...`);
  await attachFile(page, formCtx, filePath);
  await saveForm(page, formCtx, unit);

  return { unit, docDate, title, docType: 'Registration', category: 'returnedparking', ownerTenant: 'O', occupants: null };
}

// Bicycle registration. Same filename format and occupant-by-initials flow as the
// regular parking permit (unit, #number, initials before the trailing date), only
// the title differs. Filed under the matched occupant's Registrations folder.
async function uploadBicycle(page, filename) {
  const unit      = extractUnit(filename);
  const permitNos = extractHashNumbers(filename); // one file may cover several bikes
  const initials  = extractInitials(filename);
  const docDate   = extractDateFromFilename(filename);
  if (!unit)             throw new Error(`Cannot extract unit number from filename: ${filename}`);
  if (!permitNos.length) throw new Error(`Cannot extract permit number (expected "#1234") from filename: ${filename}`);
  if (!initials)         throw new Error(`Cannot extract occupant initials (expected two letters before the date) from filename: ${filename}`);
  if (!docDate)          throw new Error(`Cannot extract date from filename (expected MM-DD-YY at end): ${filename}`);

  const permitList = formatHashNumbers(permitNos);
  const title    = `Bicycle Registration (${permitList})`;
  const filePath = path.join(FILES_DIR, filename);

  log(`\n${'─'.repeat(65)}`);
  log(`🚲 BICYCLE REGISTRATION`);
  log(`   File: ${filename}`);
  log(`   Unit: ${unit}   Permit: ${permitList}   Initials: ${initials}   Date: ${docDate}`);
  log(`${'─'.repeat(65)}`);

  const formCtx = await openAddDocForm(page, unit);
  stepBegin('form', 'Form fill', `  [5] Filling form...`);
  await fillTitle(formCtx, title);
  await fillType(formCtx, 'Registration');
  await fillAssociation(page, formCtx, 'specific');
  // Pauses for a numbered prompt if several occupants share the initials;
  // throws on no match / skipped prompt.
  const { isRenter, names } = await selectOccupantByInitials(page, formCtx, initials, unit);
  const ownerTenant  = isRenter ? 'T' : 'O'; // owner/tenant from the matched occupant
  await fillDate(formCtx, docDate);
  stepBegin('attach', 'Attach PDF', `  [6] Attaching PDF...`);
  await attachFile(page, formCtx, filePath);
  await saveForm(page, formCtx, unit);

  return { unit, docDate, title, docType: 'Registration', category: 'bicycle', ownerTenant, occupants: names && names.length ? names : null };
}

async function uploadKeyFob(page, filename) {
  const unit    = extractUnit(filename);
  const fobNos  = extractHashNumbers(filename); // a unit is often issued a pair of fobs
  const docDate = extractDateFromFilename(filename);
  if (!unit)          throw new Error(`Cannot extract unit number from filename: ${filename}`);
  if (!fobNos.length) throw new Error(`Cannot extract fob number (expected "#1234") from filename: ${filename}`);
  if (!docDate)       throw new Error(`Cannot extract date from filename (expected MM-DD-YY at end): ${filename}`);

  const fobList  = formatHashNumbers(fobNos);
  const title    = `Key FOB (${fobList})`;
  const filePath = path.join(FILES_DIR, filename);

  log(`\n${'─'.repeat(65)}`);
  log(`🔐 KEY FOB`);
  log(`   File: ${filename}`);
  log(`   Unit: ${unit}   Fob: ${fobList}   Date: ${docDate}`);
  log(`${'─'.repeat(65)}`);

  const formCtx = await openAddDocForm(page, unit);
  stepBegin('form', 'Form fill', `  [5] Filling form...`);
  await fillTitle(formCtx, title);
  await fillType(formCtx, 'Registration');
  await fillAssociation(page, formCtx, 'occupancy');
  await fillDate(formCtx, docDate);
  stepBegin('attach', 'Attach PDF', `  [6] Attaching PDF...`);
  await attachFile(page, formCtx, filePath);
  await saveForm(page, formCtx, unit);

  return { unit, docDate, title, docType: 'Registration', category: 'keyfob', ownerTenant: null, occupants: null };
}

// Take only what is needed — the unit and the date — and ignore the rest of the
// name. A "#" log number, "for"/"on" filler, a trailing O/T: all read straight
// past rather than validated, so extra information in a filename can never fail
// a key log. The unit is the one genuinely required piece.
//
// The date is optional as well: key logs used to carry none, and for those
// today's date is the right answer (it is when the receipt was filed). When the
// filename does carry a date, that date wins — it is when the keys actually
// changed hands.
async function uploadKeyLog(page, filename) {
  const unit    = extractUnit(filename);
  if (!unit)    throw new Error(`Cannot extract unit number from filename: ${filename}`);

  const fileDate = extractDateFromFilename(filename);
  const docDate  = fileDate || todayDate();
  const filePath = path.join(FILES_DIR, filename);

  log(`\n${'─'.repeat(65)}`);
  log(`🔑 KEY CONTROL LOG`);
  log(`   File: ${filename}`);
  log(`   Unit: ${unit}   Date: ${docDate}${fileDate ? '' : ' (today — no date in filename)'}`);
  log(`${'─'.repeat(65)}`);

  const title = 'Emergency & Convenience Key Receipt';
  const formCtx = await openAddDocForm(page, unit);
  stepBegin('form', 'Form fill', `  [5] Filling form...`);
  await fillTitle(formCtx, title);
  await fillType(formCtx, 'Correspondence');
  await fillAssociation(page, formCtx, 'unit');
  await fillDate(formCtx, docDate);
  stepBegin('attach', 'Attach PDF', `  [6] Attaching PDF...`);
  await attachFile(page, formCtx, filePath);
  await saveForm(page, formCtx, unit);

  return { unit, docDate, title, docType: 'Correspondence', category: 'keylog', ownerTenant: null, occupants: null };
}

async function uploadLease(page, filename) {
  const unit  = extractUnit(filename);
  const dates = extractAllDates(filename); // [expiration, ..., signed]
  if (!unit)             throw new Error(`Cannot extract unit number from filename: ${filename}`);
  if (dates.length < 2)  throw new Error(`Lease agreement needs two dates (expiration + signed): ${filename}`);

  const expiration = dates[0];                 // first date = expiration
  const docDate    = dates[dates.length - 1];  // last date  = date signed
  const title      = `Lease Agreement (${expiration})`;
  const filePath   = path.join(FILES_DIR, filename);

  log(`\n${'─'.repeat(65)}`);
  log(`📄 LEASE AGREEMENT`);
  log(`   File: ${filename}`);
  log(`   Unit: ${unit}   Expires: ${expiration}   Signed: ${docDate}`);
  log(`${'─'.repeat(65)}`);

  const formCtx = await openAddDocForm(page, unit);
  stepBegin('form', 'Form fill', `  [5] Filling form...`);
  await fillTitle(formCtx, title);
  await fillType(formCtx, 'Lease Documents');
  await fillAssociation(page, formCtx, 'occupancy');
  await fillDate(formCtx, docDate);
  stepBegin('attach', 'Attach PDF', `  [6] Attaching PDF...`);
  await attachFile(page, formCtx, filePath);
  await saveForm(page, formCtx, unit);

  return { unit, docDate, title, docType: 'Lease Documents', category: 'lease', ownerTenant: null, occupants: null };
}

async function uploadAddendum(page, filename) {
  const unit    = extractUnit(filename);
  const docDate = extractDateFromFilename(filename); // single trailing date = signed
  if (!unit)    throw new Error(`Cannot extract unit number from filename: ${filename}`);
  if (!docDate) throw new Error(`Cannot extract date from filename (expected MM-DD-YY at end): ${filename}`);

  const filePath = path.join(FILES_DIR, filename);

  log(`\n${'─'.repeat(65)}`);
  log(`📑 LEASE ADDENDUM`);
  log(`   File: ${filename}`);
  log(`   Unit: ${unit}   Signed: ${docDate}`);
  log(`${'─'.repeat(65)}`);

  const title = 'Lease Addendum';
  const formCtx = await openAddDocForm(page, unit);
  stepBegin('form', 'Form fill', `  [5] Filling form...`);
  await fillTitle(formCtx, title);
  await fillType(formCtx, 'Lease Documents');
  await fillAssociation(page, formCtx, 'occupancy');
  await fillDate(formCtx, docDate);
  stepBegin('attach', 'Attach PDF', `  [6] Attaching PDF...`);
  await attachFile(page, formCtx, filePath);
  await saveForm(page, formCtx, unit);

  return { unit, docDate, title, docType: 'Lease Documents', category: 'addendum', ownerTenant: null, occupants: null };
}

// ───────────────────────────────────────────────────────────────
// MOVE IN / MOVE OUT / BUILDINGLINK REGISTRATION FORMS (3 variations).
// Shared parsing: unit (standard), initials (two letters before the date,
// same as parking permits), date (MM-DD-YY at end). Occupant is matched by
// initials via selectOccupantsMoveIn; owner/tenant for folder routing comes
// from the matched occupant's red "Renter" label, not the filename.
// ───────────────────────────────────────────────────────────────

// Variation 1 ("Move In & BuildingLink Form") and Variation 3 ("Move In
// Application") are identical except for Document Type and destination folder,
// so they share this single-document handler.
//   opts = { category, docType, label, emoji }
async function uploadMoveInSingle(page, filename, opts) {
  const { category, docType, label, emoji } = opts;
  const unit     = extractUnit(filename);
  const initials = extractInitials(filename);
  const docDate  = extractDateFromFilename(filename);
  if (!unit)     throw new Error(`Cannot extract unit number from filename: ${filename}`);
  if (!initials) throw new Error(`Cannot extract occupant initials (expected two letters before the date) from filename: ${filename}`);
  if (!docDate)  throw new Error(`Cannot extract date from filename (expected MM-DD-YY at end): ${filename}`);

  const title    = `Move in request for (${docDate})`;
  const filePath = path.join(FILES_DIR, filename);

  log(`\n${'─'.repeat(65)}`);
  log(`${emoji} ${label}`);
  log(`   File: ${filename}`);
  log(`   Unit: ${unit}   Initials: ${initials}   Date: ${docDate}`);
  log(`${'─'.repeat(65)}`);

  const formCtx = await openAddDocForm(page, unit);
  stepBegin('form', 'Form fill', `  [5] Filling form...`);
  await fillTitle(formCtx, title);
  await fillType(formCtx, docType);
  await fillAssociation(page, formCtx, 'specific');
  // Pauses for a numbered prompt if several occupants share the initials;
  // throws (→ error pause) on no match.
  const { isRenter, names } = await selectOccupantsMoveIn(page, formCtx, initials, unit);
  await fillDate(formCtx, docDate);
  stepBegin('attach', 'Attach PDF', `  [6] Attaching PDF...`);
  await attachFile(page, formCtx, filePath);
  await saveForm(page, formCtx, unit);

  const ownerTenant = isRenter ? 'T' : 'O';
  return { unit, docDate, title, docType, category, ownerTenant, occupants: names };
}

// Variation 1 — "Move In & BuildingLink Form": Registration, → Registrations folder.
function uploadMoveInBuildingLink(page, filename) {
  return uploadMoveInSingle(page, filename, {
    category: 'movein1', docType: 'Registration',
    label: 'MOVE IN & BUILDINGLINK FORM', emoji: '📦',
  });
}

// Variation 3 — "Move In Application": Reservation, → Reservations folder.
function uploadMoveInApplication(page, filename) {
  return uploadMoveInSingle(page, filename, {
    category: 'movein3', docType: 'Reservation',
    label: 'MOVE IN APPLICATION', emoji: '📦',
  });
}

// Standalone "Move Out Form" ("Move Out Form for 2-0438 03-16-2026"). Associated
// with the PHYSICAL UNIT, for the same reason returned parking permits are — the
// person moving out has often already been removed from the occupant list by the
// time the form is filed, so matching by initials failed more often than it
// worked. The unit is the one thing always known.
//
// Consequences: no initials matching, no occupant selection, and no numbered
// prompt (nothing here can be ambiguous). Initials left in the filename are
// ignored harmlessly — they are no longer required. With no matched occupant
// there is no Owner/Tenant role to read either, so these always file under the
// TENANT Reservations folder: a move-out is by nature a tenant event.
async function uploadMoveOutForm(page, filename) {
  const unit    = extractUnit(filename);
  const docDate = extractDateFromFilename(filename);
  if (!unit)    throw new Error(`Cannot extract unit number from filename: ${filename}`);
  if (!docDate) throw new Error(`Cannot extract date from filename (expected MM-DD-YY at end): ${filename}`);

  const title    = `Move out request for (${docDate})`;
  const filePath = path.join(FILES_DIR, filename);

  log(`\n${'─'.repeat(65)}`);
  log(`📦 MOVE OUT FORM`);
  log(`   File: ${filename}`);
  log(`   Unit: ${unit}   Date: ${docDate}`);
  log(`${'─'.repeat(65)}`);

  const formCtx = await openAddDocForm(page, unit);
  stepBegin('form', 'Form fill', `  [5] Filling form...`);
  await fillTitle(formCtx, title);
  await fillType(formCtx, 'Reservation');
  await fillAssociation(page, formCtx, 'unit');
  await fillDate(formCtx, docDate);
  stepBegin('attach', 'Attach PDF', `  [6] Attaching PDF...`);
  await attachFile(page, formCtx, filePath);
  await saveForm(page, formCtx, unit);

  return { unit, docDate, title, docType: 'Reservation', category: 'moveout', ownerTenant: 'T', occupants: null };
}

// Variation 2 — "Move In & Move Out" (tenant moves from one unit to another).
// Creates TWO separate documents from the same PDF:
//   Doc 1 (Move Out): Reservation, associated with the specific occupant moving out.
//   Doc 2 (Move In) : Reservation, associated with THE OCCUPANCY (the new tenant
//                     isn't in the system yet), via RdoAssignUnit.
async function uploadMoveInMoveOut(page, filename) {
  const units    = extractUnits(filename); // ["<old/from>", "<new/to>"]
  const initials = extractInitials(filename);
  const docDate  = extractDateFromFilename(filename);
  if (units.length === 0) throw new Error(`Cannot extract unit number from filename: ${filename}`);
  if (!initials)          throw new Error(`Cannot extract occupant initials (expected two letters before the date) from filename: ${filename}`);
  if (!docDate)           throw new Error(`Cannot extract date from filename (expected MM-DD-YY at end): ${filename}`);

  // Doc 1 (move-out) → the old unit (physical-unit association, no occupant
  // matching — the mover-out has left the system); Doc 2 (move-in) → the new
  // unit, matching the mover-in by the filename initials. A single-unit filename
  // falls back to the same unit for both.
  const fromUnit = units[0];
  const toUnit   = units[1] || units[0];
  const title    = `Move in & Move out form for (${docDate})`;
  const filePath = path.join(FILES_DIR, filename);

  log(`\n${'─'.repeat(65)}`);
  log(`📦 MOVE IN & MOVE OUT`);
  log(`   File: ${filename}`);
  log(`   From: ${fromUnit} → To: ${toUnit}   Initials: ${initials}   Date: ${docDate}`);
  log(`${'─'.repeat(65)}`);

  // ── Document 1 — Move Out: the physical unit, OLD unit ──
  // The person moving out is no longer in the system for the old unit, so there
  // is no occupant to match — associate with the physical unit instead.
  log(`  ► Document 1 of 2 (Move Out — physical unit @ ${fromUnit})`);
  let formCtx = await openAddDocForm(page, fromUnit);
  stepBegin('form', 'Form fill', `  [5] Filling form...`);
  await fillTitle(formCtx, title);
  await fillType(formCtx, 'Reservation');
  await fillAssociation(page, formCtx, 'unit');
  await fillDate(formCtx, docDate);
  stepBegin('attach', 'Attach PDF', `  [6] Attaching PDF...`);
  await attachFile(page, formCtx, filePath);
  await saveForm(page, formCtx, fromUnit);

  // Doc 1 is now in BuildingLink, so this PDF is part-uploaded. Doc 2 must
  // follow even if the operator stops the run — stopping here would leave the
  // move-out document filed, the PDF in the source folder, and a re-run would
  // add a second copy of Doc 1. Same reasoning as multi-unit files; the two
  // documents of a movein2 are one indivisible piece of work.
  //
  // (If Doc 2 needs the numbered occupant prompt, the run waits on that answer
  // before it can honour a Stop. The operator has to answer it either way, and
  // an orphaned Doc 1 is the worse outcome.)
  const commit = { committed: false };
  multiUnitCommit(commit, [fromUnit, toUnit]);
  let names;
  try {
    // ── Document 2 — Move In: specific occupant by initials, NEW unit ──
    // The person moving in is already registered in the new unit, so match them
    // by the filename initials (same logic as the other move-in forms).
    log(`  ► Document 2 of 2 (Move In — specific occupant @ ${toUnit})`);
    formCtx = await openAddDocForm(page, toUnit);
    stepBegin('form', 'Form fill', `  [5] Filling form...`);
    await fillTitle(formCtx, title);
    await fillType(formCtx, 'Reservation');
    await fillAssociation(page, formCtx, 'specific');
    // Matches the mover-in by initials; pauses for a numbered prompt if several
    // occupants share the initials. Throws (→ error pause) on no match.
    ({ names } = await selectOccupantsMoveIn(page, formCtx, initials, toUnit));
    await fillDate(formCtx, docDate);
    stepBegin('attach', 'Attach PDF', `  [6] Attaching PDF...`);
    await attachFile(page, formCtx, filePath);
    await saveForm(page, formCtx, toUnit);
  } finally {
    multiUnitRelease(commit);
  }

  // Move In & Move Out is always a tenant situation → file under the NEW unit's
  // Tenant Reservations folder (ownerTenant 'T' selects that path in destFolder).
  // Title reflects both docs; occupants = the mover-in matched on the new unit.
  return { unit: toUnit, docDate, title, docType: 'Reservation', category: 'movein2', ownerTenant: 'T', occupants: names };
}

// ───────────────────────────────────────────────────────────────
// MEETING ROOM RENTAL CONTRACT
// Shared parsing: unit (standard), initials (two letters before the date),
// date (MM-DD-YYYY at end = date signed). Occupant matched by initials via
// selectOccupantsMoveIn; owner/tenant for folder routing comes from the matched
// occupant's red "Renter" label, not the filename. Title carries the signed year.
// ───────────────────────────────────────────────────────────────
async function uploadMeetingRoom(page, filename) {
  const unit     = extractUnit(filename);
  const initials = extractInitials(filename);
  const docDate  = extractDateFromFilename(filename); // single trailing date = signed
  if (!unit)     throw new Error(`Cannot extract unit number from filename: ${filename}`);
  if (!initials) throw new Error(`Cannot extract occupant initials (expected two letters before the date) from filename: ${filename}`);
  if (!docDate)  throw new Error(`Cannot extract date from filename (expected MM-DD-YY at end): ${filename}`);

  const year     = docDate.split('/')[2];
  const title    = `Meeting Room Rental Contract (${year})`;
  const filePath = path.join(FILES_DIR, filename);

  log(`\n${'─'.repeat(65)}`);
  log(`🏛️ MEETING ROOM RENTAL CONTRACT`);
  log(`   File: ${filename}`);
  log(`   Unit: ${unit}   Initials: ${initials}   Signed: ${docDate}`);
  log(`${'─'.repeat(65)}`);

  const formCtx = await openAddDocForm(page, unit);
  stepBegin('form', 'Form fill', `  [5] Filling form...`);
  await fillTitle(formCtx, title);
  await fillType(formCtx, 'Reservation');
  await fillAssociation(page, formCtx, 'specific');
  // Matches the occupant by initials; pauses for a numbered prompt if several
  // occupants share the initials. Throws (→ error pause) on no match.
  const { isRenter, names } = await selectOccupantsMoveIn(page, formCtx, initials, unit);
  await fillDate(formCtx, docDate);
  stepBegin('attach', 'Attach PDF', `  [6] Attaching PDF...`);
  await attachFile(page, formCtx, filePath);
  await saveForm(page, formCtx, unit);

  const ownerTenant = isRenter ? 'T' : 'O';
  return { unit, docDate, title, docType: 'Reservation', category: 'meetingroom', ownerTenant, occupants: names };
}

// ───────────────────────────────────────────────────────────────
// GUEST ROOM RESERVATION
// Parsing: unit (standard), trailing date (MM-DD-YY); the title carries the
// date's year. Occupancy-associated (RdoAssignUnit, via fillAssociation
// 'occupancy') and always filed under the unit owner's Reservations folder
// (never created).
// ───────────────────────────────────────────────────────────────
async function uploadGuestRoom(page, filename) {
  const unit    = extractUnit(filename);
  const docDate = extractDateFromFilename(filename);
  if (!unit)    throw new Error(`Cannot extract unit number from filename: ${filename}`);
  if (!docDate) throw new Error(`Cannot extract date from filename (expected MM-DD-YY at end): ${filename}`);

  const year     = docDate.split('/')[2];
  const title    = `Guest Room Reservation Request (${year})`;
  const filePath = path.join(FILES_DIR, filename);

  log(`\n${'─'.repeat(65)}`);
  log(`🛏️ GUEST ROOM RESERVATION`);
  log(`   File: ${filename}`);
  log(`   Unit: ${unit}   Date: ${docDate}`);
  log(`${'─'.repeat(65)}`);

  const formCtx = await openAddDocForm(page, unit);
  stepBegin('form', 'Form fill', `  [5] Filling form...`);
  await fillTitle(formCtx, title);
  await fillType(formCtx, 'Reservation');
  await fillAssociation(page, formCtx, 'occupancy');
  await fillDate(formCtx, docDate);
  stepBegin('attach', 'Attach PDF', `  [6] Attaching PDF...`);
  await attachFile(page, formCtx, filePath);
  await saveForm(page, formCtx, unit);

  return { unit, docDate, title, docType: 'Reservation', category: 'guestroom', ownerTenant: null, occupants: null };
}

// ───────────────────────────────────────────────────────────────
// DELIVERY FORM
// Filename format: "Delivery Form for 2-0711 YH 06-10-2026.pdf".
// Parsing: unit (standard), initials (two letters before the date, same as
// parking permits), trailing date (MM-DD-YY = date of delivery). Matched to a
// specific occupant by initials (same numbered-prompt / no-match flow as the
// other initials-based types); owner/tenant comes from the matched occupant and
// routes the file to that role's Correspondence folder (never created).
// ───────────────────────────────────────────────────────────────
async function uploadDelivery(page, filename) {
  const unit     = extractUnit(filename);
  const initials = extractInitials(filename);
  const docDate  = extractDateFromFilename(filename);
  if (!unit)     throw new Error(`Cannot extract unit number from filename: ${filename}`);
  if (!initials) throw new Error(`Cannot extract occupant initials (expected two letters before the date) from filename: ${filename}`);
  if (!docDate)  throw new Error(`Cannot extract date from filename (expected MM-DD-YY at end): ${filename}`);

  const title    = `Delivery Request for (${docDate})`;
  const filePath = path.join(FILES_DIR, filename);

  log(`\n${'─'.repeat(65)}`);
  log(`📦 DELIVERY FORM`);
  log(`   File: ${filename}`);
  log(`   Unit: ${unit}   Initials: ${initials}   Date: ${docDate}`);
  log(`${'─'.repeat(65)}`);

  const formCtx = await openAddDocForm(page, unit);
  stepBegin('form', 'Form fill', `  [5] Filling form...`);
  await fillTitle(formCtx, title);
  await fillType(formCtx, 'Reservation');
  await fillAssociation(page, formCtx, 'specific');
  // Pauses for a numbered prompt if several occupants share the initials;
  // throws on no match / skipped prompt.
  const { isRenter, names } = await selectOccupantByInitials(page, formCtx, initials, unit);
  const ownerTenant  = isRenter ? 'T' : 'O'; // owner/tenant from the matched occupant
  await fillDate(formCtx, docDate);
  stepBegin('attach', 'Attach PDF', `  [6] Attaching PDF...`);
  await attachFile(page, formCtx, filePath);
  await saveForm(page, formCtx, unit);

  return { unit, docDate, title, docType: 'Reservation', category: 'delivery', ownerTenant, occupants: names && names.length ? names : null };
}

// ───────────────────────────────────────────────────────────────
// WORK ORDER — file organization only. These PDFs are already in BuildingLink,
// so there is NO upload step and no browser interaction: we only parse the unit
// and route the file into its Unit Owner Delete-Able Files\Work Orders folder.
// This is the ONLY category whose destination folder may be auto-created (most
// units won't have a "Work Orders" folder yet) — main passes createDest through
// to moveFileTo, which creates just that leaf folder if its parent exists.
// Returns skipUpload so main records "Upload: N/A (file organization only)".
// ───────────────────────────────────────────────────────────────
function organizeWorkOrder(filename) {
  const unit = extractUnit(filename);
  if (!unit) throw new Error(`Cannot extract unit number from filename: ${filename}`);

  log(`\n${'─'.repeat(65)}`);
  log(`🛠️ WORK ORDER (file organization only — no upload)`);
  log(`   File: ${filename}`);
  log(`   Unit: ${unit}`);
  log(`${'─'.repeat(65)}`);

  return {
    unit, docDate: null, title: null, docType: null, category: 'workorder',
    ownerTenant: null, occupants: null, skipUpload: true, createDest: true,
  };
}

// ───────────────────────────────────────────────────────────────
// COMMON AREA WORK ORDER — file organization only, like the unit work order
// above, and likewise with NO BuildingLink interaction whatsoever.
//
// What makes it different: it belongs to a BUILDING, not to a unit. There is no
// unit number in the name to parse — the building is read from the source
// subfolder the file was scanned out of ("bldg 2 common areas work orders" →
// Building 2) — and the only thing read from the filename is the trailing date,
// whose YEAR selects the destination subfolder:
//   S:\UNIT FILES\Building 2\Common Area\2026 Work Orders
//
// createDest is set for the same reason unit work orders set it: a new year
// needs its "<year> Work Orders" folder created. moveFileTo only ever creates
// that one leaf, and only if the building's "Common Area" folder already
// exists, so a misread building can't fabricate a folder tree.
// ───────────────────────────────────────────────────────────────
function organizeCommonAreaWorkOrder(filename) {
  const folder   = path.dirname(String(filename));
  const building = commonAreaBuildingOf(folder);
  if (!building) throw new Error(`Not in a recognized "bldg N common areas work orders" folder: ${filename}`);
  // Read the date off the BASENAME, so the folder name (which contains digits of
  // its own) can never be mistaken for part of it.
  const docDate = extractDateFromFilename(path.basename(String(filename)));
  if (!docDate) throw new Error(`Cannot extract date from filename: ${filename}`);
  const year    = docDate.split('/')[2];
  const destDir = commonAreaDestFolder(building, year);

  log(`\n${'─'.repeat(65)}`);
  log(`🏢 COMMON AREA WORK ORDER (file organization only — no upload)`);
  log(`   File    : ${path.basename(String(filename))}`);
  log(`   Folder  : ${folder}`);
  log(`   Building: ${building}   Year: ${year}`);
  log(`${'─'.repeat(65)}`);

  return {
    unit: `Building ${building} — Common Area`, docDate, title: null, docType: null,
    category: 'commonarea', ownerTenant: null, occupants: null,
    skipUpload: true, createDest: true, destDir,
  };
}

// ───────────────────────────────────────────────────────────────
// HOMEOWNERS / RENTERS INSURANCE — file organization only. Like work orders,
// these PDFs are NOT uploaded to BuildingLink: we only parse the unit and route
// the file into its Unit Owner Delete-Able Files\Correspondence folder. Policy
// numbers and company names vary widely, so the unit is anchored on the
// "for X-XXXX" portion of the name (falling back to standard extraction) to keep
// a dash-laden policy number from being mistaken for the unit. No folder is ever
// created. Returns skipUpload so main records "N/A (file organization only)".
// ───────────────────────────────────────────────────────────────
function organizeInsurance(filename) {
  const unit = extractUnitAfterFor(filename) || extractUnit(filename);
  if (!unit) throw new Error(`Cannot extract unit number from filename: ${filename}`);

  log(`\n${'─'.repeat(65)}`);
  log(`🛡️ INSURANCE (file organization only — no upload)`);
  log(`   File: ${filename}`);
  log(`   Unit: ${unit}`);
  log(`${'─'.repeat(65)}`);

  return {
    unit, docDate: null, title: null, docType: null, category: 'insurance',
    ownerTenant: null, occupants: null, skipUpload: true,
  };
}

// ───────────────────────────────────────────────────────────────
// RESALE PACKAGE — file organization only (like work orders / insurance). NOT
// uploaded to BuildingLink: parse the unit (standard extraction) and route the
// file into its Permanent Files\Resale Certificates folder. No folder is ever
// created. ("Resale Package Correspondence" is excluded by classifyFile and
// handled by the unknown prompt instead.) Returns skipUpload so main records
// "N/A (file organization only)".
// ───────────────────────────────────────────────────────────────
function organizeResale(filename) {
  const unit = extractUnit(filename);
  if (!unit) throw new Error(`Cannot extract unit number from filename: ${filename}`);

  log(`\n${'─'.repeat(65)}`);
  log(`🏷️ RESALE PACKAGE (file organization only — no upload)`);
  log(`   File: ${filename}`);
  log(`   Unit: ${unit}`);
  log(`${'─'.repeat(65)}`);

  return {
    unit, docDate: null, title: null, docType: null, category: 'resale',
    ownerTenant: null, occupants: null, skipUpload: true,
  };
}

// ───────────────────────────────────────────────────────────────
// UNKNOWN FILE TYPE — not recognized by classifyFile. Instead of leaving it
// unprocessed, prompt the operator for how to handle it:
//   1. Upload to BuildingLink (Correspondence, physical unit, today's date) AND
//      move to Unit Owner Delete-Able Files → Correspondence
//   2. Move to that same folder only (no BuildingLink upload)
//   3. Skip and handle manually (throws → file left in place)
// Either action needs a unit, parsed with standard extraction. The chosen option
// is always logged. Chrome is opened (via ensureBrowser) ONLY when the operator
// picks option 1 — reusing a session already open from an earlier file in the
// run. Options 2 (move only) and 3 (skip) never open Chrome.
// ───────────────────────────────────────────────────────────────
async function handleUnknown(ensureBrowser, filename) {
  // Extract the unit up front so the prompt can show which unit it's for. (May
  // be null — options 1 & 2 re-check and throw below if it's missing.)
  const unit = extractUnit(filename);

  let choice;
  while (true) {
    const ans = (await askChoice({
      kind: 'choice',
      title: 'Unknown file type',
      filename,
      unit: unit || '(none detected)',
      message: 'How should this unrecognized file be handled?',
      options: [
        { value: '1', label: 'Upload to BuildingLink + Move to Correspondence', description: "Adds the document to BuildingLink (Correspondence, physical unit, today's date), then files it under Unit Owner Delete-Able Files → Correspondence. Opens Chrome if it isn't already open." },
        { value: '2', label: 'Move to Correspondence Only (No Upload)', description: 'Skips BuildingLink entirely. Just files the PDF under Unit Owner Delete-Able Files → Correspondence.' },
        { value: '3', label: 'Skip — Handle Manually', description: 'Leaves the file where it is. Nothing is uploaded or moved.' },
      ],
    })).trim();
    if (ans === '1' || ans === '2' || ans === '3') { choice = ans; break; }
    log(`  ✗ Invalid input "${ans}" — choose 1, 2, or 3.`);
  }

  if (choice === '3') {
    log(`         ▶ Operator chose: 3 (skip — handle manually)`);
    throw new Error('Unknown file type — skipped by operator, file left in place.');
  }

  if (!unit) throw new Error(`Cannot extract unit number from filename: ${filename}`);
  const filePath = path.join(FILES_DIR, filename);

  if (choice === '2') {
    log(`         ▶ Operator chose: 2 (move only — no upload)`);
    return { unit, docDate: null, title: null, docType: null, category: 'unknownmove', ownerTenant: null, occupants: null, skipUpload: true };
  }

  // choice === '1' → upload then move. Open Chrome now if it isn't already
  // (reusing the session if an earlier file in this run opened it).
  log(`         ▶ Operator chose: 1 (upload to BuildingLink + move)`);
  const page    = await ensureBrowser();
  const docDate = todayDate();
  const title   = path.basename(filename, '.pdf'); // no known title convention — use the filename

  log(`   Unit: ${unit}   Date: ${docDate} (today)   Title: "${title}"`);
  const formCtx = await openAddDocForm(page, unit);
  stepBegin('form', 'Form fill', `  [5] Filling form...`);
  await fillTitle(formCtx, title);
  await fillType(formCtx, 'Correspondence');
  await fillAssociation(page, formCtx, 'unit');
  await fillDate(formCtx, docDate);
  stepBegin('attach', 'Attach PDF', `  [6] Attaching PDF...`);
  await attachFile(page, formCtx, filePath);
  await saveForm(page, formCtx, unit);

  return { unit, docDate, title, docType: 'Correspondence', category: 'unknownupload', ownerTenant: null, occupants: null };
}

// ───────────────────────────────────────────────────────────────
// MISCELLANEOUS CORRESPONDENCE — death certificates, final notices, complaint
// forms, water shut-off notices, returned mail, condo questionnaires, resale
// package correspondence (see CORRESPONDENCE_KEYWORDS for the full list).
//
// These have no shared title convention and no occupant to match — a death
// certificate names someone who is no longer an occupant, returned mail names
// whoever moved out — so, like returned parking permits, they are associated with
// the PHYSICAL UNIT and file under the Unit Owner's Correspondence folder.
//
// Title: the filename itself (minus ".pdf"), which is what these documents got
// when they went through the unknown-file prompt before this category existed.
// Date: the trailing date in the filename when there is one, otherwise today's —
// most of these names carry a date, but none of them is required to.
//
// ★ MULTI-UNIT (v2.19.0, 2026-08-17): one letter often concerns several units at
// once — "Correspondence 1-0307, 1-0306, 2-0534, … Accounts Incorrect
// 06-24-2022". EVERY unit in the name is read, and then, exactly like water
// leaks (uploadWaterLeak):
//   • ONE Correspondence document is uploaded PER UNIT, each associated with
//     that unit's physical unit, all carrying the SAME title;
//   • the PDF is then moved into the first unit's Correspondence folder and
//     COPIED into every other listed unit's, however many there are (multiDest
//     → placeWaterLeakFile).
//
// The title is the filename stem, which already names every affected unit — so
// it lists them all and stays identical across each upload, the same property
// the water-leak title has.
//
// ⚠️ The uploads are NOT atomic: if unit 4 of 6 fails, units 1-3 already have
// their document. The file stays in the source folder, so re-running would add
// duplicates to 1-3 — the error names the units that already succeeded so they
// can be sorted out by hand. This is the same tradeoff water leaks have always
// had; it is called out here because a 6-unit letter makes it far likelier.
// ───────────────────────────────────────────────────────────────
async function uploadCorrespondence(page, filename) {
  const units = extractUnits(filename); // every unit in the name, in filename order
  if (units.length === 0) throw new Error(`Cannot extract unit number from filename: ${filename}`);

  const fileDate = extractDateFromFilename(filename);
  const docDate  = fileDate || todayDate();
  const title    = path.basename(filename, '.pdf'); // no title convention — use the filename
  const filePath = path.join(FILES_DIR, filename);

  log(`\n${'─'.repeat(65)}`);
  log(`✉️ CORRESPONDENCE`);
  log(`   File: ${filename}`);
  log(`   Unit(s): ${units.join(', ')}   Date: ${docDate}${fileDate ? '' : ' (today — no date in filename)'}`);
  log(`   Title: "${title}"`);
  if (title.length > TITLE_MAX_LEN) {
    log(`   ⚠️  Title is ${title.length} chars — BuildingLink stores the first ${TITLE_MAX_LEN}.`);
  }
  log(`${'─'.repeat(65)}`);

  // One document per listed unit — same title, each associated with its own
  // physical unit (RdoPhysicalUnitBin, via fillAssociation 'unit').
  const done = [];
  // Once the first unit is saved the file is part-uploaded, so the rest must
  // finish even if the operator stops the run — see multiUnitCommit.
  const commit = { committed: false };
  try {
  for (let i = 0; i < units.length; i++) {
    const unit = units[i];
    if (units.length > 1) log(`  ► Document ${i + 1} of ${units.length} (physical unit @ ${unit})`);
    try {
      const formCtx = await openAddDocForm(page, unit);
      stepBegin('form', 'Form fill', `  [5] Filling form...`);
      await fillTitle(formCtx, title);
      await fillType(formCtx, 'Correspondence');
      await fillAssociation(page, formCtx, 'unit');
      await fillDate(formCtx, docDate);
      stepBegin('attach', 'Attach PDF', `  [6] Attaching PDF...`);
      await attachFile(page, formCtx, filePath);
      await saveForm(page, formCtx, unit);
      done.push(unit);
      multiUnitCommit(commit, units);
    } catch (err) {
      // Name the units already uploaded, so a re-run doesn't silently duplicate
      // them. Without this the operator only learns which unit FAILED.
      if (done.length) {
        throw new Error(
          `${err.message}\n` +
          `      ⚠️ ${done.length} of ${units.length} document(s) were ALREADY uploaded for this file ` +
          `(${done.join(', ')}) before ${unit} failed. The PDF was left in the source folder — re-running it ` +
          `would add a SECOND copy to ${done.length > 1 ? 'those units' : 'that unit'}, so upload only the ` +
          `remaining unit(s) by hand, or delete the ${done.join(', ')} copies first.`);
      }
      throw err;
    }
  }
  } finally {
    multiUnitRelease(commit);
  }

  // multiDest tells main to place the file across every listed unit's folder.
  // Harmless for the single-unit case: placeWaterLeakFile does a plain move when
  // there is only one destination, exactly as before.
  return { unit: units[0], units, docDate, title, docType: 'Correspondence', category: 'correspondence', ownerTenant: null, occupants: null, multiDest: true };
}

// ───────────────────────────────────────────────────────────────
// PROOF OF OWNERSHIP — deeds and powers of attorney (see OWNERSHIP_KEYWORDS).
//
// The correspondence handler's twin: no title convention (the filename IS the
// title), no occupant to match (a deed names a buyer/seller, a POA names an agent
// — neither is reliably an occupant), so it is associated with the PHYSICAL UNIT.
// Only the unit and the date are read; O/T flags, "#" numbers, names and any
// other descriptive text in the filename are ignored, never validated.
//
// Files under Permanent Files\Proof of Ownership, alongside ALTA settlements.
// Date: the trailing date when there is one, otherwise today's — a deed's
// filename often carries no date, and refusing the file over that would defeat
// the point of the category.
// ───────────────────────────────────────────────────────────────
async function uploadOwnership(page, filename) {
  const unit = extractUnit(filename);
  if (!unit) throw new Error(`Cannot extract unit number from filename: ${filename}`);

  const fileDate = extractDateFromFilename(filename);
  const docDate  = fileDate || todayDate();
  const title    = path.basename(filename, '.pdf'); // no title convention — use the filename
  const filePath = path.join(FILES_DIR, filename);

  log(`\n${'─'.repeat(65)}`);
  log(`📜 PROOF OF OWNERSHIP`);
  log(`   File: ${filename}`);
  log(`   Unit: ${unit}   Date: ${docDate}${fileDate ? '' : ' (today — no date in filename)'}`);
  log(`   Title: "${title}"`);
  log(`${'─'.repeat(65)}`);

  const formCtx = await openAddDocForm(page, unit);
  stepBegin('form', 'Form fill', `  [5] Filling form...`);
  await fillTitle(formCtx, title);
  await fillType(formCtx, 'Proof of Ownership');
  await fillAssociation(page, formCtx, 'unit');
  await fillDate(formCtx, docDate);
  stepBegin('attach', 'Attach PDF', `  [6] Attaching PDF...`);
  await attachFile(page, formCtx, filePath);
  await saveForm(page, formCtx, unit);

  return { unit, docDate, title, docType: 'Proof of Ownership', category: 'ownership', ownerTenant: null, occupants: null };
}

// ───────────────────────────────────────────────────────────────
// WATER LEAK — a single report that may affect one OR several units.
// Parsing: ALL unit numbers in the filename (separated by "&"), date
// (MM-DD-YYYY at end = date sent out). Title lists EVERY affected unit and
// stays the same across each upload, regardless of which unit it's filed under.
// Uploads one Correspondence document per affected unit (physical-unit
// association). main then places the file: one unit → move; many → copy into the
// secondary units' Damage Reports folders and move the original into the first
// unit's (multiDest flag — see placeWaterLeakFile).
// ───────────────────────────────────────────────────────────────
async function uploadWaterLeak(page, filename) {
  const units   = extractUnits(filename); // every unit, in filename order
  const docDate = extractDateFromFilename(filename);
  if (units.length === 0) throw new Error(`Cannot extract unit number from filename: ${filename}`);
  if (!docDate)           throw new Error(`Cannot extract date from filename (expected MM-DD-YYYY at end): ${filename}`);

  const year     = docDate.split('/')[2];
  const title    = `Water Leak (${units.join(', ')}) (${year})`; // all affected units
  const filePath = path.join(FILES_DIR, filename);

  log(`\n${'─'.repeat(65)}`);
  log(`💧 WATER LEAK`);
  log(`   File: ${filename}`);
  log(`   Unit(s): ${units.join(', ')}   Sent: ${docDate}`);
  log(`${'─'.repeat(65)}`);

  // One document per affected unit — same title, associated with each unit's
  // physical unit (RdoPhysicalUnitBin, via fillAssociation 'unit').
  // Once the first unit is saved the file is part-uploaded, so the rest must
  // finish even if the operator stops the run — see multiUnitCommit.
  const commit = { committed: false };
  try {
    for (let i = 0; i < units.length; i++) {
      const unit = units[i];
      log(`  ► Document ${i + 1} of ${units.length} (physical unit @ ${unit})`);
      const formCtx = await openAddDocForm(page, unit);
      stepBegin('form', 'Form fill', `  [5] Filling form...`);
      await fillTitle(formCtx, title);
      await fillType(formCtx, 'Correspondence');
      await fillAssociation(page, formCtx, 'unit');
      await fillDate(formCtx, docDate);
      stepBegin('attach', 'Attach PDF', `  [6] Attaching PDF...`);
      await attachFile(page, formCtx, filePath);
      await saveForm(page, formCtx, unit);
      multiUnitCommit(commit, units);
    }
  } finally {
    multiUnitRelease(commit);
  }

  // multiDest tells main to place the file across every affected unit's folder.
  return { unit: units[0], units, docDate, title, docType: 'Correspondence', category: 'waterleak', ownerTenant: null, occupants: null, multiDest: true };
}

// ═══════════════════════════════════════════════════════════════
// RUN LOG
// Append a detailed record of this run to upload_log_MM-DD-YYYY.txt in the
// script folder — one block per file plus a summary. Appends (not overwrites)
// so multiple runs on the same day accumulate. CRLF line endings for Notepad.
// ═══════════════════════════════════════════════════════════════
function writeRunLog(records, runStart, totals) {
  const L = [];
  L.push('='.repeat(70));
  L.push(`  BuildingLink Upload Run - started ${runStart}`);
  L.push('='.repeat(70));
  L.push('');
  records.forEach((r, i) => {
    L.push(`[${i + 1}] ${r.timestamp}`);
    L.push(`    Filename    : ${r.filename}`);
    L.push(`    Unit        : ${r.unit || 'N/A'}`);
    L.push(`    Title       : ${r.title || 'N/A'}`);
    L.push(`    Doc Type    : ${r.docType || 'N/A'}`);
    L.push(`    Occupant(s) : ${r.occupants && r.occupants.length ? r.occupants.join('; ') : 'N/A'}`);
    L.push(`    Upload      : ${r.uploadStatus}`);
    // Second attempts say so, and carry what went wrong the first time — a file
    // that only works on the retry is exactly what this log exists to surface.
    if (r.attempt > 1) {
      L.push(`    Attempt     : ${r.attempt} (automatic retry)`);
      if (r.firstError) L.push(`    First try   : ${r.firstError}`);
    }
    // Plain English first (what went wrong, in operator terms), raw underneath.
    if (r.plainError) L.push(`    Problem     : ${r.plainError}`);
    if (r.error)      L.push(`    Error       : ${r.error}`);
    L.push(`    Destination : ${r.destFolder || 'N/A'}`);
    L.push(`    File Move   : ${r.moveStatus}`);
    if (r.durationMs != null) L.push(`    Took        : ${fmtSecs(r.durationMs)}`);
    if (r.steps && r.steps.length) {
      L.push(`    Steps       : ${r.steps.map(s => `${s.label} ${fmtSecs(s.ms)}`).join('  |  ')}`);
    }
    L.push('');
  });
  L.push('-'.repeat(70));
  L.push('  SUMMARY');
  L.push('-'.repeat(70));
  L.push(`  Total files processed : ${totals.processed}`);
  L.push(`  Successful uploads    : ${totals.successUploads}`);
  L.push(`  Files moved           : ${totals.movedCount}`);
  L.push(`  Errors                : ${totals.errorCount}`);
  if (totals.retried) {
    L.push(`  Automatic retries     : ${totals.retried} (${totals.retriedOk} then succeeded)`);
  }
  if (totals.durationMs != null) {
    L.push(`  Total time            : ${formatDuration(totals.durationMs)}` +
           `${totals.pausedMs > 1000 ? ` (including ${formatDuration(totals.pausedMs)} paused)` : ''}`);
    L.push(`  Average rate          : ${totals.filesPerMin ? totals.filesPerMin.toFixed(1) + ' files/min' : 'N/A'}`);
  }
  if (totals.needAttention.length) {
    L.push(`  Needs manual attention:`);
    totals.needAttention.forEach(r => {
      L.push(`    - ${r.filename}`);
      L.push(`        ${r.plainError || r.error || 'uploaded but not moved'}`);
    });
  } else {
    L.push(`  Needs manual attention: none`);
  }
  // Step breakdown — same ordering as the on-screen summary (costliest first).
  if (totals.stepRows && totals.stepRows.length) {
    L.push('');
    L.push(`  AVERAGE STEP TIMES (across ${totals.processed} file(s))`);
    const pad = Math.max(...totals.stepRows.map(r => r.label.length));
    totals.stepRows.forEach(r =>
      L.push(`    ${r.label.padEnd(pad)}  ${fmtSecs(r.avgMs).padStart(7)} avg   ` +
             `x${String(r.count).padEnd(4)}  ${fmtSecs(r.totalMs).padStart(8)} total  ` +
             `${(r.share * 100).toFixed(0).padStart(3)}%`));
  }
  L.push('');
  L.push('');

  const file = logFilePath();
  fs.appendFileSync(file, L.join('\r\n'), 'utf8');
  return file;
}

// ═══════════════════════════════════════════════════════════════
// DRY RUN  (node upload.js --dry-run)
// Pure, offline planning: classify + parse each file and report exactly what the
// real run WOULD do — no Chrome, no BuildingLink, no file moves. The title/type/
// association literals here mirror the upload handlers above; keep them in sync.
// The ONE thing a dry run can't know is the matched occupant's Owner/Tenant role
// for initials-based types (it's decided live against the occupant list), so for
// those the destination is shown for BOTH roles and flagged.
// ═══════════════════════════════════════════════════════════════

// Human-friendly association labels (mirror fillAssociation's modes).
const ASSOC = {
  unit:      'Physical Unit (RdoPhysicalUnitBin)',
  occupancy: 'Occupancy (RdoAssignUnit)',
  specific:  'Only specific occupant(s) (RdoAssignUser)',
  none:      'N/A (no BuildingLink upload)',
};

// Plan a single file: returns what the real run would do, derived from the
// filename alone. { filename, type, title, docType, association, date, dests[],
// error, notes[] }. Never throws — extraction failures become `error`.
function planFile(filename) {
  const type = classifyFile(filename);
  const p = { filename, type, title: null, docType: null, association: null, date: null, dests: [], error: null, notes: [] };

  // destFolder, but capturing its throw as a readable token instead of crashing.
  const dest = (unit, cat, ot) => { try { return destFolder(unit, cat, ot); } catch (e) { return `‹${e.message}›`; } };
  // Occupant-dependent destination: role unknown offline → show both.
  const occDep = (unit, cat) => {
    p.dests = [`Owner  → ${dest(unit, cat, 'O')}`, `Tenant → ${dest(unit, cat, 'T')}`];
    p.notes.push('Destination depends on the matched occupant (Owner vs Tenant) — decided live.');
  };

  try {
    switch (type) {
      case 'skip':
        p.notes.push('Skipped (building account) — not processed.');
        break;

      case 'inspection': {
        const units = extractUnits(filename), docDate = extractDateFromFilename(filename);
        p.docType = 'Inspection'; p.association = ASSOC.unit;
        if (!units.length) { p.error = 'missing unit number'; break; }
        if (!docDate)      { p.error = 'missing date (MM-DD-YYYY at end)'; break; }
        p.title = `${docDate.split('/')[2]} Unit Inspection & Compliance Checklist`;
        p.date = docDate; p.dests = units.map(u => dest(u, 'inspection', null));
        if (units.length > 1) p.notes.push(`Multi-unit (${units.join(', ')}): one upload per unit; file copied into the other unit folder(s), then the original moved into ${units[0]}.`);
        break;
      }

      case 'windowreplacement': {
        const unit = extractUnit(filename), docDate = extractDateFromFilename(filename);
        p.docType = 'Correspondence'; p.association = ASSOC.unit;
        if (!unit)    { p.error = 'missing unit number'; break; }
        if (!docDate) { p.error = 'missing date (MM-DD-YYYY at end)'; break; }
        p.title = `Window Replacement Request (${docDate.split('/')[2]})`;
        p.date = docDate; p.dests = [dest(unit, 'windowreplacement', null)];
        break;
      }

      case 'alta': {
        const unit = extractUnit(filename), docDate = extractDateFromFilename(filename);
        p.docType = 'Proof of Ownership'; p.association = ASSOC.unit;
        if (!unit)    { p.error = 'missing unit number'; break; }
        if (!docDate) { p.error = 'missing date (MM-DD-YYYY at end)'; break; }
        p.title = `ALTA Settlement Statement (${docDate.split('/')[2]})`;
        p.date = docDate; p.dests = [dest(unit, 'alta', null)];
        break;
      }

      case 'storagebin': {
        const unit = extractUnit(filename), bins = extractHashNumbers(filename), docDate = extractDateFromFilename(filename);
        const cancelled = parseBase(filename).toLowerCase().includes('cancelled');
        p.docType = 'Registration'; p.association = ASSOC.occupancy;
        if (!unit)      { p.error = 'missing unit number'; break; }
        if (!bins.length) { p.error = 'missing bin number (expected "#2-9-392")'; break; }
        if (!docDate)   { p.error = 'missing date (MM-DD-YYYY at end)'; break; }
        p.title = cancelled ? `Cancelled Storage Bin ${formatHashNumbers(bins)}` : `Storage Bin Assignment ${formatHashNumbers(bins)}`;
        p.date = docDate; p.dests = [dest(unit, 'storagebin', null)];
        break;
      }

      case 'yardsale': {
        const unit = extractUnit(filename), ot = extractOwnerTenantBeforeDate(filename), docDate = extractDateFromFilename(filename);
        p.docType = 'Signed Documents & Waivers'; p.association = ASSOC.occupancy;
        if (!unit)    { p.error = 'missing unit number'; break; }
        if (!ot)      { p.error = 'missing Owner/Tenant flag (expected "O" or "T" before the date)'; break; }
        if (!docDate) { p.error = 'missing date (MM-DD-YYYY at end)'; break; }
        p.title = `Yard Sale Registration (${docDate.split('/')[2]})`;
        p.date = docDate; p.dests = [dest(unit, 'yardsale', ot)];
        break;
      }

      case 'blform': {
        const unit = extractUnit(filename), docDate = extractDateFromFilename(filename);
        const ot = extractOwnerTenantBeforeDate(filename) || extractOwnerTenant(filename);
        p.docType = 'Registration'; p.association = ASSOC.occupancy;
        if (!unit)    { p.error = 'missing unit number'; break; }
        if (!ot)      { p.error = 'missing Owner/Tenant flag (expected "O" or "T" before the date)'; break; }
        if (!docDate) { p.error = 'missing date (MM-DD-YYYY at end)'; break; }
        p.title = `BuildingLink Form (${docDate})`;
        p.date = docDate; p.dests = [dest(unit, 'blform', ot)];
        break;
      }

      case 'poolpass': {
        const unit = extractUnit(filename), docDate = extractDateFromFilename(filename), ot = extractOwnerTenant(filename);
        p.docType = 'Registration'; p.association = ASSOC.specific;
        if (!unit)    { p.error = 'missing unit number'; break; }
        if (!docDate) { p.error = 'missing date (MM-DD-YY at end)'; break; }
        if (!ot)      { p.error = 'missing Owner/Tenant flag (expected "O" or "T" at end)'; break; }
        p.title = `${docDate.split('/')[2]} Pool Pass Application`;
        p.date = docDate; p.dests = [dest(unit, 'poolpass', ot)];
        p.notes.push(`Occupant(s) selected by role from filename flag "${ot}" (${ot === 'O' ? 'Owner' : 'Tenant'}).`);
        break;
      }

      case 'parking': {
        const unit = extractUnit(filename), permitNos = extractHashNumbers(filename), initials = extractInitials(filename), docDate = extractDateFromFilename(filename);
        p.docType = 'Registration'; p.association = ASSOC.specific;
        if (!unit)             { p.error = 'missing unit number'; break; }
        if (!permitNos.length) { p.error = 'missing permit number (expected "#1-0376")'; break; }
        if (!initials)         { p.error = 'missing occupant initials (two letters before the date)'; break; }
        if (!docDate)          { p.error = 'missing date (MM-DD-YY at end)'; break; }
        p.title = `Vehicle Parking Permit (${formatHashNumbers(permitNos)})`; p.date = docDate;
        p.notes.push(`Occupant matched by initials "${initials}".`); occDep(unit, 'parking');
        break;
      }

      case 'returnedparking': {
        const unit = extractUnit(filename), permitNos = extractHashNumbers(filename);
        p.docType = 'Registration'; p.association = ASSOC.unit;
        if (!unit)             { p.error = 'missing unit number'; break; }
        if (!permitNos.length) { p.error = 'missing permit number (expected "#1-0376")'; break; }
        p.title = `Returned Vehicle Parking Permit (${formatHashNumbers(permitNos)})`;
        p.date = `${todayDate()} (today — no date in filename)`;
        p.dests = [dest(unit, 'returnedparking', 'O')];
        p.notes.push('Associated with the physical unit — no occupant matching, so no initials are needed in the filename.');
        break;
      }

      case 'bicycle': {
        const unit = extractUnit(filename), permitNos = extractHashNumbers(filename), initials = extractInitials(filename), docDate = extractDateFromFilename(filename);
        p.docType = 'Registration'; p.association = ASSOC.specific;
        if (!unit)             { p.error = 'missing unit number'; break; }
        if (!permitNos.length) { p.error = 'missing permit number (expected "#1234")'; break; }
        if (!initials)         { p.error = 'missing occupant initials (two letters before the date)'; break; }
        if (!docDate)          { p.error = 'missing date (MM-DD-YY at end)'; break; }
        p.title = `Bicycle Registration (${formatHashNumbers(permitNos)})`; p.date = docDate;
        p.notes.push(`Occupant matched by initials "${initials}".`); occDep(unit, 'bicycle');
        break;
      }

      case 'keyfob': {
        const unit = extractUnit(filename), fobNos = extractHashNumbers(filename), docDate = extractDateFromFilename(filename);
        p.docType = 'Registration'; p.association = ASSOC.occupancy;
        if (!unit)          { p.error = 'missing unit number'; break; }
        if (!fobNos.length) { p.error = 'missing fob number (expected "#1234")'; break; }
        if (!docDate)       { p.error = 'missing date (MM-DD-YY at end)'; break; }
        p.title = `Key FOB (${formatHashNumbers(fobNos)})`; p.date = docDate; p.dests = [dest(unit, 'keyfob', null)];
        break;
      }

      case 'keylog': {
        // Unit and date only — everything else in the name is ignored, never
        // validated, so extra text cannot produce an error here either.
        const unit = extractUnit(filename), fileDate = extractDateFromFilename(filename);
        p.docType = 'Correspondence'; p.association = ASSOC.unit;
        if (!unit) { p.error = 'missing unit number'; break; }
        p.title = 'Emergency & Convenience Key Receipt';
        p.date = fileDate || `${todayDate()} (today — no date in filename)`;
        p.dests = [dest(unit, 'keylog', null)];
        break;
      }

      case 'lease': {
        const unit = extractUnit(filename), dates = extractAllDates(filename);
        p.docType = 'Lease Documents'; p.association = ASSOC.occupancy;
        if (!unit)            { p.error = 'missing unit number'; break; }
        if (dates.length < 2) { p.error = 'lease needs two dates (expiration + signed)'; break; }
        p.title = `Lease Agreement (${dates[0]})`;
        p.date = `${dates[dates.length - 1]} (signed)`; p.dests = [dest(unit, 'lease', null)];
        break;
      }

      case 'addendum': {
        const unit = extractUnit(filename), docDate = extractDateFromFilename(filename);
        p.docType = 'Lease Documents'; p.association = ASSOC.occupancy;
        if (!unit)    { p.error = 'missing unit number'; break; }
        if (!docDate) { p.error = 'missing date (MM-DD-YY at end)'; break; }
        p.title = 'Lease Addendum'; p.date = docDate; p.dests = [dest(unit, 'addendum', null)];
        break;
      }

      case 'movein1':
      case 'movein3': {
        const unit = extractUnit(filename), initials = extractInitials(filename), docDate = extractDateFromFilename(filename);
        p.docType = type === 'movein1' ? 'Registration' : 'Reservation'; p.association = ASSOC.specific;
        if (!unit)     { p.error = 'missing unit number'; break; }
        if (!initials) { p.error = 'missing occupant initials (two letters before the date)'; break; }
        if (!docDate)  { p.error = 'missing date (MM-DD-YY at end)'; break; }
        p.title = `Move in request for (${docDate})`; p.date = docDate;
        p.notes.push(`Occupant matched by initials "${initials}".`); occDep(unit, type);
        break;
      }

      case 'movein2': {
        const units = extractUnits(filename), initials = extractInitials(filename), docDate = extractDateFromFilename(filename);
        p.docType = 'Reservation'; p.association = `${ASSOC.unit} (move-out) + ${ASSOC.specific} (move-in)`;
        if (!units.length) { p.error = 'missing unit number'; break; }
        if (!initials)     { p.error = 'missing occupant initials (two letters before the date)'; break; }
        if (!docDate)      { p.error = 'missing date (MM-DD-YY at end)'; break; }
        const from = units[0], to = units[1] || units[0];
        p.title = `Move in & Move out form for (${docDate})`; p.date = docDate;
        p.dests = [dest(to, 'movein2', 'T')];
        p.notes.push(`Two documents: Move Out @ ${from} (physical unit), Move In @ ${to} (occupant "${initials}"). Always filed as Tenant.`);
        break;
      }

      case 'meetingroom': {
        const unit = extractUnit(filename), initials = extractInitials(filename), docDate = extractDateFromFilename(filename);
        p.docType = 'Reservation'; p.association = ASSOC.specific;
        if (!unit)     { p.error = 'missing unit number'; break; }
        if (!initials) { p.error = 'missing occupant initials (two letters before the date)'; break; }
        if (!docDate)  { p.error = 'missing date (MM-DD-YY at end)'; break; }
        p.title = `Meeting Room Rental Contract (${docDate.split('/')[2]})`; p.date = docDate;
        p.notes.push(`Occupant matched by initials "${initials}".`); occDep(unit, 'meetingroom');
        break;
      }

      case 'guestroom': {
        const unit = extractUnit(filename), docDate = extractDateFromFilename(filename);
        p.docType = 'Reservation'; p.association = ASSOC.occupancy;
        if (!unit)    { p.error = 'missing unit number'; break; }
        if (!docDate) { p.error = 'missing date (MM-DD-YYYY at end)'; break; }
        p.title = `Guest Room Reservation Request (${docDate.split('/')[2]})`;
        p.date = docDate; p.dests = [dest(unit, 'guestroom', null)];
        break;
      }

      case 'delivery': {
        const unit = extractUnit(filename), initials = extractInitials(filename), docDate = extractDateFromFilename(filename);
        p.docType = 'Reservation'; p.association = ASSOC.specific;
        if (!unit)     { p.error = 'missing unit number'; break; }
        if (!initials) { p.error = 'missing occupant initials (two letters before the date)'; break; }
        if (!docDate)  { p.error = 'missing date (MM-DD-YY at end)'; break; }
        p.title = `Delivery Request for (${docDate})`; p.date = docDate;
        p.notes.push(`Occupant matched by initials "${initials}".`); occDep(unit, 'delivery');
        break;
      }

      case 'moveout': {
        const unit = extractUnit(filename), docDate = extractDateFromFilename(filename);
        p.docType = 'Reservation'; p.association = ASSOC.unit;
        if (!unit)    { p.error = 'missing unit number'; break; }
        if (!docDate) { p.error = 'missing date (MM-DD-YY at end)'; break; }
        p.title = `Move out request for (${docDate})`; p.date = docDate;
        p.dests = [dest(unit, 'moveout', 'T')];
        p.notes.push('Physical-unit association (the mover-out is often off the occupant list) — no initials needed; any in the filename are ignored. Always filed as Tenant.');
        break;
      }

      case 'waterleak': {
        const units = extractUnits(filename), docDate = extractDateFromFilename(filename);
        p.docType = 'Correspondence'; p.association = ASSOC.unit;
        if (!units.length) { p.error = 'missing unit number'; break; }
        if (!docDate)      { p.error = 'missing date (MM-DD-YYYY at end)'; break; }
        p.title = `Water Leak (${units.join(', ')}) (${docDate.split('/')[2]})`;
        p.date = docDate; p.dests = units.map(u => dest(u, 'waterleak', null));
        if (units.length > 1) p.notes.push(`Multi-unit (${units.join(', ')}): one upload per unit; file copied into the other units' Damage Reports folders, then the original moved into ${units[0]}'s.`);
        break;
      }

      case 'workorder': {
        const unit = extractUnit(filename);
        p.docType = 'N/A (file organization only)'; p.association = ASSOC.none;
        if (!unit) { p.error = 'missing unit number'; break; }
        p.dests = [dest(unit, 'workorder', null)];
        p.notes.push('No upload. Leaf "Work Orders" folder is auto-created if its parent exists.');
        break;
      }

      case 'commonarea': {
        const folder   = path.dirname(filename);
        const building = commonAreaBuildingOf(folder);
        const docDate  = extractDateFromFilename(path.basename(filename));
        p.docType = 'N/A (file organization only)'; p.association = ASSOC.none;
        if (!building) { p.error = 'not in a recognized "bldg N common areas work orders" folder'; break; }
        if (!docDate)  { p.error = 'missing date (MM-DD-YYYY at end)'; break; }
        p.date  = docDate;
        p.dests = [commonAreaDestFolder(building, docDate.split('/')[2])];
        p.notes.push(`Building ${building} comes from the source folder "${folder}" — no unit is involved.`);
        p.notes.push('No upload. Leaf "<year> Work Orders" folder is auto-created if the building\'s Common Area folder exists.');
        break;
      }

      case 'insurance': {
        const unit = extractUnitAfterFor(filename) || extractUnit(filename);
        p.docType = 'N/A (file organization only)'; p.association = ASSOC.none;
        if (!unit) { p.error = 'missing unit number'; break; }
        p.dests = [dest(unit, 'insurance', null)];
        break;
      }

      case 'resale': {
        const unit = extractUnit(filename);
        p.docType = 'N/A (file organization only)'; p.association = ASSOC.none;
        if (!unit) { p.error = 'missing unit number'; break; }
        p.dests = [dest(unit, 'resale', null)];
        break;
      }

      case 'correspondence': {
        const units = extractUnits(filename), fileDate = extractDateFromFilename(filename);
        p.docType = 'Correspondence'; p.association = ASSOC.unit;
        if (!units.length) { p.error = 'missing unit number'; break; }
        p.title = path.basename(filename, '.pdf');
        p.date = fileDate || `${todayDate()} (today — no date in filename)`;
        p.dests = units.map(u => dest(u, 'correspondence', null));
        p.notes.push('Matched a correspondence keyword — filename used as the title; associated with the physical unit (no occupant matching).');
        if (units.length > 1) {
          p.notes.push(`Multi-unit (${units.join(', ')}): one upload per unit (${units.length} documents, same title); the PDF is then moved into ${units[0]}'s Correspondence folder and copied into the other ${units.length - 1}.`);
        }
        if (p.title.length > TITLE_MAX_LEN) {
          p.notes.push(`Title is ${p.title.length} chars — BuildingLink stores only the first ${TITLE_MAX_LEN}: "${p.title.slice(0, TITLE_MAX_LEN)}".`);
        }
        break;
      }

      case 'ownership': {
        const unit = extractUnit(filename), fileDate = extractDateFromFilename(filename);
        p.docType = 'Proof of Ownership'; p.association = ASSOC.unit;
        if (!unit) { p.error = 'missing unit number'; break; }
        p.title = path.basename(filename, '.pdf');
        p.date = fileDate || `${todayDate()} (today — no date in filename)`;
        p.dests = [dest(unit, 'ownership', null)];
        p.notes.push('Deed / power of attorney — filename used as the title; associated with the physical unit (no occupant matching).');
        break;
      }

      case 'unknown': {
        const unit = extractUnit(filename);
        p.docType = '(operator choice at runtime)'; p.association = '(operator choice at runtime)';
        p.notes.push('Unrecognized — would prompt: 1) upload + move, 2) move only, 3) skip.');
        if (!unit) { p.error = 'missing unit number (needed for options 1 & 2)'; break; }
        p.title = `${path.basename(filename, '.pdf')} (if upload chosen)`;
        p.dests = [dest(unit, 'unknownmove', null)];
        break;
      }

      default:
        p.error = `no plan for category "${type}"`;
    }
  } catch (e) {
    p.error = e.message;
  }
  return p;
}

// Print the full offline plan for every scanned file, then a summary, and exit.
// allowedTypes (optional) restricts the plan to those categories — the UI passes
// the operator's chip selection so a dry run previews exactly the same subset a
// real run would process.
function runDryRun(cats, allowedTypes) {
  // Processing order, then the non-processed buckets (unknown is processed via
  // its prompt; skip is never processed). Every category key appears once.
  const fullOrder = ['inspection', 'windowreplacement', 'keylog', 'poolpass', 'parking', 'returnedparking', 'bicycle', 'keyfob', 'lease', 'addendum', 'movein1', 'movein2', 'movein3', 'moveout', 'meetingroom', 'guestroom', 'delivery', 'workorder', 'commonarea', 'waterleak', 'alta', 'ownership', 'storagebin', 'yardsale', 'blform', 'insurance', 'resale', 'correspondence', 'unknown', 'skip'];
  const order = (allowedTypes && allowedTypes.length)
    ? fullOrder.filter(t => allowedTypes.includes(t))
    : fullOrder;

  log('\n' + '═'.repeat(65));
  log('  DRY RUN — offline plan only (no Chrome, no BuildingLink, no moves)');
  log('═'.repeat(65));
  if (allowedTypes && allowedTypes.length) {
    log(`  Selected types only: ${allowedTypes.join(', ')}`);
  }

  const errors = [];
  let n = 0, total = 0;
  for (const t of order) {
    for (const filename of cats[t]) {
      total++; n++;
      const p = planFile(filename);
      log(`\n[${n}] ${p.filename}`);
      log(`    Detected     : ${p.type}`);
      log(`    Title        : ${p.title || '—'}`);
      log(`    Doc Type     : ${p.docType || '—'}`);
      log(`    Association  : ${p.association || '—'}`);
      log(`    Date         : ${p.date || '—'}`);
      if (p.dests.length <= 1) {
        log(`    Destination  : ${p.dests[0] || '—'}`);
      } else {
        log(`    Destination  :`);
        p.dests.forEach(d => log(`                   ${d}`));
      }
      p.notes.forEach(note => log(`    Note         : ${note}`));
      if (p.error) { log(`    ⚠️  WOULD ERROR: ${p.error}`); errors.push(p); }
    }
  }

  // ── Summary ──────────────────────────────────────────────────
  log('\n' + '─'.repeat(65));
  log('  DRY RUN SUMMARY');
  log('─'.repeat(65));
  log(`  Total files found : ${total}`);
  log(`  By type:`);
  for (const t of order) {
    if (cats[t].length) log(`    ${t.padEnd(16)}: ${cats[t].length}`);
  }
  log(`  Unknown files     : ${cats.unknown.length}`);
  if (errors.length) {
    log(`  Would error (${errors.length}):`);
    errors.forEach(p => log(`    - ${p.filename}  [${p.type}] → ${p.error}`));
  } else {
    log(`  Would error       : none`);
  }
  log('');
  log('  (Dry run — nothing was uploaded or moved.)');
}

// ═══════════════════════════════════════════════════════════════
// INSPECT MODE — `node upload.js --inspect-unit=1-0105`
// Opens the unit's Unit Overview tab and dumps, for every occupancy card:
// the role badge, the detected name + the selector it came from, the name
// element's HTML and the card's HTML. Uploads nothing, moves nothing.
// Use it to confirm/pin OCCUPANT_NAME_SELECTORS against the live page.
// ═══════════════════════════════════════════════════════════════
async function launchLoggedInPage() {
  const browser = await chromium.launch({ headless: false, channel: 'chrome', args: ['--start-maximized'] });
  const context = await browser.newContext({ viewport: null });
  const page    = await context.newPage();

  await page.goto(SEARCH_URL);
  try { await page.waitForLoadState('load', { timeout: 15000 }); } catch {}

  const needsLogin =
    page.url().toLowerCase().includes('login') ||
    page.url().toLowerCase().includes('logon') ||
    !page.url().includes('/mgmt/') ||
    (await page.locator('input[type="password"]').count()) > 0;

  if (needsLogin) {
    log('⚠️  Please log in to BuildingLink in the browser window that just opened.');
    await page.waitForURL(
      url => url.href.includes('/mgmt/') && !url.href.toLowerCase().includes('login'),
      { timeout: 300000 },
    );
    try { await page.waitForLoadState('load', { timeout: 10000 }); } catch {}
    log('✓ Logged in.\n');
  } else {
    log('✓ Already on BuildingLink management portal.\n');
  }
  return { browser, page };
}

async function inspectUnitOccupants(rawUnit) {
  const unit = normalizeUnit(rawUnit) || rawUnit;
  log(`\n  Inspecting occupancy cards for unit ${unit}...\n`);

  const { browser, page } = await launchLoggedInPage();
  try {
    // Same navigation as openAddDocForm steps 1–2, minus the Documents tab.
    await page.goto(SEARCH_URL);
    try { await page.waitForLoadState('load', { timeout: 15000 }); } catch {}
    await page.waitForTimeout(1500);

    const { loc: searchInput, ctx: searchCtx } = await findAcrossFrames(page, [
      'input[placeholder*="Quick Search" i]',
      'input[placeholder*="quick" i]',
      'input[id*="quickSearch" i]',
      'input[id*="QuickSearch" i]',
    ]);
    await searchInput.click();
    await searchInput.fill(unit);
    const autocomplete = searchCtx.locator([
      'ul.ui-autocomplete li a',
      '[class*="autocomplete" i] li a',
      '[class*="suggest" i] a',
    ].join(', ')).first();
    try {
      await autocomplete.waitFor({ state: 'visible', timeout: 2500 });
      await autocomplete.click();
    } catch {
      await searchInput.press('Enter');
    }
    try { await page.waitForLoadState('load', { timeout: 15000 }); } catch {}
    await page.waitForTimeout(1500);

    let frame = await findOccupantTypeFrame(page, 5000);
    if (!frame) {
      try {
        const { loc: tab } = await findAcrossFrames(page, UNIT_OVERVIEW_TAB_SELECTORS, 5000);
        await tab.click();
        try { await page.waitForLoadState('load', { timeout: 10000 }); } catch {}
        await page.waitForTimeout(1200);
      } catch {}
      frame = await findOccupantTypeFrame(page, 8000);
    }
    if (!frame) {
      log(`  ✗ No ${OCCUPANT_TYPE_SELECTOR} elements found on unit ${unit}'s profile.`);
      await screenshot(page, `inspect-${unit.replace(/\W/g, '_')}`);
      return;
    }

    const cards = await scrapeOccupantCards(frame, { dump: true });
    const out = [];
    out.push(`Unit ${unit} — ${cards.length} occupancy card(s)  [${nowStamp()}]`);
    cards.forEach((c, i) => {
      const { isTenant, basis } = occupantIsTenant(c);
      const rgb = parseCssColor(c.pillBg);
      const hsl = rgb ? rgbToHsl(rgb) : null;
      out.push('');
      out.push('='.repeat(70));
      out.push(`[${i + 1}] ROLE BADGE : ${c.role}   → ${isTenant ? 'TENANT' : 'OWNER SIDE'}  (via ${basis})`);
      out.push(`    NAME       : ${c.name || '[not found]'}`);
      out.push(`    NAME VIA   : ${c.nameSelector}`);
      out.push(`    PILL CLASS : ${c.pillClass || '(no pill found)'}`);
      out.push(`    PILL BG    : ${c.pillBg || '(none)'}${hsl ? `   hue=${hsl.h.toFixed(0)}° sat=${(hsl.s * 100).toFixed(0)}% light=${(hsl.l * 100).toFixed(0)}%` : ''}`);
      out.push(`    BADGE CLASS: ${c.badgeClass || '(none)'}`);
      out.push(`    BADGE STYLE: ${c.badgeStyle || '(none)'}`);
      out.push(`    CARD testid: ${c.cardTestId || '(none)'}`);
      out.push(`    NAME HTML  : ${c.nameHtml || '(none — name came from card text)'}`);
      out.push(`    PILL HTML  :`);
      out.push(c.pillHtml || '(none)');
      out.push(`    CARD HTML  :`);
      out.push(c.cardHtml || '(none)');
    });

    const text = out.join('\r\n');
    log(text);
    const file = path.join(outputDir, `occupant-cards-${unit.replace(/\W/g, '_')}.txt`);
    try {
      fs.writeFileSync(file, text, 'utf8');
      log(`\n  💾 Saved to ${file}`);
    } catch (e) {
      log(`  ⚠️  Could not save dump: ${e.message}`);
    }
    log(`\n  → Paste the CARD HTML back so the name selector can be pinned at the`);
    log(`    top of OCCUPANT_NAME_SELECTORS.`);
  } finally {
    await ask('\nPress Enter to close the browser...');
    await browser.close();
  }
}

// ═══════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════
// options (all optional) let a caller drive the run without CLI args — the
// Electron app passes these instead of mutating process.argv. Each falls back to
// the original argv parsing when not supplied, so `node upload.js [flags]` is
// unchanged:
//   { dryRun:true }            → same as --dry-run
//   { all:true }               → same as --all (process every file)
//   { types:['poolpass',...] } → same as --types=...
//   { limit:N }                → same as --limit=N
async function main(options = {}) {
  // A previous run's stop/abort must not leak into this one.
  resetRunControl();

  // ── Inspect mode: dump a unit's occupancy cards and exit ─────
  const inspectArg  = process.argv.find(a => a.startsWith('--inspect-unit='));
  const inspectUnit = options.inspectUnit || (inspectArg ? inspectArg.split('=')[1] : null);
  if (inspectUnit) { await inspectUnitOccupants(inspectUnit); return; }

  // ── Scan files ───────────────────────────────────────────────
  const cats = scanFiles();

  // Type restriction (UI chip selection, or --types= on the CLI). Resolved here
  // so the dry run below can honour it too, not just a live run.
  const typesArg = process.argv.find(a => a.startsWith('--types='));
  const allowedTypes = (options.types && options.types.length) ? options.types
                     : (typesArg ? typesArg.split('=')[1].split(',') : null);

  // Test switch for the [2b] Unit Overview read (UI checkbox or CLI flag).
  skipRoleMap = !!options.skipRoleMap || process.argv.includes('--skip-role-map');
  if (skipRoleMap) log('\n  ⚠️  TEST MODE: the [2b] Unit Overview role read is DISABLED for this run.\n');

  // ── Dry run: print the offline plan and exit (no browser, no moves) ──
  if (options.dryRun || process.argv.includes('--dry-run')) { runDryRun(cats, allowedTypes); return; }

  log('\n' + '═'.repeat(65));
  log('  BuildingLink Document Upload');
  log('═'.repeat(65));
  log(`\n  Files scanned in: ${FILES_DIR}`);
  log(`    Inspections    : ${cats.inspection.length}`);
  log(`    Window Replace : ${cats.windowreplacement.length}`);
  log(`    Key Logs       : ${cats.keylog.length}`);
  log(`    Pool Passes    : ${cats.poolpass.length}`);
  log(`    Parking Permits: ${cats.parking.length}`);
  log(`    Returned Parking: ${cats.returnedparking.length}`);
  log(`    Bicycle Reg    : ${cats.bicycle.length}`);
  log(`    Key Fobs       : ${cats.keyfob.length}`);
  log(`    Lease Agreements: ${cats.lease.length}`);
  log(`    Lease Addenda  : ${cats.addendum.length}`);
  log(`    Move In/BL Form: ${cats.movein1.length}`);
  log(`    Move In & Out  : ${cats.movein2.length}`);
  log(`    Move In App    : ${cats.movein3.length}`);
  log(`    Move-Out Forms : ${cats.moveout.length}`);
  log(`    Meeting Room   : ${cats.meetingroom.length}`);
  log(`    Guest Room Res : ${cats.guestroom.length}`);
  log(`    Delivery Forms : ${cats.delivery.length}`);
  log(`    Work Orders    : ${cats.workorder.length}`);
  log(`    Common Area WOs: ${cats.commonarea.length}`);
  log(`    Water Leaks    : ${cats.waterleak.length}`);
  log(`    ALTA Settlements: ${cats.alta.length}`);
  log(`    Deeds / POAs   : ${cats.ownership.length}`);
  log(`    Storage Bins   : ${cats.storagebin.length}`);
  log(`    Yard Sales     : ${cats.yardsale.length}`);
  log(`    BuildingLink Forms: ${cats.blform.length}`);
  log(`    Insurance      : ${cats.insurance.length}`);
  log(`    Resale Packages: ${cats.resale.length}`);
  log(`    Correspondence : ${cats.correspondence.length}`);
  log(`    Skipped        : ${cats.skip.length}`);
  log(`    Unknown        : ${cats.unknown.length}`);

  if (cats.skip.length)    { log(`\n  Skipped:`);  cats.skip.forEach(f => log(`    - ${f}`)); }
  if (cats.unknown.length) { log(`\n  Unknown (will prompt for handling):`); cats.unknown.forEach(f => log(`    - ${f}`)); }

  // ── Select which files to process ─────────────────────────────
  // Two modes:
  //   node upload.js          TEST MODE (default) — 1 file per type, then stop
  //                           for review before the rest. Nothing runs by accident.
  //   node upload.js --all    FULL MODE — process every qualifying file to completion.
  // Power-user flags (optional, both stay in TEST MODE):
  //   --types=inspection,windowreplacement,keylog,poolpass,parking,returnedparking,bicycle,keyfob,lease,addendum,movein1,movein2,movein3,moveout,meetingroom,guestroom,delivery,workorder,commonarea,waterleak,alta,ownership,storagebin,yardsale,blform,insurance,resale,correspondence,unknown  restrict types
  //   --limit=N                           process at most N files total
  // (allowedTypes was resolved above, before the dry-run branch.)
  const limitArg = process.argv.find(a => a.startsWith('--limit='));
  const limit    = options.limit != null ? options.limit
                 : (limitArg ? parseInt(limitArg.split('=')[1], 10) : null);
  const all      = options.all || process.argv.includes('--all');

  // Build a round-robin ordering so a small limit samples across types.
  const typeOrder = ['inspection', 'windowreplacement', 'keylog', 'poolpass', 'parking', 'returnedparking', 'bicycle', 'keyfob', 'lease', 'addendum', 'movein1', 'movein2', 'movein3', 'moveout', 'meetingroom', 'guestroom', 'delivery', 'workorder', 'commonarea', 'waterleak', 'alta', 'ownership', 'storagebin', 'yardsale', 'blform', 'insurance', 'resale', 'correspondence', 'unknown']
    .filter(t => !allowedTypes || allowedTypes.includes(t));

  const ordered = [];
  const maxLen = Math.max(0, ...typeOrder.map(t => cats[t].length));
  for (let i = 0; i < maxLen; i++) {
    for (const t of typeOrder) {
      if (cats[t][i]) ordered.push({ filename: cats[t][i], type: t });
    }
  }

  let testBatch;
  if (all) {
    testBatch = ordered;
  } else if (limit != null && !Number.isNaN(limit)) {
    testBatch = ordered.slice(0, limit);
  } else {
    // Default: first of each qualifying type (legacy safe test mode).
    const seen = new Set();
    testBatch = ordered.filter(({ type }) => !seen.has(type) && seen.add(type));
  }

  if (testBatch.length === 0) { log('\nNo qualifying files found. Exiting.'); return; }

  const mode = all
    ? 'FULL MODE — ALL files'
    : (limit != null ? `TEST MODE — ${testBatch.length} file(s) (--limit)` : 'TEST MODE — 1 per type (default)');

  log(`\n  ${'━'.repeat(61)}`);
  log(`  ▶ ${mode}`);
  if (allowedTypes && allowedTypes.length) {
    log(`    Restricted to selected type(s): ${allowedTypes.join(', ')}`);
  }
  if (!all) log(`    (Re-run with  node upload.js --all  to process every file.)`);
  log(`  ${'━'.repeat(61)}`);
  log(`\n  Processing:`);
  testBatch.forEach(({ type, filename }) => log(`    [${type}] ${filename}`));
  log('');

  // ── Browser launch (lazy + reused) ────────────────────────────
  // ensureBrowser() opens Chrome and handles login on first use, then returns
  // the SAME page on every later call — so a session opened for one file is
  // reused by the rest of the run. We pre-open it only when the batch contains a
  // file that DEFINITELY uploads. File-organization types (work orders, common
  // area work orders, insurance, resale) never need it; unknown files only need
  // it if the operator picks "upload" (option 1), so they open it on demand from
  // inside handleUnknown — never for option 2 (move only) or 3 (skip).
  const ALWAYS_FILEORG = new Set(['workorder', 'commonarea', 'insurance', 'resale']);
  const definiteUpload = testBatch.some(i => !ALWAYS_FILEORG.has(i.type) && i.type !== 'unknown');
  const hasUnknown     = testBatch.some(i => i.type === 'unknown');

  let browser = null, context = null, page = null;

  async function ensureBrowser() {
    if (page) return page; // reuse the session already open from an earlier file in this run

    browser = await chromium.launch({ headless: false, channel: 'chrome', args: ['--start-maximized'] });
    // Hand the browser to the run controller: it can now terminate the session
    // on abort, and an unexpected disconnect aborts the run instead of letting
    // every remaining file fail against a dead browser.
    registerRunBrowser(browser);
    context = await browser.newContext({ viewport: null });
    page    = await context.newPage();
    // Start recording network + console for the save diagnostics.
    attachDiagnostics(page);

    // ── Login check ───────────────────────────────────────────────
    await page.goto(SEARCH_URL);
    try { await page.waitForLoadState('load', { timeout: 15000 }); } catch {}

    const needsLogin =
      page.url().toLowerCase().includes('login') ||
      page.url().toLowerCase().includes('logon') ||
      !page.url().includes('/mgmt/') ||
      (await page.locator('input[type="password"]').count()) > 0;

    if (needsLogin) {
      log('⚠️  Please log in to BuildingLink in the browser window that just opened.');
      log('   The script continues automatically once you reach the management portal.\n');
      await page.waitForURL(
        url => url.href.includes('/mgmt/') && !url.href.toLowerCase().includes('login'),
        { timeout: 300000 },
      );
      try { await page.waitForLoadState('load', { timeout: 10000 }); } catch {}
      log('✓ Logged in.\n');
    } else {
      log('✓ Already on BuildingLink management portal.\n');
    }
    return page;
  }

  if (definiteUpload) {
    try {
      await ensureBrowser();
    } catch (err) {
      // Losing the window/browser during login surfaces here as a Playwright
      // "target closed" — report it as the abort it is, not as a fatal bug.
      if (isRunAborted()) { log(`\n  ⏹  Run stopped before any file was processed: ${runAbortReason()}.`); return null; }
      throw err;
    }
  } else if (hasUnknown) {
    log('✓ No up-front upload needed — Chrome opens only if you choose to upload an unknown file (option 1).\n');
  } else {
    log('✓ File-organization only — skipping browser & login (no BuildingLink upload needed).\n');
  }

  // ── Process test batch ────────────────────────────────────────
  const runStart = nowStamp();
  const results = [];
  let endedEarly = false;   // stopped or aborted before the batch was exhausted

  // The clock starts HERE — after Chrome is open and logged in — so the run
  // timer and the files-per-minute rate measure actual filing speed and aren't
  // skewed by however long the operator took to type their password.
  const batchStartMs = Date.now();
  resetStepTotals();   // step averages cover THIS run only

  // Tell the UI what this batch consists of, so its per-type squares can count
  // down from the right numbers.
  const batchByType = {};
  for (const it of testBatch) batchByType[it.type] = (batchByType[it.type] || 0) + 1;
  const folderCounts = {};
  for (const k of Object.keys(cats)) folderCounts[k] = cats[k].length;
  emitProgress({ phase: 'batch-start', total: testBatch.length, byType: batchByType, folderCounts });

  let fileIndex = 0;

  // Process ONE file end to end: upload, file it, record what happened. Written
  // as a function so the auto-retry pass at the bottom re-runs a file through
  // the IDENTICAL path — a retry that behaved differently from a first attempt
  // would be a second thing to debug.
  //
  // retryOf = the record of the earlier failed attempt. Its result is REPLACED
  // (not appended) so the summary counts each file once and reports its final
  // outcome, not its worst one.
  async function processOne(item, { retryOf = null } = {}) {
    const isRetry = !!retryOf;

    // One log record per file; defaults assume failure until proven otherwise.
    const rec = {
      timestamp: nowStamp(), filename: item.filename, type: item.type,
      unit: null, title: null, docType: null, occupants: null,
      uploadStatus: 'Error', error: null, plainError: null,
      destFolder: null, moveStatus: 'Not Moved',
      attempt: isRetry ? 2 : 1,
      firstError: isRetry ? (retryOf.plainError || retryOf.error) : null,
    };
    if (!isRetry) fileIndex++;
    emitProgress({
      phase: 'file-start', type: item.type, filename: item.filename,
      index: fileIndex, total: testBatch.length, retry: isRetry,
    });
    stepReset();   // start this file's step clock
    try {
      let result;
      if (item.type === 'inspection')    result = await uploadInspection(page, item.filename);
      else if (item.type === 'windowreplacement') result = await uploadWindowReplacement(page, item.filename);
      else if (item.type === 'keylog')   result = await uploadKeyLog(page,     item.filename);
      else if (item.type === 'poolpass') result = await uploadPoolPass(page,   item.filename);
      else if (item.type === 'parking')  result = await uploadParking(page,    item.filename);
      else if (item.type === 'returnedparking') result = await uploadReturnedParking(page, item.filename);
      else if (item.type === 'bicycle')  result = await uploadBicycle(page,    item.filename);
      else if (item.type === 'keyfob')   result = await uploadKeyFob(page,     item.filename);
      else if (item.type === 'lease')    result = await uploadLease(page,      item.filename);
      else if (item.type === 'addendum') result = await uploadAddendum(page,   item.filename);
      else if (item.type === 'movein1')  result = await uploadMoveInBuildingLink(page, item.filename);
      else if (item.type === 'movein2')  result = await uploadMoveInMoveOut(page,      item.filename);
      else if (item.type === 'movein3')  result = await uploadMoveInApplication(page,  item.filename);
      else if (item.type === 'moveout')  result = await uploadMoveOutForm(page,        item.filename);
      else if (item.type === 'meetingroom') result = await uploadMeetingRoom(page,     item.filename);
      else if (item.type === 'guestroom')   result = await uploadGuestRoom(page,       item.filename);
      else if (item.type === 'delivery')    result = await uploadDelivery(page,        item.filename);
      else if (item.type === 'waterleak')   result = await uploadWaterLeak(page,       item.filename);
      else if (item.type === 'correspondence') result = await uploadCorrespondence(page, item.filename);
      else if (item.type === 'alta')        result = await uploadAlta(page,           item.filename);
      else if (item.type === 'ownership')   result = await uploadOwnership(page,      item.filename);
      else if (item.type === 'storagebin')  result = await uploadStorageBin(page,      item.filename);
      else if (item.type === 'yardsale')    result = await uploadYardSale(page,        item.filename);
      else if (item.type === 'blform')      result = await uploadBLForm(page,          item.filename);
      else if (item.type === 'workorder')   result = organizeWorkOrder(item.filename); // no upload — file organization only
      else if (item.type === 'commonarea')  result = organizeCommonAreaWorkOrder(item.filename); // no upload — building-level, folder move only
      else if (item.type === 'insurance')   result = organizeInsurance(item.filename); // no upload — file organization only
      else if (item.type === 'resale')      result = organizeResale(item.filename);    // no upload — file organization only
      else if (item.type === 'unknown')     result = await handleUnknown(ensureBrowser, item.filename); // prompts operator; opens Chrome only on "upload"

      // Handler returned without throwing. Record details. Work orders skip the
      // BuildingLink upload entirely, so their status is N/A rather than Success.
      rec.unit = result.unit; rec.title = result.title || null;
      rec.docType = result.docType || null; rec.occupants = result.occupants || null;
      rec.uploadStatus = result.skipUpload ? 'N/A (file organization only)' : 'Success';

      // Success with no ambiguity (any multi-occupant choice already paused
      // inside the handler) → move the file automatically and continue. No y/n.
      // createDest (work orders only) lets moveFileTo create the leaf folder.
      const srcPath = path.join(FILES_DIR, item.filename);
      // The S:-drive move is timed like any other step — it gets its own line so
      // its duration lands inline, the same as steps [1]–[7].
      stepBegin('move', 'File move', `  [8] Filing into the unit folder...`);
      // The move is INDIVISIBLE too. The document is already in BuildingLink by
      // now, so a Stop that landed between the upload and the move would leave
      // the PDF in the source folder and the next run would upload it twice.
      // Once the upload has happened, the file gets filed — full stop.
      beginCritical('filing the PDF into the unit folder');
      try {
      if (result.multiDest) {
        // Water leak / multi-unit inspection: one report → every affected unit's
        // folder. One unit → the file is moved. Several → it is copied into the
        // secondary units and the ORIGINAL is moved into the first unit's folder,
        // so the source folder clears without the original ever being deleted
        // (see placeWaterLeakFile). `placed` lists the primary first.
        const destDirs = result.units.map(u => destFolder(u, result.category, result.ownerTenant));
        rec.destFolder = destDirs.join('  |  ');
        const placed = await placeWaterLeakFile(srcPath, destDirs);
        const multi = result.units.length > 1;
        rec.moveStatus = multi ? 'Moved + Copied' : 'Moved';
        log(`  ✓ Uploaded & ${multi ? `moved into ${result.units[0]} + copied into ${result.units.length - 1} more unit folder(s)` : 'moved'} → ${placed.join('\n                       ')}`);
      } else {
        // destDir is an explicit destination a handler worked out for itself,
        // used when the file is not filed under a unit at all — today only
        // common area work orders, which are filed under their BUILDING (see
        // commonAreaDestFolder). Everything else derives it from the unit.
        const dest = result.destDir || destFolder(result.unit, result.category, result.ownerTenant);
        rec.destFolder = dest;
        const moved = await moveFileTo(srcPath, dest, !!result.createDest);
        rec.moveStatus = 'Moved';
        log(`  ✓ ${result.skipUpload ? 'Organized' : 'Uploaded'} & moved → ${moved}`);
      }
      } finally { endCritical(); }

    } catch (err) {
      // ── The operator ended the run while this file was in flight ──
      // Not a failure, and it must not be treated like one: no screenshot, no
      // error prompt (there may be no window left to answer it), no auto-retry
      // queue entry, and no scary red line in the summary. Nothing was left
      // half-done — everything that could not be interrupted safely ran inside
      // a critical section — so the PDF is simply still in the source folder
      // and the next run picks it up.
      if (isRunInterrupt(err)) {
        rec.interrupted = true;
        rec.uploadStatus = 'Not uploaded — run ended';
        rec.error = null;
        rec.plainError = null;
        rec.moveStatus = 'Not Moved';
        const at = currentStepLabel();
        log(`\n  ⏹  Run ended during this file${at ? ` (at ${at})` : ''} — nothing was uploaded.`);
        log(`     "${item.filename}" is untouched in the source folder; just run again.`);
        const stepsNow = stepFinish();
        rec.durationMs = stepsNow.totalMs;
        rec.steps = stepsNow.entries.map(e => ({ key: e.key, label: e.label, ms: e.ms }));
        if (isRetry) {
          const idx = results.indexOf(retryOf);
          if (idx >= 0) results[idx] = rec; else results.push(rec);
        } else {
          results.push(rec);
        }
        emitProgress({
          phase: 'file-end', type: item.type, filename: item.filename,
          index: fileIndex, total: testBatch.length, retry: isRetry,
          ok: false, interrupted: true, moved: false,
          error: null, plainError: null,
          durationMs: stepsNow.totalMs, steps: rec.steps,
        });
        return rec;
      }

      // An aborted run's page is already gone — a screenshot would only add a
      // second failure to the log.
      if (page && !isRunAborted()) await screenshot(page, `error_${(item.filename || '').replace(/[^a-z0-9]/gi, '_').slice(0, 40)}`);
      if (isRunAborted()) {
        rec.error = `Interrupted: ${runAbortReason()}`;
      } else if (rec.uploadStatus === 'Success') {
        // Upload worked but the file move failed (e.g. missing dest folder).
        rec.error = `File move failed: ${err.message}`;
      } else {
        rec.error = err.message;
      }
      // Lead with plain English, keep the raw text underneath — the operator
      // needs to know what to DO, and a developer still needs the details.
      const human = humanizeError(rec.error);
      rec.plainError = human.plain;
      if (isRunAborted()) {
        log(`\n  ⏹  ${human.plain}`);
      } else {
        log(`\n  ${rec.uploadStatus === 'Success' ? '⚠️' : '✗'}  ${human.plain}`);
        if (human.raw && human.raw !== human.plain) log(`     Details: ${human.raw}`);
      }
      // Will the end-of-run pass try this one again by itself? If so, don't stop
      // the run to report it — an occupancy-load failure that the retry fixes is
      // not something the operator needs to acknowledge, and pausing here would
      // defeat the point of an unattended run. It is still logged, and if the
      // retry fails too THAT failure prompts normally.
      rec.autoRetryPending = !isRetry && !isRunAborted() && isOccupancyLoadFailure(rec.error);
      if (rec.autoRetryPending) {
        log(`     ↻ Queued for an automatic retry at the end of this run.`);
      }
      // Pause on errors so they get noticed before the run moves on — but not
      // when the run is already ending: there may be no window left to answer,
      // and the operator has said they're done either way.
      if (!isStopRequested() && !rec.autoRetryPending) {
        await askChoice({
          kind: 'continue',
          title: 'Error — this file was left in place',
          filename: item.filename,
          message: human.plain,
          details: human.raw && human.raw !== human.plain ? human.raw : null,
        });
      }
    }
    // Close this file's steps (folding them into the run averages) and report
    // how long the file took end to end.
    const fileSteps = stepFinish();
    rec.durationMs = fileSteps.totalMs;
    rec.steps = fileSteps.entries.map(e => ({ key: e.key, label: e.label, ms: e.ms }));
    log(`  Total: ${fmtSecs(fileSteps.totalMs)}\n`);

    // A retry REPLACES the record of the attempt it repeats, so one file is one
    // row in the summary either way.
    if (isRetry) {
      const at = results.indexOf(retryOf);
      if (at >= 0) results[at] = rec; else results.push(rec);
    } else {
      results.push(rec);
    }
    emitProgress({
      phase: 'file-end', type: item.type, filename: item.filename,
      index: fileIndex, total: testBatch.length, retry: isRetry,
      ok: !rec.error,
      moved: filePlaced(rec.moveStatus),
      error: rec.error, plainError: rec.plainError,
      durationMs: fileSteps.totalMs, steps: rec.steps,
    });
    return rec;
  }

  for (const item of testBatch) {
    // Between-files gate. Files can now also be interrupted from the INSIDE
    // (processOne returns a record marked `interrupted`), so both are checked.
    if (await runCheckpoint() === 'stop') { endedEarly = true; break; }
    const rec = await processOne(item);
    if (rec && rec.interrupted) { endedEarly = true; break; }
  }

  // The loop can also fall out with a stop pending on its LAST iteration.
  if (isStopRequested() && results.filter(r => !r.interrupted).length < testBatch.length) endedEarly = true;

  // ── Automatic retry pass ──────────────────────────────────────
  // Files that failed because BuildingLink never loaded the unit's occupancy
  // data are worth one more go: nothing was uploaded, the PDF is still in the
  // source folder, and the failure is a timing/state problem on their side that
  // a fresh page load often clears. Everything else is left alone — a missing
  // destination folder or an unmatched occupant will fail identically on a
  // retry, and repeating it would only bury the real message.
  //
  // Skipped entirely when the run was stopped or aborted: the operator asked for
  // it to end, and on an abort there is no browser left to retry with.
  const retryQueue = (endedEarly || isRunAborted())
    ? []
    : results.filter(r => r.error && r.attempt === 1 && isOccupancyLoadFailure(r.error));

  if (retryQueue.length) {
    log('\n' + '─'.repeat(65));
    log(`  ↻ AUTOMATIC RETRY — ${retryQueue.length} file(s) failed because the unit's occupancy`);
    log(`    data never loaded. Trying each of them once more.`);
    log('─'.repeat(65));
    // Snapshot the queue first: processOne rewrites `results` as it goes.
    for (const previous of [...retryQueue]) {
      if (await runCheckpoint() === 'stop') { endedEarly = true; break; }
      log(`\n  ↻ Retrying: ${previous.filename}`);
      const after = await processOne(
        { filename: previous.filename, type: previous.type }, { retryOf: previous });
      if (!after.error) log(`  ✓ Retry succeeded — the first attempt had simply hit a slow occupancy load.`);
    }
  }

  // ── Summary ───────────────────────────────────────────────────
  // A file the operator interrupted mid-flight is NOT a processed file and NOT a
  // failure — it was never attempted to completion, nothing was uploaded, and
  // the PDF is still in the source folder. It is counted with the files that
  // never started, so the summary reads "N were not processed" rather than
  // reporting a phantom error the operator has to go and investigate.
  const interruptedRecs = results.filter(r => r.interrupted);
  const done            = results.filter(r => !r.interrupted);

  const processed      = done.length;
  const successUploads = done.filter(r => r.uploadStatus === 'Success').length;
  const movedCount     = done.filter(r => filePlaced(r.moveStatus)).length;
  const errorCount     = done.filter(r => r.error).length;
  // A record needs attention if something errored or the file wasn't placed.
  // (Keying off error/move — not uploadStatus — so work orders, whose status is
  // the intentional "N/A (file organization only)", aren't falsely flagged.
  // 'Moved + Copied' is a successful multi-unit placement, not a failure.)
  const needAttention  = done.filter(r => r.error || !filePlaced(r.moveStatus));
  // Auto-retry outcomes: how many files needed a second attempt, and how many of
  // those the retry rescued. This is the number that says whether the occupancy
  // problem is actually being beaten.
  const retriedRecs    = done.filter(r => r.attempt > 1);
  const retriedOk      = retriedRecs.filter(r => !r.error).length;

  const remaining = Math.max(0, testBatch.length - processed);

  // ── Timing ────────────────────────────────────────────────────
  // durationMs is wall clock from the first file; activeMs takes out any time
  // the run sat paused, which is what the rate is computed against.
  const durationMs = Date.now() - batchStartMs;
  const pausedMs   = runPausedMs();
  const activeMs   = Math.max(0, durationMs - pausedMs);
  const rate       = filesPerMinute(processed, activeMs);
  emitProgress({ phase: 'batch-end', processed, durationMs, pausedMs });

  log('\n' + '═'.repeat(65));
  log(endedEarly ? (isRunAborted() ? '  RUN ABORTED — SUMMARY OF WORK DONE' : '  RUN STOPPED — SUMMARY OF WORK DONE')
                 : '  RUN COMPLETE — SUMMARY');
  log('═'.repeat(65) + '\n');
  if (endedEarly) {
    log(isRunAborted()
      ? `  ⏹  ${runAbortReason()}. The run was terminated; ${remaining} file(s) were not processed.`
      : `  ⏹  Stopped by operator. ${remaining} file(s) were not processed.`);
    if (interruptedRecs.length) {
      log(`     One file was in progress when you pressed Stop and was abandoned safely:`);
      interruptedRecs.forEach(r => log(`       - ${r.filename} — nothing uploaded, still in the source folder.`));
    }
    log('     Every unprocessed file is still in the source folder — just run again.\n');
  }
  for (const r of done) {
    log(`  File   : ${r.filename}`);
    if (r.unit) log(`  Unit   : ${r.unit}   Type: ${r.docType || 'N/A'}`);
    log(`  Upload : ${r.uploadStatus}${r.error ? `  (${r.error})` : ''}`);
    log(`  Move   : ${r.moveStatus}${r.destFolder ? `  → ${r.destFolder}` : ''}`);
    log('');
  }
  log(`  ${processed} processed — ${successUploads} uploaded, ${movedCount} moved, ${errorCount} error(s).`);
  if (retriedRecs.length) {
    log(`  ${retriedRecs.length} file(s) needed an automatic retry — ${retriedOk} of them then succeeded.`);
  }
  log(`  Completed in ${formatDuration(durationMs)}${pausedMs > 1000 ? ` (including ${formatDuration(pausedMs)} paused)` : ''}` +
      `${rate ? ` — ${rate.toFixed(1)} files/min` : ''}.`);
  if (needAttention.length) {
    log('  Needs manual attention:');
    needAttention.forEach(r =>
      log(`    - ${r.filename}\n        ${r.plainError || r.error || 'Uploaded, but the PDF was not moved out of the source folder.'}`));
  }

  // ── Where the time went ───────────────────────────────────────
  // Ordered by TOTAL cost across the run, so the top row is the step worth
  // optimizing first. Average alone would mislead: a step that runs once per
  // file at 4s costs far more than a 20s step that only ran twice.
  const stepRows = stepAverages();
  if (stepRows.length) {
    log('');
    log(`  ${'─'.repeat(61)}`);
    log(`  AVERAGE STEP TIMES (across ${processed} file${processed === 1 ? '' : 's'})`);
    log(`  ${'─'.repeat(61)}`);
    const pad = Math.max(...stepRows.map(r => r.label.length));
    for (const r of stepRows) {
      log(`    ${r.label.padEnd(pad)}  ${fmtSecs(r.avgMs).padStart(7)} avg` +
          `   ×${String(r.count).padEnd(4)}` +
          `  ${fmtSecs(r.totalMs).padStart(8)} total` +
          `  ${(r.share * 100).toFixed(0).padStart(3)}%`);
    }
    const stepGrand = stepRows.reduce((s, r) => s + r.totalMs, 0);
    log(`    ${'─'.repeat(pad + 34)}`);
    log(`    Timed steps account for ${fmtSecs(stepGrand)} of the ${formatDuration(durationMs)} run.`);
  }

  // ── Write the detailed log file ───────────────────────────────
  // `done` only: an interrupted file has no outcome to record, and a block
  // saying "Upload: Not uploaded" for a file the operator deliberately stopped
  // would read like a failure in the permanent log. The stop is reported in the
  // summary block instead.
  const logPath = writeRunLog(done, runStart, {
    processed, successUploads, movedCount, errorCount, needAttention,
    durationMs, pausedMs, activeMs, filesPerMin: rate, stepRows,
    retried: retriedRecs.length, retriedOk,
  });
  log(`\n  📝 Log written: ${logPath}`);

  await closeRunBrowser();

  // Return structured totals so a caller (the Electron app) can render a final
  // summary view. The CLI ignores this value, so its behavior is unchanged.
  return {
    processed, successUploads, movedCount, errorCount, logPath,
    retried: retriedRecs.length, retriedOk,
    stopped: endedEarly, aborted: isRunAborted(), stopReason: runAbortReason(), remaining,
    durationMs, pausedMs, activeMs, filesPerMin: rate, durationText: formatDuration(durationMs),
    // Per-step breakdown for the run, slowest-by-total first.
    stepRows: stepRows.map(r => ({
      key: r.key, label: r.label, count: r.count,
      totalMs: r.totalMs, avgMs: r.avgMs, share: r.share,
    })),
    // Both forms travel to the UI: `error` is the raw text (shown under "Show
    // details"), `plainError` is what the operator reads first.
    needAttention: needAttention.map(r => ({
      filename: r.filename,
      error: r.error || 'uploaded but not moved',
      plainError: r.plainError
                  || (r.error ? humanizeError(r.error).plain
                              : 'Uploaded to BuildingLink, but the PDF was not moved out of the source folder.'),
    })),
    records: done.map(r => ({
      filename: r.filename, unit: r.unit, docType: r.docType,
      uploadStatus: r.uploadStatus, moveStatus: r.moveStatus,
      error: r.error, plainError: r.plainError, durationMs: r.durationMs,
      attempt: r.attempt || 1, firstError: r.firstError || null,
    })),
    // The file (if any) that was in flight when Stop was pressed. Nothing was
    // uploaded and nothing was moved — it is named so the UI can say so plainly
    // rather than leaving the operator wondering what happened to it.
    interrupted: interruptedRecs.map(r => ({ filename: r.filename, type: r.type })),
  };
}

// Only auto-run when invoked directly (e.g. `node upload.js`); requiring the
// file as a module (for tests) does not launch the browser.
if (require.main === module) {
  main().catch(err => {
    console.error('\nFatal error:', err.message);
    process.exit(1);
  });
}

module.exports = { humanizeError, formatDuration, filesPerMinute, fmtSecs, runPausedMs,
  stepBegin, stepEnd, stepReset, stepFinish, stepAverages, resetStepTotals, main, configureIO, requestPause, requestResume, requestStop, abortRun, resetRunControl, setRunStateListener, runState, runCheckpoint, isRunAborted, isStopRequested,
  // Mid-file pause/stop machinery (see the RUN CONTROL block). Exported so the
  // offline harness can drive a pause into the middle of a file and assert that
  // the run parks, resumes on the same step, and never interrupts a save.
  gate, waitInterruptible, runCritical, beginCritical, endCritical, isCritical, criticalLabel,
  interruptPending, RunInterrupted, isRunInterrupt, currentStepLabel,
  multiUnitCommit, multiUnitRelease, scanFiles, writeRunLog, logFilePath, nowStamp, classifyFile, extractUnit, extractUnits, extractInitials, extractHashNumber, extractHashNumbers, formatHashNumbers, extractBinNumber, extractPermitNumber, extractDateFromFilename, destFolder, commonAreaDestFolder, commonAreaBuildingOf, organizeCommonAreaWorkOrder, planFile, defaultAskChoice, inspectUnitOccupants, readUnitRoleMap, occupantIsTenant, colorIsTenant, parseCssColor, rgbToHsl, normalizeOccupantName, occupantNameKey, lookupOccupantRole, clearDialogOverlay, waitForOverlayGone, countVisibleOverlays, addDocFormIsOpen, clickResilient, collectOccupantCandidates, checkOccupant, fillType, fillDate, dateFieldMatches, clearDateField,
  // Exported for the offline form harness (test/mock-form.html) — these are the
  // steps whose waits were tightened, so they need to be drivable in isolation.
  fillTitle, fillAssociation, attachFile, saveForm, waitForFormReady, waitForFileAccepted, selectOccupantsByRole,
  openAddDocForm, findAcrossFrames, findAcrossFramesPreferred, DOCS_TAB_SELECTOR, DOCS_TAB_FALLBACK_SELECTORS,
  verifyDocumentSaved, readAllFrameText, countOccurrences,
  findInPreferred, SAVE_BUTTON_SELECTOR, SAVE_BUTTON_FALLBACK_SELECTORS,
  attachDiagnostics, settleAfterAttach, attachmentUiBusy, decodePostBody,
  // Association-click verification (see waitForRadioEffect) and the degenerate
  // single-option dialog guard.
  radioSnapshot, radioTookEffect, waitForRadioEffect, assocOptionsAreDegenerate,
  // Occupancy-load retry policy: the verdict function, the auto-retry predicate
  // and the budgets, so the harness can drive them without a browser.
  judgeAssocOptions, isOccupancyLoadFailure, unitHasKnownOccupants,
  setRoleMapForTest, OCCUPANCY_MAX_ATTEMPTS, OCCUPANCY_RETRY_BACKOFF_MS,
  OCCUPANCY_EXHAUSTED_MARKER, openDialogAndReadOptions };
