/** Every Piem compaction supplies its configured Models transport explicitly. */
export function completeSimple(): never {
	throw new Error("Compaction requires Piem's configured model transport");
}
