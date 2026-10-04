import { expect, it } from "bun:test";
import { MemoryStorage } from "@earendil-works/pi-durable/storage/memory";
import { PiemSession } from "./PiemSession";

it("retains all branches, labels and UUID identities through a durable import", async () => {
	const metadata = { id: "chat", createdAt: 1, storageVersion: 1 };
	const session = await PiemSession.open(new MemoryStorage(), metadata);
	const first = await session.appendMessage("First");
	const old = await session.appendMessage("Old answer");
	await session.setLabel(old, "bookmark");
	await session.createLane("alternative", first);
	const alternative = await session.appendMessage("Alternative", "alternative");
	await session.setName("A chat");
	const restored = await PiemSession.open(new MemoryStorage(), metadata);
	await restored.restoreLog(await session.getLog(), await session.getLanes());
	expect((await restored.view().findEntries()).map(entry => entry.id)).toEqual([first, old]);
	expect((await restored.view("alternative").findEntries()).map(entry => entry.id)).toEqual([first, alternative]);
	expect(await restored.getLabel(old)).toBe("bookmark");
	expect(await restored.getName()).toBe("A chat");
	await session.close();
	await restored.close();
});
