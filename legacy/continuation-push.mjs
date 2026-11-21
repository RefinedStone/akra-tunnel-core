// Reads frames that the signed-in discovery page already received on its own
// WebSocket. Only event type names, conversation IDs and a key-only shape leave
// this function; message text, tokens and other values never do.
export const PUSH_FRAME_MAX_BYTES = 64 * 1024;
const MAX_IDS = 3, MAX_DEPTH = 6, SHAPE_DEPTH = 3, SHAPE_MAX = 200;
const conversationId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const typeName = /^[\w.:/-]{1,64}$/;
// The real frame format is unverified; both spellings are accepted.
const ID_KEYS = new Set(["conversation_id", "conversationId"]);
/** Returns null for frames that are too large or not JSON. */
export function readPushFrame(text) {
    if (typeof text !== "string" || Buffer.byteLength(text) > PUSH_FRAME_MAX_BYTES)
        return null;
    const root = parse(text);
    if (!root || typeof root !== "object")
        return null;
    const ids = new Set();
    collect(root, 0, ids);
    const type = Array.isArray(root) ? undefined : root.type;
    return { type: typeof type === "string" && typeName.test(type) ? type : null, conversationIds: [...ids], shape: shapeOf(root, 0).slice(0, SHAPE_MAX) };
}
function parse(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return null;
    }
}
function collect(value, depth, ids) {
    if (ids.size >= MAX_IDS || depth > MAX_DEPTH || !value)
        return;
    // Some push envelopes carry the event as a JSON string.
    if (typeof value === "string") {
        if (value.startsWith("{") || value.startsWith("["))
            collect(parse(value), depth + 1, ids);
        return;
    }
    if (typeof value !== "object")
        return;
    for (const [key, child] of Object.entries(value)) {
        if (ids.size >= MAX_IDS)
            return;
        if (ID_KEYS.has(key) && typeof child === "string" && conversationId.test(child))
            ids.add(child.toLowerCase());
        else
            collect(child, depth + 1, ids);
    }
}
// Key names only, for learning the unverified frame format. Keys that are not plain
// identifiers (IDs, numbers) become "#"; values become their kind, never their content.
function shapeOf(value, depth) {
    if (typeof value === "string")
        return value.startsWith("{") || value.startsWith("[") ? (parse(value) ? "json" : "str") : "str";
    if (value === null || typeof value !== "object")
        return typeof value === "number" ? "num" : typeof value === "boolean" ? "bool" : "null";
    if (depth >= SHAPE_DEPTH)
        return Array.isArray(value) ? "[..]" : "{..}";
    if (Array.isArray(value))
        return "[" + (value.length ? shapeOf(value[0], depth + 1) : "") + "]";
    const fields = new Map();
    for (const [key, child] of Object.entries(value).slice(0, 12)) {
        // An 8+ hex run marks a UUID or hash even when it starts with a letter (a-f).
        const name = /^[A-Za-z_][\w.-]{0,39}$/.test(key) && !/[0-9a-f]{8}/i.test(key) ? key : "#";
        if (!fields.has(name))
            fields.set(name, child);
    }
    return "{" + [...fields].sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) => name + ":" + shapeOf(child, depth + 1)).join(",") + "}";
}
