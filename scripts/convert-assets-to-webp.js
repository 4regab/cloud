import { readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const root = path.resolve("public", "assets");
const skipDirs = new Set(["favicons"]);

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) {
        files.push(...(await walk(fullPath)));
      }
      continue;
    }

    if (entry.isFile() && entry.name.toLowerCase().endsWith(".png")) {
      files.push(fullPath);
    }
  }

  return files;
}

const files = await walk(root);
let originalBytes = 0;
let webpBytes = 0;

for (const file of files) {
  const output = file.replace(/\.png$/i, ".webp");
  const before = await stat(file);
  await sharp(file).webp({ quality: 82, effort: 6 }).toFile(output);
  const after = await stat(output);
  await unlink(file);

  originalBytes += before.size;
  webpBytes += after.size;
  console.log(`${path.relative(process.cwd(), file)} -> ${path.relative(process.cwd(), output)} (${before.size} -> ${after.size})`);
}

console.log(`Converted ${files.length} PNG files to WebP.`);
console.log(`Saved ${originalBytes - webpBytes} bytes (${originalBytes} -> ${webpBytes}).`);
