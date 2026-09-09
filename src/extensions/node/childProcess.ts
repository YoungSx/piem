import { unavailable } from "./unavailable";
export const spawn = (): never => unavailable("child_process.spawn");
export const spawnSync = (): never => unavailable("child_process.spawnSync");
