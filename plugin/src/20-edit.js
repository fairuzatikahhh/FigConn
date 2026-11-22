// ---------------------------------------------------------------------------
// 20-edit — editing & structure tools (auto layout, layout children, effects,
// gradients, strokes, duplicate, group/ungroup, reparent, reorder).
// Shares scope with 00-core.js. Helpers here are prefixed `ed` to avoid
// collisions with other concatenated source files.
// ---------------------------------------------------------------------------

// Run fn(node) for each id; never abort the batch. fn may return extra fields to merge into the result.
async function edEach(ids, fn) {
  var results = [];
  for (var i = 0; i < ids.length; i++) {
    var id = ids[i];
    try {
      var n = await node(id);
      var extra = await fn(n, i);
      var r = { id: n.id, ok: true };
      if (extra && typeof extra === 'object') Object.keys(extra).forEach(function (k) { r[k] = extra[k]; });
      results.push(r);
    } catch (e) {
      results.push({ id: id, error: (e && e.message) ? e.message : String(e) });
    }
  }
  return results;
}

function edIsAutoLayout(n) {
  return !!n && 'layoutMode' in n && n.layoutMode !== 'NONE';
}
function edSupportsAutoLayout(n) {
  return n.type === 'FRAME' || n.type === 'COMPONENT' || n.type === 'COMPONENT_SET' || n.type === 'INSTANCE';
}

// --- 2x3 affine matrix helpers ([[a,b,tx],[c,d,ty]]) ---------------------------
function edMul(A, B) {
  return [
    [A[0][0] * B[0][0] + A[0][1] * B[1][0], A[0][0] * B[0][1] + A[0][1] * B[1][1], A[0][0] * B[0][2] + A[0][1] * B[1][2] + A[0][2]],
    [A[1][0] * B[0][0] + A[1][1] * B[1][0], A[1][0] * B[0][1] + A[1][1] * B[1][1], A[1][0] * B[0][2] + A[1][1] * B[1][2] + A[1][2]],
  ];
}
function edInv(M) {
  var a = M[0][0], b = M[0][1], c = M[1][0], d = M[1][1], tx = M[0][2], ty = M[1][2];
  var det = a * d - b * c;
  if (!det) throw new Error('Non-invertible transform');
  return [
    [d / det, -b / det, (b * ty - d * tx) / det],
    [-c / det, a / det, (c * tx - a * ty) / det],
  ];
}
function edCopyT(M) { return [[M[0][0], M[0][1], M[0][2]], [M[1][0], M[1][1], M[1][2]]]; }

// Is n's position controlled by an auto-layout parent?
function edLaidOut(n) {
  return edIsAutoLayout(n.parent) && n.layoutPositioning !== 'ABSOLUTE';
}

// After n was moved, restore its previous absolute transform (unless an auto-layout parent controls it).
// Works for any container (frames, pages, groups — which share their parent's coordinate space).
function edRestoreAbs(n, abs) {
  if (edLaidOut(n)) return;
  var containerAbs = edMul(n.absoluteTransform, edInv(n.relativeTransform));
  n.relativeTransform = edMul(edInv(containerAbs), abs);
}

// Absolute axis-aligned bounds of a node from its absolute transform and size.
function edAbsBounds(n) {
  var t = n.absoluteTransform, w = n.width, h = n.height;
  var pts = [[0, 0], [w, 0], [0, h], [w, h]].map(function (p) {
    return [t[0][0] * p[0] + t[0][1] * p[1] + t[0][2], t[1][0] * p[0] + t[1][1] * p[1] + t[1][2]];
  });
  var xs = pts.map(function (p) { return p[0]; }), ys = pts.map(function (p) { return p[1]; });
  return { minX: Math.min.apply(null, xs), minY: Math.min.apply(null, ys), maxX: Math.max.apply(null, xs), maxY: Math.max.apply(null, ys) };
}

