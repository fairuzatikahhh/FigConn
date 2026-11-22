// Editing & structure tools: auto layout, layout children, effects, gradients, strokes,
// duplicate, group/ungroup, reparent, reorder. Plugin handlers live in plugin/src/20-edit.js.

export function register({ z, relay }) {
  const nodeIds = z.array(z.string()).min(1).describe("Figma node ids, e.g. ['12:34']");
  const hex = z.string().describe("Hex color #RRGGBB or #RRGGBBAA (alpha)");
  const perNode = "Returns per-node results ({id, ok, ...} or {id, error}); one failing node does not abort the batch.";

  // --- 1. set_auto_layout ------------------------------------------------------
  relay(
    "set_auto_layout",
    "Add, change or remove auto layout on frames / components / instances. Only the options you pass are changed. " +
      "gap: number, or 'AUTO' for space-between. padding: number | [vertical, horizontal] | [top,right,bottom,left] | {top,right,bottom,left}. " +
      "primarySizing/counterSizing: HUG (auto) or FIXED. wrap (HORIZONTAL only) + counterGap = spacing between wrapped rows. " +
      "mode NONE removes auto layout. " + perNode,
    {
      nodeIds,
      mode: z.enum(["HORIZONTAL", "VERTICAL", "NONE"]).optional(),
      gap: z.union([z.number(), z.literal("AUTO")]).optional().describe("Item spacing, or 'AUTO' = space between"),
      counterGap: z.number().optional().describe("Spacing between wrapped rows (requires wrap)"),
      padding: z
        .union([
          z.number(),
          z.array(z.number()).length(2),
          z.array(z.number()).length(4),
          z.object({ top: z.number().optional(), right: z.number().optional(), bottom: z.number().optional(), left: z.number().optional() }),
        ])
        .optional()
        .describe("number | [v,h] | [top,right,bottom,left] | {top,right,bottom,left} (object form sets only given sides)"),
      primaryAlign: z.enum(["MIN", "CENTER", "MAX", "SPACE_BETWEEN"]).optional().describe("Alignment along the layout direction"),
      counterAlign: z.enum(["MIN", "CENTER", "MAX", "BASELINE"]).optional().describe("Alignment across the layout direction (BASELINE: horizontal only)"),
      primarySizing: z.enum(["HUG", "FIXED"]).optional().describe("Size along the layout direction"),
      counterSizing: z.enum(["HUG", "FIXED"]).optional().describe("Size across the layout direction"),
      wrap: z.boolean().optional().describe("Wrap children onto new rows (HORIZONTAL only)"),
      clipsContent: z.boolean().optional(),
      strokesIncludedInLayout: z.boolean().optional(),
    }
  );

  // --- 2. set_layout_child -----------------------------------------------------
  relay(
    "set_layout_child",
    "Set how nodes behave inside their auto-layout parent: horizontal/vertical sizing (FILL needs an auto-layout parent; HUG needs the node " +
      "itself to be auto layout or text), positioning AUTO|ABSOLUTE (ignore auto layout), grow (1 = fill along parent's direction), " +
      "alignSelf STRETCH|INHERIT (fill across parent's direction), and min/max width/height (null clears). " + perNode,
    {
      nodeIds,
      horizontal: z.enum(["FILL", "HUG", "FIXED"]).optional().describe("layoutSizingHorizontal"),
      vertical: z.enum(["FILL", "HUG", "FIXED"]).optional().describe("layoutSizingVertical"),
      positioning: z.enum(["AUTO", "ABSOLUTE"]).optional().describe("layoutPositioning"),
      grow: z.number().min(0).max(1).optional().describe("layoutGrow: 0 or 1"),
      alignSelf: z.enum(["STRETCH", "INHERIT"]).optional().describe("layoutAlign"),
      minWidth: z.number().nullable().optional(),
      maxWidth: z.number().nullable().optional(),
      minHeight: z.number().nullable().optional(),
      maxHeight: z.number().nullable().optional(),
    }
  );

  // --- 3. set_effects ----------------------------------------------------------
  relay(
    "set_effects",
    "Set effects on nodes. Replaces existing effects by default ([] clears all; mode 'append' adds). " +
      "Shadows: color (alpha via #RRGGBBAA, default #00000040), x, y (default 0,4), blur (default 4), spread, blendMode, " +
      "showShadowBehindNode (drop shadow only). Blurs (LAYER_BLUR / BACKGROUND_BLUR) use only blur and visible. " +
      "Setting effects detaches any effect style. " + perNode,
    {
      nodeIds,
      effects: z
        .array(
          z.object({
            type: z.enum(["DROP_SHADOW", "INNER_SHADOW", "LAYER_BLUR", "BACKGROUND_BLUR"]).default("DROP_SHADOW"),
            color: hex.optional(),
            x: z.number().optional(),
            y: z.number().optional(),
            blur: z.number().min(0).optional().describe("Blur radius"),
            spread: z.number().optional(),
            visible: z.boolean().optional(),
            blendMode: z.string().optional().describe("e.g. NORMAL, MULTIPLY"),
            showShadowBehindNode: z.boolean().optional(),
          })
        )
        .describe("Effects list; [] clears"),
      mode: z.enum(["replace", "append"]).optional().describe("Default replace"),
    }
  );

  // --- 4. set_gradient ---------------------------------------------------------
  relay(
    "set_gradient",
    "Apply a gradient paint to fills or strokes. Give either `angle` in degrees (0 = left→right, 90 = top→bottom, 180 = right→left, " +
      "45 = top-left corner → bottom-right corner; measured in the node's box so corners always hit 0%/100% for LINEAR; default 90 for LINEAR, 0 otherwise) " +
      "or a raw 2x3 `transform` (Figma gradientTransform). RADIAL/DIAMOND/ANGULAR are centered and fill the box. " +
      "mode replace (default) replaces all paints; append adds on top. " + perNode,
    {
      nodeIds,
      target: z.enum(["fill", "stroke"]).optional().describe("Default fill"),
      type: z.enum(["LINEAR", "RADIAL", "ANGULAR", "DIAMOND"]).optional().describe("Default LINEAR"),
      stops: z
        .array(z.object({ position: z.number().min(0).max(1), color: hex }))
        .min(2)
        .describe("Color stops, position 0..1"),
      angle: z.number().optional(),
      transform: z
        .array(z.array(z.number()).length(3))
        .length(2)
        .optional()
        .describe("Raw gradientTransform [[a,b,tx],[c,d,ty]] (overrides angle)"),
      opacity: z.number().min(0).max(1).optional().describe("Paint opacity"),
      mode: z.enum(["replace", "append"]).optional(),
    }
  );

  // --- 5. set_stroke -----------------------------------------------------------
  relay(
    "set_stroke",
    "Set stroke color / weight / alignment / dashes on nodes. color 'none' removes strokes. `sides` sets per-side weights " +
      "(frames, components, instances, rectangles), e.g. {bottom: 1, top: 0, left: 0, right: 0} for a bottom border. " +
      "Only the options you pass are changed. " + perNode,
    {
      nodeIds,
      color: z.string().optional().describe("Hex #RRGGBB / #RRGGBBAA, or 'none' to remove strokes"),
      weight: z.number().min(0).optional(),
      sides: z
        .object({ top: z.number().min(0).optional(), right: z.number().min(0).optional(), bottom: z.number().min(0).optional(), left: z.number().min(0).optional() })
        .optional()
        .describe("Per-side stroke weights"),
      align: z.enum(["INSIDE", "OUTSIDE", "CENTER"]).optional(),
      dashPattern: z.array(z.number().min(0)).optional().describe("e.g. [4, 4] for dashed; [] for solid"),
      cap: z.enum(["NONE", "ROUND", "SQUARE", "ARROW_LINES", "ARROW_EQUILATERAL"]).optional().describe("strokeCap (lines/vectors)"),
      join: z.enum(["MITER", "BEVEL", "ROUND"]).optional(),
    }
  );

  // --- 6. duplicate_nodes ------------------------------------------------------
  relay(
    "duplicate_nodes",
    "Duplicate nodes. Each copy is offset by (offsetX, offsetY) from the previous one; `count` makes N copies with cumulative offset " +
      "(copy k sits at original + k*offset). Copies stay in the original's parent (just above it) unless `parentId` is given, " +
      "in which case they are appended there at the same relative x/y (+offset). Positions are ignored inside auto-layout parents. " +
      "Returns per source node {id, clones:[...]}.",
    {
      nodeIds,
      offsetX: z.number().optional().describe("Default 0"),
      offsetY: z.number().optional().describe("Default 0"),
      count: z.number().int().min(1).max(100).optional().describe("Copies per node, default 1"),
      parentId: z.string().optional().describe("Place the copies in this parent instead"),
    }
  );

  // --- 7. group_nodes ----------------------------------------------------------
  relay(
    "group_nodes",
    "Wrap nodes that share the same parent in a group (or, with asFrame, a transparent non-clipping frame sized to their bounds). " +
      "Absolute positions and z-order are preserved. Returns the new group/frame with its children.",
    {
      nodeIds,
      name: z.string().optional(),
      asFrame: z.boolean().optional().describe("Wrap in a frame instead of a group"),
    }
  );

  // --- 8. ungroup_node ---------------------------------------------------------
  relay(
    "ungroup_node",
    "Ungroup groups, or unwrap frames/sections: children move to the container's parent at the same absolute position and z-order, " +
      "and the container is deleted (a frame's own fill/stroke/effects are lost). Returns per node {id, children:[new child ids], parentId}.",
    { nodeIds }
  );

  // --- 9. reparent_nodes -------------------------------------------------------
  relay(
    "reparent_nodes",
    "Move nodes into another parent (frame, group, section, page, component...). `index` inserts at that z-position " +
      "(0 = bottom; multiple nodes go in consecutively); default is on top. keepPosition (default true) preserves the absolute " +
      "on-canvas position unless the new parent's auto layout controls it. " + perNode,
    {
      nodeIds,
      parentId: z.string().describe("New parent node id (a page id moves to top level of that page)"),
      index: z.number().int().min(0).optional(),
      keepPosition: z.boolean().optional().describe("Default true"),
    }
  );

  // --- 10. reorder_nodes -------------------------------------------------------
  relay(
    "reorder_nodes",
    "Change z-order (layer order) of nodes within their parent: 'front' (top), 'back' (bottom), 'forward' / 'backward' (one step), " +
      "or a numeric index (0 = bottom). In auto-layout frames this also changes item order. Returns per node its new index.",
    {
      nodeIds,
      to: z.union([z.enum(["front", "back", "forward", "backward"]), z.number().int().min(0)]),
    }
  );
}
