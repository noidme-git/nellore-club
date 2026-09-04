#!/usr/bin/env node
/**
 * Post-build gate. Runs as the second half of `npm run build`; the two halves are
 * never run separately, because `next build` alone ships a site that will not
 * hydrate under the enforced CSP.
 *
 * It does three jobs, and every one of them fails the build rather than warning.
 *
 * 1. **CSP hashes.** Walk `out/**\/*.html`, sha256 the exact bytes of every
 *    inline `<script>`, and write `worker/csp-hashes.json` keyed by ASSET path.
 *    A static export cannot mint a per-request nonce and Next inlines its
 *    `self.__next_f.push(...)` flight payload into every prerendered page, so
 *    build-time hashes are the only way to keep `'unsafe-inline'` out of
 *    `script-src` — and this site renders user-supplied content, so
 *    `'unsafe-inline'` is not an acceptable answer (SECURITY.md §8.1).
 *
 * 2. **Unhashable output is a build failure.** An inline event-handler attribute,
 *    a cross-origin `<script src>`, a `javascript:` URL or an unterminated
 *    `<script>` all mean the shipped page needs a policy we refuse to send. The
 *    theme bootstrap gets extra scrutiny: it is the one allowlisted
 *    `dangerouslySetInnerHTML` in the codebase (ARCHITECTURE.md §4 rule 5), so
 *    this script asserts its bytes, asserts it is a plain string literal with no
 *    interpolation, and asserts its hash is in EVERY page's list — a page missing
 *    it is a build failure, not a runtime flash of the wrong theme.
 *
 * 3. **The shell head-tag gate.** For `out/shell/tournament/index.html` and
 *    `out/shell/player/index.html`: exactly one `<title>`, and exactly one
 *    element for each of description, og:title, og:description, og:image, og:url,
 *    canonical and the JSON-LD block, each carrying its `nc-*` id. This is the
 *    only thing standing between the project and a non-reproducible WhatsApp
 *    preview bug: the Worker's `HTMLRewriter` REPLACES attributes and never
 *    appends, so a missing tag silently never appears in a link preview, and a
 *    duplicate `<title>` (which is what a `title` in `app/layout.tsx` produces —
 *    IA.md §4.0) gives the crawler a coin flip that it caches for days with no
 *    purge API. Neither reproduces on `curl` or in a browser.
 *
 * No dependencies: DESIGN.md §9 is a hard byte budget and a build script that
 * pulls in an HTML parser is a supply-chain surface for a job that is a few
 * hundred lines of regex over output this repo itself generates.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'out');
const HASHES_FILE = join(ROOT, 'worker', 'csp-hashes.json');
const LAYOUT_FILE = join(ROOT, 'app', 'layout.tsx');

/**
 * DESIGN.md §2.1, byte-for-byte identical to the `THEME_BOOTSTRAP` constant in
 * app/layout.tsx. Duplicated here on purpose: this script is what closes the
 * drift loop, by asserting the literal below still appears verbatim in that file.
 * Two copies that are mechanically compared are safer than one copy read out of
 * a .tsx file by a regex that a formatting change can defeat.
 */
const THEME_BOOTSTRAP =
  "try{var t=localStorage.getItem('nc:v1:theme');if(t!=='dark'&&t!=='light'){t=matchMedia('(prefers-color-scheme: light)').matches?'light':'dark'}document.documentElement.dataset.theme=t}catch(e){document.documentElement.dataset.theme='dark'}";

/**
 * The head tag set the Worker rewrites, per IA.md §4(a) and API.md §8.6. `id` is
 * how the rewriter selects; `match` is what proves the id is on the RIGHT
 * element, so renaming an id onto the wrong tag is caught too.
 */
const REQUIRED_SHELL_TAGS = [
  { id: 'nc-title', label: '<title>', match: (t) => t.name === 'title' },
  {
    id: 'nc-desc',
    label: '<meta name="description">',
    match: (t) => t.name === 'meta' && t.attrs.name === 'description',
  },
  {
    id: 'nc-og-title',
    label: '<meta property="og:title">',
    match: (t) => t.name === 'meta' && t.attrs.property === 'og:title',
  },
  {
    id: 'nc-og-desc',
    label: '<meta property="og:description">',
    match: (t) => t.name === 'meta' && t.attrs.property === 'og:description',
  },
  {
    id: 'nc-og-image',
    label: '<meta property="og:image">',
    match: (t) => t.name === 'meta' && t.attrs.property === 'og:image',
  },
  {
    id: 'nc-og-url',
    label: '<meta property="og:url">',
    match: (t) => t.name === 'meta' && t.attrs.property === 'og:url',
  },
  {
    id: 'nc-canonical',
    label: '<link rel="canonical">',
    match: (t) => t.name === 'link' && t.attrs.rel === 'canonical',
  },
  {
    id: 'nc-jsonld',
    label: '<script type="application/ld+json">',
    match: (t) => t.name === 'script' && t.attrs.type === 'application/ld+json',
  },
];

