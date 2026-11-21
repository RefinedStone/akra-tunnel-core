const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const isId = (value) => typeof value === "string" && uuid.test(value);
const fields = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
const role = (message) => fields(message?.author)?.role;
function selectedMessages(mapping, currentId) {
    const current = fields(fields(mapping[currentId])?.message);
    if (current?.id !== currentId)
        return null;
    let key = currentId;
    let user;
    const seen = new Set();
    while (typeof key === "string" && Object.hasOwn(mapping, key) && !seen.has(key)) {
        seen.add(key);
        const node = fields(mapping[key]);
        if (!node || (node.id !== undefined && node.id !== key))
            return null;
        const message = fields(node.message);
        if (node.message != null && (!message || message.id !== key))
            return null;
        if (!user && role(message) === "user")
            user = message;
        if (node.parent === null)
            return { current, user };
        key = node.parent;
    }
    return null;
}
function linearMessages(entries, currentId) {
    if (!Array.isArray(entries))
        return null;
    const messages = entries.map(entry => fields(fields(entry)?.message ?? entry));
    const current = messages.find(message => message?.id === currentId);
    const user = messages.filter(message => role(message) === "user").at(-1);
    if (!current || !user || messages.indexOf(user) >= messages.indexOf(current) ||
        messages.filter(message => message?.id === currentId).length !== 1 ||
        messages.filter(message => message?.id === user.id).length !== 1)
        return null;
    return { current, user };
}
/** Decode an already received snapshot. Conversation-wide streaming alone cannot identify an active turn. */
export function readCloudTurnState(input, conversationId) {
    const data = fields(input);
    if (!isId(conversationId) || data?.conversation_id !== conversationId || !isId(data.current_node))
        return null;
    const mapping = fields(data.mapping);
    const pair = Object.hasOwn(data, "mapping")
        ? mapping && selectedMessages(mapping, data.current_node)
        : linearMessages(data.messages, data.current_node);
    if (!pair || !isId(pair.user?.id) || role(pair.current) !== "assistant")
        return null;
    const { current } = pair;
    const ids = { turnId: pair.user.id, responseId: data.current_node };
    const metadata = fields(current.metadata);
    if (metadata?.clientOnlyMessage != null)
        return null;
    const finish = fields(metadata?.finish_details)?.type;
    const contentType = fields(current.content)?.content_type;
    const error = metadata?.is_error === true || contentType === "error" || contentType === "system_error";
    const cancelled = metadata?.reasoning_status === "reasoning_cancelled";
    // 3 is STREAMING. Require the current assistant and its selected user ancestor too.
    if (data.async_status === 3) {
        if (!mapping || current.status !== "in_progress" || current.end_turn !== false ||
            metadata?.finish_details != null || error || cancelled)
            return null;
        return { ...ids, phase: "running" };
    }
    if (data.async_status !== null)
        return null;
    const finished = current.status === "finished_successfully";
    const partial = current.status === "finished_partial_completion" && current.channel === "final";
    if ((!finished && !partial) || current.end_turn !== true || (current.channel ?? "final") !== "final" ||
        (current.recipient ?? "all") !== "all")
        return null;
    if (finish === "interrupted")
        return { ...ids, phase: "stopped" };
    if (error)
        return { ...ids, phase: "failed" };
    if (finished && !cancelled && (metadata?.finish_details == null || finish === "stop"))
        return { ...ids, phase: "complete" };
    return null;
}
