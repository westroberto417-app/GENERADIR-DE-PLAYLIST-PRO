import type {
  AppSettings,
  LinkedFolder,
  ScheduledTask,
  TrackRecord,
  UsageHistoryEntry,
} from '../types/studio';

export interface DesktopBridgeRecentRun {
  jobName?: string;
  lastRunAt?: string;
  file?: string;
  reason?: string;
  itemsCount?: number;
}

export interface DesktopBridgeStatus {
  connected: boolean;
  mode: 'browser-pwa' | 'windows-x64-bridge';
  engineVersion?: string;
  capabilities: string[];
  message: string;
  jobsCount?: number;
  syncedTracksCount?: number;
  syncedAt?: number | null;
  scheduledTriggersCount?: number;
  recentRuns?: DesktopBridgeRecentRun[];
}

export interface DesktopBridgeSyncResult {
  ok: boolean;
  syncedTracksCount?: number;
  scheduledTriggersCount?: number;
  message?: string;
}

export interface IDesktopBridge {
  checkConnection(baseUrl: string): Promise<DesktopBridgeStatus>;
  syncWithBridge(
    baseUrl: string,
    payload: {
      schedules: ScheduledTask[];
      settings: AppSettings;
      folders: LinkedFolder[];
      tracks: TrackRecord[];
      usageHistory: UsageHistoryEntry[];
    }
  ): Promise<DesktopBridgeSyncResult>;
  triggerJobOnBridge(
    baseUrl: string,
    jobId: string
  ): Promise<{ ok: boolean; file?: string; message?: string }>;
  buildAPSchedulerConfig(
    schedules: ScheduledTask[],
    settings: AppSettings,
    folders: LinkedFolder[]
  ): Record<string, unknown>;
}

