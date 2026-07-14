/**
 * Unit tests for pure helpers exposed on the helpers module (no RED runtime).
 */

const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  validateSubPath,
  generateCSS,
  quickCheckSyntax,
  findMissingComponentRefs,
  stripComments,
  extractImports,
  checkAppCode,
  serveableHash,
  hasFreshBuild,
  identifierRe,
  shouldSkipInstall,
} = require("../nodes/lib/helpers");
const { extractUtilitySymbols } = require("../nodes/lib/registry-nodes");

describe("validateSubPath", () => {
  it("accepts a simple single segment", () => {
    expect(validateSubPath("sensors")).toEqual({ ok: true, value: "sensors" });
  });

  it("accepts nested segments", () => {
    expect(validateSubPath("team/alpha")).toEqual({
      ok: true,
      value: "team/alpha",
    });
  });

  it("accepts segments starting with a digit", () => {
    expect(validateSubPath("3d").ok).toBe(true);
  });

  it("trims surrounding whitespace", () => {
    expect(validateSubPath("  sensors  ")).toEqual({
      ok: true,
      value: "sensors",
    });
  });

  it.each([
    ["", "empty string"],
    ["   ", "whitespace only"],
    [null, "null"],
    [undefined, "undefined"],
    [42, "non-string"],
  ])("rejects %p (%s)", (input) => {
    expect(validateSubPath(input).ok).toBe(false);
  });

  it("rejects leading slash", () => {
    expect(validateSubPath("/sensors").ok).toBe(false);
  });

  it("rejects trailing slash", () => {
    expect(validateSubPath("sensors/").ok).toBe(false);
  });

  it("rejects internal whitespace", () => {
    expect(validateSubPath("foo bar").ok).toBe(false);
  });

  it("rejects path traversal", () => {
    expect(validateSubPath("..").ok).toBe(false);
    expect(validateSubPath("./foo").ok).toBe(false);
    expect(validateSubPath("foo/../bar").ok).toBe(false);
  });

  it("rejects reserved segment 'public' (case-insensitive)", () => {
    expect(validateSubPath("public").ok).toBe(false);
    expect(validateSubPath("Public").ok).toBe(false);
    expect(validateSubPath("PUBLIC").ok).toBe(false);
    expect(validateSubPath("foo/public/bar").ok).toBe(false);
  });

  it("rejects reserved segment '_ws'", () => {
    expect(validateSubPath("_ws").ok).toBe(false);
    expect(validateSubPath("foo/_ws").ok).toBe(false);
  });

  it("rejects invalid characters", () => {
    expect(validateSubPath("foo?").ok).toBe(false);
    expect(validateSubPath("foo bar").ok).toBe(false);
    expect(validateSubPath("foo#bar").ok).toBe(false);
  });

  it("rejects segments starting with non-alphanumeric", () => {
    expect(validateSubPath("-foo").ok).toBe(false);
    expect(validateSubPath(".foo").ok).toBe(false);
    expect(validateSubPath("_foo").ok).toBe(false);
  });

  it("accepts dot, dash, underscore after leading alnum", () => {
    expect(validateSubPath("foo.bar").ok).toBe(true);
    expect(validateSubPath("foo-bar").ok).toBe(true);
    expect(validateSubPath("foo_bar").ok).toBe(true);
  });
});

describe("quickCheckSyntax", () => {
  it("returns null for valid JSX", () => {
    expect(quickCheckSyntax("function App(){return <div>hi</div>}")).toBeNull();
  });

  it("returns null for empty/whitespace input", () => {
    expect(quickCheckSyntax("")).toBeNull();
    expect(quickCheckSyntax("   \n  ")).toBeNull();
  });

  it("returns null for valid arrow component", () => {
    expect(quickCheckSyntax("const App = () => <div />;")).toBeNull();
  });

  it("returns error string for malformed JSX", () => {
    const err = quickCheckSyntax("function App(){ return <div }");
    expect(typeof err).toBe("string");
    expect(err.length).toBeGreaterThan(0);
  });

  it("includes line info for syntax errors", () => {
    const err = quickCheckSyntax("function bad() {\n  let x = ;\n}");
    expect(err).toMatch(/line/);
  });

  it("returns error for ReferenceError-shaped code (still parses) → null", () => {
    // dsada is undefined at runtime, but valid syntax — should pass
    expect(quickCheckSyntax("function App(){return dsada}")).toBeNull();
  });
});

