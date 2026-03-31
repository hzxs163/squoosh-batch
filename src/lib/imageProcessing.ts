// DESIGN NOTES (Industrial Tool / "Squoosh Batch")
// Browser-first implementation using jSquash (codecs derived from Squoosh).
// - Runs fully locally (no upload)
// - Uses Web Workers + OffscreenCanvas to avoid blocking UI

export type OutputFormat = "webp" | "avif" | "jpeg" | "png";

export type ResizeSettings = {
  enabled: boolean;
  keepAspect: boolean;
  width?: number;
  height?: number;
};

export type BatchParams = {
  format: OutputFormat;
  quality: number; // 0-100
  // advanced (optional)
  webpMethod?: number; // kept for compatibility; jsquash ignores if unsupported
  avifCqLevel?: number; // 0-63 (lower is better)
  pngEffort?: number; // 0-6
  resize: ResizeSettings;
};

export type ProcessedImage = {
  outputBlob: Blob;
  outputUrl: string;
  outputSize: number;
  outputExt: string;
  outWidth: number;
  outHeight: number;
};

export type ImageMeta = {
  inWidth: number;
  inHeight: number;
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

type Pending = {
  resolve: (v: { processed: ProcessedImage; meta: ImageMeta }) => void;
  reject: (e: any) => void;
};

class SquooshWorkerPool {
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private queue: Array<{ req: WorkerReq; pending: Pending }> = [];
  private pendingByWorker = new Map<Worker, Pending>();
  private size: number;

  constructor(size: number) {
    this.size = size;
    for (let i = 0; i < size; i++) {  
      const w = new Worker(new URL("../workers/squooshWorker.ts", import.meta.url), {
        type: "module",
      });
      w.onmessage = (ev) => {
        const res = ev.data as WorkerRes;
        const pending = this.pendingByWorker.get(w);
        this.pendingByWorker.delete(w);
        this.idle.push(w);
        this.pump();

        if (!pending) return;
        if (!res.ok) {
          pending.reject(new Error(res.error || "处理失败"));
          return;
        }

        const blob = new Blob([res.outBuffer], { type: res.outMime });
        const url = URL.createObjectURL(blob);
        pending.resolve({
          processed: {
            outputBlob: blob,
            outputUrl: url,
            outputSize: blob.size,
            outputExt: res.outExt,
            outWidth: res.outWidth,
            outHeight: res.outHeight,
          },
          meta: { inWidth: res.inWidth, inHeight: res.inHeight },
        });
      };
      w.onerror = (err) => {
        const pending = this.pendingByWorker.get(w);
        this.pendingByWorker.delete(w);
        this.idle.push(w);
        this.pump();
        pending?.reject(err);
      };

      this.workers.push(w);
      this.idle.push(w);
    }
  }

  async close() {
    for (const w of this.workers) w.terminate();
    this.workers = [];
    this.idle = [];
    this.queue = [];
    this.pendingByWorker.clear();
  }

  process(fileBuffer: ArrayBuffer, mime: string, params: BatchParams) {
    return new Promise<{ processed: ProcessedImage; meta: ImageMeta }>((resolve, reject) => {
      this.queue.push({ req: { kind: "process", fileBuffer, mime, params }, pending: { resolve, reject } });
      this.pump();
    });
  }

  private pump() {
    while (this.idle.length && this.queue.length) {
      const w = this.idle.pop()!;
      const job = this.queue.shift()!;
      this.pendingByWorker.set(w, job.pending);
      // Transfer ArrayBuffer for speed
      w.postMessage(job.req, [job.req.fileBuffer]);
    }
  }
}

let pool: SquooshWorkerPool | null = null;

export function getWorkerPool() {
  if (pool) return pool;
  const threads = Math.max(1, Math.min(8, (navigator as any).hardwareConcurrency || 4));
  pool = new SquooshWorkerPool(threads);
  return pool;
}

export async function closeWorkerPool() {
  if (!pool) return;
  const p = pool;
  pool = null;
  await p.close();
}

export async function processWithSquoosh(
  fileBuffer: ArrayBuffer,
  params: BatchParams,
  mime = "image/*",
): Promise<{ processed: ProcessedImage; meta: ImageMeta }> {
  const p = getWorkerPool();
  return p.process(fileBuffer, mime, params);
}