function edPadding(v) {
  if (typeof v === 'number') return [v, v, v, v];
  if (Array.isArray(v)) {
    if (v.length === 2) return [v[0], v[1], v[0], v[1]];
    if (v.length === 4) return v;
    throw new Error('padding array must be [vertical, horizontal] or [top, right, bottom, left]');
  }
  if (v && typeof v === 'object') return [v.top, v.right, v.bottom, v.left];
  throw new Error('Invalid padding');
}

// ---------------------------------------------------------------------------
// set_auto_layout
// ---------------------------------------------------------------------------
H.set_auto_layout = async function (p) {
  return edEach(p.nodeIds, function (n) {
    if (!edSupportsAutoLayout(n)) throw new Error(n.type + ' does not support auto layout (use a frame, component or instance)');
    var notes = [];
    if (p.mode !== undefined) n.layoutMode = p.mode;
    var isAL = n.layoutMode !== 'NONE';
    var wantsLayoutProps = p.gap !== undefined || p.counterGap !== undefined || p.primaryAlign !== undefined || p.counterAlign !== undefined ||
      p.primarySizing !== undefined || p.counterSizing !== undefined || p.wrap !== undefined || p.strokesIncludedInLayout !== undefined;
    if (!isAL && wantsLayoutProps) throw new Error('Node has no auto layout; pass mode HORIZONTAL or VERTICAL');
    if (p.wrap !== undefined) {
      if (p.wrap && n.layoutMode !== 'HORIZONTAL') throw new Error('wrap is only supported for HORIZONTAL auto layout');
      n.layoutWrap = p.wrap ? 'WRAP' : 'NO_WRAP';
    }
    if (p.gap !== undefined) {
      if (p.gap === 'AUTO') n.primaryAxisAlignItems = 'SPACE_BETWEEN';
      else {
        n.itemSpacing = p.gap;
        if (p.primaryAlign === undefined && n.primaryAxisAlignItems === 'SPACE_BETWEEN') {
          n.primaryAxisAlignItems = 'MIN';
          notes.push('primaryAlign reset from SPACE_BETWEEN to MIN so the fixed gap applies');
        }
      }
    }
    if (p.counterGap !== undefined) {
      if (n.layoutWrap !== 'WRAP') throw new Error('counterGap requires wrap: true');
      n.counterAxisSpacing = p.counterGap;
    }
    if (p.padding !== undefined) {
      var pd = edPadding(p.padding);
      if (pd[0] !== undefined) n.paddingTop = pd[0];
      if (pd[1] !== undefined) n.paddingRight = pd[1];
      if (pd[2] !== undefined) n.paddingBottom = pd[2];
      if (pd[3] !== undefined) n.paddingLeft = pd[3];
    }
    if (p.primaryAlign !== undefined) n.primaryAxisAlignItems = p.primaryAlign;
    if (p.counterAlign !== undefined) n.counterAxisAlignItems = p.counterAlign;
    if (p.primarySizing !== undefined) n.primaryAxisSizingMode = p.primarySizing === 'HUG' ? 'AUTO' : 'FIXED';
    if (p.counterSizing !== undefined) n.counterAxisSizingMode = p.counterSizing === 'HUG' ? 'AUTO' : 'FIXED';
    if (p.clipsContent !== undefined) n.clipsContent = p.clipsContent;
    if (p.strokesIncludedInLayout !== undefined) n.strokesIncludedInLayout = p.strokesIncludedInLayout;
    var r = { node: ser(n, 0) };
    if (r.node.layout && n.layoutWrap === 'WRAP') { r.node.layout.wrap = true; r.node.layout.counterGap = n.counterAxisSpacing; }
    if (r.node.layout && 'clipsContent' in n) r.node.layout.clipsContent = n.clipsContent;
    if (notes.length) r.notes = notes;
    return r;
  });
};

