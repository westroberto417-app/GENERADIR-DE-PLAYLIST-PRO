import { addActivityLog, db, getSettings, saveSettings } from '../db/database';
import type {
  PlaylistGeneratorConfig,
  SavedPlaylist,
  ScheduledTask,
} from '../types/studio';
import { detectNativeFolderBasePath, supportsFileSystemAccess } from './fileAccessService';
import { normalizeText } from './metadataParser';
import { generateSmartPlaylist } from './playlistEngine';
import {
  buildPlaylistOutputPathHint,
  buildRadioBossM3UContent,
  normalizeWindowsFolderPath,
} from './radioboss';

export const SCHEDULER_GLOBAL_OUTPUT_HANDLE_ID = 'scheduler_output_default';

export function getTaskOutputHandleId(taskId: string): string {
  return `scheduler_output_${taskId}`;
}

export function formatScheduleOutputName(
  pattern: string,
  taskName: string,
  refDate: Date = new Date()
): string {
  const dd = String(refDate.getDate()).padStart(2, '0');
  const mm = String(refDate.getMonth() + 1).padStart(2, '0');
  const yyyy = String(refDate.getFullYear());
  const hh = String(refDate.getHours()).padStart(2, '0');
  const min = String(refDate.getMinutes()).padStart(2, '0');

  return (pattern || '{DD-MM-YYYY}_{NAME}')
    .replace(/\{DD-MM-YYYY\}/gi, `${dd}-${mm}-${yyyy}`)
    .replace(/\{YYYY-MM-DD\}/gi, `${yyyy}-${mm}-${dd}`)
    .replace(/\{HH-MM\}/gi, `${hh}-${min}`)
    .replace(/\{NAME\}/gi, taskName.trim().replace(/\s+/g, '_'));
}

