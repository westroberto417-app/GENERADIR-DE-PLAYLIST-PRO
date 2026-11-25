import { addActivityLog, db, getSettings, sessionFileRegistry } from '../db/database';
import type { AnalysisMode, RmsThresholds, TrackRecord } from '../types/studio';
import { analyzeDspPcm, type DspAnalyzeRequest, type DspAnalyzeResponse } from '../workers/dspCore';
import { healFalseInaccessibleTracks, verifyAndRelinkFolder } from './fileAccessService';

export interface AnalysisBatchProgress {
  status: 'idle' | 'running' | 'paused' | 'completed' | 'cancelled';
  mode: AnalysisMode;
  isBackground: boolean;
  total: number;
  completed: number;
  succeeded: number;
  failed: number;
  skippedUnchanged: number;
  needsRelinkCount?: number;
  currentTrackTitle: string;
  tracksPerSec?: number;
  activeWorkers?: number;
  lastError?: string;
}

/**
 * Clean extension point for local ML classifiers (e.g. ONNX Web / Windows x64 Librosa + Essentia bridge).
 */
export interface ILocalMLClassifier {
  readonly id: string;
  isAvailable(): Promise<boolean>;
}

export function getMaxDspConcurrency(): number {
  if (typeof navigator === 'undefined') return 4;
  return Math.min(8, Math.max(2, navigator.hardwareConcurrency || 4));
}

export function trackNeedsAudioDecode(track: TrackRecord, mode: AnalysisMode): boolean {
  if (mode === 'full-dsp') return true;
  const hasTagOrManualBpm =
    (track.origins.bpm === 'MANUAL' || track.origins.bpm === 'ETIQUETA') &&
    Boolean(track.bpm);
  return !hasTagOrManualBpm;
}

export async function rehydrateMissingTrackFiles(tracks: TrackRecord[]): Promise<void> {
  try {
    await healFalseInaccessibleTracks();
  } catch {
    // ignore healing errors
  }

  const missingFolderIds = new Set<string>();
  for (const t of tracks) {
    if (!sessionFileRegistry.has(t.id)) {
      missingFolderIds.add(t.folderId);
    }
  }
  if (missingFolderIds.size === 0) return;

  for (const folderId of missingFolderIds) {
    try {
      const handleRec = await db.folderHandles.get(folderId);
      if (handleRec?.handle) {
        await verifyAndRelinkFolder(folderId);
      }
    } catch {
      // Ignore permission errors here; handled by missing-file check below
    }
  }
}

/**
 * Finds the start offset of the first valid MPEG audio frame after ID3v2 tags or leading junk.
 * Helps Chromium decodeAudioData recover MP3s with malformed ID3v2 headers.
 */
function findMp3AudioStartOffset(bytes: Uint8Array): number {
  if (bytes.length < 16) return 0;

  let startSearch = 0;
  // Parse ID3v2 header: "ID3" + 2-byte version + 1-byte flags + 4-byte synchsafe size
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    const tagSize =
      ((bytes[6] & 0x7f) << 21) |
      ((bytes[7] & 0x7f) << 14) |
      ((bytes[8] & 0x7f) << 7) |
      (bytes[9] & 0x7f);
    const hasFooter = (bytes[5] & 0x10) !== 0 ? 10 : 0;
    const candidateOffset = 10 + tagSize + hasFooter;
    if (candidateOffset > 10 && candidateOffset < bytes.length - 4) {
      startSearch = candidateOffset;
    }
  }

  const maxScan = Math.min(bytes.length - 4, startSearch + 512 * 1024);
  for (let i = startSearch; i < maxScan; i++) {
    // Frame sync (11 bits set), non-reserved MPEG version, Layer III (01), non-free bitrate (!=0, !=15), valid SR (!=3)
    if (bytes[i] === 0xff && (bytes[i + 1] & 0xe0) === 0xe0) {
      const mpegVersion = (bytes[i + 1] >> 3) & 0x03;
      const layer = (bytes[i + 1] >> 1) & 0x03;
      const bitrateIdx = (bytes[i + 2] >> 4) & 0x0f;
      const srIdx = (bytes[i + 2] >> 2) & 0x03;
      if (mpegVersion !== 1 && layer !== 0 && bitrateIdx !== 0 && bitrateIdx !== 15 && srIdx !== 3) {
        return i;
      }
    }
  }
  return startSearch;
}

