/** A private virtual environment for bundled extensions; never assigned to window.process. */
import { unavailable } from "./unavailable";
export const env = Object.freeze({ PI_PACKAGE_DIR: "/pi", PI_TIMING: "0" });
export const platform = "browser";
export const arch = "web";
export const versions = Object.freeze({});
export const features = Object.freeze({});
export const cwd = (): string => "/vault";
export const execPath = "";
export const argv: readonly string[] = [];
export const getBuiltinModule = (): undefined => undefined;
export const exit = (): never => unavailable("process.exit");
export default { env, platform, arch, versions, features, cwd, execPath, argv, getBuiltinModule, exit };
