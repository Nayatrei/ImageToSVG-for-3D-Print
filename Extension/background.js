chrome.runtime.onInstalled.addListener(() => {
    chrome.contextMenus.create({
        id: "convertToSVG",
        title: "Convert Image to SVG",
        contexts: ["image"]
    });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === "convertToSVG") {
        chrome.scripting.executeScript({
            target: { tabId: tab.id },
            func: convertImageToSVG,
            args: [info.srcUrl]
        });
    }
});

function convertImageToSVG(imageUrl) {
    fetch(imageUrl)
        .then(res => res.blob())
        .then(blob => {
            const reader = new FileReader();
            reader.onloadend = () => {
                const img = new Image();
                img.onload = () => {
                    const canvas = document.createElement("canvas");
                    canvas.width = img.width;
                    canvas.height = img.height;
                    const ctx = canvas.getContext("2d");
                    ctx.drawImage(img, 0, 0);
                    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                    const svgString = ImageTracer.imagedataToSVG(imageData, { ltres: 1, qtres: 1, numberofcolors: 16 });
                    const blob = new Blob([svgString], { type: "image/svg+xml" });
                    const url = URL.createObjectURL(blob);
                    chrome.runtime.sendMessage({ action: "downloadSVG", url: url, filename: "converted_image.svg" });
                };
                img.src = reader.result;
            };
            reader.readAsDataURL(blob);
        });
}

chrome.runtime.onMessage.addListener((message) => {
    if (message.action === "downloadSVG") {
        chrome.downloads.download({
            url: message.url,
            filename: message.filename,
            saveAs: true
        });
    }
});
