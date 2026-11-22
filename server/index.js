#!/usr/bin/env node
// FigConn — MCP server that talks to the FigConn Figma plugin over a local WebSocket.
// No Figma REST API is used, so there is no API quota.

import { createServer } from "node:http";
import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { WebSocketServer } from "ws";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const PORT_START = Number(process.env.FIGCONN_PORT || 3911);
const PORT_END = PORT_START + 9; // plugin scans 3911..3920
const DEFAULT_TIMEOUT = 30_000;

const log = (...a) => console.error("[figconn]", ...a); // stdout is reserved for MCP

// ---------------------------------------------------------------------------
// WebSocket side (plugin connections)
// ---------------------------------------------------------------------------

/** @type {Map<string, {ws: import('ws').WebSocket, info: any, connectedAt: number, lastActive: number}>} */
const clients = new Map();
const pending = new Map(); // requestId -> {resolve, reject, timer}
let boundPort = null;

const sockets = new Set(); // every open plugin socket, hello'd or not
const startedAt = Date.now();
const SERVER_VERSION = "0.1.0";

/** Who this server is, shown in the plugin window so users can tell connections apart. */
function serverInfo() {
  const client = mcp.server.getClientVersion();
  return {
    version: SERVER_VERSION,
    port: boundPort,
    pid: process.pid,
    cwd: process.cwd(),
    startedAt,
    client: client ? { name: client.name, version: client.version } : null,
  };
}
function sendServerInfo(ws) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: "server-info", info: serverInfo() }));
}

function onConnection(ws, req) {
  // Browsers send an Origin header; the plugin iframe's origin is "null".
  // Reject any real web page that tries to connect to this port.
  const origin = req.headers.origin;
  if (origin && origin !== "null") {
    log("rejected connection from origin", origin);
    ws.close(1008, "origin not allowed");
    return;
  }
  const connId = randomUUID();
  sockets.add(ws);
  sendServerInfo(ws);
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === "hello") {
      clients.set(connId, { ws, info: msg.info || {}, connectedAt: Date.now(), lastActive: Date.now() });
      log("plugin connected:", msg.info && msg.info.fileName);
      return;
    }
    if (msg.type === "active") {
      const c = clients.get(connId);
      if (c) { c.lastActive = Date.now(); if (msg.info) c.info = msg.info; }
      return;
    }
    if (msg.type === "response" && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || "Unknown plugin error"));
    }
  });
  ws.on("close", () => {
    sockets.delete(ws);
    clients.delete(connId);
  });
}

async function listenOn(port) {
  // Listen on both IPv4 and IPv6 loopback so ws://localhost works either way.
  const hosts = ["127.0.0.1", "::1"];
  const servers = [];
  for (const host of hosts) {
    const http = createServer((_, res) => { res.writeHead(200); res.end("figconn"); });
    try {
      await new Promise((resolve, reject) => {
        http.once("error", reject);
        http.listen(port, host, resolve);
      });
      const wss = new WebSocketServer({ server: http, maxPayload: 64 * 1024 * 1024 });
      wss.on("connection", onConnection);
      servers.push(http);
    } catch (e) {
      if (host === "127.0.0.1") {
        for (const s of servers) s.close();
        throw e;
      }
      // IPv6 loopback unavailable -> fine, IPv4 is enough
    }
  }
  return servers;
}

async function startWs() {
  for (let port = PORT_START; port <= PORT_END; port++) {
    try {
      await listenOn(port);
      boundPort = port;
      log(`listening on ws://localhost:${port}`);
      return;
    } catch (e) {
      if (e.code !== "EADDRINUSE") throw e;
    }
  }
  log(`no free port in ${PORT_START}-${PORT_END}; plugin connection unavailable`);
}

function pickClient(file) {
  const all = [...clients.values()];
  if (all.length === 0) {
    throw new Error(
      "No Figma file connected. Open a file in Figma Desktop and run Plugins → Development → FigConn " +
      `(this server listens on port ${boundPort ?? "none"}).`
    );
  }
  if (file) {
    const f = String(file).toLowerCase();
    const hit = all.find((c) => c.info.fileKey === file || c.info.id === file) ||
      all.find((c) => (c.info.fileName || "").toLowerCase() === f) ||
      all.find((c) => (c.info.fileName || "").toLowerCase().includes(f));
    if (!hit) throw new Error(`File "${file}" not connected. Connected: ${all.map((c) => c.info.fileName).join(", ")}`);
    return hit;
  }
  // default: the file whose plugin window was most recently active
  return all.sort((a, b) => b.lastActive - a.lastActive)[0];
}

