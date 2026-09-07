import {
    launchBambuStudio,
    probeBambuTransferBackend,
    publishBambuProject
} from './bambu-bridge.js?v=r-0482439758aef41c';
import {
    createBambuSendProgress,
    waitForBrowserPaint
} from './shared/bambu-send-progress.js?v=r-0482439758aef41c';

const THREE_MF_BLOB_TYPE = 'model/3mf';

function setStatus(statusText, message) {
    if (statusText) statusText.textContent = message;
}

function createCancellationError() {
    const error = new Error('Bambu send cancelled.');
    error.name = 'AbortError';
    error.code = 'BAMBU_SEND_CANCELLED';
    return error;
}

function mapPackageProgress(event) {
    const ratio = Math.max(0, Math.min(1, Number(event?.ratio) || 0));
    if (event?.phase === 'preview') {
        return {
            stage: 'Creating project previews',
            value: 54 + (ratio * 8),
            detail: 'Rendering the thumbnails Bambu Studio will display…'
        };
    }
    if (event?.phase === 'serialize-mesh') {
        return {
            stage: 'Packaging 3MF meshes',
            value: 62 + (ratio * 12),
            detail: `Writing mesh ${event.completed || 0} of ${event.total || 0}…`
        };
    }
    if (event?.phase === 'serialize-xml') {
        return {
            stage: 'Packaging 3MF objects',
            value: 74 + (ratio * 9),
            detail: `Writing object ${event.completed || 0} of ${event.total || 0}…`
        };
    }
    return {
        stage: 'Compressing 3MF project',
        value: 83 + (ratio * 8),
        detail: 'Building the final Bambu Studio file…'
    };
}

/**
 * Coordinates the Bambu handoff only. Geometry preparation, 3MF packaging,
 * and DOM rendering are injected so none of those concerns own each other.
 */
