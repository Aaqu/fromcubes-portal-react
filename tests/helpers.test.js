/**
 * Unit tests for pure helpers exposed on the helpers module (no RED runtime).
 */

const {
  validateSubPath,
  quickCheckSyntax,
  findMissingComponentRefs,
  serveableHash,
  hasFreshBuild,
} = require("../nodes/lib/helpers");

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
