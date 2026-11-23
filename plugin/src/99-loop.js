
// ---------------------------------------------------------------------------
// message loop
// ---------------------------------------------------------------------------

figma.ui.onmessage = async function (msg) {
  if (msg && msg.type === 'resize') {
    figma.ui.resize(Math.max(160, Math.min(480, msg.width || 300)), Math.max(32, Math.min(640, Math.ceil(msg.height))));
    return;
  }
  if (msg && msg.type === 'set-minimized') {
    figma.clientStorage.setAsync('minimized', !!msg.minimized).catch(function () {});
    return;
  }
  if (!msg || msg.type !== 'request') return;
  var res = { type: 'response', id: msg.id, cmd: msg.cmd, port: msg.port };
  try {
    var handler = H[msg.cmd];
    if (!handler) throw new Error('Unknown command: ' + msg.cmd);
    res.result = await handler(msg.params || {});
    res.ok = true;
  } catch (e) {
    res.ok = false;
    res.error = (e && e.message) ? e.message : String(e);
  }
  figma.ui.postMessage(res);
};
