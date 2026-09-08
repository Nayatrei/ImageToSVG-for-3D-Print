import {
    DEFAULT_AMS_PRINT_STYLE,
    getAmsPrintStylePreset,
    normalizeAmsPrintStyle
} from '../config.js?v=r-afbde72383fa3b50';
import { waitForBrowserPaint } from './bambu-send-progress.js?v=r-afbde72383fa3b50';

const STYLE_HELPERS = Object.freeze({
    'raised-efficient': '2.4mm base with a 0.6mm color surface. Keeps the raised look while limiting AMS swaps.',
    'face-down': 'Prints the colored face against the plate for a flush finish and uses less model material. The base color joins those face layers, so thin raised color usually creates less AMS purge.',
    'full-depth': 'Uses 4mm color bodies so the sidewalls stay colored. This requires the most AMS swaps.'
});

const FACE_DOWN_STYLE = 'face-down';
const activeStyleRenderLocks = new WeakSet();

function getFaceDownReturnStyle(value) {
    const normalized = normalizeAmsPrintStyle(value);
    return normalized === FACE_DOWN_STYLE ? DEFAULT_AMS_PRINT_STYLE : normalized;
}

function syncFaceDownToggle(controls, styleId) {
    const button = controls?.objFaceDownToggle;
    if (!button) return;

    const isFaceDown = styleId === FACE_DOWN_STYLE;
    const stateLabel = button.querySelector('[data-face-down-state]');
    button.classList.toggle('is-active', isFaceDown);
    button.classList.remove('is-blocked');
    button.classList.remove('is-error');
    button.setAttribute('aria-pressed', String(isFaceDown));
    button.setAttribute(
        'aria-label',
        isFaceDown
            ? 'Face on Bed is on. Return to the previous raised print style'
            : 'Place the colored face flat on the build plate'
    );
    button.title = isFaceDown
        ? 'Colored regions share the first layer at Z=0; click to restore the previous raised style.'
        : 'Build every color flush against the plate, with the base continuing as backing.';
    if (stateLabel) stateLabel.textContent = isFaceDown ? 'Active' : 'Off';
}

/**
 * Lets the style control paint a concrete in-progress state before the
 * synchronous mask/mesh rebuild begins. The preview canvas exposes the same
 * lifecycle so callers and browser tests can wait for finished geometry.
 */
export async function renderAmsPrintStyleChange({
    rootState,
    tabState,
    controls,
    apply,
    render
}) {
    if (typeof render !== 'function') return;

    const button = controls?.objFaceDownToggle;
    const select = controls?.objAmsPrintStyle;
    const canvas = controls?.objPreviewCanvas;
    const orientationNote = controls?.printOrientationNote;
    const stateLabel = button?.querySelector('[data-face-down-state]');
    const priorOrientationNote = orientationNote?.textContent || '';
    // The lock guards one tab's style render, not the whole app. Preferring the
    // root state made the SVG and Logo tabs share a lock, so a style change on
    // one tab could be swallowed while the other was mid-render.
    const lockTarget = tabState && typeof tabState === 'object'
        ? tabState
        : rootState && typeof rootState === 'object'
            ? rootState
            : null;

    if ((lockTarget && activeStyleRenderLocks.has(lockTarget)) || button?.getAttribute('aria-busy') === 'true') {
        syncAmsPrintStyleControls({ rootState, tabState, controls });
        return false;
    }

    if (lockTarget) activeStyleRenderLocks.add(lockTarget);

    let renderSucceeded = false;
    let priorAriaLabel = button?.getAttribute('aria-label') || '';
    let busyAriaLabel = '';

    try {
        if (typeof apply === 'function') apply();
        const isFaceDown = normalizeAmsPrintStyle(select?.value) === FACE_DOWN_STYLE;
        priorAriaLabel = button?.getAttribute('aria-label') || priorAriaLabel;
        busyAriaLabel = isFaceDown
            ? 'Building the Face on Bed preview'
            : 'Building the raised-face preview';

        if (button) {
            button.classList.remove('is-error');
            button.classList.add('is-building');
            button.setAttribute('aria-busy', 'true');
            button.setAttribute('aria-disabled', 'true');
            button.setAttribute('aria-label', busyAriaLabel);
        }
        if (select) {
            select.classList.add('is-building');
            select.setAttribute('aria-disabled', 'true');
        }
        if (stateLabel) stateLabel.textContent = 'Building';
        if (canvas) canvas.dataset.renderState = 'building';
        if (orientationNote) {
            orientationNote.textContent = isFaceDown
                ? 'Preparing bed orientation...'
                : 'Preparing raised orientation...';
        }

        await waitForBrowserPaint();

        renderSucceeded = render() !== false;
    } catch (error) {
        console.error('AMS print style preview failed:', error);
    } finally {
        if (button) {
            button.classList.remove('is-building');
            button.setAttribute('aria-busy', 'false');
            button.setAttribute('aria-disabled', 'false');
        }
        if (select) {
            select.classList.remove('is-building');
            select.removeAttribute('aria-disabled');
        }
        if (canvas) canvas.dataset.renderState = renderSucceeded ? 'ready' : 'error';
        if (!renderSucceeded) {
            button?.classList.add('is-error');
            button?.setAttribute('aria-label', 'The 3D style preview failed. Re-analyze the image and try again.');
            if (stateLabel) stateLabel.textContent = 'Error';
        } else if (stateLabel?.textContent === 'Building') {
            stateLabel.textContent = button?.classList.contains('is-blocked')
                ? 'Blocked'
                : button?.getAttribute('aria-pressed') === 'true'
                    ? 'Active'
                    : 'Off';
        }
        if (renderSucceeded && button?.getAttribute('aria-label') === busyAriaLabel) {
            button.setAttribute('aria-label', priorAriaLabel);
        }
        if (orientationNote?.textContent?.startsWith('Preparing ')) {
            orientationNote.textContent = priorOrientationNote;
        }
        if (lockTarget) activeStyleRenderLocks.delete(lockTarget);
    }

    return renderSucceeded;
}

