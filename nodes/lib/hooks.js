/**
 * Plugin hook system for @aaqu/fromcubes-portal-react.
 *
 * Plugins register with Node-RED via:
 *   RED.plugins.registerPlugin("my-plugin", {
 *     type: "fromcubes-portal-react",
 *     hooks: {
 *       onIsValidConnection(request)         { return true },
 *       onCanSendTo(ws, msg)                 { return true },
 *       onInbound(msg, ws)                   { return msg },
 *     },
 *   })
 *
 * Semantics:
 * - allow(name, ...args): every registered hook must return !== false
 *   (no hooks registered -> allowed). AND logic across plugins.
 * - transform(name, msg, ...args): runs each hook sequentially, each
 *   may return a new msg. Returning undefined keeps the current msg.
 * - Any thrown exception is treated as `false` for allow hooks and
 *   logged via RED.log.error. Transform hooks log and skip the step.
 */

const PLUGIN_TYPE = "fromcubes-portal-react";

/**
 * Build a plugin-hook dispatcher bound to `RED`.
 *
 * @param {Object} RED  Node-RED runtime.
 * @returns {{ allow: Function, transform: Function, hasHook: Function, PLUGIN_TYPE: string }}
 */
module.exports = function (RED) {
  /**
   * Collect hook functions for a given name across all registered plugins
   * of type `PLUGIN_TYPE`. Returns an empty list when no plugins or when
   * `RED.plugins` is unavailable.
   *
   * @param {string} name
   * @returns {Array<{ fn: Function, id: string }>}
   */
  function getHooks(name) {
    let plugins = [];
    try {
      plugins = RED.plugins.getByType(PLUGIN_TYPE) || [];
    } catch (_) {
      return [];
    }
    const out = [];
    for (const p of plugins) {
      const fn = p && p.hooks && p.hooks[name];
      if (typeof fn === "function") out.push({ fn, id: p.id || p.name || "?" });
    }
    return out;
  }

  /**
   * AND-fold across all registered hook implementations. A hook returning
   * `false` (or throwing) blocks the action. No hooks → allowed.
   *
   * @param {string} name
   * @param  {...unknown} args
   * @returns {boolean}
   */
  function allow(name, ...args) {
    const hooks = getHooks(name);
    if (hooks.length === 0) return true;
    for (const h of hooks) {
      let result;
      try {
        result = h.fn(...args);
      } catch (e) {
        RED.log.error(
          `[portal-react] hook ${name} (${h.id}) threw: ${e.message}`,
        );
        return false;
      }
      if (result === false) return false;
    }
    return true;
  }

  /**
   * Sequentially apply each hook to the running value. A hook returning
   * `undefined` keeps the current value; returning `null` is treated as
   * "drop this message" by callers (caller checks for null after transform).
   * Throws are logged via `RED.log.error` and the hook is skipped.
   *
   * @template T
   * @param {string} name
   * @param {T} msg
   * @param  {...unknown} args
   * @returns {T|null}
   */
  function transform(name, msg, ...args) {
    const hooks = getHooks(name);
    let current = msg;
    for (const h of hooks) {
      try {
        const next = h.fn(current, ...args);
        if (next !== undefined) current = next;
      } catch (e) {
        RED.log.error(
          `[portal-react] hook ${name} (${h.id}) threw: ${e.message}`,
        );
      }
    }
    return current;
  }

  /**
   * @param {string} name
   * @returns {boolean}  True when at least one plugin registers the hook.
   */
  function hasHook(name) {
    return getHooks(name).length > 0;
  }

  return { allow, transform, hasHook, PLUGIN_TYPE };
};

module.exports.PLUGIN_TYPE = PLUGIN_TYPE;