/** Shells the Worker boot-injects, and therefore the ones the gate applies to. */
const INJECTED_SHELLS = ['/shell/tournament/index.html', '/shell/player/index.html'];
/**
 * The admin shell gets no injection and no meta placeholders (IA.md §2.2), which
 * makes it the canary: if a `title` ever reappears in app/layout.tsx, Next emits
 * it on EVERY page, so it shows up here as a title in a document that is supposed
 * to have none — a failed build instead of a coin-flip link preview.
 */
const BARE_SHELL = '/shell/admin/index.html';

/** An actual USE of the prop, not the several places it is named in a comment. */
const DANGER_USE_RE = /dangerouslySetInnerHTML\s*[=:]/g;

const errors = [];
const fail = (message) => errors.push(message);

/* =====================================================================
 * A minimal HTML scanner
 *
 * Only ever run over this repo's own build output, which is React 19's
 * serialiser: well-formed, no unquoted-with-`>` attribute values, no SGML
 * exotica. Script BODIES are blanked before tags are scanned, because Next's
 * flight payload is a JS string that can legitimately contain `<`.
 * ===================================================================== */

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const TAG_RE = /<([a-zA-Z][a-zA-Z0-9-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttrs(raw) {
  const attrs = {};
  ATTR_RE.lastIndex = 0;
  let m;
  while ((m = ATTR_RE.exec(raw)) !== null) {
    if (m[0].trim() === '') {
      ATTR_RE.lastIndex += 1;
      continue;
    }
    attrs[m[1].toLowerCase()] = m[2] ?? m[3] ?? m[4] ?? '';
  }
  return attrs;
}

/** Replaces every script body with spaces of the same length, preserving offsets. */
function blankScriptBodies(html) {
  return html.replace(SCRIPT_RE, (whole, attrs, body) => whole.replace(body, ' '.repeat(body.length)));
}

function parseTags(html) {
  const tags = [];
  TAG_RE.lastIndex = 0;
  let m;
  while ((m = TAG_RE.exec(html)) !== null) {
    tags.push({ name: m[1].toLowerCase(), attrs: parseAttrs(m[2] ?? ''), raw: m[0] });
  }
  return tags;
}

/* =====================================================================
 * Per-file checks
 * ===================================================================== */

function collectHtmlFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...collectHtmlFiles(full));
    else if (entry.endsWith('.html')) found.push(full);
  }
  return found.sort();
}

/** `out/shell/tournament/index.html` -> `/shell/tournament/index.html`. */
function assetPath(file) {
  return '/' + relative(OUT_DIR, file).split(sep).join('/');
}

function sha256Source(text) {
  return `sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}`;
}

/**
 * SECURITY.md §8.1 point 2: a build that would need `'unsafe-inline'` does not
 * ship. An inline handler cannot be hashed at all — CSP has no mechanism for it
 * short of `'unsafe-hashes'`, which we do not send.
 */
function checkForInlineHandlers(page, tags) {
  for (const tag of tags) {
    for (const [name, value] of Object.entries(tag.attrs)) {
      if (name.length > 2 && name.startsWith('on')) {
        fail(`${page}: inline event handler \`${name}\` on <${tag.name}>. CSP script-src cannot hash it.`);
      }
      if (/^\s*javascript:/i.test(value)) {
        fail(`${page}: \`javascript:\` URL in ${tag.name}[${name}]. Blocked by script-src, so it is dead code.`);
      }
    }
  }
}

/**
 * `script-src 'self'` plus hashes. A same-origin `src` is covered by `'self'`; a
 * cross-origin one would be refused at runtime, and a build is a much better
 * place to find that out than a phone in a WhatsApp WebView.
 */
function checkScriptSources(page, tags) {
  for (const tag of tags) {
    if (tag.name !== 'script') continue;
    const src = tag.attrs.src;
    if (src === undefined || src === '') continue;
    if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(src)) {
      fail(`${page}: cross-origin <script src="${src}">. script-src is 'self' (SECURITY.md §8.1).`);
    }
  }
}

