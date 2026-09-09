/*
 * Paste into Obsidian's developer console while the scrollbar is stuck.
 * Drag twice, then select Latest. The report prints after scrolling settles.
 * Stop early with piemScrollProbe.stop(); it also stops after 60 seconds.
 *
 * This is an opt-in diagnostic, never imported by the plugin. It reads geometry
 * and input coordinates, not messages, note names, credentials or file paths.
 * No scrolling, DOM/style changes, network requests or clipboard writes.
 */
(() => {
	const scope = globalThis;
	const previous = scope.piemScrollProbe;
	if (previous && previous.kind !== "piem-scroll-probe") {
		throw new Error("piemScrollProbe is already in use by another script.");
	}
	previous?.stop();
	let doc = typeof activeDocument === "undefined" ? document : activeDocument;
	const candidates = Array.from(doc.querySelectorAll(".piem-chat__messages"))
		.filter(el => el.clientHeight > 0 && el.getBoundingClientRect().height > 0);
	let scroller = candidates.find(el => el.closest(".piem-chat")?.contains(doc.activeElement));
	const active = candidates.filter(el => el.closest(".workspace-leaf.mod-active"));
	scroller ??= active.length === 1 ? active[0] : candidates.length === 1 ? candidates[0] : null;
	if (!scroller) throw new Error(candidates.length === 0
		? "Open the Piem chat panel in this window first. / 请先打开本窗口的 Piem 聊天面板。"
		: "ambiguous-target: focus one Piem chat first. / 请先点击要检查的那个聊天面板。");
	candidates.length = 0;
	active.length = 0;
	let win = scroller.ownerDocument.defaultView;
	const start = win.performance.now();
	const events = [];
	const boundaries = [];
	const nodes = [];
	const removers = [];
	let observed = 0;
	let mutations = 0;
	let resizes = 0;
	let dragging = false;
	let beforeLatest = null;
	let result;
	let deadline;
	let latestDeadline;
	let lastMove = -Infinity;
	let mutationObserver;
	let resizeObserver;
	const elapsed = () => Math.round(win.performance.now() - start);
	const rounded = value => Math.round(value * 100) / 100;
	const rectOf = el => {
		const r = el.getBoundingClientRect();
		return Object.fromEntries(["x", "y", "width", "height", "top", "right", "bottom", "left"].map(key => [key, rounded(r[key])]));
	};
	for (let el = scroller; el && nodes.length < 8; el = el.parentElement) nodes.push(el);
	const initialRect = rectOf(scroller);
	const nodeKind = node => {
		const index = nodes.indexOf(node);
		if (index >= 0) return index === 0 ? "messages" : `ancestor-${index}`;
		if (node?.closest?.(".piem-chat__latest")) return "latest";
		return scroller?.contains(node) ? "message-descendant" : "outside";
	};
	const add = entry => {
		observed++;
		if (events.length === 240) events.splice(40, 1); // Keep the first 40 and latest 200.
		const record = { ms: elapsed(), ...entry };
		events.push(record);
		if (["pointerdown", "pointerup", "pointercancel", "latest-click"].includes(entry.type)) {
			if (boundaries.length === 24) boundaries.shift();
			boundaries.push(record);
		}
	};
	const snapshot = () => nodes.map((el, index) => {
		try {
			const style = win.getComputedStyle(el);
			return {
				node: index === 0 ? "messages" : `ancestor-${index}`,
				tag: el.tagName.toLowerCase(),
				// Arbitrary classes, ids and attributes may contain note names.
				classes: Array.from(el.classList).filter(name => /^(?:piem-chat(?:__transcript|-view)?|piem-chat__messages|workspace-leaf(?:-content)?|view-content)$/.test(name)),
				rect: rectOf(el),
				scrollTop: rounded(el.scrollTop), scrollLeft: rounded(el.scrollLeft),
				clientHeight: el.clientHeight, scrollHeight: el.scrollHeight,
				clientWidth: el.clientWidth, scrollWidth: el.scrollWidth,
				offsetWidth: el.offsetWidth, clientLeft: el.clientLeft,
				style: Object.fromEntries(["overflowX", "overflowY", "position", "display", "contain", "containerType", "transform", "zoom", "pointerEvents", "scrollbarGutter", "scrollBehavior", "direction", "borderLeftWidth", "borderRightWidth"].map(name => [name, style[name]])),
				appRegion: style.getPropertyValue("-webkit-app-region"),
			};
		} catch { return { node: index === 0 ? "messages" : `ancestor-${index}`, error: "geometry-unavailable" }; }
	});
	const initial = snapshot();
	let scrollbar;
	try {
		const bar = win.getComputedStyle(scroller, "::-webkit-scrollbar");
		const thumb = win.getComputedStyle(scroller, "::-webkit-scrollbar-thumb");
		scrollbar = { width: bar.width, minThumbHeight: thumb.minHeight };
	} catch { scrollbar = { error: "pseudo-style-unavailable" }; }
	const environment = {
		userAgent: win.navigator.userAgent,
		devicePixelRatio: win.devicePixelRatio,
		viewport: { width: win.innerWidth, height: win.innerHeight, scale: win.visualViewport?.scale ?? null },
		versions: typeof process === "undefined" ? {} : Object.fromEntries(["electron", "chrome"].map(name => [name, process.versions?.[name] ?? null])),
	};
	const listen = (target, type, fn) => {
		target.addEventListener(type, fn, { capture: true, passive: true });
		removers.push(() => target.removeEventListener(type, fn, { capture: true }));
	};
	const onPointer = event => {
		const kind = nodeKind(event.target);
		if (event.type === "pointerdown") dragging = kind === "messages" || kind === "message-descendant";
		const within = event.clientX >= initialRect.left && event.clientX <= initialRect.right && event.clientY >= initialRect.top && event.clientY <= initialRect.bottom;
		if (dragging || (within && event.buttons !== 0)) {
			// No geometry/style reads on pointermove: forcing layout can mask the bug.
			if (event.type !== "pointermove" || elapsed() - lastMove >= 50) {
				if (event.type === "pointermove") lastMove = elapsed();
				add({ type: event.type, target: kind, x: rounded(event.clientX), y: rounded(event.clientY), buttons: event.buttons, trusted: event.isTrusted });
			}
		}
		if (event.type === "pointerup" || event.type === "pointercancel") dragging = false;
	};
	function stop(reason = "manual") {
		if (result !== undefined) return result;
		cleanupBindings();
		try {
			result = JSON.stringify({
				schema: "piem-scroll-probe-1", reason, durationMs: elapsed(), environment,
				targetConnected: scroller.isConnected,
				scrollbar, initial, beforeLatest, final: snapshot(),
				observedEvents: observed, omittedEvents: observed - events.length,
				mutationRecords: mutations, resizeNotifications: resizes, boundaries, events,
			}, null, 2);
		} finally { releaseNodes(); }
		console.log("Piem scroll report / Piem 滚动诊断报告\n" + result);
		return result;
	}
	function cleanupBindings() {
		for (const remove of removers) {
			try { remove(); } catch { /* Continue releasing the other resources. */ }
		}
		removers.length = 0;
		mutationObserver?.disconnect();
		resizeObserver?.disconnect();
		mutationObserver = null;
		resizeObserver = null;
		win.clearTimeout(deadline);
		win.clearTimeout(latestDeadline);
	}
	function releaseNodes() {
		nodes.length = 0;
		scroller = null;
		doc = null;
		win = null;
	}
	try {
		for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel"]) listen(doc, type, onPointer);
		listen(doc, "scroll", event => {
			if (nodes.includes(event.target)) add({ type: "scroll", target: nodeKind(event.target), top: rounded(event.target.scrollTop) });
		});
		listen(scroller, "wheel", event => add({ type: "wheel", dx: event.deltaX, dy: event.deltaY, mode: event.deltaMode, trusted: event.isTrusted }));
		listen(scroller, "keydown", event => {
			if (event.target === scroller && ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) add({ type: "scroll-key", key: event.key });
		});
		mutationObserver = new win.MutationObserver(records => {
			mutations += records.length;
			if (!scroller.isConnected) stop("target-detached");
		});
		mutationObserver.observe(scroller, { childList: true, subtree: true, characterData: true });
		resizeObserver = new win.ResizeObserver(() => { resizes++; });
		for (const el of nodes.slice(0, 4)) resizeObserver.observe(el);
		listen(doc, "click", event => {
			const button = event.target?.closest?.(".piem-chat__latest");
			if (!button || button.parentElement !== scroller.parentElement || beforeLatest) return;
			// The click boundary is the one full measurement before the known-good
			// programmatic path. Merely observing it may trigger a browser relayout.
			beforeLatest = snapshot();
			add({ type: "latest-click", trusted: event.isTrusted });
			latestDeadline = win.setTimeout(() => stop("latest-timeout"), 2000);
		});
		listen(scroller, "scrollend", event => { if (event.target === scroller && beforeLatest) stop("latest-scrollend"); });
		deadline = win.setTimeout(() => stop("timeout"), 60_000);
		scope.piemScrollProbe = Object.freeze({ kind: "piem-scroll-probe", stop: () => stop("manual") });
	} catch {
		cleanupBindings();
		releaseNodes();
		throw new Error("probe-start-failed: diagnostic listeners removed. / 诊断启动失败，已移除监听。");
	}
	console.log("请拖动滑块两次，再点‘最新’。60 秒后自动停止。 / Drag twice, then select Latest. Stops after 60 seconds.");
	return scope.piemScrollProbe;
})();
