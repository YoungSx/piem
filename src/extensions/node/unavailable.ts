/** Unsupported platform operations must fail visibly, never pretend to succeed. */
export function unavailable(operation: string): never {
	throw new Error(`The built-in extension host does not support ${operation}.`);
}
