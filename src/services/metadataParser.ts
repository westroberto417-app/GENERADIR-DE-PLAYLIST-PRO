import { parseBlob } from 'music-metadata';
import type { DataOrigin, TrackOrigins, TrackRecord } from '../types/studio';

export function deriveDecade(year: number | null): string {
  if (!year || year < 1920 || year > 2099) return 'Desconocida';
  const dec = Math.floor(year / 10) * 10;
  return `${dec}s`;
}

export function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

export function computeDuplicateKey(
  title: string,
  artist: string,
  duration: number,
  size: number
): string {
  const normTitle = normalizeText(title);
  const normArtist = normalizeText(artist);
  const roundedDur = Math.round(duration);
  const sizeBucket = Math.round(size / 4096);
  if (normArtist && normTitle && normArtist !== 'desconocido') {
    return `${normArtist}::${normTitle}::${roundedDur}`;
  }
  return `file::${normTitle}::${roundedDur}::${sizeBucket}`;
}

function parseFromFilename(fileName: string, relativePath: string): {
  title: string;
  artist: string;
  album: string;
  year: number | null;
  trackNumber: number | null;
} {
  const baseName = fileName.replace(/\.[^/.]+$/, '').trim();
  const trackNumMatch = baseName.match(/^(\d{1,3})[\s._-]+/);
  const trackNumber = trackNumMatch ? Number(trackNumMatch[1]) : null;
  const cleaned = baseName.replace(/^\d{1,3}[\s._-]+/, '').trim();
  const dashIdx = cleaned.indexOf(' - ');
  let artist = 'Desconocido';
  let title = cleaned || baseName;

  if (dashIdx > 0 && dashIdx < cleaned.length - 3) {
    artist = cleaned.slice(0, dashIdx).trim();
    title = cleaned.slice(dashIdx + 3).trim();
  } else {
    const parts = relativePath.split('/').filter(Boolean);
    if (parts.length >= 3) {
      artist = parts[parts.length - 3];
    }
  }

  let album = 'Sin álbum';
  const parts = relativePath.split('/').filter(Boolean);
  if (parts.length >= 2) {
    album = parts[parts.length - 2];
  }

  const yearMatch = (relativePath + ' ' + fileName).match(/\b(19[5-9]\d|20[0-2]\d)\b/);
  const year = yearMatch ? Number(yearMatch[1]) : null;

  return { title, artist, album, year, trackNumber };
}

const GENRE_PATH_MAP: Array<[RegExp, string]> = [
  [/\breggaet[oó]n\b/i, 'Reggaeton'],
  [/\b(house|deep\s*house|tech\s*house|progressive\s*house)\b/i, 'House'],
  [/\btechno\b/i, 'Techno'],
  [/\btrance\b/i, 'Trance'],
  [/\b(dance|eurodance|edm|club)\b/i, 'Dance'],
  [/\b(electr[oó]nica?|electro|synthpop|nu\s*disco)\b/i, 'Electronic'],
  [/\bdisco\b/i, 'Disco'],
  [/\b(latino|latin|urbano)\b/i, 'Latino'],
  [/\bsalsa\b/i, 'Salsa'],
  [/\bcumbia\b/i, 'Cumbia'],
  [/\bmerengue\b/i, 'Merengue'],
  [/\bbachata\b/i, 'Bachata'],
  [/\btropical\b/i, 'Tropical'],
  [/\b(rock|alternative|grunge|punk|indie)\b/i, 'Rock'],
  [/\bmetal\b/i, 'Metal'],
  [/\b(pop|80s\s*pop|90s\s*pop)\b/i, 'Pop'],
  [/\bjazz\b/i, 'Jazz'],
  [/\bblues\b/i, 'Blues'],
  [/\b(hip[\s_-]*hop|rap|trap)\b/i, 'Hip Hop'],
  [/\b(r&b|rnb|soul|funk)\b/i, 'R&B'],
  [/\breggae\b/i, 'Reggae'],
  [/\b(cl[aá]sicos?|classics|oldies|retro)\b/i, 'Clásicos'],
  [/\b(balada|rom[aá]ntic[ao]s?)\b/i, 'Balada'],
];

