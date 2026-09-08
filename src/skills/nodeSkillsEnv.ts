import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";
import { err, ExecutionError, FileError, type ExecutionEnv, type Result, type ShellExecOptions } from "@earendil-works/pi-agent-core";

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
	override async exec(_command: string, _options?: ShellExecOptions): Promise<Result<{ stdout: string; stderr: string; exitCode: number }, ExecutionError>> {
		return err(new ExecutionError("shell_unavailable", "the user-skills environment has no shell"));
	}

	override async createTempDir(_prefix?: string): Promise<Result<string, FileError>> {
		return err(new FileError("not_supported", "user skills do not use temporary directories", this.cwd));
	}

	override async createTempFile(_options?: { prefix?: string; suffix?: string }): Promise<Result<string, FileError>> {
		return err(new FileError("not_supported", "user skills do not use temporary files", this.cwd));
	}
}

export function createNodeSkillsEnv(home: string): ExecutionEnv {
	return new UserSkillsNodeEnv({ cwd: home });
}
