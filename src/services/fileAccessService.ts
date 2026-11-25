import { addActivityLog, db, sessionFileRegistry } from '../db/database';
import {
  SUPPORTED_AUDIO_EXTENSIONS,
  type LinkedFolder,
  type SavedPlaylist,
  type TrackRecord,
} from '../types/studio';
import { extractTrackMetadata } from './metadataParser';
import { isFolderPathPendingConfirmation, normalizeWindowsFolderPath } from './radioboss';

export interface ScanProgress {
  phase: 'discovering' | 'parsing' | 'done' | 'cancelled';
  totalDiscovered: number;
  processed: number;
  added: number;
  updated: number;
  skippedUnchanged: number;
  currentFile: string;
}

export function isSupportedAudioFile(name: string): boolean {
  const lower = name.toLowerCase();
  return SUPPORTED_AUDIO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function isCrossOriginSubframe(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.self !== window.top;
  } catch {
    return true;
  }
}

export function supportsFileSystemAccess(): boolean {
  if (typeof window === 'undefined') return false;
  if (!('showDirectoryPicker' in window)) return false;
  return !isCrossOriginSubframe();
}

export interface DiscoveredFile {
  file: File;
  relativePath: string;
}

export function detectNativeFolderBasePath(discovered: DiscoveredFile[]): string | null {
  for (const item of discovered) {
    const nativePath = (item.file as File & { path?: string }).path;
    if (!nativePath || typeof nativePath !== 'string') continue;
    const trimmed = nativePath.trim();
    if (!trimmed.includes('/') && !trimmed.includes('\\')) continue;

    const normFile = normalizeWindowsFolderPath(trimmed);
    const isPosix = normFile.startsWith('/') && !normFile.startsWith('\\\\');
    const sep = isPosix ? '/' : '\\';
    const normRel = (item.relativePath || item.file.name)
      .replace(/[\\/]+/g, sep)
      .replace(/^[\\/]+/, '');
    if (!normRel) continue;

    const suffix = `${sep}${normRel}`;
    const matchesSuffix = isPosix
      ? normFile.endsWith(suffix)
      : normFile.toLowerCase().endsWith(suffix.toLowerCase());

    if (matchesSuffix && normFile.length > suffix.length) {
      const rawBase = normFile.slice(0, normFile.length - suffix.length);
      return normalizeWindowsFolderPath(rawBase) || null;
    }
  }
  return null;
}

function getScanConcurrency(): number {
  if (typeof navigator === 'undefined') return 4;
  return Math.min(8, Math.max(4, navigator.hardwareConcurrency || 4));
}

async function walkDirectoryHandle(
  dirHandle: FileSystemDirectoryHandle,
  prefix: string,
  signal: AbortSignal,
  onDiscover: (count: number) => void,
  acc: DiscoveredFile[],
  skippedErrors?: { count: number }
): Promise<void> {
  if (signal.aborted) return;

  const dirIterable = dirHandle as unknown as {
    entries(): AsyncIterable<[string, FileSystemHandle]>;
  };
  const fileEntries: Array<{ handle: FileSystemFileHandle; relativePath: string }> = [];
  const subDirs: Array<{ handle: FileSystemDirectoryHandle; relativePath: string }> = [];

  try {
    for await (const [name, handle] of dirIterable.entries()) {
      if (signal.aborted) return;
      const rel = prefix ? `${prefix}/${name}` : name;
      if (handle.kind === 'file') {
        if (isSupportedAudioFile(name)) {
          fileEntries.push({ handle: handle as FileSystemFileHandle, relativePath: rel });
        }
      } else if (handle.kind === 'directory') {
        subDirs.push({ handle: handle as FileSystemDirectoryHandle, relativePath: rel });
      }
    }
  } catch {
    if (skippedErrors) skippedErrors.count++;
    return;
  }

  // Resolve File objects in parallel chunks inside each folder with per-entry isolation
  const chunkSize = 16;
  for (let i = 0; i < fileEntries.length; i += chunkSize) {
    if (signal.aborted) return;
    const slice = fileEntries.slice(i, i + chunkSize);
    const resolved = await Promise.all(
      slice.map(async (entry): Promise<DiscoveredFile | null> => {
        try {
          const file = await entry.handle.getFile();
          return { file, relativePath: entry.relativePath };
        } catch {
          if (skippedErrors) skippedErrors.count++;
          return null;
        }
      })
    );
    for (const item of resolved) {
      if (item) acc.push(item);
    }
    onDiscover(acc.length);
  }

  for (const sub of subDirs) {
    if (signal.aborted) return;
    await walkDirectoryHandle(sub.handle, sub.relativePath, signal, onDiscover, acc, skippedErrors);
  }
}

