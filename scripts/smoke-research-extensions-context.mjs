/** Verifies checkpoint facts, old branch preservation, and resumed model input on disk. */
export async function contextScenarios(h) {
	const path = await h.configure("openai-responses");
	const checkpoint = "research-sources-verified", backup = "research-before-summary";
	const summary = "已核对 Obsidian 官方插件文档。保留引用和事实；下一步：整理待办，不再重复搜索。";
	const log = () => h.plugin.sessionManager.getSessionFor(path).getLog();
	const facts = items => items.filter(item => item.kind === "fact" && item.fact === "label");
	await h.submit("/context");
	await h.wait(() => document.querySelector(".piem-chat__context-popover"), "Native context command opens readout");
	h.record("context-command: native context readout opens", true);
	document.querySelector(".piem-chat__context-gauge")?.click();
	await h.idle(path);
	await h.plan("context-seed", { chat: [{ text: "已核对资料，可以记录一个检查点。" }] });
	h.record("context-seed: real conversation created", await h.service.sendPrompt("先核对资料，再保存这个阶段。")); await h.idle(path);
	const checkpointResult = await h.tool("为已核对资料建立检查点。", "context_checkpoint", { name: checkpoint }, "context-checkpoint");
	h.record("context-checkpoint: original tool confirms label", h.textOf(checkpointResult).includes(`Created checkpoint '${checkpoint}'`));
	const saved = facts(await log()).find(item => item.label === checkpoint);
	h.record("context-checkpoint: label is a persisted session fact", !!saved?.targetId);
	const anchor = saved.targetId;
	const timeline = await h.tool("查看当前会话时间线。", "context_timeline", { limit: 20 }, "context-timeline");
	h.record("context-timeline: original checkpoint and head visible", h.textOf(timeline).includes(checkpoint) && h.textOf(timeline).includes("HEAD") && h.textOf(timeline).includes(anchor));
	const labelsBefore = facts(await log()).filter(item => item.label === checkpoint).length;
	const duplicate = await h.tool("尝试重复的检查点名字。", "context_checkpoint", { name: checkpoint }, "context-duplicate");
	h.record("context-duplicate: existing label protected", /already exists/i.test(h.textOf(duplicate)) && facts(await log()).filter(item => item.label === checkpoint).length === labelsBefore);
	const before = await log(), originalIds = before.filter(item => item.kind === "entry").map(item => item.entry.id);
	await h.plan("context-compact", { chat: [
		{ tool: { name: "context_compact", args: { target: checkpoint, summary, backupCheckpoint: backup } } },
		{ text: "已根据交接摘要继续，开始整理待办。" },
	] });
	await h.service.sendPrompt("把检查点后的工作压成摘要，再按下一步继续。");
	await h.wait(async () => (await log()).some(item => item.kind === "entry" && item.entry.type === "branch_summary" && item.entry.summary.includes(summary)), "Context summary persisted", 12000);
	await h.wait(async () => (await h.requests("context-compact", "chat")).length === 2, "Context continuation request", 12000);
	await h.idle(path);
	const compactLog = await log();
	const branch = compactLog.find(item => item.kind === "entry" && item.entry.type === "branch_summary" && item.entry.summary.includes(summary)).entry;
	h.record("context-compact: summary branches from checkpoint", branch.parentId === anchor);
	h.record("context-compact: original history preserved", originalIds.every(id => compactLog.some(item => item.kind === "entry" && item.entry.id === id)));
	h.record("context-compact: backup checkpoint persisted", facts(compactLog).some(item => item.label === backup));
	const active = await h.entries(path);
	h.record("context-compact: active branch contains summary", active.some(entry => entry.id === branch.id));
	const compactRequests = await h.requests("context-compact", "chat");
	h.record("context-compact: continuation receives handoff", JSON.stringify(compactRequests[1].body).includes(summary));
	h.record("context-compact: private command never reaches model", compactRequests.every(request => !JSON.stringify(request.body).includes('"/acm"')));
	h.record("context-compact: invisible marker not shown in transcript", !document.querySelector(".piem-chat")?.textContent.includes("context_compact complete. A handoff summary"));
	const stored = await h.plugin.sessionManager.buildSessionContextFor(path);
	h.record("context-compact: hidden continuation marker saved", stored.messages.some(message => message.role === "custom" && message.customType === "pi-context" && message.display === false));

	const registrations = h.plugin._events.length;
	for (let index = 1; index <= 2; index++) {
		const oldService = h.service, oldHost = oldService.runtimes.get(path)?.communityHost;
		await h.reload(); await h.service.openSession(path); await h.idle(path);
		h.record(`context-reload-${index}: listeners stable`, h.plugin._events.length === registrations);
		h.record(`context-reload-${index}: old host refuses commands`, !!(await h.settle(oldHost.run("acm"))).error);
		h.record(`context-reload-${index}: label survives reload`, facts(await log()).some(item => item.label === checkpoint && item.targetId === anchor));
		h.record(`context-reload-${index}: summary survives reload`, (await h.entries(path)).some(entry => entry.id === branch.id));
		const restored = await h.tool("重载后重新查看时间线。", "context_timeline", { limit: 20 }, `context-reload-${index}`);
		h.record(`context-reload-${index}: timeline restored`, h.textOf(restored).includes(checkpoint) && h.textOf(restored).includes("SUMMARY"));
	}
	await h.wait(() => document.querySelector(".piem-chat__composer textarea"), "Final composer visible");
	const chatElement = document.querySelector(".piem-chat");
	h.record("final layout: chat does not overflow horizontally", !!chatElement && chatElement.scrollWidth <= chatElement.clientWidth + 1);
	h.report.contextSession = { path, checkpoint, anchor, summaryId: branch.id, backup };
}
