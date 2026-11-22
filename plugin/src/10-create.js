// --- creation tools: shapes, SVG, images, pages, sections ----------------------
// Plain ES2017. Shares scope with 00-core.js (node, nodes, ser, rgb, hexPaint, paintList, appendTo, ...).

// Resize a freshly created node to (w, h). When only one dimension is given the other is
// derived from the aspect ratio. `scaleChildren` uses rescale() so vector content scales too.
function crSizeTo(n, w, h, scaleChildren) {
  if (w === undefined && h === undefined) return;
  var cw = n.width || 1, ch = n.height || 1;
  var tw = w !== undefined ? w : cw * (h / ch);
  var th = h !== undefined ? h : ch * (w / cw);
  if (!scaleChildren) { n.resize(Math.max(tw, 0.01), Math.max(th, 0.01)); return; }
  // Proportional scale first (scales strokes/vectors inside), then stretch the remaining axis.
  var f = tw / cw;
  if (Math.abs(f - 1) > 1e-6) n.rescale(f);
  if (Math.abs(n.height - th) > 0.01) {
    if ('children' in n) {
      n.children.forEach(function (c) {
        if ('constraints' in c) c.constraints = { horizontal: 'SCALE', vertical: 'SCALE' };
      });
    }
    n.resize(Math.max(n.width, 0.01), Math.max(th, 0.01));
  }
}

function crBBox(c) {
  var b = c.absoluteBoundingBox;
  if (b) return b;
  return { x: c.absoluteTransform[0][2], y: c.absoluteTransform[1][2], width: c.width, height: c.height };
}

// Move `child` into `container` keeping its absolute position/rotation on canvas.
function crReparentKeepPosition(child, container) {
  var t = child.absoluteTransform;
  container.appendChild(child);
  var ct = container.absoluteTransform;
  // Containers we use here (sections / non-rotated frames) have no rotation: translate only.
  child.relativeTransform = [
    [t[0][0], t[0][1], t[0][2] - ct[0][2]],
    [t[1][0], t[1][1], t[1][2] - ct[1][2]],
  ];
}

// Shift children so their bbox starts at `padding`, move the container by the opposite amount
// (children stay put on canvas), then resize the container around them.
function crFitContainer(n, padding) {
  if (!('children' in n) || !n.children.length) throw new Error(n.name + ' has no children to fit');
  if ('layoutMode' in n && n.layoutMode !== 'NONE') throw new Error(n.name + ' uses auto layout; fit_section only works on sections / non-auto-layout frames');
  if (!('resizeWithoutConstraints' in n)) throw new Error(n.type + ' cannot be resized to fit');
  var pad = padding === undefined ? 0 : padding;
  var ox = n.absoluteTransform[0][2], oy = n.absoluteTransform[1][2];
  var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  n.children.forEach(function (c) {
    var b = crBBox(c);
    minX = Math.min(minX, b.x - ox); minY = Math.min(minY, b.y - oy);
    maxX = Math.max(maxX, b.x - ox + b.width); maxY = Math.max(maxY, b.y - oy + b.height);
  });
  var dx = pad - minX, dy = pad - minY;
  if (dx !== 0 || dy !== 0) {
    n.children.forEach(function (c) { c.x = c.x + dx; c.y = c.y + dy; });
    n.x = n.x - dx; n.y = n.y - dy;
  }
  n.resizeWithoutConstraints(Math.max(maxX - minX + 2 * pad, 0.01), Math.max(maxY - minY + 2 * pad, 0.01));
}

var CR_SHAPES = {
  RECTANGLE: function () { return figma.createRectangle(); },
  ELLIPSE: function () { return figma.createEllipse(); },
  LINE: function () { return figma.createLine(); },
  POLYGON: function () { return figma.createPolygon(); },
  STAR: function () { return figma.createStar(); },
};

H.create_shape = async function (p) {
  var type = String(p.shapeType || 'RECTANGLE').toUpperCase();
  if (!CR_SHAPES[type]) throw new Error('Unknown shapeType: ' + p.shapeType + '. Use RECTANGLE, ELLIPSE, LINE, POLYGON or STAR');
  var n = CR_SHAPES[type]();
  try {
    if (p.name) n.name = p.name;
    if (type === 'LINE') {
      n.resize(p.width !== undefined ? p.width : 100, 0);
      if (p.stroke === undefined && (!n.strokes || !n.strokes.length)) n.strokes = [hexPaint('#000000')];
    } else {
      n.resize(p.width !== undefined ? p.width : 100, p.height !== undefined ? p.height : (p.width !== undefined ? p.width : 100));
    }
    if (type === 'POLYGON' && p.pointCount !== undefined) n.pointCount = p.pointCount;
    if (type === 'STAR') {
      if (p.pointCount !== undefined) n.pointCount = p.pointCount;
      if (p.innerRadius !== undefined) n.innerRadius = p.innerRadius;
    }
    if (p.fill !== undefined && type !== 'LINE') n.fills = paintList(p.fill);
    if (p.stroke !== undefined) n.strokes = paintList(p.stroke);
    if (p.strokeWeight !== undefined) n.strokeWeight = p.strokeWeight;
    if (p.cornerRadius !== undefined) {
      if (!('cornerRadius' in n) || type === 'ELLIPSE' || type === 'LINE') throw new Error('cornerRadius is not supported on ' + type);
      n.cornerRadius = p.cornerRadius;
    }
    await appendTo(n, p.parentId, p.x, p.y);
    if (p.rotation !== undefined) n.rotation = p.rotation;
  } catch (e) {
    n.remove();
    throw e;
  }
  return ser(n, 0);
};

