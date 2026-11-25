import React, { useMemo } from 'react';
import {
  Activity,
  AlertTriangle,
  CalendarClock,
  Clock,
  Copy,
  Disc3,
  FolderPlus,
  ListMusic,
  Music,
  RefreshCw,
  Sparkles,
  Tag,
  Users,
  Wand2,
} from 'lucide-react';
import { useStudio } from '../context/StudioContext';
import {
  supportsFileSystemAccess,
  verifyAllFoldersAccessibility,
} from '../services/fileAccessService';
import { computeNextOccurrences } from '../services/schedulerService';
import { formatDateTime, formatDuration, formatLongDuration } from '../utils/formatters';

export { computeNextOccurrences };

interface BarItem {
  label: string;
  count: number;
  pct: number;
  colorClass: string;
}

export const DashboardModule: React.FC = () => {
  const {
    tracks,
    folders,
    playlists,
    schedules,
    activityLogs,
    setActiveModule,
    setEditingPlaylist,
    importFolderViaPicker,
    importFilesViaInput,
    startBatchAnalysis,
    refreshAll,
    showToast,
  } = useStudio();

  const fileInputRef = React.useRef<HTMLInputElement>(null);

  const stats = useMemo(() => {
    const musicTracks = tracks.filter((t) => !t.isSpotFolder);
    const spotTracks = tracks.filter((t) => t.isSpotFolder);
    const analyzed = musicTracks.filter((t) => t.analysisStatus === 'analyzed').length;
    const pending = musicTracks.filter((t) => t.analysisStatus === 'pending').length;
    const errors = musicTracks.filter((t) => t.analysisStatus === 'error').length;
    const inaccessible = tracks.filter((t) => !t.accessible).length;
    const totalDuration = musicTracks.reduce((acc, t) => acc + (t.duration || 0), 0);
    const activeSchedules = schedules.filter((s) => s.enabled).length;

    const artistSet = new Set<string>();
    const albumSet = new Set<string>();
    const genreSet = new Set<string>();
    const dupCounts = new Map<string, number>();

    const genreMap = new Map<string, number>();
    const decadeMap = new Map<string, number>();
    const intensityMap = new Map<string, number>();

    for (const t of musicTracks) {
      if (t.artist && t.artist !== 'Desconocido') artistSet.add(t.artist.toLowerCase());
      if (t.album && t.album !== 'Sin álbum') albumSet.add(t.album.toLowerCase());
      if (t.genre && t.genre !== 'Desconocido') genreSet.add(t.genre.toLowerCase());

      dupCounts.set(t.duplicateKey, (dupCounts.get(t.duplicateKey) || 0) + 1);

      const g = t.genre || 'Desconocido';
      genreMap.set(g, (genreMap.get(g) || 0) + 1);

      const d = t.decade || 'Desconocida';
      decadeMap.set(d, (decadeMap.get(d) || 0) + 1);

      const inten = t.intensity || 'Sin analizar';
      intensityMap.set(inten, (intensityMap.get(inten) || 0) + 1);
    }

    let duplicateTracks = 0;
    for (const c of dupCounts.values()) {
      if (c > 1) duplicateTracks += c - 1;
    }

    const totalMusic = Math.max(1, musicTracks.length);
    const topGenres: BarItem[] = Array.from(genreMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([label, count]) => ({
        label,
        count,
        pct: Math.round((count / totalMusic) * 100),
        colorClass: 'bg-cyan-500',
      }));

    const topDecades: BarItem[] = Array.from(decadeMap.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([label, count]) => ({
        label,
        count,
        pct: Math.round((count / totalMusic) * 100),
        colorClass: 'bg-blue-500',
      }));

    const intensityOrder = ['Muy suave', 'Suave', 'Media', 'Alta', 'Muy alta', 'Sin analizar'];
    const intensityColors: Record<string, string> = {
      'Muy suave': 'bg-sky-400',
      'Suave': 'bg-cyan-400',
      'Media': 'bg-emerald-400',
      'Alta': 'bg-amber-400',
      'Muy alta': 'bg-rose-500',
      'Sin analizar': 'bg-slate-600',
    };
    const intensityBars: BarItem[] = intensityOrder
      .map((label) => {
        const count = intensityMap.get(label) || 0;
        return {
          label,
          count,
          pct: Math.round((count / totalMusic) * 100),
          colorClass: intensityColors[label] || 'bg-slate-500',
        };
      })
      .filter((item) => item.count > 0);

    return {
      totalMusic: musicTracks.length,
      totalSpots: spotTracks.length,
      uniqueArtists: artistSet.size,
      uniqueAlbums: albumSet.size,
      uniqueGenres: genreSet.size,
      analyzed,
      pending,
      errors,
      inaccessible,
      totalDuration,
      playlistsCount: playlists.length,
      activeSchedules,
      duplicateTracks,
      topGenres,
      topDecades,
      intensityBars,
    };
  }, [tracks, playlists, schedules]);

  const upcomingSchedules = useMemo(() => computeNextOccurrences(schedules, 5), [schedules]);

  const handleImportClick = () => {
    if (supportsFileSystemAccess()) {
      importFolderViaPicker('music', null, () => fileInputRef.current?.click());
    } else {
      fileInputRef.current?.click();
    }
  };

  const handleVerifyLibrary = async () => {
    if (folders.length === 0) {
      handleImportClick();
      return;
    }
    const res = await verifyAllFoldersAccessibility();
    await refreshAll();
    const relinkHint =
      res.needsSessionRelinkFolders > 0
        ? ` · ${res.needsSessionRelinkFolders} carpeta(s) requieren re-importar solo si deseas re-analizar audio`
        : '';
    showToast(
      res.inaccessible > 0 ? 'warning' : 'success',
      `Escaneo/verificación: ${res.verified} accesibles, ${res.inaccessible} faltantes${relinkHint}.`
    );
  };

  const pendingTracksList = useMemo(
    () => tracks.filter((t) => !t.isSpotFolder && t.analysisStatus === 'pending'),
    [tracks]
  );

  return (
    <div className="space-y-6">
      <input
        ref={fileInputRef}
        type="file"
        multiple
        // @ts-expect-error webkitdirectory
        webkitdirectory=""
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) {
            importFilesViaInput(e.target.files, 'music', 'Música Importada');
            e.target.value = '';
          }
        }}
      />

      {/* Quick Actions Banner */}
      <div className="rounded-xl border border-slate-800/80 bg-[#101726] p-5 flex flex-col xl:flex-row xl:items-center xl:justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">
            Resumen operativo del estudio
          </h2>
          <p className="text-sm text-slate-400 mt-1">
            Opción A confirmada: almacenamiento exclusivo de listas M3U/M3U8 sin copiar ni mover archivos de audio originales.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={handleImportClick}
            className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-500 px-3.5 py-2 text-xs font-semibold text-slate-950 hover:bg-cyan-400 transition-colors cursor-pointer"
          >
            <FolderPlus className="w-4 h-4" />
            Importar música
          </button>
          <button
            type="button"
            onClick={handleVerifyLibrary}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/80 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <RefreshCw className="w-4 h-4 text-blue-400" />
            Escanear biblioteca
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveModule('analyzer');
              if (pendingTracksList.length > 0) {
                startBatchAnalysis(pendingTracksList, false);
              }
            }}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/80 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <Sparkles className="w-4 h-4 text-violet-400" />
            Analizar canciones ({stats.pending})
          </button>
          <button
            type="button"
            onClick={() => setActiveModule('generator')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/80 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <Wand2 className="w-4 h-4 text-emerald-400" />
            Crear playlist
          </button>
          <button
            type="button"
            onClick={() => setActiveModule('scheduler')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/80 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <CalendarClock className="w-4 h-4 text-amber-400" />
            Programar generación
          </button>
        </div>
      </div>

      {/* Complete KPI Grid matching PDF Section 4 */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3.5">
        <div className="rounded-xl border border-slate-800/80 bg-[#101726] p-4">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Total canciones</span>
            <Music className="w-4 h-4 text-cyan-400" />
          </div>
          <p className="mt-2 text-2xl font-bold font-mono tabular-nums text-slate-100">
            {stats.totalMusic.toLocaleString()}
          </p>
          <p className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
            {stats.totalSpots} spots · {formatLongDuration(stats.totalDuration)}
          </p>
        </div>

        <div className="rounded-xl border border-slate-800/80 bg-[#101726] p-4">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Total artistas</span>
            <Users className="w-4 h-4 text-blue-400" />
          </div>
          <p className="mt-2 text-2xl font-bold font-mono tabular-nums text-slate-100">
            {stats.uniqueArtists.toLocaleString()}
          </p>
          <p className="mt-1 text-xs text-slate-500">Artistas identificados</p>
        </div>

        <div className="rounded-xl border border-slate-800/80 bg-[#101726] p-4">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Total álbumes</span>
            <Disc3 className="w-4 h-4 text-indigo-400" />
          </div>
          <p className="mt-2 text-2xl font-bold font-mono tabular-nums text-slate-100">
            {stats.uniqueAlbums.toLocaleString()}
          </p>
          <p className="mt-1 text-xs text-slate-500">Álbumes indexados</p>
        </div>

        <div className="rounded-xl border border-slate-800/80 bg-[#101726] p-4">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Géneros</span>
            <Tag className="w-4 h-4 text-emerald-400" />
          </div>
          <p className="mt-2 text-2xl font-bold font-mono tabular-nums text-slate-100">
            {stats.uniqueGenres.toLocaleString()}
          </p>
          <p className="mt-1 text-xs text-slate-500">Géneros identificados</p>
        </div>

        <div className="rounded-xl border border-slate-800/80 bg-[#101726] p-4">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Analizadas</span>
            <Activity className="w-4 h-4 text-violet-400" />
          </div>
          <p className="mt-2 text-2xl font-bold font-mono tabular-nums text-slate-100">
            {stats.analyzed.toLocaleString()}
          </p>
          <p className="mt-1 text-xs text-slate-500 font-mono tabular-nums">
            {stats.pending} pendientes · {stats.errors} err
          </p>
        </div>

        <div className="rounded-xl border border-slate-800/80 bg-[#101726] p-4">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Pendientes análisis</span>
            <Clock className="w-4 h-4 text-amber-400" />
          </div>
          <p className="mt-2 text-2xl font-bold font-mono tabular-nums text-slate-100">
            {stats.pending.toLocaleString()}
          </p>
          <p className="mt-1 text-xs text-slate-500">Sin análisis PCM</p>
        </div>

        <div className="rounded-xl border border-slate-800/80 bg-[#101726] p-4">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Playlists generadas</span>
            <ListMusic className="w-4 h-4 text-emerald-400" />
          </div>
          <p className="mt-2 text-2xl font-bold font-mono tabular-nums text-slate-100">
            {stats.playlistsCount}
          </p>
          <p className="mt-1 text-xs text-slate-500">Listas guardadas</p>
        </div>

        <div className="rounded-xl border border-slate-800/80 bg-[#101726] p-4">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Tareas programadas</span>
            <CalendarClock className="w-4 h-4 text-cyan-400" />
          </div>
          <p className="mt-2 text-2xl font-bold font-mono tabular-nums text-slate-100">
            {stats.activeSchedules}
          </p>
          <p className="mt-1 text-xs text-slate-500">de {schedules.length} configuradas</p>
        </div>

        <div className="rounded-xl border border-slate-800/80 bg-[#101726] p-4 col-span-2 sm:col-span-1 lg:col-span-2">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Integridad del catálogo</span>
            {stats.inaccessible > 0 ? (
              <AlertTriangle className="w-4 h-4 text-rose-400" />
            ) : (
              <Copy className="w-4 h-4 text-amber-400" />
            )}
          </div>
          <p className="mt-2 text-2xl font-bold font-mono tabular-nums text-slate-100">
            {stats.duplicateTracks} duplicados · {stats.inaccessible} inaccesibles
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Detección por huella y verificación real de acceso
          </p>
        </div>
      </div>

      {/* Distribution Charts */}
      {stats.totalMusic === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-700/80 bg-[#101726]/60 p-10 text-center">
          <Music className="w-10 h-10 text-slate-500 mx-auto" />
          <h3 className="mt-3 text-base font-semibold text-slate-200">
            Tu biblioteca musical está vacía
          </h3>
          <p className="mt-1.5 text-sm text-slate-400 max-w-lg mx-auto">
            Vincula una carpeta de tu equipo mediante File System Access o selecciona archivos locales.
            No se copiarán ni modificarán tus archivos originales.
          </p>
          <button
            type="button"
            onClick={handleImportClick}
            className="mt-5 inline-flex items-center gap-2 rounded-lg bg-cyan-500 px-5 py-2.5 text-sm font-semibold text-slate-950 hover:bg-cyan-400 transition-colors cursor-pointer"
          >
            <FolderPlus className="w-4 h-4" />
            Importar primera carpeta
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {[
            { title: 'Distribución por géneros', items: stats.topGenres },
            { title: 'Canciones por décadas', items: stats.topDecades },
            { title: 'Resumen de intensidad musical', items: stats.intensityBars },
          ].map((panel) => (
            <div
              key={panel.title}
              className="rounded-xl border border-slate-800/80 bg-[#101726] p-5"
            >
              <h3 className="text-sm font-semibold text-slate-200">{panel.title}</h3>
              <div className="mt-4 space-y-3">
                {panel.items.map((item) => (
                  <div key={item.label} className="space-y-1">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-slate-300 truncate max-w-[68%]">{item.label}</span>
                      <span className="font-mono tabular-nums text-slate-400">
                        {item.count} ({item.pct}%)
                      </span>
                    </div>
                    <div className="h-2 w-full rounded-full bg-slate-800/90 overflow-hidden">
                      <div
                        className={`h-full rounded-full ${item.colorClass}`}
                        style={{ width: `${Math.max(3, item.pct)}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Bottom 3-Column Real Lists: Latest Playlists, Upcoming Schedules, Recent Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="rounded-xl border border-slate-800/80 bg-[#101726] p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-slate-200">Últimas playlists generadas</h3>
            <button
              type="button"
              onClick={() => setActiveModule('radioboss')}
              className="text-xs text-cyan-400 hover:text-cyan-300 cursor-pointer"
            >
              Ver todas
            </button>
          </div>
          {playlists.length === 0 ? (
            <p className="text-xs text-slate-500">Sin playlists generadas todavía.</p>
          ) : (
            <div className="divide-y divide-slate-800/70 text-xs">
              {playlists.slice(0, 5).map((pl) => (
                <div
                  key={pl.id}
                  onClick={() => {
                    setEditingPlaylist(pl);
                    setActiveModule('generator');
                  }}
                  className="py-2 flex items-center justify-between gap-2 hover:bg-slate-800/35 px-1 rounded cursor-pointer"
                >
                  <div className="min-w-0">
                    <p className="font-medium text-slate-200 truncate">{pl.name}</p>
                    <p className="text-[11px] text-slate-500 font-mono">
                      {pl.musicCount} pistas · {formatDuration(pl.totalDuration)}
                    </p>
                  </div>
                  <span className="text-[11px] text-cyan-400 shrink-0">{pl.mode}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-slate-800/80 bg-[#101726] p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-slate-200">Próximas tareas programadas</h3>
            <button
              type="button"
              onClick={() => setActiveModule('scheduler')}
              className="text-xs text-cyan-400 hover:text-cyan-300 cursor-pointer"
            >
              Programador
            </button>
          </div>
          {upcomingSchedules.length === 0 ? (
            <p className="text-xs text-slate-500">Sin tareas programadas activas.</p>
          ) : (
            <div className="divide-y divide-slate-800/70 text-xs">
              {upcomingSchedules.map(({ task, nextDate, timeStr }) => (
                <div key={`${task.id}_${timeStr}`} className="py-2 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-slate-200 truncate">{task.name}</p>
                    <p className="text-[11px] text-slate-500">
                      {task.format.toUpperCase()} ·{' '}
                      {task.targetType === 'count'
                        ? `${task.targetCount} temas`
                        : `${task.targetDurationMin} min`}
                      {task.spots?.enabled ? ` · Spots c/${task.spots.everyNSongs}` : ''}
                    </p>
                  </div>
                  <span className="font-mono text-[11px] text-amber-300 shrink-0">
                    {nextDate.toLocaleDateString('es-ES', { weekday: 'short', day: '2-digit' })}{' '}
                    {timeStr}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-slate-800/80 bg-[#101726] p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-slate-200">Últimas operaciones</h3>
            <button
              type="button"
              onClick={() => setActiveModule('history')}
              className="text-xs text-cyan-400 hover:text-cyan-300 cursor-pointer"
            >
              Ver historial
            </button>
          </div>
          {activityLogs.length === 0 ? (
            <p className="text-xs text-slate-500">Aún no hay eventos registrados.</p>
          ) : (
            <div className="divide-y divide-slate-800/70 text-xs">
              {activityLogs.slice(0, 5).map((log) => (
                <div key={log.id} className="py-2 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-slate-200 font-medium truncate">{log.title}</p>
                    <p className="text-[11px] text-slate-500 truncate">{log.detail}</p>
                  </div>
                  <span className="font-mono text-[11px] text-slate-500 shrink-0">
                    {formatDateTime(log.timestamp).split(',')[1] || formatDateTime(log.timestamp)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
