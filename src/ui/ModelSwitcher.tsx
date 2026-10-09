import React from "react";
import { Menu } from "obsidian";
import { IconButton, ObsidianIcon } from "./ObsidianIcon";
import { activeModelName, modelChoiceLabel, modelSwitcherTitle, type ModelTarget } from "./modelSwitcherCopy";
import type { CodemodeSessionMode } from "../codemode/mode";
import { useT } from "./TranslatorContext";

interface ModelSwitcherProps {
	/** The target in force and the configured models available to switch to. */
	target: ModelTarget;
	/** Switches to a configured model by its `ModelConfig.id`. */
	onSelect: (modelId: string) => void;
	/** The vault-wide `codemode` answer, checked on its row in the group above the models. */
	toolMode: CodemodeSessionMode;
	/** Sets the vault-wide `codemode` answer. One writer: `setCodemodeMode`. */
	onSelectToolMode: (mode: CodemodeSessionMode) => void;
	/**
	 * Opens the plugin's settings tab. Absent when the host cannot reach it, in
	 * which case the menu drops the item — the same treatment {@link ChatHeader}
	 * gives its own settings entry.
	 */
	onOpenSettings?: () => void;
}

/**
 * Which model answers, at the left of the send row.
 *
 * The panel used to print the model in the header, where it could be read and
 * not acted on: changing it meant leaving the chat, finding **Settings → Piem**,
 * and moving a dropdown two tabs in — for the one setting a user revisits
 * mid-conversation more than any other. The readout and the control are the same
 * thing now, and the header row it cost is gone.
 *
 * Left of Send, not right of it. Send is the row's terminal action and lives in
 * the corner every send button lives in; the switcher qualifies the message
 * *about* to be sent, so it reads before it — the same order as the context chips
 * above, which also say what the next turn will carry.
 *
 * An Obsidian `Menu` rather than a `<select>`. The list needs a check on the
 * active row, a separator, and an action that leaves the list entirely, none of
 * which an `<option>` can be; and the menu arrives themed, dismissable, and
 * keyboard-navigable rather than reimplemented here.
 *
 * Usable mid-turn (issue #252). The choice is deferred — settings write through
 * at once, the run in flight keeps the model it started on, and the service
 * applies the new one when the run lands — so switching never moves a run's
 * remaining turns onto a different model halfway through. The face shows the
 * chosen model (the intent); the title notes when it is still pending, keyed off
 * the gap between the settings target and {@link ModelTarget.runningModelId}.
 *
 * "Tool mode" sits above the models. It is the same decision as the Extensions
 * tab's dropdown and `/codemode`, on the control a user already has open — and
 * it is why the button no longer greys out when no model is configured: the
 * group makes the popover live in every state, so the one dead line that
 * justified disabling is gone.
 */
export function ModelSwitcher({ target, onSelect, toolMode, onSelectToolMode, onOpenSettings }: ModelSwitcherProps): React.JSX.Element {
	const t = useT();
	const choices = target.modelChoices;

	/**
	 * The menu.
	 *
	 * "Manage models" is unconditional — with models configured it is how a user
	 * adds the next one, and with none it is the only thing the switcher can
	 * usefully do, which is why the empty case still opens rather than going
	 * silent. The label above it exists so that case reads as "you have not set
	 * one up" instead of as an empty list.
	 */
	const openMenu = (event: React.MouseEvent<HTMLButtonElement>): void => {
		const menu = new Menu();
		if (choices.length === 0) {
			menu.addItem((item) => item.setTitle(t.t("modelSwitcher.noModels")).setIsLabel(true));
		}
		for (const choice of choices) {
			menu.addItem((item) =>
				item
					.setIcon(choice.icon)
					.setTitle(modelChoiceLabel(choice, t))
					// The check is what marks the active row, so the label must not say
					// "active" as well — the Models tab's own rows do, and repeating it
					// here would make the checked row read as a different kind of entry.
					.setChecked(choice.id === target.activeModelId)
					.onClick(() => onSelect(choice.id)),
			);
		}
		menu.addSeparator();
		menu.addItem((item) => {
			item.setTitle(t.t("toolMode.heading")).setIcon("wrench");
			if (typeof item.setSubmenu === "function") {
				const submenu = item.setSubmenu();
				for (const mode of ["only", "on", "off"] as const) {
					submenu.addItem((subItem) =>
						subItem
							.setTitle(t.t(`toolMode.${mode}`))
							.setChecked(mode === toolMode)
							.onClick(() => onSelectToolMode(mode)),
					);
				}
				if (onOpenSettings) {
					submenu.addSeparator();
					submenu.addItem((subItem) =>
						subItem
							.setTitle(t.t("toolMode.settings"))
							.setIcon("settings")
							.onClick(onOpenSettings),
					);
				}
			} else if (onOpenSettings) {
				item.onClick(onOpenSettings);
			}
		});
		if (onOpenSettings) {
			menu.addSeparator();
			menu.addItem((item) => item.setTitle(t.t("modelSwitcher.manageModels")).setIcon("settings").onClick(onOpenSettings));
		}
		/*
		 * Anchored to the button, not to the pointer.
		 *
		 * `showAtMouseEvent` would be the shorter call, but a button activated with
		 * Enter or Space dispatches a click whose coordinates are `0, 0`, which
		 * puts the menu in the window's top-left corner — far from the control and
		 * off the panel entirely. The button's own top edge is where the menu
		 * belongs either way, and Obsidian flips it above the point when there is
		 * no room below, which at the bottom of a sidebar there never is.
		 */
		const rect = event.currentTarget.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.top });
	};

	return (
		<IconButton
			icon="chevrons-up-down"
			label={modelSwitcherTitle(target, t)}
			className="piem-chat__model-switcher"
			hasPopup="menu"
			onClick={openMenu}
		>
			{/*
			 * Hidden from assistive tech: the accessible name above already carries
			 * the model and its endpoint, so reading this too would repeat the
			 * first third of it.
			 */}
			{target.modelIcon !== undefined && (
				<ObsidianIcon name={target.modelIcon} className="piem-chat__model-switcher-mark" />
			)}
			<span className="piem-chat__model-switcher-name" aria-hidden="true">
				{activeModelName(target)}
			</span>
		</IconButton>
	);
}