export const desktopBridge: IDesktopBridge = {
  async checkConnection(baseUrl: string): Promise<DesktopBridgeStatus> {
    const cleanUrl = (baseUrl || 'http://127.0.0.1:8765').replace(/\/+$/, '');
    try {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 1600);
      const res = await fetch(`${cleanUrl}/health`, {
        signal: controller.signal,
      });
      window.clearTimeout(timer);
      if (res.ok) {
        const data = (await res.json()) as {
          version?: string;
          capabilities?: string[];
          jobsCount?: number;
          syncedTracksCount?: number;
          syncedAt?: number | null;
          scheduledTriggersCount?: number;
          recentRuns?: DesktopBridgeRecentRun[];
        };
        return {
          connected: true,
          mode: 'windows-x64-bridge',
          engineVersion: data.version || '2.0.0',
          capabilities: data.capabilities || ['APScheduler', 'Mutagen', 'OfflineRecovery'],
          jobsCount: data.jobsCount ?? 0,
          syncedTracksCount: data.syncedTracksCount ?? 0,
          syncedAt: data.syncedAt ?? null,
          scheduledTriggersCount: data.scheduledTriggersCount ?? 0,
          recentRuns: data.recentRuns || [],
          message: `Puente local Windows 24/7 conectado (${data.scheduledTriggersCount ?? 0} disparos APScheduler activos · ${data.syncedTracksCount ?? 0} pistas sincronizadas).`,
        };
      }
    } catch {
      // Expected in standalone browser PWA mode when local Python daemon isn't running
    }

    return {
      connected: false,
      mode: 'browser-pwa',
      capabilities: ['FileSystemAccessAPI', 'IndexedDB', 'WebAudioDSP', 'WebWorkers'],
      message:
        'Puente Windows Python (127.0.0.1:8765) no detectado en ejecución. La app sigue trabajando en modo PWA local; inicia Iniciar_DesktopBridge.bat si deseas respaldo 24/7 sin navegador.',
    };
  },

  async syncWithBridge(baseUrl, { schedules, settings, folders, tracks, usageHistory }) {
    const cleanUrl = (baseUrl || 'http://127.0.0.1:8765').replace(/\/+$/, '');
    const bridgeConfig = this.buildAPSchedulerConfig(schedules, settings, folders);
    const slimTracks = tracks.map((t) => ({
      id: t.id,
      folderId: t.folderId,
      relativePath: t.relativePath,
      fileName: t.fileName,
      title: t.title,
      artist: t.artist,
      genre: t.genre,
      year: t.year,
      decade: t.decade,
      duration: t.duration,
      bpm: t.bpm,
      energyScore: t.energyScore,
      energyLevel: t.energyLevel,
      intensity: t.intensity,
      mood: t.mood,
      duplicateKey: t.duplicateKey,
      isSpotFolder: t.isSpotFolder,
      accessible: t.accessible,
    }));
    const slimUsage = usageHistory.slice(-10000).map((u) => ({
      trackId: u.trackId,
      usedAt: u.usedAt,
      playlistName: u.playlistName,
    }));

    try {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 15000);
      const res = await fetch(`${cleanUrl}/sync`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          bridgeConfig,
          tracks: slimTracks,
          usageHistory: slimUsage,
        }),
        signal: controller.signal,
      });
      window.clearTimeout(timer);
      const data = (await res.json()) as DesktopBridgeSyncResult;
      if (!res.ok || !data.ok) {
        return {
          ok: false,
          message: data.message || `Error HTTP ${res.status} al sincronizar con DesktopBridge.`,
        };
      }
      return data;
    } catch (err) {
      return {
        ok: false,
        message:
          err instanceof Error
            ? `No se pudo conectar con ${cleanUrl}. Verifica que Iniciar_DesktopBridge.bat esté abierto.`
            : 'No se pudo conectar con DesktopBridge.',
      };
    }
  },

  async triggerJobOnBridge(baseUrl, jobId) {
    const cleanUrl = (baseUrl || 'http://127.0.0.1:8765').replace(/\/+$/, '');
    try {
      const res = await fetch(`${cleanUrl}/run-now/${encodeURIComponent(jobId)}`, {
        method: 'POST',
      });
      return (await res.json()) as { ok: boolean; file?: string; message?: string };
    } catch {
      return { ok: false, message: 'DesktopBridge no respondió al ejecutar la tarea.' };
    }
  },

  buildAPSchedulerConfig(
    schedules: ScheduledTask[],
    settings: AppSettings,
    folders: LinkedFolder[]
  ) {
    return {
      schema: 'smart-playlist-ai-studio-apscheduler-v1',
      generatedAt: new Date().toISOString(),
      targetRuntime: 'Windows x64 Python (APScheduler / Mutagen / OfflineRecovery)',
      settings: {
        antiRepeatHours: settings.antiRepeatHours,
        artistSeparation: settings.artistSeparation,
        defaultFormat: settings.defaultFormat,
        defaultPathMode: settings.defaultPathMode,
        storageRootPath: settings.storageRootPath,
        defaultExportSubfolder: settings.defaultExportSubfolder,
        globalFallbackPrefix: settings.globalFallbackPrefix,
        schedulerOutputFolderName: settings.schedulerOutputFolderName || '',
        schedulerOutputWindowsPath: settings.schedulerOutputWindowsPath || '',
        organizeByYearMonth: settings.organizeByYearMonth,
        rmsThresholds: settings.rmsThresholds,
      },
      folderMappings: folders.map((f) => ({
        folderId: f.id,
        name: f.name,
        role: f.role,
        windowsBasePath: f.windowsBasePath,
      })),
      jobs: schedules.map((s) => ({
        id: s.id,
        name: s.name,
        enabled: s.enabled,
        trigger: 'cron',
        times: [s.time, ...(s.extraTimes || [])].filter(Boolean),
        cron: {
          hour: Number(s.time.split(':')[0] || 0),
          minute: Number(s.time.split(':')[1] || 0),
          day_of_week:
            s.frequency === 'daily'
              ? '*'
              : s.daysOfWeek
                  .map((d) => ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][d])
                  .join(',') || '*',
        },
        criteria: {
          sourceScope: s.sourceScope || 'all',
          sourceFolderId: s.sourceFolderId || '',
          mode: s.mode || 'Combinado',
          progressiveCurve: { preset: 'Ascendente', segments: [28, 52, 76, 92] },
          noRepeatTracks: s.noRepeatTracks !== false,
          noRepeatArtists: s.noRepeatArtists !== false,
          respectAntiRepeat: s.respectAntiRepeat ?? true,
          fallbackToOldestOnExhaust: s.fallbackToOldestOnExhaust !== false,
          antiRepeatHours: s.antiRepeatHours ?? settings.antiRepeatHours,
          artistSeparation: s.artistSeparation ?? settings.artistSeparation,
          allowedGenres: s.allowedGenres,
          excludedGenres: s.excludedGenres,
          decades: s.decades || [],
          mood: s.mood,
          moods: s.mood && s.mood !== 'Todos' ? [s.mood] : [],
          bpmMin: s.bpmMin,
          bpmMax: s.bpmMax,
          intensities: s.intensities,
          spots: s.spots || null,
          targetType: s.targetType,
          targetDurationMin: s.targetDurationMin,
          targetCount: s.targetCount,
        },
        output: {
          format: s.format,
          pathMode: s.pathMode,
          outputFileName: s.outputFileName || '',
          overwriteExisting: s.overwriteExisting !== false,
          namePattern: s.namePattern,
          outputFolderName: s.outputFolderName || settings.schedulerOutputFolderName || '',
          outputWindowsPath: settings.schedulerOutputWindowsPath || '',
        },
      })),
    };
  },
};