function setObjParams(target, styleId, preset) {
    if (!target?.objParams) return;
    const currentStyle = normalizeAmsPrintStyle(target.objParams.amsPrintStyle);
    if (styleId === FACE_DOWN_STYLE && currentStyle !== FACE_DOWN_STYLE) {
        target.objParams.faceDownReturnStyle = getFaceDownReturnStyle(currentStyle);
    } else if (styleId !== FACE_DOWN_STYLE) {
        target.objParams.faceDownReturnStyle = styleId;
    }
    target.objParams.amsPrintStyle = styleId;
    target.objParams.baseThickness = preset.baseThickness;
    target.objParams.thickness = preset.colorThickness;
}

export function getAmsPrintStyleHelper(styleId) {
    return STYLE_HELPERS[normalizeAmsPrintStyle(styleId)] || STYLE_HELPERS[DEFAULT_AMS_PRINT_STYLE];
}

export function syncAmsPrintStyleControls({ rootState, tabState, controls }) {
    const sourceParams = tabState?.objParams || rootState?.objParams || {};
    const styleId = normalizeAmsPrintStyle(sourceParams.amsPrintStyle);
    const preset = getAmsPrintStylePreset(styleId);

    if (controls?.objAmsPrintStyle) {
        controls.objAmsPrintStyle.value = styleId;
        controls.objAmsPrintStyle.dataset.amsPrintStyle = styleId;
    }
    if (controls?.objAmsPrintStyleHelper) {
        controls.objAmsPrintStyleHelper.textContent = getAmsPrintStyleHelper(styleId);
    }
    if (controls?.objBaseThicknessSlider) {
        controls.objBaseThicknessSlider.value = String(sourceParams.baseThickness ?? preset.baseThickness);
    }
    if (controls?.objBaseThicknessValue) {
        controls.objBaseThicknessValue.textContent = String(sourceParams.baseThickness ?? preset.baseThickness);
    }
    if (controls?.objThicknessSlider) {
        controls.objThicknessSlider.value = String(sourceParams.thickness ?? preset.colorThickness);
    }
    if (controls?.objThicknessValue) {
        controls.objThicknessValue.textContent = String(sourceParams.thickness ?? preset.colorThickness);
    }
    syncFaceDownToggle(controls, styleId);
    return { styleId, preset };
}

export function applyAmsPrintStylePreset({ rootState, tabState, controls, styleId }) {
    const normalizedStyleId = normalizeAmsPrintStyle(styleId);
    const preset = getAmsPrintStylePreset(normalizedStyleId);
    // A print style belongs to the tab whose control was used. Writing it into
    // every tab's state (and every tab's base-layer checkbox) meant picking a
    // style on one tab silently re-thicknessed the other tab's model.
    const target = tabState || rootState;

    setObjParams(target, normalizedStyleId, preset);

    if (target) {
        target.layerThicknessById = {};
        target.useBaseLayer = true;
        target.autoBaseLayerSelectionPending = true;
    }

    if (controls?.useBaseLayerCheckbox) controls.useBaseLayerCheckbox.checked = true;
    if (controls?.baseLayerSelect) controls.baseLayerSelect.disabled = false;

    syncAmsPrintStyleControls({ rootState, tabState, controls });
    return { styleId: normalizedStyleId, preset };
}

export function toggleFaceDownPrintStyle({ rootState, tabState, controls }) {
    const sourceParams = tabState?.objParams || rootState?.objParams || {};
    const currentStyle = normalizeAmsPrintStyle(sourceParams.amsPrintStyle);
    const nextStyle = currentStyle === FACE_DOWN_STYLE
        ? getFaceDownReturnStyle(sourceParams.faceDownReturnStyle)
        : FACE_DOWN_STYLE;

    return applyAmsPrintStylePreset({
        rootState,
        tabState,
        controls,
        styleId: nextStyle
    });
}
