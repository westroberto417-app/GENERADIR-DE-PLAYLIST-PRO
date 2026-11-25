import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ClipboardPaste,
  FolderOpen,
  HardDrive,
} from 'lucide-react';
import { db } from '../db/database';
import { useStudio } from '../context/StudioContext';
import {
  isFolderPathPendingConfirmation,
  normalizeWindowsFolderPath,
  resolveRadioBossPath,
} from '../services/radioboss';
import type { LinkedFolder, TrackRecord } from '../types/studio';

interface FolderDiskPathEditorProps {
  folders: LinkedFolder[];
  sampleTracksByFolder?: Map<string, TrackRecord>;
  compact?: boolean;
  defaultExpanded?: boolean;
  title?: string;
  onUseRelativePaths?: () => void;
}

export const FolderDiskPathEditor: React.FC<FolderDiskPathEditorProps> = ({
  folders,
  sampleTracksByFolder,
  compact = false,
  defaultExpanded,
  title = 'Rutas reales de carpetas en disco (Windows / NAS)',
  onUseRelativePaths,
}) => {
  const { tracks, settings, refreshAll, showToast } = useStudio();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);

  const pendingFolders = folders.filter((f) => isFolderPathPendingConfirmation(f));
  const [expanded, setExpanded] = useState<boolean>(
    defaultExpanded ?? pendingFolders.length > 0
  );

  useEffect(() => {
    const map: Record<string, string> = {};
    for (const f of folders) {
      map[f.id] = f.windowsBasePath;
    }
    setDrafts(map);
  }, [folders]);

  useEffect(() => {
    if (pendingFolders.length > 0 && defaultExpanded === undefined) {
      setExpanded(true);
    }
  }, [pendingFolders.length, defaultExpanded]);

  if (folders.length === 0) return null;

  const getSampleTrack = (folder: LinkedFolder): TrackRecord | undefined => {
    if (sampleTracksByFolder?.has(folder.id)) {
      return sampleTracksByFolder.get(folder.id);
    }
    return tracks.find((t) => t.folderId === folder.id);
  };

  const handleSaveFolderPath = async (folder: LinkedFolder, rawValue?: string) => {
    const valueToSave = rawValue !== undefined ? rawValue : drafts[folder.id] ?? folder.windowsBasePath;
    const normalized = normalizeWindowsFolderPath(valueToSave);
    if (!normalized) {
      showToast('warning', `Ingresa una ruta válida en disco para "${folder.name}".`);
      return;
    }
    setSavingId(folder.id);
    try {
      await db.folders.update(folder.id, {
        windowsBasePath: normalized,
        pathConfirmed: true,
      });
      setDrafts((prev) => ({ ...prev, [folder.id]: normalized }));
      await refreshAll();
      showToast('success', `Ruta en disco guardada para "${folder.name}": ${normalized}`);
    } finally {
      setSavingId(null);
    }
  };

  const handlePasteFromClipboard = async (folder: LinkedFolder) => {
    try {
      if (!navigator.clipboard?.readText) {
        showToast('info', 'Pega la ruta manualmente con Ctrl+V dentro del campo.');
        return;
      }
      const clip = (await navigator.clipboard.readText()).trim();
      if (!clip) {
        showToast('warning', 'El portapapeles está vacío.');
        return;
      }
      const normalized = normalizeWindowsFolderPath(clip);
      setDrafts((prev) => ({ ...prev, [folder.id]: normalized }));
      if (normalized) {
        await handleSaveFolderPath(folder, normalized);
      }
    } catch {
      showToast('info', 'Permiso de portapapeles no disponible: pega la ruta con Ctrl+V en el campo.');
    }
  };

  const allConfirmed = pendingFolders.length === 0;

  return (
    <div
      className={`rounded-xl border p-3.5 space-y-3 text-xs ${
        allConfirmed
          ? 'border-slate-800/80 bg-[#0d1422]'
          : 'border-amber-500/40 bg-amber-500/5'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {allConfirmed ? (
            <HardDrive className="w-4 h-4 text-emerald-400 shrink-0" />
          ) : (
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
          )}
          <div className="min-w-0">
            <div className="font-semibold text-slate-100 flex flex-wrap items-center gap-2">
              <span>{title}</span>
              {allConfirmed ? (
                <span className="font-mono text-[10px] text-emerald-300">
                  {folders.length} configurada{folders.length === 1 ? '' : 's'}
                </span>
              ) : (
                <span className="font-mono text-[10px] text-amber-300">
                  {pendingFolders.length} pendiente{pendingFolders.length === 1 ? '' : 's'} de confirmar
                </span>
              )}
            </div>
            {!allConfirmed && (
              <p className="text-[11px] text-amber-200/90 mt-0.5">
                Por seguridad, el navegador oculta la unidad real (ej. <span className="font-mono">C:\</span> o{' '}
                <span className="font-mono">E:\</span>). Copia la ruta de tu carpeta en el Explorador de Windows (
                <span className="font-mono">Ctrl+Shift+C</span>) y pégala aquí para que el{' '}
                <span className="font-mono">.m3u8</span> encuentre todas las canciones.
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {onUseRelativePaths && !allConfirmed && (
            <button
              type="button"
              onClick={onUseRelativePaths}
              className="rounded-lg border border-cyan-500/40 bg-cyan-500/15 px-2.5 py-1 text-[11px] font-medium text-cyan-200 hover:bg-cyan-500/25 cursor-pointer"
            >
              Usar rutas relativas
            </button>
          )}
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1 text-[11px] text-slate-200 hover:bg-slate-800 cursor-pointer"
          >
            {expanded ? 'Ocultar rutas' : `Editar rutas (${folders.length})`}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="space-y-2.5 pt-2 border-t border-slate-800/70">
          {folders.map((folder) => {
            const draft = drafts[folder.id] ?? folder.windowsBasePath;
            const normalizedDraft = normalizeWindowsFolderPath(draft);
            const dirty = normalizedDraft !== normalizeWindowsFolderPath(folder.windowsBasePath);
            const isPending = isFolderPathPendingConfirmation(folder);
            const sample = getSampleTrack(folder);
            const foldersMap = new Map<string, LinkedFolder>([
              [
                folder.id,
                {
                  ...folder,
                  windowsBasePath: normalizedDraft || folder.windowsBasePath,
                },
              ],
            ]);
            const previewResolved = sample
              ? resolveRadioBossPath(
                  {
                    folderId: folder.id,
                    relativePath: sample.relativePath,
                    fileName: sample.fileName,
                  },
                  'multi-drive',
                  foldersMap,
                  settings
                )
              : normalizedDraft
              ? `${normalizedDraft.replace(/\\+$/, '')}\\Ejemplo.mp3`
              : '';

            return (
              <div
                key={folder.id}
                className="rounded-lg border border-slate-800 bg-[#090d16] p-3 space-y-2"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <FolderOpen className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                    <span className="font-semibold text-slate-100 truncate">{folder.name}</span>
                    <span
                      className={`rounded px-1.5 py-0.5 text-[10px] font-mono ${
                        folder.role === 'spots'
                          ? 'bg-amber-500/15 text-amber-300'
                          : 'bg-cyan-500/15 text-cyan-300'
                      }`}
                    >
                      {folder.role === 'spots' ? 'SPOTS' : 'MÚSICA'}
                    </span>
                    <span className="font-mono text-[11px] text-slate-500">
                      {folder.trackCount} pistas
                    </span>
                  </div>

                  {isPending ? (
                    <span className="text-[11px] font-mono text-amber-300">
                      Ruta genérica del navegador
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[11px] font-mono text-emerald-300">
                      <CheckCircle2 className="w-3 h-3" />
                      Confirmada
                    </span>
                  )}
                </div>

                <div className={`flex ${compact ? 'flex-col sm:flex-row' : 'flex-col md:flex-row'} gap-2`}>
                  <input
                    type="text"
                    value={draft}
                    onChange={(e) =>
                      setDrafts((prev) => ({ ...prev, [folder.id]: e.target.value }))
                    }
                    onBlur={() => {
                      const norm = normalizeWindowsFolderPath(draft);
                      if (norm && norm !== draft) {
                        setDrafts((prev) => ({ ...prev, [folder.id]: norm }));
                      }
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        void handleSaveFolderPath(folder);
                      }
                    }}
                    placeholder={`Ej. C:\\Users\\TuUsuario\\Music\\${folder.name} o E:\\${folder.name}`}
                    className="flex-1 rounded-lg border border-slate-700 bg-[#101726] px-3 py-1.5 font-mono text-xs text-slate-100 focus:outline-none focus:border-cyan-500"
                  />
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={() => void handlePasteFromClipboard(folder)}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-[11px] text-slate-200 hover:bg-slate-800 cursor-pointer"
                      title="Pegar ruta copiada desde el Explorador de Windows"
                    >
                      <ClipboardPaste className="w-3.5 h-3.5 text-cyan-400" />
                      Pegar ruta
                    </button>
                    <button
                      type="button"
                      disabled={savingId === folder.id || (!dirty && !isPending)}
                      onClick={() => void handleSaveFolderPath(folder)}
                      className="inline-flex items-center gap-1 rounded-lg bg-emerald-500 px-3 py-1.5 text-[11px] font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-45 cursor-pointer"
                    >
                      <Check className="w-3.5 h-3.5" />
                      {dirty || isPending ? 'Confirmar ruta' : 'Guardada'}
                    </button>
                  </div>
                </div>

                {previewResolved && (
                  <p className="text-[11px] font-mono text-slate-400 truncate">
                    Ruta generada en playlist:{' '}
                    <span className={isPending && !dirty ? 'text-amber-300' : 'text-cyan-300'}>
                      {previewResolved}
                    </span>
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
