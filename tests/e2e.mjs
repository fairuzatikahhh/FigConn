// End-to-end test for FigConn: starts a fresh server, talks to it over MCP, and drives the
// Figma plugin in an EMPTY file. It refuses to run if any page of the target file has content.
//
// Usage: open an empty Figma design file, run the FigConn plugin in it, then
//   npm run test:e2e -- "<file name>"
// Output (report.json, screenshots, exports) goes to e2e-output/.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "e2e-output");
mkdirSync(OUT, { recursive: true });
const TARGET = process.argv[2];
if (!TARGET) { console.error('usage: npm run test:e2e -- "<file name>"'); process.exit(2); }

// ---- tiny PNG generator (64x64 gradient) -----------------------------------
function png(w, h) {
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 4 + 1)] = 0; for (let x = 0; x < w; x++) { const i = y * (w * 4 + 1) + 1 + x * 4; raw[i] = 255 - x * 3; raw[i + 1] = 78 + y * 2; raw[i + 2] = 158 + x; raw[i + 3] = 255; } }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const PNG = png(64, 64);
const PNG_PATH = join(OUT, "sample.png");
writeFileSync(PNG_PATH, PNG);

// ---- MCP client --------------------------------------------------------------
const transport = new StdioClientTransport({ command: "node", args: [join(ROOT, "server", "index.js")], stderr: "ignore" });
const client = new Client({ name: "figconn-e2e", version: "1.0.0" });
await client.connect(transport);
const allTools = (await client.listTools()).tools.map((t) => t.name);

const results = [];
const used = new Set();
async function call(name, args = {}, { expectError = false, file = true } = {}) {
  used.add(name);
  const t0 = Date.now();
  let res, err;
  try { res = await client.callTool({ name, arguments: file ? { ...args, file: TARGET } : args }, undefined, { timeout: 120000 }); }
  catch (e) { err = e.message; }
  const ms = Date.now() - t0;
  const text = res && res.content ? res.content.filter((c) => c.type === "text").map((c) => c.text).join("\n") : "";
  const images = res && res.content ? res.content.filter((c) => c.type === "image") : [];
  const isErr = !!err || !!(res && res.isError);
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { ok: !isErr, ms, data, images, error: err || (isErr ? text : null) };
}
async function step(label, name, args, opts = {}) {
  const r = await call(name, args, opts);
  const pass = opts.expectError ? !r.ok : r.ok;
  let note = "";
  if (pass && opts.check) { try { const c = opts.check(r.data, r); if (c !== true) note = c || "check failed"; } catch (e) { note = "check threw: " + e.message; } }
  const status = !pass ? "FAIL" : note ? "WARN" : "PASS";
  const perItemErrors = findItemErrors(r.data);
  if (status === "PASS" && perItemErrors.length) note = "per-item errors: " + perItemErrors.join(" | ");
  results.push({ label, tool: name, status: status === "PASS" && note ? "WARN" : status, ms: r.ms, note: !pass ? (opts.expectError ? "expected an error, got success" : r.error) : note });
  process.stderr.write(`${status.padEnd(4)} ${label} (${r.ms} ms)${!pass ? " — " + (r.error || "").slice(0, 200) : note ? " — " + note.slice(0, 200) : ""}\n`);
  return r;
}
function findItemErrors(d, out = []) {
  if (!d || typeof d !== "object") return out;
  if (Array.isArray(d)) { d.forEach((x) => findItemErrors(x, out)); return out; }
  if (typeof d.error === "string" && d.id) out.push(d.id + ": " + d.error);
  for (const k of Object.keys(d)) if (k !== "error" && typeof d[k] === "object") findItemErrors(d[k], out);
  return out;
}
const idOf = (d) => (d && d.id) || (d && d.node && d.node.id) || null;
function findKey(d, key) { if (!d || typeof d !== "object") return undefined; if (key in d) return d[key]; for (const v of Object.values(d)) { const r = findKey(v, key); if (r !== undefined) return r; } }