function call(cmd, params = {}, { file, timeout = DEFAULT_TIMEOUT } = {}) {
  const client = pickClient(file);
  const id = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out after ${timeout} ms waiting for Figma (${cmd}). Is the plugin still open?`));
    }, timeout);
    pending.set(id, { resolve, reject, timer });
    client.ws.send(JSON.stringify({ type: "request", id, cmd, params }));
  });
}

// ---------------------------------------------------------------------------
// MCP side
// ---------------------------------------------------------------------------

const mcp = new McpServer(
  { name: "FigConn", version: SERVER_VERSION },
  {
    instructions:
      "FigConn controls Figma Desktop through a local plugin (no REST API, no quota). Start with `status` to see connected files " +
      "(each has editorType figma|figjam; pass `file` to target one). Read: get_document, get_selection, get_node, get_layout_tree, " +
      "get_screenshot (PNG/JPG/SVG), save_screenshots. Create: create_frame, create_text, create_shape, create_svg, create_image, " +
      "create_page, create_section. Edit: set_properties, set_auto_layout, set_layout_child, set_effects, set_gradient, set_stroke, " +
      "set_constraints. Structure/arrange: duplicate_nodes, group_nodes, ungroup_node, reparent_nodes, reorder_nodes, place_relative, " +
      "align_nodes, distribute_nodes, arrange_grid. Design systems: get_variables, create_variable_collection, create_variables, " +
      "bind_variable, set_variable_mode, get_styles, create_paint_style, create_text_style, create_effect_style, apply_style, " +
      "create_component, combine_as_variants, add_component_property, create_instance, set_instance_properties. Prototype: " +
      "get_prototype_connections, trace_prototype_flow, set_reaction. FigJam-only: create_sticky, create_shape_with_text, " +
      "create_connector, create_table (variables, styles and components are not available in FigJam). For anything else use `execute`, " +
      "which runs arbitrary Figma Plugin API code (async, `figma` in scope; document access is dynamic-page so use *Async APIs such as " +
      "figma.getNodeByIdAsync and figma.variables.getLocalVariablesAsync). Colors are hex strings like #RRGGBB or #RRGGBBAA. " +
      "Always check the result with get_screenshot after visual changes.",
  }
);

const fileParam = z.string().optional().describe("Target file (fileKey, id or name). Defaults to the most recently active file.");
const nodeId = z.string().describe("Figma node id, e.g. '12:34'");

const ok = (result) => ({ content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: "text", text: String(e && e.message ? e.message : e) }] });

/** Register a tool that simply forwards its args to the plugin command of the same name. */
function relay(name, description, shape, opts = {}) {
  mcp.registerTool(name, { description, inputSchema: { ...shape, file: fileParam } }, async (args) => {
    const { file, ...params } = args || {};
    try {
      const result = await call(opts.cmd || name, params, { file, timeout: opts.timeout });
      return opts.format ? opts.format(result) : ok(result);
    } catch (e) {
      return fail(e);
    }
  });
}

// --- connection ------------------------------------------------------------
mcp.registerTool(
  "status",
  { description: "Show the FigConn port and which Figma files currently have the plugin open.", inputSchema: {} },
  async () =>
    ok({
      port: boundPort,
      files: [...clients.values()].map((c) => ({ ...c.info, lastActive: new Date(c.lastActive).toISOString() })),
      hint: clients.size
        ? undefined
        : "Open a file in Figma Desktop → Plugins → Development → FigConn. First time? Import the plugin via " +
          "Plugins → Development → Import plugin from manifest… and pick " + join(dirname(fileURLToPath(import.meta.url)), "..", "plugin", "manifest.json"),
    })
);

// --- generic -----------------------------------------------------------------
mcp.registerTool(
  "execute",
  {
    description:
      "Run arbitrary JavaScript against the Figma Plugin API inside the plugin. The code is the body of an async function " +
      "with `figma` and `h` (helpers: h.hex(hex)->Paint, h.rgb(hex)->RGB(A), h.node(id), h.ser(node, depth), h.loadFonts(textNode), h.findVariable(nameOrId)) in scope. " +
      "`return` a JSON-serialisable value (nodes are auto-serialised). Use *Async APIs (dynamic-page).",
    inputSchema: {
      code: z.string().describe("Async function body, e.g. `const n = await figma.getNodeByIdAsync('1:2'); return n.name;`"),
      timeoutMs: z.number().int().min(1000).max(300000).optional(),
      file: fileParam,
    },
  },
  async ({ code, timeoutMs, file }) => {
    try {
      return ok(await call("execute", { code }, { file, timeout: timeoutMs || 60_000 }));
    } catch (e) {
      return fail(e);
    }
  }
);

// --- read --------------------------------------------------------------------
relay("get_document", "List pages and the top-level nodes of the current (or given) page.", {
  pageId: z.string().optional(),
});
relay("get_selection", "Return the current selection (serialised, with children up to `depth`).", {
  depth: z.number().int().min(0).max(10).optional(),
});
relay("get_node", "Return a node and its children up to `depth` (default 2).", {
  nodeId,
  depth: z.number().int().min(0).max(10).optional(),
});
relay("set_selection", "Select nodes and scroll/zoom them into view.", { nodeIds: z.array(z.string()).min(1) });

// --- create / edit -------------------------------------------------------------
const autoLayout = z
  .object({
    mode: z.enum(["HORIZONTAL", "VERTICAL", "NONE"]),
    gap: z.number().optional(),
    padding: z.union([z.number(), z.array(z.number()).length(4)]).optional().describe("number or [top,right,bottom,left]"),
    primaryAlign: z.enum(["MIN", "CENTER", "MAX", "SPACE_BETWEEN"]).optional(),
    counterAlign: z.enum(["MIN", "CENTER", "MAX", "BASELINE"]).optional(),
    sizing: z.enum(["HUG", "FIXED"]).optional().describe("Applies to both axes"),
    wrap: z.boolean().optional(),
  })
  .optional();

relay("create_frame", "Create a frame (optionally with auto layout) on the page or inside a parent.", {
  name: z.string().optional(),
  parentId: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  fill: z.string().optional().describe("Hex color; omit for white, 'none' for no fill"),
  cornerRadius: z.number().optional(),
  autoLayout,
});
relay("create_text", "Create a text node. Font is loaded automatically.", {
  characters: z.string(),
  parentId: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  fontFamily: z.string().optional().describe("Default Inter"),
  fontStyle: z.string().optional().describe("Default Regular"),
  fontSize: z.number().optional(),
  fill: z.string().optional(),
  width: z.number().optional().describe("Fixed width (enables wrapping)"),
  name: z.string().optional(),
});
relay(
  "set_properties",
  "Set arbitrary properties on nodes (e.g. {\"name\":\"Card\",\"opacity\":0.5,\"layoutMode\":\"VERTICAL\",\"itemSpacing\":8,\"fills\":\"#FF0000\",\"characters\":\"Hi\"}). " +
    "`fills`/`strokes` accept a hex string; `characters` loads fonts; width/height resize.",
  { nodeIds: z.array(z.string()).min(1), props: z.record(z.any()) }
);
relay("delete_nodes", "Delete nodes.", { nodeIds: z.array(z.string()).min(1) });

// --- variables -----------------------------------------------------------------
relay("get_variables", "List local variable collections, modes and variables with their values per mode.", {
  collection: z.string().optional().describe("Filter by collection name or id"),
});
relay("create_variable_collection", "Create a variable collection with the given mode names (first mode renames the default).", {
  name: z.string(),
  modes: z.array(z.string()).min(1).optional().describe("e.g. ['Light','Dark']"),
});
relay(
  "create_variables",
  "Create or update variables in a collection. values map mode name -> value: COLOR '#hex', FLOAT number, STRING string, BOOLEAN bool, " +
    "or {\"alias\":\"other/variable name\"} (looked up in the same collection first; add \"collection\" to point elsewhere). A single value (not a map) applies to all modes. Existing variables with the same name are updated.",
  {
    collection: z.string().describe("Collection name or id"),
    variables: z
      .array(
        z.object({
          name: z.string().describe("Use slashes for groups, e.g. 'color/primary/500'"),
          type: z.enum(["COLOR", "FLOAT", "STRING", "BOOLEAN"]),
          value: z.any().optional().describe("Value for all modes"),
          values: z.record(z.any()).optional().describe("mode name -> value"),
          scopes: z.array(z.string()).optional().describe("e.g. ['FRAME_FILL','SHAPE_FILL'] or ['GAP','WIDTH_HEIGHT']"),
          description: z.string().optional(),
        })
      )
      .min(1),
  }
);
relay(
  "bind_variable",
  "Bind a variable to node properties. field: 'fill' | 'stroke' (paint color) or any bindable node field: width, height, itemSpacing, " +
    "counterAxisSpacing, paddingTop/Right/Bottom/Left, cornerRadius, topLeftRadius..., strokeWeight, opacity, visible, characters, " +
    "fontSize, fontFamily, fontStyle, fontWeight, lineHeight, letterSpacing, minWidth, maxWidth... 'padding' and 'cornerRadius' bind all sides.",
  {
    nodeIds: z.array(z.string()).min(1),
    field: z.string(),
    variable: z.string().describe("Variable name or id"),
    collection: z.string().optional().describe("Disambiguate by collection name"),
  }
);
relay("set_variable_mode", "Set which mode of a collection a frame/section uses (e.g. Dark).", {
  nodeIds: z.array(z.string()).min(1),
  collection: z.string(),
  mode: z.string(),
});
relay("list_library_variables", "List variable collections (and optionally variables) from enabled team libraries.", {
  collectionKey: z.string().optional().describe("If given, list the variables in this library collection"),
}, { timeout: 60_000 });
relay("import_library_variable", "Import a library variable by key so it can be bound.", { key: z.string() });

// --- styles --------------------------------------------------------------------
relay("get_styles", "List local paint, text, effect and grid styles.", {});
relay("create_paint_style", "Create (or update by name) a paint style from a hex color or bound to a color variable.", {
  name: z.string(),
  hex: z.string().optional(),
  variable: z.string().optional().describe("Color variable name/id to bind"),
  collection: z.string().optional().describe("Disambiguate `variable` by collection name or id"),
  description: z.string().optional(),
});
relay("create_text_style", "Create (or update by name) a text style.", {
  name: z.string(),
  fontFamily: z.string(),
  fontStyle: z.string().optional(),
  fontSize: z.number(),
  lineHeight: z.union([z.number(), z.string()]).optional().describe("px number, '150%' or 'auto'"),
  letterSpacing: z.union([z.number(), z.string()]).optional().describe("px number or '2%'"),
  textCase: z.enum(["ORIGINAL", "UPPER", "LOWER", "TITLE"]).optional(),
  description: z.string().optional(),
});
relay("create_effect_style", "Create (or update by name) a drop-shadow effect style.", {
  name: z.string(),
  shadows: z
    .array(z.object({ color: z.string(), x: z.number(), y: z.number(), blur: z.number(), spread: z.number().optional(), inner: z.boolean().optional() }))
    .min(1),
});
relay("apply_style", "Apply a local style (by name or id) to nodes.", {
  nodeIds: z.array(z.string()).min(1),
  style: z.string().describe("Style name or id"),
  target: z.enum(["fill", "stroke", "text", "effect", "grid"]).optional().describe("Inferred from the style type when omitted (paint -> fill)"),
});

// --- components ------------------------------------------------------------------
relay("get_components", "List local components and component sets (with keys and variant properties).", {
  pageId: z.string().optional().describe("Limit to one page; default all pages (slower)"),
}, { timeout: 120_000 });
relay("create_component", "Convert an existing node into a component (or create an empty one when nodeId is omitted).", {
  nodeId: z.string().optional(),
  name: z.string().optional(),
});
relay("combine_as_variants", "Combine components into a component set. Name components like 'Size=Large, State=Hover' to define variant properties.", {
  componentIds: z.array(z.string()).min(1),
  name: z.string().optional(),
});
relay("add_component_property", "Add a component property (BOOLEAN, TEXT, INSTANCE_SWAP, VARIANT) to a component or component set.", {
  nodeId,
  name: z.string(),
  type: z.enum(["BOOLEAN", "TEXT", "INSTANCE_SWAP", "VARIANT"]),
  defaultValue: z.union([z.string(), z.boolean()]),
  bindToNodeId: z.string().optional().describe("Child node whose visibility (BOOLEAN) / characters (TEXT) / mainComponent (INSTANCE_SWAP) is controlled by the property"),
});
relay("create_instance", "Create an instance of a local component (id) or a library component/component set (key).", {
  componentId: z.string().optional(),
  componentKey: z.string().optional(),
  isComponentSet: z.boolean().optional().describe("Set when componentKey is a component set key (uses its default variant)"),
  parentId: z.string().optional(),
  x: z.number().optional(),
  y: z.number().optional(),
  properties: z.record(z.union([z.string(), z.boolean()])).optional().describe("Instance property values, e.g. {\"Size\":\"Large\"}"),
});
relay("set_instance_properties", "Set component properties on instances (variant values, booleans, text, instance swap).", {
  nodeIds: z.array(z.string()).min(1),
  properties: z.record(z.union([z.string(), z.boolean()])).describe("Property names may omit the '#id' suffix"),
});

// --- extra tool modules (server/tools/*.js) --------------------------------------
// Each module exports `register(ctx)` and registers its own tools via ctx.relay / ctx.mcp.registerTool.
const toolsDir = join(dirname(fileURLToPath(import.meta.url)), "tools");
const ctx = { mcp, z, relay, call, ok, fail, fileParam, nodeId, log };
for (const f of readdirSync(toolsDir).filter((f) => f.endsWith(".js")).sort()) {
  const mod = await import(pathToFileURL(join(toolsDir, f)).href);
  if (typeof mod.register === "function") mod.register(ctx);
}

// ---------------------------------------------------------------------------

await startWs();
mcp.server.oninitialized = () => { for (const ws of sockets) sendServerInfo(ws); };
await mcp.connect(new StdioServerTransport());
log("MCP ready");
