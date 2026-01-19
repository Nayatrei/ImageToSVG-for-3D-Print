export const SLIDER_TOOLTIPS = {
    'path-simplification': 'Higher values remove more small details and noise.',
    'corner-sharpness': 'Higher values create crisper, more defined corners.',
    'curve-straightness': 'Higher values make curved lines more straight.',
    'color-precision': 'Higher values find more distinct color layers.',
    'max-colors': 'Caps the maximum number of colors created.',
    'obj-detail': 'Lower values reduce OBJ size by simplifying curved edges.'
};

export const TRANSPARENT_ALPHA_CUTOFF = 10;
export const OBJ_ZOOM_MIN = 0.5;
export const OBJ_ZOOM_MAX = 3;
export const OBJ_DEFAULT_ROTATION = { x: -0.5, y: 0.6 };

export const BED_PRESETS = {
    x1: { width: 256, depth: 256, label: 'Bambu X1/X1C' },
    a1mini: { width: 180, depth: 180, label: 'Bambu A1 mini' },
    h2d: { width: 325, depth: 320, label: 'Bambu H2D (single nozzle)' }
};
