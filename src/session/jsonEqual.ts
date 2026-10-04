/** JSON wire equality: object order is irrelevant; array order and values are not. */
export function jsonEqual(left: unknown, right: unknown): boolean {
	const canonical = (value: unknown): string => JSON.stringify(value, (_key, item: unknown) => {
		if (item === null || typeof item !== "object" || Array.isArray(item)) return item;
		return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
	});
	return canonical(left) === canonical(right);
}
