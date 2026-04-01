/**
 * Creates zoom and pan controls for a preview area.
 *
 * @param {object} st - the state object that owns a `.zoom` map (e.g. state or ls)
 * @param {string} idPrefix - prefix applied to button IDs ('', or 'logo-')
 *
 * The expected DOM structure per preview type:
 *   Buttons:  #{idPrefix}zoom-in-{type}, #{idPrefix}zoom-out-{type}, #{idPrefix}zoom-reset-{type}
 *   Container: [data-preview="{idPrefix}{type}"] > .preview-content
 *
 * @returns {{ setupZoomControls, zoomPreview, resetZoom }}
 */
export function createZoomPanController({ st, idPrefix = '' }) {

    function getZoom(type) {
        return st.zoom?.[type];
    }

    function zoomPreview(type, factor) {
        const zs = getZoom(type);
        if (!zs) return;
        zs.scale = Math.max(0.1, Math.min(5, zs.scale * factor));
        updatePreviewTransform(type);
        updateZoomDisplay(type);
    }

    function resetZoom(type) {
        const zs = getZoom(type);
        if (!zs) return;
        zs.scale = 1;
        zs.x = 0;
        zs.y = 0;
        updatePreviewTransform(type);
        updateZoomDisplay(type);
    }

    function updatePreviewTransform(type) {
        const container = document.querySelector(`[data-preview="${idPrefix}${type}"]`);
        if (!container) return;
        const content = container.querySelector('.preview-content');
        if (!content) return;
        const zs = getZoom(type);
        if (!zs) return;

        content.style.transform = `translate(${zs.x}px, ${zs.y}px) scale(${zs.scale})`;
        container.classList.toggle('zoomed', zs.scale > 1);
    }

    function updateZoomDisplay(type) {
        const zs = getZoom(type);
        if (!zs) return;
        const zoomLevel = Math.round(zs.scale * 100);
        const resetButton = document.getElementById(`${idPrefix}zoom-reset-${type}`);
        if (resetButton) resetButton.textContent = `${zoomLevel}%`;

        const zoomInBtn = document.getElementById(`${idPrefix}zoom-in-${type}`);
        const zoomOutBtn = document.getElementById(`${idPrefix}zoom-out-${type}`);
        if (zoomInBtn) zoomInBtn.disabled = zs.scale >= 5;
        if (zoomOutBtn) zoomOutBtn.disabled = zs.scale <= 0.1;
    }

    function setupPanControls(type) {
        const container = document.querySelector(`[data-preview="${idPrefix}${type}"]`);
        if (!container) return;
        const content = container.querySelector('.preview-content');
        if (!content) return;
        const zs = getZoom(type);
        if (!zs) return;

        let startX, startY, initialX, initialY;

        content.addEventListener('mousedown', (e) => {
            if (zs.scale <= 1) return;
            e.preventDefault();
            zs.isDragging = true;
            container.classList.add('dragging');
            startX = e.clientX;
            startY = e.clientY;
            initialX = zs.x;
            initialY = zs.y;
        });

        document.addEventListener('mousemove', (e) => {
            if (!zs.isDragging) return;
            e.preventDefault();
            zs.x = initialX + (e.clientX - startX);
            zs.y = initialY + (e.clientY - startY);
            updatePreviewTransform(type);
        });

        document.addEventListener('mouseup', () => {
            if (zs.isDragging) {
                zs.isDragging = false;
                container.classList.remove('dragging');
            }
        });

        content.addEventListener('touchstart', (e) => {
            if (zs.scale <= 1) return;
            e.preventDefault();
            zs.isDragging = true;
            container.classList.add('dragging');
            const touch = e.touches[0];
            startX = touch.clientX;
            startY = touch.clientY;
            initialX = zs.x;
            initialY = zs.y;
        }, { passive: false });

        document.addEventListener('touchmove', (e) => {
            if (!zs.isDragging) return;
            e.preventDefault();
            const touch = e.touches[0];
            zs.x = initialX + (touch.clientX - startX);
            zs.y = initialY + (touch.clientY - startY);
            updatePreviewTransform(type);
        }, { passive: false });

        document.addEventListener('touchend', () => {
            if (zs.isDragging) {
                zs.isDragging = false;
                container.classList.remove('dragging');
            }
        });

        container.addEventListener('wheel', (e) => {
            e.preventDefault();
            zoomPreview(type, e.deltaY > 0 ? 0.9 : 1.1);
        }, { passive: false });
    }

    /**
     * Wires up zoom buttons and pan controls for each type in the provided list.
     * @param {string[]} types - e.g. ['all'] or ['all', 'selected']
     */
    function setupZoomControls(types = ['all']) {
        types.forEach((type) => {
            const zoomIn = document.getElementById(`${idPrefix}zoom-in-${type}`);
            const zoomOut = document.getElementById(`${idPrefix}zoom-out-${type}`);
            const zoomReset = document.getElementById(`${idPrefix}zoom-reset-${type}`);

            if (zoomIn) zoomIn.addEventListener('click', () => zoomPreview(type, 1.25));
            if (zoomOut) zoomOut.addEventListener('click', () => zoomPreview(type, 0.8));
            if (zoomReset) zoomReset.addEventListener('click', () => resetZoom(type));

            setupPanControls(type);
            updateZoomDisplay(type);
        });
    }

    return { setupZoomControls, zoomPreview, resetZoom };
}