export async function scanDirectoryWithHandle(
  dirHandle: FileSystemDirectoryHandle,
  role: 'music' | 'spots',
  existingFolderId: string | null,
  signal: AbortSignal,
  onProgress: (p: ScanProgress) => void
): Promise<{ folder: LinkedFolder; summary: ScanProgress }> {
  const folderId =
    existingFolderId || `fs_${dirHandle.name.replace(/[^a-zA-Z0-9_-]/g, '_')}_${Date.now().toString(36)}`;

  const discovered: DiscoveredFile[] = [];
  const skippedErrors = { count: 0 };
  onProgress({
    phase: 'discovering',
    totalDiscovered: 0,
    processed: 0,
    added: 0,
    updated: 0,
    skippedUnchanged: 0,
    currentFile: `Explorando ${dirHandle.name}...`,
  });

  await walkDirectoryHandle(
    dirHandle,
    '',
    signal,
    (count) =>
      onProgress({
        phase: 'discovering',
        totalDiscovered: count,
        processed: 0,
        added: 0,
        updated: 0,
        skippedUnchanged: 0,
        currentFile: `Descubiertos ${count} archivos de audio...`,
      }),
    discovered,
    skippedErrors
  );

  // Persist FileSystemDirectoryHandle in IndexedDB for future re-authorization
  try {
    await db.folderHandles.put({ folderId, handle: dirHandle });
  } catch {
    // Handle persistence can fail on restricted origins; continue scan
  }

  return processDiscoveredFiles(
    folderId,
    dirHandle.name,
    role,
    'fs-access',
    discovered,
    signal,
    onProgress,
    Boolean(existingFolderId)
  );
}

export async function scanFilesFromInput(
  fileList: FileList | File[],
  role: 'music' | 'spots',
  folderLabel: string,
  signal: AbortSignal,
  onProgress: (p: ScanProgress) => void,
  existingFolderId?: string
): Promise<{ folder: LinkedFolder; summary: ScanProgress }> {
  const allFiles = Array.from(fileList || []);
  const files = allFiles.filter((f) => isSupportedAudioFile(f.name));
  const sampleRel =
    (files[0] as File & { webkitRelativePath?: string })?.webkitRelativePath ||
    (allFiles[0] as File & { webkitRelativePath?: string })?.webkitRelativePath ||
    '';
  const inferredRoot = sampleRel.includes('/') ? sampleRel.split('/')[0] : folderLabel;
  const folderName = inferredRoot || folderLabel || 'Archivos importados';

  let resolvedFolderId = existingFolderId;
  if (!resolvedFolderId) {
    const existingMatch = await db.folders
      .where('name')
      .equals(folderName)
      .filter((f) => f.role === role && f.sourceType === 'file-input')
      .first();
    resolvedFolderId =
      existingMatch?.id ||
      `inp_${folderName.replace(/[^a-zA-Z0-9_-]/g, '_')}_${Date.now().toString(36)}`;
  }

  const discovered: DiscoveredFile[] = files.map((file) => {
    const webkitRel = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
    let rel = webkitRel && webkitRel.includes('/') ? webkitRel.split('/').slice(1).join('/') : file.name;
    if (!rel) rel = file.name;
    return { file, relativePath: rel };
  });

  return processDiscoveredFiles(
    resolvedFolderId,
    folderName,
    role,
    'file-input',
    discovered,
    signal,
    onProgress,
    Boolean(existingFolderId)
  );
}

