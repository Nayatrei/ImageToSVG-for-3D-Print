import {
    getMagnetPresets,
    normalizeMagnetPocketConfig
} from './magnet-pockets.js?v=r-0482439758aef41c';

function setInputValue(input, value) {
    if (input) input.value = String(value);
}

function setHidden(element, hidden) {
    element?.classList.toggle('hidden', hidden);
}

function formatMm(value) {
    const numeric = Number.isFinite(value) ? value : Number.parseFloat(value);
    if (!Number.isFinite(numeric)) return '—';
    return Number(numeric.toFixed(2)).toString();
}

function populatePresetOptions(controls, config) {
    if (!controls.magnetPreset) return;
    const presets = getMagnetPresets(config.shape);
    controls.magnetPreset.replaceChildren();
    presets.forEach((preset) => {
        const option = document.createElement('option');
        option.value = preset.id;
        option.textContent = preset.label;
        controls.magnetPreset.appendChild(option);
    });
    const custom = document.createElement('option');
    custom.value = 'custom';
    custom.textContent = 'Custom dimensions';
    controls.magnetPreset.appendChild(custom);
    controls.magnetPreset.value = presets.some((preset) => preset.id === config.presetId)
        ? config.presetId
        : 'custom';
}

function syncControlVisibility(controls, config) {
    setHidden(controls.magnetBody, !config.enabled);
    setHidden(controls.magnetCustomFields, config.presetId !== 'custom');
    setHidden(controls.magnetDiameterField, config.shape !== 'disc');
    setHidden(controls.magnetLengthField, config.shape !== 'block');
    setHidden(controls.magnetWidthField, config.shape !== 'block');
    setHidden(controls.magnetFloorField, config.mode !== 'hidden');
    controls.magnetModeButtons?.forEach((button) => {
        const active = button.dataset.magnetMode === config.mode;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
    });
}

function syncControls(controls, rawConfig) {
    const config = normalizeMagnetPocketConfig(rawConfig);
    if (controls.magnetEnabled) controls.magnetEnabled.checked = config.enabled;
    setInputValue(controls.magnetShape, config.shape);
    populatePresetOptions(controls, config);
    setInputValue(controls.magnetDiameter, config.diameter);
    setInputValue(controls.magnetLength, config.length);
    setInputValue(controls.magnetWidth, config.width);
    setInputValue(controls.magnetHeight, config.height);
    setInputValue(controls.magnetCount, config.count);
    if (controls.magnetCountValue) controls.magnetCountValue.textContent = String(config.count);
    setInputValue(controls.magnetClearance, config.clearanceXY);
    if (controls.magnetClearanceValue) {
        controls.magnetClearanceValue.textContent = `${formatMm(config.clearanceXY)} mm`;
    }
    setInputValue(controls.magnetClearanceZ, config.clearanceZ);
    setInputValue(controls.magnetWall, config.minWall);
    setInputValue(controls.magnetFloor, config.floor);
    setInputValue(controls.magnetRoof, config.roof);
    syncControlVisibility(controls, config);
    if (controls.magnetPanel && !config.enabled) controls.magnetPanel.dataset.state = 'disabled';
    return config;
}

function readControls(controls, current) {
    return normalizeMagnetPocketConfig({
        ...current,
        enabled: controls.magnetEnabled?.checked === true,
        shape: controls.magnetShape?.value,
        presetId: controls.magnetPreset?.value,
        diameter: controls.magnetDiameter?.value,
        length: controls.magnetLength?.value,
        width: controls.magnetWidth?.value,
        height: controls.magnetHeight?.value,
        count: controls.magnetCount?.value,
        clearanceXY: controls.magnetClearance?.value,
        clearanceZ: controls.magnetClearanceZ?.value,
        minWall: controls.magnetWall?.value,
        floor: controls.magnetFloor?.value,
        roof: controls.magnetRoof?.value
    });
}

