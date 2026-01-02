#!/usr/bin/env bun

import { createCanvas } from "canvas";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Create a 200x200 canvas
const canvas = createCanvas(200, 200);
const ctx = canvas.getContext("2d");

// Fill background with white
ctx.fillStyle = "white";
ctx.fillRect(0, 0, 200, 200);

// Draw a red circle in the center
ctx.fillStyle = "red";
ctx.beginPath();
ctx.arc(100, 100, 50, 0, Math.PI * 2);
ctx.fill();

// Save the image
const buffer = canvas.toBuffer("image/png");
const outputPath = join(__dirname, "..", "test", "data", "red-circle.png");

// Ensure the directory exists
await Bun.write(join(__dirname, "..", "test", "data", ".keep"), "");

await Bun.write(outputPath, buffer);
console.log(`Generated test image at: ${outputPath}`);
