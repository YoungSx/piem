import type { Menu } from "obsidian";

declare module "obsidian" {
	interface MenuItem {
		setSubmenu(): Menu;
	}
}
