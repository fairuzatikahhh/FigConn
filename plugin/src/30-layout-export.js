// ---------------------------------------------------------------------------
// layout helpers & export (Tier 2)
// get_screenshot, export_node_bytes (used by server-side save_screenshots), place_relative,
// distribute_nodes, align_nodes, arrange_grid, align_to_grid, set_constraints,
// get_layout_tree, scroll_into_view
// ---------------------------------------------------------------------------

var LE_MAX_DIM_DEFAULT = 4096;

// Absolute (page-space) axis-aligned bounding box of a node.
function leAbsBox(n) {
  if (n.absoluteBoundingBox) {
    var b = n.absoluteBoundingBox;
    return { x: b.x, y: b.y, width: b.width, height: b.height };
  }
  if (n.absoluteTransform && 'width' in n) {
    var t = n.absoluteTransform;
    var pts = [[0, 0], [n.width, 0], [0, n.height], [n.width, n.height]].map(function (q) {
      return [t[0][0] * q[0] + t[0][1] * q[1] + t[0][2], t[1][0] * q[0] + t[1][1] * q[1] + t[1][2]];
    });
    var xs = pts.map(function (q) { return q[0]; }), ys = pts.map(function (q) { return q[1]; });
    var minX = Math.min.apply(null, xs), minY = Math.min.apply(null, ys);
    return { x: minX, y: minY, width: Math.max.apply(null, xs) - minX, height: Math.max.apply(null, ys) - minY };
  }
  throw new Error('Node ' + n.id + ' (' + n.type + ') has no bounds');
}

function leUnion(boxes) {
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  boxes.forEach(function (b) {
    minX = Math.min(minX, b.x); minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.width); maxY = Math.max(maxY, b.y + b.height);
  });
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function leRoundBox(b) {
  return b ? { x: round(b.x), y: round(b.y), width: round(b.width), height: round(b.height) } : null;
}

function leInAutoLayout(n) {
  var p = n.parent;
  return !!(p && 'layoutMode' in p && p.layoutMode && p.layoutMode !== 'NONE' && n.layoutPositioning !== 'ABSOLUTE');
}

// Throw if the node's position cannot be set freely.
function leAssertMovable(n) {
  if (n.type === 'PAGE' || n.type === 'DOCUMENT') throw new Error(n.type + ' cannot be moved');
  if (!('x' in n)) throw new Error(n.type + ' has no position');
  if (leInAutoLayout(n)) throw new Error('Node is inside auto layout (' + n.parent.name + '); set layoutPositioning ABSOLUTE first');
}

// Move a node by (dx, dy) expressed in absolute (page) coordinates, converting into the parent's space.
function leMoveAbs(n, dx, dy) {
  if (!dx && !dy) return;
  var p = n.parent;
  var ldx = dx, ldy = dy;
  if (p && p.type !== 'PAGE' && p.absoluteTransform) {
    // parent transform is a rotation (+translation); its inverse is the transpose
    var t = p.absoluteTransform;
    ldx = t[0][0] * dx + t[1][0] * dy;
    ldy = t[0][1] * dx + t[1][1] * dy;
  }
  n.x = n.x + ldx;
  n.y = n.y + ldy;
}

// Move node so its absolute bbox top-left lands at (x, y). Either may be undefined (axis unchanged).
function leMoveAbsTo(n, x, y) {
  var b = leAbsBox(n);
  leMoveAbs(n, x === undefined ? 0 : x - b.x, y === undefined ? 0 : y - b.y);
}

function lePos(n) {
  return { id: n.id, name: n.name, x: round(n.x), y: round(n.y), absolute: leRoundBox(leAbsBox(n)) };
}

// --- export ------------------------------------------------------------------