function inferGenreFromPath(folderName: string, relativePath: string): string | null {
  const haystack = `${folderName} ${relativePath}`.replace(/[_/\\-]+/g, ' ');
  for (const [pattern, label] of GENRE_PATH_MAP) {
    if (pattern.test(haystack)) {
      return label;
    }
  }
  return null;
}

const DURATION_PROBE_MAX_CONCURRENT = 2;
let activeDurationProbes = 0;
const durationProbeWaiters: Array<() => void> = [];

async function acquireDurationProbeSlot(): Promise<void> {
  if (activeDurationProbes < DURATION_PROBE_MAX_CONCURRENT) {
    activeDurationProbes++;
    return;
  }
  await new Promise<void>((resolve) => {
    durationProbeWaiters.push(resolve);
  });
  activeDurationProbes++;
}

function releaseDurationProbeSlot(): void {
  activeDurationProbes = Math.max(0, activeDurationProbes - 1);
  const next = durationProbeWaiters.shift();
  if (next) next();
}

function sanitizeFiniteInt(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? Math.round(n) : fallback;
}

async function parseBlobWithTimeout(file: File, timeoutMs = 4500) {
  let timer: number | undefined;
  try {
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = window.setTimeout(() => reject(new Error('parseBlob timeout')), timeoutMs);
    });
    return await Promise.race([
      parseBlob(file, { duration: true, skipCovers: true }),
      timeoutPromise,
    ]);
  } finally {
    if (timer !== undefined) {
      window.clearTimeout(timer);
    }
  }
}