H.create_svg = async function (p) {
  if (!p.svg) throw new Error('svg markup required');
  var f;
  try { f = figma.createNodeFromSvg(p.svg); } catch (e) { throw new Error('Could not parse SVG: ' + (e && e.message ? e.message : e)); }
  try {
    if (p.name) f.name = p.name;
    crSizeTo(f, p.width, p.height, true);
    if (p.flatten && f.children.length) {
      var v = figma.flatten(f.children.slice(), f);
      v.name = p.name || 'Vector';
      if ('constraints' in v) v.constraints = { horizontal: 'SCALE', vertical: 'SCALE' };
    }
    await appendTo(f, p.parentId, p.x, p.y);
  } catch (e) {
    f.remove();
    throw e;
  }
  return ser(f, p.flatten ? 1 : 0);
};

H.create_image = async function (p) {
  if (!p.imageBase64) throw new Error('imageBase64 missing (the server should have loaded `source`)');
  var image;
  try { image = figma.createImage(figma.base64Decode(p.imageBase64)); } catch (e) {
    throw new Error('Figma rejected the image (' + (e && e.message ? e.message : e) + '). Supported: PNG, JPEG, GIF up to 4096x4096 px.');
  }
  var size = await image.getSizeAsync();
  var paint = { type: 'IMAGE', imageHash: image.hash, scaleMode: p.scaleMode || 'FILL' };

  if (p.targetNodeId) {
    var t = await node(p.targetNodeId);
    if (!('fills' in t)) throw new Error(t.type + ' has no fills');
    t.fills = [paint];
    if (p.cornerRadius !== undefined && 'cornerRadius' in t) t.cornerRadius = p.cornerRadius;
    var out = ser(t, 0);
    out.image = { hash: image.hash, width: size.width, height: size.height };
    return out;
  }

  var r = figma.createRectangle();
  try {
    r.name = p.name || 'Image';
    r.resize(size.width, size.height);
    crSizeTo(r, p.width, p.height, false);
    r.fills = [paint];
    if (p.cornerRadius !== undefined) r.cornerRadius = p.cornerRadius;
    await appendTo(r, p.parentId, p.x, p.y);
  } catch (e) {
    r.remove();
    throw e;
  }
  var o = ser(r, 0);
  o.image = { hash: image.hash, width: size.width, height: size.height };
  return o;
};

H.create_page = async function (p) {
  var page = figma.createPage();
  if (p.name) page.name = p.name;
  if (p.setCurrent) await figma.setCurrentPageAsync(page);
  return { id: page.id, name: page.name, current: figma.currentPage.id === page.id };
};

H.create_section = async function (p) {
  var s = figma.createSection();
  var moved = [];
  try {
    if (p.name) s.name = p.name;
    s.resizeWithoutConstraints(p.width !== undefined ? p.width : 400, p.height !== undefined ? p.height : 300);
    if (p.fill !== undefined) s.fills = paintList(p.fill);
    await appendTo(s, p.parentId, p.x, p.y);
  } catch (e) {
    s.remove();
    throw e;
  }
  var ids = p.childIds || [];
  for (var i = 0; i < ids.length; i++) {
    try {
      var c = await node(ids[i]);
      if (c.type === 'PAGE' || c.type === 'DOCUMENT') throw new Error('Cannot move a ' + c.type + ' into a section');
      if (c.id === s.id) throw new Error('Cannot move a section into itself');
      if (pageOf(c) !== pageOf(s)) throw new Error('Node is on a different page than the section');
      crReparentKeepPosition(c, s);
      moved.push({ id: c.id, ok: true });
    } catch (e) {
      moved.push({ id: ids[i], error: e.message });
    }
  }
  var fit = p.fitToContent !== undefined ? p.fitToContent : (ids.length > 0 && p.width === undefined && p.height === undefined);
  var fitError;
  if (fit) {
    try { crFitContainer(s, p.padding !== undefined ? p.padding : 40); } catch (e) { fitError = e.message; }
  }
  var o = ser(s, 1);
  if (ids.length) o.moved = moved;
  if (fitError) o.fitError = fitError;
  return o;
};

H.fit_section = async function (p) {
  var pad = p.padding !== undefined ? p.padding : 40;
  if (!p.nodeIds) {
    if (!p.nodeId) throw new Error('nodeId or nodeIds required');
    var one = await node(p.nodeId);
    crFitContainer(one, pad);
    return ser(one, 0);
  }
  var ids = p.nodeIds;
  var results = [];
  for (var i = 0; i < ids.length; i++) {
    try {
      var n = await node(ids[i]);
      crFitContainer(n, pad);
      results.push(ser(n, 0));
    } catch (e) {
      results.push({ id: ids[i], error: e.message });
    }
  }
  return results;
};
