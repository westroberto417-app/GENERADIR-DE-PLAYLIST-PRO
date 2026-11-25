import React, { useState } from 'react';
import { Download, MonitorDown, Smartphone, WifiOff, X } from 'lucide-react';
import { useOnlineStatus, usePWAInstall } from '../hooks/usePWAInstall';
import { isCrossOriginSubframe } from '../services/fileAccessService';

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);
  const [showDesktopGuide, setShowDesktopGuide] = useState(false);

  if (isInstalled) {
    return null;
  }

  if (isInstallable) {
    return (
      <button
        type="button"
        onClick={install}
        className="inline-flex items-center gap-2 rounded-lg bg-cyan-500 px-3.5 py-2 text-xs font-semibold text-slate-950 hover:bg-cyan-400 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
      >
        <Download className="w-3.5 h-3.5" />
        Instalar App (PWA)
      </button>
    );
  }

  if (isIOS) {
    return (
      <>
        <button
          type="button"
          onClick={() => setShowIOSGuide(true)}
          className="inline-flex items-center gap-2 rounded-lg border border-slate-700 bg-slate-800/80 px-3 py-2 text-xs font-medium text-slate-200 hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        >
          <Smartphone className="w-3.5 h-3.5 text-cyan-400" />
          Instalar en iOS
        </button>

        {showIOSGuide && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
            <div className="w-full max-w-sm rounded-2xl border border-slate-800 bg-[#101726] p-6">
              <div className="flex items-center justify-between">
                <h3 className="text-base font-semibold text-slate-100">
                  Instalar en iPhone / iPad
                </h3>
                <button
                  type="button"
                  onClick={() => setShowIOSGuide(false)}
                  className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800"
                  aria-label="Cerrar guía iOS"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              <ol className="mt-4 space-y-2.5 text-sm text-slate-300 list-decimal list-inside">
                <li>Pulsa el botón <strong>Compartir</strong> en la barra inferior de Safari.</li>
                <li>Desplázate hacia abajo y selecciona <strong>Añadir a pantalla de inicio</strong>.</li>
                <li>Confirma tocando <strong>Añadir</strong> para abrir la app offline.</li>
              </ol>
              <button
                type="button"
                onClick={() => setShowIOSGuide(false)}
                className="mt-5 w-full rounded-lg bg-cyan-500 py-2.5 text-sm font-semibold text-slate-950 hover:bg-cyan-400 transition-colors"
              >
                Entendido
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  const inIframe = isCrossOriginSubframe();

  return (
    <>
      <button
        type="button"
        onClick={() => setShowDesktopGuide(true)}
        className="hidden sm:inline-flex items-center gap-1.5 rounded-lg border border-cyan-500/35 bg-cyan-500/10 px-3 py-2 text-xs font-medium text-cyan-200 hover:bg-cyan-500/20 transition-colors whitespace-nowrap shrink-0 cursor-pointer"
        title="Cómo instalar la app en Edge o Chrome"
      >
        <MonitorDown className="w-3.5 h-3.5 text-cyan-400" />
        Instalar en PC
      </button>

      {showDesktopGuide && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-md rounded-2xl border border-slate-800 bg-[#101726] p-6 space-y-3 text-xs">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-100">
                Instalar SMART PLAYLIST AI STUDIO en Chrome / Edge
              </h3>
              <button
                type="button"
                onClick={() => setShowDesktopGuide(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 cursor-pointer"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {inIframe ? (
              <p className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-amber-200">
                Estás viendo la app dentro de una vista previa embebida. Los navegadores solo permiten instalar una PWA cuando la abres directamente en su propia pestaña.
              </p>
            ) : (
              <p className="text-slate-300">
                Si no apareció el aviso automático de instalación, puedes instalarla directamente desde el menú del navegador:
              </p>
            )}

            <ol className="space-y-2 text-slate-300 list-decimal list-inside">
              <li>
                Asegúrate de tener abierta la app en su <strong>propia pestaña</strong> (no embebida ni en incógnito).
              </li>
              <li>
                En <strong>Edge</strong>: Menú <strong>(⋯) → Aplicaciones → Instalar este sitio como una aplicación</strong>.
              </li>
              <li>
                En <strong>Chrome</strong>: icono de instalar en la barra de direcciones o Menú <strong>(⋮) → Guardar y compartir → Instalar página como aplicación</strong>.
              </li>
            </ol>

            <button
              type="button"
              onClick={() => setShowDesktopGuide(false)}
              className="w-full rounded-lg bg-cyan-500 py-2 text-xs font-semibold text-slate-950 hover:bg-cyan-400 cursor-pointer"
            >
              Entendido
            </button>
          </div>
        </div>
      )}
    </>
  );
};

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();
  if (isOnline) return null;

  return (
    <div className="fixed bottom-20 lg:bottom-4 left-4 z-50 flex items-center gap-2 rounded-lg border border-emerald-500/40 bg-[#0c1220]/95 backdrop-blur-md px-3.5 py-2 text-xs font-medium text-emerald-200 shadow-xl">
      <WifiOff className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
      <span>Modo 100% Offline activo · Motor DSP, Agenda y RadioBOSS operativos</span>
    </div>
  );
};
