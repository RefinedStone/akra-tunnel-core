# Akra Tunnel Core

`akra-tunnel-core/chat` is the Node 22+ text-only API. Its Desktop contract is in `chat.d.ts`.

1. Acquire `await acquireHostLease(home)` in the frontend. Pass the same canonical Akra Tunnel home to `ChatSessionService`. A busy frontend must report `chat_host_busy`. Release the lease during shutdown after draining frontend work.
2. Supply `pageFor(requestId)` using a dedicated browser page per request. Return the same page for subsequent calls while it exists. A replacement page must start blank. The frontend owns the partition, navigation and redirect restrictions, account matching for `continue`, login UI, scheduling and user takeover. Keep credentials and account identifiers in the frontend.
3. Wrap the service operations `status`, `submit`, `observe`, `readResult` and `stop`. Poll `observe` after submission to confirm delivery and collect the final response. A submitted request ID is reserved durably even if it never clicks. A lost click response is `send_uncertain`. Use `observe` on that ID to reconcile it.

`PagePort.evaluate` serializes a self-contained function and its argument and runs it in the page. A frontend must enforce navigation and takeover checks on browser mutations, including mutations submitted to a renderer but not yet executed. `assertActive` can additionally fail closed between calls. Use finite frontend deadlines for port operations. A timeout from an in-flight send must not be treated as proof that the click did not happen.

Recovery loads the same conversation URL at most `maxResumes` times, persisted per request. It never submits a second message. New and temporary jobs have no reopenable URL until a durable conversation is observed. Temporary jobs are kept in the original frontend page.

The `legacy` entry is the private launcher's continuation integration. It does not register any local machine tools. Text jobs should use the `chat` entry only. The launcher must supply its own synchronous `runtime.usedTunnelApp(conversation, appIds)` classifier. The host passes parsed conversation data to the classifier locally and uses its boolean result for enrollment.

Install the release from Git and commit the resolved lockfile:

```sh
npm install "git+https://github.com/RefinedStone/akra-tunnel-core.git#v0.1.1"
```

For an immutable dependency specifier, replace `v0.1.1` with the full commit SHA resolved by the tag. For a portable tarball, run `npm pack --ignore-scripts` in a checkout of that commit and install the tarball by its repository-relative path.
