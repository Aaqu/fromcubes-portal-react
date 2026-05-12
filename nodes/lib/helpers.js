/**
 * @module nodes/lib/helpers
 *
 * Shared helper functions for portal-react. Pure helpers (hash, validators,
 * esbuild wrappers) are exported at module level; runtime helpers that need
 * `RED` (cache, tailwind, preInstall hook) are produced by the default export
 * factory.
 *
 * @typedef {Object} TranspileResult
 * @property {string|null} js          Compiled IIFE bundle, or null on error.
 * @property {string|null} [error]     Multi-line error description from esbuild.
 * @property {Object}      [metafile]  Optional esbuild metafile (size analysis).
 *
 * @typedef {Object} SubPathResult
 * @property {boolean} ok
 * @property {string}  [value]
 * @property {string}  [error]
 *
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

let twCompiled = null;
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

async function generateCSS(source) {
  const cssHash = hash(source);
  const compiled = await getTwCompiled();
  const candidates = [...new Set(source.match(CANDIDATE_RE) || [])];
  const css = compiled.build(candidates);
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

function removeRoute(router, path) {
  if (!router || !router.stack) return;
  router.stack = router.stack.filter(
    (layer) => !(layer.route && layer.route.path === path),
  );
}

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

module.exports = function (RED) {
  return createHelpers(RED);
};

module.exports.validateSubPath = validateSubPath;
module.exports.isSafeName = isSafeName;
module.exports.quickCheckSyntax = quickCheckSyntax;
module.exports.formatEsbuildError = formatEsbuildError;
module.exports.extractPortalUser = extractPortalUser;
module.exports.NAME_MAX_LEN = NAME_MAX_LEN;
module.exports.MAX_GROUPS_HEADER_BYTES = MAX_GROUPS_HEADER_BYTES;

function createHelpers(RED) {
  // Package root — where react/react-dom live (this package's own node_modules)
  const pkgRoot = path.join(__dirname, "../..");
  // userDir — where dynamicModuleList installs user packages
  const userDir = RED.settings.userDir || path.join(__dirname, "../../../..");

  /**
   * `preInstall` hook (Node-RED 1.3+) — vetoes an npm install when the
   * package is already on disk. Useful for offline/Docker setups where
   * Node-RED's auto-install pass would otherwise try to hit the registry
   * and fail. Hook itself is *optional by design*: any unexpected error
   * inside the body MUST NOT bubble up (it would cancel an install path
   * the user actually expected to run). We log at `trace` level so the
   * developer can opt into diagnostics via `logging.level = trace` in
   * `settings.js`, without spamming default-level logs.
   *
   * @param {{dir: string, module: string}} event
   * @returns {boolean|void}  `false` skips the install; anything else proceeds.
   * @listens RED.hooks#preInstall.portalReact
   */
  RED.hooks.add("preInstall.portalReact", (event) => {
    try {
      const modDir = path.join(event.dir, "node_modules", event.module);
      if (fs.existsSync(modDir)) {
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

  function writeCachedCSS(jsxHash, css) {
    try {
      fs.writeFileSync(path.join(cacheDir, jsxHash + ".css"), css, "utf8");
    } catch (e) {
      RED.log.warn("[portal-react] CSS cache write failed: " + e.message);
    }
  }

  function deleteCacheFiles(jsxHash) {
    if (!jsxHash) return;
    for (const ext of [".js", ".css", ".meta.json"]) {
      try {
        fs.unlinkSync(path.join(cacheDir, jsxHash + ext));
      } catch (_) {}
    }
  }

  function isHashInUse(jsxHash, pageState, excludeEndpoint) {
    for (const ep in pageState) {
      if (ep !== excludeEndpoint && pageState[ep]?.jsxHash === jsxHash)
        return true;
    }
    return false;
  }

  function transpile(jsx) {
    // Pre-validate with transformSync (fast, no bundling) to avoid esbuild buildSync deadlock on syntax errors
    const syntaxErr = quickCheckSyntax(jsx);
    if (syntaxErr) return { js: null, error: syntaxErr };
    // Syntax OK — bundle with full resolution
    try {
      const buildResult = esbuild.buildSync({
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
    removeRoute,
    isSafeName,
    validateSubPath,
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