// ---------------------------------------------------------------------------
// set_layout_child
// ---------------------------------------------------------------------------
H.set_layout_child = async function (p) {
  return edEach(p.nodeIds, function (n) {
    var parent = n.parent;
    var parentAL = edIsAutoLayout(parent);
    var parentDesc = parent ? (parent.name + ' (' + parent.type + ')') : 'none';
    function needParentAL(what) {
      if (!parentAL) throw new Error(what + ' requires the parent to be an auto-layout frame; parent ' + parentDesc + ' has no auto layout. Use set_auto_layout on the parent first.');
    }
    if (p.positioning !== undefined) {
      needParentAL('positioning');
      n.layoutPositioning = p.positioning;
    }
    if (p.grow !== undefined) { needParentAL('grow'); n.layoutGrow = p.grow; }
    if (p.alignSelf !== undefined) { needParentAL('alignSelf'); n.layoutAlign = p.alignSelf; }
    function sizing(prop, v) {
      if (v === 'FILL') {
        needParentAL('FILL sizing');
        if (n.layoutPositioning === 'ABSOLUTE') throw new Error('FILL is not allowed on absolutely positioned children');
      }
      if (v === 'HUG' && !(edIsAutoLayout(n) || n.type === 'TEXT')) {
        throw new Error('HUG sizing only applies to auto-layout frames and text nodes (' + n.name + ' is ' + n.type + (edSupportsAutoLayout(n) ? ' without auto layout' : '') + ')');
      }
      if (!('layoutSizingHorizontal' in n)) throw new Error(n.type + ' does not support layout sizing');
      n[prop] = v;
    }
    if (p.horizontal !== undefined) sizing('layoutSizingHorizontal', p.horizontal);
    if (p.vertical !== undefined) sizing('layoutSizingVertical', p.vertical);
    ['minWidth', 'maxWidth', 'minHeight', 'maxHeight'].forEach(function (k) {
      if (p[k] === undefined) return;
      if (!parentAL && !edIsAutoLayout(n)) throw new Error(k + ' only applies to auto-layout frames or children of auto-layout frames');
      n[k] = p[k];
    });
    var r = { node: ser(n, 0) };
    if ('layoutSizingHorizontal' in n) {
      r.layout = { horizontal: n.layoutSizingHorizontal, vertical: n.layoutSizingVertical };
      if (parentAL) { r.layout.positioning = n.layoutPositioning; r.layout.grow = n.layoutGrow; r.layout.alignSelf = n.layoutAlign; }
      ['minWidth', 'maxWidth', 'minHeight', 'maxHeight'].forEach(function (k) { if (n[k] !== null && n[k] !== undefined) r.layout[k] = n[k]; });
    }
    return r;
  });
};

// ---------------------------------------------------------------------------
// set_effects
// ---------------------------------------------------------------------------
function edEffect(e) {
  var type = e.type || 'DROP_SHADOW';
  var visible = e.visible === undefined ? true : e.visible;
  if (type === 'LAYER_BLUR' || type === 'BACKGROUND_BLUR') {
    return { type: type, radius: e.blur !== undefined ? e.blur : 4, visible: visible };
  }
  if (type !== 'DROP_SHADOW' && type !== 'INNER_SHADOW') throw new Error('Unknown effect type: ' + type);
  var out = {
    type: type,
    color: rgb(e.color || '#00000040'),
    offset: { x: e.x !== undefined ? e.x : 0, y: e.y !== undefined ? e.y : 4 },
    radius: e.blur !== undefined ? e.blur : 4,
    spread: e.spread || 0,
    visible: visible,
    blendMode: e.blendMode || 'NORMAL',
  };
  if (type === 'DROP_SHADOW' && e.showShadowBehindNode !== undefined) out.showShadowBehindNode = e.showShadowBehindNode;
  return out;
}
function edEffectSummary(e) {
  var o = { type: e.type, visible: e.visible };
  if (e.type === 'DROP_SHADOW' || e.type === 'INNER_SHADOW') {
    o.color = toHex(e.color, e.color.a); o.x = e.offset.x; o.y = e.offset.y; o.blur = e.radius; o.spread = e.spread || 0;
  } else o.blur = e.radius;
  return o;
}

H.set_effects = async function (p) {
  var effects = (p.effects || []).map(edEffect);
  return edEach(p.nodeIds, function (n) {
    if (!('effects' in n)) throw new Error(n.type + ' does not support effects');
    n.effects = p.mode === 'append' ? n.effects.slice().concat(effects) : effects;
    return { effects: n.effects.map(edEffectSummary) };
  });
};

