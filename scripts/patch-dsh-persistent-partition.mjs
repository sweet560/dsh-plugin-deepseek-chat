/**
 * DEPRECATED — do not use. Kept only so old bookmarks fail loudly.
 *
 * This byte-only replacement does NOT update the per-file SHA256 `integrity`
 * metadata in ASAR builds from 0.2.1-rc.3 onward (including 0.2.2-rc.1).
 * Applying it makes Electron abort with "ASAR Integrity Violation" on the next
 * DSH restart.
 *
 * Use scripts/patch-dsh-persistent-partition.cjs instead: it recomputes the
 * lib/main.js hash, syncs the ASAR header, and verifies every block.
 *
 * See docs/login-persistence.md for the current procedure.
 */
console.error("DEPRECATED: this script omits ASAR integrity and would break DSH on restart.");
console.error("Use scripts/patch-dsh-persistent-partition.cjs instead (see docs/login-persistence.md).");
process.exit(1);