function enableSupportBaseForMagnets(state) {
    state.useBaseLayer = true;
    if (state.logo) state.logo.useBaseLayer = true;

    ['use-base-layer', 'logo-use-base-layer'].forEach((id) => {
        const checkbox = document.getElementById(id);
        if (checkbox) checkbox.checked = true;
    });
    ['base-layer-select', 'logo-base-layer-select'].forEach((id) => {
        const select = document.getElementById(id);
        if (select) select.disabled = false;
    });
}

function restoreSupportBaseState(state, snapshot) {
    if (!snapshot) return;
    state.useBaseLayer = snapshot.svg;
    if (state.logo) state.logo.useBaseLayer = snapshot.logo;

    const svgCheckbox = document.getElementById('use-base-layer');
    const logoCheckbox = document.getElementById('logo-use-base-layer');
    if (svgCheckbox) svgCheckbox.checked = snapshot.svg;
    if (logoCheckbox) logoCheckbox.checked = snapshot.logo;
    const svgSelect = document.getElementById('base-layer-select');
    const logoSelect = document.getElementById('logo-base-layer-select');
    if (svgSelect) svgSelect.disabled = !snapshot.svg;
    if (logoSelect) logoSelect.disabled = !snapshot.logo;
}

// The magnet panel is a deliberately global control: the same pocket spec is
// meant to follow the user between the 3D and Logo tabs. Each tab still gets
// its own copy so no other write path can alias the two objParams trees.
function storeSharedMagnetConfig(state, config) {
    state.objParams.magnetPocket = { ...config };
    if (state.logo?.objParams) state.logo.objParams.magnetPocket = { ...config };
}

/**
 * Repaints the shared magnet DOM from one tab's stored pocket config. Called
 * when a tab is activated so the shared controls always show the active tab's
 * values.
 */
export function syncMagnetPocketControls(controls, config) {
    if (!controls?.magnetPanel) return null;
    return syncControls(controls, config);
}

function releaseMagnetExportBlock(button) {
    if (button.dataset.magnetExportBlocked !== 'true') return;
    button.disabled = button.dataset.magnetExportWasDisabled === 'true';
    delete button.dataset.magnetExportBlocked;
    delete button.dataset.magnetExportWasDisabled;
}

export function updateMagnetPocketStatus(controls, result) {
    if (!controls?.magnetPanel || !controls.magnetStatusText) return;
    const enabled = controls.magnetEnabled?.checked === true;
    if (!enabled) {
        controls.magnetPanel.dataset.state = 'disabled';
        controls.magnetStatusText.textContent = 'Magnet pockets are off.';
        setHidden(controls.magnetPause, true);
        document.querySelectorAll('[data-magnet-export-blocked="true"]').forEach((button) => {
            releaseMagnetExportBlock(button);
        });
        return;
    }
    if (!result?.enabled) {
        controls.magnetPanel.dataset.state = 'pending';
        controls.magnetStatusText.textContent = 'Generate a model to place pockets.';
        setHidden(controls.magnetPause, true);
        return;
    }

    controls.magnetPanel.dataset.state = result.valid ? 'ready' : 'error';
    const baseMessage = result.valid
        ? `${result.placements.length} pocket${result.placements.length === 1 ? '' : 's'} placed. ${result.message}`
        : result.errors?.[0] || 'Magnet pocket placement is invalid.';
    const thicknessMessage = result.valid
        ? result.autoThickenedBy > 0
            ? ` Base auto-thickened by ${formatMm(result.autoThickenedBy)} mm (${formatMm(result.effectiveBaseThickness - result.autoThickenedBy)} → ${formatMm(result.effectiveBaseThickness)} mm required).`
            : ` Required base: ${formatMm(result.requiredBaseThickness)} mm; effective base: ${formatMm(result.effectiveBaseThickness)} mm.`
        : '';
    controls.magnetStatusText.textContent = `${baseMessage}${thicknessMessage}`;

    const showPause = result.valid && result.config?.mode === 'hidden' && Number.isFinite(result.pauseZ);
    if (controls.magnetPause) {
        controls.magnetPause.textContent = showPause
            ? `Bambu pause: before the first cover layer at Z ${formatMm(result.pauseZ)} mm.`
            : '';
        setHidden(controls.magnetPause, !showPause);
    }

    const logoActive = !document.getElementById('tab-logo')?.classList.contains('hidden');
    const selector = logoActive
        ? '#logo-export-obj-btn, #logo-export-3mf-btn, #logo-export-stl-btn, #logo-bambu-open-btn'
        : '#export-obj-btn, #export-3mf-btn, #export-stl-btn, #svg-bambu-open-btn';
    document.querySelectorAll(selector).forEach((button) => {
        if (!result.valid) {
            if (button.dataset.magnetExportBlocked !== 'true') {
                button.dataset.magnetExportWasDisabled = String(button.disabled);
            }
            button.disabled = true;
            button.dataset.magnetExportBlocked = 'true';
        } else if (button.dataset.magnetExportBlocked === 'true') {
            releaseMagnetExportBlock(button);
        }
    });
}