// ---- wait for the target file ------------------------------------------------
let target;
for (let i = 0; i < 30 && !target; i++) {
  const s = await call("status", {}, { file: false });
  target = (s.data.files || []).find((f) => (f.fileName || "").toLowerCase().includes(TARGET.toLowerCase()));
  if (!target) await new Promise((r) => setTimeout(r, 1000));
}
if (!target) { console.error(`Target file "${TARGET}" is not connected to the test server. Is the FigConn plugin open in it?`); await client.close(); process.exit(3); }
console.error(`target: ${target.fileName} (${target.editorType})`);

// ---- SAFETY: refuse unless the whole file is empty ------------------------------
const guard = await call("execute", { code: "var n=0; for (const p of figma.root.children){ await p.loadAsync(); n+=p.children.length; } return { pages: figma.root.children.length, nodes: n, name: figma.root.name };" });
if (!guard.ok || guard.data.nodes !== 0) {
  console.error("ABORT: target file is not empty:", JSON.stringify(guard.data || guard.error));
  await client.close(); process.exit(4);
}
console.error("guard ok: file is empty (" + guard.data.pages + " page)");

// =============================================================================
// Tests
// =============================================================================
const R = {};
let r;
// Variables and styles outlive deleted layers, so give everything from this run a unique name.
const RUN = new Date().toISOString().slice(5, 16).replace(/[-:T]/g, "");
const COL = "FC Tokens " + RUN;
const STY = "FC " + RUN + "/";

// --- read / basics
await step("status lists editorType", "status", {}, { file: false, check: (d) => d.files.every((f) => "editorType" in f) || "editorType missing" });
await step("get_document", "get_document", {});
await step("execute", "execute", { code: "return figma.editorType;" }, { check: (d) => d === "figma" || "got " + JSON.stringify(d) });

// --- pages & frames
r = await step("create_page + setCurrent", "create_page", { name: "FigConn Test", setCurrent: true }); R.page = idOf(r.data);
r = await step("create_frame Screen A", "create_frame", { name: "Screen A", parentId: R.page, x: 0, y: 0, width: 390, height: 844, fill: "#FFFFFF" }); R.A = idOf(r.data);
r = await step("create_frame Card (auto layout)", "create_frame", { name: "Card", parentId: R.A, x: 24, y: 24, width: 342, fill: "#F4F4F8", cornerRadius: 16, autoLayout: { mode: "VERTICAL", gap: 12, padding: 16, sizing: "HUG" } }); R.card = idOf(r.data);
r = await step("create_text title", "create_text", { characters: "Hello FigConn", parentId: R.card, fontSize: 20, fontStyle: "Bold" }); R.t1 = idOf(r.data);
r = await step("create_text body (fixed width)", "create_text", { characters: "Built end-to-end by the FigConn test script.", parentId: R.card, fontSize: 14, width: 300, fill: "#555566" }); R.t2 = idOf(r.data);
await step("set_properties characters", "set_properties", { nodeIds: [R.t1], props: { characters: "Hello, FigConn" } }, { check: (d) => d[0].characters === "Hello, FigConn" || JSON.stringify(d[0]).slice(0, 120) });

// --- layout & appearance
await step("set_layout_child FILL", "set_layout_child", { nodeIds: [R.t2], horizontal: "FILL" });
await step("set_auto_layout", "set_auto_layout", { nodeIds: [R.card], gap: 16, padding: [20, 20, 20, 20], counterAlign: "MIN", primarySizing: "HUG", counterSizing: "FIXED" });
await step("set_effects drop shadow", "set_effects", { nodeIds: [R.card], effects: [{ type: "DROP_SHADOW", color: "#0000001F", x: 0, y: 4, blur: 16, spread: 0 }] });
await step("set_stroke dashed", "set_stroke", { nodeIds: [R.card], color: "#E2E2EA", weight: 1, dashPattern: [4, 2], align: "INSIDE" });

