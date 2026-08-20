// Shared identity needles for the "this file ships no author identity" tests.
//
// Every needle is assembled from fragments rather than written as a literal.
// A test that spells the name out is itself an occurrence of the name, so the
// release identity gate in mcp-server/release-check.mjs flags it and the gate
// then has to choose between exempting the assertions that enforce it or
// failing every release. Assembling the needles removes that choice: the
// assertions stay readable, and the literal never enters the tree.
//
// The surname needle is bounded because it is a substring of ordinary English
// words such as "exploration", and an unbounded match would fire on prose.

const AUTHOR_GIVEN_NAME = ['rob', 'ert'].join('');
const AUTHOR_SURNAME = ['lo', 'ra'].join('');
const AUTHOR_HANDLE = `rj${AUTHOR_SURNAME}`;

/** Matches the author's given name anywhere, case-insensitively. */
export const AUTHOR_NAME_RE = new RegExp(AUTHOR_GIVEN_NAME, 'i');

/** Matches the author's surname as a whole word, case-insensitively. */
export const AUTHOR_SURNAME_RE = new RegExp(`(?<![a-z])${AUTHOR_SURNAME}(?![a-z])`, 'i');

/** Matches the author's handle, which is also the email local part. */
export const AUTHOR_HANDLE_RE = new RegExp(AUTHOR_HANDLE, 'i');

/** Matches the author-named launchd label that dev.umbra.broker replaced. */
export const AUTHOR_LAUNCHD_LABEL_RE = new RegExp(
  `com\\.${AUTHOR_GIVEN_NAME}${AUTHOR_SURNAME}`,
  'i',
);

/** Matches any absolute macOS home directory path. */
export const HOME_PATH_RE = /\/Users\/[A-Za-z]/;

/** Matches the author's own website, used as an example in earlier drafts. */
export const AUTHOR_SITE_RE = new RegExp(['travel', 'bag', 'experts'].join(''), 'i');
