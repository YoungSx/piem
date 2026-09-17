import type { Context } from "@earendil-works/chord";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { BACKGROUND_CONTEXT, err, ExecutionError, FileError, type ExecutionEnv, type Result, type ShellExecOptions, type ShellExecResult } from "@earendil-works/pi-agent-core";

const envProto = NodeExecutionEnv.prototype as unknown as Record<string, unknown>;
const methodsToPatch = [
	"exec", "readTextFile", "readTextLines", "readBinaryFile",
	"writeFile", "appendFile", "renameFile", "fileInfo", "listDir",
	"canonicalPath", "exists", "createDir", "remove", "createTempDir", "createTempFile", "absolutePath",
];
for (const method of methodsToPatch) {
	const orig = envProto[method];
	if (typeof orig === "function" && !(orig as { __patched?: boolean }).__patched) {
		const targetIdx = orig.length - 1;
		const patched = function (this: unknown, ...args: unknown[]) {
			while (args.length < orig.length) {
				args.push(undefined);
			}
			const ctx = args[targetIdx];
			if (!ctx || typeof ctx !== "object" || !("abortSignal" in ctx)) {
				args[targetIdx] = BACKGROUND_CONTEXT;
			}
			return (orig as (...a: unknown[]) => unknown).apply(this, args);
		};
		(patched as { __patched?: boolean }).__patched = true;
		envProto[method] = patched;
	}
}



/**
 * Pi owns filesystem operations and host-native path semantics. This bridge
 * owns only Obsidian's boundary: loading skill markdown never runs a shell or
 * creates temporary files. It is not the environment handed to model tools;
 * those still use VaultExecutionEnv.
 *
 * Keep this file behind nodeSkillsHost's lazy import. Pi's public Node entry
 * imports desktop builtins at module scope, including child_process.
 */
class UserSkillsNodeEnv extends NodeExecutionEnv {
	override async exec(
		_command: string,
		_options?: ShellExecOptions,
		_context?: Context,
	): Promise<Result<ShellExecResult, ExecutionError>> {
		return err(new ExecutionError("shell_unavailable", "the user-skills environment has no shell"));
	}

	override async createTempDir(_prefix?: string, _context?: Context): Promise<Result<string, FileError>> {
		return err(new FileError("not_supported", "user skills do not use temporary directories", this.cwd));
	}

	override async createTempFile(
		_options?: { prefix?: string; suffix?: string },
		_context?: Context,
	): Promise<Result<string, FileError>> {
		return err(new FileError("not_supported", "user skills do not use temporary files", this.cwd));
	}
}

export function createNodeSkillsEnv(home: string): ExecutionEnv {
	return new UserSkillsNodeEnv({ cwd: home });
}