// --- shapes, svg, images
r = await step("create_shape RECTANGLE", "create_shape", { shapeType: "RECTANGLE", name: "Rect", parentId: R.A, x: 24, y: 320, width: 100, height: 100, fill: "#8B5CF6", cornerRadius: 12 }); R.rect = idOf(r.data);
await step("set_gradient 45deg", "set_gradient", { nodeIds: [R.rect], type: "LINEAR", angle: 45, stops: [{ position: 0, color: "#FF7A59" }, { position: 1, color: "#8B5CF6" }] });
r = await step("create_shape ELLIPSE", "create_shape", { shapeType: "ELLIPSE", name: "Ellipse", parentId: R.A, x: 24, y: 440, width: 60, fill: "#22D3EE" }); R.ell = idOf(r.data);
r = await step("create_shape LINE", "create_shape", { shapeType: "LINE", name: "Line", parentId: R.A, x: 101, y: 470, width: 80, stroke: "#1B1530", strokeWeight: 2 }); R.line = idOf(r.data);
r = await step("create_shape POLYGON", "create_shape", { shapeType: "POLYGON", name: "Polygon", parentId: R.A, x: 200, y: 440, width: 60, pointCount: 6, fill: "#F24E9E" }); R.poly = idOf(r.data);
r = await step("create_shape STAR", "create_shape", { shapeType: "STAR", name: "Star", parentId: R.A, x: 280, y: 440, width: 60, pointCount: 5, innerRadius: 0.45, fill: "#FFB020" }); R.star = idOf(r.data);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#1B1530" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
r = await step("create_svg (width only)", "create_svg", { svg: SVG, name: "Icon check", parentId: R.A, x: 24, y: 540, width: 48 }, { check: (d) => Math.round(d.height) === 48 || "height " + d.height }); R.svg = idOf(r.data);
r = await step("create_svg flatten (w+h)", "create_svg", { svg: SVG, name: "Icon flat", parentId: R.A, x: 90, y: 540, width: 48, height: 32, flatten: true }); R.svg2 = idOf(r.data);
r = await step("create_image data URI", "create_image", { source: "data:image/png;base64," + PNG.toString("base64"), name: "Image (data URI)", parentId: R.A, x: 160, y: 540, width: 96, cornerRadius: 12 }, { check: (d) => Math.round(d.height || (d.node && d.node.height)) === 96 || "not square: " + JSON.stringify(d).slice(0, 160) }); R.img = idOf(r.data);
r = await step("create_image local file", "create_image", { source: PNG_PATH, name: "Image (file)", parentId: R.A, x: 270, y: 540, width: 96 }); R.img2 = idOf(r.data);
await step("create_image targetNodeId", "create_image", { source: PNG_PATH, targetNodeId: R.ell, scaleMode: "FILL" });
await step("create_image rejects SVG", "create_image", { source: "data:image/svg+xml;base64," + Buffer.from(SVG).toString("base64") }, { expectError: true });