describe("findMissingComponentRefs", () => {
  it("returns empty when name is in registry", () => {
    expect(
      findMissingComponentRefs("function App(){return <Header/>}", new Set(["Header"])),
    ).toEqual(new Set());
  });

  it("flags name not in registry and not defined locally", () => {
    expect(
      findMissingComponentRefs(
        'function App(){return <Header title="x"/>}',
        new Set(),
      ),
    ).toEqual(new Set(["Header"]));
  });

  it("does not flag locally-defined function component", () => {
    expect(
      findMissingComponentRefs(
        "function Header(){return null} function App(){return <Header/>}",
        new Set(),
      ),
    ).toEqual(new Set());
  });

  it("does not flag locally-defined const component", () => {
    expect(
      findMissingComponentRefs(
        "const Header = () => null; function App(){return <Header/>}",
        new Set(),
      ),
    ).toEqual(new Set());
  });

  it("does not flag named import", () => {
    expect(
      findMissingComponentRefs(
        'import {Canvas} from "@react-three/fiber"; function App(){return <Canvas/>}',
        new Set(),
      ),
    ).toEqual(new Set());
  });

  it("does not flag default import", () => {
    expect(
      findMissingComponentRefs(
        'import Canvas from "x"; function App(){return <Canvas/>}',
        new Set(),
      ),
    ).toEqual(new Set());
  });

  it("does not flag React built-ins (Fragment / Suspense)", () => {
    expect(
      findMissingComponentRefs(
        "function App(){return <Fragment><Suspense/></Fragment>}",
        new Set(),
      ),
    ).toEqual(new Set());
  });

  it("collects multiple missing names", () => {
    expect(
      findMissingComponentRefs(
        "function App(){return <div><Header/><Stat/></div>}",
        new Set(),
      ),
    ).toEqual(new Set(["Header", "Stat"]));
  });

  it("ignores lower-case HTML tags", () => {
    expect(
      findMissingComponentRefs(
        "function App(){return <div><span/><p>x</p></div>}",
        new Set(),
      ),
    ).toEqual(new Set());
  });

  it("mixes registry hits and misses", () => {
    expect(
      findMissingComponentRefs(
        "function App(){return <Page><Header/></Page>}",
        new Set(["Page"]),
      ),
    ).toEqual(new Set(["Header"]));
  });

  it("treats utility symbols (passed via knownNames) as satisfied", () => {
    // A utility node may declare a top-level component; pass its symbol set in.
    expect(
      findMissingComponentRefs(
        "function App(){return <Widget/>}",
        new Set(["Widget"]),
      ),
    ).toEqual(new Set());
  });

  it("handles empty / non-string input safely", () => {
    expect(findMissingComponentRefs("", new Set())).toEqual(new Set());
    expect(findMissingComponentRefs(null, new Set())).toEqual(new Set());
    expect(findMissingComponentRefs(undefined, new Set())).toEqual(new Set());
  });

  it("does not flag self-closing tags whose name is also defined", () => {
    expect(
      findMissingComponentRefs(
        "class Header extends React.Component{} function App(){return <Header/>}",
        new Set(),
      ),
    ).toEqual(new Set());
  });

  it("does not flag npm component when import is preserved (regression: portal-react.js call-site)", () => {
    // Mirrors a real Three.js example componentCode — both the import and
    // the <Canvas/> usage must stay together when fed to the helper.
    const code = [
      "import { Canvas } from '@react-three/fiber';",
      "import { OrbitControls } from '@react-three/drei';",
      "function App(){",
      "  return (<Canvas><OrbitControls/></Canvas>);",
      "}",
    ].join("\n");
    expect(findMissingComponentRefs(code, new Set())).toEqual(new Set());
  });

  it("does not flag a tag used only inside a JSX block comment", () => {
    const code = [
      "function App(){",
      "  return (",
      "    <div>",
      "      {/* <Gauge value={1}/> */}",
      "      <p>hello</p>",
      "    </div>",
      "  );",
      "}",
    ].join("\n");
    expect(findMissingComponentRefs(code, new Set())).toEqual(new Set());
  });

  it("does not flag a tag used only in a // line comment", () => {
    const code = [
      "function App(){",
      "  // <Gauge value={1}/>",
      "  return <div/>;",
      "}",
    ].join("\n");
    expect(findMissingComponentRefs(code, new Set())).toEqual(new Set());
  });

  it("still flags a live tag when another usage is commented out", () => {
    const code = [
      "function App(){",
      "  // <Gauge value={1}/>",
      "  return <Gauge value={2}/>;",
      "}",
    ].join("\n");
    expect(findMissingComponentRefs(code, new Set())).toEqual(
      new Set(["Gauge"]),
    );
  });

  it("flags a tag whose only definition is commented out", () => {
    const code = [
      "// const Gauge = () => null;",
      "function App(){ return <Gauge/>; }",
    ].join("\n");
    expect(findMissingComponentRefs(code, new Set())).toEqual(
      new Set(["Gauge"]),
    );
  });

  it("does not treat a tag inside a string as a usage", () => {
    const code =
      'function App(){ const s = "see <Gauge/> docs at https://x"; return <div>{s}</div>; }';
    // The scan blanks string interiors, so <Gauge/> inside the string is not
    // a JSX usage.
    expect(findMissingComponentRefs(code, new Set())).toEqual(new Set());
  });
});

