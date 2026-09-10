/** Exercises upstream clarify through the real service and mounted React composer. */
export async function clarifyScenarios(h) {
	const path = await h.configure("openai-responses");
	const rewritten = "整理周五的会议笔记，保留原始事实，并列出待办事项。";
	await h.type("");
	await h.plan("clarify-args", { clarify: { text: rewritten } });
	h.record("clarify-args: extension command handles request", await h.service.runExtensionCommand("clarify", "把周五会议笔记理清楚，留着事实，再列要做的事"));
	await h.wait(() => h.textarea()?.value === rewritten, "Clarify result in composer"); await h.idle(path);
	h.record("clarify-args: result fills actual textarea", true);
	h.record("clarify-args: rewrite does not send a conversation", h.service.getSnapshot().messages.length === 0 && (await h.requests("clarify-args", "chat")).length === 0);
	h.record("clarify-args: configured credential reused", (await h.requests("clarify-args", "clarify")).every(request => request.authenticated && request.protocol === "responses"));
	await h.plan("clarify-manual-send", { chat: [{ text: "已按确认后的要求整理。" }] });
	await h.submit(rewritten);
	await h.wait(() => h.service.getSnapshot().messages.some(message => message.role === "assistant"), "Manual send after clarify"); await h.idle(path);
	h.record("clarify-manual-send: user chooses when to send", (await h.requests("clarify-manual-send", "chat")).length === 1);

	const editorText = "把长段笔记分成三段，保留引用";
	await h.type(editorText); await h.plan("clarify-editor", { clarify: { text: "将笔记整理为三个段落，保留全部引用。" } });
	await h.service.runExtensionCommand("clarify");
	await h.wait(() => h.textarea()?.value === "将笔记整理为三个段落，保留全部引用。", "Clarify reads editor text");
	h.record("clarify-editor: source comes from composer", JSON.stringify((await h.requests("clarify-editor", "clarify"))[0]?.body).includes(editorText));
	await h.idle(path);

	await h.type("");
	await h.plan("clarify-marker", { clarify: { text: "为下周制定三个明确的学习目标。" } });
	const before = h.service.getSnapshot().messages.length;
	await h.submit("下周想学点东西，定三个目标 -clarify");
	await h.wait(() => h.textarea()?.value === "为下周制定三个明确的学习目标。", "Marker rewrite ready"); await h.idle(path);
	h.record("clarify-marker: upstream input hook does not send chat", (await h.requests("clarify-marker", "chat")).length === 0 && h.service.getSnapshot().messages.length === before);
	h.record("clarify-marker: marker stripped before rewrite request", !JSON.stringify((await h.requests("clarify-marker", "clarify"))[0]?.body).includes("-clarify"));

	await h.type("发生错误也保留这份草稿");
	await h.plan("clarify-401", { clarify: { error: 401 } });
	await h.service.runExtensionCommand("clarify", "检查凭据错误"); await h.idle(path);
	h.record("clarify-401: draft preserved", h.textarea()?.value === "发生错误也保留这份草稿");
	h.record("clarify-401: failure visible", /401|authentication|empty text|认证|凭据/i.test(document.body.textContent + JSON.stringify(h.service.getSnapshot().errorMessage ?? "")));
	h.record("clarify-401: no automatic retry or conversation send", (await h.requests("clarify-401", "clarify")).length === 1 && (await h.requests("clarify-401", "chat")).length === 0);

	await h.plan("clarify-cancel", { clarify: { text: "迟到的改写绝不能覆盖草稿", hold: "clarify-cancel" } });
	const cancelled = h.settle(h.service.runExtensionCommand("clarify", "要取消的改写"));
	await h.held("clarify-cancel");
	const stopping = h.settle(h.service.abortSession(path));
	await h.type("取消后我重新写的草稿"); await h.release("clarify-cancel");
	h.record("clarify-cancel: stop settles", !(await stopping).error); await cancelled; await h.idle(path);
	h.record("clarify-cancel: late result preserves new draft", h.textarea()?.value === "取消后我重新写的草稿");
	h.record("clarify-cancel: no chat request", (await h.requests("clarify-cancel", "chat")).length === 0);

	await h.type("");
	await h.plan("clarify-session-owner", { clarify: { text: "属于原聊天的改写", hold: "clarify-session-owner" } });
	const pending = h.settle(h.service.runExtensionCommand("clarify", "留在原聊天的请求"));
	await h.held("clarify-session-owner"); await h.service.newSession();
	const other = h.service.getActiveSessionPath(); await h.type("另一聊天正在写的草稿");
	await h.release("clarify-session-owner"); await pending; await h.idle(path);
	h.record("clarify-session-owner: new conversation keeps its draft", h.service.getActiveSessionPath() === other && h.textarea()?.value === "另一聊天正在写的草稿");
	h.record("clarify-session-owner: new conversation stays empty", h.service.getSnapshot().messages.length === 0);

	await h.service.openSession(path); await h.idle(path);
	await h.type("卸载时保留的草稿");
	await h.plan("clarify-unload", { clarify: { text: "旧插件的迟到改写", hold: "clarify-unload" } });
	const stale = h.settle(h.service.runExtensionCommand("clarify", "卸载中的改写"));
	await h.held("clarify-unload");
	const reloading = h.settle(h.reload());
	await h.release("clarify-unload");
	h.record("clarify-unload: reload settles", !(await reloading).error);
	await stale; await h.service.openSession(path); await h.idle(path);
	h.record("clarify-unload: old result never overwrites restored draft", h.textarea()?.value !== "旧插件的迟到改写");
	h.record("clarify-unload: no late conversation request", (await h.requests("clarify-unload", "chat")).length === 0);

	h.record("clarify-pin: original model command persists", await h.service.runExtensionCommand("clarify", "model research-fixture research-model"));
	h.plugin.settings.models.push({ id: "research-alternate", providerId: "research-fixture", modelApiId: "research-alternate", displayName: "Alternate research fixture", reasoning: false, supportsImages: false });
	h.plugin.settings.activeModelId = "research-alternate";
	await h.plugin.saveSettings(); await h.idle(path);
	const registrations = h.plugin._events.length;
	await h.reload(); await h.service.openSession(path); await h.idle(path);
	h.record("clarify-pin: listeners stable after reload", h.plugin._events.length === registrations);
	await h.service.setActiveModel("research-alternate"); await h.idle(path);
	h.record("clarify-pin: conversation really uses alternate model", h.service.getSnapshot().runningModelId === "research-alternate");
	await h.type(""); await h.plan("clarify-after-reload", { clarify: { text: "重载后继续整理原来的笔记。" } });
	await h.service.runExtensionCommand("clarify", "重载后再整理");
	await h.wait(() => h.textarea()?.value === "重载后继续整理原来的笔记。", "Clarify works after reload");
	const pinnedRequests = await h.requests("clarify-after-reload", "clarify");
	h.record("clarify-after-reload: pinned model survives different active choice", pinnedRequests.length === 1 && pinnedRequests[0].model === "research-model" && h.plugin.settings.activeModelId === "research-alternate");
	h.record("clarify-pin: model reset succeeds", await h.service.runExtensionCommand("clarify", "model reset"));
}