function buildEmergencyFallbackTrack(
  file: File,
  folderId: string,
  folderName: string,
  relativePath: string,
  isSpotFolder: boolean
): TrackRecord {
  const now = Date.now();
  const baseName = file.name.replace(/\.[^/.]+$/, '').trim() || file.name;
  const extMatch = file.name.match(/\.[^/.]+$/);
  const extension = extMatch ? extMatch[0].toLowerCase() : '';
  const size = Number.isFinite(file.size) ? file.size : 0;
  const lastModified = Number.isFinite(file.lastModified) ? file.lastModified : now;

  return {
    id: `${folderId}::${relativePath}`,
    folderId,
    folderName,
    relativePath,
    fileName: file.name,
    extension,
    size,
    lastModified,
    trackNumber: null,
    title: baseName,
    artist: 'Desconocido',
    album: 'Sin álbum',
    genre: 'Desconocido',
    year: null,
    decade: 'Desconocida',
    duration: 0,
    bitrate: null,
    sampleRate: null,
    bpm: null,
    bpmConfidence: null,
    energyRmsDb: null,
    energyScore: null,
    energyLevel: null,
    intensity: null,
    danceability: null,
    danceabilityLabel: null,
    valence: null,
    valenceLabel: null,
    mood: 'Desconocido',
    origins: {
      title: 'DESCONOCIDO',
      artist: 'DESCONOCIDO',
      genre: 'DESCONOCIDO',
      year: 'DESCONOCIDO',
      bpm: 'DESCONOCIDO',
      energy: 'DESCONOCIDO',
      mood: 'DESCONOCIDO',
    },
    analysisStatus: 'pending',
    accessible: true,
    lastVerifiedAt: now,
    duplicateKey: `file::${baseName.toLowerCase()}::0::${Math.round(size / 4096)}`,
    isSpotFolder,
    createdAt: now,
    updatedAt: now,
  };
}

async function safeBulkPutTracks(chunk: TrackRecord[]): Promise<void> {
  if (chunk.length === 0) return;
  try {
    await db.tracks.bulkPut(chunk);
  } catch {
    for (const rec of chunk) {
      try {
        await db.tracks.put(rec);
      } catch {
        // Ignore single malformed record instead of aborting entire scan
      }
    }
  }
}