class AudioAnalyzerController {
  private workers: Array<Worker | null> = [];
  private workersDisabled = false;
  private decodeCtx: BaseAudioContext | null = null;
  private paused = false;
  private cancelled = false;
  private running = false;
  private resumeResolvers: Array<() => void> = [];

  // Semaphore to cap concurrent heavy decodeAudioData calls (prevents RAM/decoder crashes)
  private activeDecodes = 0;
  private decodeWaiters: Array<() => void> = [];

  // Live queue state so newly imported folders can append to an active background run
  private activeQueue: TrackRecord[] = [];
  private activeQueuedIds = new Set<string>();
  private activeProgress: AnalysisBatchProgress | null = null;

  public isRunning(): boolean {
    return this.running;
  }

  private getWorkerAt(slot: number): Worker | null {
    if (this.workersDisabled || typeof Worker === 'undefined') return null;
    try {
      while (this.workers.length <= slot) {
        const w = new Worker(new URL('../workers/dspWorker.ts', import.meta.url), {
          type: 'module',
        });
        this.workers.push(w);
      }
      return this.workers[slot];
    } catch {
      this.workersDisabled = true;
      return null;
    }
  }

  private disposeWorkerAt(slot: number) {
    const w = this.workers[slot];
    if (w) {
      try {
        w.terminate();
      } catch {
        // ignore
      }
      this.workers[slot] = null;
    }
  }

  /**
   * Prefer OfflineAudioContext for decodeAudioData:
   * - Does NOT require user activation / autoplay unlock
   * - Never suspends or deadlocks on `.resume()` in background scans or iframes
   */
  private getDecodeContext(): BaseAudioContext {
    if (this.decodeCtx && this.decodeCtx.state !== 'closed') {
      return this.decodeCtx;
    }
    const OfflineCtx =
      window.OfflineAudioContext ||
      (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext })
        .webkitOfflineAudioContext;

