import { createZipFile } from '../export3d.js';
import {
    estimateRasterBlobSizeFromSource,
    estimateSizeBytes,
    formatBytes,
    getBulkFolderName,
    getBulkRelativePath,
    getFormatLabel,
    getImageFormat,
    IMPORTABLE_IMAGE_PROMPT,
    getPreserveAlphaForFormat,
    getRasterExtension,
    getScaledDimensions,
    getSortedBulkFiles,
    isSupportedBulkFile,
    loadImageElementFromFile,
    loadImageMetricsFromFile,
    renderRasterBlobFromSource,
    sanitizeFileComponent
} from '../raster-utils.js';

export function createBulkTabController({
    state,
    elements,
    showLoader,
    syncWorkspaceView,
    downloadBlob
}) {
    const bulkEstimateCache = new Map();
    let bulkEstimateJobId = 0;

    function createBulkListCell(label, primary, secondary = '') {
        const cell = document.createElement('div');
        cell.className = 'bulk-list-cell';
        cell.dataset.label = label;

        const primaryText = document.createElement('span');
        primaryText.className = 'bulk-list-primary';
        primaryText.textContent = primary;
        cell.appendChild(primaryText);

        if (secondary) {
            const secondaryText = document.createElement('span');
            secondaryText.className = 'bulk-list-secondary';
            secondaryText.textContent = secondary;
            cell.appendChild(secondaryText);
        }

        return cell;
    }

    function buildBulkExportFileName(entry, index) {
        const ext = getRasterExtension(state.bulk.exportFormat);
        if (state.bulk.keepOriginalNames) {
            const originalBase = entry.name.replace(/\.[^.]+$/, '');
            const baseName = sanitizeFileComponent(originalBase, 'image');
            return `${baseName}.${ext}`;
        }
        const rawName = state.bulk.outputName.trim() || state.bulk.folderName || entry.name;
        const baseName = sanitizeFileComponent(rawName, 'image');
        return `${baseName}_${index}.${ext}`;
    }

    function computeBulkTarget(entry) {
        if (state.bulk.resizeMode === 'fixed') {
            return {
                width: Math.max(1, Math.round(state.bulk.targetWidth)),
                height: Math.max(1, Math.round(state.bulk.targetHeight)),
                fitMode: state.bulk.fitMode
            };
        }
        return getScaledDimensions(
            { width: entry.width, height: entry.height },
            state.bulk.exportScale
        );
    }

    function getBulkEstimateCacheKey(entry, target, format, preserveAlpha) {
        return [
            entry.relativePath,
            entry.size,
            entry.width,
            entry.height,
            entry.file?.lastModified || 0,
            target.width,
            target.height,
            target.fitMode || '',
            format,
            preserveAlpha ? 1 : 0
        ].join('|');
    }

    async function getBulkAccurateEstimate(entry, target, format, preserveAlpha) {
        const cacheKey = getBulkEstimateCacheKey(entry, target, format, preserveAlpha);
        if (bulkEstimateCache.has(cacheKey)) {
            return bulkEstimateCache.get(cacheKey);
        }

        const { img, cleanup } = await loadImageElementFromFile(entry.file);
        try {
            const bytes = await estimateRasterBlobSizeFromSource(img, target, format, preserveAlpha);
            bulkEstimateCache.set(cacheKey, bytes);
            return bytes;
        } finally {
            cleanup();
        }
    }

    function formatEstimatedBytes(bytes) {
        return typeof bytes === 'number' ? formatBytes(bytes) : 'Estimating...';
    }

    function updateBulkTotalsDisplay(originalBytes) {
        const resolvedItems = state.bulk.previewItems.filter((entry) => typeof entry.estimatedBytes === 'number');
        const allResolved = resolvedItems.length === state.bulk.previewItems.length;

        if (!state.bulk.previewItems.length) {
            state.bulk.totals = {
                originalBytes,
                estimatedBytes: 0,
                savedBytes: 0,
                savedPercent: 0
            };
            if (elements.bulkEstOriginal) elements.bulkEstOriginal.textContent = '—';
            if (elements.bulkEstOutput) elements.bulkEstOutput.textContent = '—';
            if (elements.bulkTotalSaved) elements.bulkTotalSaved.textContent = '—';
            if (elements.bulkTotalSavedPercent) elements.bulkTotalSavedPercent.textContent = '—';
            return;
        }

        if (!allResolved) {
            state.bulk.totals = {
                originalBytes,
                estimatedBytes: 0,
                savedBytes: 0,
                savedPercent: 0
            };
            if (elements.bulkEstOriginal) elements.bulkEstOriginal.textContent = 'Estimating...';
            if (elements.bulkEstOutput) elements.bulkEstOutput.textContent = 'Estimating...';
            if (elements.bulkTotalSaved) {
                elements.bulkTotalSaved.textContent = `Estimating ${resolvedItems.length}/${state.bulk.previewItems.length}`;
            }
            if (elements.bulkTotalSavedPercent) {
                elements.bulkTotalSavedPercent.textContent = 'Calculating actual output sizes';
            }
            return;
        }

        const estimatedBytes = resolvedItems.reduce((sum, entry) => sum + entry.estimatedBytes, 0);
        const savedBytes = originalBytes - estimatedBytes;
        const savedPercent = originalBytes > 0 ? (savedBytes / originalBytes) * 100 : 0;

        state.bulk.totals = {
            originalBytes,
            estimatedBytes,
            savedBytes,
            savedPercent
        };

        if (elements.bulkEstOriginal) elements.bulkEstOriginal.textContent = formatBytes(Math.abs(savedBytes));
        if (elements.bulkEstOutput) elements.bulkEstOutput.textContent = formatBytes(estimatedBytes);

        if (elements.bulkTotalSaved) {
            if (savedBytes > 0) {
                elements.bulkTotalSaved.textContent = `Saved ${formatBytes(savedBytes)}`;
            } else if (savedBytes < 0) {
                elements.bulkTotalSaved.textContent = `Larger by ${formatBytes(Math.abs(savedBytes))}`;
            } else {
                elements.bulkTotalSaved.textContent = 'No size change';
            }
        }

        if (elements.bulkTotalSavedPercent) {
            if (savedBytes > 0) {
                elements.bulkTotalSavedPercent.textContent = `${savedPercent.toFixed(1)}% smaller overall`;
            } else if (savedBytes < 0) {
                elements.bulkTotalSavedPercent.textContent = `${Math.abs(savedPercent).toFixed(1)}% larger overall`;
            } else {
                elements.bulkTotalSavedPercent.textContent = '0.0% difference';
            }
        }
    }

    async function hydrateBulkEstimates(jobId, format, preserveAlpha) {
        for (const item of state.bulk.previewItems) {
            if (jobId !== bulkEstimateJobId) return;
            if (typeof item.estimatedBytes === 'number') continue;

            try {
                item.estimatedBytes = await getBulkAccurateEstimate(item, item.target, format, preserveAlpha);
            } catch (error) {
                console.warn(`Falling back to approximate ${getFormatLabel(format)} bulk estimate for ${item.name}.`, error);
                item.estimatedBytes = estimateSizeBytes(item.target.width, item.target.height, format, preserveAlpha);
            }

            if (jobId !== bulkEstimateJobId) return;
            updateBulkTotalsDisplay(state.bulk.files.reduce((sum, entry) => sum + entry.size, 0));
            renderBulkPreviewList();
            renderSelectedPreviewDetails();
        }
    }

    function getSelectedPreviewItem() {
        if (state.bulk.selectedPreviewIndex < 0) return null;
        return state.bulk.previewItems[state.bulk.selectedPreviewIndex] || null;
    }

    function syncSelectedPreviewIndex() {
        if (!state.bulk.previewItems.length) {
            state.bulk.selectedPreviewIndex = -1;
            return;
        }

        if (
            state.bulk.selectedPreviewIndex < 0
            || state.bulk.selectedPreviewIndex >= state.bulk.previewItems.length
        ) {
            state.bulk.selectedPreviewIndex = 0;
        }
    }

    function renderSelectedPreviewDetails() {
        const selectedItem = getSelectedPreviewItem();
        const formatLabel = getFormatLabel(state.bulk.exportFormat);

        if (elements.bulkSelectedChip) {
            elements.bulkSelectedChip.textContent = selectedItem
                ? `${state.bulk.selectedPreviewIndex + 1} / ${state.bulk.previewItems.length}`
                : 'No selection';
        }

        if (elements.bulkSelectedFormat) {
            elements.bulkSelectedFormat.textContent = formatLabel;
        }

        if (!selectedItem) {
            if (elements.bulkSelectedName) elements.bulkSelectedName.textContent = 'No file selected';
            if (elements.bulkSelectedPath) {
                elements.bulkSelectedPath.textContent = state.bulk.folderName
                    ? 'This folder does not have a selectable preview item yet.'
                    : 'Choose a folder from the left sidebar to begin.';
            }
            if (elements.bulkSelectedExportName) elements.bulkSelectedExportName.textContent = '—';
            if (elements.bulkSelectedOriginalDims) elements.bulkSelectedOriginalDims.textContent = '—';
            if (elements.bulkSelectedOriginalSize) elements.bulkSelectedOriginalSize.textContent = '—';
            if (elements.bulkSelectedOutputDims) elements.bulkSelectedOutputDims.textContent = '—';
            if (elements.bulkSelectedEstSize) elements.bulkSelectedEstSize.textContent = '—';
            if (elements.bulkSelectedOutputFormat) elements.bulkSelectedOutputFormat.textContent = '—';
            return;
        }

        if (elements.bulkSelectedName) elements.bulkSelectedName.textContent = selectedItem.name;
        if (elements.bulkSelectedPath) {
            elements.bulkSelectedPath.textContent = selectedItem.relativePath !== selectedItem.name
                ? selectedItem.relativePath
                : 'Top-level file';
        }
        if (elements.bulkSelectedExportName) elements.bulkSelectedExportName.textContent = selectedItem.exportName;
        if (elements.bulkSelectedOriginalDims) {
            elements.bulkSelectedOriginalDims.textContent = `${selectedItem.width}×${selectedItem.height}px`;
        }
        if (elements.bulkSelectedOriginalSize) {
            elements.bulkSelectedOriginalSize.textContent = formatBytes(selectedItem.size);
        }
        if (elements.bulkSelectedOutputDims) {
            elements.bulkSelectedOutputDims.textContent = `${selectedItem.target.width}×${selectedItem.target.height}px`;
        }
        if (elements.bulkSelectedEstSize) {
            elements.bulkSelectedEstSize.textContent = formatEstimatedBytes(selectedItem.estimatedBytes);
        }
        if (elements.bulkSelectedOutputFormat) {
            elements.bulkSelectedOutputFormat.textContent = formatLabel;
        }
    }

    function renderBulkSourceList() {
        if (!elements.bulkSourceList) return;
        elements.bulkSourceList.innerHTML = '';

        if (!state.bulk.files.length) {
            const empty = document.createElement('div');
            empty.className = 'bulk-empty-state';
            empty.textContent = state.bulk.folderName
                ? `No compatible images were found. Supported imports include ${IMPORTABLE_IMAGE_PROMPT}.`
                : `Choose a folder from the left sidebar to see compatible images. Supported imports include ${IMPORTABLE_IMAGE_PROMPT}.`;
            elements.bulkSourceList.appendChild(empty);
            return;
        }

        const fragment = document.createDocumentFragment();
        state.bulk.files.forEach((entry) => {
            const row = document.createElement('div');
            row.className = 'bulk-list-row';
            row.appendChild(createBulkListCell('Name', entry.name, entry.relativePath !== entry.name ? entry.relativePath : ''));
            row.appendChild(createBulkListCell('Resolution', `${entry.width}×${entry.height}px`));
            row.appendChild(createBulkListCell('File Size', formatBytes(entry.size)));
            row.appendChild(createBulkListCell('Format', entry.format));
            fragment.appendChild(row);
        });

        elements.bulkSourceList.appendChild(fragment);
    }

    function renderBulkPreviewList() {
        if (!elements.bulkPreviewList) return;
        elements.bulkPreviewList.innerHTML = '';

        if (!state.bulk.previewItems.length) {
            const empty = document.createElement('div');
            empty.className = 'bulk-empty-state';
            empty.textContent = state.bulk.folderName
                ? 'No bulk preview is available for this folder.'
                : 'Choose a folder from the left sidebar to preview bulk output.';
            elements.bulkPreviewList.appendChild(empty);
            return;
        }

        const fragment = document.createDocumentFragment();
        state.bulk.previewItems.forEach((entry, index) => {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'bulk-list-row bulk-result-row bulk-result-button';
            row.classList.toggle('is-selected', index === state.bulk.selectedPreviewIndex);
            row.appendChild(createBulkListCell('Image', entry.name, entry.relativePath !== entry.name ? entry.relativePath : entry.exportName));
            row.appendChild(createBulkListCell('Result', `${entry.target.width}×${entry.target.height}px`, entry.exportName));
            row.appendChild(createBulkListCell('Estimated', formatEstimatedBytes(entry.estimatedBytes), getFormatLabel(state.bulk.exportFormat)));
            row.addEventListener('click', () => {
                state.bulk.selectedPreviewIndex = index;
                renderBulkPreviewList();
                renderSelectedPreviewDetails();
            });
            fragment.appendChild(row);
        });

        elements.bulkPreviewList.appendChild(fragment);
    }

    function updateBulkAlphaVisibility() {
        if (!elements.bulkAlphaToggle || !elements.bulkPreserveAlphaCheckbox) return;

        const supportsAlpha = state.bulk.exportFormat === 'png' || state.bulk.exportFormat === 'tga';
        elements.bulkAlphaToggle.classList.toggle('hidden', !supportsAlpha);
        elements.bulkPreserveAlphaCheckbox.disabled = !supportsAlpha;
    }

    function setExportScale(scale) {
        state.bulk.exportScale = Math.min(500, Math.max(1, Math.round(scale)));
        state.bulk.resizeMode = 'scale';
        elements.bulkResizeChips.forEach((chip) => {
            chip.classList.toggle('active', parseInt(chip.dataset.scale, 10) === state.bulk.exportScale);
        });
        updatePreview();
    }

    function setResizeMode(mode) {
        state.bulk.resizeMode = mode === 'fixed' ? 'fixed' : 'scale';
        updatePreview();
    }

    function syncResizeModeUI() {
        if (elements.bulkResizeModeTabs) {
            elements.bulkResizeModeTabs.forEach((tab) => {
                tab.classList.toggle('active', tab.dataset.mode === state.bulk.resizeMode);
            });
        }
        if (elements.bulkResizePanels) {
            elements.bulkResizePanels.forEach((panel) => {
                panel.classList.toggle('hidden', panel.dataset.modePanel !== state.bulk.resizeMode);
            });
        }
        if (elements.bulkTargetWidthInput && document.activeElement !== elements.bulkTargetWidthInput) {
            elements.bulkTargetWidthInput.value = state.bulk.targetWidth;
        }
        if (elements.bulkTargetHeightInput && document.activeElement !== elements.bulkTargetHeightInput) {
            elements.bulkTargetHeightInput.value = state.bulk.targetHeight;
        }
        if (elements.bulkFitModeSelect) {
            elements.bulkFitModeSelect.value = state.bulk.fitMode;
        }
    }

    function updatePreview() {
        const preserveAlpha = getPreserveAlphaForFormat(state.bulk.exportFormat, state.bulk.preserveAlpha);
        const previewItems = state.bulk.files.map((entry, index) => {
            const target = computeBulkTarget(entry);
            const estimateCacheKey = getBulkEstimateCacheKey(entry, target, state.bulk.exportFormat, preserveAlpha);
            const estimatedBytes = bulkEstimateCache.has(estimateCacheKey)
                ? bulkEstimateCache.get(estimateCacheKey)
                : null;
            return {
                ...entry,
                target,
                estimatedBytes,
                estimateCacheKey,
                exportName: buildBulkExportFileName(entry, index + 1)
            };
        });

        const originalBytes = state.bulk.files.reduce((sum, entry) => sum + entry.size, 0);

        state.bulk.previewItems = previewItems;
        syncSelectedPreviewIndex();
        bulkEstimateJobId += 1;

        if (elements.bulkPreviewCount) elements.bulkPreviewCount.textContent = String(state.bulk.files.length);
        if (elements.bulkPreviewFormat) elements.bulkPreviewFormat.textContent = getFormatLabel(state.bulk.exportFormat);
        if (elements.bulkPreviewScale) {
            elements.bulkPreviewScale.textContent = state.bulk.resizeMode === 'fixed'
                ? `${Math.max(1, Math.round(state.bulk.targetWidth))}×${Math.max(1, Math.round(state.bulk.targetHeight))}`
                : `${state.bulk.exportScale}%`;
        }
        elements.bulkFormatTabs.forEach((tab) => {
            tab.classList.toggle('active', tab.dataset.format === state.bulk.exportFormat);
        });
        if (elements.bulkPreserveAlphaCheckbox) elements.bulkPreserveAlphaCheckbox.checked = state.bulk.preserveAlpha;
        if (elements.bulkFolderName) elements.bulkFolderName.textContent = state.bulk.folderName || '—';
        if (elements.bulkFileCount) elements.bulkFileCount.textContent = String(state.bulk.files.length);
        if (elements.bulkSkipCount) elements.bulkSkipCount.textContent = String(state.bulk.skippedCount);
        const skipWrap = document.getElementById('bulk-skip-count-wrap');
        if (skipWrap) skipWrap.classList.toggle('hidden', state.bulk.skippedCount === 0);
        if (elements.bulkOutputNameInput && !state.bulk.outputName) {
            elements.bulkOutputNameInput.placeholder = state.bulk.folderName
                ? `e.g. ${state.bulk.folderName} (saved as name_1.${getRasterExtension(state.bulk.exportFormat)})`
                : 'e.g. export (saved as name_1.jpg)';
        }
        if (elements.bulkOriginalTotal) elements.bulkOriginalTotal.textContent = formatBytes(originalBytes);
        updateBulkTotalsDisplay(originalBytes);

        if (elements.bulkFolderSummary) {
            elements.bulkFolderSummary.textContent = state.bulk.folderName
                ? `${state.bulk.files.length} file(s)${state.bulk.skippedCount ? ` · ${state.bulk.skippedCount} skipped` : ''}`
                : '';
        }

        updateBulkAlphaVisibility();
        syncResizeModeUI();
        renderBulkSourceList();
        renderBulkPreviewList();
        renderSelectedPreviewDetails();

        if (elements.bulkDownloadBtn) {
            elements.bulkDownloadBtn.disabled = state.bulk.files.length === 0;
        }

        if (state.bulk.previewItems.length) {
            void hydrateBulkEstimates(bulkEstimateJobId, state.bulk.exportFormat, preserveAlpha);
        }
    }

    async function handleFolderSelection(files) {
        syncWorkspaceView();

        showLoader(true, {
            title: 'Scanning Folder...',
            subtitle: 'Preparing folder scan...'
        });

        try {
            const sortedFiles = getSortedBulkFiles(files);
            const supportedFiles = sortedFiles.filter((file) => isSupportedBulkFile(file));
            const skippedUnsupported = sortedFiles.length - supportedFiles.length;
            const supportedTotal = supportedFiles.length;

            showLoader(true, {
                title: 'Scanning Folder...',
                subtitle: supportedTotal
                    ? `0 / ${supportedTotal} supported image(s) analyzed`
                    : 'Checking selected folder contents',
                progress: supportedTotal ? 0 : 1
            });
            elements.statusText.textContent = supportedTotal
                ? `Scanning ${supportedTotal} compatible image(s)...`
                : `Checking selected folder for ${IMPORTABLE_IMAGE_PROMPT}...`;

            let processedCount = 0;
            const loadedEntries = await Promise.all(supportedFiles.map(async (file) => {
                try {
                    const metrics = await loadImageMetricsFromFile(file);
                    return {
                        file,
                        name: file.name,
                        relativePath: getBulkRelativePath(file),
                        format: getImageFormat(file.name, null),
                        size: file.size,
                        width: metrics.width,
                        height: metrics.height
                    };
                } catch (error) {
                    console.warn('Skipping unreadable bulk file:', file.name, error);
                    return null;
                } finally {
                    processedCount += 1;
                    showLoader(true, {
                        title: 'Scanning Folder...',
                        subtitle: `${processedCount} / ${supportedTotal} supported image(s) analyzed`,
                        progress: supportedTotal ? processedCount / supportedTotal : 1
                    });
                }
            }));

            const validFiles = loadedEntries.filter(Boolean);
            const invalidCount = loadedEntries.length - validFiles.length;

            state.bulk.folderName = sortedFiles.length ? getBulkFolderName(sortedFiles) : '';
            state.bulk.files = validFiles;
            state.bulk.selectedPreviewIndex = validFiles.length ? 0 : -1;
            state.bulk.skippedCount = skippedUnsupported + invalidCount;

            updatePreview();

            if (validFiles.length) {
                elements.statusText.textContent = `Loaded ${validFiles.length} image(s) from ${state.bulk.folderName}.${state.bulk.skippedCount ? ` Skipped ${state.bulk.skippedCount}.` : ''}`;
            } else {
                elements.statusText.textContent = `No compatible images found in selected folder. Supported imports include ${IMPORTABLE_IMAGE_PROMPT}.`;
            }
        } catch (error) {
            console.error('Bulk folder scan failed:', error);
            state.bulk.folderName = '';
            state.bulk.files = [];
            state.bulk.selectedPreviewIndex = -1;
            state.bulk.skippedCount = 0;
            updatePreview();
            elements.statusText.textContent = `Folder scan failed: ${error.message || 'Unexpected error while reading the selected folder.'}`;
        } finally {
            showLoader(false);
        }
    }

    async function saveBulkRaster() {
        if (!state.bulk.files.length) {
            elements.statusText.textContent = 'No folder loaded for bulk export.';
            return;
        }

        const preserveAlpha = getPreserveAlphaForFormat(state.bulk.exportFormat, state.bulk.preserveAlpha);
        const zipEntries = {};
        let processedCount = 0;
        let failedCount = 0;

        try {
            showLoader(true, {
                title: 'Converting Bulk Images...',
                subtitle: `0 / ${state.bulk.files.length} image(s) converted`,
                progress: 0
            });
            if (elements.bulkDownloadBtn) elements.bulkDownloadBtn.disabled = true;

            for (const [index, entry] of state.bulk.files.entries()) {
                elements.statusText.textContent = `Converting ${index + 1}/${state.bulk.files.length}: ${entry.name}`;
                showLoader(true, {
                    title: 'Converting Bulk Images...',
                    subtitle: `${index} / ${state.bulk.files.length} image(s) converted`,
                    progress: state.bulk.files.length ? index / state.bulk.files.length : 0
                });

                try {
                    const { img, cleanup } = await loadImageElementFromFile(entry.file);
                    try {
                        const target = computeBulkTarget(entry);
                        const blob = await renderRasterBlobFromSource(img, target, state.bulk.exportFormat, preserveAlpha);
                        zipEntries[buildBulkExportFileName(entry, index + 1)] = blob;
                        processedCount++;
                    } finally {
                        cleanup();
                    }
                } catch (error) {
                    failedCount++;
                    console.warn('Bulk export skipped file:', entry.name, error);
                }

                showLoader(true, {
                    title: 'Converting Bulk Images...',
                    subtitle: `${index + 1} / ${state.bulk.files.length} image(s) converted`,
                    progress: state.bulk.files.length ? (index + 1) / state.bulk.files.length : 1
                });
            }

            if (!processedCount) {
                throw new Error('No files were successfully converted.');
            }

            elements.statusText.textContent = 'Packaging ZIP archive...';
            showLoader(true, {
                title: 'Packaging ZIP Archive...',
                subtitle: `${processedCount} file(s) ready for download`,
                progress: 1
            });
            const zipBlob = await createZipFile(zipEntries);
            const rawArchiveName = state.bulk.outputName.trim() || state.bulk.folderName || 'bulk_export';
            const archiveName = `${sanitizeFileComponent(rawArchiveName, 'bulk_export')}.zip`;
            downloadBlob(zipBlob, archiveName);
            elements.statusText.textContent = `Exported ${processedCount} image(s) to ${archiveName}.${failedCount ? ` Skipped ${failedCount} unreadable file(s).` : ''}`;
        } catch (error) {
            console.error('Bulk export failed:', error);
            elements.statusText.textContent = error.message || 'Failed to export bulk images.';
        } finally {
            showLoader(false);
            if (elements.bulkDownloadBtn) {
                elements.bulkDownloadBtn.disabled = state.bulk.files.length === 0;
            }
        }
    }

    function bindEvents() {
        if (elements.bulkFolderInput) {
            elements.bulkFolderInput.addEventListener('change', async (event) => {
                const files = Array.from(event.target.files || []);
                if (files.length) {
                    await handleFolderSelection(files);
                }
                event.target.value = '';
            });
        }

        elements.bulkResizeChips.forEach((chip) => {
            chip.addEventListener('click', () => {
                const scale = parseInt(chip.dataset.scale, 10);
                if (!isNaN(scale)) setExportScale(scale);
            });
        });

        if (elements.applyBulkCustomResizeBtn) {
            elements.applyBulkCustomResizeBtn.addEventListener('click', () => {
                const val = parseInt(elements.bulkResizeCustomInput.value, 10);
                if (!isNaN(val)) setExportScale(val);
            });
        }

        if (elements.bulkResizeModeTabs) {
            elements.bulkResizeModeTabs.forEach((tab) => {
                tab.addEventListener('click', () => {
                    setResizeMode(tab.dataset.mode);
                });
            });
        }

        if (elements.applyBulkFixedSizeBtn) {
            elements.applyBulkFixedSizeBtn.addEventListener('click', () => {
                const w = parseInt(elements.bulkTargetWidthInput?.value, 10);
                const h = parseInt(elements.bulkTargetHeightInput?.value, 10);
                if (!isNaN(w) && w > 0) state.bulk.targetWidth = Math.min(16384, w);
                if (!isNaN(h) && h > 0) state.bulk.targetHeight = Math.min(16384, h);
                updatePreview();
            });
        }

        if (elements.bulkFitModeSelect) {
            elements.bulkFitModeSelect.addEventListener('change', () => {
                state.bulk.fitMode = elements.bulkFitModeSelect.value;
                updatePreview();
            });
        }

        if (elements.bulkKeepNamesCheckbox) {
            elements.bulkKeepNamesCheckbox.checked = state.bulk.keepOriginalNames;
            elements.bulkKeepNamesCheckbox.addEventListener('change', () => {
                state.bulk.keepOriginalNames = elements.bulkKeepNamesCheckbox.checked;
                updatePreview();
            });
        }

        elements.bulkFormatTabs.forEach((tab) => {
            tab.addEventListener('click', () => {
                state.bulk.exportFormat = tab.dataset.format;
                updatePreview();
            });
        });

        if (elements.bulkOutputNameInput) {
            elements.bulkOutputNameInput.addEventListener('input', () => {
                state.bulk.outputName = elements.bulkOutputNameInput.value;
                updatePreview();
            });
        }

        if (elements.bulkPreserveAlphaCheckbox) {
            elements.bulkPreserveAlphaCheckbox.checked = state.bulk.preserveAlpha;
            elements.bulkPreserveAlphaCheckbox.addEventListener('change', () => {
                state.bulk.preserveAlpha = elements.bulkPreserveAlphaCheckbox.checked;
                updatePreview();
            });
        }

        if (elements.bulkDownloadBtn) {
            elements.bulkDownloadBtn.addEventListener('click', saveBulkRaster);
        }
    }

    function onTabActivated() {
        updatePreview();
    }

    return {
        bindEvents,
        onTabActivated,
        setExportScale,
        updatePreview,
        handleFolderSelection,
        saveBulkRaster
    };
}
