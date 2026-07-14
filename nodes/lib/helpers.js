/** @module nodes/lib/helpers */

/**
 * Shared helper functions for portal-react. Pure helpers (hash, validators,
 * esbuild wrappers) are exported at module level; runtime helpers that need
 * `RED` (cache, tailwind, preInstall hook) are produced by the default export
 * factory.
 */

/**
 * @typedef {Object} TranspileResult
 * @property {string|null} js          Compiled IIFE bundle, or null on error.
 * @property {string|null} [error]     Multi-line error description from esbuild.
 * @property {Object}      [metafile]  Optional esbuild metafile (size analysis).
 */

/**
 * @typedef {Object} SubPathResult
 * @property {boolean} ok
 * @property {string}  [value]
 * @property {string}  [error]
 */

/**
 * @typedef {Object} PortalUser
 * @property {string}              [userId]
 * @property {string}              [userName]
 * @property {string}              [username]
 * @property {string}              [email]
 * @property {string}              [role]
 * @property {string|Array<string>}[groups]
 */

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const esbuild = require("esbuild");

// Cap on JSON-encoded `x-portal-user-groups` header — protects JSON.parse from
// being fed an unbounded payload by a misbehaving auth proxy / forged header.
// Same order of magnitude as Express default header size; trimming here so a
// 1MB string can't reach JSON.parse.
const MAX_GROUPS_HEADER_BYTES = 8 * 1024;

/**
 * Short content hash used for cache keys (16 hex chars of sha256).
 * @param {string} str
 * @returns {string}
 */
function hash(str) {
  return crypto.createHash("sha256").update(str).digest("hex").slice(0, 16);
}