    if (OfflineCtx) {
      this.decodeCtx = new OfflineCtx(1, 1, 44100);
      return this.decodeCtx;
    }

    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.decodeCtx = new Ctx();
    return this.decodeCtx;
  }

  private async acquireDecodeSlot(maxParallel: number): Promise<void> {
    if (this.activeDecodes < maxParallel) {
      this.activeDecodes++;
      return;
    }
    await new Promise<void>((resolve) => {
      this.decodeWaiters.push(resolve);
    });
    this.activeDecodes++;
  }

  private releaseDecodeSlot(): void {
    this.activeDecodes = Math.max(0, this.activeDecodes - 1);
    const next = this.decodeWaiters.shift();
    if (next) next();
  }

  private decodeBufferOnce(
    ctx: BaseAudioContext,
    arrayBuffer: ArrayBuffer,
    timeoutMs: number
  ): Promise<AudioBuffer> {
    return new Promise<AudioBuffer>((resolve, reject) => {
      let settled = false;
      const timer = window.setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('Tiempo de espera agotado al decodificar el archivo de audio.'));
        }
      }, timeoutMs);

      try {
        // Note: pass a detached-safe copy; decodeAudioData detaches the buffer
        const resultPromise = ctx.decodeAudioData(
          arrayBuffer,
          (buf) => {
            if (!settled) {
              settled = true;
              window.clearTimeout(timer);
              resolve(buf);
            }
          },
          (err) => {
            if (!settled) {
              settled = true;
              window.clearTimeout(timer);
              reject(err instanceof Error ? err : new Error('No se pudo decodificar el audio.'));
            }
          }
        );
        if (resultPromise && typeof resultPromise.catch === 'function') {
          resultPromise.catch((err) => {
            if (!settled) {
              settled = true;
              window.clearTimeout(timer);
              reject(err instanceof Error ? err : new Error('No se pudo decodificar el audio.'));
            }
          });
        }
      } catch (err) {
        if (!settled) {
          settled = true;
          window.clearTimeout(timer);
          reject(err instanceof Error ? err : new Error('No se pudo iniciar la decodificación.'));
        }
      }
    });
  }

  private async decodeAudioWithTimeout(
    rawBuffer: ArrayBuffer,
    extension: string,
    timeoutMs = 20000
  ): Promise<AudioBuffer> {
    if (!rawBuffer || rawBuffer.byteLength === 0) {
      throw new Error('El archivo está vacío (0 bytes).');
    }

    const ctx = this.getDecodeContext();
    try {
      return await this.decodeBufferOnce(ctx, rawBuffer.slice(0), timeoutMs);
    } catch (firstErr) {
      // Recovery for MP3s with malformed/corrupt ID3v2 headers or leading padding
      const bytes = new Uint8Array(rawBuffer);
      const isMp3OrId3 =
        extension === '.mp3' ||
        (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33);

      if (isMp3OrId3) {
        const audioOffset = findMp3AudioStartOffset(bytes);
        if (audioOffset > 0 && audioOffset < bytes.length - 128) {
          return await this.decodeBufferOnce(ctx, rawBuffer.slice(audioOffset), timeoutMs);
        }
      }
      throw firstErr;
    }
  }

  public pause() {
    this.paused = true;
  }

  public resume() {
    this.paused = false;
    const resolvers = this.resumeResolvers.splice(0, this.resumeResolvers.length);
    for (const resolve of resolvers) resolve();
  }

  public cancel() {
    this.cancelled = true;
    this.paused = false;
    const resolvers = this.resumeResolvers.splice(0, this.resumeResolvers.length);
    for (const resolve of resolvers) resolve();
  }

  private async waitIfPaused(): Promise<void> {
    if (!this.paused) return;
    await new Promise<void>((resolve) => {
      this.resumeResolvers.push(resolve);
    });
  }

  private extractMonoAnalysisSlice(
    buffer: AudioBuffer,
    mode: AnalysisMode
  ): { pcmData: Float32Array; sampleRate: number } {
    const channels = buffer.numberOfChannels;
    const origLength = buffer.length;
    const origSr = buffer.sampleRate;

    // Fast mode only needs 28s @ 8000 Hz (kick/bass transients < 200Hz stay intact)
    const maxSeconds = mode === 'fast-metadata-bpm' ? 28 : 45;
    const targetSr = mode === 'fast-metadata-bpm' ? 8000 : 11025;

    const targetSamples = Math.floor(maxSeconds * origSr);
    const startSample = origLength > targetSamples * 1.35 ? Math.floor(origLength * 0.2) : 0;
    const availableLength = Math.max(0, origLength - startSample);
    const maxOrigSamples = Math.min(availableLength, targetSamples);

    const stride = Math.max(1, Math.round(origSr / targetSr));
    const effectiveSr = origSr / stride;
    const outLength = Math.floor(maxOrigSamples / stride);
    const mono = new Float32Array(outLength);

    if (outLength === 0 || channels === 0) {
      return { pcmData: mono, sampleRate: effectiveSr };
    }

    const ch0 = buffer.getChannelData(0);
    const ch1 = channels > 1 ? buffer.getChannelData(1) : null;

    if (ch1) {
      for (let i = 0, idx = startSample; i < outLength; i++, idx += stride) {
        mono[i] = (ch0[idx] + ch1[idx]) * 0.5;
      }
    } else {
      for (let i = 0, idx = startSample; i < outLength; i++, idx += stride) {
        mono[i] = ch0[idx];
      }
    }

    return { pcmData: mono, sampleRate: effectiveSr };
  }

  private async runMainThreadDspFallback(req: DspAnalyzeRequest): Promise<DspAnalyzeResponse> {
    await new Promise((resolve) => window.setTimeout(resolve, 0));
    return analyzeDspPcm(req);
  }

  private async runWorkerDsp(
    slot: number,
    req: DspAnalyzeRequest
  ): Promise<DspAnalyzeResponse> {
    const worker = this.getWorkerAt(slot);
    if (!worker) {
      return this.runMainThreadDspFallback(req);
    }

    // Keep an intact copy only when transferring so fallback is always lossless if worker fails
    const pcmCopy = req.pcmData.slice();
    const workerReq: DspAnalyzeRequest = { ...req, pcmData: pcmCopy };

    return new Promise((resolve) => {
      let settled = false;

      const cleanup = () => {
        window.clearTimeout(timer);
        worker.removeEventListener('message', onMessage);
        worker.removeEventListener('error', onError);
        worker.removeEventListener('messageerror', onError);
      };

      const fallback = () => {
        if (settled) return;
        settled = true;
        cleanup();
        this.disposeWorkerAt(slot);
        void this.runMainThreadDspFallback(req).then(resolve);
      };

      const onMessage = (ev: MessageEvent<DspAnalyzeResponse>) => {
        if (ev.data && ev.data.id === req.id && !settled) {
          settled = true;
          cleanup();
          resolve(ev.data);
        }
      };

      const onError = () => {
        fallback();
      };

      const timer = window.setTimeout(fallback, 15000);
      worker.addEventListener('message', onMessage);
      worker.addEventListener('error', onError);
      worker.addEventListener('messageerror', onError);

      try {
        worker.postMessage(workerReq, [pcmCopy.buffer]);
      } catch {
        fallback();
      }
    });
  }

  private async computeTrackRecord(
    track: TrackRecord,
    thresholds: RmsThresholds,
    workerSlot: number,
    mode: AnalysisMode,
    maxDecodeParallel: number
  ): Promise<{ record: TrackRecord; missingSessionFile: boolean }> {
    const preserveManualOrTagBpm =
      (track.origins.bpm === 'MANUAL' || track.origins.bpm === 'ETIQUETA') &&
      Boolean(track.bpm);

    // Zero-decode fast path: in Metadata + Genre + BPM mode, if BPM is already tagged, skip audio decoding completely
    if (mode === 'fast-metadata-bpm' && preserveManualOrTagBpm) {
      const now = Date.now();
      return {
        missingSessionFile: false,
        record: {
          ...track,
          accessible: true,
          bpmConfidence: track.bpmConfidence ?? 100,
          analysisStatus: 'analyzed',
          analysisError: undefined,
          analyzedAt: now,
          analyzedFileSignature: `${track.size}_${track.lastModified}`,
          updatedAt: now,
        },
      };
    }

    const file = sessionFileRegistry.get(track.id);
    if (!file) {
      // Do NOT corrupt accessible=false or overwrite with false error when browser dropped session handle
      return {
        missingSessionFile: true,
        record: track,
      };
    }

    try {
      await this.acquireDecodeSlot(maxDecodeParallel);
      let realDuration = track.duration;
      let decodedSr = track.sampleRate;
      let slice: { pcmData: Float32Array; sampleRate: number };

      try {
        const arrayBuffer = await file.arrayBuffer();
        const audioBuffer = await this.decodeAudioWithTimeout(
          arrayBuffer,
          track.extension,
          20000
        );
        realDuration = Number.isFinite(audioBuffer.duration) ? Math.round(audioBuffer.duration) : 0;
        decodedSr = Number.isFinite(audioBuffer.sampleRate) ? audioBuffer.sampleRate : null;
        slice = this.extractMonoAnalysisSlice(audioBuffer, mode);
      } finally {
        this.releaseDecodeSlot();
      }

      const dsp = await this.runWorkerDsp(workerSlot, {
        id: track.id,
        mode,
        sampleRate: slice.sampleRate,
        pcmData: slice.pcmData,
        thresholds,
        existingGenre: track.genre,
        existingYear: track.year,
      });

      if (!dsp.ok) {
        return {
          missingSessionFile: false,
          record: {
            ...track,
            duration: track.duration || realDuration,
            analysisStatus: 'error',
            analysisError: dsp.error || 'No fue posible analizar las muestras de audio.',
            updatedAt: Date.now(),
          },
        };
      }

      const now = Date.now();
      if (mode === 'fast-metadata-bpm') {
        return {
          missingSessionFile: false,
          record: {
            ...track,
            duration: track.duration || realDuration,
            sampleRate: track.sampleRate || decodedSr,
            bpm: preserveManualOrTagBpm ? track.bpm : dsp.bpm ?? null,
            bpmConfidence: preserveManualOrTagBpm ? 100 : dsp.bpmConfidence ?? null,
            origins: {
              ...track.origins,
              bpm: preserveManualOrTagBpm ? track.origins.bpm : 'ANÁLISIS PCM',
            },
            analysisStatus: 'analyzed',
            analysisError: undefined,
            analyzedAt: now,
            analyzedFileSignature: `${track.size}_${track.lastModified}`,
            accessible: true,
            updatedAt: now,
          },
        };
      }

      return {
        missingSessionFile: false,
        record: {
          ...track,
          duration: track.duration || realDuration,
          sampleRate: track.sampleRate || decodedSr,
          bpm: preserveManualOrTagBpm ? track.bpm : dsp.bpm ?? null,
          bpmConfidence: preserveManualOrTagBpm ? 100 : dsp.bpmConfidence ?? null,
          energyRmsDb: dsp.energyRmsDb ?? null,
          energyScore: dsp.energyScore ?? null,
          energyLevel: dsp.energyLevel ?? null,
          intensity: dsp.intensity ?? null,
          danceability: dsp.danceability ?? null,
          danceabilityLabel: dsp.danceabilityLabel ?? null,
          valence: dsp.valence ?? null,
          valenceLabel: dsp.valenceLabel ?? null,
          mood: track.origins.mood === 'MANUAL' ? track.mood : dsp.mood ?? 'Desconocido',
          origins: {
            ...track.origins,
            bpm: preserveManualOrTagBpm ? track.origins.bpm : 'ANÁLISIS PCM',
            energy: 'ANÁLISIS PCM',
            mood: track.origins.mood === 'MANUAL' ? 'MANUAL' : 'ANÁLISIS PCM',
          },
          analysisStatus: 'analyzed',
          analysisError: undefined,
          analyzedAt: now,
          analyzedFileSignature: `${track.size}_${track.lastModified}`,
          accessible: true,
          updatedAt: now,
        },
      };
    } catch (err) {
      const rawMsg = err instanceof Error ? err.message : '';
      const extHint =
        track.extension === '.wma'
          ? 'El formato .wma no es compatible con Web Audio del navegador.'
          : rawMsg || 'El navegador no pudo decodificar este códec/archivo de audio.';
      return {
        missingSessionFile: false,
        record: {
          ...track,
          analysisStatus: 'error',
          analysisError: `Fallo de decodificación: ${extHint}`,
          updatedAt: Date.now(),
        },
      };
    }
  }

  public async analyzeSingleTrack(
    track: TrackRecord,
    mode: AnalysisMode = 'fast-metadata-bpm'
  ): Promise<{ track: TrackRecord; missingSessionFile: boolean }> {
    await rehydrateMissingTrackFiles([track]);
    const settings = await getSettings();
    const { record, missingSessionFile } = await this.computeTrackRecord(
      track,
      settings.rmsThresholds,
      0,
      mode,
      1
    );
    if (!missingSessionFile) {
      await db.tracks.put(record);
    }
    return { track: record, missingSessionFile };
  }

  public enqueueTracks(tracks: TrackRecord[]): number {
    if (!this.running || !this.activeProgress) return 0;
    let added = 0;
    for (const t of tracks) {
      if (!t.isSpotFolder && !this.activeQueuedIds.has(t.id) && sessionFileRegistry.has(t.id)) {
        this.activeQueuedIds.add(t.id);
        this.activeQueue.push(t);
        this.activeProgress.total++;
        added++;
      }
    }
    return added;
  }

  public async runBatch(
    tracks: TrackRecord[],
    forceReanalyze: boolean,
    onProgress: (p: AnalysisBatchProgress) => void,
    options?: {
      concurrency?: number;
      mode?: AnalysisMode;
      isBackground?: boolean;
      onIntermediateRefresh?: () => void;
    }
  ): Promise<AnalysisBatchProgress> {
    this.paused = false;
    this.cancelled = false;
    this.running = true;

    const settings = await getSettings();
    const mode: AnalysisMode = options?.mode || settings.defaultAnalysisMode || 'fast-metadata-bpm';
    const isBackground = Boolean(options?.isBackground);
    const maxWorkers = Math.max(1, Math.min(12, options?.concurrency || getMaxDspConcurrency()));

    let progress: AnalysisBatchProgress = {
      status: 'running',
      mode,
      isBackground,
      total: tracks.length,
      completed: 0,
      succeeded: 0,
      failed: 0,
      skippedUnchanged: 0,
      needsRelinkCount: 0,
      currentTrackTitle: '',
      tracksPerSec: 0,
      activeWorkers: 1,
    };

    try {
      await rehydrateMissingTrackFiles(tracks);

      this.activeQueue = [];
      this.activeQueuedIds.clear();
      let skippedUnchanged = 0;
      let needsRelinkCount = 0;

      for (const track of tracks) {
        const sig = `${track.size}_${track.lastModified}`;
        const alreadyFullOrFast =
          !forceReanalyze &&
          track.analysisStatus === 'analyzed' &&
          track.analyzedFileSignature === sig &&
          (mode === 'fast-metadata-bpm' || track.energyRmsDb !== null);

        if (alreadyFullOrFast) {
          skippedUnchanged++;
        } else if (trackNeedsAudioDecode(track, mode) && !sessionFileRegistry.has(track.id)) {
          needsRelinkCount++;
        } else if (!this.activeQueuedIds.has(track.id)) {
          this.activeQueuedIds.add(track.id);
          this.activeQueue.push(track);
        }
      }

      const activeWorkers =
        this.activeQueue.length > 0 ? Math.min(maxWorkers, this.activeQueue.length) : 1;
      const maxDecodeParallel = Math.max(1, Math.min(3, activeWorkers));

      progress = {
        status: 'running',
        mode,
        isBackground,
        total: this.activeQueue.length + skippedUnchanged,
        completed: skippedUnchanged,
        succeeded: 0,
        failed: 0,
        skippedUnchanged,
        needsRelinkCount,
        currentTrackTitle: this.activeQueue[0]
          ? `${this.activeQueue[0].artist} — ${this.activeQueue[0].title}`
          : '',
        tracksPerSec: 0,
        activeWorkers,
      };
      this.activeProgress = progress;

      onProgress({ ...progress });

      if (this.activeQueue.length === 0) {
        progress.status = 'completed';
        progress.currentTrackTitle = '';
        onProgress({ ...progress });
        return progress;
      }

      const startedAt = performance.now();
      let cursor = 0;
      let lastReportAt = 0;
      let lastDbFlushAt = performance.now();
      let lastUiRefreshAt = performance.now();
      const pendingDbWrites: TrackRecord[] = [];
      let dbFlushChain = Promise.resolve();

      const flushDb = (force = false) => {
        if (pendingDbWrites.length === 0) return;
        const now = performance.now();
        if (!force && pendingDbWrites.length < 24 && now - lastDbFlushAt < 450) return;
        lastDbFlushAt = now;
        const chunk = pendingDbWrites.splice(0, pendingDbWrites.length);
        dbFlushChain = dbFlushChain.then(async () => {
          try {
            await db.tracks.bulkPut(chunk);
            const nowRefresh = performance.now();
            if (options?.onIntermediateRefresh && nowRefresh - lastUiRefreshAt >= 2500) {
              lastUiRefreshAt = nowRefresh;
              options.onIntermediateRefresh();
            }
          } catch (err) {
            console.error('Error guardando lote de análisis en IndexedDB:', err);
          }
        });
      };

      const reportProgress = (force = false) => {
        const now = performance.now();
        if (!force && now - lastReportAt < 120) return;
        lastReportAt = now;
        const elapsedSec = Math.max(0.05, (now - startedAt) / 1000);
        const processedNow = progress.succeeded + progress.failed;
        progress.tracksPerSec = Math.round((processedNow / elapsedSec) * 10) / 10;
        progress.status = this.paused ? 'paused' : this.cancelled ? 'cancelled' : 'running';
        onProgress({ ...progress });
      };

      const runSlot = async (slotIdx: number) => {
        while (true) {
          if (this.paused) {
            flushDb(true);
            reportProgress(true);
            await this.waitIfPaused();
          }
          if (this.cancelled) return;

          const idx = cursor++;
          if (idx >= this.activeQueue.length) return;
          const track = this.activeQueue[idx];

          progress.currentTrackTitle = `${track.artist} — ${track.title}`;
          reportProgress(false);

          const { record, missingSessionFile } = await this.computeTrackRecord(
            track,
            settings.rmsThresholds,
            slotIdx,
            mode,
            maxDecodeParallel
          );

          if (missingSessionFile) {
            progress.needsRelinkCount = (progress.needsRelinkCount || 0) + 1;
            progress.completed++;
          } else {
            pendingDbWrites.push(record);
            progress.completed++;
            if (record.analysisStatus === 'analyzed') {
              progress.succeeded++;
            } else {
              progress.failed++;
              progress.lastError = record.analysisError;
            }
          }

          flushDb(false);
          reportProgress(false);
        }
      };

      await Promise.all(Array.from({ length: activeWorkers }, (_, idx) => runSlot(idx)));
      flushDb(true);
      await dbFlushChain;

      const totalSec = Math.max(0.05, (performance.now() - startedAt) / 1000);
      progress.tracksPerSec = Math.round(((progress.succeeded + progress.failed) / totalSec) * 10) / 10;

      if (this.cancelled) {
        progress.status = 'cancelled';
        onProgress({ ...progress });
        await addActivityLog(
          'analysis',
          'warning',
          isBackground ? 'Análisis en segundo plano cancelado' : 'Análisis cancelado',
          `Procesadas ${progress.completed} de ${progress.total} pistas (${progress.tracksPerSec} pistas/s, ${activeWorkers} hilos).`
        );
        return progress;
      }

      progress.status = 'completed';
      progress.currentTrackTitle = '';
      onProgress({ ...progress });

      const modeLabel = mode === 'fast-metadata-bpm' ? 'Metadatos + BPM' : 'Completo DSP';
      await addActivityLog(
        'analysis',
        progress.failed > 0 ? 'warning' : 'success',
        `${isBackground ? 'Análisis automático en 2º plano' : 'Lote de análisis'} (${modeLabel}) finalizado`,
        `Exitosas: ${progress.succeeded} · Sin cambios: ${progress.skippedUnchanged} · Errores: ${progress.failed} · ${progress.tracksPerSec} pistas/s (${activeWorkers} hilos)`
      );

      return progress;
    } catch (err) {
      progress.status = 'completed';
      progress.lastError =
        err instanceof Error ? err.message : 'Error inesperado en el motor de análisis.';
      onProgress({ ...progress });
      return progress;
    } finally {
      this.running = false;
      this.activeProgress = null;
      this.activeQueue = [];
      this.activeQueuedIds.clear();
    }
  }
}

export const audioAnalyzer = new AudioAnalyzerController();
