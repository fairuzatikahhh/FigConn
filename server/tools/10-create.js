// Creation tools: shapes, SVG, images, pages, sections.
// Plugin handlers live in plugin/src/10-create.js.

import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_TIMEOUT = 60_000;

function expandPath(p) {
  let s = String(p).trim();
  if (s.startsWith("file://")) s = decodeURIComponent(new URL(s).pathname);
  if (s === "~" || s.startsWith("~/")) s = homedir() + s.slice(1);
  return isAbsolute(s) ? s : resolve(s);
}

function sniffImage(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "png";
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (buf.length >= 6 && buf.toString("ascii", 0, 4) === "GIF8") return "gif";
  if (buf.length >= 12 && buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") return "webp";
  return null;
}

function looksLikeSvg(buf) {
  const head = buf.toString("utf8", 0, Math.min(buf.length, 1024)).trimStart().toLowerCase();
  return head.startsWith("<svg") || (head.startsWith("<?xml") && head.includes("<svg"));
}

function tooBig(n) {
  return new Error(`Image is ${(n / 1048576).toFixed(1)} MB; the limit is 20 MB.`);
}

/** Load image bytes from a local path, http(s) URL or data URI. */
export async function loadImageSource(source) {
  const src = String(source).trim();
  let buf;
  if (/^data:/i.test(src)) {
    const m = /^data:([^,]*?),(.*)$/is.exec(src);
    if (!m) throw new Error("Malformed data URI");
    const isB64 = /;base64$/i.test(m[1]);
    buf = isB64 ? Buffer.from(m[2], "base64") : Buffer.from(decodeURIComponent(m[2]), "utf8");
  } else if (/^https?:\/\//i.test(src)) {
    const res = await fetch(src, { redirect: "follow", signal: AbortSignal.timeout(IMAGE_TIMEOUT - 10_000) });
    if (!res.ok) throw new Error(`Fetching ${src} failed: HTTP ${res.status} ${res.statusText}`);
    const len = Number(res.headers.get("content-length") || 0);
    if (len > MAX_IMAGE_BYTES) throw tooBig(len);
    buf = Buffer.from(await res.arrayBuffer());
  } else {
    const path = expandPath(src);
    let st;
    try { st = await stat(path); } catch { throw new Error(`File not found: ${path}`); }
    if (!st.isFile()) throw new Error(`Not a file: ${path}`);
    if (st.size > MAX_IMAGE_BYTES) throw tooBig(st.size);
    buf = await readFile(path);
  }
  if (buf.length > MAX_IMAGE_BYTES) throw tooBig(buf.length);
  if (buf.length === 0) throw new Error("Image source is empty");
  const kind = sniffImage(buf);
  if (!kind) {
    if (looksLikeSvg(buf)) throw new Error("Source is an SVG; use create_svg instead.");
    throw new Error("Source is not a PNG, JPEG, GIF or WebP image.");
  }
  return { base64: buf.toString("base64"), kind, bytes: buf.length };
}

export function register(ctx) {
  const { mcp, z, relay, call, ok, fail, fileParam } = ctx;

  const pos = {
    name: z.string().optional(),
    parentId: z.string().optional().describe("Parent frame/group/section id; default current page"),
    x: z.number().optional().describe("Position relative to parent. If x, y and parentId are all omitted the node is centred in the viewport"),
    y: z.number().optional(),
  };

  // --- create_shape -------------------------------------------------------------
  relay(
    "create_shape",
    "Create a basic shape: RECTANGLE, ELLIPSE, LINE, POLYGON or STAR. Size defaults to 100x100 (height defaults to width). " +
      "LINE: `width` is the length (no height; use `rotation` for direction) and gets a black 1px stroke unless `stroke` is given. " +
      "POLYGON uses `pointCount` (sides, default 3); STAR uses `pointCount` (default 5) and `innerRadius` (0-1 ratio, default ~0.38). " +
      "fill/stroke are hex (#RRGGBB / #RRGGBBAA), fill 'none' removes the default grey fill. cornerRadius works on RECTANGLE/POLYGON/STAR. " +
      "rotation is in degrees (counter-clockwise, around the top-left corner) and is applied after positioning. Returns the created node.",
    {
      shapeType: z.enum(["RECTANGLE", "ELLIPSE", "LINE", "POLYGON", "STAR"]),
      ...pos,
      width: z.number().positive().optional().describe("Width (LINE: length). Default 100"),
      height: z.number().positive().optional().describe("Height (ignored for LINE). Default = width"),
      rotation: z.number().optional().describe("Degrees"),
      fill: z.string().optional().describe("Hex color or 'none'"),
      stroke: z.string().optional().describe("Hex color or 'none'"),
      strokeWeight: z.number().min(0).optional(),
      cornerRadius: z.number().min(0).optional(),
      pointCount: z.number().int().min(3).max(60).optional().describe("POLYGON sides / STAR points"),
      innerRadius: z.number().min(0).max(1).optional().describe("STAR only: inner radius ratio 0-1"),
    }
  );

  // --- create_svg ---------------------------------------------------------------
  mcp.registerTool(
    "create_svg",
    {
      description:
        "Import SVG as editable vector layers (wrapped in a frame). Give either `svg` (raw markup) or `path` (local .svg file read by the server). " +
        "Set width and/or height to scale it (only one -> proportional; both -> scale then stretch). " +
        "`flatten: true` merges all shapes into a single vector inside the frame — handy for icons. Returns the frame (with children when flattened).",
      inputSchema: {
        svg: z.string().optional().describe("Raw SVG markup, e.g. '<svg viewBox=\"0 0 24 24\">...</svg>'"),
        path: z.string().optional().describe("Local .svg file path (absolute, ~ or relative to the server cwd)"),
        ...pos,
        width: z.number().positive().optional(),
        height: z.number().positive().optional(),
        flatten: z.boolean().optional().describe("Flatten all layers into one vector"),
        file: fileParam,
      },
    },
    async ({ svg, path, file, ...rest }) => {
      try {
        if (!svg && !path) throw new Error("Provide `svg` markup or a `path` to an .svg file");
        if (svg && path) throw new Error("Provide only one of `svg` or `path`");
        let markup = svg;
        if (path) {
          const p = expandPath(path);
          try { markup = await readFile(p, "utf8"); } catch { throw new Error(`Cannot read SVG file: ${p}`); }
        }
        if (!/<svg[\s>]/i.test(markup)) throw new Error("Input does not contain an <svg> element");
        return ok(await call("create_svg", { svg: markup, ...rest }, { file, timeout: IMAGE_TIMEOUT }));
      } catch (e) {
        return fail(e);
      }
    }
  );

  // --- create_image -------------------------------------------------------------
  mcp.registerTool(
    "create_image",
    {
      description:
        "Place a raster image (PNG/JPEG/GIF; max 20 MB, max 4096x4096 px) as a rectangle with an IMAGE fill. " +
        "`source` is an absolute local path, an http(s) URL or a data URI — the server loads the bytes. " +
        "Default size is the image's natural size; give width or height alone to scale proportionally, or both to set the box (scaleMode decides how the image fits). " +
        "With `targetNodeId` the image instead replaces the fills of an existing node (frame, rectangle, ellipse, ...) and no node is created. " +
        "Returns the node plus image {hash, width, height}. Use create_svg for SVG files.",
      inputSchema: {
        source: z.string().describe("Absolute file path, http(s) URL, or data:image/...;base64,... URI"),
        targetNodeId: z.string().optional().describe("Set the image as the fill of this existing node instead of creating a rectangle"),
        scaleMode: z.enum(["FILL", "FIT", "CROP", "TILE"]).optional().describe("Default FILL"),
        ...pos,
        width: z.number().positive().optional(),
        height: z.number().positive().optional(),
        cornerRadius: z.number().min(0).optional(),
        file: fileParam,
      },
    },
    async ({ source, file, ...rest }) => {
      try {
        const img = await loadImageSource(source);
        const result = await call("create_image", { ...rest, imageBase64: img.base64 }, { file, timeout: IMAGE_TIMEOUT });
        if (result && typeof result === "object" && result.image) { result.image.format = img.kind; result.image.bytes = img.bytes; }
        return ok(result);
      } catch (e) {
        return fail(e);
      }
    }
  );

  // --- create_page --------------------------------------------------------------
  relay("create_page", "Create a new page. `setCurrent: true` switches to it. Returns {id, name, current}.", {
    name: z.string().optional(),
    setCurrent: z.boolean().optional(),
  });

  // --- sections -----------------------------------------------------------------
  relay(
    "create_section",
    "Create a section (canvas organiser; parent must be the page or another section, not a frame). Default size 400x300. " +
      "`childIds` moves existing nodes into the section keeping their position on canvas (per-node results in `moved`). " +
      "`fitToContent` resizes/moves the section to wrap its children with `padding` (default 40) — it defaults to true when childIds " +
      "are given without width/height, so `create_section({name, childIds})` just wraps those nodes.",
    {
      ...pos,
      width: z.number().positive().optional(),
      height: z.number().positive().optional(),
      fill: z.string().optional().describe("Hex color or 'none'"),
      childIds: z.array(z.string()).optional().describe("Existing nodes (same page) to move into the section"),
      fitToContent: z.boolean().optional(),
      padding: z.number().min(0).optional().describe("Padding used by fitToContent. Default 40"),
    }
  );
  relay(
    "fit_section",
    "Resize a section (or a frame without auto layout) to wrap its children with `padding` (default 40). Children keep their position on canvas; " +
      "the container moves/resizes around them. Give `nodeId` (returns the node) or `nodeIds` (returns per-node results with {id, error} on failure).",
    {
      nodeId: z.string().optional(),
      nodeIds: z.array(z.string()).min(1).optional(),
      padding: z.number().min(0).optional(),
    }
  );
}