// --- structure & arrange
r = await step("duplicate_nodes count 2", "duplicate_nodes", { nodeIds: [R.rect], offsetX: 120, count: 2 });
R.clones = (findKey(r.data, "clones") || []).map((c) => (typeof c === "string" ? c : c.id));
if (R.clones.length !== 2) results[results.length - 1].note = "clones: " + JSON.stringify(r.data).slice(0, 200);
await step("align_nodes top", "align_nodes", { nodeIds: [R.rect, ...R.clones], align: "top" });
await step("distribute_nodes gap 16", "distribute_nodes", { nodeIds: [R.rect, ...R.clones], axis: "horizontal", gap: 16 });
await step("arrange_grid", "arrange_grid", { nodeIds: [R.ell, R.poly, R.star], columns: 3, gapX: 12, gapY: 12, x: 24, y: 640 });
await step("align_to_grid", "align_to_grid", { nodeIds: [R.line], gridSize: 8 });
await step("place_relative below", "place_relative", { nodeId: R.svg, relativeToId: R.rect, side: "below", gap: 16, align: "start" });
r = await step("group_nodes", "group_nodes", { nodeIds: [R.ell, R.poly], name: "Shapes" }); R.group = idOf(r.data);
await step("ungroup_node", "ungroup_node", { nodeIds: [R.group] });
r = await step("group_nodes asFrame", "group_nodes", { nodeIds: [R.star, R.line], name: "Wrap", asFrame: true }); R.wrap = idOf(r.data);
await step("reorder_nodes back", "reorder_nodes", { nodeIds: [R.wrap], to: "back" });
await step("reparent_nodes keepPosition", "reparent_nodes", { nodeIds: [R.star], parentId: R.A, keepPosition: true });
await step("set_constraints", "set_constraints", { nodeIds: [R.rect], horizontal: "STRETCH", vertical: "MIN" });
await step("set_constraints rejects auto-layout child", "set_constraints", { nodeIds: [R.t1], horizontal: "STRETCH" }, { check: (d) => findItemErrors(d).length > 0 || "expected per-item error" });
results[results.length - 1].status = results[results.length - 1].note === "expected per-item error" ? "WARN" : "PASS";
if (results[results.length - 1].status === "PASS") results[results.length - 1].note = "";

// --- second screen + section
r = await step("create_frame Screen B", "create_frame", { name: "Screen B", parentId: R.page, x: 450, y: 0, width: 390, height: 844, fill: "#FAFAFC" }); R.B = idOf(r.data);
r = await step("create_section around screens", "create_section", { name: "Flow", parentId: R.page, childIds: [R.A, R.B], fitToContent: true, padding: 40, fill: "#F0EEF8" }); R.sec = idOf(r.data);
await step("fit_section padding 60", "fit_section", { nodeId: R.sec, padding: 60 });

// --- variables
r = await step("create_variable_collection Light/Dark", "create_variable_collection", { name: COL, modes: ["Light", "Dark"] });
R.twoModes = r.ok;
if (!r.ok && /fewer modes|limited to/i.test(results[results.length - 1].note || "")) {
  results[results.length - 1].status = "WARN";
  results[results.length - 1].note = "Figma plan allows 1 mode per collection; continuing with 1 mode";
}
if (!r.ok) { r = await step("create_variable_collection (1 mode fallback)", "create_variable_collection", { name: COL, modes: ["Light"] }); }
const vals = (light, dark) => (R.twoModes ? { Light: light, Dark: dark } : { Light: light });
await step("create_variables (incl. alias)", "create_variables", { collection: COL, variables: [
  { name: "color/bg", type: "COLOR", values: vals("#FFFFFF", "#15131F") },
  { name: "color/surface", type: "COLOR", values: vals("#F4F4F8", "#221F31") },
  { name: "color/primary", type: "COLOR", value: "#8B5CF6" },
  { name: "color/accent", type: "COLOR", value: { alias: "color/primary" } },
  { name: "space/16", type: "FLOAT", value: 16, scopes: ["GAP", "WIDTH_HEIGHT"] },
  { name: "radius/md", type: "FLOAT", value: 12, scopes: ["CORNER_RADIUS"] },
] });
await step("get_variables", "get_variables", { collection: COL }, { check: (d) => d[0].variables.length === 6 || "count " + d[0].variables.length });
await step("bind_variable fill", "bind_variable", { nodeIds: [R.A], field: "fill", variable: "color/bg", collection: COL });
await step("bind_variable fill (card)", "bind_variable", { nodeIds: [R.card], field: "fill", variable: "color/surface", collection: COL });
await step("bind_variable padding", "bind_variable", { nodeIds: [R.card], field: "padding", variable: "space/16", collection: COL });
await step("bind_variable cornerRadius", "bind_variable", { nodeIds: [R.card], field: "cornerRadius", variable: "radius/md", collection: COL });
if (R.twoModes) await step("set_variable_mode Dark", "set_variable_mode", { nodeIds: [R.B], collection: COL, mode: "Dark" });
await step("list_library_variables", "list_library_variables", {});

