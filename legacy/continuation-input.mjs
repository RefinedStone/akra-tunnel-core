// Uses the native composer and its plugin picker; never fabricates mention HTML.
export async function sendContinuationInput({ read, insertText, assertActive, focus = () => {}, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }, { prompt, plugins }) {
  let clickAttempted = false;
  const check = result => { if (result?.error) throw new Error(result.error); return result; };
  try {
    assertActive(); await focus(); assertActive(); check(await read("focus"));
    const selected = [];
    for (const plugin of plugins) {
      assertActive();
      const query = "@" + plugin.name;
      // Mention menus open on the trigger input, before their search text.
      // Pasting the entire query can leave an ordinary, unselected @name.
      await insertText("@");
      await wait(250);
      assertActive(); await insertText(plugin.name);
      let picked = false;
      for (let i = 0; i < 40; i++) {
        assertActive();
        const result = await read("select_plugin", { query, plugin, plugins: selected });
        if (result.selected) { picked = true; break; }
        if (result.error !== "PLUGIN_SELECTION_UNAVAILABLE") check(result);
        await wait(250);
      }
      if (!picked) throw new Error("PLUGIN_SELECTION_UNAVAILABLE");
      selected.push(plugin);
      let confirmed = false;
      for (let i = 0; i < 12; i++) {
        assertActive();
        const state = check(await read("plugin_state"));
        if (!state.draftText && state.selectedPlugins.length === selected.length && selected.every(p => state.selectedPlugins.some(q => p.appId === q.appId && p.name === q.name))) { confirmed = true; break; }
        await wait(100);
      }
      if (!confirmed) throw new Error("PLUGIN_CONTEXT_MISSING");
      check(await read("focus_append", { plugins: selected }));
    }
    assertActive(); await insertText(prompt);
    assertActive();
    // Once this call starts, a timeout may hide a successful click. Never replay it.
    clickAttempted = true;
    const result = await read("send", { prompt, plugins });
    if (result.error) { clickAttempted = false; check(result); }
    if (!result.clicked) throw new Error("SEND_UNCONFIRMED");
  } catch (error) {
    if (!clickAttempted) error.beforeSend = true;
    throw error;
  }
}