async function leExport(n, p) {
  var format = String(p.format || 'PNG').toUpperCase();
  if (format === 'JPEG') format = 'JPG';
  if (['PNG', 'JPG', 'SVG', 'PDF'].indexOf(format) < 0) throw new Error('Unsupported format: ' + format);
  if (!('exportAsync' in n)) throw new Error(n.type + ' cannot be exported');
  var useAbs = !!p.useAbsoluteBounds;
  var out = { id: n.id, name: n.name, type: n.type, format: format };

  if (format === 'SVG') {
    var svgOpts = { format: 'SVG_STRING' };
    if (useAbs) svgOpts.useAbsoluteBounds = true;
    if (p.svgOutlineText !== undefined) svgOpts.svgOutlineText = p.svgOutlineText;
    if (p.svgIdAttribute !== undefined) svgOpts.svgIdAttribute = p.svgIdAttribute;
    out.svg = await n.exportAsync(svgOpts);
    var sb = leAbsBox(n);
    out.width = round(sb.width); out.height = round(sb.height);
    return out;
  }

  var box = useAbs ? leAbsBox(n) : (n.absoluteRenderBounds || leAbsBox(n));
  var opts = { format: format };
  if (useAbs) opts.useAbsoluteBounds = true;
  if (format === 'PDF') {
    out.bytes = await n.exportAsync(opts);
    out.width = round(box.width); out.height = round(box.height);
    return out;
  }
  var scale = p.scale === undefined ? 1 : Number(p.scale);
  var maxDim = p.maxDimension === undefined ? LE_MAX_DIM_DEFAULT : Number(p.maxDimension);
  var longest = Math.max(box.width, box.height);
  if (maxDim > 0 && longest * scale > maxDim) {
    out.requestedScale = scale;
    scale = Math.floor((maxDim / longest) * 10000) / 10000;
    out.downscaled = true;
  }
  if (!(scale > 0)) throw new Error('Node is empty or invalid scale');
  opts.constraint = { type: 'SCALE', value: scale };
  out.bytes = await n.exportAsync(opts);
  out.scale = scale;
  out.width = Math.round(box.width * scale);
  out.height = Math.round(box.height * scale);
  return out;
}

function leFirstSelected() {
  var sel = figma.currentPage.selection;
  if (!sel.length) throw new Error('No nodeId given and nothing is selected');
  return sel[0];
}

H.get_screenshot = async function (p) {
  var n = p.nodeId ? await node(p.nodeId) : leFirstSelected();
  var r = await leExport(n, p);
  if (r.bytes) { r.base64 = figma.base64Encode(r.bytes); delete r.bytes; }
  return r;
};

// Single-node export used by the server's save_screenshots (keeps each WebSocket message small).
H.export_node_bytes = async function (p) {
  var n = await node(p.nodeId);
  var r = await leExport(n, p);
  if (r.bytes) { r.base64 = figma.base64Encode(r.bytes); delete r.bytes; }
  return r;
};

// --- positioning -------------------------------------------------------------------

H.place_relative = async function (p) {
  var n = await node(p.nodeId);
  var ref = await node(p.relativeToId);
  leAssertMovable(n);
  var side = p.side || 'right', gap = p.gap || 0, align = p.align || 'start';
  var R = leAbsBox(ref), N = leAbsBox(n);
  function alignOn(start, refSize, size) {
    if (align === 'center') return start + (refSize - size) / 2;
    if (align === 'end') return start + refSize - size;
    return start;
  }
  var x, y;
  if (side === 'right') { x = R.x + R.width + gap; y = alignOn(R.y, R.height, N.height); }
  else if (side === 'left') { x = R.x - gap - N.width; y = alignOn(R.y, R.height, N.height); }
  else if (side === 'below') { y = R.y + R.height + gap; x = alignOn(R.x, R.width, N.width); }
  else if (side === 'above') { y = R.y - gap - N.height; x = alignOn(R.x, R.width, N.width); }
  else throw new Error('Invalid side: ' + side);
  leMoveAbsTo(n, x, y);
  return lePos(n);
};

H.distribute_nodes = async function (p) {
  var ns = await nodes(p.nodeIds);
  var horiz = (p.axis || 'horizontal') === 'horizontal';
  var results = [];
  var items = [];
  ns.forEach(function (n) {
    try { leAssertMovable(n); items.push({ n: n, b: leAbsBox(n) }); }
    catch (e) { results.push({ id: n.id, error: e.message }); }
  });
  if (items.length < 2) throw new Error('Need at least 2 movable nodes (3 to equalise spacing)');
  var pos = horiz ? 'x' : 'y', size = horiz ? 'width' : 'height';
  items.sort(function (a, b) { return a.b[pos] - b.b[pos]; });
  var gap;
  if (p.gap !== undefined) gap = p.gap;
  else {
    if (items.length < 3) throw new Error('Need at least 3 movable nodes to equalise spacing (or pass gap)');
    var first = items[0].b, last = items[items.length - 1].b;
    var span = last[pos] + last[size] - first[pos];
    var total = items.reduce(function (s, it) { return s + it.b[size]; }, 0);
    gap = (span - total) / (items.length - 1);
  }
  var cursor = items[0].b[pos];
  items.forEach(function (it) {
    try {
      if (horiz) leMoveAbsTo(it.n, cursor, undefined); else leMoveAbsTo(it.n, undefined, cursor);
      cursor += it.b[size] + gap;
      results.push(lePos(it.n));
    } catch (e) { results.push({ id: it.n.id, error: e.message }); }
  });
  return { axis: horiz ? 'horizontal' : 'vertical', gap: round(gap), results: results };
};