async function processDiscoveredFiles(
  folderId: string,
  folderName: string,
  role: 'music' | 'spots',
  sourceType: 'fs-access' | 'file-input',
  discovered: DiscoveredFile[],
  signal: AbortSignal,
  onProgress: (p: ScanProgress) => void,
  isExplicitReconnect = false
): Promise<{ folder: LinkedFolder; summary: ScanProgress }> {
  const existingTracks = await db.tracks.where('folderId').equals(folderId).toArray();
  const existingById = new Map<string, TrackRecord>(existingTracks.map((t) => [t.id, t]));
  const existingFolder = await db.folders.get(folderId);

  const isSpotFolder = role === 'spots';
  let added = 0;
  let updated = 0;
  let skippedUnchanged = 0;
  let processed = 0;
  const seenIds = new Set<string>();
  const batchToPut: TrackRecord[] = [];
  const toParse: Array<{ file: File; relativePath: string; existing?: TrackRecord }> = [];

  // Fast synchronous incremental pass
  for (let i = 0; i < discovered.length; i++) {
    const { file, relativePath } = discovered[i];
    const id = `${folderId}::${relativePath}`;
    seenIds.add(id);
    sessionFileRegistry.set(id, file);

    const existing = existingById.get(id);
    const sameFileMeta =
      existing && existing.size === file.size && existing.lastModified === file.lastModified;

    if (sameFileMeta) {
      const hadFalseSessionError =
        existing.analysisStatus === 'error' &&
        (existing.analysisError?.includes('no disponible en esta sesión') ||
          existing.analysisError?.includes('Re-vincula'));

      if (
        !existing.accessible ||
        existing.missingOnDisk ||
        existing.isSpotFolder !== isSpotFolder ||
        hadFalseSessionError
      ) {
        batchToPut.push({
          ...existing,
          accessible: true,
          missingOnDisk: false,
          isSpotFolder,
          analysisStatus: hadFalseSessionError ? 'pending' : existing.analysisStatus,
          analysisError: hadFalseSessionError ? undefined : existing.analysisError,
          lastVerifiedAt: Date.now(),
        });
      }
      skippedUnchanged++;
      processed++;
    } else {
      toParse.push({ file, relativePath, existing });
    }
  }

  let cursor = 0;
  let lastReportAt = 0;
  let flushChain = Promise.resolve();

  const enqueueFlush = (force = false) => {
    if (batchToPut.length === 0) return;
    if (!force && batchToPut.length < 100) return;
    const chunk = batchToPut.splice(0, batchToPut.length);
    flushChain = flushChain.then(() => safeBulkPutTracks(chunk));
  };

  const reportThrottled = (currentFile: string, force = false) => {
    const now = performance.now();
    if (!force && now - lastReportAt < 100) return;
    lastReportAt = now;
    onProgress({
      phase: 'parsing',
      totalDiscovered: discovered.length,
      processed,
      added,
      updated,
      skippedUnchanged,
      currentFile,
    });
  };

  if (toParse.length > 0) {
    reportThrottled(toParse[0].relativePath, true);
    const workerCount = Math.min(getScanConcurrency(), toParse.length);

    const runWorker = async () => {
      while (true) {
        if (signal.aborted) return;
        const idx = cursor++;
        if (idx >= toParse.length) return;
        const { file, relativePath, existing } = toParse[idx];

        let parsed: TrackRecord;
        try {
          parsed = await extractTrackMetadata(
            file,
            folderId,
            folderName,
            relativePath,
            isSpotFolder
          );
        } catch {
          parsed = buildEmergencyFallbackTrack(
            file,
            folderId,
            folderName,
            relativePath,
            isSpotFolder
          );
        }

        if (existing) {
          if (existing.origins?.title === 'MANUAL') parsed.title = existing.title;
          if (existing.origins?.artist === 'MANUAL') parsed.artist = existing.artist;
          if (existing.origins?.genre === 'MANUAL') parsed.genre = existing.genre;
          if (existing.origins?.year === 'MANUAL') {
            parsed.year = existing.year;
            parsed.decade = existing.decade;
          }
          if (existing.origins?.bpm === 'MANUAL' && existing.bpm) {
            parsed.bpm = existing.bpm;
            parsed.bpmConfidence = existing.bpmConfidence ?? 100;
            parsed.origins.bpm = 'MANUAL';
          }
          updated++;
        } else {
          added++;
        }

        batchToPut.push(parsed);
        processed++;
        enqueueFlush(false);
        reportThrottled(relativePath, false);
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  }

  enqueueFlush(true);
  await flushChain;

  if (signal.aborted) {
    onProgress({
      phase: 'cancelled',
      totalDiscovered: discovered.length,
      processed,
      added,
      updated,
      skippedUnchanged,
      currentFile: 'Escaneo cancelado por el usuario',
    });
  }

  // Mark tracks that were previously in this folder but missing now as inaccessible
  // (when fs-access or explicit folder reconnection wasn't aborted)
  if (
    !signal.aborted &&
    existingTracks.length > 0 &&
    (sourceType === 'fs-access' || isExplicitReconnect)
  ) {
    const missingTracks: TrackRecord[] = [];
    for (const prev of existingTracks) {
      if (!seenIds.has(prev.id) && (prev.accessible || !prev.missingOnDisk)) {
        missingTracks.push({
          ...prev,
          accessible: false,
          missingOnDisk: true,
          lastVerifiedAt: Date.now(),
        });
      }
    }
    if (missingTracks.length > 0) {
      await safeBulkPutTracks(missingTracks);
    }
  }

  const totalFolderTracks = await db.tracks.where('folderId').equals(folderId).count();
  const detectedNativeBase = detectNativeFolderBasePath(discovered);
  const existingConfirmed =
    existingFolder && !isFolderPathPendingConfirmation(existingFolder)
      ? normalizeWindowsFolderPath(existingFolder.windowsBasePath)
      : '';

  const windowsBasePath =
    detectedNativeBase ||
    existingConfirmed ||
    existingFolder?.windowsBasePath ||
    `D:\\RadioBOSS\\${folderName}`;

  const folder: LinkedFolder = {
    id: folderId,
    name: folderName,
    role,
    sourceType,
    windowsBasePath,
    pathConfirmed: Boolean(detectedNativeBase) || Boolean(existingConfirmed),
    trackCount: totalFolderTracks,
    lastScannedAt: Date.now(),
  };
  await db.folders.put(folder);

  if (isExplicitReconnect && !signal.aborted) {
    await reconcilePlaylistsAfterFolderReconnect(folderId);
  }

  const summary: ScanProgress = {
    phase: signal.aborted ? 'cancelled' : 'done',
    totalDiscovered: discovered.length,
    processed,
    added,
    updated,
    skippedUnchanged,
    currentFile: signal.aborted ? 'Cancelado' : 'Completado',
  };

  await addActivityLog(
    'scan',
    signal.aborted ? 'warning' : 'success',
    `${isSpotFolder ? 'Carpeta de Spots' : 'Carpeta'} "${folderName}" ${
      isExplicitReconnect ? 'reconectada' : 'escaneada'
    }`,
    `Nuevas: ${added} · Actualizadas: ${updated} · Sin cambios: ${skippedUnchanged}`
  );

  onProgress(summary);
  return { folder, summary };
}

async function reconcilePlaylistsAfterFolderReconnect(folderId: string): Promise<number> {
  const [folderTracks, playlists] = await Promise.all([
    db.tracks.where('folderId').equals(folderId).toArray(),
    db.playlists.toArray(),
  ]);
  const accessibleTracks = folderTracks.filter((t) => t.accessible);
  if (accessibleTracks.length === 0 || playlists.length === 0) return 0;

  const byId = new Map(folderTracks.map((t) => [t.id, t]));
  const byFileName = new Map<string, TrackRecord[]>();
  for (const t of accessibleTracks) {
    const k = t.fileName.toLowerCase();
    const list = byFileName.get(k) || [];
    list.push(t);
    byFileName.set(k, list);
  }

  let updatedPlaylists = 0;
  for (const pl of playlists) {
    let changed = false;
    const nextItems = pl.items.map((item) => {
      if (item.folderId !== folderId) return item;
      const direct = byId.get(item.trackId);
      if (direct && direct.accessible) {
        if (!item.accessible || item.relativePath !== direct.relativePath) {
          changed = true;
          return { ...item, relativePath: direct.relativePath, accessible: true };
        }
        return item;
      }
      // Try matching moved file within same reconnected folder by filename
      const candidates = byFileName.get((item.fileName || '').toLowerCase()) || [];
      if (candidates.length > 0) {
        const matched = candidates[0];
        changed = true;
        return {
          ...item,
          trackId: matched.id,
          relativePath: matched.relativePath,
          fileName: matched.fileName,
          accessible: true,
        };
      }
      if (item.accessible) {
        changed = true;
        return { ...item, accessible: false };
      }
      return item;
    });

    if (changed) {
      await db.playlists.update(pl.id, { items: nextItems, updatedAt: Date.now() });
      updatedPlaylists++;
    }
  }
  return updatedPlaylists;
}

export async function healFalseInaccessibleTracks(): Promise<number> {
  const [tracks, folders] = await Promise.all([db.tracks.toArray(), db.folders.toArray()]);
  const folderMap = new Map(folders.map((f) => [f.id, f]));
  const updates: TrackRecord[] = [];

  for (const t of tracks) {
    if (t.missingOnDisk) continue;
    const folder = folderMap.get(t.folderId);
    const hasLegacySessionError =
      t.analysisStatus === 'error' &&
      Boolean(
        t.analysisError?.includes('no disponible en esta sesión') ||
          t.analysisError?.includes('Re-vincula')
      );
    const isFileInputMarkedInaccessible = folder?.sourceType === 'file-input' && !t.accessible;

    if (hasLegacySessionError || isFileInputMarkedInaccessible) {
      updates.push({
        ...t,
        accessible: true,
        analysisStatus: hasLegacySessionError ? 'pending' : t.analysisStatus,
        analysisError: hasLegacySessionError ? undefined : t.analysisError,
      });
    }
  }

  if (updates.length > 0) {
    await safeBulkPutTracks(updates);
  }
  return updates.length;
}

export async function verifyAndRelinkFolder(folderId: string): Promise<{
  verified: number;
  inaccessible: number;
  reauthorized: boolean;
  needsSessionRelink?: boolean;
}> {
  const handleRec = await db.folderHandles.get(folderId);
  const tracks = await db.tracks.where('folderId').equals(folderId).toArray();

  if (handleRec?.handle) {
    const handle = handleRec.handle as FileSystemDirectoryHandle & {
      queryPermission?: (desc: { mode: 'read' }) => Promise<PermissionState>;
      requestPermission?: (desc: { mode: 'read' }) => Promise<PermissionState>;
    };

    let perm: PermissionState = 'granted';
    try {
      if (handle.queryPermission) {
        perm = await handle.queryPermission({ mode: 'read' });
        if (perm !== 'granted' && handle.requestPermission) {
          perm = await handle.requestPermission({ mode: 'read' });
        }
      }
    } catch {
      perm = 'denied';
    }

    if (perm !== 'granted') {
      // Do not mark tracks permanently inaccessible if the browser merely needs permission again
      return {
        verified: tracks.filter((t) => t.accessible).length,
        inaccessible: 0,
        reauthorized: false,
        needsSessionRelink: true,
      };
    }

    const ac = new AbortController();
    const discovered: DiscoveredFile[] = [];
    await walkDirectoryHandle(handle, '', ac.signal, () => {}, discovered);
    const fileMap = new Map(discovered.map((d) => [`${folderId}::${d.relativePath}`, d.file]));

    let verified = 0;
    let inaccessible = 0;
    const updates: TrackRecord[] = [];
    const now = Date.now();

    for (const t of tracks) {
      const f = fileMap.get(t.id);
      if (f) {
        sessionFileRegistry.set(t.id, f);
        verified++;
        if (!t.accessible) updates.push({ ...t, accessible: true, lastVerifiedAt: now });
      } else {
        inaccessible++;
        if (t.accessible) updates.push({ ...t, accessible: false, lastVerifiedAt: now });
      }
    }
    if (updates.length > 0) await safeBulkPutTracks(updates);
    return { verified, inaccessible, reauthorized: true };
  }

  // For file-input folders, missing sessionFileRegistry entries after page reload mean the browser
  // dropped temporary handles — NOT that files were deleted on Windows disk. Never mark accessible=false!
  await healFalseInaccessibleTracks();
  let activeInSession = 0;
  for (const t of tracks) {
    if (sessionFileRegistry.has(t.id)) activeInSession++;
  }

  return {
    verified: tracks.length,
    inaccessible: 0,
    reauthorized: activeInSession === tracks.length,
    needsSessionRelink: tracks.length > 0 && activeInSession < tracks.length,
  };
}

export async function verifyAllFoldersAccessibility(): Promise<{
  verified: number;
  inaccessible: number;
  needsSessionRelinkFolders: number;
}> {
  await healFalseInaccessibleTracks();
  const folders = await db.folders.toArray();
  let verified = 0;
  let inaccessible = 0;
  let needsSessionRelinkFolders = 0;

  for (const f of folders) {
    const res = await verifyAndRelinkFolder(f.id);
    verified += res.verified;
    inaccessible += res.inaccessible;
    if (res.needsSessionRelink) needsSessionRelinkFolders++;
  }

  await addActivityLog(
    'scan',
    inaccessible > 0 ? 'warning' : 'success',
    'Verificación de biblioteca completada',
    `Catalogadas accesibles: ${verified} · Faltantes en disco: ${inaccessible}${
      needsSessionRelinkFolders > 0
        ? ` · ${needsSessionRelinkFolders} carpeta(s) requieren re-vincular para lectura DSP`
        : ''
    }`
  );
  return { verified, inaccessible, needsSessionRelinkFolders };
}

export type FolderDiskStatus =
  | 'ok'
  | 'missing-files'
  | 'folder-moved'
  | 'needs-permission'
  | 'needs-reselect';

export interface MissingTrackDetail {
  trackId: string;
  folderId: string;
  title: string;
  artist: string;
  relativePath: string;
}

export interface FolderDiskVerification {
  folderId: string;
  folderName: string;
  role: 'music' | 'spots';
  windowsBasePath: string;
  sourceType: 'fs-access' | 'file-input';
  status: FolderDiskStatus;
  totalInPlaylist: number;
  verifiedCount: number;
  missingCount: number;
  unverifiedCount: number;
  missingFiles: MissingTrackDetail[];
}

export interface PreExportFileVerificationResult {
  checkedAt: number;
  totalItems: number;
  verifiedCount: number;
  missingCount: number;
  unverifiedCount: number;
  hasBlockingIssues: boolean;
  needsReconnect: boolean;
  folders: FolderDiskVerification[];
  missingTracks: MissingTrackDetail[];
}

async function resolveFileFromDirectoryHandle(
  rootHandle: FileSystemDirectoryHandle,
  relativePath: string
): Promise<File> {
  const parts = relativePath
    .replace(/\\/g, '/')
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new DOMException('Empty path', 'NotFoundError');
  }
  let dir = rootHandle;
  for (let i = 0; i < parts.length - 1; i++) {
    dir = await dir.getDirectoryHandle(parts[i]);
  }
  const fileHandle = await dir.getFileHandle(parts[parts.length - 1]);
  return fileHandle.getFile();
}

async function isBrowserFileStillReadableOnDisk(file: File): Promise<boolean> {
  try {
    await file.slice(0, 1).arrayBuffer();
    return true;
  } catch {
    return false;
  }
}

export async function verifyPlaylistFilesOnDisk(
  playlist: SavedPlaylist,
  options: { requestHandlePermission?: boolean } = {}
): Promise<PreExportFileVerificationResult> {
  const [allTracks, allFolders, handleRecords] = await Promise.all([
    db.tracks.toArray(),
    db.folders.toArray(),
    db.folderHandles.toArray(),
  ]);

  const trackMap = new Map(allTracks.map((t) => [t.id, t]));
  const folderMap = new Map(allFolders.map((f) => [f.id, f]));
  const handleMap = new Map(handleRecords.map((h) => [h.folderId, h.handle]));

  // Deduplicate playlist items by trackId while preserving folder grouping
  const itemsByFolder = new Map<
    string,
    Array<{
      trackId: string;
      folderId: string;
      title: string;
      artist: string;
      relativePath: string;
      catalogTrack?: TrackRecord;
    }>
  >();

  const seenTrackIds = new Set<string>();
  for (const item of playlist.items) {
    if (seenTrackIds.has(item.trackId)) continue;
    seenTrackIds.add(item.trackId);
    const catalogTrack = trackMap.get(item.trackId);
    const folderId = catalogTrack?.folderId || item.folderId;
    const relativePath = catalogTrack?.relativePath || item.relativePath || item.fileName;
    const list = itemsByFolder.get(folderId) || [];
    list.push({
      trackId: item.trackId,
      folderId,
      title: item.title,
      artist: item.artist,
      relativePath,
      catalogTrack,
    });
    itemsByFolder.set(folderId, list);
  }

  const now = Date.now();
  const trackUpdates: TrackRecord[] = [];
  const folderResults: FolderDiskVerification[] = [];
  const missingTracks: MissingTrackDetail[] = [];

  let verifiedCount = 0;
  let missingCount = 0;
  let unverifiedCount = 0;

  for (const [folderId, entries] of itemsByFolder.entries()) {
    const folder = folderMap.get(folderId);
    const folderName = folder?.name || entries[0]?.catalogTrack?.folderName || 'Carpeta eliminada';
    const windowsBasePath = folder?.windowsBasePath || `D:\\RadioBOSS\\${folderName}`;
    const sourceType = folder?.sourceType || 'file-input';
    const role = folder?.role || 'music';

    const dirHandle = handleMap.get(folderId) as
      | (FileSystemDirectoryHandle & {
          queryPermission?: (desc: { mode: 'read' }) => Promise<PermissionState>;
          requestPermission?: (desc: { mode: 'read' }) => Promise<PermissionState>;
          entries?: () => AsyncIterable<[string, FileSystemHandle]>;
        })
      | undefined;

    let fVerified = 0;
    let fMissing = 0;
    let fUnverified = 0;
    const fMissingFiles: MissingTrackDetail[] = [];
    let status: FolderDiskStatus = 'ok';

    if (!folder) {
      status = 'folder-moved';
      for (const entry of entries) {
        fMissing++;
        const miss: MissingTrackDetail = {
          trackId: entry.trackId,
          folderId,
          title: entry.title,
          artist: entry.artist,
          relativePath: entry.relativePath,
        };
        fMissingFiles.push(miss);
        missingTracks.push(miss);
        if (entry.catalogTrack && (entry.catalogTrack.accessible || !entry.catalogTrack.missingOnDisk)) {
          trackUpdates.push({
            ...entry.catalogTrack,
            accessible: false,
            missingOnDisk: true,
            lastVerifiedAt: now,
          });
        }
      }
    } else if (dirHandle) {
      let perm: PermissionState = 'granted';
      try {
        if (dirHandle.queryPermission) {
          perm = await dirHandle.queryPermission({ mode: 'read' });
          if (perm !== 'granted' && options.requestHandlePermission && dirHandle.requestPermission) {
            perm = await dirHandle.requestPermission({ mode: 'read' });
          }
        }
      } catch {
        perm = 'denied';
      }

      if (perm !== 'granted') {
        status = 'needs-permission';
        for (const entry of entries) {
          const cachedFile = sessionFileRegistry.get(entry.trackId);
          if (cachedFile && (await isBrowserFileStillReadableOnDisk(cachedFile))) {
            fVerified++;
          } else {
            fUnverified++;
          }
        }
      } else {
        // Verify root directory handle still exists on disk
        let rootExists = true;
        try {
          if (dirHandle.entries) {
            const iter = dirHandle.entries() as AsyncIterator<[string, FileSystemHandle]>;
            await iter.next();
          }
        } catch (err) {
          if (
            err instanceof DOMException &&
            (err.name === 'NotFoundError' || err.name === 'NotAllowedError')
          ) {
            rootExists = false;
          }
        }

        if (!rootExists) {
          status = 'folder-moved';
          for (const entry of entries) {
            fMissing++;
            const miss: MissingTrackDetail = {
              trackId: entry.trackId,
              folderId,
              title: entry.title,
              artist: entry.artist,
              relativePath: entry.relativePath,
            };
            fMissingFiles.push(miss);
            missingTracks.push(miss);
            if (entry.catalogTrack && (entry.catalogTrack.accessible || !entry.catalogTrack.missingOnDisk)) {
              trackUpdates.push({
                ...entry.catalogTrack,
                accessible: false,
                missingOnDisk: true,
                lastVerifiedAt: now,
              });
            }
          }
        } else {
          for (const entry of entries) {
            try {
              const file = await resolveFileFromDirectoryHandle(dirHandle, entry.relativePath);
              sessionFileRegistry.set(entry.trackId, file);
              fVerified++;
              if (entry.catalogTrack && (!entry.catalogTrack.accessible || entry.catalogTrack.missingOnDisk)) {
                trackUpdates.push({
                  ...entry.catalogTrack,
                  accessible: true,
                  missingOnDisk: false,
                  lastVerifiedAt: now,
                });
              }
            } catch {
              fMissing++;
              const miss: MissingTrackDetail = {
                trackId: entry.trackId,
                folderId,
                title: entry.title,
                artist: entry.artist,
                relativePath: entry.relativePath,
              };
              fMissingFiles.push(miss);
              missingTracks.push(miss);
              if (entry.catalogTrack && (entry.catalogTrack.accessible || !entry.catalogTrack.missingOnDisk)) {
                trackUpdates.push({
                  ...entry.catalogTrack,
                  accessible: false,
                  missingOnDisk: true,
                  lastVerifiedAt: now,
                });
              }
            }
          }
          if (fMissing > 0) status = 'missing-files';
        }
      }
    } else {
      // file-input / subframe session: test live File handles when available, otherwise flag session re-select
      for (const entry of entries) {
        const cachedFile = sessionFileRegistry.get(entry.trackId);
        if (cachedFile) {
          const alive = await isBrowserFileStillReadableOnDisk(cachedFile);
          if (alive) {
            fVerified++;
            if (entry.catalogTrack && (!entry.catalogTrack.accessible || entry.catalogTrack.missingOnDisk)) {
              trackUpdates.push({
                ...entry.catalogTrack,
                accessible: true,
                missingOnDisk: false,
                lastVerifiedAt: now,
              });
            }
          } else {
            sessionFileRegistry.delete(entry.trackId);
            fMissing++;
            const miss: MissingTrackDetail = {
              trackId: entry.trackId,
              folderId,
              title: entry.title,
              artist: entry.artist,
              relativePath: entry.relativePath,
            };
            fMissingFiles.push(miss);
            missingTracks.push(miss);
            if (entry.catalogTrack) {
              trackUpdates.push({
                ...entry.catalogTrack,
                accessible: false,
                missingOnDisk: true,
                lastVerifiedAt: now,
              });
            }
          }
        } else if (entry.catalogTrack && (!entry.catalogTrack.accessible || entry.catalogTrack.missingOnDisk)) {
          fMissing++;
          const miss: MissingTrackDetail = {
            trackId: entry.trackId,
            folderId,
            title: entry.title,
            artist: entry.artist,
            relativePath: entry.relativePath,
          };
          fMissingFiles.push(miss);
          missingTracks.push(miss);
        } else {
          fUnverified++;
        }
      }

      if (fMissing > 0) {
        status = 'missing-files';
      } else if (fUnverified > 0) {
        status = 'needs-reselect';
      }
    }

    verifiedCount += fVerified;
    missingCount += fMissing;
    unverifiedCount += fUnverified;

    folderResults.push({
      folderId,
      folderName,
      role,
      windowsBasePath,
      sourceType,
      status,
      totalInPlaylist: entries.length,
      verifiedCount: fVerified,
      missingCount: fMissing,
      unverifiedCount: fUnverified,
      missingFiles: fMissingFiles,
    });
  }

  if (trackUpdates.length > 0) {
    await safeBulkPutTracks(trackUpdates);
  }

  const hasBlockingIssues =
    missingCount > 0 ||
    folderResults.some((f) => f.status === 'folder-moved' || f.status === 'missing-files');
  const needsReconnect = folderResults.some((f) => f.status !== 'ok');

  await addActivityLog(
    'validator',
    hasBlockingIssues ? 'warning' : 'success',
    `Verificación de archivos en disco (${playlist.name})`,
    `Verificados: ${verifiedCount} · Faltantes: ${missingCount} · Sin acceso de sesión: ${unverifiedCount}`
  );

  return {
    checkedAt: now,
    totalItems: seenTrackIds.size,
    verifiedCount,
    missingCount,
    unverifiedCount,
    hasBlockingIssues,
    needsReconnect,
    folders: folderResults,
    missingTracks,
  };
}