describe("stripComments", () => {
  it("blanks // line comments but keeps the newline", () => {
    const out = stripComments("const a = 1; // note\nconst b = 2;");
    expect(out).toContain("const a = 1;");
    expect(out).toContain("const b = 2;");
    expect(out).not.toContain("note");
    expect(out.length).toBe("const a = 1; // note\nconst b = 2;".length);
  });

  it("blanks /* */ block comments across lines, preserving line count", () => {
    const src = "a\n/*\nx\ny\n*/\nb";
    const out = stripComments(src);
    expect(out.split("\n").length).toBe(src.split("\n").length);
    expect(out).not.toContain("x");
    expect(out).toContain("a");
    expect(out).toContain("b");
  });

  it("blanks JSX comments {/* … */}", () => {
    const out = stripComments("<div>{/* <Gauge/> */}</div>");
    expect(out).not.toContain("Gauge");
    expect(out).toContain("<div>{");
    expect(out).toContain("}</div>");
  });

  it("does not treat // inside a string as a comment", () => {
    const src = 'const url = "https://example.com"; // real';
    const out = stripComments(src);
    expect(out).toContain("https://example.com");
    expect(out).not.toContain("real");
  });

  it("does not treat /* inside a template literal as a comment", () => {
    const src = "const t = `/* not a comment */`; /* yes */";
    const out = stripComments(src);
    expect(out).toContain("/* not a comment */");
    expect(out).not.toContain("yes");
  });

  it("handles escaped quotes inside strings", () => {
    const src = 'const s = "a \\" b // still string"; // gone';
    const out = stripComments(src);
    expect(out).toContain('a \\" b // still string');
    expect(out).not.toContain("gone");
  });

  it("returns '' for empty / non-string input", () => {
    expect(stripComments("")).toBe("");
    expect(stripComments(null)).toBe("");
    expect(stripComments(undefined)).toBe("");
  });

  it("preserves offsets exactly (same length output)", () => {
    const src = "let x = 1; /* c */ let y = 2; // d";
    expect(stripComments(src).length).toBe(src.length);
  });
});

