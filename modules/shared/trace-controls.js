export const TRACE_PRESETS = {
    logo: {
        label: 'Logo',
        values: {
            outputColors: 4,
            colorCleanup: 30,
            pathCleanup: 35,
            cornerSharpness: 75,
            curveStraightness: 40,
            preserveRightAngles: true
        }
    },
    detailed: {
        label: 'Detailed',
        values: {
            outputColors: 6,
            colorCleanup: 10,
            pathCleanup: 15,
            cornerSharpness: 55,
            curveStraightness: 20,
            preserveRightAngles: false
        }
    }
};

export const TRACE_PRESET_ORDER = ['logo', 'detailed'];

export const TRACE_CONTROL_TOOLTIPS = {
    'trace-preset': 'Loads recommended starting values without changing what each control means.',
    'output-colors': 'Sets the exact maximum number of color layers the trace may keep.',
    'color-cleanup': 'Removes tiny color regions without changing the selected color-layer cap.',
    'path-cleanup': 'Removes tiny traced shapes before curves are fitted.',
    'corner-sharpness': 'Higher values preserve sharper corners by lowering curve tolerance.',
    'curve-straightness': 'Higher values allow straighter segments instead of smooth curves.',
    'preserve-right-angles': 'Keeps detected 90° corners crisp instead of rounding them.'
};

export function createDefaultTraceControls(preset = 'logo') {
    const presetKey = TRACE_PRESETS[preset] ? preset : 'logo';
    return {
        preset: presetKey,
        ...TRACE_PRESETS[presetKey].values
    };
}

export function normalizeTraceControls(controls = {}) {
    const fallback = createDefaultTraceControls(controls.preset);
    return {
        preset: TRACE_PRESETS[controls.preset] ? controls.preset : fallback.preset,
        outputColors: clampInt(controls.outputColors, 2, 8, fallback.outputColors),
        colorCleanup: clampInt(controls.colorCleanup, 0, 100, fallback.colorCleanup),
        pathCleanup: clampInt(controls.pathCleanup, 0, 100, fallback.pathCleanup),
        cornerSharpness: clampInt(controls.cornerSharpness, 0, 100, fallback.cornerSharpness),
        curveStraightness: clampInt(controls.curveStraightness, 0, 100, fallback.curveStraightness),
        preserveRightAngles: Boolean(
            typeof controls.preserveRightAngles === 'boolean'
                ? controls.preserveRightAngles
                : fallback.preserveRightAngles
        )
    };
}

export function readTraceControls(elements) {
    return normalizeTraceControls({
        preset: elements.presetBtn?.dataset.preset || 'logo',
        outputColors: elements.outputColorsSlider?.value,
        colorCleanup: elements.colorCleanupSlider?.value,
        pathCleanup: elements.pathCleanupSlider?.value,
        cornerSharpness: elements.cornerSharpnessSlider?.value,
        curveStraightness: elements.curveStraightnessSlider?.value,
        preserveRightAngles: elements.preserveRightAnglesCheckbox?.checked
    });
}

export function writeTraceControls(elements, controls) {
    const normalized = normalizeTraceControls(controls);

    if (elements.outputColorsSlider) elements.outputColorsSlider.value = String(normalized.outputColors);
    if (elements.colorCleanupSlider) elements.colorCleanupSlider.value = String(normalized.colorCleanup);
    if (elements.pathCleanupSlider) elements.pathCleanupSlider.value = String(normalized.pathCleanup);
    if (elements.cornerSharpnessSlider) elements.cornerSharpnessSlider.value = String(normalized.cornerSharpness);
    if (elements.curveStraightnessSlider) elements.curveStraightnessSlider.value = String(normalized.curveStraightness);
    if (elements.preserveRightAnglesCheckbox) elements.preserveRightAnglesCheckbox.checked = normalized.preserveRightAngles;

    updatePresetButton(elements.presetBtn, normalized.preset);
}

export function applyTracePreset(elements, preset) {
    writeTraceControls(elements, createDefaultTraceControls(preset));
}

export function cycleTracePreset(elements) {
    const current = elements.presetBtn?.dataset.preset || 'logo';
    const next = getNextTracePreset(current);
    applyTracePreset(elements, next);
    return next;
}

export function getNextTracePreset(currentPreset = 'logo') {
    const currentIndex = TRACE_PRESET_ORDER.indexOf(currentPreset);
    const nextIndex = currentIndex >= 0
        ? (currentIndex + 1) % TRACE_PRESET_ORDER.length
        : 0;
    return TRACE_PRESET_ORDER[nextIndex];
}

export function buildTraceOptions(controls, { htmlDeclaredColorCount = null } = {}) {
    const normalized = normalizeTraceControls(controls);
    const usesDeclaredHtmlColors = Number.isInteger(htmlDeclaredColorCount) && htmlDeclaredColorCount > 0;

    return {
        viewbox: true,
        strokewidth: 0,
        roundcoords: 1,
        colorsampling: 2,
        blurradius: 0.1,
        colorquantcycles: 12,
        numberofcolors: usesDeclaredHtmlColors
            ? Math.max(2, htmlDeclaredColorCount)
            : normalized.outputColors,
        mincolorratio: usesDeclaredHtmlColors
            ? 0
            : +(normalized.colorCleanup / 4000).toFixed(3),
        pathomit: Math.round(normalized.pathCleanup / 10),
        qtres: +(0.8 - (0.75 * normalized.cornerSharpness / 100)).toFixed(2),
        ltres: +(0.05 + (0.95 * normalized.curveStraightness / 100)).toFixed(2),
        rightangleenhance: normalized.preserveRightAngles
    };
}