// ---------------------------------------------------------------------------
// set_gradient
// ---------------------------------------------------------------------------
// angle in degrees in the node's normalized (0..1) box: 0 = left→right, 90 = top→bottom,
// 45 = top-left corner → bottom-right corner. For LINEAR the gradient line is scaled so the
// extreme corners land on 0% / 100% (like CSS); other types are only rotated about the center.
function edGradientTransform(angle, type) {
  var rad = angle * Math.PI / 180;
  var c = Math.cos(rad), s = Math.sin(rad);
  if (Math.abs(c) < 1e-12) c = 0;
  if (Math.abs(s) < 1e-12) s = 0;
  var L = type === 'LINEAR' ? (Math.abs(c) + Math.abs(s)) : 1;
  return [
    [c / L, s / L, 0.5 - 0.5 * (c + s) / L],
    [-s, c, 0.5 + 0.5 * s - 0.5 * c],
  ];
}

H.set_gradient = async function (p) {
  var type = p.type || 'LINEAR';
  if (!p.stops || p.stops.length < 2) throw new Error('A gradient needs at least 2 stops');
  var transform = p.transform ? p.transform : edGradientTransform(p.angle !== undefined ? p.angle : (type === 'LINEAR' ? 90 : 0), type);
  var stops = p.stops.map(function (s) {
    if (s.position < 0 || s.position > 1) throw new Error('Stop position must be between 0 and 1');
    return { position: s.position, color: rgb(s.color) };
  });
  var paint = { type: 'GRADIENT_' + type, gradientTransform: transform, gradientStops: stops, visible: true };
  if (p.opacity !== undefined) paint.opacity = p.opacity;
  var prop = p.target === 'stroke' ? 'strokes' : 'fills';
  return edEach(p.nodeIds, function (n) {
    if (!(prop in n)) throw new Error(n.type + ' has no ' + prop);
    var cur = n[prop];
    if (p.mode === 'append') {
      if (cur === figma.mixed) throw new Error('Cannot append to mixed ' + prop + ' (text with multiple paints); use mode replace');
      n[prop] = cur.slice().concat([paint]);
    } else n[prop] = [paint];
    var out = {};
    out[prop] = n[prop].map(paintSummary);
    return out;
  });
};

// ---------------------------------------------------------------------------
// set_stroke
// ---------------------------------------------------------------------------
H.set_stroke = async function (p) {
  return edEach(p.nodeIds, function (n) {
    if (!('strokes' in n)) throw new Error(n.type + ' does not support strokes');
    if (p.color !== undefined) n.strokes = paintList(p.color);
    if (p.weight !== undefined) n.strokeWeight = p.weight;
    if (p.sides) {
      if (!('strokeTopWeight' in n)) throw new Error('Per-side stroke weights are only supported on frames, components, instances and rectangles');
      if (p.sides.top !== undefined) n.strokeTopWeight = p.sides.top;
      if (p.sides.right !== undefined) n.strokeRightWeight = p.sides.right;
      if (p.sides.bottom !== undefined) n.strokeBottomWeight = p.sides.bottom;
      if (p.sides.left !== undefined) n.strokeLeftWeight = p.sides.left;
    }
    if (p.align !== undefined) n.strokeAlign = p.align;
    if (p.dashPattern !== undefined) n.dashPattern = p.dashPattern;
    if (p.cap !== undefined) {
      if (!('strokeCap' in n)) throw new Error(n.type + ' does not support strokeCap');
      n.strokeCap = p.cap;
    }
    if (p.join !== undefined) n.strokeJoin = p.join;
    var r = { strokes: n.strokes.map(paintSummary), weight: n.strokeWeight === figma.mixed ? 'mixed' : n.strokeWeight, align: n.strokeAlign };
    if ('strokeTopWeight' in n && n.strokeWeight === figma.mixed) {
      r.sides = { top: n.strokeTopWeight, right: n.strokeRightWeight, bottom: n.strokeBottomWeight, left: n.strokeLeftWeight };
    }
    if (n.dashPattern && n.dashPattern.length) r.dashPattern = n.dashPattern;
    return r;
  });
};

