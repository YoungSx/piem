/** Browser exports only; never import the CLI root or its filesystem configuration. */
export { BorderedLoader, DynamicBorder } from "./loader";
export { theme, getSelectListTheme } from "./theme";
import { EXTENSION_CONFIG_ROOT } from "../extensionConfigStore";

/**
 * The one virtual agent directory, shared with the scoped platform's own
 * `getAgentDir`.
 *
 * This used to answer `/vault/.pi/agent` while the scoped platform answered
 * `/extensions/config`, which meant a non-scoped extension resolving a config
 * path built one no reader could serve: the resource `fs` only holds each
 * audited package's `package.json`, so every such read returned ENOENT and the
 * extension silently fell back to its defaults. Two values could only ever
 * agree by accident, so there is now one.
 */
export const getAgentDir = (): string => EXTENSION_CONFIG_ROOT;

/**
 * Pi's config directory name, `.pi`. Upstream extensions join it with a home or
 * cwd to spell their storage path (`<cwd>/.pi/<file>.json`); the platform's
 * config bridge translates that `.pi` root into the owner's namespace.
 */
export const CONFIG_DIR_NAME = ".pi";