export function sanitizeOutputFileBaseName(raw: string): string {
  return (raw || 'playlist')
    .replace(/[<>:"/\\|?*]+/g, '_')
    .replace(/\.(m3u8|m3u)$/i, '')
    .trim() || 'playlist';
}

export function resolveScheduledOutputFilename(
  task: Pick<ScheduledTask, 'name' | 'namePattern' | 'outputFileName' | 'format' | 'overwriteExisting'>,
  refDate: Date = new Date()
): string {
  const ext = task.format === 'm3u' ? 'm3u' : 'm3u8';
  const rawInput = task.outputFileName?.trim();
  const rawBase = rawInput
    ? rawInput.includes('{')
      ? formatScheduleOutputName(rawInput, task.name, refDate)
      : rawInput
    : formatScheduleOutputName(task.namePattern, task.name, refDate);
  const cleanBase = sanitizeOutputFileBaseName(rawBase);

  if (task.overwriteExisting === false) {
    const stamp = `${String(refDate.getHours()).padStart(2, '0')}${String(refDate.getMinutes()).padStart(2, '0')}${String(refDate.getSeconds()).padStart(2, '0')}`;
    return `${cleanBase}_${stamp}.${ext}`;
  }
  return `${cleanBase}.${ext}`;
}

export interface SchedulerDirectoryStatus {
  supported: boolean;
  hasHandle: boolean;
  folderName: string;
  permission: PermissionState | 'unlinked' | 'unsupported';
}

type PermissionCapableDirectoryHandle = FileSystemDirectoryHandle & {
  queryPermission?: (desc: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (desc: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  entries?: () => AsyncIterable<[string, FileSystemHandle]>;
};

export async function getSchedulerDirectoryStatus(
  handleId: string = SCHEDULER_GLOBAL_OUTPUT_HANDLE_ID
): Promise<SchedulerDirectoryStatus> {
  if (!supportsFileSystemAccess()) {
    const settings = await getSettings();
    return {
      supported: false,
      hasHandle: false,
      folderName: settings.schedulerOutputFolderName || '',
      permission: 'unsupported',
    };
  }
  const rec = await db.folderHandles.get(handleId);
  if (!rec?.handle) {
    return {
      supported: true,
      hasHandle: false,
      folderName: '',
      permission: 'unlinked',
    };
  }
  const handle = rec.handle as PermissionCapableDirectoryHandle;
  let permission: PermissionState = 'prompt';
  try {
    if (handle.queryPermission) {
      permission = await handle.queryPermission({ mode: 'readwrite' });
    } else {
      permission = 'granted';
    }
  } catch {
    permission = 'denied';
  }
  return {
    supported: true,
    hasHandle: true,
    folderName: handle.name,
    permission,
  };
}

export async function pickSchedulerOutputDirectory(
  handleId: string = SCHEDULER_GLOBAL_OUTPUT_HANDLE_ID
): Promise<{
  ok: boolean;
  folderName: string;
  detectedWindowsPath?: string;
  error?: string;
}> {
  if (!supportsFileSystemAccess()) {
    return {
      ok: false,
      folderName: '',
      error:
        'Tu navegador o vista embebida no permite seleccionar carpetas locales en modo escritura. Abre la app directamente en Chrome/Edge o usa el servicio APScheduler Windows x64.',
    };
  }
  try {
    const dirHandle = await (
      window as unknown as {
        showDirectoryPicker: (opts?: { mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
      }
    ).showDirectoryPicker({ mode: 'readwrite' });

    const permHandle = dirHandle as PermissionCapableDirectoryHandle;
    let perm: PermissionState = 'granted';
    if (permHandle.queryPermission) {
      perm = await permHandle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted' && permHandle.requestPermission) {
        perm = await permHandle.requestPermission({ mode: 'readwrite' });
      }
    }
    if (perm !== 'granted') {
      return {
        ok: false,
        folderName: dirHandle.name,
        error: 'Se requiere permiso de lectura y escritura sobre la carpeta seleccionada.',
      };
    }

    await db.folderHandles.put({ folderId: handleId, handle: dirHandle });

    // Attempt to inspect first file inside to auto-detect native Windows path if available (Electron/desktop)
    let detectedWindowsPath: string | undefined;
    try {
      if (permHandle.entries) {
        for await (const [entryName, entryHandle] of permHandle.entries()) {
          if (entryHandle.kind === 'file') {
            const f = await (entryHandle as FileSystemFileHandle).getFile();
            const detected = detectNativeFolderBasePath([{ file: f, relativePath: entryName }]);
            if (detected) {
              detectedWindowsPath = detected;
            }
            break;
          }
        }
      }
    } catch {
      // ignore path probe errors
    }

    if (handleId === SCHEDULER_GLOBAL_OUTPUT_HANDLE_ID) {
      const current = await getSettings();
      await saveSettings({
        schedulerOutputFolderName: dirHandle.name,
        schedulerOutputWindowsPath: detectedWindowsPath
          ? normalizeWindowsFolderPath(detectedWindowsPath)
          : current.schedulerOutputWindowsPath || current.storageRootPath,
      });
    }

    await addActivityLog(
      'scheduler',
      'success',
      `Carpeta destino de programación vinculada: "${dirHandle.name}"`,
      detectedWindowsPath
        ? `Escritura automática habilitada en ${detectedWindowsPath}`
        : `Escritura y sobrescritura automática habilitada en "${dirHandle.name}".`
    );

    return {
      ok: true,
      folderName: dirHandle.name,
      detectedWindowsPath,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return { ok: false, folderName: '' };
    }
    return {
      ok: false,
      folderName: '',
      error: err instanceof Error ? err.message : 'No se pudo vincular la carpeta destino.',
    };
  }
}

export async function requestSchedulerDirectoryPermission(
  handleId: string = SCHEDULER_GLOBAL_OUTPUT_HANDLE_ID
): Promise<PermissionState | 'unlinked'> {
  const rec = await db.folderHandles.get(handleId);
  if (!rec?.handle) return 'unlinked';
  const handle = rec.handle as PermissionCapableDirectoryHandle;
  try {
    if (handle.requestPermission) {
      return await handle.requestPermission({ mode: 'readwrite' });
    }
    return 'granted';
  } catch {
    return 'denied';
  }
}

async function writePlaylistContentToTaskFolder(
  task: ScheduledTask,
  fileName: string,
  content: string,
  allowPermissionPrompt: boolean
): Promise<{
  status: 'written' | 'pending-permission' | 'no-folder' | 'unsupported' | 'error';
  folderName: string;
  detail: string;
}> {
  if (!supportsFileSystemAccess()) {
    return {
      status: 'unsupported',
      folderName: task.outputFolderName || '',
      detail: 'Navegador/entorno sin File System Access API en escritura directa.',
    };
  }

  const customHandleId =
    task.outputFolderMode === 'custom' ? getTaskOutputHandleId(task.id) : null;
  const customRec = customHandleId ? await db.folderHandles.get(customHandleId) : undefined;
  const globalRec = await db.folderHandles.get(SCHEDULER_GLOBAL_OUTPUT_HANDLE_ID);
  const chosenRec = customRec || globalRec;

  if (!chosenRec?.handle) {
    return {
      status: 'no-folder',
      folderName: task.outputFolderName || '',
      detail: 'No hay carpeta en disco vinculada en Programación para sobrescribir el archivo.',
    };
  }

  const dirHandle = chosenRec.handle as PermissionCapableDirectoryHandle;
  let perm: PermissionState = 'granted';
  try {
    if (dirHandle.queryPermission) {
      perm = await dirHandle.queryPermission({ mode: 'readwrite' });
      if (perm !== 'granted' && allowPermissionPrompt && dirHandle.requestPermission) {
        perm = await dirHandle.requestPermission({ mode: 'readwrite' });
      }
    }
  } catch {
    perm = 'denied';
  }

  if (perm !== 'granted') {
    return {
      status: 'pending-permission',
      folderName: dirHandle.name,
      detail: `Permiso de escritura pendiente para "${dirHandle.name}". Pulsa "Autorizar escritura" en Programación.`,
    };
  }

  try {
    const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
    const writable = await fileHandle.createWritable({ keepExistingData: false });
    await writable.write(content);
    await writable.close();
    return {
      status: 'written',
      folderName: dirHandle.name,
      detail: `Archivo "${fileName}" guardado y sobrescrito en "${dirHandle.name}".`,
    };
  } catch (err) {
    return {
      status: 'error',
      folderName: dirHandle.name,
      detail:
        err instanceof Error
          ? `Error al escribir "${fileName}" en "${dirHandle.name}": ${err.message}`
          : `Error al escribir "${fileName}" en disco.`,
    };
  }
}

export async function executeScheduledTask(
  task: ScheduledTask,
  options: { allowPermissionPrompt?: boolean } = {}
): Promise<{
  playlist: SavedPlaylist | null;
  status: 'success' | 'warning' | 'error';
  diskStatus: ScheduledTask['lastDiskWriteStatus'];
  outputFileName: string;
  message: string;
}> {
  const settings = await getSettings();
  const outputFileName = resolveScheduledOutputFilename(task);
  const basePlaylistName = sanitizeOutputFileBaseName(outputFileName);

  const cfg: PlaylistGeneratorConfig = {
    name: basePlaylistName,
    templateId: '',
    sourceScope: task.sourceScope || 'all',
    sourceFolderId: task.sourceFolderId || '',
    targetType: task.targetType,
    targetDurationMin: task.targetDurationMin,
    targetCount: task.targetCount,
    mode: task.mode || (task.mood ? 'Por ambiente' : 'Combinado'),
    progressiveCurve: { preset: 'Ascendente', segments: [30, 55, 78, 90] },
    allowedGenres: task.allowedGenres || [],
    excludedGenres: task.excludedGenres || [],
    decades: task.decades || [],
    years: [],
    includedArtists: [],
    excludedArtists: [],
    bpmMin: task.bpmMin,
    bpmMax: task.bpmMax,
    energyMin: null,
    energyMax: null,
    energyLevels: [],
    intensities: task.intensities || [],
    moods: task.mood ? [task.mood] : [],
    noRepeatTracks: task.noRepeatTracks !== false,
    noRepeatArtists: task.noRepeatArtists !== false,
    respectAntiRepeat: task.respectAntiRepeat ?? true,
    antiRepeatHours:
      typeof task.antiRepeatHours === 'number' ? task.antiRepeatHours : settings.antiRepeatHours,
    fallbackToOldestOnExhaust: task.fallbackToOldestOnExhaust !== false,
    artistSeparation:
      typeof task.artistSeparation === 'number'
        ? task.artistSeparation
        : settings.artistSeparation,
    spots: task.spots || {
      enabled: false,
      spotFolderId: '',
      everyNSongs: 4,
      rotationMode: 'sequential',
      insertIntroAtStart: false,
    },
  };

  const result = await generateSmartPlaylist(cfg);
  if (result.items.length === 0) {
    const msg = result.warnings[0] || 'No se encontraron pistas elegibles.';
    await db.schedules.update(task.id, {
      lastRunAt: Date.now(),
      lastStatus: 'error',
      lastMessage: msg,
    });
    await addActivityLog('scheduler', 'error', `Tarea "${task.name}" fallida`, msg);
    return {
      playlist: null,
      status: 'error',
      diskStatus: 'error',
      outputFileName,
      message: msg,
    };
  }

  const now = Date.now();
  // Keep deterministic playlist ID per task when overwriting so IndexedDB stays clean, or new ID when not overwriting
  const playlistId =
    task.overwriteExisting !== false
      ? `pl_sch_fixed_${task.id}`
      : `pl_sch_${now}_${Math.random().toString(36).slice(2, 6)}`;

  const playlist: SavedPlaylist = {
    id: playlistId,
    name: basePlaylistName,
    createdAt: now,
    updatedAt: now,
    mode: cfg.mode,
    category: `Programación: ${task.name}`,
    format: task.format,
    outputPathHint:
      settings.schedulerOutputWindowsPath ||
      task.outputFolderName ||
      buildPlaylistOutputPathHint(settings),
    items: result.items,
    totalDuration: result.totalDuration,
    musicCount: result.musicCount,
    spotCount: result.spotCount,
    warnings: result.warnings,
  };

  await db.playlists.put(playlist);

  // Record non-spot music tracks in anti-repeat history
  const usageEntries = result.items
    .filter((it) => !it.isSpot)
    .map((it) => ({
      id: `${now}_${it.trackId}_${Math.random().toString(36).slice(2, 5)}`,
      trackId: it.trackId,
      artistNormalized: normalizeText(it.artist),
      playlistId: playlist.id,
      playlistName: playlist.name,
      usedAt: now,
    }));
  if (usageEntries.length > 0) {
    await db.usageHistory.bulkAdd(usageEntries);
  }

  // Build RadioBOSS M3U/M3U8 content and overwrite target file in chosen disk directory
  const { content, brokenItems, exportedCount } = await buildRadioBossM3UContent(
    playlist,
    task.format,
    task.pathMode
  );

  let diskWrite: {
    status: NonNullable<ScheduledTask['lastDiskWriteStatus']>;
    folderName: string;
    detail: string;
  };

  if (exportedCount === 0) {
    diskWrite = {
      status: 'error',
      folderName: task.outputFolderName || '',
      detail: 'Ninguna pista accesible para escribir en el archivo M3U/M3U8.',
    };
  } else {
    diskWrite = await writePlaylistContentToTaskFolder(
      task,
      outputFileName,
      content,
      Boolean(options.allowPermissionPrompt)
    );
  }

  const hasWarnings =
    result.warnings.length > 0 || brokenItems.length > 0 || diskWrite.status !== 'written';
  const status: 'success' | 'warning' = hasWarnings ? 'warning' : 'success';

  const summaryParts = [
    `${result.musicCount} canciones` +
      (result.spotCount > 0 ? ` + ${result.spotCount} spots` : ''),
    `${Math.round(result.totalDuration / 60)} min`,
    diskWrite.status === 'written'
      ? `Sobrescrito "${outputFileName}" en "${diskWrite.folderName}"`
      : diskWrite.detail,
  ];
  const msg = summaryParts.join(' · ');

  await db.schedules.update(task.id, {
    lastRunAt: now,
    lastStatus: status,
    lastMessage: msg,
    outputFolderName: diskWrite.folderName || task.outputFolderName,
    lastDiskWriteStatus: diskWrite.status,
    lastDiskWritePath:
      diskWrite.status === 'written'
        ? `${diskWrite.folderName}/${outputFileName}`
        : outputFileName,
    lastDiskWriteAt: diskWrite.status === 'written' ? now : task.lastDiskWriteAt ?? null,
  });

  await addActivityLog('scheduler', status, `Tarea "${task.name}" ejecutada`, msg);
  return {
    playlist,
    status,
    diskStatus: diskWrite.status,
    outputFileName,
    message: msg,
  };
}

export function getTaskScheduledTimes(task: Pick<ScheduledTask, 'time' | 'extraTimes'>): string[] {
  const times = [task.time, ...(task.extraTimes || [])]
    .map((t) => (t || '').trim())
    .map((t) => {
      const m = t.match(/^(\d{1,2}):(\d{2})$/);
      if (!m) return '';
      const hh = Number(m[1]);
      const mm = Number(m[2]);
      if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return '';
      return `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    })
    .filter(Boolean);
  return Array.from(new Set(times)).sort();
}

export function computeNextOccurrences(
  tasks: ScheduledTask[],
  limit = 5
): Array<{
  task: ScheduledTask;
  nextDate: Date;
  timeStr: string;
}> {
  const now = new Date();
  const results: Array<{ task: ScheduledTask; nextDate: Date; timeStr: string }> = [];

  for (const t of tasks) {
    if (!t.enabled) continue;
    const times = getTaskScheduledTimes(t);
    for (const timeStr of times) {
      const [hh, mm] = timeStr.split(':').map((n) => Number(n) || 0);
      for (let offset = 0; offset < 8; offset++) {
        const candidate = new Date(now);
        candidate.setDate(now.getDate() + offset);
        candidate.setHours(hh, mm, 0, 0);
        if (candidate <= now) continue;
        if (t.frequency === 'weekly' && !t.daysOfWeek.includes(candidate.getDay())) {
          continue;
        }
        results.push({ task: t, nextDate: candidate, timeStr });
        break;
      }
    }
  }

  return results
    .sort((a, b) => a.nextDate.getTime() - b.nextDate.getTime())
    .slice(0, limit);
}

export interface SchedulerCheckSummary {
  ran: number;
  succeeded: number;
  warnings: number;
  errors: number;
  pendingPermissionCount: number;
  noFolderCount: number;
  messages: string[];
}

export async function flushPendingDiskWrites(): Promise<number> {
  if (!supportsFileSystemAccess()) return 0;
  const schedules = await db.schedules.toArray();
  const pending = schedules.filter(
    (t) =>
      t.lastDiskWriteStatus === 'pending-permission' ||
      t.lastDiskWriteStatus === 'no-folder'
  );
  if (pending.length === 0) return 0;

  let flushed = 0;
  for (const task of pending) {
    const fixedPlaylist = await db.playlists.get(`pl_sch_fixed_${task.id}`);
    const playlist =
      fixedPlaylist ||
      (await db.playlists
        .filter((p) => p.category === `Programación: ${task.name}`)
        .toArray()
        .then((arr) => arr.sort((a, b) => b.updatedAt - a.updatedAt)[0]));
    if (!playlist || playlist.items.length === 0) continue;

    const outputFileName = resolveScheduledOutputFilename(task);
    const { content, brokenItems, exportedCount } = await buildRadioBossM3UContent(
      playlist,
      task.format,
      task.pathMode
    );
    if (exportedCount === 0) continue;

    const diskWrite = await writePlaylistContentToTaskFolder(
      task,
      outputFileName,
      content,
      false
    );
    if (diskWrite.status === 'written') {
      const now = Date.now();
      const hasWarnings = (playlist.warnings?.length || 0) > 0 || brokenItems.length > 0;
      const msg = [
        `${playlist.musicCount} canciones` +
          (playlist.spotCount > 0 ? ` + ${playlist.spotCount} spots` : ''),
        `${Math.round(playlist.totalDuration / 60)} min`,
        `Sobrescrito "${outputFileName}" en "${diskWrite.folderName}"`,
      ].join(' · ');

      await db.schedules.update(task.id, {
        lastStatus: hasWarnings ? 'warning' : 'success',
        lastMessage: msg,
        outputFolderName: diskWrite.folderName || task.outputFolderName,
        lastDiskWriteStatus: 'written',
        lastDiskWritePath: `${diskWrite.folderName}/${outputFileName}`,
        lastDiskWriteAt: now,
      });
      await addActivityLog(
        'scheduler',
        'success',
        `Archivo pendiente guardado en disco: "${task.name}"`,
        msg
      );
      flushed++;
    }
  }
  return flushed;
}

const CATCH_UP_ARMED_WINDOW_MS = 3 * 60 * 60 * 1000; // 3 hours catch-up if tab was backgrounded/asleep
const CATCH_UP_LEGACY_WINDOW_MS = 15 * 60 * 1000; // 15 min catch-up for legacy tasks without armedAt

let activeCheckPromise: Promise<SchedulerCheckSummary> | null = null;

async function runCheckDueSchedulesInternal(): Promise<SchedulerCheckSummary> {
  const schedules = await db.schedules.toArray();
  const now = new Date();
  const nowMs = now.getTime();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const dayOfMonth = now.getDate();
  const currentHHMM = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const currentDay = now.getDay();

  const summary: SchedulerCheckSummary = {
    ran: 0,
    succeeded: 0,
    warnings: 0,
    errors: 0,
    pendingPermissionCount: 0,
    noFolderCount: 0,
    messages: [],
  };

  for (const task of schedules) {
    if (!task.enabled) continue;
    if (task.frequency === 'weekly' && !task.daysOfWeek.includes(currentDay)) continue;

    const taskTimes = getTaskScheduledTimes(task);
    if (taskTimes.length === 0) continue;

    const alreadyExecuted = new Set<string>(task.executedSlotKeys || []);
    if (task.lastSlotKey) alreadyExecuted.add(task.lastSlotKey);

    const dueSlots: Array<{ timeStr: string; slotKey: string; slotMs: number }> = [];

    for (const timeStr of taskTimes) {
      const [hh, mm] = timeStr.split(':').map((n) => Number(n) || 0);
      const slotDate = new Date(year, month - 1, dayOfMonth, hh, mm, 0, 0);
      const slotMs = slotDate.getTime();
      const slotEndMs = slotMs + 59_999;
      const slotKey = `${year}-${month}-${dayOfMonth}_${timeStr}`;

      if (alreadyExecuted.has(slotKey)) continue;
      if (nowMs < slotMs) continue;

      const isCurrentMinute = timeStr === currentHHMM;
      if (!isCurrentMinute) {
        if (typeof task.armedAt === 'number') {
          if (slotEndMs < task.armedAt) continue;
          if (nowMs - slotMs > CATCH_UP_ARMED_WINDOW_MS) continue;
        } else {
          if (nowMs - slotMs > CATCH_UP_LEGACY_WINDOW_MS) continue;
        }
      }

      dueSlots.push({ timeStr, slotKey, slotMs });
    }

    if (dueSlots.length === 0) continue;

    // If multiple slots of the same fixed-filename overwriting task came due while asleep,
    // coalesce earlier slots and execute only the latest one so we don't burn tracks on immediate self-overwrites.
    const variesPerSlot =
      task.overwriteExisting === false || Boolean(task.outputFileName?.includes('{HH-MM}'));
    const slotsToRun =
      !variesPerSlot && dueSlots.length > 1 ? [dueSlots[dueSlots.length - 1]] : dueSlots;

    const allMarkedKeys = Array.from(
      new Set([...alreadyExecuted, ...dueSlots.map((s) => s.slotKey)])
    ).slice(-30);

    await db.schedules.update(task.id, {
      lastSlotKey: dueSlots[dueSlots.length - 1].slotKey,
      executedSlotKeys: allMarkedKeys,
    });

    for (const slot of slotsToRun) {
      try {
        const res = await executeScheduledTask(task, { allowPermissionPrompt: false });
        summary.ran++;
        if (res.status === 'success') summary.succeeded++;
        else if (res.status === 'warning') summary.warnings++;
        else summary.errors++;

        if (res.diskStatus === 'pending-permission') summary.pendingPermissionCount++;
        if (res.diskStatus === 'no-folder') summary.noFolderCount++;
        summary.messages.push(`${task.name} (${slot.timeStr}): ${res.message}`);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Error inesperado al ejecutar programación.';
        summary.ran++;
        summary.errors++;
        summary.messages.push(`${task.name} (${slot.timeStr}): ${errMsg}`);
        await db.schedules.update(task.id, {
          lastRunAt: Date.now(),
          lastStatus: 'error',
          lastMessage: errMsg,
        });
        await addActivityLog('scheduler', 'error', `Error en tarea "${task.name}"`, errMsg);
      }
    }
  }

  return summary;
}

export async function checkDueSchedules(): Promise<SchedulerCheckSummary> {
  if (activeCheckPromise) {
    return activeCheckPromise;
  }

  const runWithCrossTabLock = async (): Promise<SchedulerCheckSummary> => {
    const nav = typeof navigator !== 'undefined' ? navigator : undefined;
    const locks = (nav as Navigator & {
      locks?: {
        request: <T>(
          name: string,
          options: { ifAvailable?: boolean },
          cb: (lock: unknown | null) => Promise<T>
        ) => Promise<T>;
      };
    })?.locks;

    if (locks?.request) {
      return locks.request(
        'smart-playlist-scheduler-lock',
        { ifAvailable: true },
        async (lock) => {
          if (!lock) {
            return {
              ran: 0,
              succeeded: 0,
              warnings: 0,
              errors: 0,
              pendingPermissionCount: 0,
              noFolderCount: 0,
              messages: [],
            };
          }
          return runCheckDueSchedulesInternal();
        }
      );
    }
    return runCheckDueSchedulesInternal();
  };

  activeCheckPromise = runWithCrossTabLock().finally(() => {
    activeCheckPromise = null;
  });
  return activeCheckPromise;
}
