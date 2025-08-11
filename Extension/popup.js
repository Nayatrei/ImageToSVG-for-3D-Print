document.getElementById("convertBtn").addEventListener("click", () => {
    const fileInput = document.getElementById("fileInput");
    if (fileInput.files.length === 0) {
        alert("Please select an image file.");
        return;
    }
    const file = fileInput.files[0];
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
            const a = document.createElement("a");
            a.href = url;
            a.download = "converted_image.svg";
            a.click();
        };
        img.src = reader.result;
    };
    reader.readAsDataURL(file);
});