H.align_nodes = async function (p) {
  var ns = await nodes(p.nodeIds);
  var to = p.to || 'selection';
  var align = p.align;
  if (['left', 'hcenter', 'right', 'top', 'vcenter', 'bottom'].indexOf(align) < 0) throw new Error('Invalid align: ' + align);
  var fixedTarget = null, targetNodeId = null;
  if (to === 'selection') fixedTarget = leUnion(ns.map(leAbsBox));
  else if (to !== 'parent') { var tn = await node(to); fixedTarget = leAbsBox(tn); targetNodeId = tn.id; }
  var results = [];
  ns.forEach(function (n) {
    try {
      if (n.id === targetNodeId) { results.push({ id: n.id, skipped: 'alignment target' }); return; }
      leAssertMovable(n);
      var T = fixedTarget;
      if (!T) {
        if (!n.parent || n.parent.type === 'PAGE') throw new Error('Node has no parent frame to align to');
        T = leAbsBox(n.parent);
      }
      var b = leAbsBox(n), x, y;
      if (align === 'left') x = T.x;
      else if (align === 'hcenter') x = T.x + (T.width - b.width) / 2;
      else if (align === 'right') x = T.x + T.width - b.width;
      else if (align === 'top') y = T.y;
      else if (align === 'vcenter') y = T.y + (T.height - b.height) / 2;
      else y = T.y + T.height - b.height;
      leMoveAbsTo(n, x, y);
      results.push(lePos(n));
    } catch (e) { results.push({ id: n.id, error: e.message }); }
  });
  return { align: align, to: to, results: results };
};

H.arrange_grid = async function (p) {
  var ns = await nodes(p.nodeIds);
  var cols = Math.max(1, Math.floor(p.columns || 1));
  var gapX = p.gapX === undefined ? 0 : p.gapX, gapY = p.gapY === undefined ? 0 : p.gapY;
  var results = [], items = [];
  ns.forEach(function (n) {
    try { leAssertMovable(n); items.push({ n: n, b: leAbsBox(n) }); }
    catch (e) { results.push({ id: n.id, error: e.message }); }
  });
  if (!items.length) return { results: results };
  var u = leUnion(items.map(function (it) { return it.b; }));
  var ox = p.x === undefined ? u.x : p.x, oy = p.y === undefined ? u.y : p.y;
  var colW = [], rowH = [];
  items.forEach(function (it, i) {
    var c = i % cols, r = Math.floor(i / cols);
    colW[c] = Math.max(colW[c] || 0, it.b.width);
    rowH[r] = Math.max(rowH[r] || 0, it.b.height);
  });
  var colX = [ox], rowY = [oy];
  for (var c = 1; c < colW.length; c++) colX[c] = colX[c - 1] + colW[c - 1] + gapX;
  for (var r = 1; r < rowH.length; r++) rowY[r] = rowY[r - 1] + rowH[r - 1] + gapY;
  items.forEach(function (it, i) {
    try {
      leMoveAbsTo(it.n, colX[i % cols], rowY[Math.floor(i / cols)]);
      results.push(lePos(it.n));
    } catch (e) { results.push({ id: it.n.id, error: e.message }); }
  });
  return { columns: cols, rows: rowH.length, origin: { x: round(ox), y: round(oy) }, results: results };
};

H.align_to_grid = async function (p) {
  var g = Number(p.gridSize);
  if (!(g > 0)) throw new Error('gridSize must be > 0');
  function snap(v) { return Math.round(v / g) * g; }
  var ns = await nodes(p.nodeIds);
  var results = [];
  ns.forEach(function (n) {
    try {
      leAssertMovable(n);
      var before = { x: round(n.x), y: round(n.y), width: round(n.width), height: round(n.height) };
      n.x = snap(n.x); n.y = snap(n.y);
      if (p.snapSize) {
        if (!('resize' in n)) throw new Error(n.type + ' cannot be resized');
        n.resize(Math.max(g, snap(n.width)), Math.max(g, snap(n.height)));
      }
      results.push({ id: n.id, name: n.name, before: before, after: { x: round(n.x), y: round(n.y), width: round(n.width), height: round(n.height) } });
    } catch (e) { results.push({ id: n.id, error: e.message }); }
  });
  return { gridSize: g, results: results };
};