export function bindMagnetPocketControls({
    state,
    controls,
    onChange
}) {
    if (!state?.objParams || !controls?.magnetPanel) {
        return { sync() {}, updateStatus() {} };
    }

    let changeFrame = 0;
    let baseStateBeforeMagnets = null;
    const scheduleChange = () => {
        cancelAnimationFrame(changeFrame);
        changeFrame = requestAnimationFrame(() => {
            changeFrame = 0;
            onChange?.();
        });
    };
    const commit = ({ rebuildPresets = false } = {}) => {
        const previous = state.objParams.magnetPocket;
        let next = readControls(controls, previous);
        if (rebuildPresets) {
            next = normalizeMagnetPocketConfig({
                ...next,
                presetId: next.shape === 'block' ? 'block-20x5x2' : 'disc-10x3'
            });
        }
        if (next.enabled && !previous?.enabled) {
            baseStateBeforeMagnets = {
                svg: state.useBaseLayer === true,
                logo: state.logo?.useBaseLayer === true
            };
        }
        if (next.enabled) {
            enableSupportBaseForMagnets(state);
        } else if (previous?.enabled) {
            restoreSupportBaseState(state, baseStateBeforeMagnets);
            baseStateBeforeMagnets = null;
        }
        storeSharedMagnetConfig(state, next);
        syncControls(controls, next);
        updateMagnetPocketStatus(controls, null);
        scheduleChange();
    };

    controls.magnetEnabled?.addEventListener('change', () => commit());
    controls.magnetShape?.addEventListener('change', () => commit({ rebuildPresets: true }));
    controls.magnetPreset?.addEventListener('change', () => commit());
    controls.magnetCount?.addEventListener('input', () => commit());
    controls.magnetClearance?.addEventListener('input', () => commit());
    [
        controls.magnetDiameter,
        controls.magnetLength,
        controls.magnetWidth,
        controls.magnetHeight,
        controls.magnetClearanceZ,
        controls.magnetWall,
        controls.magnetFloor,
        controls.magnetRoof
    ].filter(Boolean).forEach((input) => input.addEventListener('input', () => commit()));

    controls.magnetModeButtons?.forEach((button) => {
        button.addEventListener('click', () => {
            const next = normalizeMagnetPocketConfig({
                ...state.objParams.magnetPocket,
                mode: button.dataset.magnetMode
            });
            storeSharedMagnetConfig(state, next);
            syncControls(controls, next);
            updateMagnetPocketStatus(controls, null);
            scheduleChange();
        });
    });

    storeSharedMagnetConfig(state, syncControls(controls, state.objParams.magnetPocket));
    if (state.objParams.magnetPocket.enabled) {
        baseStateBeforeMagnets = {
            svg: state.useBaseLayer === true,
            logo: state.logo?.useBaseLayer === true
        };
        enableSupportBaseForMagnets(state);
    }
    updateMagnetPocketStatus(controls, null);

    return {
        sync() {
            storeSharedMagnetConfig(state, syncControls(controls, state.objParams.magnetPocket));
        },
        updateStatus(result) {
            updateMagnetPocketStatus(controls, result);
        }
    };
}
