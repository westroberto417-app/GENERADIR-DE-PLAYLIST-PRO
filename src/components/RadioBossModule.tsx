import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  BarChart2,
  CheckCircle2,
  Copy,
  Download,
  Edit3,
  FileCheck2,
  FileUp,
  Info,
  List,
  Trash2,
  X,
} from 'lucide-react';
import { addActivityLog, db } from '../db/database';
import { useStudio } from '../context/StudioContext';
import {
  verifyPlaylistFilesOnDisk,
  type PreExportFileVerificationResult,
} from '../services/fileAccessService';
import {
  buildRadioBossM3UContent,
  downloadTextFile,
  formatValidationReportTxt,
  isPlaceholderWindowsPath,
  normalizeWindowsFolderPath,
  validateExternalM3UContent,
  validateSavedPlaylist,
  type PlaylistValidationReport,
} from '../services/radioboss';
import type { PathExportMode, SavedPlaylist } from '../types/studio';
import { formatDateTime, formatDuration } from '../utils/formatters';
import { ConfirmDialog } from './ConfirmDialog';
import { FolderDiskPathEditor } from './FolderDiskPathEditor';
import { FolderReconnectModal } from './FolderReconnectModal';

export const RadioBossModule: React.FC = () => {
  const {
    playlists,
    folders,
    tracks,
    settings,
    updateSettings,
    setEditingPlaylist,
    setActiveModule,
    selectedRadioBossPlaylistId,
    setSelectedRadioBossPlaylistId,
    generatorEditingId,
    setGeneratorEditingId,
    refreshAll,
    showToast,
  } = useStudio();

  const [exportFormat, setExportFormat] = useState<'m3u8' | 'm3u'>(settings.defaultFormat);
  const [pathMode, setPathMode] = useState<PathExportMode>(settings.defaultPathMode);
  const [globalPrefixDraft, setGlobalPrefixDraft] = useState<string>(settings.globalFallbackPrefix);
  const [previewText, setPreviewText] = useState<string>('');
  const [brokenCount, setBrokenCount] = useState<number>(0);
  const [validationReport, setValidationReport] = useState<PlaylistValidationReport | null>(null);
  const [diskVerification, setDiskVerification] = useState<PreExportFileVerificationResult | null>(
    null
  );
  const [isVerifyingDisk, setIsVerifyingDisk] = useState(false);
  const [showReconnectModal, setShowReconnectModal] = useState(false);

  const [confirmDeletePl, setConfirmDeletePl] = useState<SavedPlaylist | null>(null);
  const [inspectTracksPl, setInspectTracksPl] = useState<SavedPlaylist | null>(null);
  const [inspectStatsPl, setInspectStatsPl] = useState<SavedPlaylist | null>(null);

  const externalFileRef = useRef<HTMLInputElement>(null);

  const selectedPlaylist =
    playlists.find((p) => p.id === selectedRadioBossPlaylistId) || playlists[0] || null;

  useEffect(() => {
    if (
      playlists.length > 0 &&
      (!selectedRadioBossPlaylistId || !playlists.some((p) => p.id === selectedRadioBossPlaylistId))
    ) {
      setSelectedRadioBossPlaylistId(playlists[0].id);
    }
  }, [playlists, selectedRadioBossPlaylistId, setSelectedRadioBossPlaylistId]);

  useEffect(() => {
    setGlobalPrefixDraft(settings.globalFallbackPrefix);
  }, [settings.globalFallbackPrefix]);

  const playlistFolders = useMemo(() => {
    if (!selectedPlaylist) return folders;
    const trackMap = new Map(tracks.map((t) => [t.id, t]));
    const usedIds = new Set(
      selectedPlaylist.items.map((it) => trackMap.get(it.trackId)?.folderId || it.folderId)
    );
    const matching = folders.filter((f) => usedIds.has(f.id));
    return matching.length > 0 ? matching : folders;
  }, [selectedPlaylist, folders, tracks]);

  useEffect(() => {
    let active = true;
    const renderPreview = async () => {
      if (!selectedPlaylist) {
        setPreviewText('');
        setBrokenCount(0);
        return;
      }
      const res = await buildRadioBossM3UContent(selectedPlaylist, exportFormat, pathMode);
      if (active) {
        setPreviewText(res.content);
        setBrokenCount(res.brokenItems.length);
      }
    };
    renderPreview();
    return () => {
      active = false;
    };
  }, [selectedPlaylist, exportFormat, pathMode, folders, settings]);

  const performExportDownload = async (targetPlaylist: SavedPlaylist) => {
    const report = await validateSavedPlaylist(targetPlaylist, exportFormat, pathMode);
    setValidationReport(report);

    const { content, brokenItems, exportedCount } = await buildRadioBossM3UContent(
      targetPlaylist,
      exportFormat,
      pathMode
    );

    if (exportedCount === 0) {
      showToast(
        'error',
        'Exportación bloqueada: ninguna pista de la lista es accesible actualmente.'
      );
      return;
    }

    const safeName = targetPlaylist.name.replace(/[<>:"/\\|?*]+/g, '_');
    const fileName = `${safeName}.${exportFormat}`;
    const saved = await downloadTextFile(fileName, content, 'audio/x-mpegurl;charset=utf-8');
    if (saved) {
      await addActivityLog(
        'export',
        brokenItems.length > 0 ? 'warning' : 'success',
        `Exportación RadioBOSS: ${fileName}`,
        `${exportedCount} pistas exportadas (${pathMode}) · Omitidas inaccesibles: ${brokenItems.length}`
      );
      await refreshAll();
      showToast(
        brokenItems.length > 0 ? 'warning' : 'success',
        `Exportado "${fileName}" con ${exportedCount} rutas (${brokenItems.length} inaccesibles omitidas).`
      );
      setShowReconnectModal(false);
    }
  };

  const runDiskVerification = async (
    targetPlaylist: SavedPlaylist
  ): Promise<PreExportFileVerificationResult> => {
    setIsVerifyingDisk(true);
    try {
      const freshPlaylist = (await db.playlists.get(targetPlaylist.id)) || targetPlaylist;
      const res = await verifyPlaylistFilesOnDisk(freshPlaylist, { requestHandlePermission: true });
      setDiskVerification(res);
      await refreshAll();
      return res;
    } finally {
      setIsVerifyingDisk(false);
    }
  };

  const handleCheckDiskOnly = async () => {
    if (!selectedPlaylist) return;
    const res = await runDiskVerification(selectedPlaylist);
    if (res.needsReconnect) {
      setShowReconnectModal(true);
      showToast(
        res.hasBlockingIssues ? 'warning' : 'info',
        res.hasBlockingIssues
          ? `Se detectaron ${res.missingCount} archivo(s) faltantes o carpetas cambiadas.`
          : `${res.unverifiedCount} pista(s) requieren reconectar carpeta en esta sesión.`
      );
    } else {
      showToast(
        'success',
        `Verificación en disco aprobada: las ${res.verifiedCount} pistas existen localmente.`
      );
    }
  };

  const handleExportPlaylist = async () => {
    if (!selectedPlaylist) return;
    const res = await runDiskVerification(selectedPlaylist);
    if (res.needsReconnect) {
      setShowReconnectModal(true);
      return;
    }
    const freshPlaylist = (await db.playlists.get(selectedPlaylist.id)) || selectedPlaylist;
    await performExportDownload(freshPlaylist);
  };

  const handleDuplicateStructure = async (pl: SavedPlaylist) => {
    const now = Date.now();
    const copy: SavedPlaylist = {
      ...pl,
      id: `pl_${now}_${Math.random().toString(36).slice(2, 6)}`,
      name: `${pl.name} (Copia)`,
      createdAt: now,
      updatedAt: now,
      items: pl.items.map((it) => ({
        ...it,
        uid: `${it.trackId}_${now}_${Math.random().toString(36).slice(2, 5)}`,
      })),
    };
    await db.playlists.put(copy);
    await refreshAll();
    setSelectedRadioBossPlaylistId(copy.id);
    showToast('success', `Estructura duplicada como "${copy.name}" sin duplicar audio.`);
  };

  const handleValidateSelected = async () => {
    if (!selectedPlaylist) return;
    const report = await validateSavedPlaylist(selectedPlaylist, exportFormat, pathMode);
    setValidationReport(report);
    await refreshAll();
  };

  const handleExternalM3UUpload = async (file: File) => {
    const text = await file.text();
    const report = await validateExternalM3UContent(file.name, text);
    setValidationReport(report);
    await refreshAll();
    showToast(
      report.radioBossCompatible ? 'success' : 'warning',
      `Validado "${file.name}": ${report.errorCount} errores, ${report.warningCount} avisos.`
    );
  };

  const handleDownloadReportTxt = async () => {
    if (!validationReport) return;
    const txt = formatValidationReportTxt(validationReport);
    await downloadTextFile(
      `informe_validacion_${validationReport.sourceName.replace(/\.[^/.]+$/, '')}.txt`,
      txt,
      'text/plain;charset=utf-8'
    );
  };

  const playlistStats = useMemo(() => {
    if (!inspectStatsPl) return null;
    const genreCounts = new Map<string, number>();
    const intensityCounts = new Map<string, number>();
    let bpmSum = 0;
    let bpmN = 0;
    for (const it of inspectStatsPl.items) {
      if (it.isSpot) continue;
      const g = it.genre || 'Desconocido';
      genreCounts.set(g, (genreCounts.get(g) || 0) + 1);
      const inten = it.intensity || 'Sin analizar';
      intensityCounts.set(inten, (intensityCounts.get(inten) || 0) + 1);
      if (it.bpm) {
        bpmSum += it.bpm;
        bpmN++;
      }
    }
    return {
      avgBpm: bpmN > 0 ? Math.round(bpmSum / bpmN) : 0,
      genres: Array.from(genreCounts.entries()).sort((a, b) => b[1] - a[1]),
      intensities: Array.from(intensityCounts.entries()).sort((a, b) => b[1] - a[1]),
    };
  }, [inspectStatsPl]);

  return (
    <div className="space-y-4">
      <input
        ref={externalFileRef}
        type="file"
        accept=".m3u,.m3u8"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) {
            handleExternalM3UUpload(file);
            e.target.value = '';
          }
        }}
      />

      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
        {/* Saved Playlists Manager */}
        <div className="xl:col-span-5 rounded-xl border border-slate-800/80 bg-[#101726] p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-100">
              Administrador de Playlists ({playlists.length})
            </h2>
          </div>

          {playlists.length === 0 ? (
            <div className="py-10 text-center text-xs text-slate-500">
              No tienes playlists guardadas. Crea una en el Generador Inteligente.
            </div>
          ) : (
            <div className="divide-y divide-slate-800/70 max-h-[460px] overflow-y-auto">
              {playlists.map((pl) => {
                const active = selectedPlaylist?.id === pl.id;
                return (
                  <div
                    key={pl.id}
                    onClick={() => setSelectedRadioBossPlaylistId(pl.id)}
                    className={`py-3 px-2.5 rounded-lg cursor-pointer transition-colors ${
                      active ? 'bg-cyan-500/12' : 'hover:bg-slate-800/40'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="text-xs font-semibold text-slate-100 truncate">{pl.name}</p>
                        <p className="text-[11px] font-mono text-slate-400 mt-0.5">
                          {pl.musicCount} canciones · {pl.spotCount} spots ·{' '}
                          {formatDuration(pl.totalDuration)} · {(pl.format || settings.defaultFormat).toUpperCase()}
                        </p>
                        <p className="text-[11px] text-slate-500 truncate">
                          Cat: {pl.category || pl.mode} · {formatDateTime(pl.createdAt)}
                        </p>
                        {pl.outputPathHint && (
                          <p className="text-[10px] font-mono text-slate-500 truncate">
                            Ubicación: {pl.outputPathHint}
                          </p>
                        )}
                      </div>

                      <div className="flex items-center gap-0.5 shrink-0">
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setInspectTracksPl(pl);
                          }}
                          className="p-1.5 rounded text-slate-400 hover:text-emerald-300 hover:bg-slate-800 cursor-pointer"
                          title="Consultar canciones utilizadas"
                        >
                          <List className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setInspectStatsPl(pl);
                          }}
                          className="p-1.5 rounded text-slate-400 hover:text-violet-300 hover:bg-slate-800 cursor-pointer"
                          title="Ver estadísticas de la playlist"
                        >
                          <BarChart2 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditingPlaylist(pl);
                            setActiveModule('generator');
                          }}
                          className="p-1.5 rounded text-slate-400 hover:text-cyan-300 hover:bg-slate-800 cursor-pointer"
                          title="Abrir / editar en generador"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDuplicateStructure(pl);
                          }}
                          className="p-1.5 rounded text-slate-400 hover:text-blue-300 hover:bg-slate-800 cursor-pointer"
                          title="Duplicar estructura"
                        >
                          <Copy className="w-3.5 h-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setConfirmDeletePl(pl);
                          }}
                          className="p-1.5 rounded text-slate-400 hover:text-rose-400 hover:bg-slate-800 cursor-pointer"
                          title="Eliminar referencia con confirmación"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* RadioBOSS M3U / M3U8 Live Exporter */}
        <div className="xl:col-span-7 rounded-xl border border-slate-800/80 bg-[#101726] p-4 space-y-4">
          <div>
            <h3 className="text-sm font-semibold text-slate-100">
              Exportación RadioBOSS (M3U / M3U8 CRLF)
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Soporte nativo UTF-8 para espacios, acentos, ñ, ü, &, () y mapeo multi-unidad Windows/NAS sin codificación %20.
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
            <div>
              <label className="block text-slate-400 mb-1">Formato de salida</label>
              <div className="grid grid-cols-2 gap-1.5 p-1 rounded-lg bg-[#090d16] border border-slate-800">
                {(['m3u8', 'm3u'] as const).map((fmt) => (
                  <button
                    key={fmt}
                    type="button"
                    onClick={() => setExportFormat(fmt)}
                    className={`py-1.5 rounded font-mono font-semibold cursor-pointer ${
                      exportFormat === fmt
                        ? 'bg-cyan-500 text-slate-950'
                        : 'text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    .{fmt.toUpperCase()} {fmt === 'm3u8' ? '(UTF-8)' : ''}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label className="block text-slate-400 mb-1">Modo de rutas en vivo</label>
              <select
                value={pathMode}
                onChange={(e) => setPathMode(e.target.value as PathExportMode)}
                className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 text-slate-100"
              >
                <option value="multi-drive">Mapeo multi-unidad (D:\, E:\, \\NAS)</option>
                <option value="absolute">Ruta absoluta (prefijo global)</option>
                <option value="relative">Rutas relativas</option>
              </select>
            </div>
          </div>

          {pathMode === 'multi-drive' && playlistFolders.length > 0 && (
            <FolderDiskPathEditor
              folders={playlistFolders}
              compact
              title="Ruta real en disco para las carpetas de esta playlist"
              onUseRelativePaths={() => setPathMode('relative')}
            />
          )}

          {pathMode === 'absolute' && (
            <div
              className={`rounded-xl border p-3 space-y-2 text-xs ${
                isPlaceholderWindowsPath(settings.globalFallbackPrefix)
                  ? 'border-amber-500/40 bg-amber-500/5'
                  : 'border-slate-800 bg-[#090d16]'
              }`}
            >
              <label className="block font-semibold text-slate-200">
                Prefijo global real en disco (Windows / NAS)
              </label>
              <div className="flex flex-col sm:flex-row gap-2">
                <input
                  type="text"
                  value={globalPrefixDraft}
                  onChange={(e) => setGlobalPrefixDraft(e.target.value)}
                  placeholder="Ej. C:\Users\Radio\Musica o E:\Biblioteca"
                  className="flex-1 rounded-lg border border-slate-700 bg-[#101726] px-3 py-1.5 font-mono text-slate-100"
                />
                <button
                  type="button"
                  onClick={() => {
                    const norm = normalizeWindowsFolderPath(globalPrefixDraft);
                    if (norm) {
                      setGlobalPrefixDraft(norm);
                      void updateSettings({ globalFallbackPrefix: norm });
                    }
                  }}
                  className="rounded-lg bg-emerald-500 px-3 py-1.5 font-semibold text-slate-950 hover:bg-emerald-400 cursor-pointer shrink-0"
                >
                  Aplicar prefijo
                </button>
              </div>
            </div>
          )}

          {pathMode === 'relative' && (
            <div className="rounded-lg border border-cyan-500/30 bg-cyan-500/10 p-2.5 text-[11px] text-cyan-200">
              Modo <strong>Rutas relativas</strong>: guarda el archivo <span className="font-mono">.{exportFormat}</span> descargado dentro de la carpeta raíz de tu música para que RadioBOSS cargue cada pista sin importar la letra de unidad.
            </div>
          )}

          {brokenCount > 0 && (
            <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-xs text-rose-200 flex items-center gap-2">
              <AlertTriangle className="w-4 h-4 text-rose-400 shrink-0" />
              <span>
                Atención: {brokenCount} pista(s) inaccesible(s) fueron excluidas automáticamente de la vista previa de exportación para evitar rutas rotas en RadioBOSS.
              </span>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between text-xs text-slate-400 mb-1.5">
              <span>Vista previa exacta del archivo generado (CRLF)</span>
              <span className="font-mono">
                {selectedPlaylist ? `${selectedPlaylist.items.length} pistas` : 'Sin selección'}
              </span>
            </div>
            <pre className="rounded-lg border border-slate-800 bg-[#090d16] p-3 text-[11px] font-mono text-slate-300 overflow-x-auto max-h-60 whitespace-pre">
              {previewText || '# Selecciona o guarda una playlist para previsualizar el archivo .m3u8'}
            </pre>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            <button
              type="button"
              disabled={!selectedPlaylist || isVerifyingDisk}
              onClick={() => void handleCheckDiskOnly()}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/80 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-40 cursor-pointer"
              title="Comprobar si los archivos siguen existiendo en disco y reconectar carpetas si cambiaron"
            >
              <FileCheck2 className="w-4 h-4 text-cyan-400" />
              {isVerifyingDisk ? 'Verificando disco...' : 'Verificar archivos en disco'}
            </button>
            <button
              type="button"
              disabled={!selectedPlaylist}
              onClick={handleValidateSelected}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/80 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 disabled:opacity-40 cursor-pointer"
            >
              <FileCheck2 className="w-4 h-4 text-emerald-400" />
              Validar formato M3U
            </button>
            <button
              type="button"
              disabled={!selectedPlaylist || isVerifyingDisk}
              onClick={() => void handleExportPlaylist()}
              className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-40 cursor-pointer"
            >
              <Download className="w-4 h-4" />
              {isVerifyingDisk
                ? 'Verificando archivos...'
                : `Exportar .${exportFormat.toUpperCase()} para RadioBOSS`}
            </button>
          </div>
        </div>
      </div>

      {/* Validator & Error Report */}
      <div className="rounded-xl border border-slate-800/80 bg-[#101726] p-5 space-y-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-slate-100">
              Validador de Playlists e Informe de Errores (.m3u / .m3u8)
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">
              Verifica cabecera #EXTM3U, codificación UTF-8, duraciones #EXTINF, duplicados, unidades detectadas y accesibilidad frente al catálogo.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => externalFileRef.current?.click()}
              className="inline-flex items-center gap-2 rounded-lg bg-blue-500 px-3.5 py-2 text-xs font-semibold text-white hover:bg-blue-400 cursor-pointer"
            >
              <FileUp className="w-4 h-4" />
              Validar archivo M3U/M3U8 externo
            </button>
            {validationReport && (
              <button
                type="button"
                onClick={handleDownloadReportTxt}
                className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800/80 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 cursor-pointer"
              >
                <Download className="w-4 h-4 text-cyan-400" />
                Descargar Informe (.txt)
              </button>
            )}
          </div>
        </div>

        {validationReport && (
          <div className="space-y-3 border-t border-slate-800 pt-4">
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3 text-xs">
              <div className="rounded-lg border border-slate-800 bg-[#090d16] p-3">
                <div className="text-slate-400">Estado RadioBOSS</div>
                <div className="mt-1 flex items-center gap-1.5 font-semibold">
                  {validationReport.radioBossCompatible ? (
                    <>
                      <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                      <span className="text-emerald-300">Aprobado</span>
                    </>
                  ) : (
                    <>
                      <AlertTriangle className="w-4 h-4 text-rose-400" />
                      <span className="text-rose-300">Con errores</span>
                    </>
                  )}
                </div>
              </div>
              <div className="rounded-lg border border-slate-800 bg-[#090d16] p-3">
                <div className="text-slate-400">Entradas</div>
                <div className="mt-1 font-mono font-semibold text-slate-100">
                  {validationReport.validEntries} / {validationReport.totalEntries}
                </div>
              </div>
              <div className="rounded-lg border border-slate-800 bg-[#090d16] p-3">
                <div className="text-slate-400">Errores</div>
                <div className="mt-1 font-mono font-semibold text-rose-400">
                  {validationReport.errorCount}
                </div>
              </div>
              <div className="rounded-lg border border-slate-800 bg-[#090d16] p-3">
                <div className="text-slate-400">Avisos</div>
                <div className="mt-1 font-mono font-semibold text-amber-300">
                  {validationReport.warningCount}
                </div>
              </div>
              <div className="rounded-lg border border-slate-800 bg-[#090d16] p-3">
                <div className="text-slate-400">Orígenes detectados</div>
                <div className="mt-1 font-mono text-[11px] text-cyan-300 truncate">
                  {validationReport.detectedOrigins.join(', ') || 'Ninguno'}
                </div>
              </div>
            </div>

            {validationReport.issues.length === 0 ? (
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-xs text-emerald-200 flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                <span>
                  Validación limpia: "{validationReport.sourceName}" cumple al 100% con el estándar RadioBOSS.
                </span>
              </div>
            ) : (
              <div className="rounded-lg border border-slate-800 bg-[#090d16] divide-y divide-slate-800/70 max-h-64 overflow-y-auto text-xs">
                {validationReport.issues.map((iss, i) => (
                  <div key={i} className="p-2.5 flex items-start gap-2.5">
                    {iss.severity === 'ERROR' ? (
                      <AlertTriangle className="w-3.5 h-3.5 text-rose-400 shrink-0 mt-0.5" />
                    ) : iss.severity === 'AVISO' ? (
                      <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0 mt-0.5" />
                    ) : (
                      <Info className="w-3.5 h-3.5 text-blue-400 shrink-0 mt-0.5" />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span
                          className={`font-mono font-semibold ${
                            iss.severity === 'ERROR'
                              ? 'text-rose-300'
                              : iss.severity === 'AVISO'
                              ? 'text-amber-300'
                              : 'text-blue-300'
                          }`}
                        >
                          {iss.severity}
                        </span>
                        <span className="font-mono text-slate-500">Línea {iss.line}</span>
                        <span className="font-mono text-slate-400">({iss.code})</span>
                      </div>
                      <p className="text-slate-200 mt-0.5">{iss.message}</p>
                      {iss.path && (
                        <p className="font-mono text-[11px] text-slate-500 truncate mt-0.5">
                          {iss.path}
                        </p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Inspect Songs Modal */}
      {inspectTracksPl && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <div className="w-full max-w-2xl rounded-2xl border border-slate-800 bg-[#101726] p-5 space-y-3 text-xs">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-100">
                Canciones utilizadas en "{inspectTracksPl.name}"
              </h3>
              <button
                type="button"
                onClick={() => setInspectTracksPl(null)}
                className="p-1 text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="max-h-96 overflow-y-auto divide-y divide-slate-800/70">
              {inspectTracksPl.items.map((it, idx) => (
                <div key={it.uid} className="py-2 flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="font-mono text-slate-500 w-6 text-right">{idx + 1}</span>
                    {it.isSpot && (
                      <span className="rounded px-1 py-0.5 text-[10px] font-mono bg-amber-500/20 text-amber-300">
                        SPOT
                      </span>
                    )}
                    <div className="min-w-0">
                      <p className="text-slate-100 truncate">
                        {it.artist} — {it.title}
                      </p>
                      <p className="text-[11px] font-mono text-slate-500 truncate">
                        {it.relativePath}
                      </p>
                    </div>
                  </div>
                  <span className="font-mono text-slate-300 shrink-0">
                    {formatDuration(it.duration)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Inspect Playlist Stats Modal */}
      {inspectStatsPl && playlistStats && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-[#101726] p-5 space-y-4 text-xs">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-100">
                Estadísticas de "{inspectStatsPl.name}"
              </h3>
              <button
                type="button"
                onClick={() => setInspectStatsPl(null)}
                className="p-1 text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2 font-mono">
              <div className="rounded-lg border border-slate-800 bg-[#090d16] p-2.5">
                <div className="text-slate-400">Canciones</div>
                <div className="text-base font-bold text-slate-100">
                  {inspectStatsPl.musicCount}
                </div>
              </div>
              <div className="rounded-lg border border-slate-800 bg-[#090d16] p-2.5">
                <div className="text-slate-400">Duración</div>
                <div className="text-base font-bold text-cyan-300">
                  {formatDuration(inspectStatsPl.totalDuration)}
                </div>
              </div>
              <div className="rounded-lg border border-slate-800 bg-[#090d16] p-2.5">
                <div className="text-slate-400">BPM Prom.</div>
                <div className="text-base font-bold text-violet-300">
                  {playlistStats.avgBpm || '—'}
                </div>
              </div>
            </div>
            <div>
              <div className="font-semibold text-slate-300 mb-1.5">Géneros</div>
              <div className="space-y-1">
                {playlistStats.genres.map(([g, c]) => (
                  <div key={g} className="flex justify-between font-mono text-slate-400">
                    <span>{g}</span>
                    <span className="text-slate-200">{c}</span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <div className="font-semibold text-slate-300 mb-1.5">Intensidad</div>
              <div className="space-y-1">
                {playlistStats.intensities.map(([i, c]) => (
                  <div key={i} className="flex justify-between font-mono text-slate-400">
                    <span>{i}</span>
                    <span className="text-slate-200">{c}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(confirmDeletePl)}
        title="Eliminar referencia de playlist"
        message={`¿Confirmas eliminar "${confirmDeletePl?.name}" del administrador? Los archivos de audio originales jamás serán eliminados.`}
        onConfirm={async () => {
          if (confirmDeletePl) {
            await db.playlists.delete(confirmDeletePl.id);
            if (generatorEditingId === confirmDeletePl.id) {
              setGeneratorEditingId(null);
            }
            setConfirmDeletePl(null);
            await refreshAll();
            showToast('info', 'Referencia de playlist eliminada.');
          }
        }}
        onCancel={() => setConfirmDeletePl(null)}
      />

      <FolderReconnectModal
        open={showReconnectModal}
        playlistName={selectedPlaylist?.name || 'Playlist'}
        exportLabel={`.${exportFormat.toUpperCase()}`}
        verification={diskVerification}
        isVerifying={isVerifyingDisk}
        onReverify={async () => {
          if (selectedPlaylist) {
            await runDiskVerification(selectedPlaylist);
          }
        }}
        onProceedExport={async () => {
          if (selectedPlaylist) {
            const fresh = (await db.playlists.get(selectedPlaylist.id)) || selectedPlaylist;
            await performExportDownload(fresh);
          }
        }}
        onClose={() => setShowReconnectModal(false)}
      />
    </div>
  );
};
