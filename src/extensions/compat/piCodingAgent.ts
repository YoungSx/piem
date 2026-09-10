/** Browser exports only; never import the CLI root or its filesystem configuration. */
export { BorderedLoader, DynamicBorder } from "./loader";
export { theme, getSelectListTheme } from "./theme";

/** Virtual compatibility path. Existing resource shims still own all access. */
export const getAgentDir = (): string => "/vault/.pi/agent";
