import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { ExtensionPlatform } from "./extensionPlatform";
export const provenance: ExtensionFactory;
export const modelSwitch: ExtensionFactory;
export const invisibleContinue: ExtensionFactory;
export function createWebSearch(platform: ExtensionPlatform): ExtensionFactory;
export function createClarify(platform: ExtensionPlatform): ExtensionFactory;
export function createContext(platform: ExtensionPlatform): ExtensionFactory;