// ---------------------------------------------------------------------------
// duplicate_nodes
// ---------------------------------------------------------------------------
H.duplicate_nodes = async function (p) {
  var count = p.count === undefined ? 1 : p.count;
  var dx = p.offsetX || 0, dy = p.offsetY || 0;
  var target = p.parentId ? await node(p.parentId) : null;
  if (target && !('appendChild' in target)) throw new Error('Node ' + p.parentId + ' cannot have children');
  return edEach(p.nodeIds, function (n) {
    if (n.type === 'PAGE' || n.type === 'DOCUMENT') throw new Error('Cannot duplicate a ' + n.type + ' with this tool');
    var clones = [];
    var last = n;
    for (var k = 1; k <= count; k++) {
      // clone() puts the copy on figma.currentPage, not in the original's parent,
      // so always place it explicitly.
      var c = n.clone();
      if (target) {
        target.appendChild(c);
      } else if (n.parent && 'insertChild' in n.parent) {
        // same parent as the original, directly above the previous copy in z-order
        var idx = n.parent.children.indexOf(last);
        n.parent.insertChild(idx >= 0 ? idx + 1 : n.parent.children.length, c);
      }
      if (!edLaidOut(c)) {
        c.x = n.x + dx * k;
        c.y = n.y + dy * k;
      }
      clones.push(ser(c, 0));
      last = c;
    }
    return { clones: clones };
  });
};

// ---------------------------------------------------------------------------
// group_nodes
// ---------------------------------------------------------------------------
H.group_nodes = async function (p) {
  var ns = await nodes(p.nodeIds);
  var parent = ns[0].parent;
  if (!parent) throw new Error('Node ' + ns[0].id + ' has no parent');
  ns.forEach(function (n) {
    if (n.parent !== parent) throw new Error('All nodes must share the same parent (' + n.id + ' is in ' + (n.parent ? n.parent.id : 'none') + ', expected ' + parent.id + ')');
  });
  // keep z-order: sort by current index; place the wrapper where the topmost node was
  var kids = parent.children;
  ns.sort(function (a, b) { return kids.indexOf(a) - kids.indexOf(b); });
  var top = kids.indexOf(ns[ns.length - 1]);
  var insertAt = 0;
  for (var i = 0; i < top; i++) if (ns.indexOf(kids[i]) < 0) insertAt++;

  var wrapper;
  if (!p.asFrame) {
    wrapper = figma.group(ns, parent);
    if (parent.children.indexOf(wrapper) !== insertAt) parent.insertChild(insertAt, wrapper);
  } else {
    var abs = ns.map(function (n) { return edCopyT(n.absoluteTransform); });
    var b = ns.map(edAbsBounds).reduce(function (a, c) {
      return { minX: Math.min(a.minX, c.minX), minY: Math.min(a.minY, c.minY), maxX: Math.max(a.maxX, c.maxX), maxY: Math.max(a.maxY, c.maxY) };
    });
    wrapper = figma.createFrame();
    wrapper.fills = [];
    wrapper.clipsContent = false;
    wrapper.resize(Math.max(0.01, b.maxX - b.minX), Math.max(0.01, b.maxY - b.minY));
    parent.insertChild(insertAt, wrapper);
    edRestoreAbs(wrapper, [[1, 0, b.minX], [0, 1, b.minY]]);
    for (var j = 0; j < ns.length; j++) {
      wrapper.appendChild(ns[j]);
      edRestoreAbs(ns[j], abs[j]);
    }
  }
  if (p.name) wrapper.name = p.name;
  return ser(wrapper, 1);
};

