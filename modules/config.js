export const SLIDER_TOOLTIPS = {
    'trace-preset': 'Loads recommended starting values without changing what each control means.',
    'output-colors': 'Sets the exact maximum number of color layers the trace may keep.',
    'color-cleanup': 'Removes tiny color regions without changing the selected color-layer cap.',
    'path-cleanup': 'Removes tiny traced shapes before curves are fitted.',
    'corner-sharpness': 'Higher values preserve sharper corners by lowering curve tolerance.',
    'curve-straightness': 'Higher values allow straighter segments instead of smooth curves.',
    'preserve-right-angles': 'Keeps detected 90° corners crisp instead of rounding them.',
    'obj-decimate': 'Higher values reduce triangle/detail density for smaller, faster 3D exports. This does not weld separate shapes.',
    'obj-bezel': 'Adds a raised rim inside the support footprint so outer edges stay protected during printing.'
};

export const TRANSPARENT_ALPHA_CUTOFF = 10;
export const OBJ_ZOOM_MIN = 0.5;
export const OBJ_ZOOM_MAX = 3;
export const OBJ_DEFAULT_ROTATION = { x: -0.65, y: 0.45 };

export const BED_PRESETS = {
    x1: { width: 256, depth: 256, height: 256, label: 'Bambu X1/X1C' },
    a1: { width: 256, depth: 256, height: 256, label: 'Bambu A1' },
    a1mini: { width: 180, depth: 180, height: 180, label: 'Bambu A1 mini' },
    h2d: { width: 325, depth: 320, height: 325, label: 'Bambu H2D (single nozzle)' }
};