const twCompile = require("tailwindcss").compile;
const CANDIDATE_RE = /[a-zA-Z0-9_\-:.\/\[\]#%]+/g;

// Contents of "…", '…' and `…` literals in the scanned source. Tailwind
// classes live inside string literals, and splitting THOSE on whitespace
// keeps arbitrary values with `(`, `)`, `,`, `!`, `@`, `'` intact — chars
// CANDIDATE_RE cannot include globally without gluing candidates to
// surrounding code (`className="w-…`). Single regex alternation, escape-aware.
const STRING_LITERAL_RE =
  /"([^"\\\n]*(?:\\.[^"\\\n]*)*)"|'([^'\\\n]*(?:\\.[^'\\\n]*)*)'|`([^`\\]*(?:\\.[^`\\]*)*)`/g;

let twCompiled = null;
/**
 * Lazily compile the Tailwind base stylesheet. Result is memoized at module
 * scope — first call resolves async stylesheet imports, every subsequent
 * call returns the cached compiler.
 *
 * @returns {Promise<Object>}  Tailwind `compile()` result with a `.build()` method.
 */
async function getTwCompiled() {
  if (twCompiled) return twCompiled;
  twCompiled = await twCompile(`@import 'tailwindcss';`, {
    loadStylesheet: async (id, base) => {
      let resolved;
      if (id === "tailwindcss") {
        resolved = require.resolve("tailwindcss/index.css");
      } else {
        resolved = require.resolve(id, { paths: [base || __dirname] });
      }
      return {
        content: fs.readFileSync(resolved, "utf8"),
        base: path.dirname(resolved),
      };
    },
  });
  return twCompiled;
}

/**
 * Generate the per-page Tailwind CSS bundle by scanning `source` for utility
 * class candidates and feeding them to the compiled Tailwind core.
 *
 * @param {string} source                       Source text to scan for class candidates.
 * @returns {Promise<{css: string, cssHash: string}>}
 */
async function generateCSS(source) {
  const cssHash = hash(source);
  const compiled = await getTwCompiled();
  const candidates = new Set(source.match(CANDIDATE_RE) || []);
  // Second pass: whitespace-split string-literal contents so arbitrary
  // values like w-[calc(100%-2rem)], grid-cols-[repeat(2,1fr)], mt-0! and
  // @md:flex survive as single candidates. Tailwind ignores candidates that
  // don't parse as utilities, so the extra tokens are harmless.
  STRING_LITERAL_RE.lastIndex = 0;
  let m;
  while ((m = STRING_LITERAL_RE.exec(source)) !== null) {
    const body = m[1] ?? m[2] ?? m[3] ?? "";
    for (const tok of body.split(/\s+/)) if (tok) candidates.add(tok);
  }
  const css = compiled.build([...candidates]);
  return { css, cssHash };
}

// Component / utility names become JavaScript identifiers in the generated
// bundle (`const Name = (() => ...)();` for components; raw top-level decls
// for utilities). Enforce strict identifier syntax up-front so the diagnostic
// surfaces on the offending node — not as a confusing esbuild parse error on
// some unrelated portal that happens to import it.
const NAME_RE = /^[A-Za-z_$][\w$]*$/;
const NAME_MAX_LEN = 64;
const NAME_BLACKLIST = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toString",
  "valueOf",
  "toLocaleString",
]);

/**
 * True when `name` is a syntactically valid JavaScript identifier of bounded
 * length that does not collide with Object prototype keys.
 *
 * Rules:
 * - non-empty string
 * - length ≤ 64
 * - matches /^[A-Za-z_$][\w$]*$/
 * - not in NAME_BLACKLIST (prototype pollution guard)
 *
 * @param {unknown} name
 * @returns {boolean}
 */
function isSafeName(name) {
  return (
    typeof name === "string" &&
    name.length > 0 &&
    name.length <= NAME_MAX_LEN &&
    NAME_RE.test(name) &&
    !NAME_BLACKLIST.has(name)
  );
}

const SUB_PATH_SEGMENT_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const SUB_PATH_RESERVED = new Set(["public", "_ws"]);

/**
 * Validate a portal sub-path (the part served under `/fromcubes/<sub-path>`).
 *
 * Rules: non-empty, no leading/trailing slash, no whitespace, segments match
 * `[a-zA-Z0-9][a-zA-Z0-9._-]*`, reserved segments `public` and `_ws` are
 * blocked case-insensitively. Multiple slash-separated segments are allowed.
 *
 * @param {unknown} input
 * @returns {SubPathResult}
 */
function validateSubPath(input) {
  if (typeof input !== "string") {
    return { ok: false, error: "Sub-path is required" };
  }
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Sub-path is required" };
  }
  if (/\s/.test(trimmed)) {
    return { ok: false, error: "Sub-path must not contain whitespace" };
  }
  if (trimmed.startsWith("/")) {
    return { ok: false, error: "Sub-path must not start with /" };
  }
  if (trimmed.endsWith("/")) {
    return { ok: false, error: "Sub-path must not end with /" };
  }
  const segments = trimmed.split("/");
  for (const seg of segments) {
    if (seg.length === 0) {
      return { ok: false, error: "Sub-path must not contain empty segments" };
    }
    if (seg === "." || seg === "..") {
      return { ok: false, error: "Path traversal not allowed in sub-path" };
    }
    if (SUB_PATH_RESERVED.has(seg.toLowerCase())) {
      return {
        ok: false,
        error: `Sub-path segment "${seg}" is reserved`,
      };
    }
    if (!SUB_PATH_SEGMENT_RE.test(seg)) {
      return {
        ok: false,
        error: `Sub-path segment "${seg}" contains invalid characters`,
      };
    }
  }
  return { ok: true, value: trimmed };
}

/**
 * Build a PortalUser object from `x-portal-user-*` headers set by an upstream
 * auth proxy. Returns null when no header is present.
 *
 * @param {Object<string,string>} headers HTTP request headers (lower-cased).
 * @returns {PortalUser|null}
 */
function extractPortalUser(headers) {
  const user = {};
  if (headers["x-portal-user-id"]) user.userId = headers["x-portal-user-id"];
  if (headers["x-portal-user-name"])
    user.userName = headers["x-portal-user-name"];
  if (headers["x-portal-user-username"])
    user.username = headers["x-portal-user-username"];
  if (headers["x-portal-user-email"])
    user.email = headers["x-portal-user-email"];
  if (headers["x-portal-user-role"]) user.role = headers["x-portal-user-role"];
  const groupsRaw = headers["x-portal-user-groups"];
  if (typeof groupsRaw === "string" && groupsRaw.length > 0) {
    if (groupsRaw.length > MAX_GROUPS_HEADER_BYTES) {
      // Truncated → fall back to the raw string (safer than feeding multi-MB
      // into JSON.parse). Auth proxy should never produce headers this large.
      user.groups = groupsRaw.slice(0, MAX_GROUPS_HEADER_BYTES);
    } else {
      try {
        user.groups = JSON.parse(groupsRaw);
      } catch (_) {
        user.groups = groupsRaw;
      }
    }
  }
  return Object.keys(user).length > 0 ? user : null;
}

/**
 * Remove a single route mount-point from an Express router by exact path
 * match. Used at deploy teardown to drop the previous portal's HTTP route
 * before re-registering on the same path.
 *
 * @param {Object} router  Express router (or Express app).
 * @param {string} path    Exact route path to remove (no glob/regex).
 * @returns {void}
 */
function removeRoute(router, path) {
  if (!router || !router.stack) return;
  router.stack = router.stack.filter(
    (layer) => !(layer.route && layer.route.path === path),
  );
}

/**
 * @typedef {Object} EsbuildErrorLocation
 * @property {number} line
 */

/**
 * @typedef {Object} EsbuildErrorEntry
 * @property {string}                text
 * @property {EsbuildErrorLocation}  [location]
 */

/**
 * @typedef {Object} EsbuildErrorLike
 * @property {Array<EsbuildErrorEntry>} [errors]
 * @property {string}                    [message]
 */

/**
 * Flatten an esbuild error object into a single multi-line string suitable
 * for `node.error()` and the in-page error overlay. Includes line numbers
 * when esbuild provides them; falls back to `.message` otherwise.
 *
 * @param {EsbuildErrorLike} e
 * @returns {string}
 */
function formatEsbuildError(e) {
  return e.errors?.length
    ? e.errors
        .map(
          (err) =>
            `${err.text}${err.location ? ` (line ${err.location.line})` : ""}`,
        )
        .join("\n")
    : e.message;
}

/**
 * Fast JSX syntax validation via esbuild `transformSync` (no bundling, no
 * filesystem lookup). Used at deploy time on individual component/utility
 * snippets so the editor can attribute syntax errors to the offending node
 * before any bundling pass runs on the portal.
 *
 * @param {string} jsx
 * @returns {string|null}  Multi-line error string, or null when JSX is syntactically valid.
 */
function quickCheckSyntax(jsx) {
  if (!jsx || !jsx.trim()) return null;
  try {
    esbuild.transformSync(jsx, {
      loader: "jsx",
      jsx: "transform",
      jsxFactory: "React.createElement",
      jsxFragment: "React.Fragment",
      logLevel: "silent",
    });
    return null;
  } catch (e) {
    return formatEsbuildError(e);
  }
}

// Identifiers that resolve at runtime through the bundler shim (React et al.)
// rather than through registry / utility / local-def lookup. Anything in this
// set is treated as "always satisfied" by findMissingComponentRefs.
const REACT_BUILTIN_TAGS = new Set([
  "React",
  "Fragment",
  "Suspense",
  "StrictMode",
  "Profiler",
  "ReactDOM",
  "App",
]);

const PASCAL_TAG_RE = /<\s*([A-Z][A-Za-z0-9_]*)/g;
const RE_ESCAPE = /[.*+?^${}()|[\]\\]/g;

// Cached identifier-boundary regexes shared by every "does this code
// reference identifier X" scan (component deps, utility selection, dirty-
// portal matching, topological sort). `\b` breaks for names that start or
// end with `$` — a legal identifier char that is not a regex word char — so
// lookarounds on the [\w$] class are used instead. Cache is bounded: cleared
// wholesale past 5000 entries (long-running process with many renames).
const IDENT_RE_CACHE = new Map();

/**
 * Return a cached RegExp matching `name` as a standalone JS identifier
 * (not as a prefix/suffix/substring of a longer identifier).
 *
 * @param {string} name  Identifier to match (component/utility/symbol name).
 * @returns {RegExp}
 */
function identifierRe(name) {
  let re = IDENT_RE_CACHE.get(name);
  if (!re) {
    if (IDENT_RE_CACHE.size > 5000) IDENT_RE_CACHE.clear();
    const escaped = name.replace(RE_ESCAPE, "\\$&");
    re = new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`);
    IDENT_RE_CACHE.set(name, re);
  }
  return re;
}

// Keywords after which a `<` starts a JSX element even though the preceding
// significant character is a letter (`return <div/>` vs the comparison
// `a < b`). Used by the JSX-context tracking in stripComments.
const JSX_PREFIX_KEYWORDS = new Set([
  "return",
  "case",
  "typeof",
  "do",
  "else",
  "void",
  "yield",
  "await",
  "in",
  "of",
  "new",
  "delete",
  "throw",
  "instanceof",
]);

/**
 * Replace every `//` and `/* *​/` comment in `code` with spaces, leaving
 * strings, template literals, newlines — and JSX text — untouched. Output
 * has exactly the same length and line structure as the input, so match
 * offsets and line numbers computed against the stripped text are valid in
 * the original.
 *
 * JSX-aware, matching esbuild's semantics: between JSX tags (children
 * context) `//` and `/* *​/` are literal text, NOT comments — esbuild
 * renders them — so they are left in place and any `<Tag/>` after them
 * stays visible to the scans. Comments are only stripped in real JS
 * contexts: top-level code, `{…}` expressions inside JSX, and inside
 * opening tags between attributes (where esbuild does allow comments).
 * `{/* … *​/}` in children is a `{…}` expression holding a block comment,
 * so its body is blanked as before.
 *
 * Used by every regex-based code scan (missing-component preflight, import
 * hoisting, App/return detection) so commented-out code is invisible to
 * them — and NOT-commented-out code (like `// <Gauge/>` in children, which
 * esbuild treats as text plus a live element) stays visible.
 *
 * The Monaco Ctrl+/ handler in portal-react.html carries a client-side
 * mirror of this scanner (`__fcJsxContextAt`) — keep the two in sync.
 *
 * Regex literals are not tracked — an unescaped `//` inside a character
 * class (`/[//]/`) is misread as a comment. The scans this feeds are
 * advisory, and esbuild always parses the original source, so the worst
 * case is a skipped preflight warning.
 *
 * @param {string} code
 * @param {boolean} [blankStrings=false]  Also blank the interior of string
 *     and template literals (quotes stay). Used by scans where text inside a
 *     string must not look like code — e.g. `"see <Gauge/>"` is not a JSX
 *     usage. JSX children text is not a string literal and is never blanked.
 * @returns {string}  Same-length text with comment bodies blanked.
 */
function stripComments(code, blankStrings = false) {
  if (!code || typeof code !== "string") return "";
  const out = code.split("");
  const n = code.length;

  // Frame stack tracking JSX context; the bottom frame is plain JS:
  //   { t: "js", depth }  – JS code / `{…}` expression inside JSX
  //                         (depth = open braces inside this frame)
  //   { t: "tag", slash } – inside an opening tag `<Tag …>` (slash = last
  //                         significant char was "/", i.e. self-closing)
  //   { t: "children" }   – between `<Tag…>` and `</Tag>`: JSX text
  const stack = [{ t: "js", depth: 0 }];

  // Lookbehind for js frames, used to decide whether `<` starts JSX.
  let prev = ""; // last significant char
  let prev2 = ""; // significant char before prev
  let word = ""; // identifier ending at prev ("" when prev is not ident)
  let prevIdent = false; // was the immediately preceding raw char ident?

  const IDENT_CH = /[A-Za-z0-9_$]/;

  function sig(ch) {
    prev2 = prev;
    prev = ch;
    if (IDENT_CH.test(ch)) {
      word = prevIdent ? word + ch : ch;
      prevIdent = true;
    } else {
      word = "";
      prevIdent = false;
    }
  }

  function startsJsx(next) {
    if (!/[A-Za-z_$>]/.test(next)) return false; // <ident, </? no, <> fragment yes
    if (prev === "") return true;
    if (prev === "<") return false; // `a << b`
    if (/[A-Za-z0-9_$)\]}"'`]/.test(prev))
      return JSX_PREFIX_KEYWORDS.has(word); // `return <div/>` vs `a < b`
    if (prev === ">") return prev2 === "="; // arrow `=> <div/>`
    return true; // ( , ? : = & | [ { ; ! …
  }

  // A complete JSX element that closes back into a js frame is an
  // expression — mark the lookbehind expression-ish so a following `<`
  // reads as a comparison, not a new element.
  function poppedIntoJs() {
    if (stack[stack.length - 1].t === "js") {
      prev = ")";
      prev2 = "";
      word = "";
      prevIdent = false;
    }
  }

  function blankLineComment() {
    out[i] = out[i + 1] = " ";
    i += 2;
    while (i < n && code[i] !== "\n") {
      out[i] = " ";
      i++;
    }
  }

  function blankBlockComment() {
    out[i] = out[i + 1] = " ";
    i += 2;
    while (i < n && !(code[i] === "*" && code[i + 1] === "/")) {
      if (code[i] !== "\n") out[i] = " ";
      i++;
    }
    if (i < n) {
      out[i] = out[i + 1] = " ";
      i += 2;
    }
  }

  function enterExpr() {
    stack.push({ t: "js", depth: 0 });
    prev = "";
    prev2 = "";
    word = "";
    prevIdent = false;
    i++;
  }

  let i = 0;
  while (i < n) {
    const top = stack[stack.length - 1];
    const c = code[i];
    const d = i + 1 < n ? code[i + 1] : "";

    if (top.t === "children") {
      if (c === "<" && d === "/") {
        // closing tag — skip to ">" and leave the element
        i += 2;
        while (i < n && code[i] !== ">") i++;
        i++;
        stack.pop();
        poppedIntoJs();
        continue;
      }
      if (c === "<" && /[A-Za-z_$>]/.test(d)) {
        stack.push({ t: "tag", slash: false });
        i++;
        continue;
      }
      if (c === "{") {
        enterExpr();
        continue;
      }
      i++; // JSX text — `//`, `/*`, quotes are all literal content here
      continue;
    }

    if (top.t === "tag") {
      if (c === '"' || c === "'") {
        // JSX attribute value — no escape processing in JSX strings
        i++;
        while (i < n && code[i] !== c) {
          if (blankStrings && code[i] !== "\n") out[i] = " ";
          i++;
        }
        i++;
        top.slash = false;
        continue;
      }
      if (c === "/" && d === "/") {
        blankLineComment(); // comments between attributes are real comments
        continue;
      }
      if (c === "/" && d === "*") {
        blankBlockComment();
        continue;
      }
      if (c === "{") {
        enterExpr();
        continue;
      }
      if (c === ">") {
        const selfClose = top.slash;
        stack.pop();
        if (selfClose) poppedIntoJs();
        else stack.push({ t: "children" });
        i++;
        continue;
      }
      if (!/\s/.test(c)) top.slash = c === "/";
      i++;
      continue;
    }

    // js frame (top-level code or `{…}` expression inside JSX)
    if (c === '"' || c === "'" || c === "`") {
      const q = c;
      i++;
      while (i < n && code[i] !== q) {
        if (code[i] === "\\") {
          if (blankStrings) {
            out[i] = " ";
            if (i + 1 < n && code[i + 1] !== "\n") out[i + 1] = " ";
          }
          i += 2;
          continue;
        }
        if (blankStrings && code[i] !== "\n") out[i] = " ";
        i++;
      }
      i++;
      sig(q);
      continue;
    }
    if (c === "/" && d === "/") {
      blankLineComment();
      continue;
    }
    if (c === "/" && d === "*") {
      blankBlockComment();
      continue;
    }
    if (c === "{") {
      top.depth++;
      sig(c);
      i++;
      continue;
    }
    if (c === "}") {
      if (top.depth === 0 && stack.length > 1) {
        stack.pop(); // end of `{…}` expression — back to tag/children
        if (stack[stack.length - 1].t === "tag")
          stack[stack.length - 1].slash = false;
        i++;
        continue;
      }
      if (top.depth > 0) top.depth--;
      sig(c);
      i++;
      continue;
    }
    if (c === "<" && startsJsx(d)) {
      stack.push({ t: "tag", slash: false });
      i++;
      continue;
    }
    if (/\s/.test(c)) {
      prevIdent = false;
      i++;
      continue;
    }
    sig(c);
    i++;
  }
  return out.join("");
}

// Trailing whitespace must stay inside the line ([^\S\r\n], not \s): ranges
// are computed on comment-stripped text and sliced out of the original, so a
// match crossing the newline would swallow whatever the next line holds.
const IMPORT_RE = /^import\s+.+?from\s+['"].+?['"];?[^\S\r\n]*$/gm;

/**
 * Extract top-level `import … from '…'` statements from `code`, ignoring
 * any that sit inside comments. Matching runs against the comment-stripped
 * text (same offsets as the original), so a commented-out import survives
 * in place as an inert comment instead of being hoisted into the bundle.
 *
 * @param {string} code
 * @returns {{imports: string[], clean: string}}  The live import statements
 *     in source order, and `code` with exactly those ranges removed
 *     (trimmed).
 */
function extractImports(code) {
  if (!code || typeof code !== "string") return { imports: [], clean: "" };
  const stripped = stripComments(code);
  const imports = [];
  const ranges = [];
  IMPORT_RE.lastIndex = 0;
  let m;
  while ((m = IMPORT_RE.exec(stripped)) !== null) {
    imports.push(code.slice(m.index, m.index + m[0].length).trim());
    ranges.push([m.index, m.index + m[0].length]);
  }
  let clean = "";
  let last = 0;
  for (const [s, e] of ranges) {
    clean += code.slice(last, s);
    last = e;
  }
  clean += code.slice(last);
  return { imports, clean: clean.trim() };
}

/**
 * Detect whether `code` defines an `App` component and, for the
 * `function App() { … }` form, whether its body contains a `return`.
 * Comments are stripped first, so `// return null` inside the body or a
 * commented-out `function App()` do not count.
 *
 * @param {string} code  User JSX (imports may or may not be present).
 * @returns {{hasApp: boolean, missingReturn: boolean}}
 */
function checkAppCode(code) {
  const src = stripComments(code || "");
  const hasApp =
    /\b(?:export\s+default\s+)?function\s+App\s*\(/.test(src) ||
    /\bclass\s+App\b/.test(src) ||
    /\b(?:const|let|var)\s+App\s*=/.test(src);

  let missingReturn = false;
  const appFnMatch = src.match(
    /(?:export\s+default\s+)?function\s+App\s*\([^)]*\)\s*\{/,
  );
  if (appFnMatch) {
    let depth = 1;
    let i = appFnMatch.index + appFnMatch[0].length;
    let hasReturn = false;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (src.slice(i, i + 7) === "return ") hasReturn = true;
      i++;
    }
    missingReturn = !hasReturn;
  }
  return { hasApp, missingReturn };
}

/**
 * Find PascalCase JSX tags in `userCode` that have no visible definition.
 *
 * Used at deploy time to catch the case where a portal references a shared
 * component (e.g. `<Header/>`) without the example flow that defines it
 * being imported into Node-RED. Without this check the bundler silently
 * skips the missing name and the browser crashes with `ReferenceError`.
 *
 * A tag is considered satisfied when ANY of:
 *   - its name is in `knownNames` (component registry / utility symbols)
 *   - its name is a React built-in (`React`, `Fragment`, `Suspense`, …)
 *   - the bare identifier appears outside JSX-tag context in `userCode`
 *     (covers `import {Name} from …`, `function Name(){…}`, `const Name = …`,
 *     `class Name extends …`)
 *
 * @param {string} userCode
 * @param {Set<string>} knownNames
 * @returns {Set<string>}  PascalCase names referenced in JSX with nothing
 *     to satisfy them.
 */
function findMissingComponentRefs(userCode, knownNames) {
  if (!userCode || typeof userCode !== "string") return new Set();
  const known = knownNames instanceof Set ? knownNames : new Set();

  // Scan with comments AND string interiors blanked: a commented-out <Tag/>
  // is not a usage, a commented-out `const Tag = …` is not a definition, and
  // `"see <Tag/> in the docs"` is neither.
  const src = stripComments(userCode, true);

  PASCAL_TAG_RE.lastIndex = 0;
  const used = new Set();
  let m;
  while ((m = PASCAL_TAG_RE.exec(src)) !== null) used.add(m[1]);

  const missing = new Set();
  for (const name of used) {
    if (REACT_BUILTIN_TAGS.has(name)) continue;
    if (known.has(name)) continue;
    const escaped = name.replace(RE_ESCAPE, "\\$&");
    const stripped = src.replace(
      new RegExp(`<\\s*/?\\s*${escaped}\\b`, "g"),
      "",
    );
    if (new RegExp(`\\b${escaped}\\b`).test(stripped)) continue;
    missing.add(name);
  }
  return missing;
}

/**
 * Resolve the content hash the server may advertise to a browser over the WS
 * `version` frame. The hash MUST only be non-empty when there is a page the
 * GET route can actually serve — otherwise a stale hash makes the served error
 * / building page reload in a tight loop (it reloads on any non-empty
 * `version` hash).
 *
 * States, in order:
 *   - no state / nulled `compiled` (post-`close` teardown window) → ""
 *   - degraded (build error but a previous good build is kept) → lastGood hash
 *   - hard build error with no fallback → ""
 *   - real serveable build (`compiled.js` present) → contentHash
 *
 * @param {?PageState} state  pageState[endpoint] (may be null/partially torn down).
 * @returns {string}          Hash to advertise, or "" when nothing is serveable.
 */
function serveableHash(state) {
  if (!state || !state.compiled) return "";
  if (state.compiled.error) {
    return state.lastGood ? state.lastGood.contentHash || "" : "";
  }
  return state.compiled.js ? state.contentHash || "" : "";
}

/**
 * True only when `state` holds a real, serveable build. Used by the no-op
 * redeploy guard to decide whether a rebuild can be skipped. MUST be false
 * after close() nulls `compiled` (`{ ...compiled: null }` teardown window),
 * otherwise the guard treats the destroyed build as valid, skips the rebuild,
 * and the GET route serves the holding page forever (permanent spinner).
 *
 * @param {?PageState} state  pageState[endpoint] (may be null/torn down).
 * @returns {boolean}
 */
function hasFreshBuild(state) {
  return !!state && !state.building && !!state.compiled && !state.compiled.error;
}

/**
 * Decide whether the `preInstall` hook may veto an npm install because the
 * module is already on disk. Vetoing is ONLY safe for plain installs of an
 * already-present package (the offline/Docker case). It must never swallow:
 *
 *   - **upgrades** (`event.isUpgrade`) — the palette manager's "update"
 *     button routes through the same install path; vetoing it makes Node-RED
 *     mark the module `pendingUpdated` and demand a restart while the old
 *     files stay on disk — the update silently never lands,
 *   - **explicit version requests** that differ from the installed version
 *     (e.g. a `libs` entry bumped from `^4.4.0`) — npm itself no-ops when
 *     the range is already satisfied, so letting it run is the safe side.
 *
 * An unreadable/corrupt package.json also proceeds with the install (npm
 * repairs what we cannot verify).
 *
 * @param {{dir: string, module: string, version?: string, isUpgrade?: boolean}} event
 *        `preInstall` hook payload from `@node-red/registry`.
 * @returns {boolean}  true → hook should return false (skip npm install).
 */
function shouldSkipInstall(event) {
  if (event.isUpgrade) return false;
  const modDir = path.join(event.dir, "node_modules", event.module);
  if (!fs.existsSync(modDir)) return false;
  if (event.version) {
    let installed;
    try {
      installed = JSON.parse(
        fs.readFileSync(path.join(modDir, "package.json"), "utf8"),
      ).version;
    } catch (_) {
      return false;
    }
    if (installed !== event.version) return false;
  }
  return true;
}

module.exports = function (RED) {
  return createHelpers(RED);
};

module.exports.validateSubPath = validateSubPath;
module.exports.generateCSS = generateCSS;
module.exports.isSafeName = isSafeName;
module.exports.quickCheckSyntax = quickCheckSyntax;
module.exports.formatEsbuildError = formatEsbuildError;
module.exports.extractPortalUser = extractPortalUser;
module.exports.findMissingComponentRefs = findMissingComponentRefs;
module.exports.stripComments = stripComments;
module.exports.extractImports = extractImports;
module.exports.checkAppCode = checkAppCode;
module.exports.identifierRe = identifierRe;
module.exports.serveableHash = serveableHash;
module.exports.hasFreshBuild = hasFreshBuild;
module.exports.shouldSkipInstall = shouldSkipInstall;
module.exports.NAME_MAX_LEN = NAME_MAX_LEN;
module.exports.MAX_GROUPS_HEADER_BYTES = MAX_GROUPS_HEADER_BYTES;

/**
 * Factory that produces the runtime helper bag bound to a Node-RED instance.
 * Returns the union of pure helpers (re-exported from module scope) and
 * runtime helpers that need `RED` (disk cache, preInstall hook, transpile).
 *
 * @param {Object} RED  Node-RED runtime object.
 * @returns {Object}    Helper bag — see the `return { … }` at the bottom of the function for the full surface.
 */
function createHelpers(RED) {
  // Package root — where react/react-dom live (this package's own node_modules)
  const pkgRoot = path.join(__dirname, "../..");
  // userDir — where dynamicModuleList installs user packages
  const userDir = RED.settings.userDir || path.join(__dirname, "../../../..");

  /**
   * `preInstall` hook (Node-RED 1.3+) — vetoes an npm install when the
   * package is already on disk. Useful for offline/Docker setups where
   * Node-RED's auto-install pass would otherwise try to hit the registry
   * and fail. Upgrades and mismatched explicit versions are never vetoed
   * (see {@link shouldSkipInstall}) — vetoing an upgrade leaves the old
   * files on disk while Node-RED demands a restart, so the update never
   * installs. Hook itself is *optional by design*: any unexpected error
   * inside the body MUST NOT bubble up (it would cancel an install path
   * the user actually expected to run). We log at `trace` level so the
   * developer can opt into diagnostics via `logging.level = trace` in
   * `settings.js`, without spamming default-level logs.
   *
   * @param {{dir: string, module: string, version?: string, isUpgrade?: boolean}} event
   * @returns {boolean|void}  `false` skips the install; anything else proceeds.
   * @listens RED.hooks#preInstall.portalReact
   */
  RED.hooks.add("preInstall.portalReact", (event) => {
    try {
      if (shouldSkipInstall(event)) {
        RED.log.info(
          `[portal-react] ${event.module} already in node_modules, skipping install`,
        );
        return false;
      }
    } catch (e) {
      RED.log.trace("[portal-react] preInstall hook err: " + e.message);
    }
  });

  // ── Disk cache for JS bundles and CSS ────────────────────────
  const cacheDir = path.join(userDir, "fromcubes", "cache");
  fs.mkdirSync(cacheDir, { recursive: true });

  /**
   * Load a cached compiled bundle from disk by JSX hash.
   *
   * @param {string} jsxHash
   * @returns {?{js: string, metafile: ?Object, error: null}}  null on cache miss.
   */
  function readCachedJS(jsxHash) {
    try {
      const js = fs.readFileSync(path.join(cacheDir, jsxHash + ".js"), "utf8");
      let metafile = null;
      try {
        metafile = JSON.parse(
          fs.readFileSync(path.join(cacheDir, jsxHash + ".meta.json"), "utf8"),
        );
      } catch (_) {}
      return { js, metafile, error: null };
    } catch (_) {
      return null;
    }
  }

  /**
   * Persist a compiled bundle (and optional metafile) to disk under `<hash>.js`.
   *
   * @param {string} jsxHash
   * @param {string} js
   * @param {Object} [metafile]  esbuild metafile for size analysis.
   * @returns {void}
   */
  function writeCachedJS(jsxHash, js, metafile) {
    try {
      fs.writeFileSync(path.join(cacheDir, jsxHash + ".js"), js, "utf8");
      if (metafile) {
        fs.writeFileSync(
          path.join(cacheDir, jsxHash + ".meta.json"),
          JSON.stringify(metafile),
          "utf8",
        );
      }
    } catch (e) {
      RED.log.warn("[portal-react] cache write failed: " + e.message);
    }
  }

  /**
   * Load a cached Tailwind CSS bundle from disk by JSX hash.
   *
   * @param {string} jsxHash
   * @returns {?{css: string, cssHash: string}}  null on cache miss.
   */
  function readCachedCSS(jsxHash) {
    try {
      const css = fs.readFileSync(
        path.join(cacheDir, jsxHash + ".css"),
        "utf8",
      );
      return { css, cssHash: jsxHash };
    } catch (_) {
      return null;
    }
  }

  /**
   * Persist a Tailwind CSS bundle to disk under `<hash>.css`.
   *
   * @param {string} jsxHash
   * @param {string} css
   * @returns {void}
   */
  function writeCachedCSS(jsxHash, css) {
    try {
      fs.writeFileSync(path.join(cacheDir, jsxHash + ".css"), css, "utf8");
    } catch (e) {
      RED.log.warn("[portal-react] CSS cache write failed: " + e.message);
    }
  }

  /**
   * Remove cached `.js`, `.css`, and `.meta.json` files for a given hash.
   * No-op when `jsxHash` is falsy. Errors are swallowed (best-effort cleanup).
   *
   * @param {?string} jsxHash
   * @returns {void}
   */
  function deleteCacheFiles(jsxHash) {
    if (!jsxHash) return;
    for (const ext of [".js", ".css", ".meta.json"]) {
      try {
        fs.unlinkSync(path.join(cacheDir, jsxHash + ext));
      } catch (_) {}
    }
  }

  /**
   * True when any other portal endpoint currently relies on `jsxHash`.
   * Used before `deleteCacheFiles` so a still-active sibling portal does not
   * lose its cache when a different portal redeploys to a new hash.
   *
   * @param {string} jsxHash
   * @param {Object<string, {jsxHash: string}>} pageState   Endpoint → state.
   * @param {string} excludeEndpoint  Endpoint to skip in the scan (the one whose hash is being replaced).
   * @returns {boolean}
   */
  function isHashInUse(jsxHash, pageState, excludeEndpoint) {
    for (const ep in pageState) {
      if (ep !== excludeEndpoint && pageState[ep]?.jsxHash === jsxHash)
        return true;
    }
    return false;
  }

  /**
   * Bundle the user JSX (with utility/library/import code already concatenated)
   * into a minified IIFE. Pre-validates with `quickCheckSyntax` first so
   * malformed input never reaches the bundler. Uses the async `esbuild.build`
   * API — a large bundle (three.js et al.) runs in esbuild's service process
   * without blocking the Node-RED event loop. The `react`/`react-dom` alias
   * points at this package's own copies so peer-dep packages share a single
   * React instance.
   *
   * @param {string} jsx
   * @returns {Promise<TranspileResult>}
   */
  async function transpile(jsx) {
    // Pre-validate with transformSync (fast, no bundling) so syntax errors get
    // clean line-numbered diagnostics before any resolution work
    const syntaxErr = quickCheckSyntax(jsx);
    if (syntaxErr) return { js: null, error: syntaxErr };
    // Syntax OK — bundle with full resolution
    try {
      const buildResult = await esbuild.build({
        stdin: {
          contents: jsx,
          resolveDir: pkgRoot,
          loader: "jsx",
        },
        bundle: true,
        format: "iife",
        minify: true,
        write: false,
        target: ["es2020"],
        jsx: "transform",
        jsxFactory: "React.createElement",
        jsxFragment: "React.Fragment",
        define: { "process.env.NODE_ENV": '"production"' },
        metafile: true,
        logLevel: "silent",
        logOverride: { "import-is-undefined": "silent" },
        nodePaths: [path.join(userDir, "node_modules")],
        alias: {
          react: path.dirname(
            require.resolve("react/package.json", { paths: [pkgRoot] }),
          ),
          "react-dom": path.dirname(
            require.resolve("react-dom/package.json", { paths: [pkgRoot] }),
          ),
        },
      });
      return {
        js: buildResult.outputFiles[0].text,
        metafile: buildResult.metafile,
        error: null,
      };
    } catch (e) {
      return { js: null, error: formatEsbuildError(e) };
    }
  }

  return {
    hash,
    transpile,
    quickCheckSyntax,
    generateCSS,
    extractPortalUser,
    serveableHash,
    hasFreshBuild,
    removeRoute,
    isSafeName,
    validateSubPath,
    findMissingComponentRefs,
    stripComments,
    extractImports,
    checkAppCode,
    identifierRe,
    pkgRoot,
    userDir,
    cacheDir,
    readCachedJS,
    writeCachedJS,
    readCachedCSS,
    writeCachedCSS,
    deleteCacheFiles,
    isHashInUse,
  };
}
