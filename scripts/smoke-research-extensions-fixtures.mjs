/** Deterministic local wire fixtures. Importing this module starts no server. */
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

export const SOURCE = { title: "Obsidian documentation", url: "https://docs.obsidian.md/Plugins/Getting+started/Build+a+plugin" };
export const SEARCH_TEXT = "Obsidian plugins keep notes inside the vault.";

const sse = (data, name) => `${name ? `event: ${name}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
const event = (type, data = {}) => sse({ type, ...data }, type);

export function openaiChat(model, step, id) {
	const chunk = { id, object: "chat.completion.chunk", created: 1, model, choices: [{ index: 0, delta: step.tool
		? { tool_calls: [{ index: 0, id: `${id}-call`, type: "function", function: { name: step.tool.name, arguments: JSON.stringify(step.tool.args) } }] }
		: { content: step.text ?? "已完成本轮整理。" }, finish_reason: null }] };
	return sse(chunk) + sse({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: step.tool ? "tool_calls" : "stop" }], usage: { prompt_tokens: 15, completion_tokens: 10, total_tokens: 25 } }) + "data: [DONE]\n\n";
}

export function responsesChat(model, step, id) {
	const item = step.tool
		? { type: "function_call", id: `fc_${id}`, call_id: `${id}-call`, name: step.tool.name, arguments: JSON.stringify(step.tool.args), status: "completed" }
		: { type: "message", id: `msg_${id}`, role: "assistant", status: "completed", content: [{ type: "output_text", text: step.text ?? "已完成本轮整理。", annotations: [] }] };
	let result = event("response.created", { response: { id, model, status: "in_progress", output: [] } });
	result += event("response.output_item.added", { output_index: 0, item: { ...item, ...(step.tool ? { arguments: "" } : { content: [] }) } });
	if (step.tool) result += event("response.function_call_arguments.delta", { output_index: 0, item_id: item.id, delta: item.arguments });
	else result += event("response.output_text.delta", { output_index: 0, item_id: item.id, content_index: 0, delta: item.content[0].text });
	result += event("response.output_item.done", { output_index: 0, item });
	return result + event("response.completed", { response: { id, model, status: "completed", output: [item], usage: { input_tokens: 15, output_tokens: 10, total_tokens: 25 } } });
}

function anthropicChat(model, step, id) {
	const block = step.tool ? { type: "tool_use", id: `${id}-call`, name: step.tool.name, input: {} } : { type: "text", text: "" };
	return event("message_start", { message: { id, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 15, output_tokens: 0 } } })
		+ event("content_block_start", { index: 0, content_block: block })
		+ event("content_block_delta", { index: 0, delta: step.tool ? { type: "input_json_delta", partial_json: JSON.stringify(step.tool.args) } : { type: "text_delta", text: step.text ?? "已完成本轮整理。" } })
		+ event("content_block_stop", { index: 0 })
		+ event("message_delta", { delta: { stop_reason: step.tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } })
		+ event("message_stop");
}

export function searchResponse(protocol) {
	if (protocol === "responses") {
		const call = { type: "web_search_call", id: "search-local", status: "completed", action: { type: "search", query: "Obsidian plugins vault", sources: [SOURCE] } };
		const annotation = { type: "url_citation", title: SOURCE.title, url: SOURCE.url, start_index: 0, end_index: SEARCH_TEXT.length };
		return event("response.web_search_call.searching", { item_id: call.id })
			+ event("response.output_item.done", { output_index: 0, item: call })
			+ event("response.output_text.delta", { output_index: 1, content_index: 0, delta: SEARCH_TEXT })
			+ event("response.output_text.annotation.added", { output_index: 1, content_index: 0, annotation })
			+ event("response.completed", { response: { id: "search-response", status: "completed", output: [call] } });
	}
	if (protocol !== "anthropic") throw new Error(`Unsupported search fixture protocol: ${protocol}`);
	return event("message_start", { message: { id: "search-message", type: "message", role: "assistant", content: [], usage: { input_tokens: 10, output_tokens: 0 } } })
		+ event("content_block_start", { index: 0, content_block: { type: "server_tool_use", id: "search-local", name: "web_search", input: { query: "Obsidian plugins vault" } } })
		+ event("content_block_stop", { index: 0 })
		+ event("content_block_start", { index: 1, content_block: { type: "web_search_tool_result", tool_use_id: "search-local", content: [{ type: "web_search_result", ...SOURCE, encrypted_content: "fixture-only" }] } })
		+ event("content_block_stop", { index: 1 })
		+ event("content_block_start", { index: 2, content_block: { type: "text", text: "" } })
		+ event("content_block_delta", { index: 2, delta: { type: "text_delta", text: SEARCH_TEXT } })
		+ event("content_block_delta", { index: 2, delta: { type: "citations_delta", citation: { type: "web_search_result_location", ...SOURCE, cited_text: SEARCH_TEXT, encrypted_index: "fixture-only" } } })
		+ event("content_block_stop", { index: 2 })
		+ event("message_delta", { delta: { stop_reason: "end_turn" }, usage: { output_tokens: 10 } })
		+ event("message_stop");
}

function requestKind(body) {
	if (body.tools?.some(tool => tool.type === "web_search" || tool.type?.startsWith("web_search_"))) return "search";
	if (JSON.stringify(body).includes("You rewrite rough, plain-language user prompts")) return "clarify";
	if (body.tools?.length) return "chat";
	return "auxiliary";
}