function hashInlineScripts(page, html) {
  const hashes = [];
  let sawTheme = false;

  SCRIPT_RE.lastIndex = 0;
  let m;
  while ((m = SCRIPT_RE.exec(html)) !== null) {
    const attrs = parseAttrs(m[1] ?? '');
    const body = m[2] ?? '';
    // An external script is governed by 'self', not by a hash.
    if (attrs.src !== undefined && attrs.src !== '') continue;
    // A zero-length body is not a script; hashing it would add a source that
    // matches every empty inline script on the internet.
    if (body === '') continue;
    if (body === THEME_BOOTSTRAP) sawTheme = true;
    const source = sha256Source(body);
    if (!hashes.includes(source)) hashes.push(source);
  }

  // An unterminated <script> means the regex above silently skipped everything
  // after it, so the page would ship with unhashed inline JS and a policy that
  // blocks it. Count open tags and closers and refuse to guess.
  const opens = (html.match(/<script\b/gi) ?? []).length;
  const closes = (html.match(/<\/script\s*>/gi) ?? []).length;
  if (opens !== closes) {
    fail(`${page}: ${opens} <script> open tags but ${closes} closers. Refusing to emit a partial hash list.`);
  }

  return { hashes, sawTheme };
}

/* =====================================================================
 * The theme bootstrap, checked at the source
 * ===================================================================== */

function checkLayoutSource() {
  let source;
  try {
    source = readFileSync(LAYOUT_FILE, 'utf8');
  } catch {
    fail('app/layout.tsx is missing. It carries the theme bootstrap that every page is required to inline.');
    return;
  }

  if (!source.includes(THEME_BOOTSTRAP)) {
    fail(
      'app/layout.tsx no longer contains the exact DESIGN.md §2.1 theme bootstrap that scripts/csp-hashes.mjs ' +
        'hashes. Update BOTH or neither — a mismatch means every page ships an unhashed inline script.',
    );
  }

  // `\s*[=:]` matches the JSX attribute and the createElement prop form and NOT
  // the several places the identifier is named in prose — including three in this
  // file and one in scripts/csp-hashes.mjs. A rule that fires on its own rationale
  // gets deleted within a week.
  const dangerCount = (source.match(DANGER_USE_RE) ?? []).length;
  if (dangerCount !== 1) {
    fail(
      `app/layout.tsx has ${dangerCount} occurrences of dangerouslySetInnerHTML; exactly 1 is allowed ` +
        '(ARCHITECTURE.md §4 rule 5 — the theme bootstrap, and nothing else).',
    );
  }

  // "compile-time string literal with no interpolation — the build fails if it
  // contains `${`" (DESIGN.md §2.1). Reached by requiring the __html value to be
  // a bare identifier: a template literal or a concatenation cannot be one.
  const html = /__html:\s*([^}]*)\}/.exec(source);
  if (html === null || !/^[A-Za-z_$][\w$]*\s*$/.test(html[1] ?? '')) {
    fail(
      'app/layout.tsx must pass a plain identifier to __html (the THEME_BOOTSTRAP constant). A template ' +
        'literal or a concatenation can interpolate, which is exactly what the CSP hash cannot survive.',
    );
  }

  // IA.md §4.0 rule 2. A layout title emits a SECOND <title> on the shells; the
  // shell gate below catches it in out/, and this catches it in the source with a
  // message that names the actual rule.
  if (/^\s*export\s+(?:const|async\s+function|function)\s+(?:metadata|generateMetadata)\b/m.test(source)) {
    fail(
      'app/layout.tsx exports metadata. IA.md §4.0: the layout sets no title/description/openGraph, because ' +
        "Next's Metadata API cannot set an element id and emits the layout's <title> on every page — giving " +
        'each shell two <title> elements and the WhatsApp crawler a coin flip it caches for days.',
    );
  }
}

/**
 * The bound on rule 5 is "exactly one occurrence in the tree, in app/layout.tsx".
 * ESLint enforces it for .ts/.tsx; this catches anything ESLint's globs miss.
 */
function checkNoOtherDangerouslySetInnerHTML() {
  const roots = ['app', 'components', 'lib', 'worker', 'scripts'];
  const skip = new Set(['node_modules', '.next', 'out', '.wrangler', 'coverage']);

  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (skip.has(entry)) continue;
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(?:ts|tsx|js|jsx|mjs|cjs)$/.test(entry)) continue;
      if (full === LAYOUT_FILE) continue;
      DANGER_USE_RE.lastIndex = 0;
      if (DANGER_USE_RE.test(readFileSync(full, 'utf8'))) {
        fail(
          `${relative(ROOT, full)}: dangerouslySetInnerHTML. It appears in exactly one file in this codebase, ` +
            'app/layout.tsx (ARCHITECTURE.md §4 rule 5). Rich text arrives as a closed-allowlist JSON AST and is ' +
            'rendered through a switch into real React elements.',
        );
      }
    }
  };

  for (const root of roots) walk(join(ROOT, root));
}

/* =====================================================================
 * The shell head-tag gate
 * ===================================================================== */

