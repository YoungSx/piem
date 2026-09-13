/** Static community imports use the host's completion channel, never a provider SDK. */
export { completeExtensionModel as complete } from "../extensionModelAuth";
export type { Api, AssistantMessage, Context, Model, ProviderStreamOptions } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { TUnsafe } from "typebox";

/**
 * The one pi-ai export this host takes from typebox instead: the upstream
 * helper is a `Type.Unsafe` string-enum schema, so the compat surface needs
 * only the same shape (see pi-ai's utils/typebox-helpers).
 */
export const StringEnum = <T extends readonly string[]>(
	values: T,
	options?: { description?: string; default?: T[number] },
): TUnsafe<T[number]> =>
	Type.Unsafe<T[number]>({ type: "string", enum: values, ...options });
