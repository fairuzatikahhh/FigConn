# FigConn

> **FigConn** — let Claude Code drive Figma Desktop directly. It's a local plugin bridge with no REST API, no tokens and no quota.

Bridge lokal Claude Code ↔ Figma tanpa REST API, jadi tanpa kuota.
Mendukung variables, styles, dan components.

```
Claude Code ──stdio──► server/index.js (MCP) ──ws://localhost:3911-3920──► plugin/ (Figma Desktop)
```

## Setup

1. `npm install`
2. Daftarkan MCP-nya di Claude Code (ganti path sesuai lokasi repo):
   ```
   claude mcp add figconn -s user -- node /path/to/figconn/server/index.js
   ```
3. Di **Figma Desktop**: Plugins → Development → **Import plugin from manifest…** → pilih `plugin/manifest.json`.
4. Buka file Figma → Plugins → Development → **FigConn**. Biarkan jendela plugin tetap terbuka sampai statusnya **Connected**.

## Tools

| Kategori | Tools |
|---|---|
| Koneksi | `status` |
| Umum | `execute` (kode Plugin API bebas) |
| Baca | `get_document`, `get_selection`, `get_node`, `get_screenshot`, `set_selection` |
| Buat/edit | `create_frame`, `create_text`, `set_properties`, `delete_nodes` |
| Variables | `get_variables`, `create_variable_collection`, `create_variables`, `bind_variable`, `set_variable_mode`, `list_library_variables`, `import_library_variable` |
| Styles | `get_styles`, `create_paint_style`, `create_text_style`, `create_effect_style`, `apply_style` |
| Components | `get_components`, `create_component`, `combine_as_variants`, `add_component_property`, `create_instance`, `set_instance_properties` |

## Catatan

- Beberapa sesi Claude Code bisa jalan bersamaan. Tiap server mengambil port bebas pertama di rentang 3911–3920, dan plugin terhubung ke semua port itu.
- Beberapa file bisa terhubung sekaligus. Pakai parameter `file` (nama atau id) untuk memilih file; defaultnya file yang terakhir aktif.
- Keamanan: server hanya mendengarkan di loopback dan menolak koneksi dari halaman web (header Origin selain `null`).
- Batas paket Figma tetap berlaku. Contohnya, paket Starter hanya mengizinkan 1 mode per variable collection.
- Setelah mengubah `server/index.js`, restart Claude Code. Setelah mengubah file di `plugin/`, cukup jalankan ulang plugin-nya.