export function createBambuSendWorkflow({
    controls,
    statusText,
    prepareGeometry,
    packageProject,
    downloadBlob,
    getBaseName,
    getSourceBaseName,
    getBedKey,
    disposeGeometry,
    waitForPaint = waitForBrowserPaint
}) {
    const progress = createBambuSendProgress(controls || {});
    let activeRun = null;
    let pendingHandoff = null;
    let lastStatusMessage = '';

    function isRunActive(run) {
        return activeRun === run && !run.cancelled && !run.controller.signal.aborted;
    }

    function assertRunActive(run) {
        if (!isRunActive(run)) throw createCancellationError();
    }

    function updateProgress(run, payload) {
        if (isRunActive(run)) progress.update(payload);
    }

    function updateStatus(run, message) {
        if (!isRunActive(run)) return;
        lastStatusMessage = message;
        setStatus(statusText, message);
    }

    function clearOwnedStatus() {
        if (statusText && statusText.textContent === lastStatusMessage) {
            statusText.textContent = '';
        }
        lastStatusMessage = '';
    }

    function setOwnedStatus(message) {
        lastStatusMessage = message;
        setStatus(statusText, message);
    }

    function parseExpiration(expiresAt) {
        const timestamp = Date.parse(expiresAt || '');
        return Number.isFinite(timestamp) ? timestamp : null;
    }

    function hasTrustedUserActivation() {
        if (typeof navigator === 'undefined' || !navigator.userActivation) return true;
        return navigator.userActivation.isActive === true;
    }

    function finishDownloadedHandoff(run, projectBlob, filename) {
        downloadBlob(projectBlob, filename);
        assertRunActive(run);
        pendingHandoff = {
            mode: 'downloaded',
            filename,
            transferUrl: '',
            expiresAt: null
        };
        const message = `${filename} downloaded to Downloads. Click Open Bambu Studio, then import the downloaded 3MF.`;
        updateStatus(run, message);
        progress.finish({
            state: 'ready',
            stage: '3MF downloaded',
            detail: message,
            buttonText: 'Open Bambu Studio'
        });
        return true;
    }

    async function prepareHandoff(defaultThickness) {
        if (activeRun !== null) return false;
        pendingHandoff = null;
        const run = {
            phase: 'prepare',
            cancelled: false,
            controller: new AbortController()
        };
        activeRun = run;
        if (!progress.begin()) {
            activeRun = null;
            return false;
        }

        const sourceBaseName = getSourceBaseName?.() || '';
        const sourceBedKey = getBedKey();
        let geometryBundle = null;
        try {
            updateStatus(run, 'Preparing model for Bambu Studio…');
            await waitForPaint();
            assertRunActive(run);

            run.step = 'geometry';
            geometryBundle = await prepareGeometry(defaultThickness, (event) => {
                updateProgress(run, { ...event, buttonText: 'Preparing model…' });
            }, run.controller.signal);
            assertRunActive(run);
            if (!geometryBundle?.layers?.size) throw new Error('No geometry generated.');

            const baseName = getBaseName(geometryBundle, defaultThickness, sourceBaseName);
            const filename = `${baseName}.3mf`;
            const bedKey = sourceBedKey;
            updateProgress(run, {
                stage: 'Building Bambu project',
                value: 54,
                detail: 'Creating previews, filament assignments, and print metadata…',
                buttonText: 'Building 3MF…'
            });
            updateStatus(run, 'Building the Bambu Studio project…');

            run.step = 'package';
            const exportResult = await packageProject({
                geometryBundle,
                baseName,
                bedKey,
                signal: run.controller.signal,
                onProgress: (event) => updateProgress(run, {
                    ...mapPackageProgress(event),
                    buttonText: 'Building 3MF…'
                })
            });
            assertRunActive(run);
            if (!exportResult?.blob) {
                throw new Error('Failed to assemble the Bambu Studio project.');
            }

            const projectBlob = exportResult.blob instanceof Blob
                ? exportResult.blob
                : new Blob([exportResult.blob], { type: THREE_MF_BLOB_TYPE });

            updateProgress(run, {
                stage: 'Checking transfer support',
                value: 92,
                detail: 'Checking whether this host supports direct Bambu transfer…',
                buttonText: 'Checking transfer…'
            });
            updateStatus(run, 'Checking direct Bambu transfer support…');

            run.step = 'probe';
            // The probe only decides which handoff to use. Any failure that is
            // not a caller cancellation means "no backend here", so it must fall
            // back to the download instead of failing the whole send — the same
            // recovery policy the publish step below already uses.
            let hasTransferBackend = false;
            try {
                hasTransferBackend = await probeBambuTransferBackend({
                    signal: run.controller.signal
                });
            } catch (probeError) {
                if (
                    run.cancelled
                    || run.controller.signal.aborted
                    || probeError?.code === 'BAMBU_SEND_CANCELLED'
                ) {
                    throw createCancellationError();
                }
                console.warn('Bambu transfer probe failed; using download fallback:', probeError);
                hasTransferBackend = false;
            }
            assertRunActive(run);
            if (!hasTransferBackend) {
                return finishDownloadedHandoff(run, projectBlob, filename);
            }

            updateProgress(run, {
                stage: 'Uploading temporary transfer',
                value: 94,
                detail: 'Uploading a temporary 10-minute transfer link. This can take up to 25 seconds…',
                buttonText: 'Uploading…'
            });
            updateStatus(run, 'Uploading a temporary Bambu transfer…');

            run.step = 'upload';
            let transfer;
            try {
                transfer = await publishBambuProject(projectBlob, filename, {
                    signal: run.controller.signal
                });
                assertRunActive(run);
            } catch (transferError) {
                if (run.cancelled || run.controller.signal.aborted) {
                    throw createCancellationError();
                }
                console.warn('Direct Bambu handoff unavailable; using download fallback:', transferError);
                return finishDownloadedHandoff(run, projectBlob, filename);
            }

            pendingHandoff = {
                mode: 'direct',
                filename,
                transferUrl: transfer.url,
                expiresAt: parseExpiration(transfer.expiresAt)
            };
            const message = `${filename} is ready for 10 minutes. Click Open Bambu Studio; Chrome and Bambu Studio may each ask for approval.`;
            updateStatus(run, message);
            progress.finish({
                state: 'ready',
                stage: 'Transfer ready',
                detail: message,
                buttonText: 'Open Bambu Studio'
            });
            return true;
        } catch (error) {
            if (run.cancelled || error?.code === 'BAMBU_SEND_CANCELLED') {
                return false;
            }
            // Name the step that failed. A bare "Could not send" hid whether the
            // geometry, the 3MF packaging, or the network was at fault.
            const step = run.step || 'prepare';
            console.error(
                `Export & open in Bambu failed during ${step}:`,
                { name: error?.name, code: error?.code, message: error?.message },
                error
            );
            const message = error?.message || 'Failed to export 3MF.';
            updateStatus(run, message);
            progress.finish({
                state: 'error',
                stage: error?.code === 'PREVIEW_NOT_READY'
                    ? 'Preview still updating'
                    : `Could not send (${step})`,
                detail: message
            });
            return false;
        } finally {
            try {
                if (geometryBundle) disposeGeometry?.(geometryBundle);
            } finally {
                if (activeRun === run) activeRun = null;
                if (run.cancelled) {
                    progress.cancel();
                    clearOwnedStatus();
                }
            }
        }
    }

    async function settlePreparedHandoff(run, handoff, launchPromise) {
        const isDownloadedHandoff = handoff.mode === 'downloaded';
        try {
            const launchResult = await launchPromise;
            assertRunActive(run);

            if (launchResult.opened) {
                pendingHandoff = handoff;
                const message = isDownloadedHandoff
                    ? `Bambu Studio launch requested. Import ${handoff.filename} from Downloads.`
                    : `Bambu Studio launch requested for ${handoff.filename}. If Chrome asks, choose Open. In Bambu Studio, choose Yes, then wait for Importing Model to finish.`;
                updateStatus(run, message);
                progress.finish({
                    state: 'warning',
                    stage: isDownloadedHandoff ? 'Import from Downloads' : 'Finish in Bambu Studio',
                    detail: message,
                    buttonText: 'Open Bambu Studio again'
                });
                return true;
            }

            assertRunActive(run);
            pendingHandoff = launchResult.attempted ? handoff : null;
            const message = launchResult.attempted
                ? isDownloadedHandoff
                    ? `Bambu Studio did not open yet. Click Open again, then import ${handoff.filename} from Downloads.`
                    : `Bambu Studio did not open yet. Click Open again, or use Download AMS-ready 3MF to open the file manually.`
                : isDownloadedHandoff
                    ? `Bambu Studio launch is unavailable on this platform. Open it manually and import ${handoff.filename} from Downloads.`
                    : `Bambu Studio launch is unavailable on this platform. Use Download AMS-ready 3MF instead.`;
            updateStatus(run, message);
            progress.finish({
                state: 'warning',
                stage: launchResult.attempted ? 'Bambu Studio did not open' : 'Desktop launch unavailable',
                detail: message,
                buttonText: launchResult.attempted ? 'Open Bambu Studio again' : 'Prepare again'
            });
            return false;
        } catch (error) {
            if (run.cancelled || error?.code === 'BAMBU_SEND_CANCELLED') {
                return false;
            }

            console.error('Opening Bambu Studio failed:', error);
            pendingHandoff = handoff;
            const message = isDownloadedHandoff
                ? `Bambu Studio could not be opened. Click Open again, then import ${handoff.filename} from Downloads.`
                : `Bambu Studio could not be opened. Click Open again, or use Download AMS-ready 3MF instead.`;
            updateStatus(run, message);
            progress.finish({
                state: 'warning',
                stage: 'Could not open Bambu Studio',
                detail: message,
                buttonText: 'Open Bambu Studio again'
            });
            return false;
        } finally {
            if (activeRun === run) activeRun = null;
            if (run.cancelled) {
                progress.cancel();
                clearOwnedStatus();
            }
        }
    }

    function openPreparedHandoff() {
        if (activeRun !== null || pendingHandoff === null) return Promise.resolve(false);

        const handoff = pendingHandoff;
        if (handoff.mode === 'direct' && handoff.expiresAt !== null && Date.now() >= handoff.expiresAt) {
            pendingHandoff = null;
            const message = `${handoff.filename} transfer expired. Prepare a fresh 10-minute transfer before opening Bambu Studio.`;
            setOwnedStatus(message);
            progress.finish({
                state: 'warning',
                stage: 'Transfer expired',
                detail: message,
                buttonText: 'Prepare again'
            });
            return Promise.resolve(false);
        }

        if (!hasTrustedUserActivation()) {
            const message = 'Click Open Bambu Studio directly so the browser can authorize the desktop app.';
            setOwnedStatus(message);
            progress.finish({
                state: 'ready',
                stage: 'Direct click required',
                detail: message,
                buttonText: 'Open Bambu Studio'
            });
            return Promise.resolve(false);
        }

        pendingHandoff = null;
        const run = {
            phase: 'open',
            cancelled: false,
            controller: new AbortController()
        };
        activeRun = run;
        if (!progress.begin({
            stage: 'Opening Bambu Studio',
            value: 100,
            detail: 'Handing the prepared project to the desktop app…',
            buttonText: 'Opening Bambu Studio…'
        })) {
            activeRun = null;
            pendingHandoff = handoff;
            return Promise.resolve(false);
        }

        updateStatus(run, handoff.mode === 'downloaded'
            ? `Opening Bambu Studio. Import ${handoff.filename} from Downloads…`
            : `Opening ${handoff.filename} in Bambu Studio…`);

        // Do not await, yield, or schedule work before this call. The custom
        // protocol dispatch inside launchBambuStudio must stay in this trusted
        // click's synchronous call stack so Chrome preserves user activation.
        const launchPromise = launchBambuStudio(
            handoff.mode === 'direct' ? handoff.transferUrl : ''
        );
        return settlePreparedHandoff(run, handoff, launchPromise);
    }

    function send(defaultThickness) {
        if (activeRun !== null) return Promise.resolve(false);
        if (pendingHandoff !== null) return openPreparedHandoff();
        return prepareHandoff(defaultThickness);
    }

    function reset() {
        if (activeRun !== null) {
            progress.update({
                stage: 'Cancelling previous send',
                detail: 'The model changed, so the previous transfer is being stopped…',
                buttonText: 'Cancelling…'
            });
            activeRun.cancelled = true;
            activeRun.controller.abort();
            clearOwnedStatus();
            return false;
        }
        pendingHandoff = null;
        const didReset = progress.reset();
        if (didReset) clearOwnedStatus();
        return didReset;
    }

    return {
        send,
        isBusy: () => activeRun !== null,
        reset
    };
}
