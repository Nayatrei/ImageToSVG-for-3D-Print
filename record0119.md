# Session Report - January 19, 2026

## Summary
This session focused on implementing a base layer feature for 3D printing and overhauling the 3D export functionality to improve Bambu Lab compatibility.

---

## Features Implemented

### 1. Base Layer Option for 3D Printing
Added ability to designate one layer as the "base" that other layers sit on top of.

**Use Case:** For images with a full background color (e.g., yellow background with text), the background becomes the foundation (0-4mm) and text/graphics extrude on top of it.

**Files Modified:**
- `converter.html` - Added checkbox and select UI elements
- `converter.js` - Added state properties and event listeners
- `modules/preview3d.js` - Updated render logic for base layer positioning

**How it works:**
- Check "Use base layer" checkbox to enable
- Select which layer should be the base (L0, L1, etc.)
- Base layer sits at z=0 with its configured thickness
- Other layers start at z=baseThickness and extend upward

---

### 2. Replaced GLB Export with 3MF Export
GLB export was producing 15-byte empty files. Replaced with 3MF format which is:
- Native to Bambu Studio
- Embeds colors directly in the file
- Better for multi-color 3D printing

**3MF Structure:**
- ZIP archive containing XML files
- `[Content_Types].xml` - MIME types
- `_rels/.rels` - Relationships
- `3D/3dmodel.model` - Mesh data with materials

---

### 3. Added Multi-STL Export
Exports separate STL files for each color layer.

**Naming Convention:** `{imagename}_{thickness}mm_L{index}_{hexcolor}.stl`

**Example Output:**
- `logo_4mm_L0_FFCC00.stl` (yellow layer)
- `logo_4mm_L1_000000.stl` (black layer)

**Use Case:** Import individual STL files into slicer and assign different filaments manually.

---

### 4. Geometry Optimization

**Merged Geometries by Color:**
- Previously: Each SVG path became a separate mesh (many small objects)
- Now: All shapes of the same color are merged into a single mesh
- Result: Cleaner, more optimized exports

**Fixed Normal Computation:**
- Added `computeVertexNormals()` after rotation transform
- Added `computeVertexNormals()` after geometry merging
- STL export now uses stored normals when available
- Eliminates "wire" artifacts and flipped bottom faces

---

## Files Changed

### `converter.html`
- Added base layer checkbox and select elements (lines 1603-1608)
- Changed export buttons from 5 to 6 columns
- Replaced GLB button with 3MF button
- Added STL export button
- Updated button descriptions

### `converter.js`
- Added element references: `useBaseLayerCheckbox`, `baseLayerSelect`, `export3mfBtn`, `exportStlBtn`
- Added state properties: `useBaseLayer`, `baseLayerIndex`
- Added event listeners for base layer UI
- Updated `disableDownloadButtons()` and `enableDownloadButtons()` for new buttons

### `modules/preview3d.js`
- Updated `updateLayerStackPreview()`:
  - Populates base layer select options dynamically
  - Shows "(Base)" badge on selected base layer
  - Displays correct z-position ranges
- Updated `render()`:
  - Calculates z-position based on base layer mode
  - Base layer at z=0, others at z=baseThickness

### `modules/export3d.js`
- Complete rewrite of export functionality
- Added `buildLayerGeometries()` helper function
- Added `geometryToSTL()` for binary STL generation
- Added `generate3MF()` for 3MF file creation
- Added `createZipFile()` for ZIP archive creation (with JSZip fallback)
- Added `crc32()` for ZIP file checksums
- Replaced `exportAsGLB()` with `exportAs3MF()`
- Added `exportAsSTL()` for multi-file STL export
- Updated `exportAsOBJ()` to use merged geometries

---

## Export Button Layout

| Button | Description |
|--------|-------------|
| Export Layers | Separate SVG files (original or merged) |
| Silhouette | Outline only |
| Combined | Single SVG file (original or merged) |
| OBJ + MTL | 3D model with materials |
| 3MF | Bambu Studio native format |
| STL | Per-layer files for manual filament assignment |

---

## Bambu Lab Workflow Recommendations

### For AMS Multi-Color Printing:

**Option 1: 3MF (Recommended)**
1. Export as 3MF
2. Open directly in Bambu Studio
3. Colors should be automatically assigned

**Option 2: Multi-STL**
1. Export as STL (creates multiple files)
2. Import all STL files into Bambu Studio
3. Manually assign filaments to each object

---

## Known Issues Addressed

| Issue | Solution |
|-------|----------|
| GLB producing 15-byte empty files | Replaced with 3MF export |
| OBJ colors not showing in slicer | 3MF embeds colors directly |
| Wire artifacts on bottom layer | Fixed normal computation after transforms |
| Flipped geometry | Added `computeVertexNormals()` after rotation |
| Many small meshes | Merged geometries by color |

---

## Technical Notes

### 3MF Format
- Uses Microsoft 3D Manufacturing namespace
- Materials defined in `<m:basematerials>` element
- Each object references materials via `pid` and `p1` attributes
- Colors stored as hex values with `displaycolor` attribute

### STL Binary Format
- 80-byte header
- 4-byte triangle count (uint32, little-endian)
- 50 bytes per triangle:
  - 12 bytes: normal vector (3x float32)
  - 36 bytes: 3 vertices (9x float32)
  - 2 bytes: attribute byte count (unused)

### Geometry Pipeline
1. Parse SVG paths from ImageTracer output
2. Create ExtrudeGeometry for each shape
3. Apply rotation (rotateX(PI) to flip for print orientation)
4. Apply z-offset based on base layer mode
5. Compute vertex normals
6. Merge all geometries of same color
7. Recompute normals after merge
8. Apply bed scaling if needed
9. Export to chosen format
