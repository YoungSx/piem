/** Runs inside Obsidian's renderer. Observes the real plugin loader, without editing main.js. */
export function observePluginNodeAccess(pluginId) {
 const originalEval = window.eval;
 const originalError = console.error;
 const report = { evaluations: 0, requests: [], controls: [], consoleErrors: [] };
 let checkingControl = false;
 console.error = function (...args) {
  report.consoleErrors.push({ control: checkingControl, message: args.map(value => String(value instanceof Error ? value.stack ?? value.message : value)).join(' ') });
  return originalError.apply(this, args);
 };
 window.eval = function (source) {
  const factory = originalEval.call(window, source);
  if (typeof source !== 'string' || !source.includes(`//# sourceURL=plugin:${encodeURIComponent(pluginId)}\n`)) return factory;
  report.evaluations += 1;
  return function (lookup, module, exports) {
   // Negative controls use the SAME require Obsidian will pass to the plugin.
   // Node in the DevTools console says nothing about this scoped lookup.
   if (!report.controls.length) {
    checkingControl = true;
    try {
     for (const id of ['fs', 'node:fs', 'node:fs/promises', 'child_process', 'node:module', 'electron']) {
      let value;
      try { value = lookup(id); } catch { value = null; }
      report.controls.push({ id, provided: value != null });
     }
    } finally { checkingControl = false; }
   }
   return factory(id => {
    let value;
    try { value = lookup(id); }
    finally { report.requests.push({ id, provided: value != null }); }
    if (id === 'obsidian') {
     const p = value.Platform;
     report.platform = { isMobile: p.isMobile, isDesktop: p.isDesktop, isMobileApp: p.isMobileApp, isDesktopApp: p.isDesktopApp };
    }
    return value;
   }, module, exports);
  };
 };
 return { report, restore() { window.eval = originalEval; console.error = originalError; } };
}
