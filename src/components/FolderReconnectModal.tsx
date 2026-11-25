import React, { useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  FolderSync,
  HardDrive,
  RefreshCw,
  ShieldAlert,
  X,
} from 'lucide-react';
import { db } from '../db/database';
import { useStudio } from '../context/StudioContext';
import {
  supportsFileSystemAccess,
  type FolderDiskVerification,
  type PreExportFileVerificationResult,
} from '../services/fileAccessService';
import { normalizeWindowsFolderPath } from '../services/radioboss';

interface FolderReconnectModalProps {
  open: boolean;
  playlistName: string;
  exportLabel: string;
  verification: PreExportFileVerificationResult | null;
  isVerifying: boolean;
  onReverify: () => Promise<void>;
  onProceedExport: () => Promise<void>;
  onClose: () => void;
}

export const FolderReconnectModal: React.FC<FolderReconnectModalProps> = ({
  open,
  playlistName,
  exportLabel,
  verification,
  isVerifying,
  onReverify,
  onProceedExport,
  onClose,
}) => {
  const { importFolderViaPicker, importFilesViaInput, refreshAll, showToast } = useStudio();
  const folderInputRef = useRef<HTMLInputElement>(null);
  const [targetReconnectFolder, setTargetReconnectFolder] = useState<FolderDiskVerification | null>(
    null
  );
  const [pathDrafts, setPathDrafts] = useState<Record<string, string>>({});
  const [reconnectingId, setReconnectingId] = useState<string | null>(null);

  if (!open || !verification) return null;

  const handleReconnectFolder = async (folder: FolderDiskVerification) => {
    setReconnectingId(folder.folderId);
    try {
      if (supportsFileSystemAccess()) {
        const res = await importFolderViaPicker(folder.role, folder.folderId, () => {
          setTargetReconnectFolder(folder);
          folderInputRef.current?.click();
        });
        if (res) {
          await onReverify();
        }
      } else {
        setTargetReconnectFolder(folder);
        folderInputRef.current?.click();
      }
    } finally {
      setReconnectingId(null);
    }
  };

  const handleSaveDiskPath = async (folder: FolderDiskVerification) => {
    const raw = pathDrafts[folder.folderId] ?? folder.windowsBasePath;
    const norm = normalizeWindowsFolderPath(raw);
    if (!norm) {
      showToast('warning', 'Ingresa una ruta válida en disco.');
      return;
    }
    await db.folders.update(folder.folderId, {
      windowsBasePath: norm,
      pathConfirmed: true,
    });
    await refreshAll();
    showToast('success', `Ruta en disco actualizada para "${folder.folderName}".`);
    await onReverify();
  };

  const statusMeta = (status: FolderDiskVerification['status']) => {
    switch (status) {
      case 'ok':
        return {
          label: 'Verificada en disco',
          badge: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300',
        };
      case 'missing-files':
        return {
          label: 'Archivos no encontrados',
          badge: 'border-rose-500/40 bg-rose-500/15 text-rose-300',
        };
      case 'folder-moved':
        return {
          label: 'Carpeta movida o inaccesible',
          badge: 'border-rose-500/40 bg-rose-500/15 text-rose-300',
        };
      case 'needs-permission':
        return {
          label: 'Permiso pendiente',
          badge: 'border-amber-500/40 bg-amber-500/15 text-amber-300',
        };
      case 'needs-reselect':
        return {
          label: 'Sesión recargada (reconectar)',
          badge: 'border-amber-500/40 bg-amber-500/15 text-amber-300',
        };
    }
  };

  const exportableCount = verification.totalItems - verification.missingCount;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4">
      <input
        ref={folderInputRef}
        type="file"
        multiple
        // @ts-expect-error webkitdirectory
        webkitdirectory=""
        className="hidden"
        onChange={async (e) => {
          const files = e.target.files;
          if (files?.length && targetReconnectFolder) {
            setReconnectingId(targetReconnectFolder.folderId);
            try {
              await importFilesViaInput(
                files,
                targetReconnectFolder.role,
                targetReconnectFolder.folderName,
                targetReconnectFolder.folderId
              );
              await onReverify();
            } finally {
              setReconnectingId(null);
              setTargetReconnectFolder(null);
            }
          }
          e.target.value = '';
        }}
      />

      <div className="w-full max-w-2xl rounded-2xl border border-slate-800 bg-[#101726] shadow-2xl overflow-hidden text-xs">
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            {verification.hasBlockingIssues ? (
              <ShieldAlert className="w-5 h-5 text-rose-400 shrink-0" />
            ) : verification.needsReconnect ? (
              <AlertTriangle className="w-5 h-5 text-amber-400 shrink-0" />
            ) : (
              <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0" />
            )}
            <div className="min-w-0">
              <h3 className="text-sm font-semibold text-slate-100 truncate">
                Verificación de archivos locales antes de exportar: {playlistName}
              </h3>
              <p className="text-[11px] text-slate-400">
                Comprobación directa contra tu sistema de archivos antes de generar el archivo para RadioBOSS.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4 max-h-[75vh] overflow-y-auto">
          {/* Summary Strip */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 font-mono">
            <div className="rounded-lg border border-slate-800 bg-[#090d16] p-2.5">
              <div className="text-slate-400 text-[11px]">En playlist</div>
              <div className="text-base font-bold text-slate-100">{verification.totalItems}</div>
            </div>
            <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-2.5">
              <div className="text-emerald-300/80 text-[11px]">Verificados</div>
              <div className="text-base font-bold text-emerald-300">
                {verification.verifiedCount}
              </div>
            </div>
            <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-2.5">
              <div className="text-rose-300/80 text-[11px]">Faltantes</div>
              <div className="text-base font-bold text-rose-300">{verification.missingCount}</div>
            </div>
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-2.5">
              <div className="text-amber-300/80 text-[11px]">Sin verificar</div>
              <div className="text-base font-bold text-amber-300">
                {verification.unverifiedCount}
              </div>
            </div>
          </div>

          {/* Per-folder reconnection list */}
          <div className="space-y-3">
            {verification.folders.map((folder) => {
              const meta = statusMeta(folder.status);
              const draftPath = pathDrafts[folder.folderId] ?? folder.windowsBasePath;
              const dirty =
                normalizeWindowsFolderPath(draftPath) !==
                normalizeWindowsFolderPath(folder.windowsBasePath);

              return (
                <div
                  key={folder.folderId}
                  className="rounded-xl border border-slate-800 bg-[#090d16] p-3.5 space-y-2.5"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <HardDrive className="w-4 h-4 text-cyan-400 shrink-0" />
                      <span className="font-semibold text-slate-100 truncate">
                        {folder.folderName}
                      </span>
                      <span
                        className={`rounded border px-2 py-0.5 text-[10px] font-mono ${meta.badge}`}
                      >
                        {meta.label}
                      </span>
                    </div>

                    <button
                      type="button"
                      disabled={reconnectingId === folder.folderId || isVerifying}
                      onClick={() => void handleReconnectFolder(folder)}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-500 px-3 py-1.5 text-[11px] font-semibold text-slate-950 hover:bg-cyan-400 disabled:opacity-50 cursor-pointer"
                    >
                      <FolderSync className="w-3.5 h-3.5" />
                      {reconnectingId === folder.folderId
                        ? 'Reconectando...'
                        : 'Reconectar carpeta en disco'}
                    </button>
                  </div>

                  <div className="flex flex-wrap items-center gap-3 font-mono text-[11px] text-slate-400">
                    <span>Pistas en lista: {folder.totalInPlaylist}</span>
                    <span className="text-emerald-300">Verificadas: {folder.verifiedCount}</span>
                    {folder.missingCount > 0 && (
                      <span className="text-rose-300">Faltantes: {folder.missingCount}</span>
                    )}
                    {folder.unverifiedCount > 0 && (
                      <span className="text-amber-300">
                        Sin sesión activa: {folder.unverifiedCount}
                      </span>
                    )}
                  </div>

                  {/* Update Windows/NAS path if drive or folder moved */}
                  <div className="flex flex-col sm:flex-row gap-2">
                    <input
                      type="text"
                      value={draftPath}
                      onChange={(e) =>
                        setPathDrafts((prev) => ({ ...prev, [folder.folderId]: e.target.value }))
                      }
                      placeholder="Ruta real en Windows (ej. E:\Musica\Carpeta)"
                      className="flex-1 rounded-lg border border-slate-800 bg-[#101726] px-3 py-1.5 font-mono text-[11px] text-slate-100"
                    />
                    <button
                      type="button"
                      disabled={!dirty}
                      onClick={() => void handleSaveDiskPath(folder)}
                      className="inline-flex items-center justify-center gap-1 rounded-lg border border-emerald-500/40 bg-emerald-500/15 px-3 py-1.5 text-[11px] font-semibold text-emerald-200 hover:bg-emerald-500/25 disabled:opacity-40 cursor-pointer"
                    >
                      <Check className="w-3.5 h-3.5" />
                      Guardar ruta
                    </button>
                  </div>

                  {folder.missingFiles.length > 0 && (
                    <div className="rounded-lg border border-rose-500/30 bg-rose-500/5 p-2.5 space-y-1">
                      <div className="text-[11px] font-semibold text-rose-300">
                        Archivos no encontrados en la ubicación guardada:
                      </div>
                      <div className="max-h-28 overflow-y-auto space-y-0.5 font-mono text-[11px] text-rose-200/90">
                        {folder.missingFiles.map((m) => (
                          <div key={m.trackId} className="truncate">
                            • {m.relativePath} ({m.artist} — {m.title})
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        <div className="px-5 py-3.5 border-t border-slate-800 bg-[#0c1220] flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            disabled={isVerifying}
            onClick={() => void onReverify()}
            className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 text-xs text-slate-200 hover:bg-slate-800 disabled:opacity-50 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 text-cyan-400 ${isVerifying ? 'animate-spin' : ''}`} />
            {isVerifying ? 'Verificando...' : 'Re-verificar disco'}
          </button>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-slate-700 px-3.5 py-2 text-xs text-slate-300 hover:bg-slate-800 cursor-pointer"
            >
              Cancelar
            </button>
            <button
              type="button"
              disabled={exportableCount <= 0 || isVerifying}
              onClick={() => void onProceedExport()}
              className={`rounded-lg px-4 py-2 text-xs font-semibold cursor-pointer disabled:opacity-40 ${
                verification.hasBlockingIssues
                  ? 'bg-amber-500 text-slate-950 hover:bg-amber-400'
                  : 'bg-cyan-500 text-slate-950 hover:bg-cyan-400'
              }`}
            >
              {verification.missingCount > 0
                ? `Exportar ${exportLabel} (${exportableCount} válidas)`
                : `Continuar y exportar ${exportLabel}`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
