const identities = new WeakMap<object, string>();
let nextIdentity = 0;

/** Environments backed by the same Vault adapter share Pi's file namespace. */
export function fileSystemIdentity(adapter: object): string {
	let id = identities.get(adapter);
	if (!id) { id = `obsidian:${++nextIdentity}`; identities.set(adapter, id); }
	return id;
}
