// Tier 3: prototype interactions (Figma Design) and FigJam board objects.
// Concatenated after 00-core.js; uses core helpers (node, ser, hexPaint, toHex, pageOf, appendTo, round, jsonSafe).
// Plain ES2017 only. Helper names are prefixed `pf` to avoid clashes with other modules.
//
// Units: the Plugin API stores transition durations, AFTER_TIMEOUT timeouts and MOUSE_* delays in SECONDS.
// The MCP tools accept/return milliseconds (durationMs, timeoutMs, delayMs) and convert here.

// ---------------------------------------------------------------------------
// shared helpers
// ---------------------------------------------------------------------------

function pfRequireDesign(tool) {
  var t = figma.editorType;
  if (t !== 'figma' && t !== 'dev') {
    throw new Error(tool + ' only works in Figma Design files (this file is "' + t + '"). Prototyping is not available in FigJam.');
  }
}
function pfRequireDesignWrite(tool) {
  if (figma.editorType !== 'figma') {
    throw new Error(tool + ' only works in Figma Design files in design mode (this file is "' + figma.editorType + '"). Prototyping is not available in FigJam.');
  }
}
function pfRequireFigJam(tool) {
  if (figma.editorType !== 'figjam') {
    throw new Error(tool + ' only works in FigJam files (this file is "' + figma.editorType + '"). In Figma Design use create_frame / create_text / create_shape instead.');
  }
}

function pfRef(n) { return n ? { id: n.id, name: n.name, type: n.type } : null; }
function pfMs(sec) { return typeof sec === 'number' ? Math.round(sec * 1000) : sec; }
function pfSec(ms) { return Number(ms) / 1000; }

// Top-level "screen" of a node: the outermost ancestor whose parent is the page or a section.
function pfScreenOf(n) {
  if (!n || n.type === 'PAGE' || n.type === 'DOCUMENT') return null;
  var cur = n;
  while (cur.parent && cur.parent.type !== 'PAGE' && cur.parent.type !== 'SECTION' && cur.parent.type !== 'DOCUMENT') cur = cur.parent;
  return cur;
}

function pfReactionActions(r) {
  if (r.actions && r.actions.length) return r.actions;
  return r.action ? [r.action] : [];
}

// Caching resolver for nodes / variables / collections referenced by reactions.
function pfResolver() {
  var nodeCache = {}, varCache = {}, colCache = {};
  var R = {
    node: async function (id) {
      if (!id) return null;
      if (!(id in nodeCache)) {
        var n = null;
        try { n = await figma.getNodeByIdAsync(id); } catch (e) { n = null; }
        nodeCache[id] = n;
      }
      return nodeCache[id];
    },
    dest: async function (id) {
      if (!id) return null;
      var n = await R.node(id);
      if (!n) return { id: id, missing: true };
      var screen = pfScreenOf(n);
      var page = pageOf(n);
      return { id: n.id, name: n.name, type: n.type, screen: pfRef(screen), page: page ? { id: page.id, name: page.name } : null };
    },
    variable: async function (id) {
      if (!id) return null;
      if (!(id in varCache)) {
        var v = null;
        try { v = await figma.variables.getVariableByIdAsync(id); } catch (e) { v = null; }
        var out = { id: id };
        if (v) {
          out.name = v.name;
          out.resolvedType = v.resolvedType;
          var c = await R.collection(v.variableCollectionId);
          if (c) out.collection = c.name;
        } else out.missing = true;
        varCache[id] = out;
      }
      return varCache[id];
    },
    collection: async function (id) {
      if (!id) return null;
      if (!(id in colCache)) {
        var c = null;
        try { c = await figma.variables.getVariableCollectionByIdAsync(id); } catch (e) { c = null; }
        colCache[id] = c;
      }
      return colCache[id];
    },
  };
  return R;
}

function pfFmtTrigger(t) {
  if (!t) return null;
  var o = jsonSafe(t);
  if (typeof t.timeout === 'number') o.timeoutMs = pfMs(t.timeout);
  if (typeof t.delay === 'number') o.delayMs = pfMs(t.delay);
  return o;
}

