import { spawn } from "child_process";
import { existsSync } from "fs";
import { extname } from "path";

export const IMAGE_COMPRESS_DEFAULT_MAX_SIZE = 1280;
export const IMAGE_COMPRESS_DEFAULT_QUALITY = 95;
export const IMAGE_COMPRESS_DEFAULT_OPTIMIZE = true;
export const IMAGE_COMPRESS_DEFAULT_MIN_FILE_SIZE_MB = 1.0;

async function runFfmpeg(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    proc.on("error", (err) => {
      reject(new Error(`ffmpeg is not available: ${err.message}`));
    });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stderr);
      } else {
        reject(new Error(`ffmpeg exited with code ${code}: ${stderr}`));
      }
    });
  });
}

async function runFfprobe(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffprobe", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (data: Buffer) => { stdout += data.toString(); });
    proc.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });
    proc.on("error", (err) => {
      reject(new Error(`ffprobe is not available: ${err.message}`));
    });
    proc.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`ffprobe exited with code ${code}: ${stderr}`));
      }
    });
  });
}

export async function getMediaDuration(filePath: string): Promise<number | null> {
  try {
    const output = await runFfprobe([
      "-v", "quiet",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      filePath,
    ]);
    const duration = parseFloat(output.trim());
    return isNaN(duration) ? null : duration;
  } catch {
    return null;
  }
}

export async function convertAudioToWav(audioPath: string, outputPath?: string): Promise<string> {
  const out = outputPath ?? audioPath.replace(/\.[^.]+$/, ".wav");
  await runFfmpeg(["-y", "-i", audioPath, "-ar", "16000", "-ac", "1", "-f", "wav", out]);
  return out;
}

export async function convertAudioToOpus(audioPath: string, outputPath?: string): Promise<string> {
  const out = outputPath ?? audioPath.replace(/\.[^.]+$/, ".opus");
  await runFfmpeg(["-y", "-i", audioPath, "-c:a", "libopus", "-b:a", "64000", out]);
  return out;
}

export async function convertAudioFormat(audioPath: string, outputFormat: string, outputPath?: string): Promise<string> {
  const out = outputPath ?? audioPath.replace(/\.[^.]+$/, `.${outputFormat}`);
  await runFfmpeg(["-y", "-i", audioPath, out]);
  return out;
}

export async function convertVideoFormat(videoPath: string, outputFormat: string, outputPath?: string): Promise<string> {
  const out = outputPath ?? videoPath.replace(/\.[^.]+$/, `.${outputFormat}`);
  await runFfmpeg(["-y", "-i", videoPath, out]);
  return out;
}

export async function ensureWav(audioPath: string, outputPath?: string): Promise<string> {
  const ext = extname(audioPath).toLowerCase();
  if (ext === ".wav") return audioPath;
  return convertAudioToWav(audioPath, outputPath);
}

export async function extractVideoCover(videoPath: string, outputPath?: string): Promise<string> {
  const out = outputPath ?? videoPath.replace(/\.[^.]+$/, "_cover.jpg");
  await runFfmpeg(["-y", "-i", videoPath, "-vframes", "1", "-q:v", "2", out]);
  return out;
}

export async function compressImage(
  urlOrPath: string,
  maxSize: number = IMAGE_COMPRESS_DEFAULT_MAX_SIZE,
  quality: number = IMAGE_COMPRESS_DEFAULT_QUALITY,
): Promise<string> {
  try {
    const sharp = require("sharp");
    const inputPath = urlOrPath;
    if (!existsSync(inputPath)) return urlOrPath;

    const ext = extname(inputPath).toLowerCase();
    const outPath = inputPath.replace(/\.[^.]+$/, `_compressed${ext}`);

    let pipeline = sharp(inputPath).resize(maxSize, maxSize, { fit: "inside", withoutEnlargement: true });

    if (ext === ".jpg" || ext === ".jpeg") {
      pipeline = pipeline.jpeg({ quality });
    } else if (ext === ".png") {
      pipeline = pipeline.png({ quality });
    } else if (ext === ".webp") {
      pipeline = pipeline.webp({ quality });
    }

    await pipeline.toFile(outPath);
    return outPath;
  } catch {
    console.warn("[media] sharp is not available, returning original image path without compression");
    return urlOrPath;
  }
}
