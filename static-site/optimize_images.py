from pathlib import Path
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "web" / "public" / "products"
DESTINATION = ROOT / "static-site" / "src" / "products"
CANVAS_SIZE = 960
QUALITY = 78
BACKGROUND = (255, 248, 250)

DESTINATION.mkdir(parents=True, exist_ok=True)
original_bytes = 0
optimized_bytes = 0
count = 0

for source_path in sorted(SOURCE.glob("MAR-*.webp")):
    original_bytes += source_path.stat().st_size
    with Image.open(source_path) as original:
        image = ImageOps.exif_transpose(original)
        has_alpha = "A" in image.getbands() or "transparency" in image.info
        image = image.convert("RGBA" if has_alpha else "RGB")
        image = ImageOps.contain(
            image,
            (CANVAS_SIZE, CANVAS_SIZE),
            method=Image.Resampling.LANCZOS,
        )

        x = (CANVAS_SIZE - image.width) // 2
        y = (CANVAS_SIZE - image.height) // 2
        if has_alpha:
            canvas = Image.new("RGBA", (CANVAS_SIZE, CANVAS_SIZE), (0, 0, 0, 0))
            canvas.paste(image, (x, y), image)
            options = {
                "format": "WEBP",
                "quality": QUALITY,
                "method": 6,
                "alpha_quality": 100,
            }
        else:
            canvas = Image.new("RGB", (CANVAS_SIZE, CANVAS_SIZE), BACKGROUND)
            canvas.paste(image, (x, y))
            options = {"format": "WEBP", "quality": QUALITY, "method": 6}

        destination_path = DESTINATION / source_path.name
        canvas.save(destination_path, **options)

    optimized_bytes += destination_path.stat().st_size
    count += 1

if count == 0:
    raise SystemExit(f"No product photos found in {SOURCE}")

saved = original_bytes - optimized_bytes
percent = (saved / original_bytes * 100) if original_bytes else 0
print(f"Photos standardized: {count} ({CANVAS_SIZE}x{CANVAS_SIZE}px each)")
print(f"Original total: {original_bytes:,} bytes")
print(f"Optimized total: {optimized_bytes:,} bytes")
print(f"Saved: {saved:,} bytes ({percent:.1f}%)")
print(f"Output: {DESTINATION}")
