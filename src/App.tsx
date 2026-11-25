import React, { useState } from 'react';
import {
  Activity,
  BarChart3,
  CalendarClock,
  Database,
  Download,
  FolderPlus,
  History,
  LayoutDashboard,
  Library,
  Menu,
  Pause,
  Play,
  Radio,
  Settings,
  Sparkles,
  Square,
  Upload,
  Wand2,
  X,
} from 'lucide-react';
import { AnalyzerModule } from './components/AnalyzerModule';
import { ConfirmDialog } from './components/ConfirmDialog';
import { DashboardModule } from './components/DashboardModule';
import { GeneratorModule } from './components/GeneratorModule';
import { HistorySettingsModule } from './components/HistorySettingsModule';
import { LibraryModule } from './components/LibraryModule';
import { OfflineIndicator, PWAInstallButton } from './components/PWAInstallButton';
import { RadioBossModule } from './components/RadioBossModule';
import { SchedulerModule } from './components/SchedulerModule';
import { StudioProvider, useStudio } from './context/StudioContext';
import { exportFullBackup, importFullBackup, type StudioBackupPayload } from './db/database';
import { supportsFileSystemAccess } from './services/fileAccessService';
import { downloadTextFile } from './services/radioboss';
import type { ModuleId } from './types/studio';

interface NavItem {
  id: ModuleId;
  label: string;
  shortLabel: string;
  icon: React.ComponentType<{ className?: string }>;
}

const NAV_ITEMS: NavItem[] = [
  { id: 'dashboard', label: 'Dashboard', shortLabel: 'Inicio', icon: LayoutDashboard },
  { id: 'library', label: 'Biblioteca Musical', shortLabel: 'Biblioteca', icon: Library },
  { id: 'analyzer', label: 'Analizador IA', shortLabel: 'Analizador', icon: Activity },
  { id: 'generator', label: 'Generador Inteligente', shortLabel: 'Generador', icon: Wand2 },
  { id: 'scheduler', label: 'Programador', shortLabel: 'Agenda', icon: CalendarClock },
  { id: 'radioboss', label: 'Playlists & RadioBOSS', shortLabel: 'RadioBOSS', icon: Radio },
  { id: 'history', label: 'Historial', shortLabel: 'Historial', icon: History },
  { id: 'stats', label: 'Estadísticas', shortLabel: 'Estadísticas', icon: BarChart3 },
  { id: 'settings', label: 'Configuración', shortLabel: 'Ajustes', icon: Settings },
];

