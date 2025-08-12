"""
Extracts individual color layers (black, yellow, red) from the Superman shield image and
converts each layer into a separate SVG.  This script uses a simple K‑means
clustering to identify the dominant colours in the image, assigns the resulting
clusters to the expected logical layers (background/outline, yellow accents,
and red fill), and then uses OpenCV to locate the contours for each region.

Contours are written to SVG path commands using absolute coordinates.  Each
layer is given a solid fill colour corresponding to the cluster.  The output
SVGs share the original image dimensions and can be stacked in a 3D modelling
workflow (e.g. Tinkercad) to reproduce the multi‑colour emblem.

Run this script from the repository root.  It will output three files in
the current directory: `layer_black.svg`, `layer_yellow.svg`, and
`layer_red.svg`.
"""

import numpy as np
from PIL import Image
from sklearn.cluster import KMeans
import cv2
# Importing svgwrite is optional.  We avoid external dependencies by
# constructing the SVG strings manually.  If svgwrite is available, you
# may use it instead; however, this script does not require it.
import os

def extract_layers(image_path: str,
                   output_dir: str = '.',
                   n_clusters: int = 3,
                   morph_kernel_size: int = 3,
                   morph_iterations: int = 2,
                   min_contour_area: float = 50.0) -> None:
    """Load an image, cluster its colours and save each cluster as an SVG.

    Args:
        image_path: Path to the source PNG with transparency.
        output_dir: Directory where the resulting SVGs will be written.
        n_clusters: Number of colour clusters to identify (default 3 for
            black/outline, yellow, red).
        morph_kernel_size: Size of the structuring element used during
            morphological closing.  A small kernel fills tiny gaps without
            distorting the outline.
        morph_iterations: Number of iterations for the closing operation.
        min_contour_area: Contours with an area below this threshold are
            discarded as likely noise.
    """
    # Load the image and separate RGBA channels.
    img = Image.open(image_path).convert('RGBA')
    arr = np.array(img)
    h, w, _ = arr.shape
    # Mask non‑transparent pixels for clustering.
    alpha = arr[:, :, 3]
    mask = alpha > 0
    # Flatten RGB values of visible pixels for K‑means.
    rgb_pixels = arr[mask][:, :3].astype(np.float64)

    # Fit K‑means to segment the colours.
    kmeans = KMeans(n_clusters=n_clusters, random_state=42)
    labels = kmeans.fit_predict(rgb_pixels)
    centers = kmeans.cluster_centers_.astype(np.uint8)

    # Assign cluster id back to full image.  Transparent pixels remain -1.
    label_image = np.full((h, w), fill_value=-1, dtype=np.int32)
    visible_indices = np.argwhere(mask)
    for idx, (y, x) in enumerate(visible_indices):
        label_image[y, x] = labels[idx]

    # Determine which cluster corresponds to which logical colour.  We use
    # brightness (sum of RGB) to rank clusters: the brightest is yellow, the
    # darkest is black/outline, and the remaining is red.  Should the input
    # image use different hues, adjust this heuristic accordingly.
    brightness = centers.sum(axis=1)
    sorted_indices = np.argsort(brightness)  # ascending: dark → bright
    # Map cluster index → logical layer name and desired fill colour.
    layer_order = {
        'black': sorted_indices[0],  # darkest cluster
        'red': sorted_indices[1],    # mid brightness cluster
        'yellow': sorted_indices[2]  # brightest cluster
    }
    # Ensure output directory exists.
    os.makedirs(output_dir, exist_ok=True)

    # Prepare morphological kernel for closing operation.
    kernel = np.ones((morph_kernel_size, morph_kernel_size), np.uint8)

    for colour_name, cluster_idx in layer_order.items():
        # Build binary mask for the current cluster.
        cluster_mask = (label_image == cluster_idx).astype(np.uint8) * 255
        # Fill tiny gaps within the shape to get continuous outlines.
        if morph_iterations > 0 and morph_kernel_size > 0:
            cluster_mask = cv2.morphologyEx(
                cluster_mask,
                cv2.MORPH_CLOSE,
                kernel,
                iterations=morph_iterations
            )
        # Find contours for external boundaries only (ignore holes).  The
        # hierarchy output is ignored because we only need top‑level contours.
        contours, _ = cv2.findContours(
            cluster_mask,
            cv2.RETR_EXTERNAL,
            cv2.CHAIN_APPROX_SIMPLE
        )
        # Convert contours into SVG path commands.  Discard tiny contours.
        svg_paths = []
        for cnt in contours:
            area = cv2.contourArea(cnt)
            if area < min_contour_area:
                continue
            # Flatten the contour array and build commands.
            pts = cnt.squeeze()
            if pts.ndim != 2 or len(pts) == 0:
                continue
            # Start path at first point.
            d_commands = [f"M {pts[0][0]} {pts[0][1]}"]
            for x, y in pts[1:]:
                d_commands.append(f"L {x} {y}")
            d_commands.append('Z')
            svg_paths.append(' '.join(d_commands))
        if not svg_paths:
            continue
        # Determine fill colour.  Override the raw cluster colour with a
        # canonical palette for the Superman logo to ensure crisp, high
        # contrast layers.  If the colour name is unrecognised, fall back
        # to the cluster centre.
        if colour_name == 'black':
            fill_hex = '#000000'
        elif colour_name == 'red':
            fill_hex = '#c80000'
        elif colour_name == 'yellow':
            fill_hex = '#fbe900'
        else:
            centre_colour = centers[cluster_idx]
            fill_hex = '#{:02x}{:02x}{:02x}'.format(*centre_colour)
        # Prepare filename for the current colour layer.
        filename = os.path.join(output_dir, f"layer_{colour_name}.svg")
        # Manually assemble the SVG document to avoid requiring svgwrite.  We
        # include width and height attributes for convenience but rely on
        # viewBox to ensure coordinate mapping is preserved in import.  Each
        # contour is represented as a separate <path> with the computed fill
        # colour.  No stroke is applied.
        with open(filename, 'w', encoding='utf-8') as svgfile:
            svgfile.write(
                f'<svg xmlns="http://www.w3.org/2000/svg" '
                f'width="{w}" height="{h}" viewBox="0 0 {w} {h}">\n'
            )
            for path_cmd in svg_paths:
                svgfile.write(f'  <path d="{path_cmd}" fill="{fill_hex}"/>\n')
            svgfile.write('</svg>\n')
        print(f"Saved {filename} with {len(svg_paths)} path(s) and colour {fill_hex}.")


if __name__ == '__main__':
    import argparse
    parser = argparse.ArgumentParser(description='Extract layered SVGs from an image.')
    parser.add_argument('image', help='Input PNG image with transparency.')
    parser.add_argument('--outdir', default='.', help='Directory to save SVG layers.')
    parser.add_argument('--clusters', type=int, default=3, help='Number of colour clusters (default 3).')
    args = parser.parse_args()
    extract_layers(args.image, output_dir=args.outdir, n_clusters=args.clusters)