async function jsonBody(request) {
	let data = "";
	for await (const chunk of request) {
		data += chunk;
		if (data.length > 2 * 1024 * 1024) throw new Error("Fixture request exceeds 2 MiB");
	}
	return data ? JSON.parse(data) : {};
}

export function createResearchFixture() {
	const token = randomUUID(), requests = [], errors = [], gates = new Map();
	let plan = { id: "unconfigured", chat: [] }, closed = false;
	const snapshot = () => ({ requests, errors, gates: [...gates.values()].map(({ label, entered, released, cancelled }) => ({ label, entered, released, cancelled })), plan: plan.id });
	const releaseAll = () => { for (const gate of gates.values()) gate.release(); };
	const hold = (label, response) => new Promise((resolve, reject) => {
		if (gates.has(label)) { reject(new Error(`Duplicate fixture gate: ${label}`)); return; }
		let timer;
		const done = () => { clearTimeout(timer); response.removeListener("close", cancel); gate.released = true; resolve(); };
		const cancel = () => { gate.cancelled = true; done(); };
		const gate = { label, entered: true, released: false, cancelled: false, release: done };
		gates.set(label, gate);
		response.once("close", cancel);
		timer = setTimeout(() => { done(); errors.push(`Gate timed out: ${label}`); }, 12000);
	});
	const server = createServer(async (request, response) => {
		try {
			const url = new URL(request.url, "http://localhost");
			if (url.pathname.startsWith("/__smoke/")) {
				// Only fixture control gets CORS. Provider traffic must use Obsidian's transport.
				response.setHeader("access-control-allow-origin", "*");
				response.setHeader("access-control-allow-headers", "content-type,x-smoke-control");
				response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
				if (request.method === "OPTIONS") { response.writeHead(204); response.end(); return; }
				if (request.headers["x-smoke-control"] !== token) { response.writeHead(403); response.end(); return; }
				if (url.pathname === "/__smoke/plan" && request.method === "POST") {
					if ([...gates.values()].some(gate => !gate.released)) throw new Error("Previous fixture still has a held request");
					plan = await jsonBody(request);
					if (typeof plan.id !== "string" || !Array.isArray(plan.chat)) throw new Error("Invalid smoke plan");
					plan.chat = [...plan.chat];
				} else if (url.pathname === "/__smoke/release" && request.method === "POST") {
					const { label } = await jsonBody(request), gate = gates.get(label);
					if (!gate) throw new Error(`Unknown fixture gate: ${label}`);
					gate.release();
				} else if (url.pathname === "/__smoke/release-all" && request.method === "POST") releaseAll();
				else if (url.pathname !== "/__smoke/state") throw new Error("Unknown fixture control request");
				const state = snapshot();
				// Gate polling must not repeatedly transfer every full provider payload.
				state.requests = url.searchParams.has("requests")
					? requests.filter(item => (!url.searchParams.has("plan") || item.plan === url.searchParams.get("plan")) && (!url.searchParams.has("kind") || item.kind === url.searchParams.get("kind")))
					: requests.map(({ body: _body, ...item }) => item);
				response.setHeader("content-type", "application/json"); response.end(JSON.stringify(state)); return;
			}
			if (request.method !== "POST") { response.writeHead(404); response.end(); return; }
			const protocol = url.pathname.endsWith("/chat/completions") ? "completions" : url.pathname.endsWith("/responses") ? "responses" : url.pathname.endsWith("/messages") ? "anthropic" : undefined;
			if (!protocol) throw new Error(`Unexpected provider path: ${url.pathname}`);
			const body = await jsonBody(request), kind = requestKind(body);
			const model = body.model;
			const auth = request.headers["x-api-key"] ?? request.headers.authorization;
			const record = { index: requests.length + 1, plan: plan.id, kind, protocol, model, path: url.pathname, authenticated: typeof auth === "string" && auth.includes("local-research-fixture-key"), body };
			requests.push(record);
			const currentPlan = plan;
			const step = kind === "chat" ? currentPlan.chat.shift() : kind === "clarify" ? currentPlan.clarify : kind === "search" ? currentPlan.search : { text: "[]" };
			if (!step) throw new Error(`Unexpected ${kind} request in ${currentPlan.id}`);
			if (step.hold) await hold(step.hold, response);
			if (response.destroyed || closed) return;
			if (step.error) {
				response.writeHead(step.error, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: { message: "Fixture authentication denied", type: "authentication_error" } }));
				return;
			}
			const id = `research_${record.index}`;
			const text = kind === "search" ? searchResponse(protocol) : protocol === "responses" ? responsesChat(model, step, id) : protocol === "anthropic" ? anthropicChat(model, step, id) : openaiChat(model, step, id);
			response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" }); response.end(text);
		} catch (error) {
			errors.push(String(error.stack ?? error));
			if (!response.destroyed) { if (!response.headersSent) response.writeHead(500); response.end(String(error)); }
		}
	});
	return {
		token, snapshot,
		async listen() {
			await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
			return `http://127.0.0.1:${server.address().port}`;
		},
		async close() {
			closed = true; releaseAll(); server.closeAllConnections();
			await new Promise(resolve => server.close(resolve));
		},
	};
}
