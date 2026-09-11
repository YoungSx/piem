/** Local compiler contract, deliberately absent from the production audit list. */
import { start, stop, probe } from "@piem-bridge/contract-dependency";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-ai";
import { Buffer as NodeBuffer } from "node:buffer";
import fs from "node:fs";

export default function (pi) {
	pi.registerCommand("bridge-probe", {
		description: "Check the scoped extension platform",
		handler: async (args, ctx) => {
			const config = `${getAgentDir()}/contract.json`;
			fs.mkdirSync(getAgentDir(), { recursive: true });
			fs.writeFileSync(config, JSON.stringify({ value: args }), "utf8");
			const response = await fetch(`${process.env.BRIDGE_ENDPOINT ?? "https://bridge.example"}/direct`, { method: "POST", body: args });
			ctx.ui.notify(JSON.stringify({
				...await probe(args),
				direct: await response.text(),
				config: JSON.parse(fs.readFileSync(config, "utf8")),
				files: fs.readdirSync(getAgentDir()),
				exists: fs.existsSync(config),
				buffer: Buffer.from(args).toString("base64"),
				bufferIdentity: Buffer === NodeBuffer && globalThis.Buffer === NodeBuffer,
				schema: Type.String().type,
				url: import.meta.url,
			}));
		},
	});
	pi.registerCommand("bridge-start", {
		description: "Start scoped periodic requests",
		handler: (args, ctx) => start(args, value => ctx.ui.notify(value)),
	});
	pi.registerCommand("bridge-stop", {
		description: "Stop scoped periodic requests",
		handler: () => stop(),
	});
	pi.on("session_shutdown", () => stop());
}
