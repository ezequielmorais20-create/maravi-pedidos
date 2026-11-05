import { cp, copyFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceDir = join(projectRoot, 'static-site', 'src');
const outputDir = join(projectRoot, 'static-site', 'dist');
const publicDir = join(projectRoot, 'web', 'public');

await rm(outputDir, { recursive: true, force: true });
await mkdir(join(outputDir, 'assets'), { recursive: true });

for (const name of ['index.html', 'styles.css', 'app.js', 'catalog.json']) {
  await copyFile(join(sourceDir, name), join(outputDir, name));
}

await copyFile(join(publicDir, 'logo-original.png'), join(outputDir, 'assets', 'logo-original.png'));
await cp(join(sourceDir, 'products'), join(outputDir, 'products'), { recursive: true });
await copyFile(join(publicDir, 'products', 'CREDITS.md'), join(outputDir, 'CREDITS.md'));

const catalog = JSON.parse(await readFile(join(sourceDir, 'catalog.json'), 'utf8'));
const products = catalog.products;
const imageFiles = await readdir(join(outputDir, 'products'));
const missingImages = products.filter((product) => product.image && !imageFiles.includes(product.image.split('/').at(-1)));
if (missingImages.length) {
  throw new Error(`Imagens ausentes: ${missingImages.map((product) => product.name).join(', ')}`);
}

const outputStat = await stat(outputDir);
console.log(`Static catalog built: ${products.length} products, ${imageFiles.filter((name) => name.endsWith('.webp')).length} WebP images.`);
console.log(`Published directory: ${outputDir} (${outputStat.isDirectory() ? 'ready' : 'invalid'})`);
