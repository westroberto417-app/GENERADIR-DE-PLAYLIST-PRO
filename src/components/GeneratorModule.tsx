import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Ban,
  BookmarkPlus,
  CheckCircle2,
  Download,
  Edit2,
  ExternalLink,
  FolderPlus,
  History,
  Plus,
  Radio,
  RotateCcw,
  Save,
  Shuffle,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import { addActivityLog, db } from '../db/database';
import { createDefaultGeneratorConfig, useStudio } from '../context/StudioContext';
import {
  supportsFileSystemAccess,
  verifyPlaylistFilesOnDisk,
  type PreExportFileVerificationResult,
} from '../services/fileAccessService';
import { normalizeText } from '../services/metadataParser';
import {
  buildLibraryTemplates,
  extractLibraryFacets,
} from '../services/libraryFacetsAndTemplates';
import { generateSmartPlaylist, matchesTrackFilters } from '../services/playlistEngine';
import {
  buildPlaylistOutputPathHint,
  buildRadioBossM3UContent,
  downloadTextFile,
  isFolderPathPendingConfirmation,
} from '../services/radioboss';
import {
  CURVE_PRESETS,
  type CurvePreset,
  type GenerationMode,
  type GeneratorProfile,
  type PathExportMode,
  type PlaylistGeneratorConfig,
  type PlaylistItem,
  type SavedPlaylist,
} from '../types/studio';
import { formatDateTime, formatDuration } from '../utils/formatters';
import { ConfirmDialog } from './ConfirmDialog';
import { FolderDiskPathEditor } from './FolderDiskPathEditor';
import { FolderReconnectModal } from './FolderReconnectModal';
import { ProgressiveCurveCanvas } from './ProgressiveCurveCanvas';

const GENERATION_MODES: GenerationMode[] = [
  'Aleatorio',
  'Por género',
  'Por década',
  'Por BPM',
  'Por intensidad',
  'Por ambiente',
  'Combinado',
  'Progresivo',
];