describe("extractImports", () => {
  it("hoists a live import and removes it from clean code", () => {
    const { imports, clean } = extractImports(
      "import * as d3 from 'd3';\nfunction App(){ return <div/>; }",
    );
    expect(imports).toEqual(["import * as d3 from 'd3';"]);
    expect(clean).toBe("function App(){ return <div/>; }");
  });

  it("does not hoist an import inside a // line comment", () => {
    const { imports, clean } = extractImports(
      "// import * as d3 from 'd3';\nfunction App(){ return <div/>; }",
    );
    expect(imports).toEqual([]);
    expect(clean).toContain("// import * as d3 from 'd3';");
  });

  it("does not hoist an import inside a /* */ block comment", () => {
    const code = [
      "/*",
      "import Chart from 'chart.js/auto';",
      "*/",
      "function App(){ return <div/>; }",
    ].join("\n");
    const { imports, clean } = extractImports(code);
    expect(imports).toEqual([]);
    expect(clean).toContain("import Chart from 'chart.js/auto';");
    expect(clean).toContain("/*");
    expect(clean).toContain("*/");
  });

  it("hoists live imports while leaving a commented duplicate in place", () => {
    const code = [
      "import Chart from 'chart.js/auto';",
      "// import Chart from 'chart.js/auto';",
      "function App(){ return <div/>; }",
    ].join("\n");
    const { imports, clean } = extractImports(code);
    expect(imports).toEqual(["import Chart from 'chart.js/auto';"]);
    expect(clean).toContain("// import Chart from 'chart.js/auto';");
    expect(clean.indexOf("import Chart")).toBe(
      clean.lastIndexOf("import Chart"),
    );
  });

  it("extracts multiple imports in source order", () => {
    const code = [
      "import { Canvas } from '@react-three/fiber';",
      "import { OrbitControls } from '@react-three/drei';",
      "function App(){ return <Canvas/>; }",
    ].join("\n");
    const { imports } = extractImports(code);
    expect(imports).toEqual([
      "import { Canvas } from '@react-three/fiber';",
      "import { OrbitControls } from '@react-three/drei';",
    ]);
  });

  it("handles empty / non-string input safely", () => {
    expect(extractImports("")).toEqual({ imports: [], clean: "" });
    expect(extractImports(null)).toEqual({ imports: [], clean: "" });
  });
});

describe("checkAppCode", () => {
  it("detects function App with return", () => {
    expect(checkAppCode("function App(){ return <div/>; }")).toEqual({
      hasApp: true,
      missingReturn: false,
    });
  });

  it("flags function App without return", () => {
    expect(checkAppCode("function App(){ const x = 1; }")).toEqual({
      hasApp: true,
      missingReturn: true,
    });
  });

  it("a commented-out return does not count", () => {
    const code = ["function App(){", "  // return <div/>;", "}"].join("\n");
    expect(checkAppCode(code)).toEqual({ hasApp: true, missingReturn: true });
  });

  it("a commented-out App definition does not count", () => {
    expect(checkAppCode("// function App(){ return <div/>; }")).toEqual({
      hasApp: false,
      missingReturn: false,
    });
  });

  it("accepts const App arrow form without return analysis", () => {
    expect(checkAppCode("const App = () => <div/>;")).toEqual({
      hasApp: true,
      missingReturn: false,
    });
  });

  it("return inside a nested block-commented region does not count", () => {
    const code = [
      "function App(){",
      "  /*",
      "  if (x) return <div/>;",
      "  */",
      "}",
    ].join("\n");
    expect(checkAppCode(code)).toEqual({ hasApp: true, missingReturn: true });
  });
});

