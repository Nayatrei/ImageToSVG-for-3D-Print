import { createZipFile } from '../export3d.js';
import {
    BULK_SUPPORTED_EXTENSIONS,
    estimateSizeBytes,
    formatBytes,
    getBulkFolderName,
    getBulkRelativePath,
    getFormatLabel,
    getImageFormat,
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
        const baseName = sanitizeFileComponent(entry.name, 'image');
        return `${baseName}_${state.bulk.exportScale}p_resize${index}.${getRasterExtension(state.bulk.exportFormat)}`;
    }

    function renderBulkSourceList() {
        if (!elements.bulkSourceList) return;
        elements.bulkSourceList.innerHTML = '';

        if (!state.bulk.files.length) {
            const empty = document.createElement('div');
            empty.className = 'bulk-empty-state';
            empty.textContent = state.bulk.folderName
                ? `No supported ${Array.from(BULK_SUPPORTED_EXTENSIONS).join(', ').toUpperCase()} images were found.`
                : 'No folder selected.';
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
                ? 'No bulk preview available for this folder.'
                : 'Select a folder to preview bulk output.';
            elements.bulkPreviewList.appendChild(empty);
            return;
        }

        const fragment = document.createDocumentFragment();
        state.bulk.previewItems.forEach((entry) => {
            const row = document.createElement('div');
            row.className = 'bulk-list-row bulk-result-row';
            row.appendChild(createBulkListCell('Image', entry.name, entry.relativePath !== entry.name ? entry.relativePath : entry.exportName));
            row.appendChild(createBulkListCell('Result', `${entry.target.width}×${entry.target.height}px`, entry.exportName));
            row.appendChild(createBulkListCell('Estimated', formatBytes(entry.estimatedBytes), getFormatLabel(state.bulk.exportFormat)));
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
        elements.bulkResizeChips.forEach((chip) => {
            chip.classList.toggle('active', parseInt(chip.dataset.scale, 10) === state.bulk.exportScale);
        });
        updatePreview();
    }

    function updatePreview() {
        const preserveAlpha = getPreserveAlphaForFormat(state.bulk.exportFormat, state.bulk.preserveAlpha);
        const previewItems = state.bulk.files.map((entry, index) => {
            const target = getScaledDimensions({ width: entry.width, height: entry.height }, state.bulk.exportScale);
            const estimatedBytes = estimateSizeBytes(target.width, target.height, state.bulk.exportFormat, preserveAlpha);
            return {
                ...entry,
                target,
                estimatedBytes,
                exportName: buildBulkExportFileName(entry, index + 1)
            };
        });

        const originalBytes = state.bulk.files.reduce((sum, entry) => sum + entry.size, 0);
        const estimatedBytes = previewItems.reduce((sum, entry) => sum + entry.estimatedBytes, 0);
        const savedBytes = originalBytes - estimatedBytes;
        const savedPercent = originalBytes > 0 ? (savedBytes / originalBytes) * 100 : 0;

        state.bulk.previewItems = previewItems;
        state.bulk.totals = {
            originalBytes,
            estimatedBytes,
            savedBytes,
            savedPercent
        };

        if (elements.bulkPreviewCount) elements.bulkPreviewCount.textContent = String(state.bulk.files.length);
        if (elements.bulkPreviewFormat) elements.bulkPreviewFormat.textContent = getFormatLabel(state.bulk.exportFormat);
        if (elements.bulkPreviewScale) elements.bulkPreviewScale.textContent = `${state.bulk.exportScale}%`;
        if (elements.bulkFormatSelect) elements.bulkFormatSelect.value = state.bulk.exportFormat;
        if (elements.bulkPreserveAlphaCheckbox) elements.bulkPreserveAlphaCheckbox.checked = state.bulk.preserveAlpha;
        if (elements.bulkFolderName) elements.bulkFolderName.textContent = state.bulk.folderName || '—';
        if (elements.bulkFileCount) elements.bulkFileCount.textContent = String(state.bulk.files.length);
        if (elements.bulkSkipCount) elements.bulkSkipCount.textContent = String(state.bulk.skippedCount);
        if (elements.bulkOriginalTotal) elements.bulkOriginalTotal.textContent = formatBytes(originalBytes);
        if (elements.bulkEstOriginal) elements.bulkEstOriginal.textContent = formatBytes(originalBytes);
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

        if (elements.bulkFolderSummary) {
            elements.bulkFolderSummary.textContent = state.bulk.folderName
                ? `${state.bulk.folderName} · ${state.bulk.files.length} supported image(s)${state.bulk.skippedCount ? ` · ${state.bulk.skippedCount} skipped` : ''}`
                : 'Select a folder to scan PNG, JPG, JPEG, and WEBP images.';
        }

        updateBulkAlphaVisibility();
        renderBulkPreviewList();
        renderBulkSourceList();

        if (elements.bulkDownloadBtn) {
            elements.bulkDownloadBtn.disabled = state.bulk.files.length === 0;
        }
    }

    async function handleFolderSelection(files) {
        syncWorkspaceView();

        const sortedFiles = getSortedBulkFiles(files);
        const supportedFiles = sortedFiles.filter(isSupportedBulkFile);
        const skippedUnsupported = sortedFiles.length - supportedFiles.length;

        showLoader(true);
        elements.statusText.textContent = 'Scanning folder...';

        try {
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
                }
            }));

            const validFiles = loadedEntries.filter(Boolean);
            const invalidCount = loadedEntries.length - validFiles.length;

            state.bulk.folderName = sortedFiles.length ? getBulkFolderName(sortedFiles) : '';
            state.bulk.files = validFiles;
            state.bulk.skippedCount = skippedUnsupported + invalidCount;

            updatePreview();

            if (validFiles.length) {
                elements.statusText.textContent = `Loaded ${validFiles.length} image(s) from ${state.bulk.folderName}.${state.bulk.skippedCount ? ` Skipped ${state.bulk.skippedCount}.` : ''}`;
            } else {
                elements.statusText.textContent = 'No supported images found in selected folder.';
            }
        } catch (error) {
            console.error('Bulk folder scan failed:', error);
            state.bulk.folderName = '';
            state.bulk.files = [];
            state.bulk.skippedCount = 0;
            updatePreview();
            elements.statusText.textContent = 'Failed to scan folder.';
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
            showLoader(true);
            if (elements.bulkDownloadBtn) elements.bulkDownloadBtn.disabled = true;

            for (const [index, entry] of state.bulk.files.entries()) {
                elements.statusText.textContent = `Converting ${index + 1}/${state.bulk.files.length}: ${entry.name}`;

                try {
                    const { img, cleanup } = await loadImageElementFromFile(entry.file);
                    try {
                        const target = getScaledDimensions({ width: entry.width, height: entry.height }, state.bulk.exportScale);
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
            }

            if (!processedCount) {
                throw new Error('No files were successfully converted.');
            }

            elements.statusText.textContent = 'Packaging ZIP archive...';
            const zipBlob = await createZipFile(zipEntries);
            const archiveName = `${sanitizeFileComponent(state.bulk.folderName, 'bulk_export')}_${state.bulk.exportScale}p_${getRasterExtension(state.bulk.exportFormat)}.zip`;
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
        if (elements.bulkFolderBtn && elements.bulkFolderInput) {
            elements.bulkFolderBtn.addEventListener('click', () => {
                syncWorkspaceView();
                elements.bulkFolderInput.click();
            });

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

        if (elements.bulkFormatSelect) {
            elements.bulkFormatSelect.value = state.bulk.exportFormat;
            elements.bulkFormatSelect.addEventListener('change', () => {
                state.bulk.exportFormat = elements.bulkFormatSelect.value;
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
