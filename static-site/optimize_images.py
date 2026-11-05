from pathlib import Path
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "web" / "public" / "products"
DESTINATION = ROOT / "static-site" / "src" / "products"
MAX_DIMENSION = 960
QUALITY = 78

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
        image.thumbnail((MAX_DIMENSION, MAX_DIMENSION), Image.Resampling.LANCZOS)
        options = {"format": "WEBP", "quality": QUALITY, "method": 6}
        if has_alpha:
            options["alpha_quality"] = 100
        image.save(DESTINATION / source_path.name, **options)
    optimized_bytes += (DESTINATION / source_path.name).stat().st_size
    count += 1

if count != 17:
    raise SystemExit(f"Expected 17 product photos, found {count}")

saved = original_bytes - optimized_bytes
percent = (saved / original_bytes * 100) if original_bytes else 0
print(f"Photos optimized: {count}")
print(f"Original total: {original_bytes:,} bytes")
print(f"Optimized total: {optimized_bytes:,} bytes")
print(f"Saved: {saved:,} bytes ({percent:.1f}%)")
print(f"Output: {DESTINATION}")