export const GeneratorModule: React.FC = () => {
  const {
    tracks,
    folders,
    generatorProfiles,
    usageHistory,
    settings,
    pendingGeneratorTrackIds,
    setPendingGeneratorTrackIds,
    editingPlaylist,
    setEditingPlaylist,
    generatorConfig: config,
    setGeneratorConfig: setConfig,
    generatorPreviewItems: previewItems,
    setGeneratorPreviewItems: setPreviewItems,
    generatorWarnings: warnings,
    setGeneratorWarnings: setWarnings,
    generatorEditingId: editingPlaylistId,
    setGeneratorEditingId: setEditingPlaylistId,
    setSelectedRadioBossPlaylistId,
    importFolderViaPicker,
    importFilesViaInput,
    refreshAll,
    updateSettings,
    showToast,
    setActiveModule,
  } = useStudio();

  const spotFolderInputRef = useRef<HTMLInputElement>(null);
  const musicFolderInputRef = useRef<HTMLInputElement>(null);
  const previewPanelRef = useRef<HTMLDivElement>(null);

  const musicTracks = useMemo(() => tracks.filter((t) => !t.isSpotFolder), [tracks]);
  const musicFolders = useMemo(() => folders.filter((f) => f.role === 'music'), [folders]);
  const spotFolders = useMemo(() => folders.filter((f) => f.role === 'spots'), [folders]);

  const [isGenerating, setIsGenerating] = useState(false);
  const [showRecentModal, setShowRecentModal] = useState(false);
  const [showAddTrackModal, setShowAddTrackModal] = useState(false);
  const [manualSearch, setManualSearch] = useState('');
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [editingItemUid, setEditingItemUid] = useState<string | null>(null);
  const [inlineEdit, setInlineEdit] = useState({ title: '', artist: '' });
  const [profileNameDraft, setProfileNameDraft] = useState('');
  const [showSaveProfile, setShowSaveProfile] = useState(false);
  const [confirmProfileDelete, setConfirmProfileDelete] = useState<GeneratorProfile | null>(null);
  const [pendingExportPlaylist, setPendingExportPlaylist] = useState<SavedPlaylist | null>(null);
  const [diskVerification, setDiskVerification] = useState<PreExportFileVerificationResult | null>(
    null
  );
  const [isVerifyingDisk, setIsVerifyingDisk] = useState(false);
  const [showReconnectModal, setShowReconnectModal] = useState(false);

  useEffect(() => {
    if (!config.spots.spotFolderId && spotFolders.length > 0) {
      setConfig((c) => ({ ...c, spots: { ...c.spots, spotFolderId: spotFolders[0].id } }));
    }
  }, [spotFolders, config.spots.spotFolderId, setConfig]);

  useEffect(() => {
    if (config.sourceScope === 'folder' && !config.sourceFolderId && musicFolders.length > 0) {
      setConfig((c) => ({ ...c, sourceFolderId: musicFolders[0].id }));
    }
  }, [config.sourceScope, config.sourceFolderId, musicFolders, setConfig]);

  useEffect(() => {
    if (pendingGeneratorTrackIds.length > 0) {
      const idSet = new Set(pendingGeneratorTrackIds);
      const selected = tracks.filter((t) => idSet.has(t.id));
      const newItems: PlaylistItem[] = selected.map((t) => ({
        uid: `${t.id}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        trackId: t.id,
        isSpot: t.isSpotFolder,
        title: t.title,
        artist: t.artist,
        duration: t.duration > 0 ? t.duration : 180,
        bpm: t.bpm,
        intensity: t.intensity,
        genre: t.genre,
        folderId: t.folderId,
        relativePath: t.relativePath,
        fileName: t.fileName,
        accessible: t.accessible,
      }));
      setPreviewItems((prev) => [...prev, ...newItems]);
      setPendingGeneratorTrackIds([]);
      showToast('success', `${newItems.length} pista(s) añadidas a la vista previa.`);
    }
  }, [pendingGeneratorTrackIds, tracks, setPendingGeneratorTrackIds, setPreviewItems, showToast]);

  useEffect(() => {
    if (editingPlaylist) {
      setEditingPlaylistId(editingPlaylist.id);
      setConfig((c) => ({ ...c, name: editingPlaylist.name, mode: editingPlaylist.mode }));
      setPreviewItems(editingPlaylist.items);
      setWarnings(editingPlaylist.warnings || []);
      setEditingPlaylist(null);
    }
  }, [editingPlaylist, setConfig, setEditingPlaylist, setEditingPlaylistId, setPreviewItems, setWarnings]);

  const scopedSourceTracks = useMemo(() => {
    if (config.sourceScope === 'folder' && config.sourceFolderId) {
      return musicTracks.filter((t) => t.folderId === config.sourceFolderId);
    }
    return musicTracks;
  }, [musicTracks, config.sourceScope, config.sourceFolderId]);

  const facets = useMemo(() => extractLibraryFacets(scopedSourceTracks), [scopedSourceTracks]);
  const libraryTemplates = useMemo(
    () => buildLibraryTemplates(scopedSourceTracks, facets),
    [scopedSourceTracks, facets]
  );

  const applyTemplate = (tplId: string) => {
    const tpl = libraryTemplates.find((t) => t.id === tplId);
    if (!tpl) return;
    setConfig((prev) => ({
      ...prev,
      templateId: tplId,
      allowedGenres: [],
      excludedGenres: [],
      decades: [],
      years: [],
      includedArtists: [],
      excludedArtists: [],
      bpmMin: null,
      bpmMax: null,
      energyLevels: [],
      intensities: [],
      moods: [],
      ...tpl.patch,
    }));
    showToast('info', `Plantilla "${tpl.name}" aplicada (${tpl.matchingCount ?? 0} pistas).`);
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = profileNameDraft.trim() || config.name;
    const profile: GeneratorProfile = {
      id: `prof_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      name,
      createdAt: Date.now(),
      config: { ...config, name },
    };
    await db.generatorProfiles.put(profile);
    setShowSaveProfile(false);
    setProfileNameDraft('');
    await refreshAll();
    showToast('success', `Perfil personalizado "${name}" guardado.`);
  };

  const persistPlaylistToDb = async (
    itemsToSave: PlaylistItem[],
    warningsToSave: string[],
    replacePlaylistId: string | null,
    logActionTitle?: string
  ): Promise<SavedPlaylist> => {
    const now = Date.now();
    const totalDuration = itemsToSave.reduce((s, i) => s + i.duration, 0);
    const spotCount = itemsToSave.filter((i) => i.isSpot).length;
    const musicCount = itemsToSave.length - spotCount;

    const targetId = replacePlaylistId || `pl_${now}_${Math.random().toString(36).slice(2, 6)}`;
    const existing = replacePlaylistId ? await db.playlists.get(replacePlaylistId) : null;

    const pl: SavedPlaylist = {
      id: targetId,
      name: config.name.trim() || `Playlist ${new Date().toLocaleDateString()}`,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      mode: config.mode,
      category: config.templateId
        ? libraryTemplates.find((t) => t.id === config.templateId)?.name || config.mode
        : config.mode,
      format: settings.defaultFormat,
      outputPathHint: buildPlaylistOutputPathHint(settings),
      items: itemsToSave,
      totalDuration,
      musicCount,
      spotCount,
      warnings: warningsToSave,
    };

    await db.playlists.put(pl);

    if (replacePlaylistId) {
      await db.usageHistory.where('playlistId').equals(pl.id).delete();
    }

    const usageEntries = itemsToSave
      .filter((it) => !it.isSpot)
      .map((it) => ({
        id: `${now}_${it.trackId}_${Math.random().toString(36).slice(2, 5)}`,
        trackId: it.trackId,
        artistNormalized: normalizeText(it.artist),
        playlistId: pl.id,
        playlistName: pl.name,
        usedAt: now,
      }));
    if (usageEntries.length > 0) {
      await db.usageHistory.bulkAdd(usageEntries);
    }

    await addActivityLog(
      'generator',
      'success',
      logActionTitle || (existing ? `Playlist actualizada: "${pl.name}"` : `Playlist guardada: "${pl.name}"`),
      `${musicCount} canciones · ${spotCount} spots · ${formatDuration(totalDuration)}`
    );

    setEditingPlaylistId(pl.id);
    setSelectedRadioBossPlaylistId(pl.id);
    return pl;
  };

  const scrollPreviewIntoViewIfNeeded = () => {
    window.requestAnimationFrame(() => {
      const el = previewPanelRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (rect.top < 56 || rect.top > window.innerHeight - 140) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    });
  };

  const handleGenerate = async () => {
    setIsGenerating(true);
    try {
      const res = await generateSmartPlaylist(config);
      setPreviewItems(res.items);
      setWarnings(res.warnings);

      if (res.items.length === 0) {
        await addActivityLog(
          'generator',
          'warning',
          `Generación sin resultados "${config.name}"`,
          res.warnings[0] || 'Ninguna pista cumplió los filtros.'
        );
        await refreshAll();
        showToast('warning', res.warnings[0] || 'No hay pistas que cumplan los filtros.');
        scrollPreviewIntoViewIfNeeded();
      } else {
        const saved = await persistPlaylistToDb(
          res.items,
          res.warnings,
          null,
          `Playlist generada: "${config.name}"`
        );
        await refreshAll();
        showToast(
          'success',
          `Playlist "${saved.name}" creada y guardada: ${res.musicCount} canciones + ${res.spotCount} spots (${formatDuration(res.totalDuration)}).`
        );
        scrollPreviewIntoViewIfNeeded();
      }
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSavePlaylist = async (replaceExisting: boolean, goToRadioBoss = false) => {
    if (previewItems.length === 0) {
      showToast('warning', 'Genera o añade al menos una pista antes de guardar.');
      return;
    }
    const saved = await persistPlaylistToDb(
      previewItems,
      warnings,
      replaceExisting ? editingPlaylistId : null
    );
    await refreshAll();
    showToast('success', `Playlist "${saved.name}" guardada en IndexedDB.`);
    if (goToRadioBoss) {
      setActiveModule('radioboss');
    }
  };

  const performDirectExportDownload = async (targetPlaylist: SavedPlaylist) => {
    const fmt = settings.defaultFormat || 'm3u8';
    const pathMode = settings.defaultPathMode || 'multi-drive';
    const { content, brokenItems, exportedCount } = await buildRadioBossM3UContent(
      targetPlaylist,
      fmt,
      pathMode
    );
    if (exportedCount === 0) {
      await refreshAll();
      showToast(
        'error',
        'No se pudo exportar el archivo: ninguna pista figura como accesible.'
      );
      return;
    }
    const safeName =
      (targetPlaylist.name || 'playlist').replace(/[<>:"/\\|?*]+/g, '_').trim() || 'playlist';
    const fileName = `${safeName}.${fmt}`;
    const downloaded = await downloadTextFile(fileName, content, 'audio/x-mpegurl;charset=utf-8');
    if (downloaded) {
      await addActivityLog(
        'export',
        brokenItems.length > 0 ? 'warning' : 'success',
        `Exportación directa: ${fileName}`,
        `${exportedCount} pistas exportadas (${pathMode}) · Omitidas: ${brokenItems.length}`
      );
      await refreshAll();
      showToast(
        brokenItems.length > 0 ? 'warning' : 'success',
        `Archivo "${fileName}" generado y descargado con ${exportedCount} pistas.`
      );
      setShowReconnectModal(false);
      setPendingExportPlaylist(null);
    } else {
      await refreshAll();
    }
  };

  const runDirectDiskCheck = async (
    targetPlaylist: SavedPlaylist
  ): Promise<PreExportFileVerificationResult> => {
    setIsVerifyingDisk(true);
    try {
      const fresh = (await db.playlists.get(targetPlaylist.id)) || targetPlaylist;
      const res = await verifyPlaylistFilesOnDisk(fresh, { requestHandlePermission: true });
      setDiskVerification(res);
      await refreshAll();
      return res;
    } finally {
      setIsVerifyingDisk(false);
    }
  };

  const handleDirectExportFile = async () => {
    if (previewItems.length === 0) {
      showToast('warning', 'Genera o añade al menos una pista antes de exportar.');
      return;
    }
    const saved = await persistPlaylistToDb(
      previewItems,
      warnings,
      editingPlaylistId,
      editingPlaylistId ? undefined : `Playlist exportada: "${config.name}"`
    );
    setPendingExportPlaylist(saved);
    const verification = await runDirectDiskCheck(saved);
    if (verification.needsReconnect) {
      setShowReconnectModal(true);
      return;
    }
    const fresh = (await db.playlists.get(saved.id)) || saved;
    await performDirectExportDownload(fresh);
  };

  const moveItem = (idx: number, delta: number) => {
    const target = idx + delta;
    if (target < 0 || target >= previewItems.length) return;
    const copy = [...previewItems];
    const [moved] = copy.splice(idx, 1);
    copy.splice(target, 0, moved);
    setPreviewItems(copy);
  };

  const shufflePreviewMusic = () => {
    const musicOnly = previewItems.filter((i) => !i.isSpot);
    for (let i = musicOnly.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [musicOnly[i], musicOnly[j]] = [musicOnly[j], musicOnly[i]];
    }
    let mIdx = 0;
    setPreviewItems((prev) => prev.map((it) => (it.isSpot ? it : musicOnly[mIdx++])));
  };

  const excludeArtistAndRemove = (artist: string) => {
    const clean = artist.trim();
    if (!clean || clean === 'Desconocido') return;
    setConfig((c) => ({
      ...c,
      excludedArtists: c.excludedArtists.includes(clean)
        ? c.excludedArtists
        : [...c.excludedArtists, clean],
    }));
    setPreviewItems((prev) =>
      prev.filter((it) => it.isSpot || normalizeText(it.artist) !== normalizeText(clean))
    );
    showToast('info', `Artista "${clean}" excluido del generador.`);
  };

  const toggleSelection = <T,>(arr: T[], val: T): T[] =>
    arr.includes(val) ? arr.filter((x) => x !== val) : [...arr, val];

  const totalPreviewDuration = useMemo(
    () => previewItems.reduce((sum, it) => sum + it.duration, 0),
    [previewItems]
  );
  const previewSpotCount = useMemo(
    () => previewItems.filter((it) => it.isSpot).length,
    [previewItems]
  );

  const previewFolders = useMemo(() => {
    const folderIds = new Set(previewItems.map((it) => it.folderId));
    return folders.filter((f) => folderIds.has(f.id));
  }, [folders, previewItems]);

  const hasPendingPreviewFolderPaths = useMemo(
    () =>
      (settings.defaultPathMode || 'multi-drive') === 'multi-drive' &&
      previewFolders.some((f) => isFolderPathPendingConfirmation(f)),
    [previewFolders, settings.defaultPathMode]
  );

  const actualEnergies = useMemo(() => {
    const trackMap = new Map(tracks.map((t) => [t.id, t]));
    return previewItems
      .filter((it) => !it.isSpot)
      .map((it) => {
        const t = trackMap.get(it.trackId);
        return t?.energyScore ?? 50;
      });
  }, [previewItems, tracks]);

  const manualCandidates = useMemo(() => {
    const q = manualSearch.trim().toLowerCase();
    return tracks
      .filter((t) =>
        q
          ? `${t.title} ${t.artist} ${t.genre}`.toLowerCase().includes(q)
          : true
      )
      .slice(0, 60);
  }, [tracks, manualSearch]);

  const recentUsageList = useMemo(() => {
    const cutoff = Date.now() - config.antiRepeatHours * 3600 * 1000;
    const trackMap = new Map(tracks.map((t) => [t.id, t]));
    return usageHistory
      .filter((u) => u.usedAt >= cutoff)
      .map((u) => ({
        ...u,
        track: trackMap.get(u.trackId),
      }));
  }, [usageHistory, config.antiRepeatHours, tracks]);

  const eligibleStats = useMemo(() => {
    const matching = scopedSourceTracks.filter((t) => matchesTrackFilters(t, config) && t.accessible);
    const recentIds = new Set(recentUsageList.map((u) => u.trackId));
    const eligible =
      config.respectAntiRepeat && config.antiRepeatHours > 0
        ? matching.filter((t) => !recentIds.has(t.id))
        : matching;
    return {
      matchingCount: matching.length,
      eligibleCount: eligible.length,
    };
  }, [scopedSourceTracks, config, recentUsageList]);

  const hasActiveFilters = Boolean(
    config.templateId ||
      config.sourceScope === 'folder' ||
      config.allowedGenres.length > 0 ||
      config.excludedGenres.length > 0 ||
      config.decades.length > 0 ||
      (config.years?.length || 0) > 0 ||
      config.includedArtists.length > 0 ||
      config.excludedArtists.length > 0 ||
      config.bpmMin !== null ||
      config.bpmMax !== null ||
      (config.energyLevels?.length || 0) > 0 ||
      config.intensities.length > 0 ||
      config.moods.length > 0
  );

  const resetFilters = () => {
    const base = createDefaultGeneratorConfig(settings, config.spots.spotFolderId);
    setConfig((prev) => ({
      ...base,
      name: prev.name,
      targetType: prev.targetType,
      targetDurationMin: prev.targetDurationMin,
      targetCount: prev.targetCount,
      mode: prev.mode,
      noRepeatTracks: prev.noRepeatTracks,
      noRepeatArtists: prev.noRepeatArtists,
      progressiveCurve: prev.progressiveCurve,
      spots: prev.spots,
    }));
    showToast('info', 'Filtros limpiados para usar todo el catálogo musical.');
  };

  return (
    <div className="space-y-4">
      <input
        ref={musicFolderInputRef}
        type="file"
        multiple
        // @ts-expect-error webkitdirectory
        webkitdirectory=""
        className="hidden"
        onChange={async (e) => {
          if (e.target.files?.length) {
            const folder = await importFilesViaInput(e.target.files, 'music', 'Música');
            if (folder) {
              setConfig((c) => ({
                ...c,
                sourceScope: 'folder',
                sourceFolderId: folder.id,
              }));
            }
            e.target.value = '';
          }
        }}
      />
      <input
        ref={spotFolderInputRef}
        type="file"
        multiple
        // @ts-expect-error webkitdirectory
        webkitdirectory=""
        className="hidden"
        onChange={async (e) => {
          if (e.target.files?.length) {
            const folder = await importFilesViaInput(e.target.files, 'spots', 'Spots_Pisadores');
            if (folder) {
              setConfig((c) => ({
                ...c,
                spots: { ...c.spots, enabled: true, spotFolderId: folder.id },
              }));
            }
            e.target.value = '';
          }
        }}
      />

      {/* Library-Driven Smart Templates + Custom Saved Profiles */}
      <div className="rounded-xl border border-slate-800/80 bg-[#101726] p-4 space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">
              Plantillas generadas desde tu biblioteca ({libraryTemplates.length})
            </h2>
            <p className="text-[11px] text-slate-400">
              Construidas automáticamente con los géneros, años, décadas, BPM y análisis reales de tus canciones.
            </p>
          </div>
          <div className="flex items-center gap-3 text-xs">
            <span className="text-slate-400">
              Pool musical: <strong className="font-mono text-slate-200">{musicTracks.length}</strong> pistas
            </span>
            <button
              type="button"
              onClick={() => {
                setProfileNameDraft(config.name);
                setShowSaveProfile(true);
              }}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-xs font-medium text-cyan-300 hover:bg-slate-800 cursor-pointer"
            >
              <BookmarkPlus className="w-3.5 h-3.5" />
              Guardar perfil actual
            </button>
          </div>
        </div>

        {libraryTemplates.length === 0 ? (
          <div className="rounded-lg border border-dashed border-slate-800 bg-[#090d16] p-4 text-xs text-slate-400">
            Importa una carpeta musical en <strong>Biblioteca Musical</strong> para extraer automáticamente géneros, años, BPM y crear plantillas basadas en tu música real.
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-2">
            {libraryTemplates.map((tpl) => {
              const active = config.templateId === tpl.id;
              return (
                <button
                  key={tpl.id}
                  type="button"
                  onClick={() => applyTemplate(tpl.id)}
                  className={`rounded-lg border p-2.5 text-left transition-colors cursor-pointer flex flex-col justify-between gap-1.5 ${
                    active
                      ? 'border-cyan-500 bg-cyan-500/15 text-slate-100'
                      : 'border-slate-800 bg-[#090d16] text-slate-300 hover:border-slate-700'
                  }`}
                >
                  <div>
                    <div className="flex items-start justify-between gap-1.5">
                      <div className="text-xs font-semibold truncate">{tpl.name}</div>
                      <span className="font-mono text-[10px] text-emerald-300 shrink-0">
                        {tpl.matchingCount ?? 0}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-400 line-clamp-2 mt-0.5">
                      {tpl.description}
                    </div>
                  </div>
                  {tpl.tags && tpl.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {tpl.tags.slice(0, 3).map((tag) => (
                        <span
                          key={tag}
                          className="rounded bg-slate-800/90 px-1.5 py-0.5 text-[10px] font-mono text-slate-300"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {generatorProfiles.length > 0 && (
          <div className="pt-2 border-t border-slate-800/70 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-slate-400">Perfiles guardados:</span>
            {generatorProfiles.map((prof) => (
              <div
                key={prof.id}
                className="inline-flex items-center rounded-lg border border-violet-500/35 bg-violet-500/10 overflow-hidden"
              >
                <button
                  type="button"
                  onClick={() => {
                    setConfig(prof.config);
                    showToast('info', `Perfil "${prof.name}" cargado.`);
                  }}
                  className="px-2.5 py-1 text-violet-200 hover:bg-violet-500/20 cursor-pointer"
                >
                  {prof.name}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmProfileDelete(prof)}
                  className="px-1.5 py-1 text-violet-300 hover:text-rose-300 hover:bg-rose-500/15 cursor-pointer"
                  title="Eliminar perfil"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Main Split: Configuration (Left) + Preview (Right) */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
        <div className="xl:col-span-5 space-y-4">
          <div className="rounded-xl border border-slate-800/80 bg-[#101726] p-4 space-y-4">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Nombre de la playlist</label>
              <input
                type="text"
                value={config.name}
                onChange={(e) => setConfig((c) => ({ ...c, name: e.target.value }))}
                className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 text-xs text-slate-100 focus:outline-none focus:border-cyan-500"
              />
            </div>

            {/* Source Folder vs Global Random Mix */}
            <div className="space-y-2.5 pt-2 border-t border-slate-800/70 text-xs">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-slate-200">
                  Origen de mezcla (Biblioteca o Carpeta específica)
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setConfig((c) => ({
                      ...c,
                      mode: c.mode === 'Aleatorio' ? 'Progresivo' : 'Aleatorio',
                    }))
                  }
                  className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 text-[11px] font-semibold cursor-pointer ${
                    config.mode === 'Aleatorio'
                      ? 'border-cyan-500 bg-cyan-500/20 text-cyan-200'
                      : 'border-slate-700 bg-slate-800/80 text-slate-300 hover:text-white'
                  }`}
                  title="Activar mezcla totalmente aleatoria desde el origen seleccionado"
                >
                  <Shuffle className="w-3 h-3" />
                  Mezcla aleatoria {config.mode === 'Aleatorio' ? 'activa' : ''}
                </button>
              </div>

              <div className="grid grid-cols-2 gap-1.5 p-1 rounded-lg bg-[#090d16] border border-slate-800">
                <button
                  type="button"
                  onClick={() =>
                    setConfig((c) => ({ ...c, sourceScope: 'all', sourceFolderId: '' }))
                  }
                  className={`py-1.5 px-2 rounded text-[11px] font-medium cursor-pointer ${
                    (config.sourceScope || 'all') === 'all'
                      ? 'bg-cyan-500 text-slate-950 font-semibold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Toda la biblioteca ({musicTracks.length})
                </button>
                <button
                  type="button"
                  onClick={() =>
                    setConfig((c) => ({
                      ...c,
                      sourceScope: 'folder',
                      sourceFolderId: c.sourceFolderId || musicFolders[0]?.id || '',
                    }))
                  }
                  className={`py-1.5 px-2 rounded text-[11px] font-medium cursor-pointer ${
                    config.sourceScope === 'folder'
                      ? 'bg-cyan-500 text-slate-950 font-semibold'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  Carpeta específica
                </button>
              </div>

              {config.sourceScope === 'folder' && (
                <div className="flex flex-col sm:flex-row gap-2">
                  <select
                    value={config.sourceFolderId || ''}
                    onChange={(e) =>
                      setConfig((c) => ({ ...c, sourceFolderId: e.target.value }))
                    }
                    className="flex-1 rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 text-slate-100"
                  >
                    <option value="">Elegir carpeta de música...</option>
                    {musicFolders.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name} ({f.trackCount} temas)
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={async () => {
                      if (supportsFileSystemAccess()) {
                        const folder = await importFolderViaPicker('music', null, () =>
                          musicFolderInputRef.current?.click()
                        );
                        if (folder) {
                          setConfig((c) => ({
                            ...c,
                            sourceScope: 'folder',
                            sourceFolderId: folder.id,
                          }));
                        }
                      } else {
                        musicFolderInputRef.current?.click();
                      }
                    }}
                    className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/10 px-3 py-2 font-medium text-cyan-200 hover:bg-cyan-500/20 shrink-0 cursor-pointer"
                  >
                    <FolderPlus className="w-3.5 h-3.5" />
                    Importar carpeta
                  </button>
                </div>
              )}
            </div>

            {/* Target Type & Generation Mode */}
            <div className="space-y-3 pt-2 border-t border-slate-800/70 text-xs">
              <div>
                <label className="block text-slate-400 mb-1.5">
                  Generar por cantidad de temas o tiempo específico
                </label>
                <div className="grid grid-cols-3 gap-1.5 p-1 rounded-lg bg-[#090d16] border border-slate-800">
                  {[
                    { id: 'count' as const, label: 'Cantidad de temas' },
                    { id: 'duration' as const, label: 'Tiempo específico' },
                    { id: 'both' as const, label: 'Ambos' },
                  ].map((opt) => (
                    <button
                      key={opt.id}
                      type="button"
                      onClick={() => setConfig((c) => ({ ...c, targetType: opt.id }))}
                      className={`py-1.5 px-2 rounded text-[11px] font-medium cursor-pointer ${
                        config.targetType === opt.id
                          ? 'bg-emerald-500 text-slate-950 font-semibold'
                          : 'text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {(config.targetType === 'duration' || config.targetType === 'both') && (
                  <div className="space-y-1.5">
                    <label className="block text-slate-400">Duración específica (min)</label>
                    <input
                      type="number"
                      min={1}
                      max={720}
                      value={config.targetDurationMin}
                      onChange={(e) =>
                        setConfig((c) => ({
                          ...c,
                          targetDurationMin: Math.max(1, Number(e.target.value) || 60),
                        }))
                      }
                      className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 font-mono text-slate-100"
                    />
                    <div className="flex flex-wrap gap-1">
                      {[30, 60, 90, 120, 180].map((min) => (
                        <button
                          key={min}
                          type="button"
                          onClick={() => setConfig((c) => ({ ...c, targetDurationMin: min }))}
                          className={`px-2 py-0.5 rounded font-mono text-[10px] cursor-pointer ${
                            config.targetDurationMin === min
                              ? 'bg-emerald-500/25 text-emerald-200 border border-emerald-500/40'
                              : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          {min}m
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {(config.targetType === 'count' || config.targetType === 'both') && (
                  <div className="space-y-1.5">
                    <label className="block text-slate-400">Cantidad de temas</label>
                    <input
                      type="number"
                      min={1}
                      max={500}
                      value={config.targetCount}
                      onChange={(e) =>
                        setConfig((c) => ({
                          ...c,
                          targetCount: Math.max(1, Number(e.target.value) || 15),
                        }))
                      }
                      className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 font-mono text-slate-100"
                    />
                    <div className="flex flex-wrap gap-1">
                      {[10, 15, 20, 30, 50].map((cnt) => (
                        <button
                          key={cnt}
                          type="button"
                          onClick={() => setConfig((c) => ({ ...c, targetCount: cnt }))}
                          className={`px-2 py-0.5 rounded font-mono text-[10px] cursor-pointer ${
                            config.targetCount === cnt
                              ? 'bg-emerald-500/25 text-emerald-200 border border-emerald-500/40'
                              : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          {cnt}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className={config.targetType === 'both' ? 'sm:col-span-2' : ''}>
                  <label className="block text-slate-400 mb-1.5">Orden / Modo de mezcla</label>
                  <select
                    value={config.mode}
                    onChange={(e) =>
                      setConfig((c) => ({ ...c, mode: e.target.value as GenerationMode }))
                    }
                    className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 text-slate-100"
                  >
                    {GENERATION_MODES.map((m) => (
                      <option key={m} value={m}>
                        {m === 'Aleatorio' ? 'Aleatorio (mezcla aleatoria pura)' : m}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            </div>

            {config.mode === 'Progresivo' && (
              <div className="space-y-3 pt-2 border-t border-slate-800/70">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-cyan-300">
                    Curva progresiva de intensidad (4 tramos)
                  </span>
                  <div className="flex flex-wrap gap-1">
                    {(Object.keys(CURVE_PRESETS) as Array<Exclude<CurvePreset, 'Personalizada'>>).map(
                      (preset) => (
                        <button
                          key={preset}
                          type="button"
                          onClick={() =>
                            setConfig((c) => ({
                              ...c,
                              progressiveCurve: {
                                preset,
                                segments: [...CURVE_PRESETS[preset]] as [number, number, number, number],
                              },
                            }))
                          }
                          className={`px-2 py-1 rounded text-[11px] font-medium cursor-pointer ${
                            config.progressiveCurve.preset === preset
                              ? 'bg-cyan-500 text-slate-950'
                              : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                          }`}
                        >
                          {preset}
                        </button>
                      )
                    )}
                  </div>
                </div>

                <ProgressiveCurveCanvas
                  segments={config.progressiveCurve.segments}
                  actualEnergies={actualEnergies}
                />

                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
                  {[
                    'Inicio (0-20%)',
                    'Desarr. (20-50%)',
                    'Pico (50-85%)',
                    'Cierre (85-100%)',
                  ].map((label, idx) => (
                    <div key={label}>
                      <div className="flex justify-between text-slate-400 mb-0.5">
                        <span>{label}</span>
                        <span className="font-mono text-cyan-300">
                          {config.progressiveCurve.segments[idx]}
                        </span>
                      </div>
                      <input
                        type="range"
                        min={5}
                        max={100}
                        value={config.progressiveCurve.segments[idx]}
                        onChange={(e) => {
                          const val = Number(e.target.value);
                          setConfig((c) => {
                            const nextSegs = [...c.progressiveCurve.segments] as [
                              number,
                              number,
                              number,
                              number
                            ];
                            nextSegs[idx] = val;
                            return {
                              ...c,
                              progressiveCurve: { preset: 'Personalizada', segments: nextSegs },
                            };
                          });
                        }}
                        className="w-full accent-cyan-500"
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Combined Filters (100% Extracted From Library) */}
            <div className="space-y-3 pt-2 border-t border-slate-800/70 text-xs">
              <div>
                <div className="flex flex-wrap items-center justify-between gap-1 mb-1">
                  <label className="text-slate-400">Velocidad (BPM detectados)</label>
                  {facets.bpmStats && (
                    <span className="font-mono text-[11px] text-slate-400">
                      {facets.bpmStats.min}–{facets.bpmStats.max} BPM · prom. {facets.bpmStats.avg}
                    </span>
                  )}
                </div>

                {facets.bpmRanges.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 mb-2">
                    {facets.bpmRanges.map((band) => {
                      const active = config.bpmMin === band.min && config.bpmMax === band.max;
                      return (
                        <button
                          key={band.id}
                          type="button"
                          onClick={() =>
                            setConfig((c) => ({
                              ...c,
                              bpmMin: active ? null : band.min,
                              bpmMax: active ? null : band.max,
                            }))
                          }
                          className={`px-2 py-1 rounded text-[11px] font-mono border cursor-pointer ${
                            active
                              ? 'border-cyan-500 bg-cyan-500/15 text-cyan-200'
                              : 'border-slate-800 bg-[#090d16] text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          {band.label} ({band.count})
                        </button>
                      );
                    })}
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-slate-400 mb-1">BPM mínimo</label>
                    <input
                      type="number"
                      placeholder={facets.bpmStats ? `Ej. ${facets.bpmStats.min}` : 'Sin BPM'}
                      value={config.bpmMin ?? ''}
                      onChange={(e) =>
                        setConfig((c) => ({
                          ...c,
                          bpmMin: e.target.value ? Number(e.target.value) : null,
                        }))
                      }
                      className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 py-1.5 font-mono text-slate-100"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-400 mb-1">BPM máximo</label>
                    <input
                      type="number"
                      placeholder={facets.bpmStats ? `Ej. ${facets.bpmStats.max}` : 'Sin BPM'}
                      value={config.bpmMax ?? ''}
                      onChange={(e) =>
                        setConfig((c) => ({
                          ...c,
                          bpmMax: e.target.value ? Number(e.target.value) : null,
                        }))
                      }
                      className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 py-1.5 font-mono text-slate-100"
                    />
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-slate-400 mb-1">
                  Géneros en biblioteca ({facets.genres.length}) — permitir (vacío = todos)
                </label>
                {facets.genres.length === 0 ? (
                  <p className="text-[11px] text-slate-500">
                    No hay géneros etiquetados o detectados por carpeta todavía.
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1.5 max-h-28 overflow-y-auto">
                    {facets.genres.map((g) => {
                      const active = config.allowedGenres.includes(g.value);
                      return (
                        <button
                          key={g.value}
                          type="button"
                          onClick={() =>
                            setConfig((c) => ({
                              ...c,
                              allowedGenres: toggleSelection(c.allowedGenres, g.value),
                            }))
                          }
                          className={`px-2 py-1 rounded text-[11px] border cursor-pointer ${
                            active
                              ? 'border-cyan-500 bg-cyan-500/15 text-cyan-200'
                              : 'border-slate-800 bg-[#090d16] text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          {g.value} <span className="font-mono text-slate-500">({g.count})</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {facets.genres.length > 0 && (
                <div>
                  <label className="block text-slate-400 mb-1">Géneros excluidos</label>
                  <div className="flex flex-wrap gap-1.5 max-h-20 overflow-y-auto">
                    {facets.genres.map((g) => {
                      const active = config.excludedGenres.includes(g.value);
                      return (
                        <button
                          key={g.value}
                          type="button"
                          onClick={() =>
                            setConfig((c) => ({
                              ...c,
                              excludedGenres: toggleSelection(c.excludedGenres, g.value),
                            }))
                          }
                          className={`px-2 py-1 rounded text-[11px] border cursor-pointer ${
                            active
                              ? 'border-rose-500 bg-rose-500/15 text-rose-200'
                              : 'border-slate-800 bg-[#090d16] text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          {g.value}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {facets.decades.length > 0 && (
                <div>
                  <label className="block text-slate-400 mb-1">
                    Décadas detectadas ({facets.decades.length})
                  </label>
                  <div className="flex flex-wrap gap-1.5">
                    {facets.decades.map((d) => {
                      const active = config.decades.includes(d.value);
                      return (
                        <button
                          key={d.value}
                          type="button"
                          onClick={() =>
                            setConfig((c) => ({
                              ...c,
                              decades: toggleSelection(c.decades, d.value),
                            }))
                          }
                          className={`px-2 py-1 rounded text-[11px] font-mono border cursor-pointer ${
                            active
                              ? 'border-blue-500 bg-blue-500/15 text-blue-200'
                              : 'border-slate-800 bg-[#090d16] text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          {d.value} ({d.count})
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {facets.years.length > 0 && (
                <div>
                  <label className="block text-slate-400 mb-1">
                    Años detectados ({facets.years.length})
                  </label>
                  <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
                    {facets.years.map((y) => {
                      const selectedYears = config.years || [];
                      const active = selectedYears.includes(y.value);
                      return (
                        <button
                          key={y.value}
                          type="button"
                          onClick={() =>
                            setConfig((c) => ({
                              ...c,
                              years: toggleSelection(c.years || [], y.value),
                            }))
                          }
                          className={`px-2 py-1 rounded text-[11px] font-mono border cursor-pointer ${
                            active
                              ? 'border-sky-500 bg-sky-500/15 text-sky-200'
                              : 'border-slate-800 bg-[#090d16] text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          {y.value} ({y.count})
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="space-y-2">
                {facets.artists.length > 0 && (
                  <div>
                    <label className="block text-slate-400 mb-1">
                      Artistas principales en tu catálogo (clic para incluir)
                    </label>
                    <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
                      {facets.artists.slice(0, 20).map((a) => {
                        const active = config.includedArtists.some(
                          (x) => normalizeText(x) === normalizeText(a.value)
                        );
                        return (
                          <button
                            key={a.value}
                            type="button"
                            onClick={() =>
                              setConfig((c) => ({
                                ...c,
                                includedArtists: active
                                  ? c.includedArtists.filter(
                                      (x) => normalizeText(x) !== normalizeText(a.value)
                                    )
                                  : [...c.includedArtists, a.value],
                              }))
                            }
                            className={`px-2 py-1 rounded text-[11px] border cursor-pointer ${
                              active
                                ? 'border-cyan-500 bg-cyan-500/15 text-cyan-200'
                                : 'border-slate-800 bg-[#090d16] text-slate-400 hover:text-slate-200'
                            }`}
                          >
                            {a.value} <span className="font-mono text-slate-500">({a.count})</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-slate-400 mb-1">Artistas incluidos (coma)</label>
                    <input
                      type="text"
                      placeholder={
                        facets.artists[0]
                          ? `Ej. ${facets.artists.slice(0, 2).map((a) => a.value).join(', ')}`
                          : 'Separados por coma'
                      }
                      value={config.includedArtists.join(', ')}
                      onChange={(e) =>
                        setConfig((c) => ({
                          ...c,
                          includedArtists: e.target.value
                            .split(',')
                            .map((s) => s.trim())
                            .filter(Boolean),
                        }))
                      }
                      className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 py-1.5 text-slate-100"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-400 mb-1">Artistas excluidos (coma)</label>
                    <input
                      type="text"
                      placeholder="Separados por coma"
                      value={config.excludedArtists.join(', ')}
                      onChange={(e) =>
                        setConfig((c) => ({
                          ...c,
                          excludedArtists: e.target.value
                            .split(',')
                            .map((s) => s.trim())
                            .filter(Boolean),
                        }))
                      }
                      className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 py-1.5 text-slate-100"
                    />
                  </div>
                </div>
              </div>

              {facets.energyLevels.length > 0 && (
                <div>
                  <label className="block text-slate-400 mb-1">Energía musical detectada</label>
                  <div className="flex flex-wrap gap-1.5">
                    {facets.energyLevels.map((lvl) => {
                      const active = (config.energyLevels || []).includes(lvl.value);
                      return (
                        <button
                          key={lvl.value}
                          type="button"
                          onClick={() =>
                            setConfig((c) => ({
                              ...c,
                              energyLevels: toggleSelection(c.energyLevels || [], lvl.value),
                            }))
                          }
                          className={`px-2 py-1 rounded text-[11px] border cursor-pointer ${
                            active
                              ? 'border-blue-500 bg-blue-500/15 text-blue-200'
                              : 'border-slate-800 bg-[#090d16] text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          {lvl.value} <span className="font-mono text-slate-500">({lvl.count})</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {facets.intensities.length > 0 && (
                <div>
                  <label className="block text-slate-400 mb-1">Intensidad detectada</label>
                  <div className="flex flex-wrap gap-1.5">
                    {facets.intensities.map((lvl) => {
                      const active = config.intensities.includes(lvl.value);
                      return (
                        <button
                          key={lvl.value}
                          type="button"
                          onClick={() =>
                            setConfig((c) => ({
                              ...c,
                              intensities: toggleSelection(c.intensities, lvl.value),
                            }))
                          }
                          className={`px-2 py-1 rounded text-[11px] border cursor-pointer ${
                            active
                              ? 'border-emerald-500 bg-emerald-500/15 text-emerald-200'
                              : 'border-slate-800 bg-[#090d16] text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          {lvl.value} <span className="font-mono text-slate-500">({lvl.count})</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {facets.moods.length > 0 && (
                <div>
                  <label className="block text-slate-400 mb-1">Ambiente musical detectado</label>
                  <div className="flex flex-wrap gap-1.5">
                    {facets.moods.map((m) => {
                      const active = config.moods.includes(m.value);
                      return (
                        <button
                          key={m.value}
                          type="button"
                          onClick={() =>
                            setConfig((c) => ({
                              ...c,
                              moods: toggleSelection(c.moods, m.value),
                            }))
                          }
                          className={`px-2 py-1 rounded text-[11px] border cursor-pointer ${
                            active
                              ? 'border-violet-500 bg-violet-500/15 text-violet-200'
                              : 'border-slate-800 bg-[#090d16] text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          {m.value} <span className="font-mono text-slate-500">({m.count})</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {facets.energyLevels.length === 0 &&
                facets.intensities.length === 0 &&
                facets.moods.length === 0 && (
                  <p className="text-[11px] text-slate-500">
                    Las etiquetas de energía, intensidad y ambiente aparecerán aquí cuando ejecutes análisis <strong>Completo DSP</strong> en tus canciones.
                  </p>
                )}
            </div>

            {/* Anti-Repetition Rules */}
            <div className="space-y-3 pt-2 border-t border-slate-800/70 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-semibold text-slate-200">
                  Reglas de no repetición (temas y cantantes)
                </span>
                <button
                  type="button"
                  onClick={() => setShowRecentModal(true)}
                  className="inline-flex items-center gap-1 text-cyan-400 hover:text-cyan-300 cursor-pointer"
                >
                  <History className="w-3.5 h-3.5" />
                  Ver usadas ({recentUsageList.length})
                </button>
              </div>

              <div className="space-y-2 rounded-lg border border-slate-800 bg-[#090d16] p-3">
                <label className="flex items-start gap-2 text-slate-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={config.noRepeatTracks !== false}
                    onChange={(e) =>
                      setConfig((c) => ({ ...c, noRepeatTracks: e.target.checked }))
                    }
                    className="accent-cyan-500 mt-0.5"
                  />
                  <span>
                    <strong className="font-medium">No repetir temas</strong>
                    <span className="block text-[11px] text-slate-400">
                      Garantiza que no se repita la misma canción ni copias duplicadas dentro de la lista.
                    </span>
                  </span>
                </label>

                <label className="flex items-start gap-2 text-slate-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={Boolean(config.noRepeatArtists)}
                    onChange={(e) =>
                      setConfig((c) => ({ ...c, noRepeatArtists: e.target.checked }))
                    }
                    className="accent-cyan-500 mt-0.5"
                  />
                  <span>
                    <strong className="font-medium">No repetir cantantes / artistas</strong>
                    <span className="block text-[11px] text-slate-400">
                      Incluye como máximo 1 canción por cantante en toda la playlist generada.
                    </span>
                  </span>
                </label>

                <label className="flex items-start gap-2 text-slate-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={config.respectAntiRepeat}
                    onChange={(e) =>
                      setConfig((c) => ({ ...c, respectAntiRepeat: e.target.checked }))
                    }
                    className="accent-cyan-500 mt-0.5"
                  />
                  <span>
                    Excluir temas usados en playlists anteriores (ventana temporal)
                  </span>
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-400 mb-1">Separación si repite cantante</label>
                  <select
                    disabled={Boolean(config.noRepeatArtists)}
                    value={config.artistSeparation}
                    onChange={(e) =>
                      setConfig((c) => ({ ...c, artistSeparation: Number(e.target.value) }))
                    }
                    className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-2.5 py-1.5 text-slate-100 disabled:opacity-45"
                  >
                    <option value={0}>Sin restricción</option>
                    <option value={1}>No consecutivos (1)</option>
                    <option value={2}>Mínimo 2 pistas</option>
                    <option value={3}>Mínimo 3 pistas</option>
                    <option value={5}>Mínimo 5 pistas</option>
                  </select>
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Ventana historial (horas)</label>
                  <input
                    type="number"
                    min={0}
                    max={720}
                    disabled={!config.respectAntiRepeat}
                    value={config.antiRepeatHours}
                    onChange={(e) =>
                      setConfig((c) => ({
                        ...c,
                        antiRepeatHours: Math.max(0, Number(e.target.value) || 0),
                      }))
                    }
                    className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-2.5 py-1.5 font-mono text-slate-100 disabled:opacity-45"
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Spots, Jingles & Pisadores Mixer */}
          <div className="rounded-xl border border-amber-500/30 bg-[#101726] p-4 space-y-3 text-xs">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Radio className="w-4 h-4 text-amber-400" />
                <span className="font-semibold text-slate-100">
                  Mezclador de Spots, Jingles o Pisadores
                </span>
              </div>
              <label className="inline-flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={config.spots.enabled}
                  onChange={(e) =>
                    setConfig((c) => ({
                      ...c,
                      spots: { ...c.spots, enabled: e.target.checked },
                    }))
                  }
                  className="accent-amber-500 w-4 h-4"
                />
                <span className={config.spots.enabled ? 'text-amber-300 font-semibold' : 'text-slate-400'}>
                  {config.spots.enabled ? 'Activo' : 'Inactivo'}
                </span>
              </label>
            </div>

            <p className="text-[11px] text-slate-400">
              Los archivos de la carpeta de spots quedan aislados del pool musical y nunca se bloquean por el historial anti-repetición de 24h.
            </p>

            <div className="flex flex-col sm:flex-row gap-2">
              <select
                value={config.spots.spotFolderId}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    spots: { ...c.spots, spotFolderId: e.target.value },
                  }))
                }
                className="flex-1 rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 text-slate-100"
              >
                <option value="">Seleccionar carpeta de spots...</option>
                {spotFolders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.name} ({f.trackCount} archivos)
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={async () => {
                  if (supportsFileSystemAccess()) {
                    const folder = await importFolderViaPicker('spots', null, () =>
                      spotFolderInputRef.current?.click()
                    );
                    if (folder) {
                      setConfig((c) => ({
                        ...c,
                        spots: { ...c.spots, enabled: true, spotFolderId: folder.id },
                      }));
                    }
                  } else {
                    spotFolderInputRef.current?.click();
                  }
                }}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 font-medium text-amber-200 hover:bg-amber-500/20 shrink-0 cursor-pointer"
              >
                <FolderPlus className="w-3.5 h-3.5" />
                Agregar carpeta Spots
              </button>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-slate-400 mb-1">Intercalar cada N canciones</label>
                <div className="flex items-center gap-1.5">
                  {[2, 3, 4, 5, 8].map((n) => (
                    <button
                      key={n}
                      type="button"
                      onClick={() =>
                        setConfig((c) => ({ ...c, spots: { ...c.spots, everyNSongs: n } }))
                      }
                      className={`px-2 py-1 rounded font-mono cursor-pointer ${
                        config.spots.everyNSongs === n
                          ? 'bg-amber-500 text-slate-950 font-semibold'
                          : 'bg-slate-800 text-slate-300'
                      }`}
                    >
                      {n}
                    </button>
                  ))}
                  <input
                    type="number"
                    min={1}
                    max={50}
                    value={config.spots.everyNSongs}
                    onChange={(e) =>
                      setConfig((c) => ({
                        ...c,
                        spots: { ...c.spots, everyNSongs: Math.max(1, Number(e.target.value) || 3) },
                      }))
                    }
                    className="w-14 rounded border border-slate-800 bg-[#090d16] px-2 py-1 font-mono text-slate-100"
                  />
                </div>
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Modo de rotación</label>
                <select
                  value={config.spots.rotationMode}
                  onChange={(e) =>
                    setConfig((c) => ({
                      ...c,
                      spots: {
                        ...c.spots,
                        rotationMode: e.target.value as 'sequential' | 'random-no-repeat',
                      },
                    }))
                  }
                  className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-2.5 py-1.5 text-slate-100"
                >
                  <option value="sequential">Secuencial en orden</option>
                  <option value="random-no-repeat">Aleatorio sin repetir seguido</option>
                </select>
              </div>
            </div>

            <label className="inline-flex items-center gap-2 text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={config.spots.insertIntroAtStart}
                onChange={(e) =>
                  setConfig((c) => ({
                    ...c,
                    spots: { ...c.spots, insertIntroAtStart: e.target.checked },
                  }))
                }
                className="accent-amber-500"
              />
              Insertar pisador / intro al inicio antes de la primera canción
            </label>
          </div>

          <div className="rounded-xl border border-slate-800/80 bg-[#101726] p-3 flex flex-wrap items-center justify-between gap-2 text-xs">
            <div className="text-slate-300">
              Pistas elegibles ahora:{' '}
              <strong
                className={`font-mono ${
                  eligibleStats.eligibleCount > 0 ? 'text-emerald-300' : 'text-amber-300'
                }`}
              >
                {eligibleStats.eligibleCount}
              </strong>{' '}
              <span className="text-slate-500 font-mono">de {musicTracks.length}</span>
            </div>
            {hasActiveFilters && (
              <button
                type="button"
                onClick={resetFilters}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1 text-[11px] font-medium text-slate-200 hover:bg-slate-800 cursor-pointer"
              >
                <RotateCcw className="w-3 h-3" />
                Limpiar filtros
              </button>
            )}
          </div>

          <button
            type="button"
            disabled={isGenerating}
            onClick={handleGenerate}
            className="w-full inline-flex items-center justify-center gap-2 rounded-xl bg-cyan-500 py-3 text-sm font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-50 transition-colors cursor-pointer"
          >
            <Wand2 className="w-4 h-4" />
            {isGenerating ? 'Generando mezcla...' : 'Generar Playlist Inteligente'}
          </button>
        </div>

        {/* Right: Interactive Playlist Preview */}
        <div
          ref={previewPanelRef}
          className="xl:col-span-7 xl:sticky xl:top-20 rounded-xl border border-slate-800/80 bg-[#101726] p-4 space-y-4"
        >
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-800 pb-3">
            <div>
              <h3 className="text-sm font-semibold text-slate-100">
                Vista previa interactiva: {config.name}
              </h3>
              <p className="text-xs font-mono tabular-nums text-slate-400 mt-0.5">
                {previewItems.length - previewSpotCount} canciones · {previewSpotCount} spots · Total{' '}
                <span className="text-cyan-300 font-semibold">
                  {formatDuration(totalPreviewDuration)}
                </span>
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setShowAddTrackModal(true)}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-800 cursor-pointer"
              >
                <Plus className="w-3.5 h-3.5" />
                Añadir pista
              </button>
              <button
                type="button"
                onClick={shufflePreviewMusic}
                disabled={previewItems.length < 2}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-40 cursor-pointer"
              >
                <Shuffle className="w-3.5 h-3.5" />
                Mezclar
              </button>
              <button
                type="button"
                onClick={() => {
                  setPreviewItems([]);
                  setWarnings([]);
                  setEditingPlaylistId(null);
                }}
                disabled={previewItems.length === 0}
                className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-slate-800 disabled:opacity-40 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                Limpiar vista
              </button>
              {editingPlaylistId && (
                <button
                  type="button"
                  onClick={() => handleSavePlaylist(true, false)}
                  disabled={previewItems.length === 0}
                  className="inline-flex items-center gap-1 rounded-lg bg-amber-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-amber-400 disabled:opacity-40 cursor-pointer"
                >
                  <Save className="w-3.5 h-3.5" />
                  Actualizar
                </button>
              )}
              <button
                type="button"
                onClick={() => handleSavePlaylist(false, false)}
                disabled={previewItems.length === 0}
                className="inline-flex items-center gap-1 rounded-lg bg-emerald-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-40 cursor-pointer"
              >
                <Save className="w-3.5 h-3.5" />
                {editingPlaylistId ? 'Guardar copia' : 'Guardar'}
              </button>
              <button
                type="button"
                onClick={handleDirectExportFile}
                disabled={previewItems.length === 0}
                className="inline-flex items-center gap-1 rounded-lg bg-cyan-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-40 cursor-pointer"
                title="Generar y descargar archivo de playlist compatible con RadioBOSS"
              >
                <Download className="w-3.5 h-3.5" />
                Descargar .{(settings.defaultFormat || 'm3u8').toUpperCase()}
              </button>
              <button
                type="button"
                onClick={() => handleSavePlaylist(Boolean(editingPlaylistId), true)}
                disabled={previewItems.length === 0}
                className="inline-flex items-center gap-1 rounded-lg bg-blue-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-400 disabled:opacity-40 cursor-pointer"
              >
                Abrir en RadioBOSS
              </button>
            </div>
          </div>

          {previewItems.length > 0 && editingPlaylistId && (
            <div className="rounded-lg border border-emerald-500/35 bg-emerald-500/10 px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-xs text-emerald-200">
              <div className="flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>
                  Guardada en <strong>Playlists & RadioBOSS</strong> ({previewItems.length} pistas listas para exportar).
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={handleDirectExportFile}
                  className="inline-flex items-center gap-1 rounded-md bg-cyan-500/25 border border-cyan-400/50 px-2.5 py-1 text-[11px] font-semibold text-cyan-100 hover:bg-cyan-500/35 cursor-pointer"
                >
                  <Download className="w-3 h-3" />
                  Exportar .{(settings.defaultFormat || 'm3u8').toUpperCase()}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedRadioBossPlaylistId(editingPlaylistId);
                    setActiveModule('radioboss');
                  }}
                  className="inline-flex items-center gap-1 rounded-md bg-emerald-500/20 border border-emerald-500/40 px-2.5 py-1 text-[11px] font-semibold text-emerald-100 hover:bg-emerald-500/30 cursor-pointer"
                >
                  <ExternalLink className="w-3 h-3" />
                  Ver en RadioBOSS
                </button>
              </div>
            </div>
          )}

          {previewItems.length > 0 && previewFolders.length > 0 && (
            <FolderDiskPathEditor
              folders={previewFolders}
              compact
              defaultExpanded={hasPendingPreviewFolderPaths}
              title={`Carpetas usadas en esta playlist (${settings.defaultPathMode === 'relative' ? 'Modo: Rutas relativas' : 'Modo: Multi-unidad'})`}
              onUseRelativePaths={
                settings.defaultPathMode !== 'relative'
                  ? () => void updateSettings({ defaultPathMode: 'relative' as PathExportMode })
                  : undefined
              }
            />
          )}

          {warnings.length > 0 && (
            <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 space-y-1 text-xs text-amber-200">
              {warnings.map((w, i) => (
                <p key={i}>• {w}</p>
              ))}
            </div>
          )}

          {previewItems.length === 0 ? (
            <div className="py-12 px-4 text-center space-y-4">
              <p className="text-sm text-slate-400">
                Configura tus criterios a la izquierda y pulsa{' '}
                <strong className="text-slate-200">Generar Playlist Inteligente</strong>, o añade pistas manualmente desde la biblioteca.
              </p>
              <div className="flex flex-wrap items-center justify-center gap-2">
                <button
                  type="button"
                  disabled={isGenerating}
                  onClick={handleGenerate}
                  className="inline-flex items-center gap-2 rounded-xl bg-cyan-500 px-4 py-2.5 text-xs font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-50 cursor-pointer"
                >
                  <Wand2 className="w-4 h-4" />
                  {isGenerating ? 'Generando mezcla...' : `Generar ahora (${eligibleStats.eligibleCount} elegibles)`}
                </button>
                {hasActiveFilters && (
                  <button
                    type="button"
                    onClick={resetFilters}
                    className="inline-flex items-center gap-1.5 rounded-xl border border-slate-700 bg-slate-800/80 px-3.5 py-2.5 text-xs font-medium text-slate-200 hover:bg-slate-800 cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    Limpiar filtros
                  </button>
                )}
              </div>
            </div>
          ) : (
            <div className="divide-y divide-slate-800/60 max-h-[640px] overflow-y-auto">
              {previewItems.map((item, idx) => (
                <div
                  key={item.uid}
                  draggable
                  onDragStart={() => setDragIdx(idx)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => {
                    if (dragIdx !== null && dragIdx !== idx) {
                      const copy = [...previewItems];
                      const [moved] = copy.splice(dragIdx, 1);
                      copy.splice(idx, 0, moved);
                      setPreviewItems(copy);
                    }
                    setDragIdx(null);
                  }}
                  className={`py-2.5 px-2 flex items-center justify-between gap-2 text-xs transition-colors ${
                    item.isSpot ? 'bg-amber-500/5 hover:bg-amber-500/10' : 'hover:bg-slate-800/35'
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <span className="font-mono tabular-nums text-slate-500 w-6 text-right shrink-0">
                      {idx + 1}
                    </span>
                    {item.isSpot && (
                      <span className="rounded px-1.5 py-0.5 text-[10px] font-mono font-semibold bg-amber-500/20 text-amber-300 border border-amber-500/35 shrink-0">
                        SPOT
                      </span>
                    )}

                    {editingItemUid === item.uid ? (
                      <div className="flex flex-wrap items-center gap-1.5 flex-1">
                        <input
                          type="text"
                          value={inlineEdit.artist}
                          onChange={(e) =>
                            setInlineEdit((s) => ({ ...s, artist: e.target.value }))
                          }
                          className="rounded border border-slate-700 bg-[#090d16] px-2 py-1 text-xs text-slate-100 w-36"
                          placeholder="Artista"
                        />
                        <input
                          type="text"
                          value={inlineEdit.title}
                          onChange={(e) =>
                            setInlineEdit((s) => ({ ...s, title: e.target.value }))
                          }
                          className="rounded border border-slate-700 bg-[#090d16] px-2 py-1 text-xs text-slate-100 flex-1 min-w-[140px]"
                          placeholder="Título"
                        />
                        <button
                          type="button"
                          onClick={() => {
                            setPreviewItems((prev) =>
                              prev.map((p) =>
                                p.uid === item.uid
                                  ? {
                                      ...p,
                                      title: inlineEdit.title.trim() || p.title,
                                      artist: inlineEdit.artist.trim() || p.artist,
                                    }
                                  : p
                              )
                            );
                            setEditingItemUid(null);
                          }}
                          className="rounded bg-cyan-500 px-2 py-1 text-[11px] font-semibold text-slate-950 cursor-pointer"
                        >
                          OK
                        </button>
                      </div>
                    ) : (
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-slate-100 truncate">
                          {item.artist} — {item.title}
                        </p>
                        <p className="text-[11px] text-slate-500 truncate font-mono">
                          {item.genre} · {item.bpm ? `${item.bpm} BPM` : 'BPM —'} ·{' '}
                          {item.intensity || 'Sin intensidad'}
                        </p>
                      </div>
                    )}
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <span className="font-mono tabular-nums text-slate-300 mr-1.5">
                      {formatDuration(item.duration)}
                    </span>
                    <button
                      type="button"
                      onClick={() => moveItem(idx, -1)}
                      disabled={idx === 0}
                      className="p-1 text-slate-400 hover:text-white disabled:opacity-25 cursor-pointer"
                      title="Subir"
                    >
                      <ArrowUp className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => moveItem(idx, 1)}
                      disabled={idx === previewItems.length - 1}
                      className="p-1 text-slate-400 hover:text-white disabled:opacity-25 cursor-pointer"
                      title="Bajar"
                    >
                      <ArrowDown className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setEditingItemUid(item.uid);
                        setInlineEdit({ title: item.title, artist: item.artist });
                      }}
                      className="p-1 text-slate-400 hover:text-cyan-300 cursor-pointer"
                      title="Editar artista/título antes de exportar"
                    >
                      <Edit2 className="w-3.5 h-3.5" />
                    </button>
                    {!item.isSpot && (
                      <button
                        type="button"
                        onClick={() => excludeArtistAndRemove(item.artist)}
                        className="p-1 text-slate-400 hover:text-amber-300 cursor-pointer"
                        title="Excluir artista"
                      >
                        <Ban className="w-3.5 h-3.5" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() =>
                        setPreviewItems((prev) => prev.filter((p) => p.uid !== item.uid))
                      }
                      className="p-1 text-slate-400 hover:text-rose-400 cursor-pointer"
                      title="Quitar de la lista"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Save Profile Modal */}
      {showSaveProfile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <form
            onSubmit={handleSaveProfile}
            className="w-full max-w-sm rounded-2xl border border-slate-800 bg-[#101726] p-5 space-y-4 text-xs"
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-100">Guardar perfil de generación</h3>
              <button
                type="button"
                onClick={() => setShowSaveProfile(false)}
                className="p-1 text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div>
              <label className="block text-slate-400 mb-1">Nombre del perfil</label>
              <input
                type="text"
                required
                value={profileNameDraft}
                onChange={(e) => setProfileNameDraft(e.target.value)}
                className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 text-slate-100"
              />
            </div>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setShowSaveProfile(false)}
                className="rounded-lg border border-slate-700 px-3 py-1.5 text-slate-300"
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="rounded-lg bg-cyan-500 px-4 py-1.5 font-semibold text-slate-950"
              >
                Guardar perfil
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Recently Used Modal */}
      {showRecentModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg rounded-2xl border border-slate-800 bg-[#101726] p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-100">
                Historial anti-repetición (últimas {config.antiRepeatHours}h)
              </h3>
              <button
                type="button"
                onClick={() => setShowRecentModal(false)}
                className="p-1 text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="max-h-80 overflow-y-auto divide-y divide-slate-800/70 text-xs">
              {recentUsageList.length === 0 ? (
                <p className="py-6 text-center text-slate-500">
                  Ninguna canción registrada dentro de la ventana actual.
                </p>
              ) : (
                recentUsageList.map((entry) => (
                  <div key={entry.id} className="py-2 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-slate-200 truncate">
                        {entry.track ? `${entry.track.artist} — ${entry.track.title}` : entry.trackId}
                      </p>
                      <p className="text-slate-500 truncate">Playlist: {entry.playlistName}</p>
                    </div>
                    <span className="font-mono text-slate-400 shrink-0">
                      {formatDateTime(entry.usedAt)}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}

      {/* Add Manual Track Modal */}
      {showAddTrackModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg rounded-2xl border border-slate-800 bg-[#101726] p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-100">Añadir pista manual</h3>
              <button
                type="button"
                onClick={() => setShowAddTrackModal(false)}
                className="p-1 text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <input
              type="text"
              value={manualSearch}
              onChange={(e) => setManualSearch(e.target.value)}
              placeholder="Buscar por título, artista o género..."
              className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 text-xs text-slate-100"
            />
            <div className="max-h-72 overflow-y-auto divide-y divide-slate-800/70 text-xs">
              {manualCandidates.map((t) => (
                <div key={t.id} className="py-2 flex items-center justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-slate-200 truncate">
                      {t.isSpotFolder ? '[SPOT] ' : ''}
                      {t.artist} — {t.title}
                    </p>
                    <p className="text-slate-500 truncate font-mono">
                      {t.genre} · {formatDuration(t.duration)}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setPreviewItems((prev) => [
                        ...prev,
                        {
                          uid: `${t.id}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
                          trackId: t.id,
                          isSpot: t.isSpotFolder,
                          title: t.title,
                          artist: t.artist,
                          duration: t.duration > 0 ? t.duration : 180,
                          bpm: t.bpm,
                          intensity: t.intensity,
                          genre: t.genre,
                          folderId: t.folderId,
                          relativePath: t.relativePath,
                          fileName: t.fileName,
                          accessible: t.accessible,
                        },
                      ]);
                      showToast('success', `Añadida "${t.title}".`);
                    }}
                    className="rounded bg-cyan-500 px-2.5 py-1 text-[11px] font-semibold text-slate-950 hover:bg-cyan-400 shrink-0 cursor-pointer"
                  >
                    Añadir
                  </button>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(confirmProfileDelete)}
        title="Eliminar perfil de generación"
        message={`¿Deseas eliminar el perfil "${confirmProfileDelete?.name}"?`}
        onConfirm={async () => {
          if (confirmProfileDelete) {
            await db.generatorProfiles.delete(confirmProfileDelete.id);
            setConfirmProfileDelete(null);
            await refreshAll();
          }
        }}
        onCancel={() => setConfirmProfileDelete(null)}
      />

      <FolderReconnectModal
        open={showReconnectModal}
        playlistName={pendingExportPlaylist?.name || config.name}
        exportLabel={`.${(settings.defaultFormat || 'm3u8').toUpperCase()}`}
        verification={diskVerification}
        isVerifying={isVerifyingDisk}
        onReverify={async () => {
          if (pendingExportPlaylist) {
            await runDirectDiskCheck(pendingExportPlaylist);
          }
        }}
        onProceedExport={async () => {
          if (pendingExportPlaylist) {
            const fresh = (await db.playlists.get(pendingExportPlaylist.id)) || pendingExportPlaylist;
            await performDirectExportDownload(fresh);
          }
        }}
        onClose={() => setShowReconnectModal(false)}
      />
    </div>
  );
};
