import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import {
  DEFAULT_SETTINGS,
  db,
  getSettings,
  saveSettings,
  sessionFileRegistry,
} from '../db/database';
import {
  audioAnalyzer,
  rehydrateMissingTrackFiles,
  trackNeedsAudioDecode,
  type AnalysisBatchProgress,
} from '../services/audioAnalyzer';
import {
  desktopBridge,
  type DesktopBridgeStatus,
} from '../services/desktopBridge';
import {
  healFalseInaccessibleTracks,
  scanDirectoryWithHandle,
  scanFilesFromInput,
  supportsFileSystemAccess,
  type ScanProgress,
} from '../services/fileAccessService';
import {
  SCHEDULER_GLOBAL_OUTPUT_HANDLE_ID,
  checkDueSchedules,
  computeNextOccurrences,
  flushPendingDiskWrites,
  getSchedulerDirectoryStatus,
  pickSchedulerOutputDirectory,
  requestSchedulerDirectoryPermission,
  type SchedulerCheckSummary,
  type SchedulerDirectoryStatus,
} from '../services/schedulerService';
import type {
  ActivityLogEntry,
  AnalysisMode,
  AppSettings,
  GeneratorProfile,
  LinkedFolder,
  ModuleId,
  PlaylistGeneratorConfig,
  PlaylistItem,
  SavedPlaylist,
  ScheduledTask,
  TrackRecord,
  UsageHistoryEntry,
} from '../types/studio';

export const createDefaultGeneratorConfig = (
  cfg: AppSettings = DEFAULT_SETTINGS,
  defaultSpotFolderId = ''
): PlaylistGeneratorConfig => ({
  name: 'Playlist Inteligente',
  templateId: '',
  sourceScope: 'all',
  sourceFolderId: '',
  targetType: 'duration',
  targetDurationMin: 60,
  targetCount: 18,
  mode: 'Progresivo',
  progressiveCurve: {
    preset: 'Ascendente',
    segments: [28, 52, 76, 92],
  },
  allowedGenres: [],
  excludedGenres: [],
  decades: [],
  years: [],
  includedArtists: [],
  excludedArtists: [],
  bpmMin: null,
  bpmMax: null,
  energyMin: null,
  energyMax: null,
  energyLevels: [],
  intensities: [],
  moods: [],
  noRepeatTracks: true,
  noRepeatArtists: false,
  respectAntiRepeat: true,
  antiRepeatHours: cfg.antiRepeatHours,
  artistSeparation: cfg.artistSeparation,
  spots: {
    enabled: false,
    spotFolderId: defaultSpotFolderId,
    everyNSongs: 3,
    rotationMode: 'sequential',
    insertIntroAtStart: true,
  },
});