function checkShellHeadTags(page, html) {
  const tags = parseTags(blankScriptBodies(html));

  const titles = tags.filter((t) => t.name === 'title');
  if (titles.length !== 1) {
    fail(
      `${page}: ${titles.length} <title> elements, expected exactly 1. ` +
        'The Worker rewrites the one matching #nc-title; a second one is a coin flip for the WhatsApp ' +
        'crawler, cached for days with no purge API (IA.md §4.0).',
    );
  }

  for (const required of REQUIRED_SHELL_TAGS) {
    const withId = tags.filter((t) => t.attrs.id === required.id);
    if (withId.length !== 1) {
      fail(
        `${page}: ${withId.length} elements with id="${required.id}", expected exactly 1. ` +
          `The Worker's HTMLRewriter REPLACES attributes and never appends, so a missing ${required.label} ` +
          'silently never appears in the shared link preview.',
      );
      continue;
    }
    if (!required.match(withId[0])) {
      fail(`${page}: id="${required.id}" is on <${withId[0].name}>, expected ${required.label}.`);
    }
    const matching = tags.filter((t) => required.match(t));
    if (matching.length !== 1) {
      fail(
        `${page}: ${matching.length} ${required.label} elements, expected exactly 1. ` +
          'A duplicate gives the crawler two answers and it picks one at random.',
      );
    }
  }
}

function checkBareShell(page, html) {
  const tags = parseTags(blankScriptBodies(html));

  const titles = tags.filter((t) => t.name === 'title');
  if (titles.length !== 0) {
    fail(
      `${page}: ${titles.length} <title> elements, expected 0. The admin shell is never injected and never ` +
        'indexed, so a title here means something (almost certainly app/layout.tsx) is emitting one for every ' +
        'page — which gives the tournament and player shells two (IA.md §4.0).',
    );
  }

  for (const required of REQUIRED_SHELL_TAGS) {
    if (tags.some((t) => t.attrs.id === required.id)) {
      fail(`${page}: unexpected id="${required.id}". The admin shell ships no injectable meta tags (IA.md §2.2).`);
    }
  }
}

/* =====================================================================
 * Main
 * ===================================================================== */

function main() {
  let files;
  try {
    files = collectHtmlFiles(OUT_DIR);
  } catch {
    console.error('out/ does not exist. Run `next build` first — `npm run build` runs both halves in order.');
    process.exit(1);
  }

  if (files.length === 0) {
    console.error('out/ contains no HTML. A build that produced no pages is not a build.');
    process.exit(1);
  }

  checkLayoutSource();
  checkNoOtherDangerouslySetInnerHTML();

  const manifest = {};
  const themeHash = sha256Source(THEME_BOOTSTRAP);
  let totalHashes = 0;

  for (const file of files) {
    const page = assetPath(file);
    const html = readFileSync(file, 'utf8');
    const tags = parseTags(blankScriptBodies(html));

    checkForInlineHandlers(page, tags);
    checkScriptSources(page, tags);

    const { hashes, sawTheme } = hashInlineScripts(page, html);
    if (!sawTheme) {
      fail(
        `${page}: the theme bootstrap is not inlined in this page. Every document must set data-theme before ` +
          'first paint, or a dark-mode reader gets a white flash on every navigation (DESIGN.md §2.1).',
      );
    }
    if (!hashes.includes(themeHash)) {
      fail(`${page}: the theme bootstrap's sha256 is missing from this page's hash list.`);
    }

    manifest[page] = hashes;
    totalHashes += hashes.length;
  }

  for (const shell of INJECTED_SHELLS) {
    const file = join(OUT_DIR, shell.slice(1).split('/').join(sep));
    let html;
    try {
      html = readFileSync(file, 'utf8');
    } catch {
      fail(`${shell} was not built. Every /t/<slug>/ and /p/<handle>/ URL is served from it.`);
      continue;
    }
    checkShellHeadTags(shell, html);
  }

  {
    const file = join(OUT_DIR, BARE_SHELL.slice(1).split('/').join(sep));
    try {
      checkBareShell(BARE_SHELL, readFileSync(file, 'utf8'));
    } catch {
      fail(`${BARE_SHELL} was not built. Every /admin/** URL is served from it.`);
    }
  }

  if (errors.length > 0) {
    console.error(`\ncsp-hashes: ${errors.length} problem(s) — the build is refused.\n`);
    for (const error of errors) console.error(`  • ${error}\n`);
    process.exit(1);
  }

  // Sorted so the committed file has a stable diff: a hash list that reorders on
  // every build makes a real change to the policy invisible in review.
  const sorted = {};
  for (const key of Object.keys(manifest).sort()) sorted[key] = manifest[key];
  writeFileSync(HASHES_FILE, `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');

  console.log(
    `csp-hashes: ${files.length} pages, ${totalHashes} inline script hashes -> ${relative(ROOT, HASHES_FILE)}`,
  );
}

main();
