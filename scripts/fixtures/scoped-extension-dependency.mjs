/** Shared library code must close over exactly the same host as its parent. */
import crypto from "node:crypto";
import { Buffer } from "buffer";
import process, { env, pid, cwd } from "node:process";
import { setTimeout, clearTimeout } from "node:timers";
import timers from "timers";
import delay, { setTimeout as sleep } from "node:timers/promises";
import { homedir } from "node:os";

let interval;
let timeout;
const transport = globalThis["fetch"];

export async function probe(value) {
	env.BRIDGE_CONTRACT = value;
	const response = await transport(`${env.BRIDGE_ENDPOINT ?? "https://bridge.example"}/dependency`, { method: "POST", body: value });
	return {
		value: process.env.BRIDGE_CONTRACT,
		globalValue: globalThis.process.env.BRIDGE_CONTRACT,
		pid, cwd: cwd(), home: homedir(),
		dependent: await response.text(),
		digest: crypto.createHash("sha256").update(Buffer.from(value)).digest("hex"),
		uuid: crypto.randomUUID(), random: crypto.randomBytes(8).toString("hex"),
		processIdentity: process === globalThis.process,
		timerIdentity: setTimeout === globalThis.setTimeout && timers.setInterval === globalThis.setInterval,
		promiseIdentity: sleep === delay.setTimeout,
		url: import.meta.url,
	};
}

export function start(value, report) {
	stop();
	const send = async kind => {
		const response = await globalThis.fetch(`${env.BRIDGE_ENDPOINT ?? "https://bridge.example"}/periodic`, { method: "POST", body: `${kind}:${value}` });
		report(await response.text());
	};
	timeout = setTimeout(() => send("timeout"), 5);
	interval = globalThis["setInterval"](() => send("interval"), 10);
}

export function stop() {
	clearTimeout(timeout);
	globalThis.clearInterval(interval);
	timeout = interval = undefined;
}