function pfFmtTransition(t) {
  if (!t) return null;
  var o = { type: t.type, durationMs: pfMs(t.duration) };
  if (t.easing) {
    o.easing = t.easing.type;
    if (t.easing.easingFunctionCubicBezier) o.bezier = jsonSafe(t.easing.easingFunctionCubicBezier);
    if (t.easing.easingFunctionSpring) o.spring = jsonSafe(t.easing.easingFunctionSpring);
  }
  if (t.direction) o.direction = t.direction;
  if (t.matchLayers !== undefined) o.matchLayers = t.matchLayers;
  return o;
}

async function pfFmtVarData(d, R) {
  if (!d) return null;
  var v = d.value;
  if (d.type === 'VARIABLE_ALIAS' || (v && typeof v === 'object' && v.type === 'VARIABLE_ALIAS')) {
    return { variable: await R.variable(v && v.id) };
  }
  if (d.type === 'EXPRESSION' || (v && typeof v === 'object' && v.expressionFunction)) {
    var args = [];
    var raw = (v && v.expressionArguments) || [];
    for (var i = 0; i < raw.length; i++) args.push(await pfFmtVarData(raw[i], R));
    return { expression: v.expressionFunction, args: args };
  }
  if (v && typeof v === 'object' && 'r' in v && 'g' in v) return toHex(v, v.a);
  return jsonSafe(v);
}

async function pfFmtAction(a, R) {
  if (!a) return null;
  var o;
  if (a.type === 'NODE') {
    o = { type: 'NODE', navigation: a.navigation, destination: await R.dest(a.destinationId), transition: pfFmtTransition(a.transition) };
    if (a.overlayRelativePosition) o.overlayRelativePosition = jsonSafe(a.overlayRelativePosition);
    if (a.resetScrollPosition !== undefined) o.resetScrollPosition = a.resetScrollPosition;
    if (a.resetVideoPosition !== undefined) o.resetVideoPosition = a.resetVideoPosition;
    if (a.resetInteractiveComponents !== undefined) o.resetInteractiveComponents = a.resetInteractiveComponents;
    return o;
  }
  if (a.type === 'CONDITIONAL') {
    var blocks = [];
    var cb = a.conditionalBlocks || [];
    for (var i = 0; i < cb.length; i++) {
      var acts = [];
      for (var j = 0; j < (cb[i].actions || []).length; j++) acts.push(await pfFmtAction(cb[i].actions[j], R));
      blocks.push({ condition: cb[i].condition ? await pfFmtVarData(cb[i].condition, R) : null, isElse: !cb[i].condition, actions: acts });
    }
    return { type: 'CONDITIONAL', blocks: blocks };
  }
  if (a.type === 'SET_VARIABLE') {
    return { type: 'SET_VARIABLE', variable: await R.variable(a.variableId), value: await pfFmtVarData(a.variableValue, R) };
  }
  if (a.type === 'SET_VARIABLE_MODE') {
    var col = await R.collection(a.variableCollectionId);
    var mode = null;
    if (col) mode = col.modes.filter(function (m) { return m.modeId === a.variableModeId; })[0] || null;
    return {
      type: 'SET_VARIABLE_MODE',
      collection: col ? { id: col.id, name: col.name } : { id: a.variableCollectionId, missing: true },
      mode: mode ? { id: mode.modeId, name: mode.name } : { id: a.variableModeId },
    };
  }
  o = jsonSafe(a);
  if (a.type === 'UPDATE_MEDIA_RUNTIME' && a.destinationId) o.destination = await R.dest(a.destinationId);
  return o;
}

async function pfFmtReactions(n, R) {
  var rs = n.reactions || [];
  var out = [];
  for (var i = 0; i < rs.length; i++) {
    var acts = pfReactionActions(rs[i]);
    var fa = [];
    for (var j = 0; j < acts.length; j++) fa.push(await pfFmtAction(acts[j], R));
    out.push({ trigger: pfFmtTrigger(rs[i].trigger), actions: fa });
  }
  return out;
}

function pfReadReactions(n) {
  try { return ('reactions' in n) ? (n.reactions || []) : null; } catch (e) { return null; }
}