// --- styles
await step("create_paint_style (bound)", "create_paint_style", { name: STY + "Primary", variable: "color/primary", collection: COL });
await step("create_text_style", "create_text_style", { name: STY + "Title", fontFamily: "Inter", fontStyle: "Bold", fontSize: 22, lineHeight: "130%", letterSpacing: "-1%" });
await step("create_effect_style", "create_effect_style", { name: STY + "Shadow", shadows: [{ color: "#1B153029", x: 0, y: 8, blur: 24, spread: -4 }] });
await step("get_styles", "get_styles", {}, { check: (d) => d.length >= 3 || "count " + d.length });
await step("apply_style text", "apply_style", { nodeIds: [R.t1], style: STY + "Title" });
await step("apply_style fill", "apply_style", { nodeIds: [R.clones[0] || R.rect], style: STY + "Primary" });
await step("apply_style effect", "apply_style", { nodeIds: [R.card], style: STY + "Shadow" });

// --- components
r = await step("create_frame Button", "create_frame", { name: "Button", parentId: R.page, x: 0, y: 1000, fill: "#8B5CF6", cornerRadius: 8, autoLayout: { mode: "HORIZONTAL", padding: [10, 16, 10, 16], sizing: "HUG" } }); R.btn = idOf(r.data);
r = await step("create_text button label", "create_text", { characters: "Button", parentId: R.btn, fontSize: 14, fontStyle: "Medium", fill: "#FFFFFF" }); R.btnText = idOf(r.data);
r = await step("create_component from frame", "create_component", { nodeId: R.btn, name: "Type=Primary" }); R.c1 = idOf(r.data);
r = await step("duplicate component", "duplicate_nodes", { nodeIds: [R.c1], offsetX: 140 }); R.c2 = (findKey(r.data, "clones") || []).map((c) => (typeof c === "string" ? c : c.id))[0];
await step("set_properties variant 2", "set_properties", { nodeIds: [R.c2], props: { name: "Type=Secondary", fills: "#EDE9FE" } });
r = await step("combine_as_variants", "combine_as_variants", { componentIds: [R.c1, R.c2], name: "Button" }); R.set = idOf(r.data);
await step("add_component_property TEXT", "add_component_property", { nodeId: R.set, name: "Label", type: "TEXT", defaultValue: "Button", bindToNodeId: R.btnText });
await step("add_component_property BOOLEAN", "add_component_property", { nodeId: R.set, name: "Show label", type: "BOOLEAN", defaultValue: true, bindToNodeId: R.btnText });
await step("get_components", "get_components", { pageId: R.page }, { check: (d) => d.some((c) => c.type === "COMPONENT_SET") || "no set" });
r = await step("create_instance (variant)", "create_instance", { componentId: R.set, parentId: R.B, x: 24, y: 760, properties: { Type: "Secondary" } }); R.inst = idOf(r.data);
await step("set_instance_properties", "set_instance_properties", { nodeIds: [R.inst], properties: { Label: "Continue", Type: "Primary" } });

// --- prototype
await step("set_reaction NAVIGATE", "set_reaction", { nodeId: R.inst, trigger: "ON_CLICK", action: "NAVIGATE", destinationId: R.A, transition: { type: "SMART_ANIMATE", durationMs: 300, easing: "EASE_OUT" } });
await step("set_reaction AFTER_TIMEOUT", "set_reaction", { nodeId: R.A, trigger: "AFTER_TIMEOUT", timeoutMs: 1500, action: "NAVIGATE", destinationId: R.B, transition: { type: "DISSOLVE", durationMs: 200 } });
await step("set_flow_starting_point", "set_flow_starting_point", { nodeId: R.B, name: "Main flow" });
await step("get_prototype_connections", "get_prototype_connections", { nodeId: R.page }, { check: (d) => JSON.stringify(d).includes("NAVIGATE") || "no NAVIGATE found" });
await step("trace_prototype_flow", "trace_prototype_flow", { nodeId: R.B }, { check: (d) => (d.screens || []).length >= 2 || "screens: " + JSON.stringify(d.screens) });

