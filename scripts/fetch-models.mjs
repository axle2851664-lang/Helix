#!/usr/bin/env node
/**
 * Fetch the local assets Helix needs for on-device hand tracking.
 *
 * Two things are installed into `public/`:
 *
 *   models/hand_landmarker.task   the MediaPipe hand model (~7.5 MB)
 *   mediapipe/wasm/*              the MediaPipe vision WASM runtime
 *
 * Both are served from Helix's own origin rather than a CDN. That is required
 * by the application's content security policy, which permits no external
 * origins, and it is what keeps camera frames on the machine.
 *
 * Neither is committed to the repository - model weights do not belong in git.
 * Run this once after cloning, or whenever public/ has been cleaned.
 *
 * The model is published by Google under the Apache 2.0 licence.
 */

import { createWriteStream } from 'node:fs';
import { mkdir, cp, access, stat } from 'node:fs/promises';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';
const MODEL_DEST = join(root, 'public', 'models', 'hand_landmarker.task');
const WASM_SRC = join(root, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
const WASM_DEST = join(root, 'public', 'mediapipe', 'wasm');

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function humanBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

async function fetchModel() {
  if (await exists(MODEL_DEST)) {
    const info = await stat(MODEL_DEST);
    console.log(`Model already present (${humanBytes(info.size)}). Skipping.`);
    return;
  }

  console.log('Downloading hand landmark model...');
  const response = await fetch(MODEL_URL);
  if (!response.ok || !response.body) {
    throw new Error(`Model download failed: HTTP ${response.status}`);
  }

  await mkdir(dirname(MODEL_DEST), { recursive: true });
  await pipeline(Readable.fromWeb(response.body), createWriteStream(MODEL_DEST));

  const info = await stat(MODEL_DEST);
  console.log(`Model installed: ${MODEL_DEST} (${humanBytes(info.size)})`);
}

async function copyWasm() {
  if (!(await exists(WASM_SRC))) {
    throw new Error(
      'MediaPipe WASM not found in node_modules. Run "npm install" before this script.',
    );
  }
  await mkdir(WASM_DEST, { recursive: true });
  await cp(WASM_SRC, WASM_DEST, { recursive: true });
  console.log(`WASM runtime installed: ${WASM_DEST}`);
}


/**
 * Whisper weights for on-device speech recognition.
 *
 * transformers.js expects a HuggingFace-style layout under localModelPath, so
 * the files keep their original names and folder shape.
 */
const WHISPER_REPO = 'Xenova/whisper-tiny.en';
const WHISPER_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'preprocessor_config.json',
  'generation_config.json',
  'onnx/encoder_model_quantized.onnx',
  'onnx/decoder_model_merged_quantized.onnx',
];

async function fetchWhisper() {
  const base = join(root, 'public', 'models', WHISPER_REPO);
  let downloaded = 0;

  for (const file of WHISPER_FILES) {
    const dest = join(base, ...file.split('/'));
    if (await exists(dest)) continue;

    const url = `https://huggingface.co/${WHISPER_REPO}/resolve/main/${file}`;
    const response = await fetch(url);
    if (!response.ok || !response.body) {
      throw new Error(`Whisper file failed: ${file} (HTTP ${response.status})`);
    }

    await mkdir(dirname(dest), { recursive: true });
    await pipeline(Readable.fromWeb(response.body), createWriteStream(dest));
    const info = await stat(dest);
    console.log(`  ${file} (${humanBytes(info.size)})`);
    downloaded += 1;
  }

  console.log(
    downloaded === 0
      ? 'Speech model already present. Skipping.'
      : `Speech model installed: ${base}`,
  );
}

try {
  await copyWasm();
  await fetchModel();
  console.log('\nDownloading speech model...');
  await fetchWhisper();
  console.log('\nAll assets ready. Served locally - nothing calls out at runtime.');
} catch (error) {
  console.error(`\nCould not install local model assets: ${error.message}`);
  console.error('Hand tracking and speech will report themselves unavailable until this succeeds.');
  process.exitCode = 1;
}
