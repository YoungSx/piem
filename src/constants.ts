export const PLUGIN_ID = "piem";
export const VIEW_TYPE_PIEM_CHAT = `${PLUGIN_ID}-chat-view`;
export const VIEW_TYPE_PIEM_LOGS = `${PLUGIN_ID}-logs-view`;
export const VIEW_TYPE_PIEM_SUBAGENTS = `${PLUGIN_ID}-subagents-view`;
export const DEFAULT_PROVIDER = "deepseek";
export const DEFAULT_MODEL_ID = "deepseek-v4-pro";
/**
 * The thinking level a brand-new session starts on when nothing better is
 * known. The level belongs to the conversation (the composer's thinking
 * selector writes it into the session file); this only covers a first-ever
 * session and a vault whose previous session recorded none.
 */
export const DEFAULT_THINKING_LEVEL = "off";
/**
 * Where the plugin's own source, tracker, and licence live.
 *
 * Spelled out rather than derived from a single base URL: GitHub's paths for
 * issues and blobs are its own conventions, and building them by concatenation
 * would break silently if any of them ever moves.
 */
export const REPOSITORY_URL = "https://github.com/YoungSx/piem";
export const ISSUES_URL = "https://github.com/YoungSx/piem/issues";
export const LICENSE_URL = "https://github.com/YoungSx/piem/blob/master/LICENSE";

/** Where the author's coffee money goes. */
export const KO_FI_URL = "https://ko-fi.com/shangxin";