// Depth-first walk (including instance sublayers). visit(n) is called for each node until `max` nodes were visited.
// Returns { visited, truncated }.
async function pfWalk(root, max, visit) {
  var stack = [root];
  var visited = 0;
  while (stack.length) {
    if (visited >= max) return { visited: visited, truncated: true };
    var n = stack.pop();
    visited++;
    await visit(n);
    if ('children' in n && n.children) {
      for (var i = n.children.length - 1; i >= 0; i--) stack.push(n.children[i]);
    }
  }
  return { visited: visited, truncated: false };
}

async function pfFlowStarts(page, R) {
  var fsp = [];
  try { fsp = page.flowStartingPoints || []; } catch (e) { fsp = []; }
  var out = [];
  for (var i = 0; i < fsp.length; i++) {
    var n = await R.node(fsp[i].nodeId);
    out.push({ name: fsp[i].name, nodeId: fsp[i].nodeId, nodeName: n ? n.name : null, missing: !n || undefined, isDefault: i === 0 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// prototype: read
// ---------------------------------------------------------------------------

H.get_prototype_connections = async function (p) {
  pfRequireDesign('get_prototype_connections');
  var root = p.nodeId ? await node(p.nodeId) : figma.currentPage;
  if (root.type === 'DOCUMENT') throw new Error('Pass a page or node id, not the document');
  var page = root.type === 'PAGE' ? root : pageOf(root);
  if (root.type === 'PAGE') await root.loadAsync();
  var max = p.maxNodes || 5000;
  var R = pfResolver();
  var connections = [];
  var walk = await pfWalk(root, max, async function (n) {
    if (n.type === 'PAGE') return;
    var rs = pfReadReactions(n);
    if (rs === null) return;
    if (!rs.length && !p.includeEmpty) return;
    connections.push({ node: pfRef(n), screen: pfRef(pfScreenOf(n)), reactions: await pfFmtReactions(n, R) });
  });
  return {
    page: page ? { id: page.id, name: page.name } : null,
    root: pfRef(root),
    flowStartingPoints: page ? await pfFlowStarts(page, R) : [],
    scannedNodes: walk.visited,
    truncated: walk.truncated,
    nodesWithReactions: connections.filter(function (c) { return c.reactions.length; }).length,
    connections: connections,
  };
};

// Collect every action of a node's reactions, flattening CONDITIONAL blocks (conditions listed outermost first).
async function pfFlatActions(n, R) {
  var out = [];
  async function addAll(trigger, acts, conds) {
    for (var i = 0; i < acts.length; i++) {
      var a = acts[i];
      if (!a) continue;
      if (a.type === 'CONDITIONAL') {
        var cb = a.conditionalBlocks || [];
        for (var j = 0; j < cb.length; j++) {
          var c = cb[j].condition ? await pfFmtVarData(cb[j].condition, R) : 'else';
          await addAll(trigger, cb[j].actions || [], conds.concat([c]));
        }
      } else out.push({ trigger: trigger, action: a, conditions: conds });
    }
  }
  var rs = pfReadReactions(n) || [];
  for (var i = 0; i < rs.length; i++) await addAll(pfFmtTrigger(rs[i].trigger), pfReactionActions(rs[i]), []);
  return out;
}

var PF_FOLLOW = { NAVIGATE: true, OVERLAY: true, SWAP: true };

H.trace_prototype_flow = async function (p) {
  pfRequireDesign('trace_prototype_flow');
  var start = await node(p.nodeId);
  var startScreen = pfScreenOf(start);
  if (!startScreen) throw new Error('nodeId must be a screen (top-level frame) or a node inside one, not a page');
  var maxScreens = p.maxScreens || 25;
  var maxNodes = p.maxNodesPerScreen || 2000;
  var R = pfResolver();

  var known = {};       // screen id -> { id, name, depth, reachedFrom }
  var queue = [];
  function enqueue(scr, depth, from) {
    if (known[scr.id]) return;
    var pg = pageOf(scr);
    known[scr.id] = { id: scr.id, name: scr.name, type: scr.type, page: pg ? pg.name : null, depth: depth, reachedFrom: from };
    queue.push(scr);
  }
  enqueue(startScreen, 0, null);

  var screens = [], edges = [], unresolved = [];
  while (queue.length && screens.length < maxScreens) {
    var scr = queue.shift();
    var info = known[scr.id];
    var walk = await pfWalk(scr, maxNodes, async function (n) {
      var flat = await pfFlatActions(n, R);
      for (var i = 0; i < flat.length; i++) {
        var a = flat[i].action;
        var e = { from: { id: scr.id, name: scr.name }, sourceNode: pfRef(n), trigger: flat[i].trigger };
        if (flat[i].conditions.length) { e.conditional = true; e.conditions = flat[i].conditions; }
        if (a.type === 'NODE') {
          e.action = 'NODE';
          e.navigation = a.navigation;
          if (a.transition) e.transition = pfFmtTransition(a.transition);
          if (!a.destinationId) { e.to = null; edges.push(e); continue; }
          var dest = await R.node(a.destinationId);
          if (!dest) {
            unresolved.push({ from: e.from, sourceNode: e.sourceNode, navigation: a.navigation, destinationId: a.destinationId });
            continue;
          }
          var ds = pfScreenOf(dest);
          e.destination = pfRef(dest);
          e.to = ds ? { id: ds.id, name: ds.name } : null;
          if (PF_FOLLOW[a.navigation] && ds) {
            enqueue(ds, info.depth + 1, { screen: scr.id, sourceNode: n.id });
          } else e.followed = false;
          edges.push(e);
        } else if (a.type === 'BACK' || a.type === 'CLOSE' || a.type === 'URL') {
          e.action = a.type;
          if (a.type === 'URL') { e.url = a.url; if (a.openInNewTab !== undefined) e.openInNewTab = a.openInNewTab; }
          e.to = null;
          edges.push(e);
        }
        // SET_VARIABLE / SET_VARIABLE_MODE / media actions are not navigation and are skipped here.
      }
    });
    if (walk.truncated) info.truncated = true;
    info.scannedNodes = walk.visited;
    screens.push(info);
  }
  var pending = queue.map(function (s) { var k = known[s.id]; return { id: k.id, name: k.name, depth: k.depth, reachedFrom: k.reachedFrom }; });
  return {
    start: { node: pfRef(start), screen: pfRef(startScreen) },
    screens: screens,
    edges: edges,
    unresolved: unresolved,
    pending: pending,
    complete: pending.length === 0 && !screens.some(function (s) { return s.truncated; }),
  };
};

// ---------------------------------------------------------------------------
// prototype: write
// ---------------------------------------------------------------------------

function pfBuildTrigger(p) {
  var t = p.trigger || 'ON_CLICK';
  if (t === 'AFTER_TIMEOUT') return { type: t, timeout: pfSec(p.timeoutMs !== undefined ? p.timeoutMs : 800) };
  if (t === 'MOUSE_ENTER' || t === 'MOUSE_LEAVE') return { type: t, delay: pfSec(p.delayMs || 0), deprecatedVersion: false };
  if (t === 'MOUSE_UP' || t === 'MOUSE_DOWN') return { type: t, delay: pfSec(p.delayMs || 0) };
  if (t === 'ON_KEY_DOWN') {
    if (!p.keyCodes || !p.keyCodes.length) throw new Error('ON_KEY_DOWN needs keyCodes');
    return { type: t, device: p.device || 'KEYBOARD', keyCodes: p.keyCodes };
  }
  return { type: t };
}

function pfSameTrigger(a, b) {
  if (!a || !b || a.type !== b.type) return false;
  if (b.any) return true; // clear-mode wildcard (ON_KEY_DOWN without keyCodes)
  if (a.type === 'ON_KEY_DOWN') return JSON.stringify(a.keyCodes || []) === JSON.stringify(b.keyCodes || []) && a.device === b.device;
  return true;
}

function pfBuildTransition(t) {
  if (!t || t.type === 'INSTANT' || t.type === 'NONE') return null;
  var easing = { type: t.easing || 'EASE_OUT' };
  if (easing.type === 'CUSTOM_CUBIC_BEZIER') {
    if (!t.bezier || t.bezier.length !== 4) throw new Error('CUSTOM_CUBIC_BEZIER easing needs bezier [x1,y1,x2,y2]');
    easing.easingFunctionCubicBezier = { x1: t.bezier[0], y1: t.bezier[1], x2: t.bezier[2], y2: t.bezier[3] };
  }
  if (easing.type === 'CUSTOM_SPRING') {
    if (!t.spring) throw new Error('CUSTOM_SPRING easing needs spring {mass, stiffness, damping, initialVelocity}');
    easing.easingFunctionSpring = { mass: t.spring.mass, stiffness: t.spring.stiffness, damping: t.spring.damping, initialVelocity: t.spring.initialVelocity || 0 };
  }
  var out = { type: t.type, easing: easing, duration: pfSec(t.durationMs !== undefined ? t.durationMs : 300) };
  if (['MOVE_IN', 'MOVE_OUT', 'PUSH', 'SLIDE_IN', 'SLIDE_OUT'].indexOf(t.type) >= 0) {
    out.direction = t.direction || 'LEFT';
    out.matchLayers = !!t.matchLayers;
  }
  return out;
}

async function pfBuildAction(p) {
  var kind = p.action;
  if (kind === 'BACK' || kind === 'CLOSE') return { type: kind };
  if (kind === 'URL') {
    if (!p.url) throw new Error('URL action needs url');
    var u = { type: 'URL', url: p.url };
    if (p.openInNewTab !== undefined) u.openInNewTab = p.openInNewTab;
    return u;
  }
  if (['NAVIGATE', 'OVERLAY', 'SWAP', 'SCROLL_TO', 'CHANGE_TO'].indexOf(kind) < 0) throw new Error('Unknown action: ' + kind);
  if (!p.destinationId) throw new Error(kind + ' needs destinationId');
  var dest = await node(p.destinationId);
  var a = { type: 'NODE', destinationId: dest.id, navigation: kind, transition: pfBuildTransition(p.transition) };
  if (p.overlayRelativePosition) a.overlayRelativePosition = { x: p.overlayRelativePosition.x, y: p.overlayRelativePosition.y };
  if (p.resetScrollPosition !== undefined) a.resetScrollPosition = p.resetScrollPosition;
  return a;
}

function pfCloneReactions(n) {
  var rs = JSON.parse(JSON.stringify(n.reactions || []));
  return rs.map(function (r) {
    var o = { trigger: r.trigger, actions: r.actions && r.actions.length ? r.actions : (r.action ? [r.action] : []) };
    return o;
  });
}

H.set_reaction = async function (p) {
  pfRequireDesignWrite('set_reaction');
  var n = await node(p.nodeId);
  if (!('setReactionsAsync' in n)) throw new Error(n.type + ' ' + n.id + ' does not support prototype reactions');
  var mode = p.mode || 'replace';
  var rs = pfCloneReactions(n);
  var before = rs.length;
  if (mode === 'clear') {
    if (p.trigger) {
      var tt = pfBuildTriggerLoose(p);
      rs = rs.filter(function (r) { return !pfSameTrigger(r.trigger, tt); });
    } else rs = [];
  } else {
    var trigger = pfBuildTrigger(p);
    var actions = [];
    if (p.action) actions.push(await pfBuildAction(p));
    if (p.extraActions && p.extraActions.length) actions = actions.concat(p.extraActions);
    if (!actions.length) throw new Error('action (or extraActions) is required unless mode is "clear"');
    if (mode === 'replace') {
      rs = rs.filter(function (r) { return !pfSameTrigger(r.trigger, trigger); });
      rs.push({ trigger: trigger, actions: actions });
    } else if (mode === 'append') {
      var hit = rs.filter(function (r) { return pfSameTrigger(r.trigger, trigger); })[0];
      if (hit) hit.actions = hit.actions.concat(actions);
      else rs.push({ trigger: trigger, actions: actions });
    } else throw new Error('Unknown mode: ' + mode);
  }
  await n.setReactionsAsync(rs);
  return { node: pfRef(n), mode: mode, reactionsBefore: before, reactions: await pfFmtReactions(n, pfResolver()) };
};

// For clear-mode matching only: like pfBuildTrigger but never throws on missing keyCodes.
function pfBuildTriggerLoose(p) {
  if (p.trigger === 'ON_KEY_DOWN' && (!p.keyCodes || !p.keyCodes.length)) return { type: 'ON_KEY_DOWN', any: true };
  return pfBuildTrigger(p);
}

H.set_flow_starting_point = async function (p) {
  pfRequireDesignWrite('set_flow_starting_point');
  var n = await node(p.nodeId);
  var page = p.pageId ? await node(p.pageId) : (pageOf(n) || figma.currentPage);
  if (page.type !== 'PAGE') throw new Error(p.pageId + ' is not a page');
  var np = pageOf(n);
  if (np && np.id !== page.id) throw new Error('Node ' + n.id + ' is on page "' + np.name + '", not "' + page.name + '"');
  var list = (page.flowStartingPoints || []).map(function (f) { return { nodeId: f.nodeId, name: f.name }; });
  var idx = -1;
  for (var i = 0; i < list.length; i++) if (list[i].nodeId === n.id) idx = i;
  var action;
  if (p.remove) {
    if (idx < 0) throw new Error(n.id + ' is not a flow starting point on "' + page.name + '"');
    list.splice(idx, 1);
    action = 'removed';
  } else if (idx >= 0) {
    if (p.name) list[idx].name = p.name;
    action = 'renamed';
  } else {
    if (pfScreenOf(n) !== n) throw new Error('Flow starting points must be top-level frames; ' + n.id + ' is inside "' + pfScreenOf(n).name + '"');
    list.push({ nodeId: n.id, name: p.name || n.name });
    action = 'added';
  }
  if (!p.remove && p.index !== undefined) {
    var cur = -1;
    for (var j = 0; j < list.length; j++) if (list[j].nodeId === n.id) cur = j;
    var item = list.splice(cur, 1)[0];
    list.splice(Math.max(0, Math.min(p.index, list.length)), 0, item);
  }
  page.flowStartingPoints = list;
  return { page: { id: page.id, name: page.name }, action: action, flowStartingPoints: await pfFlowStarts(page, pfResolver()) };
};

// ---------------------------------------------------------------------------
// FigJam
// ---------------------------------------------------------------------------

async function pfLoadSublayerFont(sub) {
  var fn = sub.fontName;
  if (fn !== figma.mixed) { await figma.loadFontAsync(fn); return; }
  var fonts = sub.getRangeAllFontNames(0, sub.characters.length);
  for (var i = 0; i < fonts.length; i++) await figma.loadFontAsync(fonts[i]);
}

async function pfSetSublayer(sub, text, opts) {
  opts = opts || {};
  await pfLoadSublayerFont(sub);
  if (text !== undefined && text !== null) sub.characters = String(text);
  if (opts.fontSize !== undefined) sub.fontSize = opts.fontSize;
  if (opts.color) sub.fills = [hexPaint(opts.color)];
}

function pfJamOut(n) {
  var o = ser(n, 0);
  if (n.text) { try { o.text = n.text.characters; } catch (e) { /* ignore */ } }
  return o;
}

H.create_sticky = async function (p) {
  pfRequireFigJam('create_sticky');
  var s = figma.createSticky();
  try {
    if (p.wide) s.isWideWidth = true;
    if (p.color) s.fills = [hexPaint(p.color)];
    if (p.authorVisible !== undefined) s.authorVisible = p.authorVisible;
    if (p.name) s.name = p.name;
    await pfSetSublayer(s.text, p.text, { fontSize: p.fontSize });
    await appendTo(s, p.parentId, p.x, p.y);
  } catch (e) { s.remove(); throw e; }
  return pfJamOut(s);
};

H.create_shape_with_text = async function (p) {
  pfRequireFigJam('create_shape_with_text');
  var s = figma.createShapeWithText();
  try {
    s.shapeType = p.shapeType || 'ROUNDED_RECTANGLE';
    if (p.width !== undefined || p.height !== undefined) s.resize(p.width || s.width, p.height || s.height);
    if (p.fill !== undefined) s.fills = paintList(p.fill);
    if (p.stroke !== undefined) s.strokes = paintList(p.stroke);
    if (p.strokeWeight !== undefined) s.strokeWeight = p.strokeWeight;
    if (p.name) s.name = p.name;
    await pfSetSublayer(s.text, p.text, { fontSize: p.fontSize, color: p.textColor });
    await appendTo(s, p.parentId, p.x, p.y);
  } catch (e) { s.remove(); throw e; }
  var o = pfJamOut(s);
  o.shapeType = s.shapeType;
  return o;
};

async function pfEndpoint(nodeId, x, y, magnet, label) {
  if (nodeId) {
    var n = await node(nodeId);
    return { endpointNodeId: n.id, magnet: magnet || 'AUTO' };
  }
  if (x !== undefined && y !== undefined) return { position: { x: x, y: y } };
  throw new Error(label + ': give ' + label + 'NodeId or both ' + label + 'X and ' + label + 'Y');
}

H.create_connector = async function (p) {
  pfRequireFigJam('create_connector');
  var start = await pfEndpoint(p.startNodeId, p.startX, p.startY, p.startMagnet, 'start');
  var end = await pfEndpoint(p.endNodeId, p.endX, p.endY, p.endMagnet, 'end');
  var c = figma.createConnector();
  try {
    if (p.parentId) {
      var parent = await node(p.parentId);
      if (!('appendChild' in parent)) throw new Error('Node ' + p.parentId + ' cannot have children');
      parent.appendChild(c);
    }
    c.connectorStart = start;
    c.connectorEnd = end;
    if (p.lineType) c.connectorLineType = p.lineType;
    if (p.stroke) c.strokes = paintList(p.stroke);
    if (p.strokeWeight !== undefined) c.strokeWeight = p.strokeWeight;
    if (p.startCap) c.connectorStartStrokeCap = p.startCap;
    if (p.endCap) c.connectorEndStrokeCap = p.endCap;
    if (p.name) c.name = p.name;
    if (p.label !== undefined) await pfSetSublayer(c.text, p.label, { fontSize: p.labelFontSize });
  } catch (e) { c.remove(); throw e; }
  var o = pfJamOut(c);
  o.connectorStart = jsonSafe(c.connectorStart);
  o.connectorEnd = jsonSafe(c.connectorEnd);
  o.lineType = c.connectorLineType;
  return o;
};

H.create_table = async function (p) {
  pfRequireFigJam('create_table');
  var cells = p.cells || null;
  var rows = p.rows || (cells ? cells.length : 2);
  var cols = p.columns || (cells ? cells.reduce(function (m, r) { return Math.max(m, (r || []).length); }, 0) : 2);
  if (rows < 1 || cols < 1) throw new Error('rows and columns must be >= 1');
  var t = figma.createTable(rows, cols);
  var errors = [];
  try {
    if (p.name) t.name = p.name;
    if (cells) {
      for (var r = 0; r < Math.min(rows, cells.length); r++) {
        var row = cells[r] || [];
        for (var c = 0; c < Math.min(cols, row.length); c++) {
          if (row[c] === undefined || row[c] === null || row[c] === '') continue;
          try {
            var cell = t.cellAt(r, c);
            await pfSetSublayer(cell.text, row[c], { fontSize: p.fontSize });
          } catch (e) { errors.push({ row: r, column: c, error: e.message }); }
        }
      }
    }
    if (p.headerFill) {
      for (var hc = 0; hc < cols; hc++) {
        try { t.cellAt(0, hc).fills = [hexPaint(p.headerFill)]; } catch (e) { errors.push({ row: 0, column: hc, error: e.message }); }
      }
    }
    await appendTo(t, p.parentId, p.x, p.y);
  } catch (e) { t.remove(); throw e; }
  var o = ser(t, 0);
  o.numRows = t.numRows;
  o.numColumns = t.numColumns;
  if (errors.length) o.errors = errors;
  return o;
};
