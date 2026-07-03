const MAX_UTIL_CODE_BYTES = 1_000_000;

const DECL_RE = /^(?:export\s+)?(?:async\s+)?(function\s*\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;

/**
 * Scan utility code for top-level `function`/`const`/`let`/`var`/`class`
 * names. Used for selective inclusion, symbol collision checks, and the
 * editor Utilities dialog. Oversize input is ignored so the regex cannot be
 * weaponized with multi-MB code.
 *
 * Multi-declarator statements (`const a = 1, b = 2`) yield every name —
 * initializer-internal commas are skipped via bracket/quote depth tracking.
 * Destructuring declarations are not supported (never were).
 *
 * @param {string} code
 * @returns {Set<string>}
 */
function extractUtilitySymbols(code) {
  const names = new Set();
  if (!code || code.length > MAX_UTIL_CODE_BYTES) return names;
  DECL_RE.lastIndex = 0;
  let m;
  while ((m = DECL_RE.exec(code))) {
    names.add(m[2]);
    const kind = m[1];
    if (kind === "const" || kind === "let" || kind === "var") {
      collectExtraDeclarators(code, DECL_RE.lastIndex, names);
    }
  }
  return names;
}

/**
 * Walk a `const`/`let`/`var` statement from just past its first declared
 * name and collect the names of any further comma-separated declarators.
 * Commas inside `()`, `[]`, `{}` or string/template literals belong to the
 * initializer expression and are ignored. Scanning stops at the first `;`
 * (or unbalanced closer) at depth 0.
 *
 * @param {string} code
 * @param {number} from   Index right after the first declarator name.
 * @param {Set<string>} names  Collector — extra names are added in place.
 * @returns {void}
 */
function collectExtraDeclarators(code, from, names) {
  let depth = 0;
  let i = from;
  const n = code.length;
  while (i < n) {
    const ch = code[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      i++;
      while (i < n && code[i] !== ch) {
        if (code[i] === "\\") i++;
        i++;
      }
    } else if (ch === "(" || ch === "[" || ch === "{") {
      depth++;
    } else if (ch === ")" || ch === "]" || ch === "}") {
      if (depth === 0) return; // end of enclosing block / malformed
      depth--;
    } else if (ch === ";" && depth === 0) {
      return;
    } else if (ch === "," && depth === 0) {
      const dm = code.slice(i + 1).match(/^\s*([A-Za-z_$][\w$]*)/);
      if (dm) names.add(dm[1]);
    }
    i++;
  }
}

/**
 * Register fc-portal-component and fc-portal-utility config nodes.
 *
 * @param {Object} RED
 * @param {Object} deps
 * @returns {void}
 */
function registerRegistryNodes(RED, deps) {
  const {
    registry,
    utilities,
    compNameOwners,
    utilSymbolOwners,
    isSafeName,
    quickCheckSyntax,
    shortStatus,
    scheduleRebuildUsing,
  } = deps;

  // Name each component/utility node currently registers: { nodeId: name }.
  // Registry entries survive a plain redeploy (close(removed=false) keeps
  // them so an unchanged deploy stays a no-op) — this map is what lets a
  // RENAME on redeploy free the old entry instead of leaking it.
  if (!RED.settings.portalReactNodeNames) {
    RED.settings.portalReactNodeNames = {};
  }
  const nodeNames = RED.settings.portalReactNodeNames;

  function PortalComponentNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const compName = (config.compName || "").trim();

    if (!isSafeName(compName)) {
      node.error("Invalid component name: " + compName);
      node.status({ fill: "red", shape: "dot", text: "invalid name" });
      return;
    }

    // Renamed on redeploy → free the previous entry owned by this node.
    const prevOwnedComp = nodeNames[node.id];
    if (prevOwnedComp && prevOwnedComp !== compName) {
      if (compNameOwners[prevOwnedComp] === node.id) {
        delete compNameOwners[prevOwnedComp];
      }
      if (registry[prevOwnedComp]) {
        delete registry[prevOwnedComp];
        scheduleRebuildUsing(prevOwnedComp);
      }
      delete nodeNames[node.id];
    }

    const existingOwner = compNameOwners[compName];
    if (existingOwner && existingOwner !== node.id) {
      node.error(
        `Component name "${compName}" is already used by another node`,
      );
      node.status({
        fill: "red",
        shape: "ring",
        text: shortStatus("dup: " + compName),
      });
      node.on("close", function (_removed, done) {
        done();
      });
      return;
    }

    const utilSymOwner = utilSymbolOwners[compName];
    if (utilSymOwner) {
      node.error(
        `Component name "${compName}" conflicts with a top-level symbol declared in utility "${utilSymOwner}"`,
      );
      node.status({
        fill: "red",
        shape: "ring",
        text: shortStatus("dup sym: " + compName),
      });
      node.on("close", function (_removed, done) {
        done();
      });
      return;
    }
    compNameOwners[compName] = node.id;
    nodeNames[node.id] = compName;

    const newCode = config.compCode || "";
    const prevCode = registry[compName]?.code;
    const syntaxErr = quickCheckSyntax(newCode);
    registry[compName] = { code: newCode, error: syntaxErr };

    if (syntaxErr) {
      node.error(`Component "${compName}" syntax error: ${syntaxErr}`);
      const short = syntaxErr.split("\n")[0];
      node.status({
        fill: "red",
        shape: "dot",
        text: shortStatus("syntax: " + short),
      });
    } else {
      node.status({ fill: "green", shape: "dot", text: shortStatus(compName) });
    }

    if (prevCode !== newCode) scheduleRebuildUsing(compName);

    node.on("close", function (removed, done) {
      // Plain redeploy (removed=false): keep the registry entry. The new
      // instance re-registers in the same deploy pass and can compare
      // prevCode — an unchanged component deploy stays a true no-op.
      // Only delete/disable (removed=true) drops the entry.
      if (removed) {
        if (compNameOwners[compName] === node.id) {
          delete compNameOwners[compName];
        }
        if (nodeNames[node.id] === compName) {
          delete nodeNames[node.id];
        }
        delete registry[compName];
        scheduleRebuildUsing(compName);
      }
      done();
    });
  }
  RED.nodes.registerType("fc-portal-component", PortalComponentNode);

  function PortalUtilityNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const utilName = (config.utilName || "").trim();

    if (!isSafeName(utilName)) {
      node.error("Invalid utility name: " + utilName);
      node.status({ fill: "red", shape: "dot", text: "invalid name" });
      return;
    }

    // Renamed on redeploy → free the previous entry + its symbol ownership.
    const prevOwnedUtil = nodeNames[node.id];
    if (prevOwnedUtil && prevOwnedUtil !== utilName) {
      if (compNameOwners[prevOwnedUtil] === node.id) {
        delete compNameOwners[prevOwnedUtil];
      }
      const oldSyms = extractUtilitySymbols(utilities[prevOwnedUtil]?.code || "");
      for (const s of oldSyms) {
        if (utilSymbolOwners[s] === prevOwnedUtil) delete utilSymbolOwners[s];
      }
      if (utilities[prevOwnedUtil]) {
        delete utilities[prevOwnedUtil];
        scheduleRebuildUsing(prevOwnedUtil);
        for (const s of oldSyms) scheduleRebuildUsing(s);
      }
      delete nodeNames[node.id];
    }

    const existingOwner = compNameOwners[utilName];
    if (existingOwner && existingOwner !== node.id) {
      node.error(
        `Name "${utilName}" is already used by another component or utility`,
      );
      node.status({
        fill: "red",
        shape: "ring",
        text: shortStatus("dup: " + utilName),
      });
      node.on("close", function (_removed, done) {
        done();
      });
      return;
    }
    compNameOwners[utilName] = node.id;
    nodeNames[node.id] = utilName;

    const newCode = config.utilCode || "";
    const prevCode = utilities[utilName]?.code;
    const prevSyms = extractUtilitySymbols(prevCode || "");
    const newSyms = extractUtilitySymbols(newCode);

    for (const s of prevSyms) {
      if (utilSymbolOwners[s] === utilName) delete utilSymbolOwners[s];
    }

    const conflicts = [];
    for (const s of newSyms) {
      if (Object.prototype.hasOwnProperty.call(registry, s)) {
        conflicts.push(`${s} (component)`);
        continue;
      }
      const symOwner = utilSymbolOwners[s];
      if (symOwner && symOwner !== utilName) {
        conflicts.push(`${s} (utility ${symOwner})`);
      }
    }

    const syntaxErr = quickCheckSyntax(newCode);
    const dupErr =
      conflicts.length > 0
        ? "duplicate symbols: " + conflicts.join(", ")
        : null;
    const combinedErr = syntaxErr || dupErr;

    utilities[utilName] = { code: newCode, error: combinedErr };

    if (combinedErr) {
      const msgs = [syntaxErr, dupErr].filter(Boolean).join(" | ");
      node.error(`Utility "${utilName}": ${msgs}`);
      if (syntaxErr) {
        const short = syntaxErr.split("\n")[0];
        node.status({
          fill: "red",
          shape: "dot",
          text: shortStatus("syntax: " + short),
        });
      } else {
        const firstSym = conflicts[0].split(" ")[0];
        node.status({
          fill: "red",
          shape: "ring",
          text: shortStatus("dup sym: " + firstSym),
        });
      }
    } else {
      for (const s of newSyms) utilSymbolOwners[s] = utilName;
      node.status({
        fill: "green",
        shape: "dot",
        text: shortStatus(utilName),
      });
    }

    if (prevCode !== newCode) {
      scheduleRebuildUsing(utilName);
      for (const s of newSyms) scheduleRebuildUsing(s);
      for (const s of prevSyms) if (!newSyms.has(s)) scheduleRebuildUsing(s);
    }

    node.on("close", function (removed, done) {
      // Plain redeploy (removed=false): keep the utility entry + symbol
      // ownership so an unchanged deploy stays a no-op (see component close).
      if (removed) {
        if (compNameOwners[utilName] === node.id) {
          delete compNameOwners[utilName];
        }
        if (nodeNames[node.id] === utilName) {
          delete nodeNames[node.id];
        }
        for (const s of Object.keys(utilSymbolOwners)) {
          if (utilSymbolOwners[s] === utilName) delete utilSymbolOwners[s];
        }
        const removedSyms = extractUtilitySymbols(utilities[utilName]?.code || "");
        delete utilities[utilName];
        scheduleRebuildUsing(utilName);
        for (const s of removedSyms) scheduleRebuildUsing(s);
      }
      done();
    });
  }
  RED.nodes.registerType("fc-portal-utility", PortalUtilityNode);
}

module.exports = { extractUtilitySymbols, registerRegistryNodes };
