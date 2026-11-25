import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  Cpu,
  Download,
  Edit3,
  FolderCheck,
  FolderOpen,
  HardDrive,
  Info,
  Palette,
  Play,
  Plus,
  Radio,
  RefreshCw,
  ShieldCheck,
  Trash2,
  Wand2,
  X,
} from 'lucide-react';
import { addActivityLog, db } from '../db/database';
import { useStudio } from '../context/StudioContext';
import { desktopBridge } from '../services/desktopBridge';
import { isCrossOriginSubframe } from '../services/fileAccessService';
import { extractLibraryFacets } from '../services/libraryFacetsAndTemplates';
import { downloadTextFile } from '../services/radioboss';
import {
  buildDesktopBridgePyScript,
  buildStartBridgeBat,
  buildStartupInstallerBat,
} from '../services/windowsBridgeKit';
import {
  SCHEDULER_GLOBAL_OUTPUT_HANDLE_ID,
  computeNextOccurrences,
  executeScheduledTask,
  flushPendingDiskWrites,
  getSchedulerDirectoryStatus,
  getTaskOutputHandleId,
  getTaskScheduledTimes,
  pickSchedulerOutputDirectory,
  requestSchedulerDirectoryPermission,
  resolveScheduledOutputFilename,
  type SchedulerDirectoryStatus,
} from '../services/schedulerService';
import {
  INTENSITY_LEVELS,
  MOOD_OPTIONS,
  type GenerationMode,
  type IntensityLevel,
  type PathExportMode,
  type ScheduledTask,
  type SpotRotationMode,
} from '../types/studio';
import { formatDateTime } from '../utils/formatters';
import {
  GENRE_COLOR_PALETTE,
  getGenreColorTheme,
  loadCustomGenreColors,
  normalizeGenreKey,
  resolveTaskVisualGenre,
  saveCustomGenreColors,
} from '../utils/genreColors';
import { ConfirmDialog } from './ConfirmDialog';

const DAYS_ES = [
  { id: 1, short: 'Lun' },
  { id: 2, short: 'Mar' },
  { id: 3, short: 'Mié' },
  { id: 4, short: 'Jue' },
  { id: 5, short: 'Vie' },
  { id: 6, short: 'Sáb' },
  { id: 0, short: 'Dom' },
];

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

