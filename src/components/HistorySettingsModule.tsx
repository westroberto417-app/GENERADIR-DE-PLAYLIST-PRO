import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3,
  CheckCircle2,
  Cpu,
  Database,
  Download,
  FolderSync,
  HardDrive,
  History,
  ListMusic,
  RotateCcw,
  Save,
  Search,
  Settings as SettingsIcon,
  ShieldCheck,
  Trash2,
  Upload,
  WifiOff,
} from 'lucide-react';
import {
  db,
  exportFullBackup,
  importFullBackup,
  type StudioBackupPayload,
} from '../db/database';
import { useStudio } from '../context/StudioContext';
import { desktopBridge, type DesktopBridgeStatus } from '../services/desktopBridge';
import { verifyAndRelinkFolder } from '../services/fileAccessService';
import {
  getOfflineReadinessStatus,
  warmOfflineCache,
  type OfflineReadinessState,
} from '../services/offlineService';
import { downloadTextFile, normalizeWindowsFolderPath } from '../services/radioboss';
import {
  buildDesktopBridgePyScript,
  buildStartBridgeBat,
  buildStartupInstallerBat,
} from '../services/windowsBridgeKit';
import { INTENSITY_LEVELS, type ActivityLogEntry, type PathExportMode } from '../types/studio';
import { formatDateTime, formatFileSize, formatLongDuration } from '../utils/formatters';
import { ConfirmDialog } from './ConfirmDialog';

type SectionTab = 'settings' | 'history' | 'stats';