interface StudioContextValue {
  activeModule: ModuleId;
  setActiveModule: (m: ModuleId) => void;
  tracks: TrackRecord[];
  folders: LinkedFolder[];
  playlists: SavedPlaylist[];
  generatorProfiles: GeneratorProfile[];
  schedules: ScheduledTask[];
  usageHistory: UsageHistoryEntry[];
  activityLogs: ActivityLogEntry[];
  settings: AppSettings;
  isLoading: boolean;
  scanProgress: ScanProgress | null;
  analysisProgress: AnalysisBatchProgress;
  pendingGeneratorTrackIds: string[];
  setPendingGeneratorTrackIds: React.Dispatch<React.SetStateAction<string[]>>;
  editingPlaylist: SavedPlaylist | null;
  setEditingPlaylist: React.Dispatch<React.SetStateAction<SavedPlaylist | null>>;
  generatorConfig: PlaylistGeneratorConfig;
  setGeneratorConfig: React.Dispatch<React.SetStateAction<PlaylistGeneratorConfig>>;
  generatorPreviewItems: PlaylistItem[];
  setGeneratorPreviewItems: React.Dispatch<React.SetStateAction<PlaylistItem[]>>;
  generatorWarnings: string[];
  setGeneratorWarnings: React.Dispatch<React.SetStateAction<string[]>>;
  generatorEditingId: string | null;
  setGeneratorEditingId: React.Dispatch<React.SetStateAction<string | null>>;
  selectedRadioBossPlaylistId: string;
  setSelectedRadioBossPlaylistId: React.Dispatch<React.SetStateAction<string>>;
  needsAudioRelink: boolean;
  setNeedsAudioRelink: React.Dispatch<React.SetStateAction<boolean>>;
  schedulerGlobalDirStatus: SchedulerDirectoryStatus;
  lastSchedulerTickAt: number | null;
  nextScheduledOccurrence: { task: ScheduledTask; nextDate: Date; timeStr: string } | null;
  runSchedulerCheckNow: () => Promise<SchedulerCheckSummary>;
  authorizeSchedulerDiskAndFlush: () => Promise<void>;
  bridgeStatus: DesktopBridgeStatus | null;
  syncingBridge: boolean;
  refreshBridgeStatus: () => Promise<DesktopBridgeStatus>;
  syncDesktopBridgeNow: (silent?: boolean) => Promise<boolean>;
  toast: { type: 'info' | 'success' | 'warning' | 'error'; text: string } | null;
  showToast: (type: 'info' | 'success' | 'warning' | 'error', text: string) => void;
  refreshAll: () => Promise<void>;
  updateSettings: (patch: Partial<AppSettings>) => Promise<void>;
  importFolderViaPicker: (
    role: 'music' | 'spots',
    existingFolderId?: string | null,
    onFallbackInput?: () => void
  ) => Promise<LinkedFolder | null>;
  importFilesViaInput: (
    files: FileList,
    role: 'music' | 'spots',
    label: string,
    existingFolderId?: string
  ) => Promise<LinkedFolder | null>;
  cancelScan: () => void;
  startBatchAnalysis: (
    targetTracks: TrackRecord[],
    forceReanalyze?: boolean,
    concurrency?: number,
    mode?: AnalysisMode,
    isBackground?: boolean
  ) => Promise<void>;
  startBackgroundPendingAnalysis: (folderId?: string) => Promise<void>;
  pauseAnalysis: () => void;
  resumeAnalysis: () => void;
  cancelAnalysis: () => void;
}

const StudioContext = createContext<StudioContextValue | null>(null);

