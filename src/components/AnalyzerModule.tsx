import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Check,
  CheckCircle2,
  Cpu,
  Edit2,
  FolderPlus,
  Gauge,
  Pause,
  Play,
  RotateCcw,
  Search,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import { db, sessionFileRegistry } from '../db/database';
import { useStudio } from '../context/StudioContext';
import { audioAnalyzer, getMaxDspConcurrency, trackNeedsAudioDecode } from '../services/audioAnalyzer';
import { supportsFileSystemAccess } from '../services/fileAccessService';
import type { AnalysisMode, DataOrigin, TrackRecord } from '../types/studio';

function OriginTag({ label }: { label: DataOrigin }) {
  const cls =
    label === 'ANÁLISIS PCM'
      ? 'text-violet-300'
      : label === 'ETIQUETA'
      ? 'text-cyan-300'
      : label === 'CARPETA'
      ? 'text-sky-300'
      : label === 'MANUAL'
      ? 'text-emerald-300'
      : 'text-slate-500';
  return <span className={`text-[10px] font-mono ${cls}`}>{label}</span>;
}

export const AnalyzerModule: React.FC = () => {
  const {
    tracks,
    settings,
    updateSettings,
    analysisProgress,
    needsAudioRelink,
    setNeedsAudioRelink,
    importFolderViaPicker,
    importFilesViaInput,
    startBatchAnalysis,
    pauseAnalysis,
    resumeAnalysis,
    cancelAnalysis,
    refreshAll,
    showToast,
  } = useStudio();

  const relinkInputRef = useRef<HTMLInputElement>(null);
  const [filterStatus, setFilterStatus] = useState<'all' | 'pending' | 'analyzed' | 'error'>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [editingBpmId, setEditingBpmId] = useState<string | null>(null);
  const [bpmDraft, setBpmDraft] = useState<string>('');
  const maxAutoThreads = useMemo(() => getMaxDspConcurrency(), []);
  const [concurrency, setConcurrency] = useState<number>(maxAutoThreads);
  const [analysisMode, setAnalysisMode] = useState<AnalysisMode>(
    settings.defaultAnalysisMode || 'fast-metadata-bpm'
  );

  useEffect(() => {
    if (settings.defaultAnalysisMode) {
      setAnalysisMode(settings.defaultAnalysisMode);
    }
  }, [settings.defaultAnalysisMode]);

  const musicTracks = useMemo(() => tracks.filter((t) => !t.isSpotFolder), [tracks]);
  const pendingTracks = useMemo(
    () => musicTracks.filter((t) => t.analysisStatus === 'pending'),
    [musicTracks]
  );
  const errorTracks = useMemo(
    () => musicTracks.filter((t) => t.analysisStatus === 'error'),
    [musicTracks]
  );
  const missingSessionFilesCount = useMemo(
    () =>
      musicTracks.filter(
        (t) => trackNeedsAudioDecode(t, analysisMode) && !sessionFileRegistry.has(t.id)
      ).length,
    [musicTracks, analysisMode]
  );

  const visibleTracks = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = musicTracks.filter((t) => {
      if (filterStatus !== 'all' && t.analysisStatus !== filterStatus) return false;
      if (!q) return true;
      return (
        t.title.toLowerCase().includes(q) ||
        t.artist.toLowerCase().includes(q) ||
        t.genre.toLowerCase().includes(q)
      );
    });
    return filtered.slice(0, 250);
  }, [musicTracks, filterStatus, searchQuery]);

  const counts = useMemo(() => {
    let analyzed = 0;
    let pending = 0;
    let error = 0;
    let withBpm = 0;
    let withDsp = 0;
    for (const t of musicTracks) {
      if (t.analysisStatus === 'analyzed') analyzed++;
      else if (t.analysisStatus === 'error') error++;
      else pending++;
      if (t.bpm !== null && t.bpm > 0) withBpm++;
      if (t.energyRmsDb !== null) withDsp++;
    }
    const pct = musicTracks.length > 0 ? Math.round((analyzed / musicTracks.length) * 100) : 0;
    return { analyzed, pending, error, withBpm, withDsp, pct };
  }, [musicTracks]);

  const handleAnalyzeOne = async (track: TrackRecord) => {
    const { track: updated, missingSessionFile } = await audioAnalyzer.analyzeSingleTrack(
      track,
      analysisMode
    );
    await refreshAll();
    if (missingSessionFile) {
      setNeedsAudioRelink(true);
      showToast(
        'warning',
        `Para analizar "${track.title}" tras recargar la pestaña, pulsa "Re-vincular carpeta".`
      );
      return;
    }
    if (updated.analysisStatus === 'analyzed') {
      const detail =
        updated.energyRmsDb !== null
          ? `${updated.bpm} BPM (${updated.bpmConfidence ?? 0}% conf.) · ${updated.energyRmsDb} dBFS (${updated.intensity})`
          : `${updated.bpm} BPM (${updated.bpmConfidence ?? 0}% conf.) · ${updated.genre}`;
      showToast('success', `${updated.title}: ${detail}`);
    } else {
      showToast('error', updated.analysisError || 'No se pudo analizar la pista.');
    }
  };

  const handleSaveManualBpm = async (track: TrackRecord) => {
    const num = Number(bpmDraft);
    if (!Number.isFinite(num) || num < 30 || num > 240) {
      showToast('warning', 'Introduce un BPM válido entre 30 y 240.');
      return;
    }
    await db.tracks.update(track.id, {
      bpm: Math.round(num),
      bpmConfidence: 100,
      origins: { ...track.origins, bpm: 'MANUAL' },
      updatedAt: Date.now(),
    });
    setEditingBpmId(null);
    await refreshAll();
    showToast('success', `BPM de "${track.title}" corregido manualmente a ${Math.round(num)}.`);
  };

  const isRunning = analysisProgress.status === 'running';
  const isPaused = analysisProgress.status === 'paused';

  return (
    <div className="space-y-4">
      <input
        ref={relinkInputRef}
        type="file"
        multiple
        // @ts-expect-error webkitdirectory
        webkitdirectory=""
        className="hidden"
        onChange={async (e) => {
          if (e.target.files?.length) {
            const folder = await importFilesViaInput(e.target.files, 'music', 'Música');
            e.target.value = '';
            if (folder) {
              setNeedsAudioRelink(false);
            }
          }
        }}
      />

      {/* Relink Banner when session files expired after page reload */}
      {(needsAudioRelink || (musicTracks.length > 0 && missingSessionFilesCount === musicTracks.length)) && (
        <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-2.5 text-xs text-amber-200 min-w-0">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="font-semibold text-amber-100">
                Se requiere re-vincular tu carpeta para leer el audio en esta sesión
              </p>
              <p className="text-amber-200/80 mt-0.5">
                Al recargar el navegador, los permisos temporales sobre archivos locales se cierran por seguridad. Selecciona la misma carpeta para restaurar el acceso sin duplicar canciones.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() =>
              supportsFileSystemAccess()
                ? importFolderViaPicker('music', null, () => relinkInputRef.current?.click())
                : relinkInputRef.current?.click()
            }
            className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3.5 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 shrink-0 cursor-pointer"
          >
            <FolderPlus className="w-3.5 h-3.5" />
            Re-vincular carpeta
          </button>
        </div>
      )}

      {/* Balanced Header + Process Options + Compact KPIs */}
      <div className="rounded-xl border border-slate-800/80 bg-[#101726] p-4 sm:p-5 space-y-4">
        <div className="flex flex-col xl:flex-row xl:items-center justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold text-slate-100">
                Motor de Análisis Veloz (Metadatos, Género y BPM)
              </h2>
              <span className="rounded border border-cyan-500/35 bg-cyan-500/10 px-2 py-0.5 text-[11px] font-mono text-cyan-300">
                Web Workers · 2º Plano
              </span>
            </div>
            <p className="text-xs text-slate-400 max-w-4xl">
              Lee etiquetas al instante (omitiendo decodificación si ya existe BPM) o ejecuta detección rítmica e intensidad DSP por picos graves en hilos paralelos.
            </p>
          </div>

          <div className="flex items-center gap-3 shrink-0 rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 text-xs">
            <div className="min-w-[140px]">
              <div className="flex items-center justify-between text-[11px] mb-1">
                <span className="text-slate-400">Progreso análisis</span>
                <span className="font-mono font-semibold text-cyan-300">{counts.pct}%</span>
              </div>
              <div className="h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-cyan-500 to-violet-500 transition-all"
                  style={{ width: `${counts.pct}%` }}
                />
              </div>
            </div>
            <div className="h-7 w-px bg-slate-800" />
            <div className="font-mono tabular-nums text-[11px] text-slate-300">
              <span className="text-emerald-300 font-semibold">{counts.analyzed.toLocaleString()}</span> /{' '}
              {musicTracks.length.toLocaleString()}
            </div>
          </div>
        </div>

        {/* 4 Balanced Compact Metric Cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-2.5">
          <div className="rounded-lg border border-slate-800/90 bg-[#090d16] px-3 py-2.5 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[11px] text-slate-400 truncate">Analizadas</p>
              <p className="text-base font-bold font-mono tabular-nums text-emerald-300">
                {counts.analyzed.toLocaleString()}
              </p>
            </div>
            <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
          </div>

          <div className="rounded-lg border border-slate-800/90 bg-[#090d16] px-3 py-2.5 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[11px] text-slate-400 truncate">Sin analizar</p>
              <p className="text-base font-bold font-mono tabular-nums text-amber-300">
                {counts.pending.toLocaleString()}
              </p>
            </div>
            <Activity className="w-4 h-4 text-amber-400 shrink-0" />
          </div>

          <div className="rounded-lg border border-slate-800/90 bg-[#090d16] px-3 py-2.5 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[11px] text-slate-400 truncate">Con BPM / DSP</p>
              <p className="text-base font-bold font-mono tabular-nums text-cyan-300">
                {counts.withBpm.toLocaleString()}{' '}
                <span className="text-[11px] font-normal text-slate-500">
                  · {counts.withDsp.toLocaleString()} DSP
                </span>
              </p>
            </div>
            <Gauge className="w-4 h-4 text-cyan-400 shrink-0" />
          </div>

          <div className="rounded-lg border border-slate-800/90 bg-[#090d16] px-3 py-2.5 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[11px] text-slate-400 truncate">Errores lectura</p>
              <p
                className={`text-base font-bold font-mono tabular-nums ${
                  counts.error > 0 ? 'text-rose-400' : 'text-slate-300'
                }`}
              >
                {counts.error.toLocaleString()}
              </p>
            </div>
            <AlertTriangle
              className={`w-4 h-4 shrink-0 ${
                counts.error > 0 ? 'text-rose-400' : 'text-slate-600'
              }`}
            />
          </div>
        </div>

        {/* Dedicated Full-Width Process Options & Actions Bar */}
        <div className="rounded-xl border border-slate-800 bg-[#090d16] p-3 flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:flex lg:flex-wrap items-center gap-2.5">
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-slate-400 shrink-0">Modo:</span>
              <select
                value={analysisMode}
                onChange={(e) => {
                  const nextMode = e.target.value as AnalysisMode;
                  setAnalysisMode(nextMode);
                  void updateSettings({ defaultAnalysisMode: nextMode });
                }}
                className="w-full sm:w-auto rounded-lg border border-slate-700 bg-[#101726] px-2.5 py-2 text-xs text-cyan-300 font-medium cursor-pointer"
                title="Modo de extracción"
              >
                <option value="fast-metadata-bpm">Rápido: Metadatos + Género + BPM</option>
                <option value="full-dsp">Completo DSP (BPM + Energía + Ambiente)</option>
              </select>
            </div>

            <div className="flex items-center gap-2">
              <Cpu className="w-3.5 h-3.5 text-slate-400 shrink-0 hidden sm:block" />
              <select
                value={concurrency}
                onChange={(e) => setConcurrency(Number(e.target.value))}
                className="w-full sm:w-auto rounded-lg border border-slate-700 bg-[#101726] px-2.5 py-2 text-xs text-slate-200 cursor-pointer"
                title="Hilos paralelos Web Worker"
              >
                <option value={maxAutoThreads}>Velocidad Máxima ({maxAutoThreads} hilos)</option>
                {maxAutoThreads !== 4 && <option value={4}>4 hilos paralelos</option>}
                <option value={2}>2 hilos paralelos</option>
                <option value={1}>1 hilo (conservador)</option>
              </select>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {!isRunning && !isPaused ? (
              <>
                <button
                  type="button"
                  onClick={() =>
                    startBatchAnalysis(pendingTracks, false, concurrency, analysisMode, true)
                  }
                  disabled={pendingTracks.length === 0}
                  className="inline-flex items-center gap-2 rounded-lg bg-violet-500 px-3.5 py-2 text-xs font-semibold text-white hover:bg-violet-400 disabled:opacity-40 cursor-pointer"
                >
                  <Sparkles className="w-3.5 h-3.5" />
                  Analizar pendientes ({counts.pending.toLocaleString()})
                </button>
                {counts.error > 0 && (
                  <button
                    type="button"
                    onClick={() =>
                      startBatchAnalysis(errorTracks, true, concurrency, analysisMode, false)
                    }
                    className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/15 px-3 py-2 text-xs font-semibold text-amber-200 hover:bg-amber-500/25 cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    Reintentar errores ({counts.error})
                  </button>
                )}
                <button
                  type="button"
                  onClick={() =>
                    startBatchAnalysis(musicTracks, true, concurrency, analysisMode, false)
                  }
                  disabled={musicTracks.length === 0}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/90 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-40 cursor-pointer"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                  Reanalizar todo ({musicTracks.length.toLocaleString()})
                </button>
              </>
            ) : (
              <>
                {isRunning ? (
                  <button
                    type="button"
                    onClick={pauseAnalysis}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-amber-500 px-3.5 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-400 cursor-pointer"
                  >
                    <Pause className="w-3.5 h-3.5" />
                    Pausar
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={resumeAnalysis}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3.5 py-2 text-xs font-semibold text-slate-950 hover:bg-emerald-400 cursor-pointer"
                  >
                    <Play className="w-3.5 h-3.5" />
                    Reanudar
                  </button>
                )}
                <button
                  type="button"
                  onClick={cancelAnalysis}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/15 px-3.5 py-2 text-xs font-semibold text-rose-200 hover:bg-rose-500/25 cursor-pointer"
                >
                  <Square className="w-3.5 h-3.5" />
                  Cancelar
                </button>
              </>
            )}
          </div>
        </div>

        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pt-0.5">
          <label className="inline-flex items-center gap-2 text-xs text-slate-300 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.autoBackgroundAnalysis}
              onChange={(e) => void updateSettings({ autoBackgroundAnalysis: e.target.checked })}
              className="accent-cyan-500"
            />
            Iniciar análisis automáticamente en segundo plano al importar carpetas o canciones nuevas
          </label>
          <span className="text-[11px] text-slate-500">
            Haz clic en el lápiz del BPM para corregir manualmente cuando la confianza sea baja
          </span>
        </div>
      </div>

      {/* Live Batch Progress */}
      {analysisProgress.status !== 'idle' && (
        <div className="rounded-xl border border-violet-500/30 bg-[#101726] p-4 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span className="font-semibold text-violet-300 truncate max-w-xl">
              Estado: {analysisProgress.status.toUpperCase()}
              {analysisProgress.activeWorkers ? ` (${analysisProgress.activeWorkers} hilos)` : ''}
              {analysisProgress.currentTrackTitle ? ` — ${analysisProgress.currentTrackTitle}` : ''}
            </span>
            <span className="font-mono tabular-nums text-slate-300">
              {analysisProgress.completed} / {analysisProgress.total} · OK {analysisProgress.succeeded} · Sin cambios {analysisProgress.skippedUnchanged} · Err {analysisProgress.failed}
              {analysisProgress.tracksPerSec ? ` · ${analysisProgress.tracksPerSec} pistas/s` : ''}
            </span>
          </div>
          <div className="h-2 w-full rounded-full bg-slate-800 overflow-hidden">
            <div
              className="h-full bg-violet-500 transition-all"
              style={{
                width:
                  analysisProgress.total > 0
                    ? `${Math.round((analysisProgress.completed / analysisProgress.total) * 100)}%`
                    : '0%',
              }}
            />
          </div>
          {analysisProgress.lastError && (
            <p className="text-xs text-rose-300">
              Último aviso de decodificación: {analysisProgress.lastError}
            </p>
          )}
        </div>
      )}

      {/* Filter Tabs + Quick Search */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="inline-flex flex-wrap items-center gap-1 p-1 rounded-lg bg-[#101726] border border-slate-800">
          {[
            { id: 'all', label: `Todas (${musicTracks.length.toLocaleString()})` },
            { id: 'pending', label: `Sin analizar (${counts.pending.toLocaleString()})` },
            { id: 'analyzed', label: `Analizadas (${counts.analyzed.toLocaleString()})` },
            { id: 'error', label: `Errores (${counts.error.toLocaleString()})` },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setFilterStatus(tab.id as typeof filterStatus)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer ${
                filterStatus === tab.id
                  ? 'bg-slate-800 text-cyan-300'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="relative w-full md:w-72">
          <Search className="w-3.5 h-3.5 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Buscar pista, artista o género..."
            className="w-full rounded-lg border border-slate-800 bg-[#101726] pl-8 pr-8 py-1.5 text-xs text-slate-100 placeholder:text-slate-500"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-200 cursor-pointer"
              aria-label="Limpiar búsqueda"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Results Table */}
      <div className="rounded-xl border border-slate-800/80 bg-[#101726] overflow-x-auto">
        <table className="w-full text-left text-xs min-w-[900px]">
          <thead className="bg-[#0c1220] border-b border-slate-800 text-slate-400">
            <tr>
              <th className="px-4 py-3 font-semibold">Pista</th>
              <th className="px-3 py-3 font-semibold text-right">BPM / Confianza</th>
              <th className="px-3 py-3 font-semibold text-right">Energía / RMS</th>
              <th className="px-3 py-3 font-semibold">Intensidad</th>
              <th className="px-3 py-3 font-semibold">Bailabilidad</th>
              <th className="px-3 py-3 font-semibold">Valencia</th>
              <th className="px-3 py-3 font-semibold">Ambiente</th>
              <th className="px-4 py-3 font-semibold text-right">Acción</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/60">
            {visibleTracks.length === 0 ? (
              <tr>
                <td colSpan={8} className="px-4 py-8 text-center text-slate-500">
                  No hay pistas en esta categoría.
                </td>
              </tr>
            ) : (
              visibleTracks.map((t) => {
                const lowConf = t.bpmConfidence !== null && t.bpmConfidence < 50;
                return (
                  <tr key={t.id} className="hover:bg-slate-800/35">
                    <td className="px-4 py-2.5 max-w-[240px]">
                      <div className="flex items-center gap-2">
                        {t.analysisStatus === 'analyzed' ? (
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                        ) : t.analysisStatus === 'error' ? (
                          <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                        ) : (
                          <span className="w-3.5 h-3.5 rounded-full border border-slate-600 shrink-0" />
                        )}
                        <div className="min-w-0">
                          <p className="font-medium text-slate-100 truncate">{t.title}</p>
                          <p className="text-[11px] text-slate-400 truncate">
                            {t.artist} · <OriginTag label={t.origins.genre} /> {t.genre}
                          </p>
                          {t.analysisError && (
                            <p className="text-[11px] text-rose-400 truncate">{t.analysisError}</p>
                          )}
                        </div>
                      </div>
                    </td>

                    <td className="px-3 py-2.5 text-right font-mono tabular-nums">
                      {editingBpmId === t.id ? (
                        <div className="inline-flex items-center gap-1">
                          <input
                            type="number"
                            value={bpmDraft}
                            onChange={(e) => setBpmDraft(e.target.value)}
                            className="w-16 rounded border border-cyan-500 bg-[#090d16] px-1.5 py-0.5 text-right text-slate-100"
                          />
                          <button
                            type="button"
                            onClick={() => handleSaveManualBpm(t)}
                            className="p-1 text-emerald-400 hover:text-emerald-300 cursor-pointer"
                          >
                            <Check className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingBpmId(null)}
                            className="p-1 text-slate-400 hover:text-white cursor-pointer"
                          >
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <div>
                          <div className="inline-flex items-center gap-1.5">
                            <span className="text-cyan-300 font-semibold">
                              {t.bpm ?? 'SIN ANALIZAR'}
                            </span>
                            <button
                              type="button"
                              onClick={() => {
                                setEditingBpmId(t.id);
                                setBpmDraft(t.bpm ? String(t.bpm) : '120');
                              }}
                              className="text-slate-500 hover:text-cyan-300 cursor-pointer"
                              title="Corregir BPM manualmente"
                            >
                              <Edit2 className="w-3 h-3" />
                            </button>
                          </div>
                          <div className="text-[10px]">
                            <OriginTag label={t.origins.bpm} />
                            {t.bpmConfidence !== null && (
                              <span className={lowConf ? 'text-amber-400 ml-1' : 'text-slate-500 ml-1'}>
                                · {t.bpmConfidence}% {lowConf ? '(Baja confianza)' : ''}
                              </span>
                            )}
                          </div>
                        </div>
                      )}
                    </td>

                    <td className="px-3 py-2.5 text-right font-mono tabular-nums">
                      <div className="text-slate-200">
                        {t.energyLevel ?? (t.analysisStatus === 'analyzed' ? 'Solo BPM' : 'SIN ANALIZAR')}
                      </div>
                      <div className="text-[10px] text-slate-400">
                        {t.energyRmsDb !== null ? `${t.energyRmsDb} dB` : '—'} ·{' '}
                        <OriginTag label={t.origins.energy} />
                      </div>
                    </td>

                    <td className="px-3 py-2.5 text-slate-200">
                      {t.intensity ?? (
                        <span className="text-slate-500">
                          {t.analysisStatus === 'analyzed' ? '—' : 'SIN ANALIZAR'}
                        </span>
                      )}
                    </td>

                    <td className="px-3 py-2.5 font-mono tabular-nums text-slate-300">
                      {t.danceability !== null ? (
                        <span>
                          {t.danceabilityLabel || 'Media'} ({t.danceability}%)
                        </span>
                      ) : (
                        <span className="text-slate-500">
                          {t.analysisStatus === 'analyzed' ? '—' : 'SIN ANALIZAR'}
                        </span>
                      )}
                    </td>

                    <td className="px-3 py-2.5 font-mono tabular-nums text-slate-300">
                      {t.valence !== null ? (
                        <span>
                          {t.valenceLabel || 'Neutral'} ({t.valence}%)
                        </span>
                      ) : (
                        <span className="text-slate-500">
                          {t.analysisStatus === 'analyzed' ? '—' : 'SIN ANALIZAR'}
                        </span>
                      )}
                    </td>

                    <td className="px-3 py-2.5">
                      <div className="text-slate-200">
                        {t.mood !== 'Desconocido' ? t.mood : t.analysisStatus === 'analyzed' ? '—' : 'Desconocido'}
                      </div>
                      <OriginTag label={t.origins.mood} />
                    </td>

                    <td className="px-4 py-2.5 text-right">
                      <button
                        type="button"
                        onClick={() => handleAnalyzeOne(t)}
                        className="rounded-md border border-slate-700 bg-slate-800/80 px-2.5 py-1 text-[11px] font-medium text-slate-200 hover:bg-slate-700 cursor-pointer"
                      >
                        Analizar
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