export const SchedulerModule: React.FC = () => {
  const {
    tracks,
    schedules,
    settings,
    folders,
    activityLogs,
    generatorConfig,
    schedulerGlobalDirStatus,
    nextScheduledOccurrence,
    runSchedulerCheckNow,
    refreshAll,
    updateSettings,
    showToast,
    bridgeStatus,
    syncingBridge,
    syncDesktopBridgeNow,
  } = useStudio();

  const musicTracks = useMemo(() => tracks.filter((t) => !t.isSpotFolder), [tracks]);
  const musicFolders = useMemo(() => folders.filter((f) => f.role === 'music'), [folders]);
  const spotFolders = useMemo(() => folders.filter((f) => f.role === 'spots'), [folders]);
  const libraryFacets = useMemo(() => extractLibraryFacets(musicTracks), [musicTracks]);

  const [globalDirStatus, setGlobalDirStatus] = useState<SchedulerDirectoryStatus>(
    schedulerGlobalDirStatus
  );
  const [customDirStatus, setCustomDirStatus] = useState<SchedulerDirectoryStatus | null>(null);
  const [windowsPathDraft, setWindowsPathDraft] = useState(
    settings.schedulerOutputWindowsPath || ''
  );

  const [editingTask, setEditingTask] = useState<ScheduledTask | null>(null);
  const [draftTaskId, setDraftTaskId] = useState<string>('');
  const [showModal, setShowModal] = useState(false);
  const [confirmDeleteTask, setConfirmDeleteTask] = useState<ScheduledTask | null>(null);
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null);
  const [extraTimeDraft, setExtraTimeDraft] = useState('14:00');
  const [nowTickMs, setNowTickMs] = useState(() => Date.now());
  const inSubframe = useMemo(() => isCrossOriginSubframe(), []);

  const [isVisualCollapsed, setIsVisualCollapsed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    try {
      return window.localStorage.getItem('smartplay_visual_program_collapsed') === 'true';
    } catch {
      return false;
    }
  });
  const [customGenreColors, setCustomGenreColors] = useState<Record<string, string>>(() =>
    loadCustomGenreColors()
  );
  const [highlightedGenreKey, setHighlightedGenreKey] = useState<string | null>(null);
  const [editingColorGenreKey, setEditingColorGenreKey] = useState<string | null>(null);

  const toggleVisualCollapsed = () => {
    setIsVisualCollapsed((prev) => {
      const next = !prev;
      try {
        window.localStorage.setItem('smartplay_visual_program_collapsed', String(next));
      } catch {
        // ignore storage errors
      }
      return next;
    });
  };

  const assignGenreColor = (genreKey: string, colorId: string) => {
    setCustomGenreColors((prev) => {
      const next = { ...prev, [genreKey]: colorId };
      saveCustomGenreColors(next);
      return next;
    });
    setEditingColorGenreKey(null);
  };

  useEffect(() => {
    const id = window.setInterval(() => setNowTickMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    setGlobalDirStatus(schedulerGlobalDirStatus);
  }, [schedulerGlobalDirStatus]);

  const refreshDirectoryStatuses = useCallback(async () => {
    const gStatus = await getSchedulerDirectoryStatus(SCHEDULER_GLOBAL_OUTPUT_HANDLE_ID);
    setGlobalDirStatus(gStatus);
    if (showModal && draftTaskId) {
      const cStatus = await getSchedulerDirectoryStatus(getTaskOutputHandleId(draftTaskId));
      setCustomDirStatus(cStatus);
    }
  }, [draftTaskId, showModal]);

  useEffect(() => {
    setWindowsPathDraft(settings.schedulerOutputWindowsPath || '');
  }, [settings.schedulerOutputWindowsPath]);

  useEffect(() => {
    void refreshDirectoryStatuses();
  }, [refreshDirectoryStatuses, schedules]);

  const buildDefaultForm = (): Omit<ScheduledTask, 'id' | 'lastRunAt'> => ({
    name: 'Bloque Programado',
    enabled: true,
    frequency: 'daily',
    time: '09:00',
    extraTimes: [],
    daysOfWeek: [1, 2, 3, 4, 5],
    sourceScope: 'all',
    sourceFolderId: musicFolders[0]?.id || '',
    mode: 'Combinado',
    noRepeatTracks: true,
    noRepeatArtists: true,
    respectAntiRepeat: true,
    antiRepeatHours: settings.antiRepeatHours,
    fallbackToOldestOnExhaust: true,
    artistSeparation: settings.artistSeparation,
    allowedGenres: [],
    excludedGenres: [],
    decades: [],
    mood: '',
    bpmMin: null,
    bpmMax: null,
    intensities: [],
    spots: {
      enabled: false,
      spotFolderId: spotFolders[0]?.id || '',
      everyNSongs: 3,
      rotationMode: 'random-no-repeat',
      insertIntroAtStart: true,
    },
    targetType: 'duration',
    targetDurationMin: 60,
    targetCount: 18,
    format: settings.defaultFormat,
    pathMode: settings.defaultPathMode,
    outputFileName: 'Bloque_Programado',
    overwriteExisting: true,
    outputFolderMode: 'global',
    namePattern: '{NAME}',
    outputFolderName:
      globalDirStatus.folderName ||
      settings.schedulerOutputFolderName ||
      settings.defaultExportSubfolder ||
      'Playlists',
  });

  const [form, setForm] = useState<Omit<ScheduledTask, 'id' | 'lastRunAt'>>(buildDefaultForm);

  const openCreate = () => {
    const newId = `sch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    setEditingTask(null);
    setDraftTaskId(newId);
    setForm(buildDefaultForm());
    setCustomDirStatus(null);
    setShowModal(true);
  };

  const openEdit = async (t: ScheduledTask) => {
    setEditingTask(t);
    setDraftTaskId(t.id);
    setForm({
      name: t.name,
      enabled: t.enabled,
      frequency: t.frequency,
      time: t.time,
      extraTimes: [...(t.extraTimes || [])],
      daysOfWeek: [...t.daysOfWeek],
      sourceScope: t.sourceScope || 'all',
      sourceFolderId: t.sourceFolderId || musicFolders[0]?.id || '',
      mode: t.mode || 'Combinado',
      noRepeatTracks: t.noRepeatTracks !== false,
      noRepeatArtists: t.noRepeatArtists !== false,
      respectAntiRepeat: t.respectAntiRepeat ?? true,
      antiRepeatHours:
        typeof t.antiRepeatHours === 'number' ? t.antiRepeatHours : settings.antiRepeatHours,
      fallbackToOldestOnExhaust: t.fallbackToOldestOnExhaust !== false,
      artistSeparation:
        typeof t.artistSeparation === 'number' ? t.artistSeparation : settings.artistSeparation,
      allowedGenres: [...t.allowedGenres],
      excludedGenres: [...t.excludedGenres],
      decades: [...(t.decades || [])],
      mood: t.mood,
      bpmMin: t.bpmMin,
      bpmMax: t.bpmMax,
      intensities: [...t.intensities],
      spots: t.spots
        ? { ...t.spots }
        : {
            enabled: false,
            spotFolderId: spotFolders[0]?.id || '',
            everyNSongs: 3,
            rotationMode: 'random-no-repeat',
            insertIntroAtStart: true,
          },
      targetType: t.targetType,
      targetDurationMin: t.targetDurationMin,
      targetCount: t.targetCount,
      format: t.format,
      pathMode: t.pathMode,
      outputFileName: t.outputFileName ?? t.name.replace(/\s+/g, '_'),
      overwriteExisting: t.overwriteExisting !== false,
      outputFolderMode: t.outputFolderMode || 'global',
      namePattern: t.namePattern,
      outputFolderName:
        t.outputFolderName || globalDirStatus.folderName || settings.schedulerOutputFolderName || 'Playlists',
    });
    const cStatus = await getSchedulerDirectoryStatus(getTaskOutputHandleId(t.id));
    setCustomDirStatus(cStatus);
    setShowModal(true);
  };

  const handleImportFromGenerator = () => {
    setForm((f) => ({
      ...f,
      sourceScope: generatorConfig.sourceScope || 'all',
      sourceFolderId: generatorConfig.sourceFolderId || f.sourceFolderId,
      mode: generatorConfig.mode,
      noRepeatTracks: generatorConfig.noRepeatTracks !== false,
      noRepeatArtists: Boolean(generatorConfig.noRepeatArtists),
      respectAntiRepeat: generatorConfig.respectAntiRepeat,
      antiRepeatHours: generatorConfig.antiRepeatHours,
      artistSeparation: generatorConfig.artistSeparation,
      allowedGenres: [...generatorConfig.allowedGenres],
      excludedGenres: [...generatorConfig.excludedGenres],
      decades: [...generatorConfig.decades],
      mood: generatorConfig.moods[0] || '',
      bpmMin: generatorConfig.bpmMin,
      bpmMax: generatorConfig.bpmMax,
      intensities: [...generatorConfig.intensities],
      spots: { ...generatorConfig.spots },
      targetType: generatorConfig.targetType,
      targetDurationMin: generatorConfig.targetDurationMin,
      targetCount: generatorConfig.targetCount,
    }));
    showToast('info', 'Reglas del Generador Inteligente importadas a esta programación.');
  };

  const handlePickGlobalFolder = async () => {
    const res = await pickSchedulerOutputDirectory(SCHEDULER_GLOBAL_OUTPUT_HANDLE_ID);
    let flushed = 0;
    if (res.ok) {
      flushed = await flushPendingDiskWrites();
      await runSchedulerCheckNow();
    }
    await refreshDirectoryStatuses();
    await refreshAll();
    if (res.ok) {
      showToast(
        'success',
        flushed > 0
          ? `Carpeta "${res.folderName}" vinculada y ${flushed} playlist(s) pendiente(s) guardada(s) en disco.`
          : `Carpeta de destino vinculada: "${res.folderName}" (escritura directa).`
      );
    } else if (res.error) {
      showToast('warning', res.error);
    }
  };

  const handleAuthorizeGlobalWrite = async () => {
    const perm = await requestSchedulerDirectoryPermission(SCHEDULER_GLOBAL_OUTPUT_HANDLE_ID);
    let flushed = 0;
    if (perm === 'granted') {
      flushed = await flushPendingDiskWrites();
      await runSchedulerCheckNow();
    }
    await refreshDirectoryStatuses();
    await refreshAll();
    if (perm === 'granted') {
      showToast(
        'success',
        flushed > 0
          ? `Permiso autorizado y ${flushed} playlist(s) pendiente(s) guardada(s) en disco.`
          : 'Permiso de escritura y sobrescritura autorizado.'
      );
    } else {
      showToast('warning', 'El navegador no otorgó permiso de escritura en la carpeta.');
    }
  };

  const handlePickCustomTaskFolder = async () => {
    const targetId = draftTaskId || editingTask?.id;
    if (!targetId) return;
    const res = await pickSchedulerOutputDirectory(getTaskOutputHandleId(targetId));
    const cStatus = await getSchedulerDirectoryStatus(getTaskOutputHandleId(targetId));
    setCustomDirStatus(cStatus);
    if (res.ok) {
      setForm((f) => ({
        ...f,
        outputFolderMode: 'custom',
        outputFolderName: res.folderName,
      }));
      showToast('success', `Carpeta exclusiva vinculada para esta tarea: "${res.folderName}".`);
    } else if (res.error) {
      showToast('warning', res.error);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (form.frequency === 'weekly' && form.daysOfWeek.length === 0) {
      showToast('warning', 'Selecciona al menos un día de la semana para la programación semanal.');
      return;
    }

    const id = editingTask?.id || draftTaskId || `sch_${Date.now()}`;
    const resolvedFolderName =
      form.outputFolderMode === 'custom'
        ? customDirStatus?.folderName || form.outputFolderName
        : globalDirStatus.folderName || settings.schedulerOutputFolderName || form.outputFolderName;

    const cleanName = form.name.trim() || 'Programación sin nombre';
    const cleanOutName = (form.outputFileName || '').trim() || cleanName.replace(/\s+/g, '_');
    const now = Date.now();

    const timingChanged =
      !editingTask ||
      editingTask.time !== form.time ||
      editingTask.frequency !== form.frequency ||
      JSON.stringify(editingTask.extraTimes || []) !== JSON.stringify(form.extraTimes || []) ||
      JSON.stringify(editingTask.daysOfWeek || []) !== JSON.stringify(form.daysOfWeek || []) ||
      (!editingTask.enabled && form.enabled);

    const task: ScheduledTask = {
      id,
      lastRunAt: editingTask?.lastRunAt ?? null,
      armedAt: now,
      updatedAt: now,
      lastSlotKey: timingChanged ? undefined : editingTask?.lastSlotKey,
      executedSlotKeys: timingChanged ? [] : editingTask?.executedSlotKeys || [],
      lastStatus: editingTask?.lastStatus,
      lastMessage: editingTask?.lastMessage,
      lastDiskWriteStatus: editingTask?.lastDiskWriteStatus,
      lastDiskWritePath: editingTask?.lastDiskWritePath,
      lastDiskWriteAt: editingTask?.lastDiskWriteAt ?? null,
      ...form,
      name: cleanName,
      outputFileName: cleanOutName,
      outputFolderName: resolvedFolderName || 'Playlists',
    };
    await db.schedules.put(task);
    await addActivityLog(
      'scheduler',
      'info',
      editingTask ? `Tarea editada: ${task.name}` : `Nueva tarea: ${task.name}`,
      `${getTaskScheduledTimes(task).join(', ')} · Archivo: ${resolveScheduledOutputFilename(task)}`
    );
    setShowModal(false);
    await refreshAll();
    const checkSummary = await runSchedulerCheckNow();
    if (checkSummary.ran === 0) {
      showToast('success', 'Programación guardada y armada en el reloj automático.');
    }
  };

  const handleToggle = async (t: ScheduledTask) => {
    const nextEnabled = !t.enabled;
    await db.schedules.update(t.id, {
      enabled: nextEnabled,
      armedAt: nextEnabled ? Date.now() : t.armedAt,
      updatedAt: Date.now(),
    });
    await refreshAll();
    if (nextEnabled) {
      await runSchedulerCheckNow();
    }
  };

  const handleRunNow = async (t: ScheduledTask) => {
    setRunningTaskId(t.id);
    try {
      const res = await executeScheduledTask(t, { allowPermissionPrompt: true });
      await refreshAll();
      await refreshDirectoryStatuses();
      showToast(res.status, res.message);
    } finally {
      setRunningTaskId(null);
    }
  };

  const handleExportAPScheduler = async () => {
    const payload = desktopBridge.buildAPSchedulerConfig(schedules, settings, folders);
    const ok = await downloadTextFile(
      'apscheduler_windows_x64_config.json',
      JSON.stringify(payload, null, 2),
      'application/json;charset=utf-8'
    );
    if (ok) {
      await addActivityLog(
        'scheduler',
        'success',
        'Exportación APScheduler JSON',
        `${schedules.length} tareas exportadas para servicio Windows x64.`
      );
      await refreshAll();
      showToast('success', 'Configuración APScheduler JSON exportada.');
    }
  };

  const addExtraTime = () => {
    if (!/^\d{2}:\d{2}$/.test(extraTimeDraft)) return;
    if (extraTimeDraft === form.time || (form.extraTimes || []).includes(extraTimeDraft)) {
      return;
    }
    setForm((f) => ({
      ...f,
      extraTimes: [...(f.extraTimes || []), extraTimeDraft].sort(),
    }));
  };

  const upcomingList = useMemo(() => computeNextOccurrences(schedules, 10), [schedules]);
  const schedulerLogs = useMemo(
    () => activityLogs.filter((l) => l.category === 'scheduler').slice(0, 12),
    [activityLogs]
  );

  const previewFilename = useMemo(
    () =>
      resolveScheduledOutputFilename({
        name: form.name,
        namePattern: form.namePattern,
        outputFileName: form.outputFileName,
        format: form.format,
        overwriteExisting: form.overwriteExisting,
      }),
    [form.name, form.namePattern, form.outputFileName, form.format, form.overwriteExisting]
  );

  return (
    <div className="space-y-4">
      {/* Header + Destination Disk Folder Configuration */}
      <div className="rounded-xl border border-slate-800/80 bg-[#101726] p-5 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              Programador Automático y Guardado en Disco
            </h2>
            <p className="text-xs text-slate-400 mt-1">
              Programa horarios con reglas inteligentes (carpeta o biblioteca, géneros, BPM, no repetir temas/cantantes y rotación de spots) para generar y sobrescribir automáticamente cada playlist en la carpeta elegida.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={openCreate}
              className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-500 px-3.5 py-2 text-xs font-semibold text-slate-950 hover:bg-cyan-400 cursor-pointer"
            >
              <Plus className="w-4 h-4" />
              Nueva programación
            </button>
            <button
              type="button"
              onClick={handleExportAPScheduler}
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/80 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 cursor-pointer"
            >
              <Download className="w-4 h-4 text-blue-400" />
              Exportar JSON APScheduler (Windows x64)
            </button>
          </div>
        </div>

        {/* Dedicated Disk Output Folder Picker in Programación */}
        <div className="rounded-xl border border-cyan-500/30 bg-[#090d16] p-4 space-y-3 text-xs">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <HardDrive className="w-4 h-4 text-cyan-400" />
                <span className="font-semibold text-slate-100">
                  Carpeta del disco donde se guardan y sobrescriben los playlists programados
                </span>
                {globalDirStatus.permission === 'granted' ? (
                  <span className="inline-flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-mono text-emerald-300">
                    <CheckCircle2 className="w-3 h-3" />
                    Escritura autorizada: {globalDirStatus.folderName}
                  </span>
                ) : globalDirStatus.hasHandle ? (
                  <span className="inline-flex items-center gap-1 rounded border border-amber-500/40 bg-amber-500/15 px-2 py-0.5 text-[10px] font-mono text-amber-300">
                    <AlertTriangle className="w-3 h-3" />
                    Permiso pendiente ({globalDirStatus.folderName})
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded border border-rose-500/40 bg-rose-500/15 px-2 py-0.5 text-[10px] font-mono text-rose-300">
                    Sin carpeta vinculada en disco
                  </span>
                )}
              </div>
              <p className="text-[11px] text-slate-400">
                Selecciona una carpeta real en tu PC (ej. <span className="font-mono text-slate-300">D:\RadioBOSS\Playlists</span>). En cada ejecución programada, la app escribirá y sobrescribirá automáticamente el archivo configurado allí.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {globalDirStatus.hasHandle && globalDirStatus.permission !== 'granted' && (
                <button
                  type="button"
                  onClick={handleAuthorizeGlobalWrite}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/20 px-3 py-2 font-semibold text-amber-200 hover:bg-amber-500/30 cursor-pointer"
                >
                  <ShieldCheck className="w-4 h-4" />
                  Autorizar escritura
                </button>
              )}
              <button
                type="button"
                onClick={handlePickGlobalFolder}
                className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-500 px-3.5 py-2 font-semibold text-slate-950 hover:bg-cyan-400 cursor-pointer"
              >
                <FolderOpen className="w-4 h-4" />
                {globalDirStatus.hasHandle ? 'Cambiar carpeta en disco' : 'Elegir carpeta en disco'}
              </button>
            </div>
          </div>

          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2 pt-1 border-t border-slate-800/70">
            <span className="text-[11px] text-slate-400 shrink-0">
              Ruta referencia Windows (opcional / APScheduler):
            </span>
            <input
              type="text"
              value={windowsPathDraft}
              onChange={(e) => setWindowsPathDraft(e.target.value)}
              placeholder="Ej. D:\RadioBOSS\Playlists"
              className="flex-1 rounded-lg border border-slate-800 bg-[#101726] px-3 py-1.5 font-mono text-[11px] text-slate-100"
            />
            <button
              type="button"
              onClick={() => updateSettings({ schedulerOutputWindowsPath: windowsPathDraft.trim() })}
              className="rounded-lg border border-slate-700 bg-slate-800 px-3 py-1.5 text-[11px] font-medium text-slate-200 hover:bg-slate-700 cursor-pointer"
            >
              Guardar ruta referencia
            </button>
          </div>
        </div>

        {/* Real-time Active Scheduler Status Bar */}
        <div className="rounded-xl border border-emerald-500/30 bg-emerald-500/10 p-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 text-xs">
          <div className="flex flex-wrap items-center gap-2 text-emerald-100">
            <span className="inline-block w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="font-semibold">
              Motor automático ACTIVO ({schedules.filter((s) => s.enabled).length} tarea(s) activas)
            </span>
            {nextScheduledOccurrence ? (
              <span className="font-mono text-[11px] text-emerald-200">
                · Próxima: {nextScheduledOccurrence.timeStr} ({nextScheduledOccurrence.task.name}) en{' '}
                {(() => {
                  const diffSec = Math.max(
                    0,
                    Math.floor((nextScheduledOccurrence.nextDate.getTime() - nowTickMs) / 1000)
                  );
                  const hrs = Math.floor(diffSec / 3600);
                  const mins = Math.floor((diffSec % 3600) / 60);
                  const secs = diffSec % 60;
                  return hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m ${secs}s`;
                })()}
              </span>
            ) : (
              <span className="text-slate-300">· Crea o activa una programación para iniciar</span>
            )}
          </div>
          <span className="font-mono text-[11px] text-emerald-200/90">
            Reloj Web Worker cada 5s · Recuperación automática activa
          </span>
        </div>

        {inSubframe && (
          <div className="rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 flex items-start gap-2.5 text-xs text-amber-200">
            <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
            <span>
              Estás viendo la app dentro de una vista previa embebida. Chrome y Edge bloquean aquí el selector de carpetas en disco: las listas programadas se generarán automáticamente dentro de <strong>Playlists & RadioBOSS</strong>, y para guardarlas/sobrescribirlas directo en tu disco duro debes abrir el enlace directo o la app instalada (PWA).
            </span>
          </div>
        )}

        <div className="rounded-lg border border-blue-500/30 bg-blue-500/10 p-3 flex items-start gap-2.5 text-xs text-blue-200">
          <Info className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
          <span>
            Con la pestaña o app instalada abierta (incluso en segundo plano o minimizada), el motor verifica automáticamente por Web Worker, temporizador exacto y recuperación de horarios para generar y sobrescribir en la carpeta vinculada (tras reiniciar el navegador, pulsa <strong>Autorizar escritura</strong> una vez al abrir). Para 24/7 sin navegador abierto o tras un corte de luz, usa el <strong>Puente Windows 24/7 (Python + APScheduler)</strong> abajo.
          </span>
        </div>

        {/* Windows 24/7 Offline DesktopBridge Kit & Live Sync */}
        <div className="rounded-xl border border-violet-500/30 bg-[#090d16] p-4 space-y-3 text-xs">
          <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <Cpu className="w-4 h-4 text-violet-400" />
                <span className="font-semibold text-slate-100">
                  Puente Windows 24/7 (Python + APScheduler · Sin navegador abierto)
                </span>
                {bridgeStatus?.connected ? (
                  <span className="inline-flex items-center gap-1 rounded border border-emerald-500/40 bg-emerald-500/15 px-2 py-0.5 text-[10px] font-mono text-emerald-300">
                    <CheckCircle2 className="w-3 h-3" />
                    ACTIVO ({bridgeStatus.scheduledTriggersCount ?? 0} disparos · {bridgeStatus.syncedTracksCount ?? 0} pistas)
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1 rounded border border-slate-700 bg-slate-800/80 px-2 py-0.5 text-[10px] font-mono text-slate-300">
                    En espera (no detectado en 127.0.0.1:8765)
                  </span>
                )}
              </div>
              <p className="text-[11px] text-slate-400">
                Si hay corte de internet o se apaga y reinicia el PC, este servicio en Windows arranca solo, recupera horarios perdidos hasta 6h atrás y sobrescribe los archivos en tu ruta Windows sin abrir Chrome/Edge.
              </p>
            </div>

            <button
              type="button"
              disabled={syncingBridge}
              onClick={() => void syncDesktopBridgeNow(false)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-violet-500 px-3.5 py-2 text-xs font-semibold text-white hover:bg-violet-400 disabled:opacity-50 shrink-0 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${syncingBridge ? 'animate-spin' : ''}`} />
              {syncingBridge ? 'Sincronizando...' : 'Sincronizar con Puente Windows'}
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-slate-800/80">
            <button
              type="button"
              onClick={() =>
                void downloadTextFile('desktop_bridge.py', buildDesktopBridgePyScript(), 'text/x-python;charset=utf-8')
              }
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-[#101726] px-3 py-1.5 text-[11px] font-medium text-cyan-200 hover:bg-slate-800 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5 text-cyan-400" />
              1. Descargar desktop_bridge.py
            </button>
            <button
              type="button"
              onClick={() =>
                void downloadTextFile('Iniciar_DesktopBridge.bat', buildStartBridgeBat(), 'text/plain;charset=utf-8')
              }
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-[#101726] px-3 py-1.5 text-[11px] font-medium text-emerald-200 hover:bg-slate-800 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5 text-emerald-400" />
              2. Descargar Iniciar_DesktopBridge.bat
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
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-[#101726] px-3 py-1.5 text-[11px] font-medium text-amber-200 hover:bg-slate-800 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5 text-amber-400" />
              3. Auto-iniciar al encender PC (.bat)
            </button>
          </div>

          <p className="text-[11px] text-slate-400">
            <strong>Cómo activarlo (sin programar):</strong> Guarda esos archivos en una carpeta (ej. <span className="font-mono text-slate-300">C:\SmartPlaylistBridge</span>), haz doble clic en <span className="font-mono text-emerald-300">Iniciar_DesktopBridge.bat</span>, escribe arriba tu carpeta de salida en <strong>Ruta referencia Windows</strong> y pulsa <strong>Sincronizar con Puente Windows</strong>. (Opcional: doble clic en <span className="font-mono text-amber-300">Activar_Inicio_Con_Windows.bat</span> para que arranque solo tras apagones).
          </p>

          {bridgeStatus?.connected && bridgeStatus.recentRuns && bridgeStatus.recentRuns.length > 0 && (
            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-[11px] text-emerald-200">
              <span className="font-semibold">Últimas ejecuciones en Windows: </span>
              {bridgeStatus.recentRuns
                .slice(-3)
                .map((r) => `${r.jobName || 'Tarea'} (${r.itemsCount ?? 0} pistas)`)
                .join(' · ')}
            </div>
          )}
        </div>
      </div>

      {/* Calendar / Programa Visual Musical + Upcoming Runs */}
      {(() => {
        const taskGenreMap = new Map<
          string,
          { primaryGenre: string; allGenres: string[]; key: string }
        >();
        const legendMap = new Map<
          string,
          { key: string; label: string; slotCount: number }
        >();

        for (const t of schedules) {
          const resolved = resolveTaskVisualGenre(t, folders, musicTracks);
          const gKey = normalizeGenreKey(resolved.primaryGenre) || 'mix';
          taskGenreMap.set(t.id, { ...resolved, key: gKey });

          const daysActive = t.frequency === 'daily' ? 7 : Math.max(1, t.daysOfWeek.length);
          const timesCount = getTaskScheduledTimes(t).length;
          const prev = legendMap.get(gKey);
          if (prev) {
            prev.slotCount += daysActive * timesCount;
          } else {
            legendMap.set(gKey, {
              key: gKey,
              label: resolved.primaryGenre,
              slotCount: daysActive * timesCount,
            });
          }
        }

        const genreLegend = Array.from(legendMap.values()).sort((a, b) => b.slotCount - a.slotCount);
        const totalWeeklySlots = genreLegend.reduce((sum, g) => sum + g.slotCount, 0);
        const todayDayId = new Date(nowTickMs).getDay();

        return (
          <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
            <div
              className={`${
                isVisualCollapsed ? 'xl:col-span-12' : 'xl:col-span-9'
              } rounded-xl border border-slate-800/80 bg-[#101726] p-4 space-y-3`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Calendar className="w-4 h-4 text-cyan-400 shrink-0" />
                  <h3 className="text-xs font-semibold text-slate-200">
                    Calendario semanal visual
                  </h3>
                  <span className="rounded-md border border-cyan-500/35 bg-cyan-500/12 px-2 py-0.5 text-[11px] font-semibold text-cyan-200">
                    Programa Visual Musical
                  </span>
                  <span className="font-mono text-[11px] text-slate-400">
                    ({totalWeeklySlots} salidas/semana · {genreLegend.length} género
                    {genreLegend.length === 1 ? '' : 's'})
                  </span>
                </div>

                <div className="flex items-center gap-2">
                  {highlightedGenreKey && (
                    <button
                      type="button"
                      onClick={() => setHighlightedGenreKey(null)}
                      className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1 text-[11px] text-slate-200 hover:bg-slate-700 cursor-pointer"
                    >
                      <X className="w-3 h-3" />
                      Ver todos
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={toggleVisualCollapsed}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/90 px-3 py-1.5 text-[11px] font-semibold text-slate-100 hover:bg-slate-700 cursor-pointer"
                    title={
                      isVisualCollapsed
                        ? 'Desplegar la parrilla del Programa Visual Musical'
                        : 'Enrollar el Programa Visual Musical para ahorrar espacio en pantalla'
                    }
                  >
                    {isVisualCollapsed ? (
                      <>
                        <ChevronDown className="w-3.5 h-3.5 text-cyan-400" />
                        Desplegar programa
                      </>
                    ) : (
                      <>
                        <ChevronUp className="w-3.5 h-3.5 text-cyan-400" />
                        Enrollar programa
                      </>
                    )}
                  </button>
                </div>
              </div>

              {/* Compact Summary Strip when collapsed */}
              {isVisualCollapsed ? (
                <div className="rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 flex flex-wrap items-center justify-between gap-2 text-[11px]">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-slate-400">Géneros en parrilla:</span>
                    {genreLegend.length === 0 ? (
                      <span className="text-slate-500">Sin programaciones configuradas</span>
                    ) : (
                      genreLegend.map((g) => {
                        const theme = getGenreColorTheme(g.label, customGenreColors);
                        return (
                          <span
                            key={g.key}
                            className={`inline-flex items-center gap-1.5 rounded border px-2 py-0.5 ${theme.legendClass}`}
                          >
                            <span className={`w-2 h-2 rounded-full ${theme.dotClass}`} />
                            <span>{g.label}</span>
                            <span className="font-mono opacity-75">({g.slotCount})</span>
                          </span>
                        );
                      })
                    )}
                  </div>
                  {nextScheduledOccurrence && (
                    <span className="font-mono text-amber-300">
                      Al aire pronto: {nextScheduledOccurrence.timeStr} · {nextScheduledOccurrence.task.name}
                    </span>
                  )}
                </div>
              ) : (
                <>
                  {/* Interactive Genre Color Legend + Color Customizer */}
                  {genreLegend.length > 0 && (
                    <div className="rounded-lg border border-slate-800/90 bg-[#090d16] p-2.5 space-y-2">
                      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                        <span className="text-slate-400 flex items-center gap-1.5">
                          <Palette className="w-3.5 h-3.5 text-cyan-400" />
                          Colores por género en parrilla (clic para resaltar · paleta para cambiar color):
                        </span>
                      </div>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {genreLegend.map((g) => {
                          const theme = getGenreColorTheme(g.label, customGenreColors);
                          const isSelected = highlightedGenreKey === g.key;
                          const isDimmed = Boolean(highlightedGenreKey && !isSelected);
                          const isPickingColor = editingColorGenreKey === g.key;

                          return (
                            <div key={g.key} className="relative inline-flex items-center">
                              <div
                                className={`inline-flex items-center rounded-md border text-[11px] transition-opacity ${
                                  theme.legendClass
                                } ${isSelected ? 'ring-2 ring-white/60 font-semibold' : ''} ${
                                  isDimmed ? 'opacity-40' : ''
                                }`}
                              >
                                <button
                                  type="button"
                                  onClick={() =>
                                    setHighlightedGenreKey((curr) =>
                                      curr === g.key ? null : g.key
                                    )
                                  }
                                  className="inline-flex items-center gap-1.5 px-2 py-1 cursor-pointer"
                                  title={`Resaltar bloques de "${g.label}" en el calendario`}
                                >
                                  <span className={`w-2.5 h-2.5 rounded-full ${theme.dotClass}`} />
                                  <span>{g.label}</span>
                                  <span className="font-mono text-[10px] opacity-80">
                                    {g.slotCount}
                                  </span>
                                </button>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setEditingColorGenreKey((curr) =>
                                      curr === g.key ? null : g.key
                                    )
                                  }
                                  className="px-1.5 py-1 border-l border-white/10 hover:bg-white/10 cursor-pointer"
                                  title={`Cambiar color distintivo para "${g.label}"`}
                                >
                                  <Palette className="w-3 h-3 opacity-80" />
                                </button>
                              </div>

                              {isPickingColor && (
                                <div className="absolute left-0 top-full mt-1.5 z-30 rounded-lg border border-slate-700 bg-[#101726] p-2 shadow-2xl flex flex-wrap gap-1.5 w-44">
                                  {GENRE_COLOR_PALETTE.map((opt) => (
                                    <button
                                      key={opt.id}
                                      type="button"
                                      onClick={() => assignGenreColor(g.key, opt.id)}
                                      className={`w-5 h-5 rounded-full ${opt.dotClass} border border-white/30 hover:scale-110 transition-transform cursor-pointer ${
                                        theme.id === opt.id ? 'ring-2 ring-white' : ''
                                      }`}
                                      title={opt.label}
                                    />
                                  ))}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* 7-Day Visual Broadcast Grid */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2.5">
                    {DAYS_ES.map((day) => {
                      const isToday = day.id === todayDayId;
                      const daySlots = schedules
                        .filter(
                          (t) =>
                            t.frequency === 'daily' ||
                            (t.frequency === 'weekly' && t.daysOfWeek.includes(day.id))
                        )
                        .flatMap((t) =>
                          getTaskScheduledTimes(t).map((timeStr) => ({ task: t, timeStr }))
                        )
                        .sort((a, b) => a.timeStr.localeCompare(b.timeStr));

                      return (
                        <div
                          key={day.id}
                          className={`rounded-lg border p-2.5 min-h-[140px] flex flex-col ${
                            isToday
                              ? 'border-cyan-500/45 bg-[#0c1424]'
                              : 'border-slate-800 bg-[#090d16]'
                          }`}
                        >
                          <div className="flex items-center justify-between border-b border-slate-800 pb-1.5 mb-2">
                            <span
                              className={`text-xs font-semibold ${
                                isToday ? 'text-cyan-300' : 'text-slate-200'
                              }`}
                            >
                              {day.short}
                            </span>
                            {isToday ? (
                              <span className="rounded bg-cyan-500/20 px-1.5 py-0.5 text-[9px] font-mono font-bold text-cyan-300">
                                HOY
                              </span>
                            ) : (
                              <span className="font-mono text-[10px] text-slate-500">
                                {daySlots.length}
                              </span>
                            )}
                          </div>

                          {daySlots.length === 0 ? (
                            <span className="text-[11px] text-slate-600 my-auto text-center">
                              Sin bloques
                            </span>
                          ) : (
                            <div className="space-y-1.5">
                              {daySlots.map(({ task, timeStr }) => {
                                const gInfo = taskGenreMap.get(task.id) || {
                                  primaryGenre: 'Mix Variado',
                                  allGenres: ['Mix Variado'],
                                  key: 'mix',
                                };
                                const theme = getGenreColorTheme(
                                  gInfo.primaryGenre,
                                  customGenreColors
                                );
                                const isDimmed = Boolean(
                                  highlightedGenreKey && highlightedGenreKey !== gInfo.key
                                );
                                const isNextOnAir =
                                  isToday &&
                                  nextScheduledOccurrence?.task.id === task.id &&
                                  nextScheduledOccurrence?.timeStr === timeStr;

                                return (
                                  <div
                                    key={`${task.id}_${timeStr}`}
                                    onClick={() => void openEdit(task)}
                                    className={`rounded-md border px-2 py-1.5 text-[11px] cursor-pointer transition-all ${
                                      task.enabled
                                        ? theme.cardClass
                                        : 'border-slate-800 border-l-4 border-l-slate-600 bg-slate-900/80 text-slate-500 opacity-70'
                                    } ${isDimmed ? 'opacity-25' : ''}`}
                                    title={`${task.name} · ${timeStr} · Género: ${gInfo.allGenres.join(', ')}`}
                                  >
                                    <div className="flex items-center justify-between gap-1">
                                      <span className="font-mono font-bold">{timeStr}</span>
                                      <span className="font-mono text-[10px] opacity-80">
                                        {task.targetType === 'count'
                                          ? `${task.targetCount}t`
                                          : `${task.targetDurationMin}m`}
                                      </span>
                                    </div>
                                    <div className="truncate font-medium mt-0.5">{task.name}</div>
                                    <div className="mt-1 flex items-center justify-between gap-1">
                                      <span
                                        className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] truncate max-w-full ${
                                          task.enabled
                                            ? theme.badgeClass
                                            : 'border-slate-700 bg-slate-800 text-slate-400'
                                        }`}
                                      >
                                        <span
                                          className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                                            task.enabled ? theme.dotClass : 'bg-slate-500'
                                          }`}
                                        />
                                        <span className="truncate">
                                          {gInfo.primaryGenre}
                                          {gInfo.allGenres.length > 1
                                            ? ` +${gInfo.allGenres.length - 1}`
                                            : ''}
                                        </span>
                                      </span>
                                      {isNextOnAir && (
                                        <span className="rounded bg-amber-400 px-1 py-0.5 text-[8px] font-bold text-slate-950 shrink-0">
                                          SIG
                                        </span>
                                      )}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
            </div>

            <div
              className={`${
                isVisualCollapsed ? 'xl:col-span-12' : 'xl:col-span-3'
              } rounded-xl border border-slate-800/80 bg-[#101726] p-4 space-y-3`}
            >
              <h3 className="text-xs font-semibold text-slate-300 flex items-center gap-2">
                <Clock className="w-4 h-4 text-amber-400" />
                Próximas ejecuciones
              </h3>
              {upcomingList.length === 0 ? (
                <p className="text-xs text-slate-500">No hay tareas activas próximas.</p>
              ) : (
                <div
                  className={
                    isVisualCollapsed
                      ? 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-xs'
                      : 'divide-y divide-slate-800/70 text-xs'
                  }
                >
                  {upcomingList.map(({ task, nextDate, timeStr }) => {
                    const gInfo = taskGenreMap.get(task.id) || {
                      primaryGenre: 'Mix Variado',
                      allGenres: ['Mix Variado'],
                      key: 'mix',
                    };
                    const theme = getGenreColorTheme(gInfo.primaryGenre, customGenreColors);
                    return (
                      <div
                        key={`${task.id}_${timeStr}`}
                        className={
                          isVisualCollapsed
                            ? 'rounded-lg border border-slate-800 bg-[#090d16] p-2.5 flex items-center justify-between gap-2'
                            : 'py-2 flex items-center justify-between gap-2'
                        }
                      >
                        <div className="min-w-0 flex items-center gap-2">
                          <span
                            className={`w-2.5 h-2.5 rounded-full shrink-0 ${theme.dotClass}`}
                            title={gInfo.primaryGenre}
                          />
                          <div className="min-w-0">
                            <p className="font-medium text-slate-200 truncate">{task.name}</p>
                            <p className="text-[11px] text-slate-500 truncate font-mono">
                              {gInfo.primaryGenre} · {resolveScheduledOutputFilename(task)}
                            </p>
                          </div>
                        </div>
                        <span className="font-mono text-[11px] text-amber-300 shrink-0">
                          {nextDate.toLocaleDateString('es-ES', {
                            weekday: 'short',
                            day: '2-digit',
                          })}{' '}
                          {timeStr}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        );
      })()}

      {/* Tasks List */}
      <div className="rounded-xl border border-slate-800/80 bg-[#101726] divide-y divide-slate-800/70">
        {schedules.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            No hay tareas programadas todavía. Pulsa <strong>Nueva programación</strong> para automatizar horarios y sobrescritura en disco.
          </div>
        ) : (
          schedules.map((t) => {
            const outFile = resolveScheduledOutputFilename(t);
            const allTimes = getTaskScheduledTimes(t);
            const sourceFolderName =
              t.sourceScope === 'folder' && t.sourceFolderId
                ? folders.find((f) => f.id === t.sourceFolderId)?.name || 'Carpeta'
                : 'Toda la biblioteca';

            return (
              <div
                key={t.id}
                className="p-4 flex flex-col lg:flex-row lg:items-center justify-between gap-3 text-xs"
              >
                <div className="space-y-1.5 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      onClick={() => void handleToggle(t)}
                      className={`rounded px-2 py-0.5 text-[11px] font-semibold cursor-pointer ${
                        t.enabled
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/35'
                          : 'bg-slate-800 text-slate-400 border border-slate-700'
                      }`}
                    >
                      {t.enabled ? 'ACTIVA' : 'PAUSADA'}
                    </button>
                    <span className="font-semibold text-sm text-slate-100">{t.name}</span>
                    <span className="font-mono text-cyan-300">{allTimes.join(' · ')}</span>
                    <span className="text-slate-400">
                      · {t.frequency === 'daily' ? 'Todos los días' : 'Semanal'} ·{' '}
                      {t.targetType === 'count'
                        ? `${t.targetCount} temas`
                        : t.targetType === 'duration'
                        ? `${t.targetDurationMin} min`
                        : `${t.targetCount} temas / ${t.targetDurationMin} min`}
                    </span>
                  </div>

                  {/* Rule Badges */}
                  <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                    <span className="rounded bg-slate-800 px-2 py-0.5 text-slate-300">
                      Origen: {sourceFolderName}
                    </span>
                    <span className="rounded bg-slate-800 px-2 py-0.5 text-slate-300">
                      Modo: {t.mode || 'Combinado'}
                    </span>
                    {t.noRepeatTracks !== false && (
                      <span className="rounded border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-cyan-200">
                        No repetir temas
                      </span>
                    )}
                    {t.noRepeatArtists !== false && (
                      <span className="rounded border border-cyan-500/30 bg-cyan-500/10 px-2 py-0.5 text-cyan-200">
                        No repetir cantantes
                      </span>
                    )}
                    {t.allowedGenres.length > 0 && (
                      <span className="rounded border border-violet-500/30 bg-violet-500/10 px-2 py-0.5 text-violet-200">
                        Géneros: {t.allowedGenres.join(', ')}
                      </span>
                    )}
                    {(t.bpmMin !== null || t.bpmMax !== null) && (
                      <span className="rounded border border-blue-500/30 bg-blue-500/10 px-2 py-0.5 font-mono text-blue-200">
                        BPM: {t.bpmMin ?? '—'}–{t.bpmMax ?? '—'}
                      </span>
                    )}
                    {t.spots?.enabled && (
                      <span className="rounded border border-amber-500/35 bg-amber-500/10 px-2 py-0.5 text-amber-200">
                        Spots cada {t.spots.everyNSongs} temas
                      </span>
                    )}
                  </div>

                  <p className="text-slate-400 font-mono text-[11px] break-all">
                    Archivo: <strong className="text-slate-200">{outFile}</strong> · Carpeta:{' '}
                    {t.outputFolderName || globalDirStatus.folderName || 'Sin vincular'} (
                    {t.overwriteExisting !== false ? 'Sobrescribe siempre' : 'Con marca de hora'}) ·
                    Última ejecución: {formatDateTime(t.lastRunAt)}
                  </p>

                  {t.lastMessage && (
                    <p
                      className={`text-[11px] ${
                        t.lastStatus === 'error'
                          ? 'text-rose-400'
                          : t.lastStatus === 'warning'
                          ? 'text-amber-300'
                          : 'text-emerald-300'
                      }`}
                    >
                      {t.lastMessage}
                    </p>
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    disabled={runningTaskId === t.id}
                    onClick={() => void handleRunNow(t)}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-500 px-3 py-1.5 font-semibold text-slate-950 hover:bg-emerald-400 disabled:opacity-50 cursor-pointer"
                  >
                    {runningTaskId === t.id ? (
                      <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Play className="w-3.5 h-3.5" />
                    )}
                    Ejecutar y sobrescribir
                  </button>
                  <button
                    type="button"
                    onClick={() => void openEdit(t)}
                    className="inline-flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-800/80 px-2.5 py-1.5 text-slate-200 hover:bg-slate-800 cursor-pointer"
                  >
                    <Edit3 className="w-3.5 h-3.5" />
                    Editar
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmDeleteTask(t)}
                    className="inline-flex items-center gap-1 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-rose-300 hover:bg-rose-500/20 cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Scheduler Execution History */}
      {schedulerLogs.length > 0 && (
        <div className="rounded-xl border border-slate-800/80 bg-[#101726] p-4 space-y-2">
          <h3 className="text-xs font-semibold text-slate-300">Historial de ejecuciones</h3>
          <div className="divide-y divide-slate-800/60 text-xs">
            {schedulerLogs.map((log) => (
              <div key={log.id} className="py-2 flex items-center justify-between gap-2">
                <div className="truncate">
                  <span className="font-medium text-slate-200">{log.title}</span>
                  <span className="text-slate-400"> · {log.detail}</span>
                </div>
                <span className="font-mono text-slate-500 shrink-0">
                  {formatDateTime(log.timestamp)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Modal Create/Edit Task */}
      {showModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 overflow-y-auto">
          <form
            onSubmit={handleSave}
            className="w-full max-w-2xl rounded-2xl border border-slate-800 bg-[#101726] p-6 space-y-5 text-xs my-auto max-h-[92vh] overflow-y-auto"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-100">
                  {editingTask ? 'Editar programación automática' : 'Nueva programación automática'}
                </h3>
                <p className="text-[11px] text-slate-400">
                  Configura horarios, reglas musicales, spots y el archivo a sobrescribir en disco.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleImportFromGenerator}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/40 bg-cyan-500/15 px-2.5 py-1.5 text-[11px] font-semibold text-cyan-200 hover:bg-cyan-500/25 cursor-pointer"
                >
                  <Wand2 className="w-3.5 h-3.5" />
                  Cargar reglas del Generador
                </button>
                <button
                  type="button"
                  onClick={() => setShowModal(false)}
                  className="p-1 text-slate-400 hover:text-white cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* 1. Schedule & Triggers */}
            <div className="space-y-3">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-cyan-400">
                1. Horarios y frecuencia
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-3">
                  <label className="block text-slate-400 mb-1">Nombre del bloque</label>
                  <input
                    type="text"
                    required
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Frecuencia</label>
                  <select
                    value={form.frequency}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        frequency: e.target.value as 'daily' | 'weekly',
                      }))
                    }
                    className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 text-slate-100"
                  >
                    <option value="daily">Todos los días</option>
                    <option value="weekly">Días específicos (semanal)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Hora principal</label>
                  <input
                    type="time"
                    required
                    value={form.time}
                    onChange={(e) => setForm((f) => ({ ...f, time: e.target.value }))}
                    className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 font-mono text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Agregar otro horario en el día</label>
                  <div className="flex gap-1.5">
                    <input
                      type="time"
                      value={extraTimeDraft}
                      onChange={(e) => setExtraTimeDraft(e.target.value)}
                      className="flex-1 rounded-lg border border-slate-800 bg-[#090d16] px-2.5 py-2 font-mono text-slate-100"
                    />
                      <button
                        type="button"
                        onClick={addExtraTime}
                        className="rounded-lg border border-cyan-500/40 bg-cyan-500/15 px-3 py-2 text-[11px] font-semibold text-cyan-200 hover:bg-cyan-500/25 whitespace-nowrap cursor-pointer"
                      >
                        + Agregar
                      </button>
                  </div>
                </div>
              </div>

              {(form.extraTimes || []).length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[11px] text-slate-400">Horarios adicionales:</span>
                  {(form.extraTimes || []).map((et) => (
                    <span
                      key={et}
                      className="inline-flex items-center gap-1 rounded border border-cyan-500/40 bg-cyan-500/15 px-2 py-0.5 font-mono text-[11px] text-cyan-200"
                    >
                      {et}
                      <button
                        type="button"
                        onClick={() =>
                          setForm((f) => ({
                            ...f,
                            extraTimes: (f.extraTimes || []).filter((x) => x !== et),
                          }))
                        }
                        className="hover:text-rose-300 cursor-pointer"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}

              {form.frequency === 'weekly' && (
                <div>
                  <label className="block text-slate-400 mb-1.5">Días de la semana</label>
                  <div className="flex flex-wrap gap-1.5">
                    {DAYS_ES.map((d) => {
                      const active = form.daysOfWeek.includes(d.id);
                      return (
                        <button
                          key={d.id}
                          type="button"
                          onClick={() =>
                            setForm((f) => ({
                              ...f,
                              daysOfWeek: active
                                ? f.daysOfWeek.filter((x) => x !== d.id)
                                : [...f.daysOfWeek, d.id],
                            }))
                          }
                          className={`px-2.5 py-1 rounded border cursor-pointer ${
                            active
                              ? 'border-cyan-500 bg-cyan-500/20 text-cyan-200'
                              : 'border-slate-800 bg-[#090d16] text-slate-400'
                          }`}
                        >
                          {d.short}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* 2. Music Selection, No Repeat & Filters */}
            <div className="space-y-3 pt-3 border-t border-slate-800/80">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-cyan-400">
                2. Selección de canciones, no repetición y filtros
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-400 mb-1">Grupo / origen musical</label>
                  <select
                    value={form.sourceScope === 'folder' ? form.sourceFolderId || '' : '__all__'}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === '__all__') {
                        setForm((f) => ({ ...f, sourceScope: 'all', sourceFolderId: '' }));
                      } else {
                        setForm((f) => ({ ...f, sourceScope: 'folder', sourceFolderId: val }));
                      }
                    }}
                    className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 text-slate-100"
                  >
                    <option value="__all__">Toda la biblioteca ({musicTracks.length} temas)</option>
                    {musicFolders.map((mf) => (
                      <option key={mf.id} value={mf.id}>
                        Carpeta: {mf.name} ({mf.trackCount} temas)
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-slate-400 mb-1">Modo de mezcla</label>
                  <select
                    value={form.mode || 'Combinado'}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, mode: e.target.value as GenerationMode }))
                    }
                    className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 text-slate-100"
                  >
                    {GENERATION_MODES.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {/* Target Type */}
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div>
                  <label className="block text-slate-400 mb-1">Objetivo</label>
                  <select
                    value={form.targetType}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        targetType: e.target.value as 'duration' | 'count' | 'both',
                      }))
                    }
                    className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-2.5 py-2 text-slate-100"
                  >
                    <option value="duration">Por tiempo (min)</option>
                    <option value="count">Por cantidad de temas</option>
                    <option value="both">Ambos</option>
                  </select>
                </div>

                {(form.targetType === 'duration' || form.targetType === 'both') && (
                  <div>
                    <label className="block text-slate-400 mb-1">Duración (min)</label>
                    <input
                      type="number"
                      min={5}
                      max={720}
                      value={form.targetDurationMin}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          targetDurationMin: Math.max(5, Number(e.target.value) || 60),
                        }))
                      }
                      className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-2.5 py-2 font-mono text-slate-100"
                    />
                  </div>
                )}

                {(form.targetType === 'count' || form.targetType === 'both') && (
                  <div>
                    <label className="block text-slate-400 mb-1">Cantidad de temas</label>
                    <input
                      type="number"
                      min={1}
                      max={500}
                      value={form.targetCount}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          targetCount: Math.max(1, Number(e.target.value) || 18),
                        }))
                      }
                      className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-2.5 py-2 font-mono text-slate-100"
                    />
                  </div>
                )}
              </div>

              {/* Non-repetition checkboxes */}
              <div className="rounded-lg border border-slate-800 bg-[#090d16] p-3 space-y-2">
                <label className="flex items-center gap-2 text-slate-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.noRepeatTracks !== false}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, noRepeatTracks: e.target.checked }))
                    }
                    className="accent-cyan-500"
                  />
                  <span>No repetir temas ni copias duplicadas dentro de la misma playlist</span>
                </label>
                <label className="flex items-center gap-2 text-slate-200 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={form.noRepeatArtists !== false}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, noRepeatArtists: e.target.checked }))
                    }
                    className="accent-cyan-500"
                  />
                  <span>No repetir cantantes / artistas dentro de la misma playlist</span>
                </label>
                <div className="flex flex-wrap items-center gap-3 pt-1">
                  <label className="flex items-center gap-2 text-slate-300 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.respectAntiRepeat ?? true}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, respectAntiRepeat: e.target.checked }))
                      }
                      className="accent-cyan-500"
                    />
                    <span>Evitar temas usados en horas recientes:</span>
                  </label>
                  <input
                    type="number"
                    min={0}
                    max={720}
                    disabled={!(form.respectAntiRepeat ?? true)}
                    value={form.antiRepeatHours ?? settings.antiRepeatHours}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        antiRepeatHours: Math.max(0, Number(e.target.value) || 0),
                      }))
                    }
                    className="w-20 rounded border border-slate-800 bg-[#101726] px-2 py-1 font-mono text-slate-100 disabled:opacity-45"
                  />
                  <span className="text-slate-400">horas</span>
                </div>
                <label className="flex items-center gap-2 text-slate-300 cursor-pointer pt-0.5">
                  <input
                    type="checkbox"
                    checked={form.fallbackToOldestOnExhaust !== false}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, fallbackToOldestOnExhaust: e.target.checked }))
                    }
                    className="accent-cyan-500"
                  />
                  <span>
                    Si todas las canciones se usaron en esas horas, completar con las más antiguas para nunca fallar la tanda
                  </span>
                </label>
              </div>

              {/* Genre chips from real library */}
              {libraryFacets.genres.length > 0 && (
                <div>
                  <label className="block text-slate-400 mb-1">
                    Géneros reales detectados en tu biblioteca (clic para seleccionar)
                  </label>
                  <div className="flex flex-wrap gap-1.5 max-h-24 overflow-y-auto">
                    {libraryFacets.genres.slice(0, 18).map((g) => {
                      const active = form.allowedGenres.includes(g.value);
                      return (
                        <button
                          key={g.value}
                          type="button"
                          onClick={() =>
                            setForm((f) => ({
                              ...f,
                              allowedGenres: active
                                ? f.allowedGenres.filter((x) => x !== g.value)
                                : [...f.allowedGenres, g.value],
                            }))
                          }
                          className={`px-2 py-0.5 rounded border text-[11px] cursor-pointer ${
                            active
                              ? 'border-cyan-500 bg-cyan-500/20 text-cyan-200'
                              : 'border-slate-800 bg-[#090d16] text-slate-400 hover:text-slate-200'
                          }`}
                        >
                          {g.value} ({g.count})
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-slate-400 mb-1">Géneros permitidos (coma)</label>
                  <input
                    type="text"
                    placeholder="Pop, Rock"
                    value={form.allowedGenres.join(', ')}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        allowedGenres: e.target.value
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean),
                      }))
                    }
                    className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Géneros excluidos (coma)</label>
                  <input
                    type="text"
                    placeholder="Infantil"
                    value={form.excludedGenres.join(', ')}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        excludedGenres: e.target.value
                          .split(',')
                          .map((s) => s.trim())
                          .filter(Boolean),
                      }))
                    }
                    className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 text-slate-100"
                  />
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-slate-400 mb-1">Ambiente</label>
                  <select
                    value={form.mood}
                    onChange={(e) => setForm((f) => ({ ...f, mood: e.target.value }))}
                    className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-2.5 py-2 text-slate-100"
                  >
                    <option value="">Cualquiera</option>
                    {MOOD_OPTIONS.map((m) => (
                      <option key={m} value={m}>
                        {m}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">BPM mín</label>
                  <input
                    type="number"
                    value={form.bpmMin ?? ''}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        bpmMin: e.target.value ? Number(e.target.value) : null,
                      }))
                    }
                    className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-2.5 py-2 font-mono text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">BPM máx</label>
                  <input
                    type="number"
                    value={form.bpmMax ?? ''}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        bpmMax: e.target.value ? Number(e.target.value) : null,
                      }))
                    }
                    className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-2.5 py-2 font-mono text-slate-100"
                  />
                </div>
              </div>

              <div>
                <label className="block text-slate-400 mb-1">Intensidades</label>
                <div className="flex flex-wrap gap-1.5">
                  {INTENSITY_LEVELS.map((lvl: IntensityLevel) => {
                    const active = form.intensities.includes(lvl);
                    return (
                      <button
                        key={lvl}
                        type="button"
                        onClick={() =>
                          setForm((f) => ({
                            ...f,
                            intensities: active
                              ? f.intensities.filter((x) => x !== lvl)
                              : [...f.intensities, lvl],
                          }))
                        }
                        className={`px-2 py-1 rounded border cursor-pointer ${
                          active
                            ? 'border-emerald-500 bg-emerald-500/20 text-emerald-200'
                            : 'border-slate-800 bg-[#090d16] text-slate-400'
                        }`}
                      >
                        {lvl}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* 3. Spots / Jingles Rotation */}
            <div className="space-y-3 pt-3 border-t border-slate-800/80">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-amber-400 flex items-center gap-1.5">
                  <Radio className="w-3.5 h-3.5" />
                  3. Rotación automática de Spots / Jingles
                </span>
                <label className="inline-flex items-center gap-2 cursor-pointer text-slate-200">
                  <input
                    type="checkbox"
                    checked={Boolean(form.spots?.enabled)}
                    onChange={(e) =>
                      setForm((f) => ({
                        ...f,
                        spots: {
                          spotFolderId: f.spots?.spotFolderId || spotFolders[0]?.id || '',
                          everyNSongs: f.spots?.everyNSongs || 3,
                          rotationMode: f.spots?.rotationMode || 'random-no-repeat',
                          insertIntroAtStart: f.spots?.insertIntroAtStart ?? true,
                          enabled: e.target.checked,
                        },
                      }))
                    }
                    className="accent-amber-500"
                  />
                  <span>Incluir spots en este horario</span>
                </label>
              </div>

              {form.spots?.enabled && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
                  <div>
                    <label className="block text-slate-400 mb-1">Carpeta de spots</label>
                    <select
                      value={form.spots.spotFolderId}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          spots: { ...f.spots!, spotFolderId: e.target.value },
                        }))
                      }
                      className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-2.5 py-2 text-slate-100"
                    >
                      <option value="">Elegir carpeta de spots...</option>
                      {spotFolders.map((sf) => (
                        <option key={sf.id} value={sf.id}>
                          {sf.name} ({sf.trackCount})
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-slate-400 mb-1">1 spot cada N canciones</label>
                    <input
                      type="number"
                      min={1}
                      max={30}
                      value={form.spots.everyNSongs}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          spots: {
                            ...f.spots!,
                            everyNSongs: Math.max(1, Number(e.target.value) || 3),
                          },
                        }))
                      }
                      className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-2.5 py-2 font-mono text-slate-100"
                    />
                  </div>
                  <div>
                    <label className="block text-slate-400 mb-1">Orden de spots</label>
                    <select
                      value={form.spots.rotationMode}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          spots: {
                            ...f.spots!,
                            rotationMode: e.target.value as SpotRotationMode,
                          },
                        }))
                      }
                      className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-2.5 py-2 text-slate-100"
                    >
                      <option value="random-no-repeat">Aleatorio sin repetir seguido</option>
                      <option value="sequential">Secuencial</option>
                    </select>
                  </div>
                  <div className="sm:col-span-3">
                    <label className="inline-flex items-center gap-2 text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={form.spots.insertIntroAtStart}
                        onChange={(e) =>
                          setForm((f) => ({
                            ...f,
                            spots: { ...f.spots!, insertIntroAtStart: e.target.checked },
                          }))
                        }
                        className="accent-amber-500"
                      />
                      <span>Insertar un spot / intro al inicio del bloque</span>
                    </label>
                  </div>
                </div>
              )}
            </div>

            {/* 4. Output File Name & Disk Overwrite Destination */}
            <div className="space-y-3 pt-3 border-t border-slate-800/80">
              <div className="text-[11px] font-semibold uppercase tracking-wider text-emerald-400">
                4. Archivo de salida y sobrescritura en disco
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <div className="sm:col-span-2">
                  <label className="block text-slate-400 mb-1">
                    Nombre fijo del archivo en disco (sin extensión)
                  </label>
                  <input
                    type="text"
                    value={form.outputFileName || ''}
                    onChange={(e) => setForm((f) => ({ ...f, outputFileName: e.target.value }))}
                    placeholder="Ej. Bloque_Matinal (dejar vacío para usar patrón)"
                    className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-3 py-2 font-mono text-slate-100"
                  />
                </div>
                <div>
                  <label className="block text-slate-400 mb-1">Formato</label>
                  <select
                    value={form.format}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, format: e.target.value as 'm3u8' | 'm3u' }))
                    }
                    className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-2.5 py-2 text-slate-100"
                  >
                    <option value="m3u8">M3U8 (UTF-8)</option>
                    <option value="m3u">M3U</option>
                  </select>
                </div>
              </div>

              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-mono text-[11px] text-emerald-200">
                    Archivo resultante: <strong>{previewFilename}</strong>
                  </span>
                  <label className="inline-flex items-center gap-2 text-slate-200 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={form.overwriteExisting !== false}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, overwriteExisting: e.target.checked }))
                      }
                      className="accent-emerald-500"
                    />
                    <span>Sobrescribir archivo existente en cada ejecución</span>
                  </label>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                  <div>
                    <label className="block text-slate-400 mb-1">Carpeta destino en disco</label>
                    <select
                      value={form.outputFolderMode || 'global'}
                      onChange={(e) =>
                        setForm((f) => ({
                          ...f,
                          outputFolderMode: e.target.value as 'global' | 'custom',
                        }))
                      }
                      className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-2.5 py-2 text-slate-100"
                    >
                      <option value="global">
                        Carpeta principal ({globalDirStatus.folderName || 'Sin vincular'})
                      </option>
                      <option value="custom">Carpeta exclusiva para esta tarea</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-slate-400 mb-1">Modo de rutas dentro del M3U</label>
                    <select
                      value={form.pathMode}
                      onChange={(e) =>
                        setForm((f) => ({ ...f, pathMode: e.target.value as PathExportMode }))
                      }
                      className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-2.5 py-2 text-slate-100"
                    >
                      <option value="multi-drive">Multi-unidad (por carpeta real)</option>
                      <option value="absolute">Absoluta (prefijo global)</option>
                      <option value="relative">Relativa</option>
                    </select>
                  </div>
                </div>

                {form.outputFolderMode === 'custom' && (
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    <span className="text-[11px] font-mono text-slate-300 flex items-center gap-1.5">
                      <FolderCheck className="w-3.5 h-3.5 text-cyan-400" />
                      {customDirStatus?.hasHandle
                        ? `Carpeta exclusiva: ${customDirStatus.folderName}`
                        : 'Sin carpeta exclusiva seleccionada todavía'}
                    </span>
                    <button
                      type="button"
                      onClick={() => void handlePickCustomTaskFolder()}
                      className="rounded-lg border border-cyan-500/40 bg-cyan-500/15 px-3 py-1.5 text-[11px] font-semibold text-cyan-200 hover:bg-cyan-500/25 cursor-pointer"
                    >
                      Elegir carpeta en disco
                    </button>
                  </div>
                )}

                {!(form.outputFileName || '').trim() && (
                  <div>
                    <label className="block text-slate-400 mb-1">
                      Patrón dinámico (solo si el nombre fijo queda vacío)
                    </label>
                    <input
                      type="text"
                      value={form.namePattern}
                      onChange={(e) => setForm((f) => ({ ...f, namePattern: e.target.value }))}
                      className="w-full rounded-lg border border-slate-800 bg-[#090d16] px-2.5 py-1.5 font-mono text-slate-100"
                    />
                  </div>
                )}
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
              <button
                type="button"
                onClick={() => setShowModal(false)}
                className="rounded-lg border border-slate-700 px-4 py-2 text-slate-300 hover:bg-slate-800 cursor-pointer"
              >
                Cancelar
              </button>
              <button
                type="submit"
                className="rounded-lg bg-cyan-500 px-4 py-2 font-semibold text-slate-950 hover:bg-cyan-400 cursor-pointer"
              >
                Guardar programación
              </button>
            </div>
          </form>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(confirmDeleteTask)}
        title="Eliminar tarea programada"
        message={`¿Confirmas eliminar la programación "${confirmDeleteTask?.name}"?`}
        onConfirm={async () => {
          if (confirmDeleteTask) {
            await db.schedules.delete(confirmDeleteTask.id);
            await db.folderHandles.delete(getTaskOutputHandleId(confirmDeleteTask.id));
            setConfirmDeleteTask(null);
            await refreshAll();
            showToast('info', 'Tarea programada eliminada.');
          }
        }}
        onCancel={() => setConfirmDeleteTask(null)}
      />
    </div>
  );
};
