// Original published factories, compiled at build time with the audited platform bridge.
export { default as provenance } from "../../node_modules/pi-assistant-provenance/extensions/assistant-provenance/index.ts";
export { default as modelSwitch } from "../../node_modules/pi-model-switch/index.ts";
export { default as invisibleContinue } from "../../node_modules/pi-invisible-continue/continue.ts";
// Scoped builders close each upstream module graph over one host's capabilities.
export { createFactory as createWebSearch } from "pi-scoped-factory:pi-web-search";
export { createFactory as createClarify } from "pi-scoped-factory:pi-clarify";
export { createFactory as createContext } from "pi-scoped-factory:pi-context";