export function estimateMeaningfulColorCount(imageData) {
    const width = imageData?.width || 0;
    const height = imageData?.height || 0;
    if (!width || !height) return null;

    const data = imageData.data;
    const maxSamples = 4096;
    const step = Math.max(1, Math.floor(Math.sqrt((width * height) / maxSamples)));
    const counts = new Map();
    let samples = 0;

    for (let y = 0; y < height; y += step) {
        for (let x = 0; x < width; x += step) {
            const idx = (y * width + x) * 4;
            if (data[idx + 3] <= 10) continue;
            const r = data[idx] >> 3;
            const g = data[idx + 1] >> 3;
            const b = data[idx + 2] >> 3;
            const key = (r << 10) | (g << 5) | b;
            counts.set(key, (counts.get(key) || 0) + 1);
            samples++;
        }
    }

    if (!samples) return null;

    const bucketsAll = Array.from(counts.values()).sort((a, b) => b - a);
    const minBucketCount = Math.max(2, Math.round(samples * 0.004));
    const buckets = bucketsAll.filter((count) => count >= minBucketCount);
    const selectedBuckets = buckets.length ? buckets : bucketsAll;
    const total = selectedBuckets.reduce((sum, count) => sum + count, 0);

    let cumulative = 0;
    let colorCount = 0;

    for (const count of selectedBuckets) {
        cumulative += count;
        colorCount++;
        if (cumulative / total >= 0.99) break;
    }

    return Math.max(1, Math.min(colorCount, selectedBuckets.length));
}

export function getColorCountNoticeMessage(estimatedCount, currentOutputColors) {
    if (!Number.isInteger(estimatedCount) || estimatedCount < 1) return '';
    if (!Number.isInteger(currentOutputColors) || currentOutputColors < 1) return '';
    return `Source looks like ~${estimatedCount} meaningful colors. Current output is set to keep ${currentOutputColors}.`;
}

export function getDeclaredColorSummary(declaredCount) {
    if (Number.isInteger(declaredCount) && declaredCount > 0) {
        return `Using ${declaredCount} declared HTML/CSS color${declaredCount === 1 ? '' : 's'}.`;
    }
    return 'Using rendered HTML colors. No declared CSS colors were detected.';
}

export function updateTraceControlUi(elements, controls, { htmlModeActive = false, htmlDeclaredColorCount = 0 } = {}) {
    const normalized = normalizeTraceControls(controls);
    const options = buildTraceOptions(normalized, {
        htmlDeclaredColorCount: htmlModeActive ? htmlDeclaredColorCount : null
    });

    if (elements.outputColorsValue) elements.outputColorsValue.textContent = String(normalized.outputColors);
    if (elements.colorCleanupValue) elements.colorCleanupValue.textContent = String(normalized.colorCleanup);
    if (elements.pathCleanupValue) elements.pathCleanupValue.textContent = String(normalized.pathCleanup);
    if (elements.cornerSharpnessValue) elements.cornerSharpnessValue.textContent = String(normalized.cornerSharpness);
    if (elements.curveStraightnessValue) elements.curveStraightnessValue.textContent = String(normalized.curveStraightness);

    setText(elements.outputColorsHelper, `Keeps up to ${normalized.outputColors} color layer${normalized.outputColors === 1 ? '' : 's'}.`);
    setText(
        elements.colorCleanupHelper,
        options.mincolorratio <= 0
            ? 'Keeps even tiny color regions.'
            : `Suppresses colors smaller than about ${(options.mincolorratio * 100).toFixed(1)}% of sampled pixels.`
    );
    setText(
        elements.pathCleanupHelper,
        options.pathomit <= 0
            ? 'Keeps even the smallest traced shapes.'
            : `Removes shapes smaller than ${options.pathomit} traced point${options.pathomit === 1 ? '' : 's'}.`
    );
    setText(elements.cornerSharpnessHelper, `Higher keeps sharper corners. Current corner tolerance: ${options.qtres}.`);
    setText(elements.curveStraightnessHelper, `Straightens curves more aggressively. Current line tolerance: ${options.ltres}.`);
    setText(
        elements.preserveRightAnglesHelper,
        normalized.preserveRightAngles
            ? '90° corners are preserved when detected.'
            : 'Right-angle snapping is off.'
    );

    updatePresetButton(elements.presetBtn, normalized.preset);

    if (elements.htmlColorSummary) {
        elements.htmlColorSummary.textContent = getDeclaredColorSummary(htmlDeclaredColorCount);
    }
}

function updatePresetButton(button, preset) {
    if (!button) return;
    const presetKey = TRACE_PRESETS[preset] ? preset : 'logo';
    button.dataset.preset = presetKey;
    button.textContent = `Preset: ${TRACE_PRESETS[presetKey].label}`;
    button.classList.toggle('btn-primary', presetKey === 'detailed');
    button.classList.toggle('btn-secondary', presetKey !== 'detailed');
}

function setText(element, value) {
    if (element) element.textContent = value;
}

function clampInt(value, min, max, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}