describe("generateCSS — arbitrary-value candidates", () => {
  it("emits CSS for calc() arbitrary value", async () => {
    const { css } = await generateCSS(
      'function App(){ return <div className="w-[calc(100%-2rem)]"/>; }',
    );
    expect(css).toContain("calc(100% - 2rem)");
  });

  it("emits CSS for repeat() with comma", async () => {
    const { css } = await generateCSS(
      'function App(){ return <div className="grid grid-cols-[repeat(2,1fr)]"/>; }',
    );
    expect(css.replace(/\s/g, "")).toContain("repeat(2,1fr)");
  });

  it("emits !important for trailing-! modifier", async () => {
    const { css } = await generateCSS(
      'function App(){ return <div className="mt-0!"/>; }',
    );
    expect(css).toContain("important");
  });

  it("emits container query CSS for @-variant", async () => {
    const { css } = await generateCSS(
      'function App(){ return <div className="@md:flex"/>; }',
    );
    expect(css).toContain("@container");
  });

  it("emits font-family for quoted arbitrary value in single-quoted class list", async () => {
    const { css } = await generateCSS(
      "function App(){ return <div className=\"font-['Open_Sans']\"/>; }",
    );
    expect(css).toContain("Open Sans");
  });

  it("still extracts plain classes outside strings (JSX expression maps)", async () => {
    const { css } = await generateCSS(
      "const variants = { primary: `bg-blue-600 hover:bg-blue-500` };",
    );
    expect(css).toContain("bg-blue-600");
    expect(css).toContain("hover\\:bg-blue-500");
  });

  it("does not choke on code-looking junk in strings", async () => {
    const { css } = await generateCSS(
      'const s = "send({ action: 1 }) w-full"; ',
    );
    expect(css).toContain("width: 100%");
  });

  it("dynamic template classes still produce no CSS (documented limitation)", async () => {
    const { css } = await generateCSS(
      "const cls = `bg-${tone}-500`; // never do this",
    );
    // bg-${tone}-500 is not a valid utility — nothing should be emitted for it
    expect(css).not.toContain("--tw-bg");
  });
});

describe("serveableHash", () => {
  it("returns '' for missing state", () => {
    expect(serveableHash(undefined)).toBe("");
    expect(serveableHash(null)).toBe("");
  });

  it("returns '' when compiled is nulled (post-close teardown window)", () => {
    // The exact state that caused the reload loop: compiled nulled by close()
    // but a stale contentHash left behind. Must NOT be advertised.
    expect(serveableHash({ compiled: null, contentHash: "abc123" })).toBe("");
  });

  it("returns '' for a hard build error with no fallback", () => {
    expect(
      serveableHash({ compiled: { error: "boom", js: null }, contentHash: "" }),
    ).toBe("");
  });

  it("returns the lastGood hash in degraded mode (build error + fallback)", () => {
    expect(
      serveableHash({
        compiled: { error: "boom", js: null },
        contentHash: "",
        lastGood: { contentHash: "good99" },
      }),
    ).toBe("good99");
  });

  it("returns contentHash for a real serveable build", () => {
    expect(
      serveableHash({ compiled: { error: null, js: "/*bundle*/" }, contentHash: "live42" }),
    ).toBe("live42");
  });

  it("returns '' for a building placeholder (no compiled yet)", () => {
    expect(serveableHash({ building: true, contentHash: "stale" })).toBe("");
  });
});

describe("hasFreshBuild", () => {
  it("returns false for missing state", () => {
    expect(hasFreshBuild(undefined)).toBe(false);
    expect(hasFreshBuild(null)).toBe(false);
  });

  it("returns false when compiled is nulled (post-close teardown window)", () => {
    // The regression: close() nulls compiled but keeps the state object and the
    // portal signature. The no-op redeploy guard must NOT treat this as valid,
    // or it skips the rebuild and the GET route serves the holding page forever.
    expect(hasFreshBuild({ compiled: null, contentHash: "abc123" })).toBe(false);
  });

  it("returns false for a building placeholder", () => {
    expect(hasFreshBuild({ building: true, contentHash: "stale" })).toBe(false);
  });

  it("returns false for a build error (degraded or hard)", () => {
    expect(
      hasFreshBuild({ compiled: { error: "boom", js: null } }),
    ).toBe(false);
    expect(
      hasFreshBuild({
        compiled: { error: "boom", js: null },
        lastGood: { contentHash: "good99" },
      }),
    ).toBe(false);
  });

  it("returns true for a real serveable build", () => {
    expect(
      hasFreshBuild({ compiled: { error: null, js: "/*bundle*/" }, contentHash: "live42" }),
    ).toBe(true);
  });
});

