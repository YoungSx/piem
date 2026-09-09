import { unavailable } from "./unavailable";
export const homedir = (): string => "/vault";
export const platform = (): string => "browser";
export const tmpdir = (): never => unavailable("os.tmpdir");
export default { homedir, platform, tmpdir };
