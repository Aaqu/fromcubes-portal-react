const MAX_UTIL_CODE_BYTES = 1_000_000;

/**
 * Scan utility code for top-level `function`/`const`/`let`/`var`/`class`
 * names. Used for selective inclusion, symbol collision checks, and the
 * editor Utilities dialog. Oversize input is ignored so the regex cannot be
 * weaponized with multi-MB code.
 *
 * @param {string} code
 * @returns {Set<string>}
 */
function extractUtilitySymbols(code) {
  const names = new Set();
  if (!code || code.length > MAX_UTIL_CODE_BYTES) return names;
  const re = /^(?:export\s+)?(?:async\s+)?(?:function\s*\*?|const|let|var|class)\s+([A-Za-z_$][\w$]*)/gm;
  let m;
  while ((m = re.exec(code))) names.add(m[1]);
  return names;
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

  function PortalComponentNode(config) {
    RED.nodes.createNode(this, config);
    const node = this;
    const compName = (config.compName || "").trim();

    if (!isSafeName(compName)) {
      node.error("Invalid component name: " + compName);
      node.status({ fill: "red", shape: "dot", text: "invalid name" });
      return;
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

    node.on("close", function (_removed, done) {
      if (compNameOwners[compName] === node.id) {
        delete compNameOwners[compName];
      }
      delete registry[compName];
      scheduleRebuildUsing(compName);
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

    node.on("close", function (_removed, done) {
      if (compNameOwners[utilName] === node.id) {
        delete compNameOwners[utilName];
      }
      for (const s of Object.keys(utilSymbolOwners)) {
        if (utilSymbolOwners[s] === utilName) delete utilSymbolOwners[s];
      }
      const removedSyms = extractUtilitySymbols(utilities[utilName]?.code || "");
      delete utilities[utilName];
      scheduleRebuildUsing(utilName);
      for (const s of removedSyms) scheduleRebuildUsing(s);
      done();
    });
  }
  RED.nodes.registerType("fc-portal-utility", PortalUtilityNode);
}

module.exports = { extractUtilitySymbols, registerRegistryNodes };