// ---------------------------------------------------------------------------
// ungroup_node
// ---------------------------------------------------------------------------
H.ungroup_node = async function (p) {
  return edEach(p.nodeIds, function (n) {
    var parent = n.parent;
    if (!parent) throw new Error('Node has no parent');
    var childIds;
    if (n.type === 'GROUP') {
      childIds = figma.ungroup(n).map(function (c) { return c.id; });
    } else if (n.type === 'FRAME' || n.type === 'SECTION') {
      if (!('insertChild' in parent)) throw new Error('Parent cannot hold children');
      var kids = n.children.slice();
      var abs = kids.map(function (c) { return edCopyT(c.absoluteTransform); });
      var at = parent.children.indexOf(n);
      for (var i = 0; i < kids.length; i++) {
        parent.insertChild(at + 1 + i, kids[i]); // above the frame, preserving z-order
        edRestoreAbs(kids[i], abs[i]);
      }
      n.remove();
      childIds = kids.map(function (c) { return c.id; });
    } else {
      throw new Error('Only GROUP, FRAME or SECTION can be ungrouped (got ' + n.type + ')');
    }
    return { children: childIds, parentId: parent.id };
  });
};

// ---------------------------------------------------------------------------
// reparent_nodes
// ---------------------------------------------------------------------------
H.reparent_nodes = async function (p) {
  var parent = await node(p.parentId);
  if (!('insertChild' in parent)) throw new Error('Node ' + p.parentId + ' (' + parent.type + ') cannot have children');
  var keep = p.keepPosition === undefined ? true : p.keepPosition;
  var nextIndex = p.index;
  return edEach(p.nodeIds, function (n) {
    var abs = edCopyT(n.absoluteTransform);
    if (nextIndex !== undefined) {
      var idx = Math.max(0, Math.min(nextIndex, parent.children.length));
      parent.insertChild(idx, n);
      nextIndex = parent.children.indexOf(n) + 1;
    } else {
      parent.appendChild(n);
    }
    if (keep) edRestoreAbs(n, abs);
    return { parentId: parent.id, index: parent.children.indexOf(n), x: round(n.x), y: round(n.y) };
  });
};

// ---------------------------------------------------------------------------
// reorder_nodes
// ---------------------------------------------------------------------------
// Move n to final index t within its parent (handles either insertChild index convention).
function edMoveTo(n, t) {
  var parent = n.parent;
  var old = parent.children.indexOf(n);
  if (old === t) return;
  parent.insertChild(t, n);
  if (old < t && parent.children.indexOf(n) !== t) parent.insertChild(t + 1, n);
}

H.reorder_nodes = async function (p) {
  var to = p.to;
  var ns = [];
  var results = [];
  for (var i = 0; i < p.nodeIds.length; i++) {
    try { ns.push(await node(p.nodeIds[i])); } catch (e) { results.push({ id: p.nodeIds[i], error: e.message }); }
  }
  function idx(n) { return n.parent ? n.parent.children.indexOf(n) : -1; }
  // Process order so multiple siblings don't leapfrog each other.
  if (to === 'front' || to === 'backward') ns.sort(function (a, b) { return idx(a) - idx(b); });
  else if (to === 'back' || to === 'forward') ns.sort(function (a, b) { return idx(b) - idx(a); });
  for (var j = 0; j < ns.length; j++) {
    var n = ns[j];
    try {
      var parent = n.parent;
      if (!parent || !('insertChild' in parent)) throw new Error('Node has no reorderable parent');
      var len = parent.children.length, cur = parent.children.indexOf(n);
      var t;
      if (to === 'front') t = len - 1;
      else if (to === 'back') t = 0;
      else if (to === 'forward' || to === 'backward') {
        t = Math.max(0, Math.min(len - 1, cur + (to === 'forward' ? 1 : -1)));
        // a selected neighbour that is already blocked at the edge blocks this node too (no swapping among the selection)
        if (ns.indexOf(parent.children[t]) >= 0) t = cur;
      } else if (typeof to === 'number') t = Math.max(0, Math.min(len - 1, Math.floor(to)));
      else throw new Error('Invalid `to`: ' + to);
      if (to === 'front') parent.appendChild(n);
      else edMoveTo(n, t);
      results.push({ id: n.id, ok: true, index: parent.children.indexOf(n), siblings: parent.children.length });
    } catch (e) {
      results.push({ id: n.id, error: e.message });
    }
  }
  return results;
};
