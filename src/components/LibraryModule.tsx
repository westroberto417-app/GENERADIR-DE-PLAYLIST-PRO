import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckSquare,
  Columns,
  Edit3,
  FileAudio,
  FolderPlus,
  RefreshCw,
  Search,
  ShieldCheck,
  Sparkles,
  Square,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import { addActivityLog, db } from '../db/database';
import { useStudio } from '../context/StudioContext';
import {
  supportsFileSystemAccess,
  verifyAllFoldersAccessibility,
} from '../services/fileAccessService';
import { computeDuplicateKey, deriveDecade } from '../services/metadataParser';
import type { TrackRecord } from '../types/studio';
import { formatDuration, formatFileSize } from '../utils/formatters';
import { ConfirmDialog } from './ConfirmDialog';
import { FolderDiskPathEditor } from './FolderDiskPathEditor';

type SortField =
  | 'trackNumber'
  | 'title'
  | 'artist'
  | 'album'
  | 'genre'
  | 'year'
  | 'duration'
  | 'bpm'
  | 'intensity'
  | 'extension'
  | 'size';

const ROW_HEIGHT = 48;

export const LibraryModule: React.FC = () => {
  const {
    tracks,
    folders,
    scanProgress,
    importFolderViaPicker,
    importFilesViaInput,
    cancelScan,
    refreshAll,
    showToast,
    startBatchAnalysis,
    startBackgroundPendingAnalysis,
    setActiveModule,
    setPendingGeneratorTrackIds,
  } = useStudio();

  const dirInputRef = useRef<HTMLInputElement>(null);
  const spotInputRef = useRef<HTMLInputElement>(null);
  const filesInputRef = useRef<HTMLInputElement>(null);
  const listContainerRef = useRef<HTMLDivElement>(null);

  const [search, setSearch] = useState('');
  const [genreFilter, setGenreFilter] = useState('');
  const [artistFilter, setArtistFilter] = useState('');
  const [decadeFilter, setDecadeFilter] = useState('');
  const [durationFilter, setDurationFilter] = useState<'all' | 'short' | 'medium' | 'long'>('all');
  const [onlyDuplicates, setOnlyDuplicates] = useState(false);
  const [onlyIncomplete, setOnlyIncomplete] = useState(false);
  const [onlyInaccessible, setOnlyInaccessible] = useState(false);
  const [showSpots, setShowSpots] = useState(false);

  const [sortField, setSortField] = useState<SortField>('artist');
  const [sortAsc, setSortAsc] = useState(true);
  const [showColumnsMenu, setShowColumnsMenu] = useState(false);
  const [visibleCols, setVisibleCols] = useState({
    trackNumber: true,
    album: true,
    genre: true,
    year: true,
    duration: true,
    bpm: true,
    intensity: true,
    extension: false,
    size: false,
  });

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastSelectedIdx, setLastSelectedIdx] = useState<number | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [confirmState, setConfirmState] = useState<{
    open: boolean;
    title: string;
    message: string;
    onConfirm: () => void;
  }>({ open: false, title: '', message: '', onConfirm: () => {} });

  const [editingTrack, setEditingTrack] = useState<TrackRecord | null>(null);
  const [editForm, setEditForm] = useState({
    trackNumber: '',
    title: '',
    artist: '',
    album: '',
    genre: '',
    year: '',
    bpm: '',
  });

  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(520);

  useEffect(() => {
    const el = listContainerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setViewportHeight(el.clientHeight || 520);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const closeMenu = () => setContextMenu(null);
    window.addEventListener('click', closeMenu);
    return () => window.removeEventListener('click', closeMenu);
  }, []);

  const duplicateKeysMap = useMemo(() => {
    const map = new Map<string, TrackRecord[]>();
    for (const t of tracks) {
      const list = map.get(t.duplicateKey) || [];
      list.push(t);
      map.set(t.duplicateKey, list);
    }
    return map;
  }, [tracks]);

  const filterOptions = useMemo(() => {
    const genres = new Set<string>();
    const artists = new Set<string>();
    const decades = new Set<string>();
    for (const t of tracks) {
      if (t.genre) genres.add(t.genre);
      if (t.artist) artists.add(t.artist);
      if (t.decade) decades.add(t.decade);
    }
    return {
      genres: Array.from(genres).sort(),
      artists: Array.from(artists).sort(),
      decades: Array.from(decades).sort(),
    };
  }, [tracks]);

  const filteredTracks = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = tracks.filter((t) => {
      if (!showSpots && t.isSpotFolder) return false;
      if (q) {
        const hay = `${t.title} ${t.artist} ${t.album} ${t.genre} ${t.relativePath}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (genreFilter && t.genre !== genreFilter) return false;
      if (artistFilter && t.artist !== artistFilter) return false;
      if (decadeFilter && t.decade !== decadeFilter) return false;
      if (durationFilter === 'short' && t.duration >= 180) return false;
      if (durationFilter === 'medium' && (t.duration < 180 || t.duration > 300)) return false;
      if (durationFilter === 'long' && t.duration <= 300) return false;

      if (onlyDuplicates) {
        const group = duplicateKeysMap.get(t.duplicateKey);
        if (!group || group.length < 2) return false;
      }
      if (onlyIncomplete) {
        const incomplete =
          t.artist === 'Desconocido' ||
          t.genre === 'Desconocido' ||
          !t.year ||
          t.bpm === null;
        if (!incomplete) return false;
      }
      if (onlyInaccessible && t.accessible) return false;
      return true;
    });

    list.sort((a, b) => {
      let cmp = 0;
      switch (sortField) {
        case 'trackNumber':
          cmp = (a.trackNumber ?? 999) - (b.trackNumber ?? 999);
          break;
        case 'title':
          cmp = a.title.localeCompare(b.title);
          break;
        case 'artist':
          cmp = a.artist.localeCompare(b.artist);
          break;
        case 'album':
          cmp = a.album.localeCompare(b.album);
          break;
        case 'genre':
          cmp = a.genre.localeCompare(b.genre);
          break;
        case 'year':
          cmp = (a.year ?? 0) - (b.year ?? 0);
          break;
        case 'duration':
          cmp = a.duration - b.duration;
          break;
        case 'bpm':
          cmp = (a.bpm ?? 0) - (b.bpm ?? 0);
          break;
        case 'intensity':
          cmp = (a.energyScore ?? 0) - (b.energyScore ?? 0);
          break;
        case 'extension':
          cmp = a.extension.localeCompare(b.extension);
          break;
        case 'size':
          cmp = a.size - b.size;
          break;
      }
      return sortAsc ? cmp : -cmp;
    });

    return list;
  }, [
    tracks,
    showSpots,
    search,
    genreFilter,
    artistFilter,
    decadeFilter,
    durationFilter,
    onlyDuplicates,
    onlyIncomplete,
    onlyInaccessible,
    duplicateKeysMap,
    sortField,
    sortAsc,
  ]);

  const handleSort = (field: SortField) => {
    if (sortField === field) setSortAsc((v) => !v);
    else {
      setSortField(field);
      setSortAsc(true);
    }
  };

  const handleRowClick = (e: React.MouseEvent, index: number, trackId: string) => {
    const next = new Set(selectedIds);
    if (e.shiftKey && lastSelectedIdx !== null) {
      const start = Math.min(lastSelectedIdx, index);
      const end = Math.max(lastSelectedIdx, index);
      if (!e.ctrlKey && !e.metaKey) next.clear();
      for (let i = start; i <= end; i++) {
        next.add(filteredTracks[i].id);
      }
    } else if (e.ctrlKey || e.metaKey) {
      if (next.has(trackId)) next.delete(trackId);
      else next.add(trackId);
      setLastSelectedIdx(index);
    } else {
      next.clear();
      next.add(trackId);
      setLastSelectedIdx(index);
    }
    setSelectedIds(next);
  };

  const toggleCheckbox = (trackId: string, index: number) => {
    const next = new Set(selectedIds);
    if (next.has(trackId)) next.delete(trackId);
    else next.add(trackId);
    setLastSelectedIdx(index);
    setSelectedIds(next);
  };

  const handleRowContextMenu = (e: React.MouseEvent, index: number, trackId: string) => {
    e.preventDefault();
    if (!selectedIds.has(trackId)) {
      setSelectedIds(new Set([trackId]));
      setLastSelectedIdx(index);
    }
    setContextMenu({
      x: Math.min(e.clientX, window.innerWidth - 260),
      y: Math.min(e.clientY, window.innerHeight - 260),
    });
  };

  const selectRedundantDuplicates = () => {
    const redundant = new Set<string>();
    for (const group of duplicateKeysMap.values()) {
      if (group.length > 1) {
        const sorted = [...group].sort((a, b) => {
          if (a.accessible !== b.accessible) return a.accessible ? -1 : 1;
          if (a.analysisStatus !== b.analysisStatus) return a.analysisStatus === 'analyzed' ? -1 : 1;
          return a.createdAt - b.createdAt;
        });
        sorted.slice(1).forEach((dup) => redundant.add(dup.id));
      }
    }
    setSelectedIds(redundant);
    showToast('info', `${redundant.size} copias duplicadas redundantes seleccionadas.`);
  };

  const handleVerifyAccessibility = async () => {
    const res = await verifyAllFoldersAccessibility();
    await refreshAll();
    const relinkMsg =
      res.needsSessionRelinkFolders > 0
        ? ` · ${res.needsSessionRelinkFolders} carpeta(s) requieren re-importar solo si deseas analizar PCM`
        : '';
    showToast(
      res.inaccessible > 0 ? 'warning' : 'success',
      `Verificación: ${res.verified} accesibles, ${res.inaccessible} faltantes${relinkMsg}.`
    );
  };

  const requestCleanInaccessible = () => {
    const badIds = tracks.filter((t) => !t.accessible).map((t) => t.id);
    if (badIds.length === 0) {
      showToast('info', 'No hay registros inaccesibles para limpiar.');
      return;
    }
    setConfirmState({
      open: true,
      title: 'Limpiar registros inaccesibles',
      message: `Se quitarán ${badIds.length} registros inaccesibles del catálogo IndexedDB. Tus archivos originales en disco no serán tocados.`,
      onConfirm: async () => {
        await db.tracks.bulkDelete(badIds);
        await addActivityLog(
          'scan',
          'info',
          'Limpieza de catálogo',
          `Se quitaron ${badIds.length} registros inaccesibles del índice (sin borrar archivos del disco).`
        );
        setConfirmState((s) => ({ ...s, open: false }));
        await refreshAll();
        showToast('success', `${badIds.length} registros inaccesibles eliminados del catálogo.`);
      },
    });
  };

  const requestDeleteSelected = () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setConfirmState({
      open: true,
      title: 'Quitar pistas del catálogo',
      message: `¿Confirmas quitar ${ids.length} pista(s) seleccionadas del índice de la biblioteca? Los archivos originales en tu disco permanecerán intactos.`,
      onConfirm: async () => {
        await db.tracks.bulkDelete(ids);
        setSelectedIds(new Set());
        await addActivityLog(
          'scan',
          'info',
          'Registros quitados del catálogo',
          `${ids.length} pistas quitadas del índice.`
        );
        setConfirmState((s) => ({ ...s, open: false }));
        await refreshAll();
        showToast('success', `${ids.length} pistas quitadas del catálogo.`);
      },
    });
  };

  const openMetadataEditor = (track: TrackRecord) => {
    setEditingTrack(track);
    setEditForm({
      trackNumber: track.trackNumber ? String(track.trackNumber) : '',
      title: track.title,
      artist: track.artist,
      album: track.album,
      genre: track.genre,
      year: track.year ? String(track.year) : '',
      bpm: track.bpm ? String(track.bpm) : '',
    });
  };

  const saveMetadataEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingTrack) return;
    const yearNum = editForm.year ? Number(editForm.year) : null;
    const bpmNum = editForm.bpm ? Number(editForm.bpm) : null;
    const trkNum = editForm.trackNumber ? Number(editForm.trackNumber) : null;
    const updated: TrackRecord = {
      ...editingTrack,
      trackNumber: trkNum && Number.isFinite(trkNum) ? trkNum : null,
      title: editForm.title.trim() || editingTrack.title,
      artist: editForm.artist.trim() || 'Desconocido',
      album: editForm.album.trim() || 'Sin álbum',
      genre: editForm.genre.trim() || 'Desconocido',
      year: yearNum && Number.isFinite(yearNum) ? yearNum : null,
      decade: deriveDecade(yearNum && Number.isFinite(yearNum) ? yearNum : null),
      bpm: bpmNum && Number.isFinite(bpmNum) ? Math.round(bpmNum) : null,
      bpmConfidence:
        String(editingTrack.bpm ?? '') !== editForm.bpm ? 100 : editingTrack.bpmConfidence,
      origins: {
        ...editingTrack.origins,
        title: editForm.title !== editingTrack.title ? 'MANUAL' : editingTrack.origins.title,
        artist: editForm.artist !== editingTrack.artist ? 'MANUAL' : editingTrack.origins.artist,
        genre: editForm.genre !== editingTrack.genre ? 'MANUAL' : editingTrack.origins.genre,
        year:
          String(editingTrack.year ?? '') !== editForm.year
            ? 'MANUAL'
            : editingTrack.origins.year,
        bpm:
          String(editingTrack.bpm ?? '') !== editForm.bpm ? 'MANUAL' : editingTrack.origins.bpm,
      },
      duplicateKey: computeDuplicateKey(
        editForm.title.trim() || editingTrack.title,
        editForm.artist.trim() || 'Desconocido',
        editingTrack.duration,
        editingTrack.size
      ),
      updatedAt: Date.now(),
    };
    await db.tracks.put(updated);
    setEditingTrack(null);
    await refreshAll();
    showToast('success', 'Metadatos actualizados en el catálogo IndexedDB.');
  };

  const totalRows = filteredTracks.length;
  const totalHeight = totalRows * ROW_HEIGHT;
  const overscan = 8;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - overscan);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + overscan * 2;
  const endIndex = Math.min(totalRows, startIndex + visibleCount);
  const visibleSlice = filteredTracks.slice(startIndex, endIndex);

  const selectedTrackObjects = useMemo(
    () => tracks.filter((t) => selectedIds.has(t.id)),
    [tracks, selectedIds]
  );

  const colLabels: Record<keyof typeof visibleCols, string> = {
    trackNumber: 'N° Pista',
    album: 'Álbum',
    genre: 'Género',
    year: 'Año',
    duration: 'Duración',
    bpm: 'BPM',
    intensity: 'Intensidad',
    extension: 'Formato',
    size: 'Tamaño',
  };

  return (
    <div className="space-y-4">
      <input
        ref={dirInputRef}
        type="file"
        multiple
        // @ts-expect-error webkitdirectory
        webkitdirectory=""
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) {
            importFilesViaInput(e.target.files, 'music', 'Música');
            e.target.value = '';
          }
        }}
      />
      <input
        ref={spotInputRef}
        type="file"
        multiple
        // @ts-expect-error webkitdirectory
        webkitdirectory=""
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) {
            importFilesViaInput(e.target.files, 'spots', 'Spots_Pisadores');
            e.target.value = '';
          }
        }}
      />
      <input
        ref={filesInputRef}
        type="file"
        multiple
        accept=".mp3,.flac,.wav,.m4a,.aac,.ogg,.wma,audio/*"
        className="hidden"
        onChange={(e) => {
          if (e.target.files?.length) {
            importFilesViaInput(e.target.files, 'music', 'Archivos_Sueltos');
            e.target.value = '';
          }
        }}
      />

      {/* Action Toolbar */}
      <div className="rounded-xl border border-slate-800/80 bg-[#101726] p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() =>
              supportsFileSystemAccess()
                ? importFolderViaPicker('music', null, () => dirInputRef.current?.click())
                : dirInputRef.current?.click()
            }
            className="inline-flex items-center gap-2 rounded-lg bg-cyan-500 px-3.5 py-2 text-xs font-semibold text-slate-950 hover:bg-cyan-400 transition-colors cursor-pointer"
          >
            <FolderPlus className="w-4 h-4" />
            Importar carpeta musical
          </button>
          <button
            type="button"
            onClick={() =>
              supportsFileSystemAccess()
                ? importFolderViaPicker('spots', null, () => spotInputRef.current?.click())
                : spotInputRef.current?.click()
            }
            className="inline-flex items-center gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3.5 py-2 text-xs font-medium text-amber-300 hover:bg-amber-500/20 transition-colors cursor-pointer"
          >
            <FolderPlus className="w-4 h-4" />
            Importar carpeta Spots
          </button>
          <button
            type="button"
            onClick={() => filesInputRef.current?.click()}
            className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800/80 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 transition-colors cursor-pointer"
          >
            <FileAudio className="w-4 h-4 text-blue-400" />
            Archivos individuales
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void startBackgroundPendingAnalysis()}
            disabled={!tracks.some((t) => !t.isSpotFolder && t.analysisStatus === 'pending')}
            className="inline-flex items-center gap-1.5 rounded-lg border border-violet-500/40 bg-violet-500/15 px-3 py-2 text-xs font-medium text-violet-200 hover:bg-violet-500/25 disabled:opacity-40 cursor-pointer"
            title="Extrae metadatos, género y BPM en segundo plano para las pistas pendientes"
          >
            <Sparkles className="w-3.5 h-3.5 text-violet-400" />
            Analizar pendientes (2º plano)
          </button>
          <button
            type="button"
            onClick={handleVerifyAccessibility}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/70 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 cursor-pointer"
          >
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
            Verificar acceso
          </button>
          <button
            type="button"
            onClick={requestCleanInaccessible}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/70 px-3 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800 cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5 text-rose-400" />
            Limpiar inaccesibles
          </button>
          <button
            type="button"
            onClick={selectRedundantDuplicates}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/70 px-3 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800 cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5 text-amber-400" />
            Sel. duplicados
          </button>
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowColumnsMenu((v) => !v)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/70 px-3 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800 cursor-pointer"
            >
              <Columns className="w-3.5 h-3.5" />
              Columnas
            </button>
            {showColumnsMenu && (
              <div className="absolute right-0 mt-1.5 w-48 rounded-xl border border-slate-700 bg-[#101726] p-2.5 z-30 shadow-xl space-y-1.5">
                {(Object.keys(visibleCols) as Array<keyof typeof visibleCols>).map((key) => (
                  <label
                    key={key}
                    className="flex items-center gap-2 text-xs text-slate-300 cursor-pointer py-1 px-1.5 rounded hover:bg-slate-800"
                  >
                    <input
                      type="checkbox"
                      checked={visibleCols[key]}
                      onChange={() =>
                        setVisibleCols((prev) => ({
                          ...prev,
                          [key]: !prev[key],
                        }))
                      }
                      className="accent-cyan-500"
                    />
                    <span>{colLabels[key]}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Folder Disk Paths Banner */}
      {folders.length > 0 && (
        <FolderDiskPathEditor
          folders={folders}
          compact
          title="Carpetas vinculadas y ruta real en tu computadora"
        />
      )}

      {/* Scan Progress Bar */}
      {scanProgress && (
        <div className="rounded-xl border border-cyan-500/30 bg-[#101726] p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-cyan-300">
                {scanProgress.phase === 'discovering'
                  ? 'Explorando carpetas...'
                  : scanProgress.phase === 'parsing'
                  ? 'Leyendo metadatos reales...'
                  : scanProgress.phase === 'cancelled'
                  ? 'Escaneo cancelado'
                  : 'Escaneo finalizado'}
              </span>
              <span className="font-mono tabular-nums text-slate-300">
                {scanProgress.processed} / {scanProgress.totalDiscovered || '?'}
              </span>
            </div>
            <div className="mt-2 h-2 w-full rounded-full bg-slate-800 overflow-hidden">
              <div
                className="h-full bg-cyan-500 transition-all"
                style={{
                  width:
                    scanProgress.totalDiscovered > 0
                      ? `${Math.round((scanProgress.processed / scanProgress.totalDiscovered) * 100)}%`
                      : '35%',
                }}
              />
            </div>
            <p className="mt-1.5 text-xs font-mono text-slate-400 truncate">
              {scanProgress.currentFile} · +{scanProgress.added} nuevas · {scanProgress.skippedUnchanged} sin cambios
            </p>
          </div>
          {(scanProgress.phase === 'discovering' || scanProgress.phase === 'parsing') && (
            <button
              type="button"
              onClick={cancelScan}
              className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-xs font-semibold text-rose-300 hover:bg-rose-500/20 shrink-0 cursor-pointer"
            >
              Cancelar escaneo
            </button>
          )}
        </div>
      )}

      {/* Search & Filters */}
      <div className="rounded-xl border border-slate-800/80 bg-[#101726] p-4 space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5">
          <div className="relative lg:col-span-2">
            <Search className="w-4 h-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar título, artista, álbum, género, ruta..."
              className="w-full rounded-lg border border-slate-800 bg-[#090d16] pl-9 pr-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-cyan-500"
            />
          </div>
          <select
            value={genreFilter}
            onChange={(e) => setGenreFilter(e.target.value)}
            className="rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
          >
            <option value="">Todos los géneros</option>
            {filterOptions.genres.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
          <select
            value={decadeFilter}
            onChange={(e) => setDecadeFilter(e.target.value)}
            className="rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
          >
            <option value="">Todas las décadas</option>
            {filterOptions.decades.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
          <select
            value={durationFilter}
            onChange={(e) =>
              setDurationFilter(e.target.value as 'all' | 'short' | 'medium' | 'long')
            }
            className="rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 text-xs text-slate-200 focus:outline-none focus:border-cyan-500"
          >
            <option value="all">Cualquier duración</option>
            <option value="short">&lt; 3 min</option>
            <option value="medium">3 – 5 min</option>
            <option value="long">&gt; 5 min</option>
          </select>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
          <div className="flex flex-wrap items-center gap-3">
            <select
              value={artistFilter}
              onChange={(e) => setArtistFilter(e.target.value)}
              className="rounded-lg border border-slate-800 bg-[#090d16] px-2.5 py-1.5 text-xs text-slate-300"
            >
              <option value="">Todos los artistas</option>
              {filterOptions.artists.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>

            <label className="inline-flex items-center gap-1.5 text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={onlyDuplicates}
                onChange={(e) => setOnlyDuplicates(e.target.checked)}
                className="accent-cyan-500"
              />
              Solo duplicados
            </label>
            <label className="inline-flex items-center gap-1.5 text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={onlyIncomplete}
                onChange={(e) => setOnlyIncomplete(e.target.checked)}
                className="accent-cyan-500"
              />
              Metadatos incompletos
            </label>
            <label className="inline-flex items-center gap-1.5 text-slate-300 cursor-pointer">
              <input
                type="checkbox"
                checked={onlyInaccessible}
                onChange={(e) => setOnlyInaccessible(e.target.checked)}
                className="accent-cyan-500"
              />
              Solo inaccesibles
            </label>
            <label className="inline-flex items-center gap-1.5 text-amber-300 cursor-pointer">
              <input
                type="checkbox"
                checked={showSpots}
                onChange={(e) => setShowSpots(e.target.checked)}
                className="accent-amber-500"
              />
              Mostrar Spots ({folders.filter((f) => f.role === 'spots').length})
            </label>
          </div>

          <div className="flex items-center gap-3 font-mono tabular-nums text-slate-400">
            <span>{filteredTracks.length.toLocaleString()} pistas</span>
            {selectedIds.size > 0 && (
              <span className="text-cyan-400 font-semibold">
                {selectedIds.size} seleccionadas
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Multi-select Action Bar */}
      {selectedIds.size > 0 && (
        <div className="rounded-xl border border-cyan-500/30 bg-cyan-500/10 px-4 py-2.5 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-medium text-cyan-200">
            {selectedIds.size} pistas seleccionadas · Ctrl/Shift+Click · Clic derecho para menú contextual
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setActiveModule('analyzer');
                startBatchAnalysis(selectedTrackObjects, true);
              }}
              className="inline-flex items-center gap-1.5 rounded-lg bg-violet-500 px-3 py-1.5 text-xs font-semibold text-white hover:bg-violet-400 cursor-pointer"
            >
              <Sparkles className="w-3.5 h-3.5" />
              Analizar seleccionadas
            </button>
            <button
              type="button"
              onClick={() => {
                setPendingGeneratorTrackIds(Array.from(selectedIds));
                setActiveModule('generator');
              }}
              className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-500 px-3 py-1.5 text-xs font-semibold text-slate-950 hover:bg-cyan-400 cursor-pointer"
            >
              <Wand2 className="w-3.5 h-3.5" />
              Añadir al generador
            </button>
            <button
              type="button"
              onClick={requestDeleteSelected}
              className="inline-flex items-center gap-1.5 rounded-lg border border-rose-500/40 bg-rose-500/15 px-3 py-1.5 text-xs font-medium text-rose-200 hover:bg-rose-500/25 cursor-pointer"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Quitar del catálogo
            </button>
            <button
              type="button"
              onClick={() => setSelectedIds(new Set())}
              className="text-xs text-slate-300 hover:text-white px-2 py-1 cursor-pointer"
            >
              Limpiar
            </button>
          </div>
        </div>
      )}

      {/* Virtualized Table */}
      <div className="rounded-xl border border-slate-800/80 bg-[#101726] overflow-x-auto">
        <div className="min-w-[820px] md:min-w-0">
          <div className="hidden md:flex items-center gap-3 px-4 py-2.5 border-b border-slate-800 bg-[#0c1220] text-xs font-semibold text-slate-400">
            <button
              type="button"
              onClick={() => {
                if (selectedIds.size === filteredTracks.length) setSelectedIds(new Set());
                else setSelectedIds(new Set(filteredTracks.map((t) => t.id)));
              }}
              className="text-slate-400 hover:text-cyan-400 cursor-pointer shrink-0"
              title="Seleccionar todo"
            >
              {selectedIds.size > 0 && selectedIds.size === filteredTracks.length ? (
                <CheckSquare className="w-4 h-4 text-cyan-400" />
              ) : (
                <Square className="w-4 h-4" />
              )}
            </button>
            {visibleCols.trackNumber && (
              <button
                type="button"
                onClick={() => handleSort('trackNumber')}
                className="w-10 text-right hover:text-slate-200 shrink-0 cursor-pointer"
              >
                # {sortField === 'trackNumber' ? (sortAsc ? '↑' : '↓') : ''}
              </button>
            )}
            <button
              type="button"
              onClick={() => handleSort('title')}
              className="flex-[2] text-left hover:text-slate-200 cursor-pointer truncate"
            >
              Título / Ruta {sortField === 'title' ? (sortAsc ? '↑' : '↓') : ''}
            </button>
            <button
              type="button"
              onClick={() => handleSort('artist')}
              className="flex-1 text-left hover:text-slate-200 cursor-pointer truncate"
            >
              Artista {sortField === 'artist' ? (sortAsc ? '↑' : '↓') : ''}
            </button>
            {visibleCols.album && (
              <button
                type="button"
                onClick={() => handleSort('album')}
                className="flex-1 text-left hover:text-slate-200 cursor-pointer truncate"
              >
                Álbum {sortField === 'album' ? (sortAsc ? '↑' : '↓') : ''}
              </button>
            )}
            {visibleCols.genre && (
              <button
                type="button"
                onClick={() => handleSort('genre')}
                className="w-28 text-left hover:text-slate-200 cursor-pointer truncate"
              >
                Género {sortField === 'genre' ? (sortAsc ? '↑' : '↓') : ''}
              </button>
            )}
            {visibleCols.year && (
              <button
                type="button"
                onClick={() => handleSort('year')}
                className="w-14 text-right hover:text-slate-200 cursor-pointer"
              >
                Año {sortField === 'year' ? (sortAsc ? '↑' : '↓') : ''}
              </button>
            )}
            {visibleCols.duration && (
              <button
                type="button"
                onClick={() => handleSort('duration')}
                className="w-16 text-right hover:text-slate-200 cursor-pointer"
              >
                Dur. {sortField === 'duration' ? (sortAsc ? '↑' : '↓') : ''}
              </button>
            )}
            {visibleCols.bpm && (
              <button
                type="button"
                onClick={() => handleSort('bpm')}
                className="w-14 text-right hover:text-slate-200 cursor-pointer"
              >
                BPM {sortField === 'bpm' ? (sortAsc ? '↑' : '↓') : ''}
              </button>
            )}
            {visibleCols.intensity && (
              <button
                type="button"
                onClick={() => handleSort('intensity')}
                className="w-20 text-right hover:text-slate-200 cursor-pointer"
              >
                Intensidad {sortField === 'intensity' ? (sortAsc ? '↑' : '↓') : ''}
              </button>
            )}
            {visibleCols.extension && (
              <button
                type="button"
                onClick={() => handleSort('extension')}
                className="w-16 text-right hover:text-slate-200 cursor-pointer"
              >
                Fmt {sortField === 'extension' ? (sortAsc ? '↑' : '↓') : ''}
              </button>
            )}
            {visibleCols.size && (
              <button
                type="button"
                onClick={() => handleSort('size')}
                className="w-20 text-right hover:text-slate-200 cursor-pointer"
              >
                Tamaño {sortField === 'size' ? (sortAsc ? '↑' : '↓') : ''}
              </button>
            )}
          </div>

          {filteredTracks.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-400">
              No hay pistas que coincidan con los filtros actuales.
            </div>
          ) : (
            <div
              ref={listContainerRef}
              onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
              className="relative overflow-y-auto h-[520px] select-none"
            >
              <div style={{ height: `${totalHeight}px`, position: 'relative' }}>
                {visibleSlice.map((track, idx) => {
                  const realIdx = startIndex + idx;
                  const isSelected = selectedIds.has(track.id);
                  const isDup = (duplicateKeysMap.get(track.duplicateKey)?.length || 0) > 1;
                  return (
                    <div
                      key={track.id}
                      onClick={(e) => handleRowClick(e, realIdx, track.id)}
                      onContextMenu={(e) => handleRowContextMenu(e, realIdx, track.id)}
                      style={{
                        position: 'absolute',
                        top: `${realIdx * ROW_HEIGHT}px`,
                        left: 0,
                        right: 0,
                        height: `${ROW_HEIGHT}px`,
                      }}
                      className={`px-4 border-b border-slate-800/60 flex items-center gap-3 text-xs transition-colors cursor-pointer ${
                        isSelected
                          ? 'bg-cyan-500/15 text-slate-100'
                          : 'hover:bg-slate-800/45 text-slate-300'
                      }`}
                    >
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleCheckbox(track.id, realIdx);
                        }}
                        className="shrink-0 text-slate-400 hover:text-cyan-400 min-w-[24px] min-h-[24px] flex items-center justify-center"
                      >
                        {isSelected ? (
                          <CheckSquare className="w-4 h-4 text-cyan-400" />
                        ) : (
                          <Square className="w-4 h-4" />
                        )}
                      </button>

                      {visibleCols.trackNumber && (
                        <div className="hidden md:block w-10 text-right font-mono tabular-nums text-slate-500 shrink-0">
                          {track.trackNumber ?? '—'}
                        </div>
                      )}

                      <div className="flex-[2] min-w-0">
                        <div className="flex items-center gap-1.5">
                          {track.isSpotFolder && (
                            <span className="rounded px-1 py-0.5 text-[10px] font-mono font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/30 shrink-0">
                              SPOT
                            </span>
                          )}
                          {!track.accessible && (
                            <AlertCircle className="w-3.5 h-3.5 text-rose-400 shrink-0" />
                          )}
                          <span className="font-medium text-slate-100 truncate">
                            {track.title}
                          </span>
                          {isDup && (
                            <span className="text-[10px] font-mono text-amber-400 shrink-0">
                              DUP
                            </span>
                          )}
                        </div>
                        <p className="text-[11px] font-mono text-slate-500 truncate">
                          {track.relativePath}
                        </p>
                      </div>

                      <div className="hidden md:block flex-1 truncate text-slate-300">
                        {track.artist}
                      </div>

                      {visibleCols.album && (
                        <div className="hidden md:block flex-1 truncate text-slate-400">
                          {track.album}
                        </div>
                      )}

                      {visibleCols.genre && (
                        <div className="hidden md:block w-28 truncate text-slate-400">
                          {track.genre}
                        </div>
                      )}

                      {visibleCols.year && (
                        <div className="hidden md:block w-14 text-right font-mono tabular-nums text-slate-400">
                          {track.year ?? '—'}
                        </div>
                      )}

                      {visibleCols.duration && (
                        <div className="hidden md:block w-16 text-right font-mono tabular-nums text-slate-300">
                          {formatDuration(track.duration)}
                        </div>
                      )}

                      {visibleCols.bpm && (
                        <div className="hidden md:block w-14 text-right font-mono tabular-nums text-cyan-300">
                          {track.bpm ?? '—'}
                        </div>
                      )}

                      {visibleCols.intensity && (
                        <div className="hidden md:block w-20 text-right text-[11px] truncate">
                          {track.intensity ? (
                            <span className="text-emerald-300">{track.intensity}</span>
                          ) : (
                            <span className="text-slate-600">Pend.</span>
                          )}
                        </div>
                      )}

                      {visibleCols.extension && (
                        <div className="hidden md:block w-16 text-right font-mono uppercase text-slate-400">
                          {track.extension.replace('.', '')}
                        </div>
                      )}

                      {visibleCols.size && (
                        <div className="hidden md:block w-20 text-right font-mono tabular-nums text-slate-400">
                          {formatFileSize(track.size)}
                        </div>
                      )}

                      <div className="md:hidden text-right shrink-0 font-mono tabular-nums text-[11px] text-slate-400">
                        <div>{formatDuration(track.duration)}</div>
                        <div className="text-cyan-400">
                          {track.bpm ? `${track.bpm} BPM` : formatFileSize(track.size)}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Right-click Context Menu */}
      {contextMenu && selectedIds.size > 0 && (
        <div
          style={{ top: contextMenu.y, left: contextMenu.x }}
          className="fixed z-50 w-60 rounded-xl border border-slate-700 bg-[#101726] p-1.5 shadow-2xl text-xs"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={() => {
              setContextMenu(null);
              setActiveModule('analyzer');
              startBatchAnalysis(selectedTrackObjects, true);
            }}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-slate-200 hover:bg-slate-800 text-left cursor-pointer"
          >
            <Sparkles className="w-4 h-4 text-violet-400" />
            Analizar seleccionadas ({selectedIds.size})
          </button>
          <button
            type="button"
            onClick={() => {
              setContextMenu(null);
              setPendingGeneratorTrackIds(Array.from(selectedIds));
              setActiveModule('generator');
            }}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-slate-200 hover:bg-slate-800 text-left cursor-pointer"
          >
            <Wand2 className="w-4 h-4 text-cyan-400" />
            Añadir al generador
          </button>
          <button
            type="button"
            onClick={() => {
              setContextMenu(null);
              selectRedundantDuplicates();
            }}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-slate-200 hover:bg-slate-800 text-left cursor-pointer"
          >
            <RefreshCw className="w-4 h-4 text-amber-400" />
            Seleccionar duplicados redundantes
          </button>
          {selectedTrackObjects.length === 1 && (
            <button
              type="button"
              onClick={() => {
                setContextMenu(null);
                openMetadataEditor(selectedTrackObjects[0]);
              }}
              className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-slate-200 hover:bg-slate-800 text-left cursor-pointer"
            >
              <Edit3 className="w-4 h-4 text-blue-400" />
              Editar metadatos en catálogo
            </button>
          )}
          <div className="my-1 border-t border-slate-800" />
          <button
            type="button"
            onClick={() => {
              setContextMenu(null);
              requestDeleteSelected();
            }}
            className="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-rose-300 hover:bg-rose-500/15 text-left cursor-pointer"
          >
            <Trash2 className="w-4 h-4" />
            Quitar del catálogo
          </button>
        </div>
      )}

      {/* Metadata Editor Modal */}
      {editingTrack && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
          <form
            onSubmit={saveMetadataEdit}
            className="w-full max-w-md rounded-2xl border border-slate-800 bg-[#101726] p-6 space-y-4"
          >
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-semibold text-slate-100">
                  Editar metadatos en catálogo
                </h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  Solo actualiza IndexedDB; el archivo original permanece intacto.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setEditingTrack(null)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3 text-xs">
              <div className="grid grid-cols-4 gap-3">
                <div>
                  <label className="block text-slate-400 mb-1">N° Pista</label>
                  <input
                    type="number"
                    value={editForm.trackNumber}
                    onChange={(e) => setEditForm((f) => ({ ...f, trackNumber: e.target.value }))}
                    className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 font-mono text-slate-100"
                  />
                </div>
                <div className="col-span-3">
                  <label className="block text-slate-400 mb-1">Título</label>
                  <input
                    type="text"
                    value={editForm.title}
                    onChange={(e) => setEditForm((f) => ({ ...f, title: e.target.value }))}
                    className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 text-slate-100"
                  />
                </div>
              </div>
              <div>
                <label className="block text-slate-400 mb-1">Artista</label>
                <input
                  type="text"
                  value={editForm.artist}
                  onChange={(e) => setEditForm((f) => ({ ...f, artist: e.target.value }))}
                  className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 text-slate-100"
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-400 mb-1">Género</label>
                  <input
                    type="text"
                    value={editForm.genre}
                    onChange={(e) => setEditForm((f) => ({ ...f, genre: e.target.value }))}
                    className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Álbum</label>
                  <input
                    type="text"
                    value={editForm.album}
                    onChange={(e) => setEditForm((f) => ({ ...f, album: e.target.value }))}
                    className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 text-slate-100"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-400 mb-1">Año</label>
                  <input
                    type="number"
                    value={editForm.year}
                    onChange={(e) => setEditForm((f) => ({ ...f, year: e.target.value }))}
                    className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 font-mono text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">BPM</label>
                  <input
                    type="number"
                    value={editForm.bpm}
                    onChange={(e) => setEditForm((f) => ({ ...f, bpm: e.target.value }))}
                    className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 font-mono text-slate-100"
                  />
                </div>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={() => setEditingTrack(null)}
                className="rounded-lg border border-slate-700 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-slate-800 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="rounded-lg bg-cyan-500 px-4 py-2 text-xs font-semibold text-slate-950 hover:bg-cyan-400 cursor-pointer"
              >
                Guardar cambios
              </button>
            </div>
          </form>
        </div>
      )}

      <ConfirmDialog
        open={confirmState.open}
        title={confirmState.title}
        message={confirmState.message}
        onConfirm={confirmState.onConfirm}
        onCancel={() => setConfirmState((s) => ({ ...s, open: false }))}
      />
    </div>
  );
};
