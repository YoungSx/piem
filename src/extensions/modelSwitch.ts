import { clampThinkingLevel, type Model } from "@earendil-works/pi-ai";
import type { Agent, ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { SessionRuntime } from "../agent/SessionRuntime";
import type { ObsidianSessionManager } from "../session/ObsidianSessionManager";
import type { PiemSettings } from "../settings";
import { configuredModels } from "./configuredModels";

interface ModelSwitchOwner {
	runtime: SessionRuntime;
	agent: Agent;
	isCurrent(): boolean;
	refresh(): Promise<void>;
	thinkingLevelChanged(previousLevel: ThinkingLevel, level: ThinkingLevel): Promise<void>;
}
interface ModelSwitchSource {
	getSettings(): PiemSettings;
	sessions: ObsidianSessionManager;
	persistSettings(options: { reconfigure: false }): Promise<void>;
	notify(): void;
	reportFailure(error: unknown): void;
}

/** Serializes shared preferences while each mutation stays on its captured session. */
export class ExtensionModelSwitch {
	private tail: Promise<unknown> = Promise.resolve();
	constructor(private readonly source: ModelSwitchSource) {}
	/** Capture the caller before joining the shared settings-write queue. */
	switch(owner: ModelSwitchOwner, requested: Pick<Model<string>, "provider" | "id">): Promise<boolean> {
		const { runtime: rt, agent } = owner;
		const epoch = rt.stopEpoch;
		let thinkingChange: { previousLevel: ThinkingLevel; level: ThinkingLevel } | undefined;
		const task = this.tail.then(async () => {
			const ownsSession = () => !rt.bookmarkClosing && owner.isCurrent() && rt.agent === agent;
			const assertOwner = () => {
				if (!ownsSession() || rt.stopEpoch !== epoch) throw new Error("Extension session is no longer available.");
			};
			assertOwner();
			const settings = this.source.getSettings();
			const choice = configuredModels(settings).find(item => item.model.provider === requested.provider && item.model.id === requested.id);
			if (!choice) return false;
			const previous = settings.activeModelId;
			const oldModel = agent.state.model;
			const oldThinking = agent.state.thinkingLevel;
			const nextThinking = clampThinkingLevel(choice.model, oldThinking);
			const release = this.source.sessions.claimOperation(rt.sessionPath);
			rt.sessionOperations += 1;
			try {
				settings.activeModelId = choice.choiceId;
				await this.source.persistSettings({ reconfigure: false });
				assertOwner();
				if (settings.activeModelId !== choice.choiceId) return false;
				await this.source.sessions.ensureConfigurationFor(rt.sessionPath, { provider: choice.model.provider, modelId: choice.model.id }, rt.activeLane);
				assertOwner();
				if (nextThinking !== oldThinking) await this.source.sessions.appendThinkingLevelChangeFor(rt.sessionPath, nextThinking, rt.activeLane);
				assertOwner();
				agent.state.model = choice.model;
				agent.state.thinkingLevel = nextThinking;
				await owner.refresh();
				assertOwner();
				this.source.notify();
				if (oldThinking !== nextThinking) thinkingChange = { previousLevel: oldThinking, level: nextThinking };
				return true;
			} catch (error) {
				// A replaced/unloaded plugin must never start another settings write.
				// An already-started write may finish; its new owner reads that result.
				if (!ownsSession()) throw error;
				agent.state.model = oldModel;
				agent.state.thinkingLevel = oldThinking;
				if (settings.activeModelId === choice.choiceId) {
					settings.activeModelId = previous;
					try { await this.source.persistSettings({ reconfigure: false }); }
					catch (rollbackError) { this.source.reportFailure(rollbackError); }
				}
				if (ownsSession() && this.source.sessions.isLoaded(rt.sessionPath)) {
					await this.source.sessions.ensureConfigurationFor(rt.sessionPath, { provider: oldModel.provider, modelId: oldModel.id }, rt.activeLane);
					if (ownsSession() && nextThinking !== oldThinking) await this.source.sessions.appendThinkingLevelChangeFor(rt.sessionPath, oldThinking, rt.activeLane);
				}
				throw error;
			} finally { rt.sessionOperations -= 1; release(); }
		});
		this.tail = task.catch(() => undefined);
		return task.then(async switched => {
			// Release the settings queue first: an observer may switch models too.
			if (switched && thinkingChange) await owner.thinkingLevelChanged(thinkingChange.previousLevel, thinkingChange.level);
			return switched;
		});
	}
}