describe("identifierRe", () => {
  it("matches a standalone identifier", () => {
    expect(identifierRe("Button").test("<Button/>")).toBe(true);
    expect(identifierRe("Button").test("return Button;")).toBe(true);
  });

  it("does not match as prefix/suffix of a longer identifier", () => {
    expect(identifierRe("Button").test("ButtonGroup")).toBe(false);
    expect(identifierRe("Button").test("MyButton")).toBe(false);
    expect(identifierRe("Button").test("_Button")).toBe(false);
  });

  it("handles $-edged identifiers that \\b misses", () => {
    expect(identifierRe("$fmt").test("call($fmt)")).toBe(true);
    expect(identifierRe("$fmt").test("x$fmt")).toBe(false);
    expect(identifierRe("fmt$").test("fmt$(x)")).toBe(true);
    expect(identifierRe("fmt$").test("fmt$x")).toBe(false);
  });

  it("returns the same cached RegExp instance for the same name", () => {
    expect(identifierRe("Stat")).toBe(identifierRe("Stat"));
  });
});

describe("extractUtilitySymbols", () => {
  it("extracts function/const/let/var/class names", () => {
    const syms = extractUtilitySymbols(
      "function go() {}\nconst A = 1;\nlet b = 2;\nvar c = 3;\nclass Foo {}",
    );
    expect([...syms].sort()).toEqual(["A", "Foo", "b", "c", "go"]);
  });

  it("extracts every name from multi-declarator statements", () => {
    expect([...extractUtilitySymbols("const a = 1, b = 2;")].sort()).toEqual(["a", "b"]);
    expect([...extractUtilitySymbols("let x, y;")].sort()).toEqual(["x", "y"]);
  });

  it("ignores commas inside initializer expressions and strings", () => {
    const syms = extractUtilitySymbols(
      'const a = f(1, 2), b = [3, 4], c = { x: 1, y: 2 }, d = "p,q";',
    );
    expect([...syms].sort()).toEqual(["a", "b", "c", "d"]);
  });

  it("does not leak arrow params or function-inner declarations", () => {
    const syms = extractUtilitySymbols(
      "const fn = (p, q) => p + q;\nfunction go() { const inner = 1, hidden = 2; }",
    );
    expect([...syms].sort()).toEqual(["fn", "go"]);
  });

  it("returns empty for oversized input (ReDoS guard)", () => {
    expect(extractUtilitySymbols("const a = 1;".repeat(200000)).size).toBe(0);
  });
});

describe("shouldSkipInstall", () => {
  let dir;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "fc-preinstall-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function installFake(module, version) {
    const modDir = path.join(dir, "node_modules", module);
    fs.mkdirSync(modDir, { recursive: true });
    fs.writeFileSync(
      path.join(modDir, "package.json"),
      JSON.stringify({ name: module, version }),
    );
  }

  it("skips a plain re-install of an already-present module", () => {
    installFake("chart.js", "4.4.0");
    expect(shouldSkipInstall({ dir, module: "chart.js" })).toBe(true);
  });

  it("proceeds when the module is not on disk", () => {
    expect(shouldSkipInstall({ dir, module: "chart.js" })).toBe(false);
  });

  it("never vetoes an upgrade, even when the module is on disk", () => {
    installFake("@aaqu/fromcubes-portal-react", "0.1.0-alpha.27");
    expect(
      shouldSkipInstall({
        dir,
        module: "@aaqu/fromcubes-portal-react",
        version: "0.1.0-alpha.28",
        isUpgrade: true,
      }),
    ).toBe(false);
  });

  it("proceeds when a different explicit version is requested", () => {
    installFake("chart.js", "4.4.0");
    expect(
      shouldSkipInstall({ dir, module: "chart.js", version: "4.5.0" }),
    ).toBe(false);
  });

  it("skips when the requested version matches the installed one", () => {
    installFake("chart.js", "4.4.0");
    expect(
      shouldSkipInstall({ dir, module: "chart.js", version: "4.4.0" }),
    ).toBe(true);
  });

  it("proceeds when a version is requested but package.json is unreadable", () => {
    installFake("chart.js", "4.4.0");
    fs.writeFileSync(
      path.join(dir, "node_modules", "chart.js", "package.json"),
      "{ not json",
    );
    expect(
      shouldSkipInstall({ dir, module: "chart.js", version: "4.4.0" }),
    ).toBe(false);
  });

  it("resolves scoped module names to their nested directory", () => {
    installFake("@scope/pkg", "1.0.0");
    expect(shouldSkipInstall({ dir, module: "@scope/pkg" })).toBe(true);
  });
});
