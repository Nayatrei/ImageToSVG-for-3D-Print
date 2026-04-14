/**
 * Bambu Studio integration using official OS file association.
 *
 * BambuStudio registers itself as the default handler for .3mf files.
 * Chrome's downloads.open() triggers the OS file association, which
 * launches BambuStudio automatically — no native messaging bridge needed.
 */

export function canOpenDownloadedFiles() {
    return typeof chrome !== 'undefined'
        && Boolean(chrome.downloads?.download && chrome.downloads?.open);
}