const StudioShell: React.FC = () => {
  const {
    activeModule,
    setActiveModule,
    tracks,
    playlists,
    schedules,
    analysisProgress,
    pauseAnalysis,
    resumeAnalysis,
    cancelAnalysis,
    schedulerGlobalDirStatus,
    nextScheduledOccurrence,
    authorizeSchedulerDiskAndFlush,
    toast,
    showToast,
    refreshAll,
    importFolderViaPicker,
    importFilesViaInput,
    isLoading,
  } = useStudio();

  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [isExportingDb, setIsExportingDb] = useState(false);
  const [pendingDbImport, setPendingDbImport] = useState<StudioBackupPayload | null>(null);
  const topImportRef = React.useRef<HTMLInputElement>(null);
  const topDbRestoreRef = React.useRef<HTMLInputElement>(null);

  const activeNav = NAV_ITEMS.find((n) => n.id === activeModule) || NAV_ITEMS[0];
  const activeSchedulesCount = schedules.filter((s) => s.enabled).length;

  const handleQuickImport = () => {
    if (supportsFileSystemAccess()) {
      importFolderViaPicker('music', null, () => topImportRef.current?.click());
    } else {
      topImportRef.current?.click();
    }
  };

  const handleExportFullDatabase = async () => {
    setIsExportingDb(true);
    try {
      const payload = await exportFullBackup();
      const fileName = `smart_playlist_studio_bd_${new Date().toISOString().slice(0, 10)}.json`;
      const ok = await downloadTextFile(
        fileName,
        JSON.stringify(payload, null, 2),
        'application/json;charset=utf-8'
      );
      if (ok) {
        await refreshAll();
        showToast(
          'success',
          `Base de datos exportada (${payload.data.tracks.length} canciones, ${payload.data.playlists.length} playlists, ${payload.data.schedules.length} programaciones).`
        );
      }
    } catch (err) {
      showToast(
        'error',
        err instanceof Error ? err.message : 'No se pudo exportar la base de datos.'
      );
    } finally {
      setIsExportingDb(false);
    }
  };

  const applyDatabaseImport = async (payload: StudioBackupPayload) => {
    try {
      const res = await importFullBackup(payload);
      await refreshAll();
      showToast(
        'success',
        `Base de datos cargada: ${res.tracks} canciones, ${res.playlists} playlists, ${res.schedules} programaciones.`
      );
    } catch (err) {
      showToast(
        'error',
        err instanceof Error ? err.message : 'No se pudo importar el archivo de base de datos.'
      );
    }
  };

  const handleSelectDatabaseFile = async (file: File) => {
    try {
      const raw = await file.text();
      const parsed = JSON.parse(raw) as StudioBackupPayload;
      if (!parsed || parsed.app !== 'SMART PLAYLIST AI STUDIO' || !parsed.data) {
        throw new Error('Archivo incompatible: selecciona un respaldo .json de SMART PLAYLIST AI STUDIO.');
      }
      const hasExistingData = tracks.length > 0 || playlists.length > 0 || schedules.length > 0;
      if (hasExistingData) {
        setPendingDbImport(parsed);
      } else {
        await applyDatabaseImport(parsed);
      }
    } catch (err) {
      showToast(
        'error',
        err instanceof Error ? err.message : 'Archivo JSON inválido o dañado.'
      );
    }
  };

  const engineBadge =
    analysisProgress.status === 'running'
      ? {
          text: `Analizando ${analysisProgress.completed}/${analysisProgress.total}`,
          tone: 'border-cyan-500/40 bg-cyan-500/10 text-cyan-300',
        }
      : analysisProgress.status === 'paused'
      ? {
          text: `Pausado ${analysisProgress.completed}/${analysisProgress.total}`,
          tone: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
        }
      : {
          text: 'DSP Listo',
          tone: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300',
        };

  return (
    <div className="min-h-screen bg-[#090d16] text-slate-100 flex flex-col lg:flex-row">
      <input
        ref={topImportRef}
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
        ref={topDbRestoreRef}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) {
            void handleSelectDatabaseFile(f);
            e.target.value = '';
          }
        }}
      />

      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:w-64 lg:flex-col lg:fixed lg:inset-y-0 border-r border-slate-800/80 bg-[#0c1220] z-30">
        <div className="h-14 px-5 flex items-center border-b border-slate-800/80">
          <span className="text-sm font-bold tracking-tight text-slate-100 whitespace-nowrap">
            SMART PLAYLIST AI STUDIO
          </span>
        </div>

        <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeModule === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveModule(item.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-xs font-medium transition-colors cursor-pointer ${
                  active
                    ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30'
                    : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/50 border border-transparent'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-800/80 text-[11px] text-slate-400 space-y-1 font-mono tabular-nums">
          <div className="flex justify-between">
            <span>Catálogo</span>
            <span className="text-slate-200">{tracks.length.toLocaleString()}</span>
          </div>
          <div className="flex justify-between">
            <span>Playlists</span>
            <span className="text-slate-200">{playlists.length}</span>
          </div>
          <div className="flex justify-between">
            <span>Tareas activas</span>
            <span className="text-slate-200">{activeSchedulesCount}</span>
          </div>
        </div>
      </aside>

      {/* Main Viewport */}
      <div className="flex-1 lg:pl-64 flex flex-col min-h-screen pb-20 lg:pb-6">
        {/* Top Bar */}
        <header className="sticky top-0 z-20 h-14 border-b border-slate-800/80 bg-[#090d16]/90 backdrop-blur-md px-4 lg:px-6 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileDrawerOpen(true)}
              className="lg:hidden p-2 -ml-2 rounded-lg text-slate-300 hover:bg-slate-800 min-w-[44px] min-h-[44px] flex items-center justify-center"
              aria-label="Abrir menú"
            >
              <Menu className="w-5 h-5" />
            </button>
            <h1 className="text-sm sm:text-base font-semibold text-slate-100 truncate">
              {activeNav.label}
            </h1>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setActiveModule('analyzer')}
              className={`hidden md:inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[11px] font-mono tabular-nums whitespace-nowrap shrink-0 cursor-pointer ${engineBadge.tone}`}
              title="Estado del motor de análisis DSP"
            >
              <Activity className="w-3 h-3" />
              {engineBadge.text}
            </button>

            <button
              type="button"
              onClick={() => setActiveModule('library')}
              className="hidden xl:inline-flex items-center rounded-md border border-slate-800 bg-slate-900/70 px-2.5 py-1 text-[11px] font-mono tabular-nums text-slate-300 hover:border-slate-700 whitespace-nowrap shrink-0 cursor-pointer"
              title="Canciones indexadas en catálogo"
            >
              {tracks.length.toLocaleString()} pistas
            </button>

            {activeSchedulesCount > 0 ? (
              schedulerGlobalDirStatus.permission === 'granted' ? (
                <button
                  type="button"
                  onClick={() => setActiveModule('scheduler')}
                  className="hidden lg:inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/15 px-2.5 py-1 text-[11px] font-mono tabular-nums text-emerald-200 hover:bg-emerald-500/25 whitespace-nowrap shrink-0 cursor-pointer"
                  title="Programador automático activo con escritura en disco autorizada"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  Auto ON
                  {nextScheduledOccurrence ? ` · Próx ${nextScheduledOccurrence.timeStr}` : ''}
                </button>
              ) : schedulerGlobalDirStatus.supported && schedulerGlobalDirStatus.hasHandle ? (
                <button
                  type="button"
                  onClick={() => void authorizeSchedulerDiskAndFlush()}
                  className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/50 bg-amber-500/20 px-2.5 py-1 text-[11px] font-semibold text-amber-200 hover:bg-amber-500/30 whitespace-nowrap shrink-0 cursor-pointer"
                  title="Haz clic para autorizar la escritura automática en tu carpeta de disco tras abrir el navegador"
                >
                  <CalendarClock className="w-3.5 h-3.5 text-amber-300" />
                  Autorizar disco
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setActiveModule('scheduler')}
                  className="hidden lg:inline-flex items-center gap-1.5 rounded-md border border-cyan-500/40 bg-cyan-500/15 px-2.5 py-1 text-[11px] font-mono tabular-nums text-cyan-200 hover:bg-cyan-500/25 whitespace-nowrap shrink-0 cursor-pointer"
                  title="Programador activo — abre Programador para vincular carpeta en disco"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-cyan-400 animate-pulse" />
                  {activeSchedulesCount} prog.
                  {nextScheduledOccurrence ? ` · ${nextScheduledOccurrence.timeStr}` : ''}
                </button>
              )
            ) : (
              <button
                type="button"
                onClick={() => setActiveModule('scheduler')}
                className="hidden xl:inline-flex items-center rounded-md border border-slate-800 bg-slate-900/70 px-2.5 py-1 text-[11px] font-mono tabular-nums text-slate-300 hover:border-slate-700 whitespace-nowrap shrink-0 cursor-pointer"
                title="Tareas programadas activas"
              >
                0 programadas
              </button>
            )}

            <PWAInstallButton />

            {/* Portable Complete Database Export / Open */}
            <div className="inline-flex items-center rounded-lg border border-emerald-500/35 bg-emerald-500/10 overflow-hidden shrink-0">
              <button
                type="button"
                disabled={isExportingDb}
                onClick={() => void handleExportFullDatabase()}
                className="inline-flex items-center gap-1.5 px-2.5 py-2 text-xs font-medium text-emerald-200 hover:bg-emerald-500/20 whitespace-nowrap cursor-pointer disabled:opacity-50"
                title="Exportar toda la base de datos portable (.json) para llevarla a otro navegador o PC"
              >
                <Database className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                <span className="hidden md:inline">Exportar BD</span>
                <Download className="w-3 h-3 md:hidden text-emerald-400" />
              </button>
              <div className="w-px h-5 bg-emerald-500/25" />
              <button
                type="button"
                onClick={() => topDbRestoreRef.current?.click()}
                className="inline-flex items-center gap-1.5 px-2.5 py-2 text-xs font-medium text-cyan-200 hover:bg-cyan-500/15 whitespace-nowrap cursor-pointer"
                title="Abrir / restaurar una base de datos completa (.json) guardada previamente"
              >
                <Upload className="w-3.5 h-3.5 text-cyan-400 shrink-0" />
                <span className="hidden md:inline">Abrir BD</span>
              </button>
            </div>

            <button
              type="button"
              onClick={handleQuickImport}
              className="hidden sm:inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 text-xs font-medium text-slate-100 hover:bg-slate-800 whitespace-nowrap shrink-0 cursor-pointer"
            >
              <FolderPlus className="w-3.5 h-3.5 text-cyan-400" />
              Importar carpeta
            </button>

            <button
              type="button"
              onClick={() => setActiveModule('settings')}
              className={`p-2 rounded-lg border transition-colors shrink-0 cursor-pointer ${
                activeModule === 'settings'
                  ? 'border-cyan-500/40 bg-cyan-500/15 text-cyan-300'
                  : 'border-slate-800 bg-slate-900/70 text-slate-300 hover:bg-slate-800'
              }`}
              title="Configuración del sistema"
              aria-label="Configuración"
            >
              <Settings className="w-4 h-4" />
            </button>
          </div>
        </header>

        {/* Active Module Content */}
        <main className="flex-1 p-4 lg:p-6 max-w-[1440px] w-full mx-auto">
          {isLoading ? (
            <div className="py-20 text-center text-sm text-slate-400 flex items-center justify-center gap-2">
              <Sparkles className="w-4 h-4 text-cyan-400 animate-spin" />
              Cargando catálogo IndexedDB...
            </div>
          ) : (
            <>
              {activeModule === 'dashboard' && <DashboardModule />}
              {activeModule === 'library' && <LibraryModule />}
              {activeModule === 'analyzer' && <AnalyzerModule />}
              {activeModule === 'generator' && <GeneratorModule />}
              {activeModule === 'scheduler' && <SchedulerModule />}
              {activeModule === 'radioboss' && <RadioBossModule />}
              {(activeModule === 'history' ||
                activeModule === 'stats' ||
                activeModule === 'settings') && <HistorySettingsModule />}
            </>
          )}
        </main>
      </div>

      {/* Mobile Bottom Navigation Bar (Thumb Zone) */}
      <nav className="lg:hidden fixed bottom-0 left-0 right-0 z-30 h-16 border-t border-slate-800 bg-[#0c1220]/95 backdrop-blur-md grid grid-cols-5 items-center">
        {[
          NAV_ITEMS[0], // Inicio
          NAV_ITEMS[1], // Biblioteca
          NAV_ITEMS[3], // Generador
          NAV_ITEMS[5], // RadioBOSS
        ].map((item) => {
          const Icon = item.icon;
          const active = activeModule === item.id;
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setActiveModule(item.id)}
              className={`flex flex-col items-center justify-center min-h-[44px] ${
                active ? 'text-cyan-400' : 'text-slate-400'
              }`}
            >
              <Icon className="w-5 h-5" />
              <span className="text-[10px] font-medium mt-1 truncate max-w-[64px]">
                {item.shortLabel}
              </span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setMobileDrawerOpen(true)}
          className={`flex flex-col items-center justify-center min-h-[44px] ${
            ['analyzer', 'scheduler', 'history', 'stats', 'settings'].includes(activeModule)
              ? 'text-cyan-400'
              : 'text-slate-400'
          }`}
        >
          <Menu className="w-5 h-5" />
          <span className="text-[10px] font-medium mt-1">Más</span>
        </button>
      </nav>

      {/* Mobile Drawer */}
      {mobileDrawerOpen && (
        <div
          className="lg:hidden fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex"
          onClick={() => setMobileDrawerOpen(false)}
        >
          <div
            className="w-72 bg-[#0c1220] border-r border-slate-800 h-full p-4 flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between pb-4 border-b border-slate-800">
              <span className="text-sm font-bold text-slate-100">SMART PLAYLIST AI</span>
              <button
                type="button"
                onClick={() => setMobileDrawerOpen(false)}
                className="p-2 text-slate-400 hover:text-white min-w-[44px] min-h-[44px] flex items-center justify-center"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="py-4 space-y-1 flex-1 overflow-y-auto">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const active = activeModule === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveModule(item.id);
                      setMobileDrawerOpen(false);
                    }}
                    className={`w-full flex items-center gap-3 px-3 py-3 rounded-lg text-sm font-medium ${
                      active
                        ? 'bg-cyan-500/15 text-cyan-300 border border-cyan-500/30'
                        : 'text-slate-300 hover:bg-slate-800/60'
                    }`}
                  >
                    <Icon className="w-4 h-4" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Non-intrusive Background Analysis Widget (visible on other views while running/paused) */}
      {(analysisProgress.status === 'running' || analysisProgress.status === 'paused') &&
        activeModule !== 'analyzer' && (
          <div className="fixed bottom-20 lg:bottom-5 left-4 lg:left-[17rem] z-40 w-[calc(100vw-2rem)] max-w-sm rounded-xl border border-violet-500/40 bg-[#0c1220]/95 backdrop-blur-md p-3 shadow-2xl space-y-2">
            <div className="flex items-center justify-between gap-2 text-xs">
              <button
                type="button"
                onClick={() => setActiveModule('analyzer')}
                className="font-semibold text-violet-300 hover:text-violet-200 truncate text-left cursor-pointer"
              >
                {analysisProgress.status === 'paused' ? 'Análisis pausado' : 'Analizando en 2º plano'}
                {analysisProgress.mode === 'fast-metadata-bpm' ? ' · Metadatos/BPM' : ' · DSP'}
              </button>
              <div className="flex items-center gap-1 shrink-0">
                {analysisProgress.status === 'running' ? (
                  <button
                    type="button"
                    onClick={pauseAnalysis}
                    className="p-1 rounded bg-slate-800 text-amber-300 hover:bg-slate-700 cursor-pointer"
                    title="Pausar análisis"
                  >
                    <Pause className="w-3.5 h-3.5" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={resumeAnalysis}
                    className="p-1 rounded bg-slate-800 text-emerald-300 hover:bg-slate-700 cursor-pointer"
                    title="Reanudar análisis"
                  >
                    <Play className="w-3.5 h-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={cancelAnalysis}
                  className="p-1 rounded bg-slate-800 text-rose-300 hover:bg-slate-700 cursor-pointer"
                  title="Cancelar análisis"
                >
                  <Square className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
            <div className="h-1.5 w-full rounded-full bg-slate-800 overflow-hidden">
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
            <div className="flex items-center justify-between text-[11px] font-mono tabular-nums text-slate-400 gap-2">
              <span className="truncate">{analysisProgress.currentTrackTitle || 'Procesando...'}</span>
              <span className="shrink-0 text-slate-200">
                {analysisProgress.completed}/{analysisProgress.total}
                {analysisProgress.tracksPerSec ? ` · ${analysisProgress.tracksPerSec}/s` : ''}
              </span>
            </div>
          </div>
        )}

      {/* Toast Feedback */}
      {toast && (
        <div
          className={`fixed bottom-20 lg:bottom-5 right-4 z-50 max-w-sm rounded-xl border px-4 py-3 text-xs font-medium shadow-2xl backdrop-blur-md ${
            toast.type === 'success'
              ? 'border-emerald-500/40 bg-emerald-950/90 text-emerald-100'
              : toast.type === 'warning'
              ? 'border-amber-500/40 bg-amber-950/90 text-amber-100'
              : toast.type === 'error'
              ? 'border-rose-500/40 bg-rose-950/90 text-rose-100'
              : 'border-cyan-500/40 bg-slate-900/95 text-slate-100'
          }`}
        >
          {toast.text}
        </div>
      )}

      <OfflineIndicator />

      <ConfirmDialog
        open={Boolean(pendingDbImport)}
        title="Abrir base de datos externa (.json)"
        message={
          pendingDbImport
            ? `El archivo contiene ${pendingDbImport.data.tracks?.length || 0} canciones, ${pendingDbImport.data.playlists?.length || 0} playlists y ${pendingDbImport.data.schedules?.length || 0} programaciones. Al cargarlo reemplazará la base de datos actual en este navegador.`
            : ''
        }
        confirmLabel="Sí, cargar base de datos"
        onConfirm={async () => {
          if (pendingDbImport) {
            const payload = pendingDbImport;
            setPendingDbImport(null);
            await applyDatabaseImport(payload);
          }
        }}
        onCancel={() => setPendingDbImport(null)}
      />
    </div>
  );
};

export default function App() {
  return (
    <StudioProvider>
      <StudioShell />
    </StudioProvider>
  );
}
