// Worker: decode -> optional resize -> encode
// Uses OffscreenCanvas to stay off main thread.

import { encode as encodeWebp } from "@jsquash/webp";
import { encode as encodeAvif } from "@jsquash/avif";
import { encode as encodeJpeg } from "@jsquash/jpeg";
import { encode as encodePng } from "@jsquash/png";

type OutputFormat = "webp" | "avif" | "jpeg" | "png";

type ResizeSettings = {
  enabled: boolean;
  keepAspect: boolean;
  width?: number;
  height?: number;
};

type BatchParams = {
  format: OutputFormat;
  quality: number;
  webpMethod?: number;
  avifCqLevel?: number;
  pngEffort?: number;
  resize: ResizeSettings;
};

type WorkerReq = {
  kind: "process";
  fileBuffer: ArrayBuffer;
  mime: string;
  params: BatchParams;
};

type WorkerRes =
  | {
      ok: true;
      outBuffer: ArrayBuffer;
      outExt: string;
      outMime: string;
      inWidth: number;
      inHeight: number;
      outWidth: number;
      outHeight: number;
    }
  | { ok: false; error: string };

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function qualityToAvifCq(quality: number) {
  const q = clamp(quality, 0, 100);
  return clamp(Math.round(63 - (q / 100) * 63), 0, 63);
}

function extAndMime(format: OutputFormat) {
  if (format === "webp") return { ext: ".webp", mime: "image/webp" };
  if (format === "avif") return { ext: ".avif", mime: "image/avif" };
  if (format === "jpeg") return { ext: ".jpg", mime: "image/jpeg" };
  return { ext: ".png", mime: "image/png" };
}

async function decodeToImageData(fileBuffer: ArrayBuffer, mime: string) {
  const blob = new Blob([fileBuffer], { type: mime || "application/octet-stream" });
  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("无法创建Canvas上下文");
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function computeResize(
  inW: number,
  inH: number,
  resize: ResizeSettings,
): { w: number; h: number } {
  if (!resize.enabled) return { w: inW, h: inH };
  const tw = resize.width && resize.width > 0 ? resize.width : undefined;
  const th = resize.height && resize.height > 0 ? resize.height : undefined;
  if (!tw && !th) return { w: inW, h: inH };

  // keepAspect: if only one side provided, keep aspect.
  if (resize.keepAspect) {
    if (tw && th) return { w: tw, h: th };
    if (tw) return { w: tw, h: Math.round((inH / inW) * tw) };
    return { w: Math.round((inW / inH) * (th as number)), h: th as number };
  }

  return { w: tw ?? inW, h: th ?? inH };
}

async function resizeImageData(src: ImageData, w: number, h: number): Promise<ImageData> {
  if (src.width === w && src.height === h) return src;

  const srcCanvas = new OffscreenCanvas(src.width, src.height);
  const sctx = srcCanvas.getContext("2d", { willReadFrequently: true });
  if (!sctx) throw new Error("无法创建Canvas上下文");
  sctx.putImageData(src, 0, 0);

  const dstCanvas = new OffscreenCanvas(w, h);
  const dctx = dstCanvas.getContext("2d", { willReadFrequently: true });
  if (!dctx) throw new Error("无法创建Canvas上下文");

  // Use bitmap for better scaling quality
  const bitmap = await createImageBitmap(srcCanvas);
  dctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close();

  return dctx.getImageData(0, 0, w, h);
}

async function encode(format: OutputFormat, img: ImageData, params: BatchParams): Promise<ArrayBuffer> {
  const q = clamp(params.quality, 0, 100);
  if (format === "webp") {
    // jsquash/webp options differ from squoosh; we keep minimal mapping
    return encodeWebp(img, { quality: q } as any);
  }
  if (format === "avif") {
    const cqLevel =
      typeof params.avifCqLevel === "number" ? clamp(params.avifCqLevel, 0, 63) : qualityToAvifCq(q);
    return encodeAvif(img, { cqLevel } as any);
  }
  if (format === "jpeg") {
    return encodeJpeg(img, { quality: q } as any);
  }
  // png
  const effort = typeof params.pngEffort === "number" ? clamp(params.pngEffort, 0, 6) : 3;
  return encodePng(img, { effort } as any);
}

self.onmessage = async (ev: MessageEvent<WorkerReq>) => {
  const req = ev.data;
  if (!req || req.kind !== "process") return;

  try {
    const inData = await decodeToImageData(req.fileBuffer, req.mime);
    const inWidth = inData.width;
    const inHeight = inData.height;

    const { w, h } = computeResize(inWidth, inHeight, req.params.resize);
    const resized = await resizeImageData(inData, w, h);

    const outBuffer = await encode(req.params.format, resized, req.params);
    const { ext, mime } = extAndMime(req.params.format);

    const res: WorkerRes = {
      ok: true,
      outBuffer,
      outExt: ext,
      outMime: mime,
      inWidth,
      inHeight,
      outWidth: resized.width,
      outHeight: resized.height,
    };

    // Transfer buffer back
    (self as any).postMessage(res, [outBuffer]);
  } catch (e: any) {
    const res: WorkerRes = { ok: false, error: e?.message ? String(e.message) : "处理失败" };
    (self as any).postMessage(res);
  }
};