// --- FigJam-only tools must refuse in a design file
await step("create_sticky refuses in Design", "create_sticky", { text: "hi" }, { expectError: true });
await step("create_connector refuses in Design", "create_connector", { startX: 0, startY: 0, endX: 10, endY: 10 }, { expectError: true });
await step("create_shape_with_text refuses in Design", "create_shape_with_text", { text: "hi" }, { expectError: true });
await step("create_table refuses in Design", "create_table", { rows: 2, columns: 2 }, { expectError: true });

// --- read & export
await step("get_node depth 1", "get_node", { nodeId: R.A, depth: 1 });
await step("get_layout_tree", "get_layout_tree", { rootId: R.sec, maxNodes: 500 }, { check: (d) => (d.nodes || d.items || []).length > 10 || "few nodes: " + Object.keys(d) });
await step("set_selection", "set_selection", { nodeIds: [R.card] });
await step("get_selection", "get_selection", { depth: 0 }, { check: (d) => d.selection[0].id === R.card || "wrong selection" });
await step("scroll_into_view", "scroll_into_view", { nodeIds: [R.sec] });
r = await step("get_screenshot PNG", "get_screenshot", { nodeId: R.sec, scale: 1 }, { check: (d, rr) => rr.images.length === 1 || "no image" });
if (r.images[0]) writeFileSync(join(OUT, "section.png"), Buffer.from(r.images[0].data, "base64"));
r = await step("get_screenshot SVG", "get_screenshot", { nodeId: R.svg, format: "SVG" }, { check: (d) => String(d).includes("<svg") || "no svg markup" });
await step("get_screenshot PDF points to save_screenshots", "get_screenshot", { nodeId: R.svg, format: "PDF" }, { expectError: true });
await step("save_screenshots dir", "save_screenshots", { nodeIds: [R.A, R.B], dir: join(OUT, "shots"), format: "PNG", scale: 2 });
await step("save_screenshots items (PDF/SVG/JPG)", "save_screenshots", { items: [{ nodeId: R.A, path: join(OUT, "shots/screen-a.pdf"), format: "PDF" }, { nodeId: R.svg, path: join(OUT, "shots/icon.svg"), format: "SVG" }, { nodeId: R.B, path: join(OUT, "shots/screen-b.jpg"), format: "JPG" }] });

// --- delete
await step("delete_nodes", "delete_nodes", { nodeIds: [R.clones[1]].filter(Boolean) });

// final picture for a human look
r = await call("get_screenshot", { nodeId: R.sec, scale: 1 });
if (r.images[0]) writeFileSync(join(OUT, "final.png"), Buffer.from(r.images[0].data, "base64"));
r = await call("get_screenshot", { nodeId: R.set, scale: 2 });
if (r.images[0]) writeFileSync(join(OUT, "button-set.png"), Buffer.from(r.images[0].data, "base64"));

// ---- report -----------------------------------------------------------------
const untested = allTools.filter((t) => !used.has(t));
const summary = { pass: results.filter((x) => x.status === "PASS").length, warn: results.filter((x) => x.status === "WARN").length, fail: results.filter((x) => x.status === "FAIL").length, toolsCovered: used.size, toolsTotal: allTools.length, untested, ids: R };
writeFileSync(join(OUT, "report.json"), JSON.stringify({ summary, results }, null, 2));
console.log(JSON.stringify(summary));
for (const x of results.filter((x) => x.status !== "PASS")) console.log(`${x.status} ${x.label} [${x.tool}]: ${x.note}`);
await client.close();