export async function extractTrackMetadata(
  file: File,
  folderId: string,
  folderName: string,
  relativePath: string,
  isSpotFolder: boolean
): Promise<TrackRecord> {
  const extMatch = file.name.match(/\.[^/.]+$/);
  const extension = extMatch ? extMatch[0].toLowerCase() : '';
  const fallback = parseFromFilename(file.name, relativePath);
  const pathGenre = inferGenreFromPath(folderName, relativePath);

  let title = fallback.title || file.name;
  let artist = fallback.artist || 'Desconocido';
  let album = fallback.album || 'Sin álbum';
  let genre = pathGenre || 'Desconocido';
  let year: number | null =
    fallback.year && Number.isFinite(fallback.year) ? fallback.year : null;
  let trackNumber: number | null =
    fallback.trackNumber && Number.isFinite(fallback.trackNumber) ? fallback.trackNumber : null;
  let duration = 0;
  let bitrate: number | null = null;
  let sampleRate: number | null = null;
  let bpm: number | null = null;

  const origins: TrackOrigins = {
    title: fallback.artist !== 'Desconocido' ? 'CARPETA' : 'DESCONOCIDO',
    artist: fallback.artist !== 'Desconocido' ? 'CARPETA' : 'DESCONOCIDO',
    genre: pathGenre ? 'CARPETA' : 'DESCONOCIDO',
    year: fallback.year ? 'CARPETA' : 'DESCONOCIDO',
    bpm: 'DESCONOCIDO',
    energy: 'DESCONOCIDO',
    mood: 'DESCONOCIDO',
  };

  try {
    const metadata =
      typeof window !== 'undefined'
        ? await parseBlobWithTimeout(file, 4500)
        : await parseBlob(file, { duration: true, skipCovers: true });
    const { common, format } = metadata;

    if (common.title?.trim()) {
      title = common.title.trim();
      origins.title = 'ETIQUETA';
    }
    if (common.artist?.trim()) {
      artist = common.artist.trim();
      origins.artist = 'ETIQUETA';
    } else if (common.albumartist?.trim()) {
      artist = common.albumartist.trim();
      origins.artist = 'ETIQUETA';
    }
    if (common.album?.trim()) {
      album = common.album.trim();
    }
    if (common.track?.no && Number.isFinite(common.track.no) && common.track.no > 0) {
      trackNumber = Math.round(common.track.no);
    }
    if (common.genre && common.genre.length > 0 && common.genre[0]?.trim()) {
      genre = common.genre[0].trim();
      origins.genre = 'ETIQUETA';
    }
    if (common.year && Number.isFinite(common.year) && common.year >= 1920 && common.year <= 2099) {
      year = Math.round(common.year);
      origins.year = 'ETIQUETA';
    }
    if (common.bpm && Number.isFinite(common.bpm) && common.bpm > 30 && common.bpm < 240) {
      bpm = Math.round(common.bpm);
      origins.bpm = 'ETIQUETA';
    }

    if (format.duration && Number.isFinite(format.duration) && format.duration > 0) {
      duration = Math.round(format.duration);
    }
    if (format.bitrate && Number.isFinite(format.bitrate) && format.bitrate > 0) {
      bitrate = Math.round(format.bitrate / 1000);
    }
    if (format.sampleRate && Number.isFinite(format.sampleRate) && format.sampleRate > 0) {
      sampleRate = Math.round(format.sampleRate);
    }
  } catch {
    // Graceful fallback when container tags are unreadable or unsupported
  }

  if (duration === 0 && file.size > 0) {
    duration = await probeAudioDuration(file);
  }

  const now = Date.now();
  const safeSize = sanitizeFiniteInt(file.size, 0);
  const safeLastModified = sanitizeFiniteInt(file.lastModified, now);
  const safeDuration = Math.max(0, sanitizeFiniteInt(duration, 0));
  const id = `${folderId}::${relativePath}`;
  const decade = deriveDecade(year);

  return {
    id,
    folderId,
    folderName,
    relativePath,
    fileName: file.name,
    extension,
    size: safeSize,
    lastModified: safeLastModified,
    trackNumber,
    title,
    artist,
    album,
    genre,
    year,
    decade,
    duration: safeDuration,
    bitrate,
    sampleRate,
    bpm,
    bpmConfidence: bpm ? 100 : null,
    energyRmsDb: null,
    energyScore: null,
    energyLevel: null,
    intensity: null,
    danceability: null,
    danceabilityLabel: null,
    valence: null,
    valenceLabel: null,
    mood: 'Desconocido',
    origins,
    analysisStatus: 'pending',
    accessible: true,
    lastVerifiedAt: now,
    duplicateKey: computeDuplicateKey(title, artist, safeDuration, safeSize),
    isSpotFolder,
    createdAt: now,
    updatedAt: now,
  };
}

async function probeAudioDuration(file: File): Promise<number> {
  if (
    typeof window === 'undefined' ||
    typeof Audio === 'undefined' ||
    typeof URL === 'undefined' ||
    typeof URL.createObjectURL !== 'function'
  ) {
    return 0;
  }

  await acquireDurationProbeSlot();
  try {
    return await new Promise<number>((resolve) => {
      let url = '';
      let audio: HTMLAudioElement | null = null;
      let settled = false;

      const cleanup = () => {
        if (audio) {
          audio.onloadedmetadata = null;
          audio.onerror = null;
          audio.removeAttribute('src');
          try {
            audio.load();
          } catch {
            // ignore
          }
          audio = null;
        }
        if (url) {
          try {
            URL.revokeObjectURL(url);
          } catch {
            // ignore
          }
          url = '';
        }
      };

      const finish = (dur: number) => {
        if (settled) return;
        settled = true;
        window.clearTimeout(timer);
        cleanup();
        resolve(Number.isFinite(dur) && dur > 0 ? Math.round(dur) : 0);
      };

      const timer = window.setTimeout(() => finish(0), 1200);

      try {
        url = URL.createObjectURL(file);
        audio = new Audio();
        audio.preload = 'metadata';
        audio.onloadedmetadata = () => finish(audio?.duration || 0);
        audio.onerror = () => finish(0);
        audio.src = url;
      } catch {
        finish(0);
      }
    });
  } finally {
    releaseDurationProbeSlot();
  }
}

export function formatOriginLabel(origin: DataOrigin): string {
  return origin;
}
