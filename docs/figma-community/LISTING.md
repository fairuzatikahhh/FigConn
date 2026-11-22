# Figma Community listing: FigConn

Copy these into Figma's publish form (Plugins → Development → Manage plugins in development → FigConn → Publish).

## Assets

| Field | File |
|---|---|
| Icon (128×128) | `docs/figma-community/icon.png` |
| Cover / thumbnail (1920×1080) | `docs/figma-community/cover.png` |

## Name

FigConn

## Tagline (max 100 characters)

Let Claude Code and other AI agents build and edit your Figma files locally. No API quota.

## Description

FigConn connects Figma Desktop to Claude Code (or any MCP client) running on your own computer. Your AI agent can read the live document and create or edit almost anything the Plugin API allows: frames, auto layout, text, shapes, SVG and images, variables and modes, styles, components and variants, prototype interactions, and FigJam stickies and connectors.

**Why FigConn**
• No REST API, no access tokens, no rate limits: everything runs through this plugin on your machine
• Full write access, not just read-only inspection
• Built for design systems: create variable collections with Light/Dark modes, bind tokens to fills, padding and radius, make components with variants
• Works with several files and several agent sessions at once

**How to use**
1. Set up the FigConn MCP server in Claude Code: `/plugin marketplace add fairuzatikahhh/FigConn` then `/plugin install figconn@figconn` (other clients: see GitHub)
2. Open your Figma file and run FigConn. Keep the small window open until it says Connected
3. Ask your agent, e.g. "Build a Button component with Primary, Secondary and Ghost variants bound to my color variables"

**Privacy**
The plugin only talks to a server on your own computer (localhost ports 3911–3920). It never sends your designs to any remote server. What your AI agent does with the data is up to the agent you connect.

Open source (MIT): https://github.com/fairuzatikahhh/FigConn

## Category

Design tools (or: Development)

## Tags

AI, MCP, Claude, design systems, variables, tokens, components, automation

## Support contact

https://github.com/fairuzatikahhh/FigConn/issues
