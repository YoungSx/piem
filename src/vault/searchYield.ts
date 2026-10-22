import { throwIfAborted } from "../tools/toolResult";

/** Let Stop and vault events run between bounded batches of synchronous work. */
export async function yieldSearch(signal?: AbortSignal): Promise<void> {
	throwIfAborted(signal);
	await new Promise<void>((resolve, reject) => {
		const finish = (): void => {
			signal?.removeEventListener("abort", abort);
			resolve();
		};
		const timer = window.setTimeout(finish, 0);
		const abort = (): void => {
			window.clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			reject(new Error("Operation aborted"));
		};
		signal?.addEventListener("abort", abort, { once: true });
	});
	throwIfAborted(signal);
}
