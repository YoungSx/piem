/** Runs in the real renderer; fixture replies cross the shipped provider transport. */
export async function searchScenarios(h) {
	const source = "https://docs.obsidian.md/Plugins/Getting+started/Build+a+plugin";
	const names = body => (body.tools ?? []).map(tool => tool.name ?? tool.function?.name);
	for (const [protocol, wire, provider] of [["openai-responses", "responses", "openai"], ["anthropic-messages", "anthropic", "anthropic"]]) {
		const path = await h.configure(protocol), id = `search-${wire}`;
		const query = "Obsidian plugins vault", privateText = `PRIVATE_VAULT_CONTEXT_${wire}`;
		await h.plan(`${id}-seed`, { chat: [{ text: "已记下这条仅用于本地验收的笔记。" }] });
		h.record(`${id}: seed conversation`, await h.service.sendPrompt(privateText)); await h.idle(path);
		await h.plan(id, {
			chat: [{ tool: { name: "web_search", args: { query } } }, { text: `笔记保存在笔记库中。[Obsidian 文档](${source})` }], search: {},
		});
		h.record(`${id}: real search conversation completes`, await h.service.sendPrompt("查找 Obsidian 插件与笔记库的官方资料，附上来源。"));
		await h.idle(path);
		const result = h.service.getSnapshot().messages.filter(message => message.role === "toolResult" && message.toolName === "web_search").at(-1);
		h.record(`${id}: result carries source URL`, h.textOf(result).includes(source));
		h.record(`${id}: provider reports native search`, result?.details?.nativeSearchUsed === true && result.details.providerKind === provider);
		h.record(`${id}: structured sources retained`, result.details.sources.some(item => item.url === source));
		h.record(`${id}: citation result persisted`, (await h.plugin.sessionManager.buildSessionContextFor(path)).messages.some(message => message.role === "toolResult" && message.toolCallId === result.toolCallId && h.textOf(message).includes(source)));
		await h.wait(() => [...document.querySelectorAll('.piem-chat a[href]')].some(link => link.getAttribute("href") === source), `${id} rendered citation`);
		h.record(`${id}: rendered citation is reachable`, true);
		const search = await h.requests(id, "search"), chat = await h.requests(id, "chat");
		h.record(`${id}: one search and two conversation requests`, search.length === 1 && chat.length === 2);
		h.record(`${id}: configured protocol and credential reused`, search[0].protocol === wire && search[0].authenticated && search[0].model === "research-model");
		h.record(`${id}: search sends query without prior conversation`, JSON.stringify(search[0].body).includes(query) && !JSON.stringify(search[0].body).includes(privateText));
		h.record(`${id}: caller receives source in next request`, JSON.stringify(chat[1].body).includes(source));
		h.record(`${id}: context tools and web search available`, ["web_search", "context_checkpoint", "context_timeline", "context_compact"].every(name => names(chat[0].body).includes(name)));
		h.record(`${id}: Gemini-only URL context absent`, !names(chat[0].body).includes("url_context"));
	}

	await h.configure("openai-responses");
	await h.plan("search-401", { chat: [{ tool: { name: "web_search", args: { query: "拒绝凭据验收" } } }, { text: "搜索服务拒绝了凭据。" }], search: { error: 401 } });
	await h.service.sendPrompt("检查搜索服务拒绝凭据的情况。"); await h.idle();
	const denied = h.service.getSnapshot().messages.filter(message => message.role === "toolResult" && message.toolName === "web_search").at(-1);
	h.record("search-401: native failure has HTTP evidence", h.textOf(denied).includes("401") && denied.isError === true);
	h.record("search-401: no invented citations", !h.textOf(denied).includes(source));
	h.record("search-401: no automatic retry", (await h.requests("search-401", "search")).length === 1);

	const path = await h.configure("openai-responses");
	await h.plan("search-cancel", { chat: [{ tool: { name: "web_search", args: { query: "取消搜索验收" } } }], search: { hold: "search-cancel" } });
	const running = h.settle(h.service.sendPrompt("开始搜索，等待取消。"));
	await h.held("search-cancel");
	const stopping = h.settle(h.service.abortSession(path));
	await h.release("search-cancel");
	h.record("search-cancel: stop settles", !(await stopping).error);
	await running; await h.idle(path);
	h.record("search-cancel: late search cannot restart conversation", (await h.requests("search-cancel", "chat")).length === 1);
	h.record("search-cancel: no late cited success", !h.service.getSnapshot().messages.some(message => message.role === "toolResult" && message.toolName === "web_search" && h.textOf(message).includes(source)));

	await h.configure("openai-completions");
	await h.plan("search-unsupported", { chat: [{ tool: { name: "web_search", args: { query: "不能静默切换服务商" } } }, { text: "当前协议不支持原生搜索。" }] });
	await h.service.sendPrompt("验证不支持搜索的协议。"); await h.idle();
	const unsupported = h.service.getSnapshot().messages.filter(message => message.role === "toolResult" && message.toolName === "web_search").at(-1);
	h.record("search-unsupported: reason is explicit", unsupported?.details?.error === "unsupported_model" || /does not support|unsupported|不支持/i.test(h.textOf(unsupported)));
	h.record("search-unsupported: no silent provider fallback", (await h.requests("search-unsupported", "search")).length === 0);
}
