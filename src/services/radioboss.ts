import { addActivityLog, db, getSettings } from '../db/database';
import type {
  AppSettings,
  LinkedFolder,
  PathExportMode,
  PlaylistItem,
  SavedPlaylist,
  TrackRecord,
} from '../types/studio';
import { isCrossOriginSubframe } from './fileAccessService';

export interface ValidationIssue {
  line: number;
  severity: 'ERROR' | 'AVISO' | 'INFO';
  code: string;
  message: string;
  path?: string;
}

export interface PlaylistValidationReport {
  sourceName: string;
  format: 'm3u' | 'm3u8' | 'internal';
  validatedAt: string;
  radioBossCompatible: boolean;
  totalEntries: number;
  validEntries: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  detectedOrigins: string[];
  issues: ValidationIssue[];
}

export function normalizeWindowsFolderPath(input: string): string {
  let cleaned = (input || '').trim();
  if (!cleaned) return '';
  // Strip surrounding single or double quotes copied from Windows Explorer ("Copiar como ruta de acceso")
  if (
    (cleaned.startsWith('"') && cleaned.endsWith('"')) ||
    (cleaned.startsWith("'") && cleaned.endsWith("'"))
  ) {
    cleaned = cleaned.slice(1, -1).trim();
  }
  if (!cleaned) return '';

  // Preserve POSIX absolute paths (e.g. /Users/name/Music) when detected
  if (cleaned.startsWith('/') && !cleaned.startsWith('//')) {
    const collapsed = cleaned.replace(/\/+/g, '/');
    return collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : collapsed;
  }

  // Convert forward slashes to Windows backslashes
  const withBackslashes = cleaned.replace(/\//g, '\\');
  const isUnc = withBackslashes.startsWith('\\\\');
  const collapsed = isUnc
    ? '\\\\' + withBackslashes.slice(2).replace(/\\+/g, '\\')
    : withBackslashes.replace(/\\+/g, '\\');

  // Keep drive root trailing slash (e.g. D:\) cleanly while stripping trailing slashes on subfolders
  if (/^[a-zA-Z]:\\?$/.test(collapsed)) {
    return `${collapsed.slice(0, 2)}\\`;
  }
  return collapsed.replace(/\\+$/, '');
}

export function isPlaceholderWindowsPath(pathValue?: string): boolean {
  const norm = normalizeWindowsFolderPath(pathValue || '').toLowerCase();
  if (!norm) return true;
  return (
    norm.startsWith('d:\\radioboss\\') ||
    norm === 'd:\\radioboss' ||
    norm.startsWith('d:\\smart playlist ai\\biblioteca')
  );
}

export function isFolderPathPendingConfirmation(folder?: LinkedFolder | null): boolean {
  if (!folder) return true;
  if (folder.pathConfirmed) return false;
  return isPlaceholderWindowsPath(folder.windowsBasePath);
}

export function buildPlaylistOutputPathHint(settings: AppSettings): string {
  const root = normalizeWindowsFolderPath(settings.storageRootPath) || 'D:\\SMART PLAYLIST AI';
  const sub = (settings.defaultExportSubfolder || 'Playlists').replace(/[\\/]+/g, '\\').replace(/^\\+|\\+$/g, '');
  const now = new Date();
  const monthNames = [
    'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
  ];
  const parts = [root.replace(/\\+$/, '')];
  if (sub) parts.push(sub);
  if (settings.organizeByYear) parts.push(String(now.getFullYear()));
  if (settings.organizeByMonth) parts.push(monthNames[now.getMonth()]);
  return parts.join('\\');
}

function joinBaseAndRelative(baseInput: string, relativePath: string): string {
  const base = normalizeWindowsFolderPath(baseInput);
  const relClean = (relativePath || '').replace(/^[\\/]+/, '');
  if (!base) {
    return relClean.replace(/\//g, '\\');
  }

  // POSIX base path (e.g. /Users/alex/Music or /)
  if (base.startsWith('/') && !base.startsWith('\\\\')) {
    const cleanRelPosix = relClean.replace(/\\/g, '/');
    return base === '/' ? `/${cleanRelPosix}` : `${base.replace(/\/+$/, '')}/${cleanRelPosix}`;
  }

  const cleanRelWin = relClean.replace(/\//g, '\\');
  if (/^[a-zA-Z]:\\$/.test(base)) {
    return `${base}${cleanRelWin}`;
  }
  return `${base.replace(/\\+$/, '')}\\${cleanRelWin}`;
}

export function resolveRadioBossPath(
  item: Pick<PlaylistItem, 'folderId' | 'relativePath'> & { fileName?: string },
  pathMode: PathExportMode,
  foldersMap: Map<string, LinkedFolder>,
  settings: AppSettings
): string {
  const relSource = item.relativePath || item.fileName || '';
  const cleanRelWin = relSource.replace(/\//g, '\\').replace(/^\\+/, '');

  if (pathMode === 'relative') {
    return cleanRelWin;
  }

  if (pathMode === 'multi-drive') {
    const folder = foldersMap.get(item.folderId);
    const base = folder?.windowsBasePath || settings.globalFallbackPrefix || 'D:\\SMART PLAYLIST AI\\Biblioteca';
    return joinBaseAndRelative(base, relSource);
  }

  const globalBase = settings.globalFallbackPrefix || 'D:\\SMART PLAYLIST AI\\Biblioteca';
  return joinBaseAndRelative(globalBase, relSource);
}

export async function buildRadioBossM3UContent(
  playlist: SavedPlaylist,
  format: 'm3u8' | 'm3u',
  pathMode: PathExportMode
): Promise<{
  content: string;
  brokenItems: PlaylistItem[];
  exportedCount: number;
}> {
  const [folders, settings, allTracks] = await Promise.all([
    db.folders.toArray(),
    getSettings(),
    db.tracks.toArray(),
  ]);

  const foldersMap = new Map(folders.map((f) => [f.id, f]));
  const trackMap = new Map(allTracks.map((t) => [t.id, t]));

  const brokenItems: PlaylistItem[] = [];
  const validItems: PlaylistItem[] = [];

  for (const item of playlist.items) {
    const catalogTrack = trackMap.get(item.trackId);
    const isAccessible = catalogTrack ? catalogTrack.accessible : item.accessible;
    if (!isAccessible) {
      brokenItems.push(item);
    } else {
      validItems.push(item);
    }
  }

  const lines: string[] = ['#EXTM3U'];
  if (format === 'm3u8') {
    lines.push('#EXTENC:UTF-8');
  }

  for (const item of validItems) {
    const catalogTrack = trackMap.get(item.trackId);
    const effectiveItem = {
      folderId: catalogTrack?.folderId || item.folderId,
      relativePath: catalogTrack?.relativePath || item.relativePath || item.fileName,
      fileName: catalogTrack?.fileName || item.fileName,
    };
    const sec = Math.max(0, Math.round(item.duration));
    // Preserve accents, spaces, &, ', (), [], #, ñ, ü natively — NEVER encode %20
    const displayArtist = item.artist?.trim() || 'Desconocido';
    const displayTitle = item.title?.trim() || item.fileName;
    lines.push(`#EXTINF:${sec},${displayArtist} - ${displayTitle}`);
    lines.push(resolveRadioBossPath(effectiveItem, pathMode, foldersMap, settings));
  }

  // Strictly CRLF for Windows / RadioBOSS compatibility
  const content = lines.join('\r\n') + '\r\n';
  return { content, brokenItems, exportedCount: validItems.length };
}

export async function downloadTextFile(
  filename: string,
  content: string,
  mimeType = 'text/plain;charset=utf-8'
): Promise<boolean> {
  if (
    typeof window !== 'undefined' &&
    'showSaveFilePicker' in window &&
    !isCrossOriginSubframe()
  ) {
    try {
      const ext = filename.includes('.') ? filename.slice(filename.lastIndexOf('.')) : '.txt';
      const handle = await (
        window as unknown as {
          showSaveFilePicker: (opts: unknown) => Promise<FileSystemFileHandle>;
        }
      ).showSaveFilePicker({
        suggestedName: filename,
        types: [
          {
            description: 'Archivo compatible RadioBOSS / Texto',
            accept: { [mimeType.split(';')[0]]: [ext] },
          },
        ],
      });
      const writable = await handle.createWritable();
      await writable.write(content);
      await writable.close();
      return true;
    } catch (err) {
      // If user explicitly cancelled the save picker, do not force fallback download
      if (err instanceof DOMException && err.name === 'AbortError') {
        return false;
      }
    }
  }

  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || 'playlist.m3u8';
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  window.setTimeout(() => {
    try {
      URL.revokeObjectURL(url);
    } catch {
      // ignore
    }
  }, 2500);
  return true;
}

export async function validateExternalM3UContent(
  fileName: string,
  rawText: string
): Promise<PlaylistValidationReport> {
  const isM3u8 = fileName.toLowerCase().endsWith('.m3u8');
  const format: 'm3u' | 'm3u8' = isM3u8 ? 'm3u8' : 'm3u';
  const issues: ValidationIssue[] = [];
  const origins = new Set<string>();

  const tracks = await db.tracks.toArray();
  const trackByFilename = new Map<string, TrackRecord[]>();
  for (const t of tracks) {
    const key = t.fileName.toLowerCase();
    const list = trackByFilename.get(key) || [];
    list.push(t);
    trackByFilename.set(key, list);
  }

  // Strip UTF-8 BOM if present and warn for classic .m3u
  let cleanText = rawText;
  if (cleanText.charCodeAt(0) === 0xfeff) {
    cleanText = cleanText.slice(1);
    if (!isM3u8) {
      issues.push({
        line: 1,
        severity: 'AVISO',
        code: 'BOM_IN_M3U',
        message: 'El archivo .m3u clásico incluye BOM UTF-8; RadioBOSS recomienda extensión .m3u8 para UTF-8.',
      });
    }
  }

  const lines = cleanText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines[0]?.trim() !== '#EXTM3U') {
    issues.push({
      line: 1,
      severity: 'ERROR',
      code: 'MISSING_EXTM3U',
      message: 'Falta la cabecera obligatoria #EXTM3U en la línea 1.',
    });
  }

  let hasExtEncUtf8 = false;
  let totalEntries = 0;
  let validEntries = 0;
  let pendingExtInf: { line: number; duration: number; label: string } | null = null;
  const seenPaths = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    if (trimmed === '#EXTM3U') continue;
    if (trimmed.toUpperCase().startsWith('#EXTENC:')) {
      if (trimmed.toUpperCase().includes('UTF-8')) hasExtEncUtf8 = true;
      continue;
    }

    if (trimmed.startsWith('#EXTINF:')) {
      const body = trimmed.slice(8);
      const commaIdx = body.indexOf(',');
      if (commaIdx === -1) {
        issues.push({
          line: lineNum,
          severity: 'ERROR',
          code: 'MALFORMED_EXTINF',
          message: 'Directiva #EXTINF sin coma separadora de título.',
        });
        pendingExtInf = null;
      } else {
        const durStr = body.slice(0, commaIdx).trim();
        const dur = Number(durStr);
        const label = body.slice(commaIdx + 1).trim();
        if (!Number.isFinite(dur) || dur < -1) {
          issues.push({
            line: lineNum,
            severity: 'AVISO',
            code: 'INVALID_DURATION',
            message: `Duración #EXTINF inválida ("${durStr}").`,
          });
        }
        if (!label) {
          issues.push({
            line: lineNum,
            severity: 'AVISO',
            code: 'EMPTY_LABEL',
            message: 'Etiqueta de Artista - Título vacía en #EXTINF.',
          });
        }
        pendingExtInf = { line: lineNum, duration: dur, label };
      }
      continue;
    }

    if (trimmed.startsWith('#')) {
      continue; // Other M3U comment/directive
    }

    // Media path line
    totalEntries++;
    const pathLower = trimmed.toLowerCase();

    if (/^[a-zA-Z]:\\/.test(trimmed)) {
      origins.add(`Unidad Windows ${trimmed.slice(0, 2).toUpperCase()}`);
    } else if (trimmed.startsWith('\\\\')) {
      const share = trimmed.split('\\').filter(Boolean).slice(0, 2).join('\\');
      origins.add(`Red UNC \\\\${share}`);
    } else {
      origins.add('Ruta relativa');
    }

    if (/%20|%C3|%26/i.test(trimmed)) {
      issues.push({
        line: lineNum,
        severity: 'ERROR',
        code: 'URL_ENCODED_PATH',
        message: 'La ruta contiene codificación URL (%20/%C3), lo cual rompe lectura local en RadioBOSS.',
        path: trimmed,
      });
    }

    if (!isM3u8 && /[^\x20-\x7E]/.test(trimmed)) {
      issues.push({
        line: lineNum,
        severity: 'AVISO',
        code: 'UNICODE_IN_ANSI_M3U',
        message: 'Caracteres Unicode/acentos detectados en archivo .m3u clásico. Exporta como .m3u8 para RadioBOSS.',
        path: trimmed,
      });
    }

    if (seenPaths.has(pathLower)) {
      issues.push({
        line: lineNum,
        severity: 'AVISO',
        code: 'DUPLICATE_ENTRY',
        message: 'Ruta duplicada dentro de la misma playlist.',
        path: trimmed,
      });
    }
    seenPaths.add(pathLower);

    // Cross-check against indexed catalog by filename/relative path
    const baseName = trimmed.split(/[\\/]/).pop()?.toLowerCase() || '';
    const matches = trackByFilename.get(baseName);
    if (!matches || matches.length === 0) {
      issues.push({
        line: lineNum,
        severity: 'INFO',
        code: 'NOT_IN_BROWSER_CATALOG',
        message: 'Archivo no encontrado en el catálogo indexado actual del navegador (puede existir en disco Windows/RadioBOSS).',
        path: trimmed,
      });
      validEntries++;
    } else if (matches.every((m) => !m.accessible)) {
      issues.push({
        line: lineNum,
        severity: 'ERROR',
        code: 'INACCESSIBLE_FILE',
        message: 'El archivo figura como inaccesible o eliminado en el último escaneo del catálogo.',
        path: trimmed,
      });
    } else {
      validEntries++;
    }

    if (!pendingExtInf) {
      issues.push({
        line: lineNum,
        severity: 'AVISO',
        code: 'MISSING_EXTINF',
        message: 'Pista sin directiva #EXTINF previa.',
        path: trimmed,
      });
    }
    pendingExtInf = null;
  }

  if (isM3u8 && !hasExtEncUtf8) {
    issues.push({
      line: 2,
      severity: 'INFO',
      code: 'NO_EXTENC_UTF8',
      message: 'Falta directiva recomendada #EXTENC:UTF-8 (aunque el archivo sea .m3u8).',
    });
  }

  if (totalEntries === 0) {
    issues.push({
      line: 1,
      severity: 'ERROR',
      code: 'EMPTY_PLAYLIST',
      message: 'La playlist no contiene rutas de audio válidas.',
    });
  }

  const errorCount = issues.filter((i) => i.severity === 'ERROR').length;
  const warningCount = issues.filter((i) => i.severity === 'AVISO').length;
  const infoCount = issues.filter((i) => i.severity === 'INFO').length;

  await addActivityLog(
    'validator',
    errorCount > 0 ? 'error' : warningCount > 0 ? 'warning' : 'success',
    `Validación de "${fileName}"`,
    `${totalEntries} pistas · ${errorCount} errores · ${warningCount} avisos`
  );

  return {
    sourceName: fileName,
    format,
    validatedAt: new Date().toISOString(),
    radioBossCompatible: errorCount === 0,
    totalEntries,
    validEntries,
    errorCount,
    warningCount,
    infoCount,
    detectedOrigins: Array.from(origins),
    issues,
  };
}

export async function validateSavedPlaylist(
  playlist: SavedPlaylist,
  format: 'm3u8' | 'm3u',
  pathMode: PathExportMode
): Promise<PlaylistValidationReport> {
  const { content } = await buildRadioBossM3UContent(playlist, format, pathMode);
  const report = await validateExternalM3UContent(`${playlist.name}.${format}`, content);

  const [allTracks, folders, settings] = await Promise.all([
    db.tracks.toArray(),
    db.folders.toArray(),
    getSettings(),
  ]);

  const trackMap = new Map(allTracks.map((t) => [t.id, t]));
  const foldersMap = new Map(folders.map((f) => [f.id, f]));

  if (pathMode === 'multi-drive') {
    const usedFolderIds = new Set(
      playlist.items.map((it) => trackMap.get(it.trackId)?.folderId || it.folderId)
    );
    for (const fid of usedFolderIds) {
      const folder = foldersMap.get(fid);
      if (isFolderPathPendingConfirmation(folder)) {
        report.issues.unshift({
          line: 0,
          severity: 'AVISO',
          code: 'PLACEHOLDER_WINDOWS_PATH',
          message: `La carpeta "${folder?.name || fid}" usa la ruta genérica "${folder?.windowsBasePath || 'D:\\RadioBOSS\\...'}". Configura su ruta real en disco o exporta con "Rutas relativas" dentro de esa carpeta.`,
          path: folder?.windowsBasePath,
        });
        report.warningCount++;
      }
    }
  } else if (pathMode === 'absolute' && isPlaceholderWindowsPath(settings.globalFallbackPrefix)) {
    report.issues.unshift({
      line: 0,
      severity: 'AVISO',
      code: 'PLACEHOLDER_GLOBAL_PREFIX',
      message: `El prefijo global "${settings.globalFallbackPrefix}" es genérico. Ajusta la ruta real de tu biblioteca en disco o usa modo "Multi-unidad" / "Rutas relativas".`,
      path: settings.globalFallbackPrefix,
    });
    report.warningCount++;
  }

  // Also explicitly flag any broken items that buildRadioBossM3UContent skipped
  const broken = playlist.items.filter((it) => {
    const t = trackMap.get(it.trackId);
    return t ? !t.accessible : !it.accessible;
  });

  for (const b of broken) {
    report.issues.unshift({
      line: 0,
      severity: 'ERROR',
      code: 'BROKEN_REFERENCE',
      message: `Pista inaccesible excluida de exportación: ${b.artist} - ${b.title}`,
      path: b.relativePath,
    });
    report.errorCount++;
    report.radioBossCompatible = false;
  }

  return report;
}

export function formatValidationReportTxt(report: PlaylistValidationReport): string {
  const lines: string[] = [
    '====================================================================',
    'SMART PLAYLIST AI STUDIO — INFORME DE VALIDACIÓN RADIOBOSS',
    '====================================================================',
    `Origen evaluado      : ${report.sourceName}`,
    `Formato              : ${report.format.toUpperCase()}`,
    `Fecha de validación  : ${new Date(report.validatedAt).toLocaleString()}`,
    `Compatible RadioBOSS : ${report.radioBossCompatible ? 'SÍ (APROBADO)' : 'NO (REQUIERE CORRECCIÓN)'}`,
    `Total de entradas    : ${report.totalEntries}`,
    `Entradas válidas     : ${report.validEntries}`,
    `Errores              : ${report.errorCount}`,
    `Avisos               : ${report.warningCount}`,
    `Informativos         : ${report.infoCount}`,
    `Orígenes detectados  : ${report.detectedOrigins.join(', ') || 'Ninguno'}`,
    '',
    'DETALLE DE INCIDENCIAS:',
    '--------------------------------------------------------------------',
  ];

  if (report.issues.length === 0) {
    lines.push('Sin incidencias detectadas. La playlist cumple con el estándar RadioBOSS.');
  } else {
    for (const iss of report.issues) {
      lines.push(
        `[${iss.severity}] Línea ${iss.line} (${iss.code}): ${iss.message}${iss.path ? `\r\n    Ruta: ${iss.path}` : ''}`
      );
    }
  }

  return lines.join('\r\n') + '\r\n';
}