H.set_constraints = async function (p) {
  if (!p.horizontal && !p.vertical) throw new Error('Pass horizontal and/or vertical');
  var ns = await nodes(p.nodeIds);
  var results = [];
  ns.forEach(function (n) {
    try {
      if (!('constraints' in n)) throw new Error(n.type + ' does not support constraints');
      if (leInAutoLayout(n)) throw new Error('Auto layout child (not absolutely positioned): constraints do not apply');
      var prev = { horizontal: n.constraints.horizontal, vertical: n.constraints.vertical };
      n.constraints = { horizontal: p.horizontal || prev.horizontal, vertical: p.vertical || prev.vertical };
      results.push({ id: n.id, name: n.name, previous: prev, constraints: { horizontal: n.constraints.horizontal, vertical: n.constraints.vertical } });
    } catch (e) { results.push({ id: n.id, error: e.message }); }
  });
  return results;
};

// --- inspection / viewport -----------------------------------------------------------

H.get_layout_tree = async function (p) {
  var root = p.rootId ? await node(p.rootId) : figma.currentPage;
  if (root.type === 'PAGE') await root.loadAsync();
  var max = p.maxNodes || 2000;
  var maxDepth = p.maxDepth === undefined ? Infinity : p.maxDepth;
  var includeHidden = p.includeHidden !== false;
  var out = [];
  var truncated = false;
  // iterative pre-order DFS
  var stack = [{ n: root, depth: 0, parentId: root.parent ? root.parent.id : null }];
  while (stack.length) {
    var it = stack.pop();
    var n = it.n;
    if (!includeHidden && n.visible === false && n !== root) continue;
    if (out.length >= max) { truncated = true; break; }
    var o = { id: n.id, name: n.name, type: n.type, parentId: it.parentId, depth: it.depth };
    if (n.type !== 'PAGE' && n.type !== 'DOCUMENT') {
      try {
        var bb = n.absoluteBoundingBox || null;
        o.x = bb ? round(bb.x) : null; o.y = bb ? round(bb.y) : null;
        o.width = bb ? round(bb.width) : round(n.width); o.height = bb ? round(bb.height) : round(n.height);
        if ('absoluteRenderBounds' in n) o.absoluteRenderBounds = leRoundBox(n.absoluteRenderBounds);
        if ('rotation' in n && n.rotation) o.rotation = round(n.rotation);
        o.visible = n.visible !== false;
        if ('layoutMode' in n && n.layoutMode !== 'NONE') {
          o.layoutMode = n.layoutMode;
          o.itemSpacing = n.itemSpacing;
          o.padding = [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft];
          if (n.layoutWrap === 'WRAP') o.layoutWrap = 'WRAP';
        }
        var parentAL = n.parent && 'layoutMode' in n.parent && n.parent.layoutMode && n.parent.layoutMode !== 'NONE';
        if (parentAL && 'layoutPositioning' in n) o.layoutPositioning = n.layoutPositioning;
        if ('layoutSizingHorizontal' in n && (parentAL || o.layoutMode)) {
          o.sizing = { h: n.layoutSizingHorizontal, v: n.layoutSizingVertical };
        }
        if ('constraints' in n && !parentAL) o.constraints = n.constraints;
        if ('clipsContent' in n && n.clipsContent) o.clipsContent = true;
      } catch (e) { o.error = e.message; }
    }
    out.push(o);
    if ('children' in n && it.depth < maxDepth) {
      for (var i = n.children.length - 1; i >= 0; i--) stack.push({ n: n.children[i], depth: it.depth + 1, parentId: n.id });
    }
  }
  return { rootId: root.id, count: out.length, truncated: truncated, nodes: out };
};

H.scroll_into_view = async function (p) {
  var ns = await nodes(p.nodeIds);
  var page = pageOf(ns[0]);
  var switched = false;
  if (page && page.id !== figma.currentPage.id) { await figma.setCurrentPageAsync(page); switched = true; }
  var onPage = ns.filter(function (n) { return pageOf(n) === figma.currentPage && n.type !== 'PAGE'; });
  if (!onPage.length) throw new Error('No scrollable nodes on page ' + figma.currentPage.name);
  if (p.zoom !== undefined) {
    var u = leUnion(onPage.map(leAbsBox));
    figma.viewport.center = { x: u.x + u.width / 2, y: u.y + u.height / 2 };
    figma.viewport.zoom = p.zoom;
  } else {
    figma.viewport.scrollAndZoomIntoView(onPage);
  }
  var skipped = ns.filter(function (n) { return onPage.indexOf(n) < 0; }).map(function (n) { return n.id; });
  return {
    page: { id: figma.currentPage.id, name: figma.currentPage.name, switched: switched },
    nodes: onPage.map(function (n) { return n.id; }),
    skipped: skipped.length ? skipped : undefined,
    viewport: { center: { x: round(figma.viewport.center.x), y: round(figma.viewport.center.y) }, zoom: round(figma.viewport.zoom) },
  };
};