export const HistorySettingsModule: React.FC = () => {
  const {
    activeModule,
    setActiveModule,
    tracks,
    folders,
    playlists,
    usageHistory,
    activityLogs,
    settings,
    updateSettings,
    refreshAll,
    showToast,
    syncingBridge,
    syncDesktopBridgeNow,
  } = useStudio();

  const restoreInputRef = useRef<HTMLInputElement>(null);

  const currentTab: SectionTab =
    activeModule === 'history' || activeModule === 'stats' || activeModule === 'settings'
      ? activeModule
      : 'settings';

  const [form, setForm] = useState(settings);
  const [genreInput, setGenreInput] = useState(settings.customGenres.join(', '));
  const [folderPaths, setFolderPaths] = useState<Record<string, string>>({});
  const [bridgeStatus, setBridgeStatus] = useState<DesktopBridgeStatus | null>(null);
  const [offlineState, setOfflineState] = useState<OfflineReadinessState | null>(null);
  const [warmingOffline, setWarmingOffline] = useState(false);

  const [historySubView, setHistorySubView] = useState<'operations' | 'usage'>('operations');
  const [logCategoryFilter, setLogCategoryFilter] = useState<'all' | ActivityLogEntry['category']>('all');
  const [logSearch, setLogSearch] = useState('');

  const [pendingConfirm, setPendingConfirm] = useState<
    | { type: 'remove-folder'; folderId: string; name: string }
    | { type: 'clear-logs' }
    | { type: 'clear-usage' }
    | null
  >(null);

  useEffect(() => {
    setForm(settings);
    setGenreInput(settings.customGenres.join(', '));
  }, [settings]);

  useEffect(() => {
    const map: Record<string, string> = {};
    for (const f of folders) {
      map[f.id] = f.windowsBasePath;
    }
    setFolderPaths(map);
  }, [folders]);

  const checkBridge = async () => {
    const status = await desktopBridge.checkConnection(form.desktopBridgeUrl);
    setBridgeStatus(status);
  };

  const refreshOfflineState = async () => {
    const st = await getOfflineReadinessStatus();
    setOfflineState(st);
  };

  const handlePrepareOffline = async () => {
    setWarmingOffline(true);
    try {
      const st = await warmOfflineCache();
      setOfflineState(st);
      if (st.swActive && st.cachedAssetCount > 0) {
        showToast(
          'success',
          `Modo offline listo (${st.cachedAssetCount} recursos en caché local${
            st.persistedStorage ? ' y almacenamiento persistente protegido' : ''
          }).`
        );
      } else {
        showToast(
          'info',
          'Verificación completada. Abre la app instalada en su propia pestaña para activar el Service Worker.'
        );
      }
    } finally {
      setWarmingOffline(false);
    }
  };

  useEffect(() => {
    checkBridge();
    void refreshOfflineState();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    const customGenres = genreInput
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);

    for (const f of folders) {
      const rawNext = folderPaths[f.id];
      if (rawNext !== undefined) {
        const normalized = normalizeWindowsFolderPath(rawNext);
        if (normalized && (normalized !== f.windowsBasePath || !f.pathConfirmed)) {
          await db.folders.update(f.id, {
            windowsBasePath: normalized,
            pathConfirmed: true,
          });
        }
      }
    }

    await updateSettings({
      ...form,
      storageRootPath: normalizeWindowsFolderPath(form.storageRootPath) || form.storageRootPath,
      globalFallbackPrefix:
        normalizeWindowsFolderPath(form.globalFallbackPrefix) || form.globalFallbackPrefix,
      organizeByYearMonth: form.organizeByYear || form.organizeByMonth,
      customGenres,
    });
    await refreshAll();
  };

  const handleExportBackup = async () => {
    const payload = await exportFullBackup();
    const ok = await downloadTextFile(
      `smart_playlist_studio_backup_${new Date().toISOString().slice(0, 10)}.json`,
      JSON.stringify(payload, null, 2),
      'application/json;charset=utf-8'
    );
    if (ok) {
      await refreshAll();
      showToast('success', 'Copia de seguridad JSON exportada.');
    }
  };

  const handleRestoreBackup = async (file: File) => {
    try {
      const raw = await file.text();
      const parsed = JSON.parse(raw) as StudioBackupPayload;
      const res = await importFullBackup(parsed);
      await refreshAll();
      showToast(
        'success',
        `Respaldo restaurado: ${res.tracks} canciones, ${res.playlists} playlists, ${res.schedules} tareas.`
      );
    } catch (err) {
      showToast(
        'error',
        err instanceof Error ? err.message : 'No se pudo importar el archivo JSON.'
      );
    }
  };

  const handleRelinkFolder = async (folderId: string) => {
    const res = await verifyAndRelinkFolder(folderId);
    await refreshAll();
    if (res.reauthorized) {
      showToast(
        'success',
        `Carpeta re-autorizada: ${res.verified} accesibles, ${res.inaccessible} no encontradas.`
      );
    } else {
      showToast(
        'info',
        `Sesión verificada: ${res.verified} en memoria, ${res.inaccessible} pendientes de re-importar.`
      );
    }
  };

  const executeConfirmedAction = async () => {
    if (!pendingConfirm) return;
    if (pendingConfirm.type === 'remove-folder') {
      const ids = await db.tracks.where('folderId').equals(pendingConfirm.folderId).primaryKeys();
      await db.tracks.bulkDelete(ids);
      await db.folders.delete(pendingConfirm.folderId);
      await db.folderHandles.delete(pendingConfirm.folderId);
      await refreshAll();
      showToast(
        'info',
        `Carpeta "${pendingConfirm.name}" desvinculada del catálogo (${ids.length} registros quitados).`
      );
    } else if (pendingConfirm.type === 'clear-logs') {
      await db.activityLogs.clear();
      await refreshAll();
      showToast('info', 'Registro de operaciones vaciado.');
    } else if (pendingConfirm.type === 'clear-usage') {
      await db.usageHistory.clear();
      await refreshAll();
      showToast('info', 'Historial anti-repetición reiniciado.');
    }
    setPendingConfirm(null);
  };

  const filteredLogs = useMemo(() => {
    const q = logSearch.trim().toLowerCase();
    return activityLogs.filter((log) => {
      if (logCategoryFilter !== 'all' && log.category !== logCategoryFilter) return false;
      if (!q) return true;
      return (
        log.title.toLowerCase().includes(q) ||
        log.detail.toLowerCase().includes(q) ||
        log.category.toLowerCase().includes(q)
      );
    });
  }, [activityLogs, logCategoryFilter, logSearch]);

  const trackById = useMemo(() => {
    const m = new Map<string, (typeof tracks)[number]>();
    for (const t of tracks) m.set(t.id, t);
    return m;
  }, [tracks]);

  const detailedStats = useMemo(() => {
    const music = tracks.filter((t) => !t.isSpotFolder);
    const totalBytes = tracks.reduce((s, t) => s + t.size, 0);
    const totalSeconds = music.reduce((s, t) => s + t.duration, 0);
    const withBpm = music.filter((t) => t.bpm !== null);
    const avgBpm =
      withBpm.length > 0
        ? Math.round(withBpm.reduce((s, t) => s + (t.bpm || 0), 0) / withBpm.length)
        : 0;

    // Catalog formats
    const formats = new Map<string, number>();
    for (const t of tracks) {
      formats.set(t.extension || 'otro', (formats.get(t.extension || 'otro') || 0) + 1);
    }

    // Usage / Playlists analytics (PDF Section 11)
    const usedGenres = new Map<string, number>();
    const usedArtists = new Map<string, number>();
    const usedDecades = new Map<string, number>();
    const intensityDist = new Map<string, number>();
    for (const lvl of INTENSITY_LEVELS) intensityDist.set(lvl, 0);

    let playlistBpmSum = 0;
    let playlistBpmCount = 0;

    const playlistItems = playlists.flatMap((p) => p.items.filter((i) => !i.isSpot));
    if (playlistItems.length > 0) {
      for (const item of playlistItems) {
        const g = item.genre || 'Sin género';
        usedGenres.set(g, (usedGenres.get(g) || 0) + 1);
        const a = item.artist || 'Artista desconocido';
        usedArtists.set(a, (usedArtists.get(a) || 0) + 1);

        const trackRef = trackById.get(item.trackId);
        const dec = trackRef?.decade || 'Sin década';
        usedDecades.set(dec, (usedDecades.get(dec) || 0) + 1);

        const inten = item.intensity || trackRef?.intensity;
        if (inten) intensityDist.set(inten, (intensityDist.get(inten) || 0) + 1);

        const bpmVal = item.bpm ?? trackRef?.bpm ?? null;
        if (bpmVal !== null) {
          playlistBpmSum += bpmVal;
          playlistBpmCount += 1;
        }
      }
    } else {
      // Fallback to catalog metrics if no playlists generated yet
      for (const t of music) {
        const g = t.genre || 'Sin género';
        usedGenres.set(g, (usedGenres.get(g) || 0) + 1);
        const a = t.artist || 'Artista desconocido';
        usedArtists.set(a, (usedArtists.get(a) || 0) + 1);
        usedDecades.set(t.decade || 'Sin década', (usedDecades.get(t.decade || 'Sin década') || 0) + 1);
        if (t.intensity) intensityDist.set(t.intensity, (intensityDist.get(t.intensity) || 0) + 1);
      }
    }

    // Top used tracks from usageHistory
    const trackUsageCount = new Map<string, { count: number; lastUsedAt: number }>();
    for (const u of usageHistory) {
      const prev = trackUsageCount.get(u.trackId);
      if (!prev) {
        trackUsageCount.set(u.trackId, { count: 1, lastUsedAt: u.usedAt });
      } else {
        trackUsageCount.set(u.trackId, {
          count: prev.count + 1,
          lastUsedAt: Math.max(prev.lastUsedAt, u.usedAt),
        });
      }
    }

    const topTracks = Array.from(trackUsageCount.entries())
      .map(([trackId, meta]) => {
        const ref = trackById.get(trackId);
        return {
          trackId,
          title: ref?.title || 'Pista no enlazada',
          artist: ref?.artist || 'Artista desconocido',
          genre: ref?.genre || '—',
          count: meta.count,
          lastUsedAt: meta.lastUsedAt,
        };
      })
      .sort((a, b) => b.count - a.count || b.lastUsedAt - a.lastUsedAt)
      .slice(0, 10);

    const avgPlaylistBpm = playlistBpmCount > 0 ? Math.round(playlistBpmSum / playlistBpmCount) : 0;

    return {
      totalTracks: tracks.length,
      musicCount: music.length,
      spotsCount: tracks.length - music.length,
      playlistsCount: playlists.length,
      usageCount: usageHistory.length,
      totalBytes,
      totalSeconds,
      avgBpm,
      avgPlaylistBpm,
      usingPlaylistScope: playlistItems.length > 0,
      formats: Array.from(formats.entries()).sort((a, b) => b[1] - a[1]),
      topGenres: Array.from(usedGenres.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8),
      topArtists: Array.from(usedArtists.entries()).sort((a, b) => b[1] - a[1]).slice(0, 8),
      topDecades: Array.from(usedDecades.entries()).sort((a, b) => b[1] - a[1]),
      intensityBreakdown: INTENSITY_LEVELS.map((lvl) => ({
        level: lvl,
        count: intensityDist.get(lvl) || 0,
      })),
      topTracks,
    };
  }, [tracks, playlists, usageHistory, trackById]);

  const maxGenreCount = Math.max(1, ...detailedStats.topGenres.map((g) => g[1]));
  const maxIntensityCount = Math.max(1, ...detailedStats.intensityBreakdown.map((i) => i.count));

  return (
    <div className="space-y-4">
      <input
        ref={restoreInputRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            handleRestoreBackup(file);
            e.target.value = '';
          }
        }}
      />

      {/* Synchronized Sub-navigation Tabs */}
      <div className="inline-flex flex-wrap items-center gap-1 p-1 rounded-lg bg-[#101726] border border-slate-800">
        {[
          { id: 'history' as SectionTab, label: `Historial (${activityLogs.length})`, icon: History },
          { id: 'stats' as SectionTab, label: 'Estadísticas', icon: BarChart3 },
          { id: 'settings' as SectionTab, label: 'Configuración & Unidades', icon: SettingsIcon },
        ].map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveModule(item.id)}
              className={`inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-md text-xs font-medium cursor-pointer ${
                currentTab === item.id
                  ? 'bg-slate-800 text-cyan-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              {item.label}
            </button>
          );
        })}
      </div>

      {currentTab === 'settings' && (
        <form onSubmit={handleSaveSettings} className="space-y-4 text-xs">
          {/* Linked Folders & Multi-Drive Windows/NAS Mapping */}
          <div className="rounded-xl border border-slate-800/80 bg-[#101726] p-5 space-y-3">
            <div className="flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-cyan-400" />
              <h3 className="text-sm font-semibold text-slate-100">
                Carpetas vinculadas y Mapeo multi-unidad Windows / RadioBOSS
              </h3>
            </div>
            <p className="text-slate-400">
              Asigna la ruta real de Windows o red (ej.{' '}
              <span className="font-mono text-slate-300">D:\RadioBOSS\Pop</span>,{' '}
              <span className="font-mono text-slate-300">E:\Archivo_Rock</span>,{' '}
              <span className="font-mono text-slate-300">\\NAS\Audio</span>) para cada carpeta al exportar en modo Multi-unidad.
            </p>

            {folders.length === 0 ? (
              <p className="py-4 text-slate-500">No hay carpetas vinculadas aún.</p>
            ) : (
              <div className="divide-y divide-slate-800/70">
                {folders.map((f) => (
                  <div
                    key={f.id}
                    className="py-3 flex flex-col lg:flex-row lg:items-center gap-3"
                  >
                    <div className="lg:w-56 shrink-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={`rounded px-1.5 py-0.5 text-[10px] font-mono font-semibold ${
                            f.role === 'spots'
                              ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                              : 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30'
                          }`}
                        >
                          {f.role === 'spots' ? 'SPOTS' : 'MÚSICA'}
                        </span>
                        <span className="font-semibold text-slate-100 truncate">{f.name}</span>
                      </div>
                      <p className="text-[11px] text-slate-500 mt-0.5 font-mono">
                        {f.trackCount} pistas · {f.sourceType}
                      </p>
                    </div>

                    <input
                      type="text"
                      value={folderPaths[f.id] ?? f.windowsBasePath}
                      onChange={(e) =>
                        setFolderPaths((prev) => ({ ...prev, [f.id]: e.target.value }))
                      }
                      className="flex-1 rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 font-mono text-slate-100"
                      placeholder="D:\RadioBOSS\Musica"
                    />

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        type="button"
                        onClick={() => handleRelinkFolder(f.id)}
                        className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-slate-200 hover:bg-slate-800 cursor-pointer"
                      >
                        <FolderSync className="w-3.5 h-3.5 text-emerald-400" />
                        Re-autorizar
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setPendingConfirm({
                            type: 'remove-folder',
                            folderId: f.id,
                            name: f.name,
                          })
                        }
                        className="inline-flex items-center gap-1 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-rose-300 hover:bg-rose-500/20 cursor-pointer"
                        title="Quitar del catálogo"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Export, Organization & RMS Calibration */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="rounded-xl border border-slate-800/80 bg-[#101726] p-5 space-y-3">
              <h3 className="text-sm font-semibold text-slate-100">
                Exportación, Estructura y Reglas por defecto
              </h3>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-400 mb-1">Formato predeterminado</label>
                  <select
                    value={form.defaultFormat}
                    onChange={(e) =>
                      setForm((s) => ({ ...s, defaultFormat: e.target.value as 'm3u8' | 'm3u' }))
                    }
                    className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 text-slate-100"
                  >
                    <option value="m3u8">M3U8 (UTF-8)</option>
                    <option value="m3u">M3U clásico</option>
                  </select>
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Modo de rutas</label>
                  <select
                    value={form.defaultPathMode}
                    onChange={(e) =>
                      setForm((s) => ({ ...s, defaultPathMode: e.target.value as PathExportMode }))
                    }
                    className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 text-slate-100"
                  >
                    <option value="multi-drive">Multi-unidad</option>
                    <option value="absolute">Absoluta</option>
                    <option value="relative">Relativa</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-400 mb-1">Carpeta raíz de salida</label>
                  <input
                    type="text"
                    value={form.storageRootPath}
                    onChange={(e) =>
                      setForm((s) => ({ ...s, storageRootPath: e.target.value }))
                    }
                    placeholder="D:\SMART PLAYLIST AI"
                    className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 font-mono text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Subcarpeta de playlists</label>
                  <input
                    type="text"
                    value={form.defaultExportSubfolder}
                    onChange={(e) =>
                      setForm((s) => ({ ...s, defaultExportSubfolder: e.target.value }))
                    }
                    placeholder="Playlists"
                    className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 font-mono text-slate-100"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-400 mb-1">
                  Prefijo global de respaldo (Windows/NAS)
                </label>
                <input
                  type="text"
                  value={form.globalFallbackPrefix}
                  onChange={(e) =>
                    setForm((s) => ({ ...s, globalFallbackPrefix: e.target.value }))
                  }
                  className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 font-mono text-slate-100"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-400 mb-1">
                    Ventana anti-repetición (horas)
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={720}
                    value={form.antiRepeatHours}
                    onChange={(e) =>
                      setForm((s) => ({ ...s, antiRepeatHours: Number(e.target.value) || 0 }))
                    }
                    className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 font-mono text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Separación artistas (pistas)</label>
                  <input
                    type="number"
                    min={0}
                    max={20}
                    value={form.artistSeparation}
                    onChange={(e) =>
                      setForm((s) => ({ ...s, artistSeparation: Number(e.target.value) || 0 }))
                    }
                    className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 font-mono text-slate-100"
                  />
                </div>
              </div>

              <div className="flex flex-wrap gap-4 pt-1">
                <label className="inline-flex items-center gap-2 text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.organizeByYear}
                    onChange={(e) =>
                      setForm((s) => ({
                        ...s,
                        organizeByYear: e.target.checked,
                        organizeByYearMonth: e.target.checked || s.organizeByMonth,
                      }))
                    }
                    className="accent-cyan-500"
                  />
                  Organizar por año (\2026)
                </label>
                <label className="inline-flex items-center gap-2 text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.organizeByMonth}
                    onChange={(e) =>
                      setForm((s) => ({
                        ...s,
                        organizeByMonth: e.target.checked,
                        organizeByYearMonth: s.organizeByYear || e.target.checked,
                      }))
                    }
                    className="accent-cyan-500"
                  />
                  Organizar por mes (\Noviembre)
                </label>
              </div>

              <div className="pt-2 border-t border-slate-800/70 space-y-2">
                <div>
                  <label className="block text-slate-400 mb-1">Modo de análisis predeterminado</label>
                  <select
                    value={form.defaultAnalysisMode}
                    onChange={(e) =>
                      setForm((s) => ({
                        ...s,
                        defaultAnalysisMode: e.target.value as typeof form.defaultAnalysisMode,
                      }))
                    }
                    className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 text-slate-100"
                  >
                    <option value="fast-metadata-bpm">
                      Rápido: Metadatos comunes + Género + BPM (Motor DJ)
                    </option>
                    <option value="full-dsp">
                      Completo DSP (BPM + Energía + Valencia + Ambiente)
                    </option>
                  </select>
                </div>
                <label className="inline-flex items-center gap-2 text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.autoBackgroundAnalysis}
                    onChange={(e) =>
                      setForm((s) => ({ ...s, autoBackgroundAnalysis: e.target.checked }))
                    }
                    className="accent-cyan-500"
                  />
                  Ejecutar análisis en segundo plano automáticamente al importar carpetas
                </label>
              </div>
            </div>

            <div className="rounded-xl border border-slate-800/80 bg-[#101726] p-5 space-y-3">
              <h3 className="text-sm font-semibold text-slate-100">
                Calibración DSP (Umbrales RMS dBFS) y Géneros
              </h3>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5">
                {[
                  { key: 'verySoftMax', label: 'Muy suave ≤' },
                  { key: 'softMax', label: 'Suave ≤' },
                  { key: 'mediumMax', label: 'Media ≤' },
                  { key: 'highMax', label: 'Alta ≤' },
                ].map((item) => (
                  <div key={item.key}>
                    <label className="block text-slate-400 mb-1">{item.label}</label>
                    <input
                      type="number"
                      step="0.5"
                      value={form.rmsThresholds[item.key as keyof typeof form.rmsThresholds]}
                      onChange={(e) =>
                        setForm((s) => ({
                          ...s,
                          rmsThresholds: {
                            ...s.rmsThresholds,
                            [item.key]: Number(e.target.value),
                          },
                        }))
                      }
                      className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-2.5 py-2 font-mono text-slate-100"
                    />
                  </div>
                ))}
              </div>
              <div>
                <label className="block text-slate-400 mb-1">
                  Géneros configurados (separados por coma)
                </label>
                <textarea
                  rows={2}
                  value={genreInput}
                  onChange={(e) => setGenreInput(e.target.value)}
                  className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 text-slate-100"
                />
              </div>

              {/* DesktopBridge Status */}
              <div className="rounded-lg border border-slate-800 bg-[#090d16] p-3 space-y-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="inline-flex items-center gap-1.5 font-semibold text-slate-200">
                    <Cpu className="w-3.5 h-3.5 text-violet-400" />
                    DesktopBridge Windows x64 (24/7 Offline)
                  </span>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      disabled={syncingBridge}
                      onClick={() => void syncDesktopBridgeNow(false)}
                      className="inline-flex items-center gap-1 rounded bg-violet-500/20 border border-violet-500/40 px-2 py-0.5 text-[11px] font-medium text-violet-200 hover:bg-violet-500/30 cursor-pointer disabled:opacity-50"
                    >
                      Sincronizar
                    </button>
                    <button
                      type="button"
                      onClick={checkBridge}
                      className="inline-flex items-center gap-1 text-cyan-400 hover:text-cyan-300 cursor-pointer"
                    >
                      <RotateCcw className="w-3 h-3" />
                      Comprobar
                    </button>
                  </div>
                </div>
                <input
                  type="text"
                  value={form.desktopBridgeUrl}
                  onChange={(e) => setForm((s) => ({ ...s, desktopBridgeUrl: e.target.value }))}
                  className="w-full rounded border border-slate-800 bg-[#101726] px-2.5 py-1.5 font-mono text-slate-200"
                />
                {bridgeStatus && (
                  <p className={`text-[11px] ${bridgeStatus.connected ? 'text-emerald-300' : 'text-slate-400'}`}>
                    {bridgeStatus.message}
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() =>
                      void downloadTextFile('desktop_bridge.py', buildDesktopBridgePyScript(), 'text/x-python;charset=utf-8')
                    }
                    className="rounded border border-slate-700 bg-[#101726] px-2.5 py-1 text-[11px] text-cyan-200 hover:bg-slate-800 cursor-pointer"
                  >
                    desktop_bridge.py
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void downloadTextFile('Iniciar_DesktopBridge.bat', buildStartBridgeBat(), 'text/plain;charset=utf-8')
                    }
                    className="rounded border border-slate-700 bg-[#101726] px-2.5 py-1 text-[11px] text-emerald-200 hover:bg-slate-800 cursor-pointer"
                  >
                    Iniciar_DesktopBridge.bat
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void downloadTextFile(
                        'Activar_Inicio_Con_Windows.bat',
                        buildStartupInstallerBat(),
                        'text/plain;charset=utf-8'
                      )
                    }
                    className="rounded border border-slate-700 bg-[#101726] px-2.5 py-1 text-[11px] text-amber-200 hover:bg-slate-800 cursor-pointer"
                  >
                    Activar_Inicio_Con_Windows.bat
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Offline Independence & Local PWA Storage */}
          <div className="rounded-xl border border-slate-800/80 bg-[#101726] p-5 space-y-3">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
              <div className="space-y-1">
                <h3 className="text-sm font-semibold text-slate-100 flex items-center gap-2">
                  <WifiOff className="w-4 h-4 text-emerald-400" />
                  Independencia de Internet y Operación 100% Offline
                </h3>
                <p className="text-slate-400">
                  Tipografías, motor DSP Web Audio, analizador en Web Workers, generador inteligente, programador automático, exportación RadioBOSS y base IndexedDB se ejecutan localmente sin servidores externos.
                </p>
              </div>
              <button
                type="button"
                disabled={warmingOffline}
                onClick={() => void handlePrepareOffline()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3.5 py-2 text-xs font-semibold text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-50 shrink-0 cursor-pointer"
              >
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                {warmingOffline ? 'Verificando caché...' : 'Preparar y verificar modo offline'}
              </button>
            </div>

            {offlineState && (
              <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5 pt-1">
                <div className="rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2">
                  <p className="text-[11px] text-slate-400">Service Worker Offline</p>
                  <p className="font-mono font-semibold text-slate-100 mt-0.5 flex items-center gap-1.5">
                    <CheckCircle2
                      className={`w-3.5 h-3.5 ${
                        offlineState.swActive ? 'text-emerald-400' : 'text-amber-400'
                      }`}
                    />
                    {offlineState.swActive
                      ? offlineState.swControlled
                        ? 'Activo y controlando'
                        : 'Instalado (recarga para activar)'
                      : 'Pendiente en esta vista'}
                  </p>
                </div>

                <div className="rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2">
                  <p className="text-[11px] text-slate-400">Recursos en Caché Local</p>
                  <p className="font-mono font-semibold text-cyan-300 mt-0.5 tabular-nums">
                    {offlineState.cachedAssetCount} archivos
                  </p>
                </div>

                <div className="rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2">
                  <p className="text-[11px] text-slate-400">Protección IndexedDB</p>
                  <p className="font-mono font-semibold text-slate-100 mt-0.5">
                    {offlineState.persistedStorage === true
                      ? 'Persistente (protegida)'
                      : offlineState.persistedStorage === false
                      ? 'Estándar del navegador'
                      : 'Local automática'}
                  </p>
                </div>

                <div className="rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2">
                  <p className="text-[11px] text-slate-400">Uso local / Red</p>
                  <p className="font-mono font-semibold text-slate-200 mt-0.5 tabular-nums">
                    {offlineState.storageUsageBytes !== null
                      ? formatFileSize(offlineState.storageUsageBytes)
                      : 'IndexedDB'}{' '}
                    · {offlineState.isOnline ? 'En línea' : 'Sin internet'}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Save & JSON Backup Bar */}
          <div className="rounded-xl border border-slate-800/80 bg-[#101726] p-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={handleExportBackup}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/80 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 cursor-pointer"
              >
                <Download className="w-4 h-4 text-emerald-400" />
                Exportar respaldo completo JSON
              </button>
              <button
                type="button"
                onClick={() => restoreInputRef.current?.click()}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/80 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 cursor-pointer"
              >
                <Upload className="w-4 h-4 text-blue-400" />
                Restaurar respaldo JSON
              </button>
            </div>

            <button
              type="submit"
              className="inline-flex items-center gap-2 rounded-lg bg-cyan-500 px-5 py-2 text-xs font-semibold text-slate-950 hover:bg-cyan-400 cursor-pointer"
            >
              <Save className="w-4 h-4" />
              Guardar configuración
            </button>
          </div>
        </form>
      )}

      {currentTab === 'history' && (
        <div className="rounded-xl border border-slate-800/80 bg-[#101726] p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="inline-flex items-center gap-1 p-1 rounded-lg bg-[#090d16] border border-slate-800">
              <button
                type="button"
                onClick={() => setHistorySubView('operations')}
                className={`px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer ${
                  historySubView === 'operations'
                    ? 'bg-slate-800 text-cyan-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Registro de operaciones ({activityLogs.length})
              </button>
              <button
                type="button"
                onClick={() => setHistorySubView('usage')}
                className={`px-3 py-1.5 rounded-md text-xs font-medium cursor-pointer ${
                  historySubView === 'usage'
                    ? 'bg-slate-800 text-cyan-300'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Historial anti-repetición ({usageHistory.length})
              </button>
            </div>

            {historySubView === 'operations' ? (
              <button
                type="button"
                disabled={activityLogs.length === 0}
                onClick={() => setPendingConfirm({ type: 'clear-logs' })}
                className="text-xs text-slate-400 hover:text-rose-300 disabled:opacity-40 cursor-pointer"
              >
                Limpiar registro
              </button>
            ) : (
              <button
                type="button"
                disabled={usageHistory.length === 0}
                onClick={() => setPendingConfirm({ type: 'clear-usage' })}
                className="text-xs text-slate-400 hover:text-rose-300 disabled:opacity-40 cursor-pointer"
              >
                Reiniciar historial de pistas
              </button>
            )}
          </div>

          {historySubView === 'operations' ? (
            <>
              <div className="flex flex-col sm:flex-row gap-2">
                <div className="relative flex-1">
                  <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={logSearch}
                    onChange={(e) => setLogSearch(e.target.value)}
                    placeholder="Buscar evento en el historial..."
                    className="w-full rounded-lg border border-slate-800 bg-[#090d16] pl-8 pr-3 py-2 text-xs text-slate-100"
                  />
                </div>
                <select
                  value={logCategoryFilter}
                  onChange={(e) =>
                    setLogCategoryFilter(e.target.value as 'all' | ActivityLogEntry['category'])
                  }
                  className="rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 text-xs text-slate-200"
                >
                  <option value="all">Todas las categorías</option>
                  <option value="scan">Escaneo</option>
                  <option value="analysis">Análisis DSP</option>
                  <option value="generator">Generador</option>
                  <option value="export">Exportación</option>
                  <option value="scheduler">Programador</option>
                  <option value="validator">Validador</option>
                  <option value="backup">Respaldo</option>
                </select>
              </div>

              {filteredLogs.length === 0 ? (
                <p className="py-10 text-center text-xs text-slate-500">
                  Sin eventos registrados con el filtro actual.
                </p>
              ) : (
                <div className="divide-y divide-slate-800/70 text-xs max-h-[540px] overflow-y-auto">
                  {filteredLogs.map((log) => (
                    <div
                      key={log.id}
                      className="py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-1"
                    >
                      <div className="min-w-0">
                        <span
                          className={`font-mono font-semibold mr-2 ${
                            log.level === 'success'
                              ? 'text-emerald-400'
                              : log.level === 'warning'
                              ? 'text-amber-400'
                              : log.level === 'error'
                              ? 'text-rose-400'
                              : 'text-cyan-400'
                          }`}
                        >
                          [{log.category.toUpperCase()}]
                        </span>
                        <span className="font-medium text-slate-100">{log.title}</span>
                        <span className="text-slate-400"> · {log.detail}</span>
                      </div>
                      <span className="font-mono text-slate-500 shrink-0 tabular-nums">
                        {formatDateTime(log.timestamp)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </>
          ) : usageHistory.length === 0 ? (
            <p className="py-10 text-center text-xs text-slate-500">
              Aún no hay pistas registradas en el historial de utilización. Genera una playlist para comenzar el control anti-repetición.
            </p>
          ) : (
            <div className="divide-y divide-slate-800/70 text-xs max-h-[540px] overflow-y-auto">
              {usageHistory.map((u) => {
                const trackRef = trackById.get(u.trackId);
                return (
                  <div
                    key={u.id}
                    className="py-2.5 flex flex-col sm:flex-row sm:items-center justify-between gap-1"
                  >
                    <div className="min-w-0">
                      <span className="font-medium text-slate-100">
                        {trackRef ? `${trackRef.artist} — ${trackRef.title}` : u.trackId}
                      </span>
                      <span className="text-slate-400"> · Playlist: {u.playlistName}</span>
                    </div>
                    <span className="font-mono text-slate-500 shrink-0 tabular-nums">
                      {formatDateTime(u.usedAt)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {currentTab === 'stats' && (
        <div className="space-y-4 text-xs">
          {/* Top KPI Row */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <div className="rounded-xl border border-slate-800/80 bg-[#101726] p-4">
              <p className="text-[11px] text-slate-400">Playlists generadas</p>
              <p className="text-2xl font-bold font-mono tabular-nums text-cyan-300 mt-1">
                {detailedStats.playlistsCount}
              </p>
              <p className="text-[11px] text-slate-500 mt-0.5 font-mono tabular-nums">
                {detailedStats.usageCount} emisiones registradas
              </p>
            </div>
            <div className="rounded-xl border border-slate-800/80 bg-[#101726] p-4">
              <p className="text-[11px] text-slate-400">BPM promedio</p>
              <p className="text-2xl font-bold font-mono tabular-nums text-violet-300 mt-1">
                {detailedStats.usingPlaylistScope
                  ? detailedStats.avgPlaylistBpm || detailedStats.avgBpm || '—'
                  : detailedStats.avgBpm || '—'}
              </p>
              <p className="text-[11px] text-slate-500 mt-0.5 font-mono tabular-nums">
                Catálogo: {detailedStats.avgBpm || '—'} BPM
              </p>
            </div>
            <div className="rounded-xl border border-slate-800/80 bg-[#101726] p-4">
              <p className="text-[11px] text-slate-400">Duración acumulada</p>
              <p className="text-2xl font-bold font-mono tabular-nums text-emerald-300 mt-1">
                {formatLongDuration(detailedStats.totalSeconds)}
              </p>
              <p className="text-[11px] text-slate-500 mt-0.5 font-mono tabular-nums">
                {detailedStats.musicCount} música · {detailedStats.spotsCount} spots
              </p>
            </div>
            <div className="rounded-xl border border-slate-800/80 bg-[#101726] p-4">
              <p className="text-[11px] text-slate-400">Peso total indexado</p>
              <p className="text-2xl font-bold font-mono tabular-nums text-slate-100 mt-1">
                {formatFileSize(detailedStats.totalBytes)}
              </p>
              <p className="text-[11px] text-slate-500 mt-0.5 font-mono tabular-nums">
                {detailedStats.totalTracks} archivos totales
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Most Used Genres */}
            <div className="rounded-xl border border-slate-800/80 bg-[#101726] p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-100">Géneros más utilizados</h3>
                <span className="text-[11px] text-slate-500">
                  {detailedStats.usingPlaylistScope ? 'En playlists' : 'En biblioteca'}
                </span>
              </div>
              {detailedStats.topGenres.length === 0 ? (
                <p className="text-slate-500 py-4">Sin datos todavía.</p>
              ) : (
                <div className="space-y-2.5">
                  {detailedStats.topGenres.map(([genre, count]) => (
                    <div key={genre} className="space-y-1">
                      <div className="flex justify-between">
                        <span className="text-slate-200">{genre}</span>
                        <span className="font-mono tabular-nums text-cyan-300">{count}</span>
                      </div>
                      <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                        <div
                          className="h-full bg-cyan-500 rounded-full"
                          style={{ width: `${(count / maxGenreCount) * 100}%` }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Intensity Distribution */}
            <div className="rounded-xl border border-slate-800/80 bg-[#101726] p-5 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-slate-100">
                  Distribución de intensidad
                </h3>
                <span className="text-[11px] text-slate-500">
                  {detailedStats.usingPlaylistScope ? 'En playlists' : 'En biblioteca'}
                </span>
              </div>
              <div className="space-y-2.5">
                {detailedStats.intensityBreakdown.map(({ level, count }) => (
                  <div key={level} className="space-y-1">
                    <div className="flex justify-between">
                      <span className="text-slate-200">{level}</span>
                      <span className="font-mono tabular-nums text-violet-300">{count}</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-slate-800 overflow-hidden">
                      <div
                        className="h-full bg-violet-500 rounded-full"
                        style={{ width: `${(count / maxIntensityCount) * 100}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Most Frequent Artists */}
            <div className="rounded-xl border border-slate-800/80 bg-[#101726] p-5 space-y-3">
              <h3 className="text-sm font-semibold text-slate-100">Artistas más frecuentes</h3>
              {detailedStats.topArtists.length === 0 ? (
                <p className="text-slate-500 py-4">Sin datos todavía.</p>
              ) : (
                <div className="divide-y divide-slate-800/60">
                  {detailedStats.topArtists.map(([artist, count], idx) => (
                    <div key={artist} className="py-2 flex items-center justify-between gap-2">
                      <span className="text-slate-200 truncate">
                        <span className="font-mono text-slate-500 mr-2">{idx + 1}.</span>
                        {artist}
                      </span>
                      <span className="font-mono tabular-nums text-emerald-300 shrink-0">
                        {count}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* Predominant Decades & Formats */}
            <div className="rounded-xl border border-slate-800/80 bg-[#101726] p-5 space-y-4">
              <div>
                <h3 className="text-sm font-semibold text-slate-100 mb-2">
                  Décadas predominantes
                </h3>
                {detailedStats.topDecades.length === 0 ? (
                  <p className="text-slate-500">Sin datos todavía.</p>
                ) : (
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                    {detailedStats.topDecades.map(([decade, count]) => (
                      <div
                        key={decade}
                        className="rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 flex items-center justify-between font-mono tabular-nums"
                      >
                        <span className="text-slate-300">{decade}</span>
                        <span className="text-cyan-300 font-semibold">{count}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="pt-2 border-t border-slate-800/70">
                <h4 className="text-xs font-semibold text-slate-200 mb-2 flex items-center gap-1.5">
                  <Database className="w-3.5 h-3.5 text-cyan-400" />
                  Formatos de audio detectados
                </h4>
                {detailedStats.formats.length === 0 ? (
                  <p className="text-slate-500">Sin datos todavía.</p>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {detailedStats.formats.map(([ext, count]) => (
                      <span
                        key={ext}
                        className="rounded-md border border-slate-800 bg-[#090d16] px-2.5 py-1 font-mono tabular-nums text-slate-200 uppercase"
                      >
                        {ext}: <strong className="text-cyan-300">{count}</strong>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Most Used Tracks */}
          <div className="rounded-xl border border-slate-800/80 bg-[#101726] p-5 space-y-3">
            <div className="flex items-center gap-2">
              <ListMusic className="w-4 h-4 text-cyan-400" />
              <h3 className="text-sm font-semibold text-slate-100">Canciones más utilizadas</h3>
            </div>
            {detailedStats.topTracks.length === 0 ? (
              <p className="text-slate-500 py-4">
                Aún no se han registrado canciones utilizadas en playlists generadas.
              </p>
            ) : (
              <div className="divide-y divide-slate-800/60">
                {detailedStats.topTracks.map((t, idx) => (
                  <div
                    key={t.trackId}
                    className="py-2 flex flex-col sm:flex-row sm:items-center justify-between gap-1"
                  >
                    <div className="min-w-0">
                      <span className="font-mono text-slate-500 mr-2">#{idx + 1}</span>
                      <span className="font-medium text-slate-100">{t.artist}</span>
                      <span className="text-slate-400"> — {t.title}</span>
                      <span className="ml-2 text-[11px] text-slate-500">({t.genre})</span>
                    </div>
                    <div className="flex items-center gap-4 shrink-0 font-mono tabular-nums">
                      <span className="text-cyan-300">{t.count} usos</span>
                      <span className="text-slate-500">{formatDateTime(t.lastUsedAt)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={pendingConfirm !== null}
        title={
          pendingConfirm?.type === 'remove-folder'
            ? 'Desvincular carpeta del catálogo'
            : pendingConfirm?.type === 'clear-logs'
            ? 'Vaciar registro de operaciones'
            : 'Reiniciar historial anti-repetición'
        }
        message={
          pendingConfirm?.type === 'remove-folder'
            ? `Se quitarán del catálogo local las pistas indexadas de "${pendingConfirm.name}". Los archivos de audio reales en tu disco o NAS permanecerán intactos.`
            : pendingConfirm?.type === 'clear-logs'
            ? 'Se eliminarán todos los registros de actividad almacenados en IndexedDB.'
            : 'Se borrará el registro de uso reciente de canciones, permitiendo que vuelvan a ser elegibles de inmediato.'
        }
        confirmLabel={
          pendingConfirm?.type === 'remove-folder' ? 'Desvincular' : 'Sí, confirmar'
        }
        onConfirm={executeConfirmedAction}
        onCancel={() => setPendingConfirm(null)}
      />
    </div>
  );
};
