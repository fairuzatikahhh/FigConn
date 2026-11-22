// figconn plugin — executes commands from the figconn MCP server.
// Written in plain ES2017 (no optional chaining / object spread) for the Figma sandbox.

figma.showUI(__html__, { width: 300, height: 180, themeColors: true });

var SESSION_ID = Math.random().toString(36).slice(2, 10);

function fileInfo() {
  return {
    id: SESSION_ID,
    fileKey: figma.fileKey || null,
    fileName: figma.root.name,
    editorType: figma.editorType,
    currentPage: { id: figma.currentPage.id, name: figma.currentPage.name },
    selection: figma.currentPage.selection.map(function (n) { return n.id; }),
  };
}
function postActive() { figma.ui.postMessage({ type: 'active', info: fileInfo() }); }
figma.ui.postMessage({ type: 'info', info: fileInfo() });
figma.on('selectionchange', postActive);
figma.on('currentpagechange', postActive);

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function round(n) { return Math.round(n * 100) / 100; }

function rgb(hex) {
  if (hex && typeof hex === 'object') return hex;
  var h = String(hex).trim().replace(/^#/, '');
  if (h.length === 3 || h.length === 4) h = h.split('').map(function (c) { return c + c; }).join('');
  if (!/^[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/.test(h)) throw new Error('Invalid hex color: ' + hex);
  var r = parseInt(h.slice(0, 2), 16) / 255, g = parseInt(h.slice(2, 4), 16) / 255, b = parseInt(h.slice(4, 6), 16) / 255;
  var a = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
  return { r: r, g: g, b: b, a: a };
}
function toHex(c, a) {
  function p(x) { var s = Math.round(x * 255).toString(16); return s.length === 1 ? '0' + s : s; }
  var out = '#' + p(c.r) + p(c.g) + p(c.b);
  var alpha = a !== undefined ? a : c.a;
  if (alpha !== undefined && alpha < 1) out += p(alpha);
  return out.toUpperCase();
}
function hexPaint(hex) {
  var c = rgb(hex);
  return { type: 'SOLID', color: { r: c.r, g: c.g, b: c.b }, opacity: c.a };
}
function paintList(v) {
  if (v === 'none' || v === null) return [];
  if (typeof v === 'string') return [hexPaint(v)];
  if (Array.isArray(v)) return v.map(function (p) { return typeof p === 'string' ? hexPaint(p) : p; });
  return v;
}

async function node(id) {
  var n = await figma.getNodeByIdAsync(id);
  if (!n) throw new Error('Node not found: ' + id);
  return n;
}
async function nodes(ids) {
  var out = [];
  for (var i = 0; i < ids.length; i++) out.push(await node(ids[i]));
  return out;
}

async function loadFonts(textNode) {
  if (textNode.type !== 'TEXT') return;
  if (textNode.characters.length === 0) {
    if (textNode.fontName !== figma.mixed) await figma.loadFontAsync(textNode.fontName);
    return;
  }
  var fonts = textNode.getRangeAllFontNames(0, textNode.characters.length);
  for (var i = 0; i < fonts.length; i++) await figma.loadFontAsync(fonts[i]);
}

function paintSummary(p) {
  if (p.type === 'SOLID') {
    var s = { hex: toHex(p.color, p.opacity) };
    if (p.boundVariables && p.boundVariables.color) s.variable = p.boundVariables.color.id;
    if (p.visible === false) s.visible = false;
    return s;
  }
  return { type: p.type };
}

function ser(n, depth) {
  if (depth === undefined) depth = 1;
  var o = { id: n.id, name: n.name, type: n.type };
  if ('x' in n && n.type !== 'PAGE') { o.x = round(n.x); o.y = round(n.y); o.width = round(n.width); o.height = round(n.height); }
  if (n.visible === false) o.visible = false;
  try {
    if ('fills' in n && Array.isArray(n.fills) && n.fills.length) o.fills = n.fills.map(paintSummary);
    if ('strokes' in n && Array.isArray(n.strokes) && n.strokes.length) { o.strokes = n.strokes.map(paintSummary); o.strokeWeight = n.strokeWeight === figma.mixed ? 'mixed' : n.strokeWeight; }
    if ('cornerRadius' in n && n.cornerRadius) o.cornerRadius = n.cornerRadius === figma.mixed ? 'mixed' : n.cornerRadius;
    if ('opacity' in n && n.opacity !== 1) o.opacity = n.opacity;
    if ('layoutMode' in n && n.layoutMode !== 'NONE') {
      o.layout = { mode: n.layoutMode, gap: n.itemSpacing, padding: [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft],
        primaryAlign: n.primaryAxisAlignItems, counterAlign: n.counterAxisAlignItems, primarySizing: n.primaryAxisSizingMode, counterSizing: n.counterAxisSizingMode };
    }
    if ('layoutSizingHorizontal' in n && n.parent && n.parent.layoutMode && n.parent.layoutMode !== 'NONE') {
      o.sizing = { h: n.layoutSizingHorizontal, v: n.layoutSizingVertical };
    }
    if (n.type === 'TEXT') {
      o.characters = n.characters.length > 500 ? n.characters.slice(0, 500) + '…' : n.characters;
      o.fontName = n.fontName === figma.mixed ? 'mixed' : n.fontName;
      o.fontSize = n.fontSize === figma.mixed ? 'mixed' : n.fontSize;
      if (typeof n.textStyleId === 'string' && n.textStyleId) o.textStyleId = n.textStyleId;
    }
    if (typeof n.fillStyleId === 'string' && n.fillStyleId) o.fillStyleId = n.fillStyleId;
    if (typeof n.effectStyleId === 'string' && n.effectStyleId) o.effectStyleId = n.effectStyleId;
    if (n.boundVariables && Object.keys(n.boundVariables).length) {
      var bv = {};
      Object.keys(n.boundVariables).forEach(function (k) {
        var v = n.boundVariables[k];
        bv[k] = Array.isArray(v) ? v.map(function (x) { return x.id; }) : (v && v.id) ? v.id : v;
      });
      o.boundVariables = bv;
    }
    if (n.type === 'INSTANCE') {
      var props = {};
      var cp = n.componentProperties || {};
      Object.keys(cp).forEach(function (k) { props[k] = cp[k].value; });
      o.componentProperties = props;
    }
    if ((n.type === 'COMPONENT' || n.type === 'COMPONENT_SET') && !(n.type === 'COMPONENT' && n.parent && n.parent.type === 'COMPONENT_SET')) {
      o.key = n.key;
      o.componentPropertyDefinitions = n.componentPropertyDefinitions;
    }
  } catch (e) { /* some props throw on special nodes — ignore */ }
  if ('children' in n && n.type !== 'PAGE' || (n.type === 'PAGE' && depth > 0)) {
    if (depth > 0) o.children = n.children.map(function (c) { return ser(c, depth - 1); });
    else o.childCount = n.children.length;
  }
  return o;
}

// Make any value (nodes, symbols, typed arrays) JSON-safe.
function jsonSafe(v, d) {
  d = d || 0;
  if (v === figma.mixed) return 'mixed';
  if (v === undefined || v === null) return v === undefined ? null : v;
  if (typeof v === 'function' || typeof v === 'symbol') return String(v);
  if (typeof v !== 'object') return v;
  if (d > 8) return '[depth limit]';
  if (v instanceof Uint8Array) return '[Uint8Array ' + v.length + ' bytes]';
  if (typeof v.id === 'string' && typeof v.type === 'string' && 'parent' in v) return ser(v, 0);
  if (Array.isArray(v)) return v.map(function (x) { return jsonSafe(x, d + 1); });
  var o = {};
  Object.keys(v).forEach(function (k) { o[k] = jsonSafe(v[k], d + 1); });
  return o;
}

function pageOf(n) {
  var p = n;
  while (p && p.type !== 'PAGE') p = p.parent;
  return p;
}

async function appendTo(n, parentId, x, y) {
  var parent = parentId ? await node(parentId) : figma.currentPage;
  if (!('appendChild' in parent)) throw new Error('Node ' + parentId + ' cannot have children');
  parent.appendChild(n);
  if (x !== undefined) n.x = x;
  if (y !== undefined) n.y = y;
  if (!parentId && x === undefined && y === undefined) {
    var c = figma.viewport.center;
    n.x = Math.round(c.x - n.width / 2); n.y = Math.round(c.y - n.height / 2);
  }
}

// --- variables ---------------------------------------------------------------

async function getCollection(ref) {
  var cols = await figma.variables.getLocalVariableCollectionsAsync();
  var low = String(ref).toLowerCase();
  var c = cols.filter(function (c) { return c.id === ref; })[0] || cols.filter(function (c) { return c.name.toLowerCase() === low; })[0];
  if (!c) throw new Error('Variable collection not found: ' + ref + '. Existing: ' + cols.map(function (c) { return c.name; }).join(', '));
  return c;
}

async function findVariable(ref, collectionRef) {
  if (/^VariableID:/.test(ref)) {
    var byId = await figma.variables.getVariableByIdAsync(ref);
    if (byId) return byId;
  }
  var vars = await figma.variables.getLocalVariablesAsync();
  var hits = vars.filter(function (v) { return v.name === ref; });
  if (collectionRef) {
    var col = await getCollection(collectionRef);
    hits = hits.filter(function (v) { return v.variableCollectionId === col.id; });
  }
  if (!hits.length) throw new Error('Variable not found: ' + ref);
  return hits[0];
}

function findMode(col, name) {
  var low = String(name).toLowerCase();
  var m = col.modes.filter(function (m) { return m.modeId === name || m.name.toLowerCase() === low; })[0];
  return m || null;
}

async function toVarValue(type, v) {
  if (v && typeof v === 'object' && v.alias) {
    return figma.variables.createVariableAlias(await findVariable(v.alias, v.collection));
  }
  if (type === 'COLOR') return rgb(v);
  if (type === 'FLOAT') return Number(v);
  if (type === 'BOOLEAN') return Boolean(v);
  return String(v);
}

function fmtVarValue(v, nameById) {
  if (v && typeof v === 'object') {
    if (v.type === 'VARIABLE_ALIAS') return { alias: nameById[v.id] || v.id };
    if ('r' in v) return toHex(v, v.a);
  }
  return v;
}

var TEXT_VAR_FIELDS = ['fontFamily', 'fontSize', 'fontStyle', 'fontWeight', 'letterSpacing', 'lineHeight', 'paragraphSpacing', 'paragraphIndent'];

// --- styles --------------------------------------------------------------------

async function allStyles() {
  var lists = await Promise.all([
    figma.getLocalPaintStylesAsync(), figma.getLocalTextStylesAsync(),
    figma.getLocalEffectStylesAsync(), figma.getLocalGridStylesAsync(),
  ]);
  return [].concat(lists[0], lists[1], lists[2], lists[3]);
}
async function findStyle(ref, type) {
  if (/^S:/.test(ref)) {
    var s = await figma.getStyleByIdAsync(ref);
    if (s) return s;
  }
  var all = await allStyles();
  var hit = all.filter(function (s) { return (s.id === ref || s.name === ref) && (!type || s.type === type); })[0];
  return hit || null;
}
function parseLength(v) {
  if (v === undefined) return undefined;
  if (v === 'auto' || v === 'AUTO') return { unit: 'AUTO' };
  if (typeof v === 'string' && /%$/.test(v)) return { value: parseFloat(v), unit: 'PERCENT' };
  return { value: Number(v), unit: 'PIXELS' };
}

// --- components ------------------------------------------------------------------

async function loadInstanceFonts(inst) {
  var texts = inst.findAll(function (n) { return n.type === 'TEXT'; });
  for (var i = 0; i < texts.length; i++) await loadFonts(texts[i]);
}
async function setInstanceProps(inst, props) {
  var defs = inst.componentProperties || {};
  var mapped = {};
  var needFonts = false;
  Object.keys(props).forEach(function (name) {
    var key = defs[name] ? name : Object.keys(defs).filter(function (k) { return k.split('#')[0] === name; })[0];
    if (!key) throw new Error('Unknown property "' + name + '" on ' + inst.name + '. Available: ' + Object.keys(defs).join(', '));
    if (defs[key].type === 'TEXT') needFonts = true;
    mapped[key] = props[name];
  });
  if (needFonts) await loadInstanceFonts(inst);
  inst.setProperties(mapped);
}

// ---------------------------------------------------------------------------
// command handlers
// ---------------------------------------------------------------------------

var H = {};

H.execute = async function (p) {
  var AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  var fn = new AsyncFunction('figma', 'h', p.code);
  var helpers = { hex: hexPaint, rgb: rgb, toHex: toHex, node: node, ser: ser, loadFonts: loadFonts, findVariable: findVariable, getCollection: getCollection };
  return jsonSafe(await fn(figma, helpers));
};

H.get_document = async function (p) {
  var page = p.pageId ? await node(p.pageId) : figma.currentPage;
  if (page.type !== 'PAGE') throw new Error(p.pageId + ' is not a page');
  await page.loadAsync();
  return {
    fileName: figma.root.name,
    pages: figma.root.children.map(function (pg) { return { id: pg.id, name: pg.name, current: pg.id === figma.currentPage.id }; }),
    page: { id: page.id, name: page.name, children: page.children.map(function (c) { return ser(c, 0); }) },
  };
};

H.get_selection = async function (p) {
  var d = p.depth === undefined ? 1 : p.depth;
  return { page: figma.currentPage.name, selection: figma.currentPage.selection.map(function (n) { return ser(n, d); }) };
};

H.get_node = async function (p) {
  return ser(await node(p.nodeId), p.depth === undefined ? 2 : p.depth);
};

H.set_selection = async function (p) {
  var ns = await nodes(p.nodeIds);
  var page = pageOf(ns[0]);
  if (page && page.id !== figma.currentPage.id) await figma.setCurrentPageAsync(page);
  figma.currentPage.selection = ns.filter(function (n) { return pageOf(n) === figma.currentPage; });
  figma.viewport.scrollAndZoomIntoView(figma.currentPage.selection);
  return { selected: figma.currentPage.selection.map(function (n) { return n.id; }) };
};

H.create_frame = async function (p) {
  var f = figma.createFrame();
  if (p.name) f.name = p.name;
  f.resize(p.width || 100, p.height || 100);
  if (p.fill !== undefined) f.fills = paintList(p.fill);
  if (p.cornerRadius !== undefined) f.cornerRadius = p.cornerRadius;
  var al = p.autoLayout;
  if (al && al.mode !== 'NONE') {
    f.layoutMode = al.mode;
    if (al.gap !== undefined) f.itemSpacing = al.gap;
    if (al.padding !== undefined) {
      var pd = Array.isArray(al.padding) ? al.padding : [al.padding, al.padding, al.padding, al.padding];
      f.paddingTop = pd[0]; f.paddingRight = pd[1]; f.paddingBottom = pd[2]; f.paddingLeft = pd[3];
    }
    if (al.primaryAlign) f.primaryAxisAlignItems = al.primaryAlign;
    if (al.counterAlign) f.counterAxisAlignItems = al.counterAlign;
    if (al.wrap) f.layoutWrap = 'WRAP';
    var sizing = al.sizing || (p.width || p.height ? 'FIXED' : 'HUG');
    f.primaryAxisSizingMode = sizing === 'HUG' ? 'AUTO' : 'FIXED';
    f.counterAxisSizingMode = sizing === 'HUG' ? 'AUTO' : 'FIXED';
  }
  await appendTo(f, p.parentId, p.x, p.y);
  return ser(f, 0);
};

H.create_text = async function (p) {
  var font = { family: p.fontFamily || 'Inter', style: p.fontStyle || 'Regular' };
  await figma.loadFontAsync(font);
  var t = figma.createText();
  t.fontName = font;
  t.characters = p.characters;
  if (p.fontSize) t.fontSize = p.fontSize;
  if (p.fill) t.fills = paintList(p.fill);
  if (p.name) t.name = p.name;
  if (p.width) { t.textAutoResize = 'HEIGHT'; t.resize(p.width, t.height); }
  await appendTo(t, p.parentId, p.x, p.y);
  return ser(t, 0);
};

H.set_properties = async function (p) {
  var ns = await nodes(p.nodeIds);
  var results = [];
  for (var i = 0; i < ns.length; i++) {
    var n = ns[i];
    try {
      if (n.type === 'TEXT') {
        await loadFonts(n);
        if (p.props.fontName) await figma.loadFontAsync(p.props.fontName);
      }
      var keys = Object.keys(p.props);
      var w = p.props.width, h = p.props.height;
      for (var k = 0; k < keys.length; k++) {
        var key = keys[k], val = p.props[key];
        if (key === 'width' || key === 'height') continue;
        if (key === 'fills' || key === 'strokes') n[key] = paintList(val);
        else if (key === 'lineHeight' || key === 'letterSpacing') n[key] = typeof val === 'object' ? val : parseLength(val);
        else n[key] = val;
      }
      if (w !== undefined || h !== undefined) n.resize(w !== undefined ? w : n.width, h !== undefined ? h : n.height);
      results.push(ser(n, 0));
    } catch (e) {
      results.push({ id: n.id, error: e.message });
    }
  }
  return results;
};

H.delete_nodes = async function (p) {
  var ns = await nodes(p.nodeIds);
  ns.forEach(function (n) { n.remove(); });
  return { deleted: p.nodeIds };
};

// --- variables ---------------------------------------------------------------

H.get_variables = async function (p) {
  var cols = await figma.variables.getLocalVariableCollectionsAsync();
  if (p.collection) { var c = await getCollection(p.collection); cols = [c]; }
  var vars = await figma.variables.getLocalVariablesAsync();
  var nameById = {};
  vars.forEach(function (v) { nameById[v.id] = v.name; });
  return cols.map(function (c) {
    return {
      id: c.id, name: c.name, key: c.key, defaultModeId: c.defaultModeId,
      modes: c.modes.map(function (m) { return { modeId: m.modeId, name: m.name }; }),
      variables: vars.filter(function (v) { return v.variableCollectionId === c.id; }).map(function (v) {
        var values = {};
        c.modes.forEach(function (m) { values[m.name] = fmtVarValue(v.valuesByMode[m.modeId], nameById); });
        return { id: v.id, name: v.name, type: v.resolvedType, scopes: v.scopes, values: values };
      }),
    };
  });
};

H.create_variable_collection = async function (p) {
  var col = figma.variables.createVariableCollection(p.name);
  var modes = p.modes || [];
  try {
    if (modes.length) col.renameMode(col.modes[0].modeId, modes[0]);
    for (var i = 1; i < modes.length; i++) col.addMode(modes[i]);
  } catch (e) {
    col.remove(); // all-or-nothing: don't leave a half-made collection behind
    var msg = e && e.message ? e.message : String(e);
    if (/limited to \d+ modes?/i.test(msg)) {
      throw new Error('This file\'s Figma plan allows fewer modes than requested (' + msg.replace(/^in addMode: /, '') +
        '). Nothing was created. Retry with fewer modes, e.g. modes: ["' + modes[0] + '"].');
    }
    throw e;
  }
  return { id: col.id, name: col.name, modes: col.modes };
};

H.create_variables = async function (p) {
  var col = await getCollection(p.collection);
  var existing = (await figma.variables.getLocalVariablesAsync()).filter(function (v) { return v.variableCollectionId === col.id; });
  var out = [];
  // Two passes so aliases can point at variables created in the same call.
  var created = [];
  for (var i = 0; i < p.variables.length; i++) {
    var spec = p.variables[i];
    var v = existing.filter(function (e) { return e.name === spec.name; })[0];
    if (v && v.resolvedType !== spec.type) throw new Error('Variable ' + spec.name + ' exists with type ' + v.resolvedType);
    if (!v) v = figma.variables.createVariable(spec.name, col, spec.type);
    if (spec.scopes) v.scopes = spec.scopes;
    if (spec.description !== undefined) v.description = spec.description;
    created.push([v, spec]);
  }
  for (var j = 0; j < created.length; j++) {
    var vv = created[j][0], sp = created[j][1];
    try {
      if (sp.values) {
        var modeNames = Object.keys(sp.values);
        for (var k = 0; k < modeNames.length; k++) {
          var mode = findMode(col, modeNames[k]);
          if (!mode) { col.addMode(modeNames[k]); mode = findMode(col, modeNames[k]); }
          vv.setValueForMode(mode.modeId, await toVarValue(sp.type, sp.values[modeNames[k]]));
        }
      } else if (sp.value !== undefined) {
        for (var m = 0; m < col.modes.length; m++) vv.setValueForMode(col.modes[m].modeId, await toVarValue(sp.type, sp.value));
      }
      out.push({ id: vv.id, name: vv.name });
    } catch (e) {
      out.push({ id: vv.id, name: vv.name, error: e.message });
    }
  }
  return { collection: col.name, variables: out };
};

H.bind_variable = async function (p) {
  var v = await findVariable(p.variable, p.collection);
  var ns = await nodes(p.nodeIds);
  var field = p.field;
  var results = [];
  for (var i = 0; i < ns.length; i++) {
    var n = ns[i];
    try {
      if (field === 'fill' || field === 'fills' || field === 'stroke' || field === 'strokes') {
        var prop = field.indexOf('fill') === 0 ? 'fills' : 'strokes';
        var paints = Array.isArray(n[prop]) && n[prop].length ? n[prop].slice() : [hexPaint('#000000')];
        if (paints[0].type !== 'SOLID') paints[0] = hexPaint('#000000');
        paints[0] = figma.variables.setBoundVariableForPaint(paints[0], 'color', v);
        n[prop] = paints;
      } else if (field === 'padding') {
        ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft'].forEach(function (f) { n.setBoundVariable(f, v); });
      } else if (field === 'cornerRadius') {
        ['topLeftRadius', 'topRightRadius', 'bottomLeftRadius', 'bottomRightRadius'].forEach(function (f) { n.setBoundVariable(f, v); });
      } else if (n.type === 'TEXT' && (TEXT_VAR_FIELDS.indexOf(field) >= 0 || field === 'characters')) {
        await loadFonts(n);
        if (field === 'characters') n.setBoundVariable('characters', v);
        else n.setRangeBoundVariable(0, n.characters.length, field, v);
      } else {
        n.setBoundVariable(field, v);
      }
      results.push({ id: n.id, ok: true });
    } catch (e) {
      results.push({ id: n.id, error: e.message });
    }
  }
  return { variable: v.name, field: field, results: results };
};

H.set_variable_mode = async function (p) {
  var col = await getCollection(p.collection);
  var mode = findMode(col, p.mode);
  if (!mode) throw new Error('Mode ' + p.mode + ' not in ' + col.name);
  var ns = await nodes(p.nodeIds);
  ns.forEach(function (n) { n.setExplicitVariableModeForCollection(col, mode.modeId); });
  return { collection: col.name, mode: mode.name, nodes: p.nodeIds };
};

H.list_library_variables = async function (p) {
  if (p.collectionKey) {
    var vars = await figma.teamLibrary.getVariablesInLibraryCollectionAsync(p.collectionKey);
    return vars.map(function (v) { return { key: v.key, name: v.name, type: v.resolvedType }; });
  }
  return await figma.teamLibrary.getAvailableLibraryVariableCollectionsAsync();
};

H.import_library_variable = async function (p) {
  var v = await figma.variables.importVariableByKeyAsync(p.key);
  return { id: v.id, name: v.name, type: v.resolvedType };
};

// --- styles --------------------------------------------------------------------

H.get_styles = async function () {
  var all = await allStyles();
  return all.map(function (s) {
    var o = { id: s.id, name: s.name, type: s.type, key: s.key };
    if (s.type === 'PAINT') o.paints = s.paints.map(paintSummary);
    if (s.type === 'TEXT') { o.fontName = s.fontName; o.fontSize = s.fontSize; o.lineHeight = s.lineHeight; o.letterSpacing = s.letterSpacing; }
    if (s.type === 'EFFECT') o.effects = s.effects.map(function (e) { return e.type; });
    return o;
  });
};

H.create_paint_style = async function (p) {
  var s = await findStyle(p.name, 'PAINT');
  if (!s) { s = figma.createPaintStyle(); s.name = p.name; }
  var paint = hexPaint(p.hex || '#000000');
  if (p.variable) paint = figma.variables.setBoundVariableForPaint(paint, 'color', await findVariable(p.variable));
  s.paints = [paint];
  if (p.description !== undefined) s.description = p.description;
  return { id: s.id, name: s.name, key: s.key };
};

H.create_text_style = async function (p) {
  var font = { family: p.fontFamily, style: p.fontStyle || 'Regular' };
  await figma.loadFontAsync(font);
  var s = await findStyle(p.name, 'TEXT');
  if (!s) { s = figma.createTextStyle(); s.name = p.name; }
  s.fontName = font;
  s.fontSize = p.fontSize;
  if (p.lineHeight !== undefined) s.lineHeight = parseLength(p.lineHeight);
  if (p.letterSpacing !== undefined) s.letterSpacing = parseLength(p.letterSpacing);
  if (p.textCase) s.textCase = p.textCase;
  if (p.description !== undefined) s.description = p.description;
  return { id: s.id, name: s.name, key: s.key };
};

H.create_effect_style = async function (p) {
  var s = await findStyle(p.name, 'EFFECT');
  if (!s) { s = figma.createEffectStyle(); s.name = p.name; }
  s.effects = p.shadows.map(function (sh) {
    return { type: sh.inner ? 'INNER_SHADOW' : 'DROP_SHADOW', color: rgb(sh.color), offset: { x: sh.x, y: sh.y },
      radius: sh.blur, spread: sh.spread || 0, visible: true, blendMode: 'NORMAL' };
  });
  return { id: s.id, name: s.name, key: s.key };
};

H.apply_style = async function (p) {
  var s = await findStyle(p.style);
  if (!s) throw new Error('Style not found: ' + p.style);
  var target = p.target || { PAINT: 'fill', TEXT: 'text', EFFECT: 'effect', GRID: 'grid' }[s.type];
  var ns = await nodes(p.nodeIds);
  var results = [];
  for (var i = 0; i < ns.length; i++) {
    var n = ns[i];
    try {
      if (target === 'fill') await n.setFillStyleIdAsync(s.id);
      else if (target === 'stroke') await n.setStrokeStyleIdAsync(s.id);
      else if (target === 'effect') await n.setEffectStyleIdAsync(s.id);
      else if (target === 'grid') await n.setGridStyleIdAsync(s.id);
      else if (target === 'text') {
        await loadFonts(n);
        await figma.loadFontAsync(s.fontName);
        await n.setTextStyleIdAsync(s.id);
      }
      results.push({ id: n.id, ok: true });
    } catch (e) {
      results.push({ id: n.id, error: e.message });
    }
  }
  return { style: s.name, target: target, results: results };
};

// --- components ------------------------------------------------------------------

H.get_components = async function (p) {
  var pages = p.pageId ? [await node(p.pageId)] : figma.root.children;
  var out = [];
  for (var i = 0; i < pages.length; i++) {
    await pages[i].loadAsync();
    var found = pages[i].findAllWithCriteria({ types: ['COMPONENT', 'COMPONENT_SET'] });
    found.forEach(function (c) {
      if (c.type === 'COMPONENT' && c.parent && c.parent.type === 'COMPONENT_SET') return;
      var o = { id: c.id, name: c.name, type: c.type, key: c.key, page: pages[i].name, properties: c.componentPropertyDefinitions };
      if (c.type === 'COMPONENT_SET') o.variants = c.children.map(function (v) { return { id: v.id, name: v.name, key: v.key }; });
      out.push(o);
    });
  }
  return out;
};

H.create_component = async function (p) {
  var c;
  if (p.nodeId) c = figma.createComponentFromNode(await node(p.nodeId));
  else { c = figma.createComponent(); await appendTo(c); }
  if (p.name) c.name = p.name;
  return ser(c, 0);
};

H.combine_as_variants = async function (p) {
  var cs = await nodes(p.componentIds);
  cs.forEach(function (c) { if (c.type !== 'COMPONENT') throw new Error(c.id + ' is not a component'); });
  var set = figma.combineAsVariants(cs, cs[0].parent || figma.currentPage);
  if (p.name) set.name = p.name;
  return ser(set, 1);
};

H.add_component_property = async function (p) {
  var c = await node(p.nodeId);
  var propName = c.addComponentProperty(p.name, p.type, p.defaultValue);
  if (p.bindToNodeId) {
    var child = await node(p.bindToNodeId);
    var refKey = { BOOLEAN: 'visible', TEXT: 'characters', INSTANCE_SWAP: 'mainComponent' }[p.type];
    if (!refKey) throw new Error('VARIANT properties cannot be bound to a child');
    var refs = Object.assign({}, child.componentPropertyReferences || {});
    refs[refKey] = propName;
    child.componentPropertyReferences = refs;
  }
  return { property: propName };
};

H.create_instance = async function (p) {
  var comp;
  if (p.componentId) comp = await node(p.componentId);
  else if (p.componentKey) {
    comp = p.isComponentSet ? await figma.importComponentSetByKeyAsync(p.componentKey) : await figma.importComponentByKeyAsync(p.componentKey);
  } else throw new Error('componentId or componentKey required');
  if (comp.type === 'COMPONENT_SET') comp = comp.defaultVariant;
  if (comp.type !== 'COMPONENT') throw new Error('Not a component: ' + comp.type);
  var inst = comp.createInstance();
  await appendTo(inst, p.parentId, p.x, p.y);
  if (p.properties) await setInstanceProps(inst, p.properties);
  return ser(inst, 0);
};

H.set_instance_properties = async function (p) {
  var ns = await nodes(p.nodeIds);
  var results = [];
  for (var i = 0; i < ns.length; i++) {
    try {
      if (ns[i].type !== 'INSTANCE') throw new Error('Not an instance');
      await setInstanceProps(ns[i], p.properties);
      results.push(ser(ns[i], 0));
    } catch (e) {
      results.push({ id: ns[i].id, error: e.message });
    }
  }
  return results;
};
