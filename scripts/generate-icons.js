#!/usr/bin/env node
// Generates PWA icons from octis-logo.svg
// Run from octis/ directory: node scripts/generate-icons.js

const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

const svgPath = path.join(__dirname, '../public/octis-logo.svg');
const outDir = path.join(__dirname, '../public/icons');

const svgBuffer = fs.readFileSync(svgPath);

// Add a background + padding for the maskable version
// Maskable safe zone = inner 80% circle — put octopus at 60% of canvas
function makeMaskableSvg(size) {
  const bg = '#1e1b4b'; // deep indigo, matches Octis dark theme
  const padding = Math.round(size * 0.12); // 12% padding on each side
  const innerSize = size - padding * 2;
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" fill="${bg}" rx="${size * 0.18}"/>
  <image href="data:image/svg+xml;base64,${svgBuffer.toString('base64')}" x="${padding}" y="${padding}" width="${innerSize}" height="${innerSize}"/>
</svg>`);
}

async function generate() {
  // 512x512 — standard large icon
  await sharp(svgBuffer)
    .resize(512, 512)
    .flatten({ background: '#1e1b4b' })
    .png()
    .toFile(path.join(outDir, 'icon-512.png'));
  console.log('✅ icon-512.png');

  // 192x192 — standard small icon
  await sharp(svgBuffer)
    .resize(192, 192)
    .flatten({ background: '#1e1b4b' })
    .png()
    .toFile(path.join(outDir, 'icon-192.png'));
  console.log('✅ icon-192.png');

  // 192x192 maskable — with safe-zone padding + rounded bg
  const maskableSvg = makeMaskableSvg(192);
  await sharp(maskableSvg)
    .resize(192, 192)
    .png()
    .toFile(path.join(outDir, 'icon-maskable-192.png'));
  console.log('✅ icon-maskable-192.png');

  // Apple touch icon (180x180) — place in public root for <link rel="apple-touch-icon">
  await sharp(svgBuffer)
    .resize(180, 180)
    .flatten({ background: '#1e1b4b' })
    .png()
    .toFile(path.join(__dirname, '../public/apple-touch-icon.png'));
  console.log('✅ apple-touch-icon.png (180x180)');

  console.log('\nAll icons generated.');
}

generate().catch(err => { console.error(err); process.exit(1); });
