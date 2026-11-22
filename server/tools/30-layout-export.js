// Tier 2 — layout helpers & export.
// Tools: get_screenshot, save_screenshots, place_relative, distribute_nodes, align_nodes, arrange_grid,
// align_to_grid, set_constraints, get_layout_tree, scroll_into_view.
// Plugin handlers live in plugin/src/30-layout-export.js.

import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, extname } from "node:path";
import { homedir } from "node:os";

const EXPORT_TIMEOUT = 120_000;
const MIME = { PNG: "image/png", JPG: "image/jpeg" };
const EXT = { PNG: ".png", JPG: ".jpg", SVG: ".svg", PDF: ".pdf" };

function resolvePath(p) {
  if (p === "~" || p.startsWith("~/")) p = join(homedir(), p.slice(1));
  return isAbsolute(p) ? p : resolve(process.cwd(), p);
}

function sanitizeName(name) {
  const s = String(name || "node")
    .replace(/[\/\\:*?"<>|\x00-\x1f]+/g, "-")
    .replace(/\s+/g, " ")
    .replace(/^[\s.-]+|[\s.-]+$/g, "")
    .slice(0, 120);
  return s || "node";
}

export function register(ctx) {
  const { mcp, z, relay, call, ok, fail, fileParam, nodeId } = ctx;

  const formatEnum = z.enum(["PNG", "JPG", "SVG", "PDF"]);
  const scaleNum = z.number().min(0.1).max(4);
  const nodeIds = z.array(z.string()).min(1);

  // --- get_screenshot ------------------------------------------------------------
  mcp.registerTool(
    "get_screenshot",
    {
      description:
        "Render a node as an image and return it inline. nodeId defaults to the first selected node. " +
        "PNG/JPG come back as an image plus a text line 'name (id) w×h'; SVG comes back as SVG markup text. " +
        "PDF cannot be shown inline — use save_screenshots to write it to disk. " +
        "The scale is lowered automatically so the longest side stays ≤ maxDimension (default 4096 px).",
      inputSchema: {
        nodeId: z.string().optional().describe("Node id; default the first selected node"),
        format: formatEnum.optional().describe("Default PNG"),
        scale: scaleNum.optional().describe("0.1–4, default 1 (PNG/JPG only)"),
        useAbsoluteBounds: z.boolean().optional().describe("Export the node's full bounds (ignore effects/clipping overflow, keep cropped text)"),
        maxDimension: z.number().int().min(16).max(16384).optional().describe("Max longest side in px (default 4096)"),
        file: fileParam,
      },
    },
    async ({ file, ...params }) => {
      if (params.format === "PDF") {
        return fail("PDF cannot be returned inline. Use save_screenshots with format 'PDF' to write it to a file.");
      }
      try {
        const r = await call("get_screenshot", params, { file, timeout: EXPORT_TIMEOUT });
        if (r.format === "SVG") {
          return { content: [{ type: "text", text: `${r.name} (${r.id}) ${r.width}×${r.height} SVG` }, { type: "text", text: r.svg }] };
        }
        let line = `${r.name} (${r.id}) ${r.width}×${r.height}`;
        if (r.downscaled) line += ` — scale lowered from ${r.requestedScale} to ${r.scale} to fit maxDimension`;
        return {
          content: [
            { type: "image", data: r.base64, mimeType: MIME[r.format] || "image/png" },
            { type: "text", text: line },
          ],
        };
      } catch (e) {
        return fail(e);
      }
    }
  );

  // --- save_screenshots ----------------------------------------------------------
  mcp.registerTool(
    "save_screenshots",
    {
      description:
        "Export nodes to files on disk (PNG, JPG, SVG or PDF). Either pass `items` [{nodeId, path, format?, scale?}] " +
        "or the shortcut `nodeIds` + `dir` (files are named from the sanitized node names, with the id appended on collisions). " +
        "Paths may be absolute or relative to the server's working directory; parent directories are created. " +
        "Returns metadata only (path, bytes, pixel size) — never the image data. Per-item errors don't abort the batch.",
      inputSchema: {
        items: z
          .array(
            z.object({
              nodeId,
              path: z.string().describe("Output file path; extension is added if missing"),
              format: formatEnum.optional(),
              scale: scaleNum.optional(),
            })
          )
          .optional(),
        nodeIds: z.array(z.string()).optional().describe("Shortcut: export these nodes into `dir`"),
        dir: z.string().optional().describe("Output directory for the nodeIds shortcut"),
        format: formatEnum.optional().describe("Default format for all items (default PNG)"),
        scale: scaleNum.optional().describe("Default scale for all items (default 1)"),
        useAbsoluteBounds: z.boolean().optional(),
        maxDimension: z.number().int().min(16).max(16384).optional().describe("Max longest side in px for PNG/JPG (default 4096)"),
        file: fileParam,
      },
    },
    async ({ items, nodeIds: ids, dir, format, scale, useAbsoluteBounds, maxDimension, file }) => {
      const jobs = [...(items || [])];
      if (ids && ids.length) {
        if (!dir) return fail("`dir` is required with `nodeIds`");
        for (const id of ids) jobs.push({ nodeId: id, dir });
      }
      if (!jobs.length) return fail("Pass `items` or `nodeIds` + `dir`");

      const used = new Set();
      const results = [];
      for (const job of jobs) {
        const fmt = (job.format || format || "PNG").toUpperCase();
        try {
          const r = await call(
            "export_node_bytes",
            { nodeId: job.nodeId, format: fmt, scale: job.scale ?? scale, useAbsoluteBounds, maxDimension },
            { file, timeout: EXPORT_TIMEOUT }
          );
          const ext = EXT[r.format] || ".png";
          let out;
          if (job.path) {
            out = resolvePath(job.path);
            if (extname(out).toLowerCase() !== ext && !(ext === ".jpg" && extname(out).toLowerCase() === ".jpeg")) out += ext;
          } else {
            const base = join(resolvePath(job.dir), sanitizeName(r.name));
            out = base + ext;
            if (used.has(out)) out = `${base} ${sanitizeName(r.id.replace(/:/g, "-"))}${ext}`;
          }
          used.add(out);
          const buf = r.format === "SVG" ? Buffer.from(r.svg, "utf8") : Buffer.from(r.base64, "base64");
          await mkdir(dirname(out), { recursive: true });
          await writeFile(out, buf);
          const meta = { nodeId: r.id, name: r.name, path: out, format: r.format, bytes: buf.length, width: r.width, height: r.height };
          if (r.scale !== undefined) meta.scale = r.scale;
          if (r.downscaled) meta.downscaledFrom = r.requestedScale;
          results.push(meta);
        } catch (e) {
          results.push({ nodeId: job.nodeId, path: job.path, error: String(e && e.message ? e.message : e) });
        }
      }
      return ok({ saved: results.filter((r) => !r.error).length, failed: results.filter((r) => r.error).length, results });
    }
  );

  // --- positioning -----------------------------------------------------------------
  relay(
    "place_relative",
    "Move a node next to another node: side right|left|below|above with a gap, aligned start|center|end along the other axis. " +
      "Uses absolute (page) coordinates, so the two nodes may have different parents. Fails for auto-layout children that " +
      "aren't absolutely positioned.",
    {
      nodeId: nodeId.describe("Node to move"),
      relativeToId: z.string().describe("Reference node (not moved)"),
      side: z.enum(["right", "left", "below", "above"]).optional().describe("Default right"),
      gap: z.number().optional().describe("Spacing in px, default 0"),
      align: z.enum(["start", "center", "end"]).optional().describe("Cross-axis alignment to the reference, default start (top for left/right, left for above/below)"),
    }
  );

  relay(
    "distribute_nodes",
    "Distribute nodes along an axis (ordered by current position). Without `gap`: the outermost nodes stay put and the " +
      "spacing between them is equalised (needs ≥3 nodes). With `gap`: nodes are laid out sequentially from the first one " +
      "with that fixed spacing. Works in absolute coordinates; per-node errors are reported.",
    {
      nodeIds: z.array(z.string()).min(2),
      axis: z.enum(["horizontal", "vertical"]).optional().describe("Default horizontal"),
      gap: z.number().optional().describe("Fixed spacing in px; omit to equalise between the extremes"),
    }
  );

  relay(
    "align_nodes",
    "Align nodes' edges or centers: left|hcenter|right|top|vcenter|bottom. `to`: 'selection' (default — the union bounds " +
      "of the given nodes), 'parent' (each node's parent frame), or a node id (that node's bounds; it is not moved).",
    {
      nodeIds,
      align: z.enum(["left", "hcenter", "right", "top", "vcenter", "bottom"]),
      to: z.string().optional().describe("'selection' (default), 'parent', or a node id"),
    }
  );

  relay(
    "arrange_grid",
    "Lay out nodes in a grid in the given order (row by row). Column width = widest node in that column, row height = " +
      "tallest node in that row. Origin defaults to the top-left of the nodes' current union bounds (absolute coordinates). " +
      "Handy for variant / component sheets.",
    {
      nodeIds,
      columns: z.number().int().min(1),
      gapX: z.number().optional().describe("Horizontal gap, default 0"),
      gapY: z.number().optional().describe("Vertical gap, default 0"),
      x: z.number().optional().describe("Origin x (absolute)"),
      y: z.number().optional().describe("Origin y (absolute)"),
    }
  );

  relay(
    "align_to_grid",
    "Snap nodes' x/y (relative to their parent) to a grid of `gridSize` px; with snapSize also round width/height to the grid. " +
      "Returns before/after per node.",
    {
      nodeIds,
      gridSize: z.number().positive(),
      snapSize: z.boolean().optional().describe("Also snap width/height (min one grid unit)"),
    }
  );

  relay(
    "set_constraints",
    "Set resize constraints on nodes. Pass horizontal and/or vertical (MIN|MAX|CENTER|STRETCH|SCALE); the unspecified " +
      "axis is kept. Auto-layout children that aren't absolutely positioned return an error. Returns previous and new values.",
    {
      nodeIds,
      horizontal: z.enum(["MIN", "MAX", "CENTER", "STRETCH", "SCALE"]).optional(),
      vertical: z.enum(["MIN", "MAX", "CENTER", "STRETCH", "SCALE"]).optional(),
    }
  );

  // --- inspection / viewport ---------------------------------------------------------
  relay(
    "get_layout_tree",
    "Flat geometry dump of a subtree (pre-order): id, name, type, parentId, depth, absolute x/y/width/height " +
      "(absoluteBoundingBox), absoluteRenderBounds, rotation, visible, and layoutMode/padding/itemSpacing, " +
      "layoutPositioning, sizing (hug/fill/fixed), constraints where relevant. rootId defaults to the current page. " +
      "`truncated` is true when maxNodes was hit.",
    {
      rootId: z.string().optional().describe("Root node or page id; default current page"),
      maxNodes: z.number().int().min(1).max(20000).optional().describe("Default 2000"),
      maxDepth: z.number().int().min(0).optional().describe("Max depth below root (default unlimited)"),
      includeHidden: z.boolean().optional().describe("Include hidden nodes (default true)"),
    },
    { timeout: 60_000 }
  );

  relay(
    "scroll_into_view",
    "Scroll the viewport to show nodes without changing the selection (switches page if needed). Without `zoom` it " +
      "fits the nodes; with `zoom` (1 = 100%) it centers on them at that zoom level.",
    {
      nodeIds,
      zoom: z.number().positive().max(256).optional(),
    }
  );
}
