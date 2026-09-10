/** Static community imports use the host's completion channel, never a provider SDK. */
export { completeExtensionModel as complete } from "../extensionModelAuth";
export type { Api, AssistantMessage, Context, Model, ProviderStreamOptions } from "@earendil-works/pi-ai";