export const StudioProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [activeModule, setActiveModule] = useState<ModuleId>('dashboard');
  const [tracks, setTracks] = useState<TrackRecord[]>([]);
  const [folders, setFolders] = useState<LinkedFolder[]>([]);
  const [playlists, setPlaylists] = useState<SavedPlaylist[]>([]);
  const [generatorProfiles, setGeneratorProfiles] = useState<GeneratorProfile[]>([]);
  const [schedules, setSchedules] = useState<ScheduledTask[]>([]);
  const [usageHistory, setUsageHistory] = useState<UsageHistoryEntry[]>([]);
  const [activityLogs, setActivityLogs] = useState<ActivityLogEntry[]>([]);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [isLoading, setIsLoading] = useState(true);

  const [scanProgress, setScanProgress] = useState<ScanProgress | null>(null);
  const scanAbortRef = useRef<AbortController | null>(null);

  const [analysisProgress, setAnalysisProgress] = useState<AnalysisBatchProgress>({
    status: 'idle',
    mode: 'fast-metadata-bpm',
    isBackground: false,
    total: 0,
    completed: 0,
    succeeded: 0,
    failed: 0,
    skippedUnchanged: 0,
    currentTrackTitle: '',
  });

  const [pendingGeneratorTrackIds, setPendingGeneratorTrackIds] = useState<string[]>([]);
  const [editingPlaylist, setEditingPlaylist] = useState<SavedPlaylist | null>(null);
  const [generatorConfig, setGeneratorConfig] = useState<PlaylistGeneratorConfig>(() =>
    createDefaultGeneratorConfig(DEFAULT_SETTINGS)
  );
  const [generatorPreviewItems, setGeneratorPreviewItems] = useState<PlaylistItem[]>([]);
  const [generatorWarnings, setGeneratorWarnings] = useState<string[]>([]);
  const [generatorEditingId, setGeneratorEditingId] = useState<string | null>(null);
  const [selectedRadioBossPlaylistId, setSelectedRadioBossPlaylistId] = useState<string>('');
  const [needsAudioRelink, setNeedsAudioRelink] = useState<boolean>(false);
  const [schedulerGlobalDirStatus, setSchedulerGlobalDirStatus] =
    useState<SchedulerDirectoryStatus>({
      supported: supportsFileSystemAccess(),
      hasHandle: false,
      folderName: '',
      permission: supportsFileSystemAccess() ? 'unlinked' : 'unsupported',
    });
  const [lastSchedulerTickAt, setLastSchedulerTickAt] = useState<number | null>(null);
  const [bridgeStatus, setBridgeStatus] = useState<DesktopBridgeStatus | null>(null);
  const [syncingBridge, setSyncingBridge] = useState(false);
  const [toast, setToast] = useState<{ type: 'info' | 'success' | 'warning' | 'error'; text: string } | null>(null);
  const toastTimerRef = useRef<number | null>(null);

  const showToast = useCallback(
    (type: 'info' | 'success' | 'warning' | 'error', text: string) => {
      setToast({ type, text });
      if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
      toastTimerRef.current = window.setTimeout(() => setToast(null), 5500);
    },
    []
  );

  const hasHealedStartupRef = useRef(false);

  const refreshAll = useCallback(async () => {
    if (!hasHealedStartupRef.current) {
      hasHealedStartupRef.current = true;
      try {
        await healFalseInaccessibleTracks();
      } catch {
        // ignore startup healing failures
      }
    }
    const [t, f, p, gp, s, u, l, cfg, dirStatus] = await Promise.all([
      db.tracks.toArray(),
      db.folders.orderBy('lastScannedAt').reverse().toArray(),
      db.playlists.orderBy('updatedAt').reverse().toArray(),
      db.generatorProfiles.orderBy('createdAt').reverse().toArray(),
      db.schedules.toArray(),
      db.usageHistory.orderBy('usedAt').reverse().limit(500).toArray(),
      db.activityLogs.orderBy('timestamp').reverse().limit(300).toArray(),
      getSettings(),
      getSchedulerDirectoryStatus(SCHEDULER_GLOBAL_OUTPUT_HANDLE_ID),
    ]);
    setTracks(t);
    setFolders(f);
    setPlaylists(p);
    setGeneratorProfiles(gp);
    setSchedules(s);
    setUsageHistory(u);
    setActivityLogs(l);
    setSettings(cfg);
    setSchedulerGlobalDirStatus(dirStatus);
    setIsLoading(false);
  }, []);

  useEffect(() => {
    refreshAll();
  }, [refreshAll]);

  const mountedRef = useRef(true);
  const wasOfflineRef = useRef(
    typeof navigator !== 'undefined' ? !navigator.onLine : false
  );
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const handleOffline = () => {
      wasOfflineRef.current = true;
      showToast(
        'info',
        'Sin conexión a internet: modo 100% local activo. Catálogo, analizador DSP, generador, programador y RadioBOSS siguen operativos.'
      );
    };
    const handleOnline = () => {
      if (wasOfflineRef.current) {
        wasOfflineRef.current = false;
        showToast('success', 'Conexión restablecida. Todos tus datos locales permanecen intactos.');
      }
    };
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
    };
  }, [showToast]);

  const refreshBridgeStatus = useCallback(async (): Promise<DesktopBridgeStatus> => {
    const st = await desktopBridge.checkConnection(settings.desktopBridgeUrl);
    if (mountedRef.current) {
      setBridgeStatus(st);
    }
    return st;
  }, [settings.desktopBridgeUrl]);

  const syncDesktopBridgeNow = useCallback(
    async (silent = false): Promise<boolean> => {
      if (mountedRef.current) setSyncingBridge(true);
      try {
        const fullUsage = await db.usageHistory.toArray();
        const res = await desktopBridge.syncWithBridge(settings.desktopBridgeUrl, {
          schedules,
          settings,
          folders,
          tracks,
          usageHistory: fullUsage,
        });
        await refreshBridgeStatus();
        if (res.ok) {
          if (!silent) {
            showToast(
              'success',
              `Puente Windows 24/7 sincronizado: ${res.syncedTracksCount ?? tracks.length} pistas y ${res.scheduledTriggersCount ?? 0} disparos APScheduler activos.`
            );
          }
          return true;
        }
        if (!silent) {
          showToast('warning', res.message || 'No se pudo sincronizar con DesktopBridge Windows.');
        }
        return false;
      } finally {
        if (mountedRef.current) setSyncingBridge(false);
      }
    },
    [folders, refreshBridgeStatus, schedules, settings, showToast, tracks]
  );

  // Check Windows DesktopBridge presence on startup and keep alive every 30s
  useEffect(() => {
    if (isLoading) return;
    void refreshBridgeStatus();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void refreshBridgeStatus();
      }
    }, 30000);
    return () => window.clearInterval(timer);
  }, [isLoading, refreshBridgeStatus]);

  // Auto-sync schedules/catalog changes to Windows DesktopBridge while connected
  useEffect(() => {
    if (isLoading || !bridgeStatus?.connected) return;
    const debounce = window.setTimeout(() => {
      void syncDesktopBridgeNow(true);
    }, 900);
    return () => window.clearTimeout(debounce);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoading, bridgeStatus?.connected, schedules, settings, folders, tracks.length]);

  const runSchedulerCheckNow = useCallback(async (): Promise<SchedulerCheckSummary> => {
    const summary = await checkDueSchedules();
    if (mountedRef.current) {
      setLastSchedulerTickAt(Date.now());
    }
    if (summary.ran > 0 && mountedRef.current) {
      await refreshAll();
      if (summary.errors > 0 && summary.succeeded === 0 && summary.warnings === 0) {
        showToast(
          'error',
          summary.messages[0] || `${summary.errors} programación(es) fallaron al generar.`
        );
      } else if (summary.pendingPermissionCount > 0) {
        showToast(
          'warning',
          `${summary.ran} playlist(s) generada(s) en catálogo, pero falta autorizar escritura en disco ("Autorizar disco" arriba).`
        );
      } else if (summary.noFolderCount > 0) {
        showToast(
          'warning',
          `${summary.ran} playlist(s) generada(s) en catálogo. Vincula una carpeta en Programador para guardar el archivo en disco.`
        );
      } else if (summary.warnings > 0 || summary.errors > 0) {
        showToast(
          'warning',
          `${summary.ran} programación(es) procesada(s): ${summary.succeeded} ok, ${summary.warnings} con aviso, ${summary.errors} error(es).`
        );
      } else {
        showToast(
          'success',
          `${summary.ran} programación(es) ejecutada(s) y sobrescrita(s) en disco automáticamente.`
        );
      }
    }
    return summary;
  }, [refreshAll, showToast]);

  const authorizeSchedulerDiskAndFlush = useCallback(async () => {
    const status = await getSchedulerDirectoryStatus(SCHEDULER_GLOBAL_OUTPUT_HANDLE_ID);
    if (!status.supported) {
      showToast(
        'warning',
        'Esta vista embebida no permite escritura directa en disco. Abre el enlace directo en Chrome o Edge.'
      );
      return;
    }
    if (!status.hasHandle) {
      const pick = await pickSchedulerOutputDirectory(SCHEDULER_GLOBAL_OUTPUT_HANDLE_ID);
      if (!pick.ok) {
        if (pick.error) showToast('warning', pick.error);
        return;
      }
    } else {
      const perm = await requestSchedulerDirectoryPermission(SCHEDULER_GLOBAL_OUTPUT_HANDLE_ID);
      if (perm !== 'granted') {
        showToast('warning', 'El navegador no otorgó permiso de escritura sobre la carpeta.');
        await refreshAll();
        return;
      }
    }
    const flushed = await flushPendingDiskWrites();
    await runSchedulerCheckNow();
    await refreshAll();
    showToast(
      'success',
      flushed > 0
        ? `Escritura en disco autorizada. Se guardaron ${flushed} playlist(s) pendiente(s).`
        : 'Escritura automática en disco autorizada y activa.'
    );
  }, [refreshAll, runSchedulerCheckNow, showToast]);

  const nextScheduledOccurrence = React.useMemo(
    () => computeNextOccurrences(schedules, 1)[0] || null,
    [schedules]
  );

  // Dedicated Web Worker ticker + visibility/focus wakeups for background reliability
  useEffect(() => {
    if (isLoading) return;
    void runSchedulerCheckNow();

    let worker: Worker | null = null;
    let fallbackInterval: number | null = null;

    if (typeof Worker !== 'undefined') {
      try {
        worker = new Worker(new URL('../workers/schedulerWorker.ts', import.meta.url), {
          type: 'module',
        });
        worker.onmessage = (e: MessageEvent<{ type: string }>) => {
          if (e.data?.type === 'tick') {
            void runSchedulerCheckNow();
          }
        };
        worker.onerror = () => {
          if (fallbackInterval === null) {
            fallbackInterval = window.setInterval(() => {
              void runSchedulerCheckNow();
            }, 10000);
          }
        };
        worker.postMessage({ type: 'start', intervalMs: 5000 });
      } catch {
        fallbackInterval = window.setInterval(() => {
          void runSchedulerCheckNow();
        }, 10000);
      }
    } else {
      fallbackInterval = window.setInterval(() => {
        void runSchedulerCheckNow();
      }, 10000);
    }

    const onWake = () => {
      if (document.visibilityState === 'visible') {
        void runSchedulerCheckNow();
      }
    };
    const onFocusOrOnline = () => {
      void runSchedulerCheckNow();
    };

    document.addEventListener('visibilitychange', onWake);
    window.addEventListener('focus', onFocusOrOnline);
    window.addEventListener('online', onFocusOrOnline);

    return () => {
      if (worker) {
        worker.postMessage({ type: 'stop' });
        worker.terminate();
      }
      if (fallbackInterval !== null) {
        window.clearInterval(fallbackInterval);
      }
      document.removeEventListener('visibilitychange', onWake);
      window.removeEventListener('focus', onFocusOrOnline);
      window.removeEventListener('online', onFocusOrOnline);
    };
  }, [isLoading, runSchedulerCheckNow]);

  // Exact-time wake timer for the next scheduled occurrence
  useEffect(() => {
    if (isLoading || !nextScheduledOccurrence) return;
    const delayMs = nextScheduledOccurrence.nextDate.getTime() - Date.now() + 400;
    if (delayMs <= 0) {
      void runSchedulerCheckNow();
      return;
    }
    // Cap setTimeout below 2^31-1 (~24.8 days); weekly schedules are <= 7 days anyway
    const safeDelay = Math.min(delayMs, 2147000000);
    const exactTimer = window.setTimeout(() => {
      void runSchedulerCheckNow();
    }, safeDelay);
    return () => window.clearTimeout(exactTimer);
  }, [isLoading, nextScheduledOccurrence, runSchedulerCheckNow]);

  const updateSettings = useCallback(
    async (patch: Partial<AppSettings>) => {
      const next = await saveSettings(patch);
      setSettings(next);
      showToast('success', 'Configuración guardada en IndexedDB.');
    },
    [showToast]
  );

  const startBatchAnalysis = useCallback(
    async (
      targetTracks: TrackRecord[],
      forceReanalyze = false,
      concurrency?: number,
      mode?: AnalysisMode,
      isBackground = false
    ) => {
      if (targetTracks.length === 0) {
        if (!isBackground) showToast('info', 'No hay pistas pendientes para analizar.');
        return;
      }

      if (audioAnalyzer.isRunning()) {
        const added = audioAnalyzer.enqueueTracks(targetTracks);
        if (added > 0) {
          showToast(
            'info',
            `Se agregaron ${added} pistas a la cola de análisis en segundo plano.`
          );
        } else if (!isBackground) {
          showToast('info', 'Ya hay un análisis en curso.');
        }
        return;
      }

      const activeMode = mode || settings.defaultAnalysisMode || 'fast-metadata-bpm';

      await rehydrateMissingTrackFiles(targetTracks);
      const actionableCount = targetTracks.filter(
        (t) => !trackNeedsAudioDecode(t, activeMode) || sessionFileRegistry.has(t.id)
      ).length;

      if (actionableCount === 0) {
        setNeedsAudioRelink(true);
        if (!isBackground) {
          showToast(
            'warning',
            'El navegador cerró el acceso temporal al audio tras recargar. Pulsa "Re-vincular carpeta" para leer el audio sin perder tus datos.'
          );
        }
        return;
      }

      setNeedsAudioRelink(false);
      const res = await audioAnalyzer.runBatch(
        targetTracks,
        forceReanalyze,
        (p) => {
          setAnalysisProgress(p);
        },
        {
          concurrency,
          mode: activeMode,
          isBackground,
          onIntermediateRefresh: () => {
            void refreshAll();
          },
        }
      );
      await refreshAll();
      const hasRelinkPending = Boolean(res.needsRelinkCount && res.needsRelinkCount > 0);
      if (hasRelinkPending) {
        setNeedsAudioRelink(true);
      }

      if (res.status === 'cancelled') {
        showToast('warning', `Análisis cancelado (${res.completed}/${res.total} procesadas).`);
      } else {
        const speedStr = res.tracksPerSec ? ` · ${res.tracksPerSec} pistas/s` : '';
        const relinkNote = hasRelinkPending
          ? ` · ${res.needsRelinkCount} requieren re-vincular carpeta`
          : '';
        const label = activeMode === 'fast-metadata-bpm' ? 'Metadatos + BPM' : 'DSP Completo';
        showToast(
          res.failed > 0 || hasRelinkPending ? 'warning' : 'success',
          `${isBackground ? 'Análisis en 2º plano' : 'Análisis'} (${label}): ${res.succeeded} exitosas, ${res.skippedUnchanged} sin cambios, ${res.failed} errores${relinkNote}${speedStr}.`
        );
      }
    },
    [refreshAll, settings.defaultAnalysisMode, showToast]
  );

  const startBackgroundPendingAnalysis = useCallback(
    async (folderId?: string) => {
      const candidates = await db.tracks
        .filter((t) => {
          if (t.isSpotFolder) return false;
          if (folderId && t.folderId !== folderId) return false;
          if (t.analysisStatus !== 'pending') return false;
          return (
            sessionFileRegistry.has(t.id) ||
            (t.origins.bpm === 'ETIQUETA' && Boolean(t.bpm))
          );
        })
        .toArray();

      if (candidates.length === 0) {
        return;
      }
      void startBatchAnalysis(
        candidates,
        false,
        undefined,
        settings.defaultAnalysisMode || 'fast-metadata-bpm',
        true
      );
    },
    [settings.defaultAnalysisMode, startBatchAnalysis]
  );

  const importFolderViaPicker = useCallback(
    async (
      role: 'music' | 'spots',
      existingFolderId: string | null = null,
      onFallbackInput?: () => void
    ): Promise<LinkedFolder | null> => {
      if (!supportsFileSystemAccess()) {
        if (onFallbackInput) {
          onFallbackInput();
          return null;
        }
        showToast(
          'warning',
          'Este entorno no permite File System Access API directo. Usa el selector universal de carpetas/archivos.'
        );
        return null;
      }
      try {
        const dirHandle = await (
          window as unknown as { showDirectoryPicker: (opts?: unknown) => Promise<FileSystemDirectoryHandle> }
        ).showDirectoryPicker({ mode: 'read' });

        const ac = new AbortController();
        scanAbortRef.current = ac;

        const { folder, summary } = await scanDirectoryWithHandle(
          dirHandle,
          role,
          existingFolderId,
          ac.signal,
          (p) => setScanProgress(p)
        );
        await refreshAll();
        if (summary.phase === 'cancelled') {
          showToast('warning', 'Escaneo cancelado.');
        } else if (summary.totalDiscovered === 0) {
          showToast(
            'warning',
            `La carpeta "${folder.name}" no contiene archivos de audio compatibles (.mp3, .flac, .wav, .m4a, .aac, .ogg, .wma).`
          );
        } else {
          setNeedsAudioRelink(false);
          showToast(
            'success',
            `Carpeta "${folder.name}": ${summary.added} nuevas, ${summary.updated} actualizadas, ${summary.skippedUnchanged} sin cambios.`
          );
          if (role === 'music' && settings.autoBackgroundAnalysis) {
            void startBackgroundPendingAnalysis(folder.id);
          }
        }
        window.setTimeout(() => setScanProgress(null), 2500);
        return folder;
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          return null;
        }
        const msg = err instanceof Error ? err.message : '';
        const isSecurityBlock =
          (err instanceof DOMException && (err.name === 'SecurityError' || err.name === 'NotAllowedError')) ||
          /sub frames|cross origin|picker/i.test(msg);
        if (isSecurityBlock && onFallbackInput) {
          onFallbackInput();
          return null;
        }
        showToast(
          'error',
          msg || 'Error al acceder a la carpeta seleccionada.'
        );
        setScanProgress(null);
        return null;
      }
    },
    [refreshAll, settings.autoBackgroundAnalysis, showToast, startBackgroundPendingAnalysis]
  );

  const importFilesViaInput = useCallback(
    async (
      files: FileList,
      role: 'music' | 'spots',
      label: string,
      existingFolderId?: string
    ): Promise<LinkedFolder | null> => {
      if (!files || files.length === 0) return null;
      const ac = new AbortController();
      scanAbortRef.current = ac;
      try {
        const { folder, summary } = await scanFilesFromInput(
          files,
          role,
          label,
          ac.signal,
          (p) => setScanProgress(p),
          existingFolderId
        );
        await refreshAll();
        if (summary.totalDiscovered === 0) {
          showToast(
            'warning',
            `No se encontraron archivos de audio compatibles en "${folder.name}".`
          );
        } else {
          setNeedsAudioRelink(false);
          showToast(
            'success',
            `Importación "${folder.name}": ${summary.added} nuevas, ${summary.updated} actualizadas, ${summary.skippedUnchanged} sin cambios.`
          );
          if (role === 'music' && settings.autoBackgroundAnalysis) {
            void startBackgroundPendingAnalysis(folder.id);
          }
        }
        window.setTimeout(() => setScanProgress(null), 2500);
        return folder;
      } catch (err) {
        showToast(
          'error',
          err instanceof Error ? err.message : 'Error al procesar los archivos seleccionados.'
        );
        setScanProgress(null);
        return null;
      }
    },
    [refreshAll, settings.autoBackgroundAnalysis, showToast, startBackgroundPendingAnalysis]
  );

  const cancelScan = useCallback(() => {
    scanAbortRef.current?.abort();
  }, []);

  const pauseAnalysis = useCallback(() => {
    audioAnalyzer.pause();
    setAnalysisProgress((prev) => ({ ...prev, status: 'paused' }));
  }, []);

  const resumeAnalysis = useCallback(() => {
    audioAnalyzer.resume();
    setAnalysisProgress((prev) => ({ ...prev, status: 'running' }));
  }, []);

  const cancelAnalysis = useCallback(() => {
    audioAnalyzer.cancel();
  }, []);

  return (
    <StudioContext.Provider
      value={{
        activeModule,
        setActiveModule,
        tracks,
        folders,
        playlists,
        generatorProfiles,
        schedules,
        usageHistory,
        activityLogs,
        settings,
        isLoading,
        scanProgress,
        analysisProgress,
        pendingGeneratorTrackIds,
        setPendingGeneratorTrackIds,
        editingPlaylist,
        setEditingPlaylist,
        generatorConfig,
        setGeneratorConfig,
        generatorPreviewItems,
        setGeneratorPreviewItems,
        generatorWarnings,
        setGeneratorWarnings,
        generatorEditingId,
        setGeneratorEditingId,
        selectedRadioBossPlaylistId,
        setSelectedRadioBossPlaylistId,
        needsAudioRelink,
        setNeedsAudioRelink,
        schedulerGlobalDirStatus,
        lastSchedulerTickAt,
        nextScheduledOccurrence,
        runSchedulerCheckNow,
        authorizeSchedulerDiskAndFlush,
        bridgeStatus,
        syncingBridge,
        refreshBridgeStatus,
        syncDesktopBridgeNow,
        toast,
        showToast,
        refreshAll,
        updateSettings,
        importFolderViaPicker,
        importFilesViaInput,
        cancelScan,
        startBatchAnalysis,
        startBackgroundPendingAnalysis,
        pauseAnalysis,
        resumeAnalysis,
        cancelAnalysis,
      }}
    >
      {children}
    </StudioContext.Provider>
  );
};

export function useStudio(): StudioContextValue {
  const ctx = useContext(StudioContext);
  if (!ctx) throw new Error('useStudio debe usarse dentro de StudioProvider');
  return ctx;
}
