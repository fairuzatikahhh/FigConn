// Tier 3 tools: prototype interactions (Figma Design) and FigJam board objects.
// Plugin handlers live in plugin/src/40-prototype-figjam.js.
// Times are milliseconds on this side; the plugin converts to the seconds the Plugin API uses.

export function register({ z, relay }) {
  // --- shared schemas ---------------------------------------------------------
  const TRIGGERS = [
    "ON_CLICK", "ON_HOVER", "ON_PRESS", "ON_DRAG", "AFTER_TIMEOUT",
    "MOUSE_ENTER", "MOUSE_LEAVE", "MOUSE_UP", "MOUSE_DOWN", "ON_KEY_DOWN",
  ];
  const ACTIONS = ["NAVIGATE", "OVERLAY", "SWAP", "SCROLL_TO", "CHANGE_TO", "BACK", "CLOSE", "URL"];
  const EASINGS = [
    "EASE_IN", "EASE_OUT", "EASE_IN_AND_OUT", "LINEAR", "EASE_IN_BACK", "EASE_OUT_BACK", "EASE_IN_AND_OUT_BACK",
    "CUSTOM_CUBIC_BEZIER", "GENTLE", "QUICK", "BOUNCY", "SLOW", "CUSTOM_SPRING",
  ];
  const transition = z
    .object({
      type: z
        .enum(["INSTANT", "DISSOLVE", "SMART_ANIMATE", "SCROLL_ANIMATE", "MOVE_IN", "MOVE_OUT", "PUSH", "SLIDE_IN", "SLIDE_OUT"])
        .describe("INSTANT = no animation"),
      durationMs: z.number().min(0).optional().describe("Default 300"),
      easing: z.enum(EASINGS).optional().describe("Default EASE_OUT"),
      direction: z.enum(["LEFT", "RIGHT", "TOP", "BOTTOM"]).optional().describe("MOVE_IN/MOVE_OUT/PUSH/SLIDE_IN/SLIDE_OUT only (default LEFT)"),
      matchLayers: z.boolean().optional().describe("Directional transitions: smart-animate matching layers"),
      bezier: z.array(z.number()).length(4).optional().describe("[x1,y1,x2,y2] for CUSTOM_CUBIC_BEZIER"),
      spring: z
        .object({ mass: z.number(), stiffness: z.number(), damping: z.number(), initialVelocity: z.number().optional() })
        .optional()
        .describe("For CUSTOM_SPRING"),
    })
    .optional();
  const magnet = z.enum(["AUTO", "TOP", "BOTTOM", "LEFT", "RIGHT", "CENTER", "NONE"]).optional();
  const cap = z
    .enum([
      "NONE", "ARROW_LINES", "ARROW_EQUILATERAL", "TRIANGLE_FILLED", "DIAMOND_FILLED", "CIRCLE_FILLED",
      "ERD_ZERO_OR_ONE", "ERD_EXACTLY_ONE", "ERD_ZERO_OR_MORE", "ERD_ONE_OR_MORE", "ERD_ONE", "ERD_MANY",
    ])
    .optional();
  const SHAPES = [
    "SQUARE", "ELLIPSE", "ROUNDED_RECTANGLE", "DIAMOND", "TRIANGLE_UP", "TRIANGLE_DOWN", "PARALLELOGRAM_RIGHT",
    "PARALLELOGRAM_LEFT", "ENG_DATABASE", "ENG_QUEUE", "ENG_FILE", "ENG_FOLDER", "TRAPEZOID", "PREDEFINED_PROCESS",
    "SHIELD", "DOCUMENT_SINGLE", "DOCUMENT_MULTIPLE", "MANUAL_INPUT", "HEXAGON", "CHEVRON", "PENTAGON", "OCTAGON",
    "STAR", "PLUS", "ARROW_LEFT", "ARROW_RIGHT", "SUMMING_JUNCTION", "OR", "SPEECH_BUBBLE", "INTERNAL_STORAGE",
  ];

  // --- prototype (Figma Design only) ------------------------------------------------
  relay(
    "get_prototype_connections",
    "Read prototype interactions (Figma Design only; errors in FigJam). Walks a node and all descendants, including instance " +
      "sublayers, and returns every node with reactions: trigger (timeouts/delays also as *Ms) and actions. NODE actions resolve " +
      "destinationId to {id, name, type, screen (top-level frame), page}; SET_VARIABLE / SET_VARIABLE_MODE resolve variable, " +
      "collection and mode names; CONDITIONAL actions are expanded recursively into blocks {condition, isElse, actions}. Also " +
      "returns the page's flowStartingPoints (first = default). `truncated` is true when maxNodes was reached.",
    {
      nodeId: z.string().optional().describe("Screen, node or page id. Default: current page"),
      includeEmpty: z.boolean().optional().describe("Also list nodes that have no reactions (verbose)"),
      maxNodes: z.number().int().min(1).max(100000).optional().describe("Max nodes to scan (default 5000)"),
    },
    { timeout: 120_000 }
  );

  relay(
    "trace_prototype_flow",
    "Trace a prototype flow (Figma Design only). Breadth-first search from a start screen (or a node inside one) following " +
      "NAVIGATE / OVERLAY / SWAP actions, including ones nested in conditionals and on instance sublayers. Returns screens " +
      "[{id, name, page, depth, reachedFrom}], edges [{from screen, sourceNode, trigger, action, navigation, destination, to screen, " +
      "transition, conditional/conditions, followed:false for SCROLL_TO/CHANGE_TO}] plus BACK/CLOSE/URL edges, `unresolved` " +
      "destinations (deleted nodes), and `pending` screens discovered but not visited because maxScreens was reached.",
    {
      nodeId: z.string().describe("Start screen (top-level frame) or any node inside it"),
      maxScreens: z.number().int().min(1).max(500).optional().describe("Max screens to visit (default 25)"),
      maxNodesPerScreen: z.number().int().min(1).max(100000).optional().describe("Max nodes scanned per screen (default 2000)"),
    },
    { timeout: 180_000 }
  );

  relay(
    "set_reaction",
    "Add, replace or clear a prototype interaction on a node (Figma Design only). mode 'replace' (default) swaps out existing " +
      "reactions with the same trigger; 'append' adds the action to the existing reaction with that trigger (multi-action) or " +
      "creates one; 'clear' removes reactions with `trigger` (or all reactions when trigger is omitted). Actions: NAVIGATE, OVERLAY, " +
      "SWAP, SCROLL_TO, CHANGE_TO (need destinationId; CHANGE_TO targets a sibling variant), BACK, CLOSE, URL (needs url). " +
      "Transition omitted = instant. Use `extraActions` for raw Plugin API Action objects (e.g. SET_VARIABLE, CONDITIONAL). " +
      "Returns the node's resulting reactions.",
    {
      nodeId: z.string().describe("Node that receives the interaction (hotspot)"),
      mode: z.enum(["replace", "append", "clear"]).optional(),
      trigger: z.enum(TRIGGERS).optional().describe("Default ON_CLICK"),
      timeoutMs: z.number().min(0).optional().describe("AFTER_TIMEOUT delay in ms (default 800)"),
      delayMs: z.number().min(0).optional().describe("MOUSE_ENTER/LEAVE/UP/DOWN delay in ms (default 0)"),
      keyCodes: z.array(z.number().int()).optional().describe("ON_KEY_DOWN key codes"),
      device: z.enum(["KEYBOARD", "XBOX_ONE", "PS4", "SWITCH_PRO", "UNKNOWN_CONTROLLER"]).optional().describe("ON_KEY_DOWN device (default KEYBOARD)"),
      action: z.enum(ACTIONS).optional().describe("Required unless mode is 'clear' or extraActions is given"),
      destinationId: z.string().optional().describe("Target node for NAVIGATE/OVERLAY/SWAP/SCROLL_TO/CHANGE_TO"),
      url: z.string().optional().describe("For URL action"),
      openInNewTab: z.boolean().optional().describe("For URL action"),
      transition,
      overlayRelativePosition: z.object({ x: z.number(), y: z.number() }).optional().describe("OVERLAY manual position"),
      resetScrollPosition: z.boolean().optional(),
      extraActions: z.array(z.record(z.any())).optional().describe("Raw Plugin API Action objects appended after `action`"),
    }
  );

  relay(
    "set_flow_starting_point",
    "Add, rename, reorder or remove a prototype flow starting point (Figma Design only). The node must be a top-level frame. " +
      "Adding an existing start just renames it. index 0 makes it the default flow. Returns the page's updated flowStartingPoints.",
    {
      nodeId: z.string().describe("Top-level frame id"),
      name: z.string().optional().describe("Flow name (default: frame name)"),
      pageId: z.string().optional().describe("Default: the node's page"),
      remove: z.boolean().optional().describe("Remove this flow starting point"),
      index: z.number().int().min(0).optional().describe("Move the flow to this position (0 = default flow)"),
    }
  );

  // --- FigJam only --------------------------------------------------------------------
  relay(
    "create_sticky",
    "Create a FigJam sticky note (FigJam only; errors in Figma Design). Font is loaded automatically. Placed at viewport center " +
      "when no parent/x/y is given.",
    {
      text: z.string(),
      color: z.string().optional().describe("Sticky fill hex (default: FigJam default sticky color)"),
      wide: z.boolean().optional().describe("Wide rectangular sticky instead of square"),
      authorVisible: z.boolean().optional().describe("Show the author name"),
      fontSize: z.number().optional(),
      name: z.string().optional(),
      parentId: z.string().optional().describe("Section or other container"),
      x: z.number().optional(),
      y: z.number().optional(),
    }
  );

  relay(
    "create_shape_with_text",
    "Create a FigJam shape with text, e.g. flowchart boxes (FigJam only). shapeType ENG_DATABASE = cylinder, ENG_QUEUE = " +
      "horizontal cylinder. Default ROUNDED_RECTANGLE 208x208.",
    {
      shapeType: z.enum(SHAPES).optional(),
      text: z.string().optional(),
      fill: z.string().optional().describe("Hex, or 'none'"),
      stroke: z.string().optional().describe("Hex, or 'none'"),
      strokeWeight: z.number().optional(),
      textColor: z.string().optional().describe("Hex"),
      fontSize: z.number().optional(),
      width: z.number().optional(),
      height: z.number().optional(),
      name: z.string().optional(),
      parentId: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
    }
  );

  relay(
    "create_connector",
    "Create a FigJam connector line (FigJam only). Each end is either attached to a node (startNodeId/endNodeId + magnet, " +
      "default AUTO) or a free canvas point (startX/startY, endX/endY). Optional label text.",
    {
      startNodeId: z.string().optional(),
      startX: z.number().optional(),
      startY: z.number().optional(),
      startMagnet: magnet,
      endNodeId: z.string().optional(),
      endX: z.number().optional(),
      endY: z.number().optional(),
      endMagnet: magnet,
      lineType: z.enum(["STRAIGHT", "ELBOWED", "CURVED"]).optional().describe("Figma default when omitted"),
      stroke: z.string().optional().describe("Hex"),
      strokeWeight: z.number().optional(),
      startCap: cap,
      endCap: cap,
      label: z.string().optional(),
      labelFontSize: z.number().optional(),
      name: z.string().optional(),
      parentId: z.string().optional(),
    }
  );

  relay(
    "create_table",
    "Create a FigJam table (FigJam only). rows/columns default to the size of `cells` (or 2x2). cells is a 2D array of strings " +
      "[row][column]; fonts are loaded automatically. Per-cell failures are reported in `errors`.",
    {
      rows: z.number().int().min(1).max(200).optional(),
      columns: z.number().int().min(1).max(50).optional(),
      cells: z.array(z.array(z.string())).optional(),
      fontSize: z.number().optional(),
      headerFill: z.string().optional().describe("Hex fill for the first row"),
      name: z.string().optional(),
      parentId: z.string().optional(),
      x: z.number().optional(),
      y: z.number().optional(),
    },
    { timeout: 60_000 }
  );
}
