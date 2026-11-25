import type { LinkedFolder, ScheduledTask, TrackRecord } from '../types/studio';

export interface GenreColorTheme {
  id: string;
  label: string;
  dotClass: string;
  cardClass: string;
  badgeClass: string;
  legendClass: string;
}

export const GENRE_COLOR_PALETTE: GenreColorTheme[] = [
  {
    id: 'cyan',
    label: 'Cian',
    dotClass: 'bg-cyan-400',
    cardClass:
      'border-cyan-500/45 border-l-4 border-l-cyan-400 bg-cyan-500/12 text-cyan-50 hover:bg-cyan-500/20',
    badgeClass: 'border-cyan-500/40 bg-cyan-500/20 text-cyan-200',
    legendClass: 'border-cyan-500/45 bg-cyan-500/15 text-cyan-200',
  },
  {
    id: 'rose',
    label: 'Rojo',
    dotClass: 'bg-rose-400',
    cardClass:
      'border-rose-500/45 border-l-4 border-l-rose-400 bg-rose-500/12 text-rose-50 hover:bg-rose-500/20',
    badgeClass: 'border-rose-500/40 bg-rose-500/20 text-rose-200',
    legendClass: 'border-rose-500/45 bg-rose-500/15 text-rose-200',
  },
  {
    id: 'amber',
    label: 'Ámbar',
    dotClass: 'bg-amber-400',
    cardClass:
      'border-amber-500/45 border-l-4 border-l-amber-400 bg-amber-500/12 text-amber-50 hover:bg-amber-500/20',
    badgeClass: 'border-amber-500/40 bg-amber-500/20 text-amber-200',
    legendClass: 'border-amber-500/45 bg-amber-500/15 text-amber-200',
  },
  {
    id: 'emerald',
    label: 'Esmeralda',
    dotClass: 'bg-emerald-400',
    cardClass:
      'border-emerald-500/45 border-l-4 border-l-emerald-400 bg-emerald-500/12 text-emerald-50 hover:bg-emerald-500/20',
    badgeClass: 'border-emerald-500/40 bg-emerald-500/20 text-emerald-200',
    legendClass: 'border-emerald-500/45 bg-emerald-500/15 text-emerald-200',
  },
  {
    id: 'violet',
    label: 'Violeta',
    dotClass: 'bg-violet-400',
    cardClass:
      'border-violet-500/45 border-l-4 border-l-violet-400 bg-violet-500/12 text-violet-50 hover:bg-violet-500/20',
    badgeClass: 'border-violet-500/40 bg-violet-500/20 text-violet-200',
    legendClass: 'border-violet-500/45 bg-violet-500/15 text-violet-200',
  },
  {
    id: 'pink',
    label: 'Rosa',
    dotClass: 'bg-pink-400',
    cardClass:
      'border-pink-500/45 border-l-4 border-l-pink-400 bg-pink-500/12 text-pink-50 hover:bg-pink-500/20',
    badgeClass: 'border-pink-500/40 bg-pink-500/20 text-pink-200',
    legendClass: 'border-pink-500/45 bg-pink-500/15 text-pink-200',
  },
  {
    id: 'orange',
    label: 'Naranja',
    dotClass: 'bg-orange-400',
    cardClass:
      'border-orange-500/45 border-l-4 border-l-orange-400 bg-orange-500/12 text-orange-50 hover:bg-orange-500/20',
    badgeClass: 'border-orange-500/40 bg-orange-500/20 text-orange-200',
    legendClass: 'border-orange-500/45 bg-orange-500/15 text-orange-200',
  },
  {
    id: 'blue',
    label: 'Azul',
    dotClass: 'bg-blue-400',
    cardClass:
      'border-blue-500/45 border-l-4 border-l-blue-400 bg-blue-500/12 text-blue-50 hover:bg-blue-500/20',
    badgeClass: 'border-blue-500/40 bg-blue-500/20 text-blue-200',
    legendClass: 'border-blue-500/45 bg-blue-500/15 text-blue-200',
  },
  {
    id: 'lime',
    label: 'Lima',
    dotClass: 'bg-lime-400',
    cardClass:
      'border-lime-500/45 border-l-4 border-l-lime-400 bg-lime-500/12 text-lime-50 hover:bg-lime-500/20',
    badgeClass: 'border-lime-500/40 bg-lime-500/20 text-lime-200',
    legendClass: 'border-lime-500/45 bg-lime-500/15 text-lime-200',
  },
  {
    id: 'fuchsia',
    label: 'Fucsia',
    dotClass: 'bg-fuchsia-400',
    cardClass:
      'border-fuchsia-500/45 border-l-4 border-l-fuchsia-400 bg-fuchsia-500/12 text-fuchsia-50 hover:bg-fuchsia-500/20',
    badgeClass: 'border-fuchsia-500/40 bg-fuchsia-500/20 text-fuchsia-200',
    legendClass: 'border-fuchsia-500/45 bg-fuchsia-500/15 text-fuchsia-200',
  },
  {
    id: 'teal',
    label: 'Turquesa',
    dotClass: 'bg-teal-400',
    cardClass:
      'border-teal-500/45 border-l-4 border-l-teal-400 bg-teal-500/12 text-teal-50 hover:bg-teal-500/20',
    badgeClass: 'border-teal-500/40 bg-teal-500/20 text-teal-200',
    legendClass: 'border-teal-500/45 bg-teal-500/15 text-teal-200',
  },
  {
    id: 'indigo',
    label: 'Índigo',
    dotClass: 'bg-indigo-400',
    cardClass:
      'border-indigo-500/45 border-l-4 border-l-indigo-400 bg-indigo-500/12 text-indigo-50 hover:bg-indigo-500/20',
    badgeClass: 'border-indigo-500/40 bg-indigo-500/20 text-indigo-200',
    legendClass: 'border-indigo-500/45 bg-indigo-500/15 text-indigo-200',
  },
];

const NEUTRAL_THEME: GenreColorTheme = {
  id: 'slate',
  label: 'Neutro',
  dotClass: 'bg-slate-400',
  cardClass:
    'border-slate-700 border-l-4 border-l-slate-400 bg-slate-800/40 text-slate-100 hover:bg-slate-800/70',
  badgeClass: 'border-slate-600 bg-slate-800 text-slate-300',
  legendClass: 'border-slate-600 bg-slate-800/70 text-slate-200',
};

const GENRE_COLORS_STORAGE_KEY = 'smartplay_genre_colors_v1';

export function loadCustomGenreColors(): Record<string, string> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(GENRE_COLORS_STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string>) : {};
  } catch {
    return {};
  }
}

export function saveCustomGenreColors(map: Record<string, string>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(GENRE_COLORS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // ignore storage quota errors
  }
}

function hashString(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return Math.abs(h);
}

export function normalizeGenreKey(genre: string): string {
  return (genre || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function getGenreColorTheme(
  genre: string,
  customMap?: Record<string, string>
): GenreColorTheme {
  const key = normalizeGenreKey(genre);
  if (!key) return NEUTRAL_THEME;

  const customId = customMap?.[key];
  if (customId) {
    const found = GENRE_COLOR_PALETTE.find((p) => p.id === customId);
    if (found) return found;
  }

  // Semantic defaults for popular radio genres
  if (/(rock|metal|punk|grunge|alternat|indie)/.test(key)) return GENRE_COLOR_PALETTE[1]; // rose
  if (/(salsa|cumbia|merengue|tropical|bachata|vallenato|son)/.test(key)) return GENRE_COLOR_PALETTE[2]; // amber
  if (/(reggaeton|urbano|trap|hip.?hop|rap)/.test(key)) return GENRE_COLOR_PALETTE[8]; // lime
  if (/(pop|synth|disco|funk)/.test(key)) return GENRE_COLOR_PALETTE[0]; // cyan
  if (/(dance|house|techno|electr|edm|trance|club)/.test(key)) return GENRE_COLOR_PALETTE[4]; // violet
  if (/(romant|balada|bolero|suave|lenta|soft)/.test(key)) return GENRE_COLOR_PALETTE[5]; // pink
  if (/(latino|latin|mariachi|ranchera|regional)/.test(key)) return GENRE_COLOR_PALETTE[6]; // orange
  if (/(jazz|blues|soul|r&b|bossa|chill)/.test(key)) return GENRE_COLOR_PALETTE[10]; // teal
  if (/(clasic|retro|80s|90s|70s|oldies)/.test(key)) return GENRE_COLOR_PALETTE[11]; // indigo
  if (/(variado|mix|general)/.test(key)) return GENRE_COLOR_PALETTE[3]; // emerald

  const idx = hashString(key) % GENRE_COLOR_PALETTE.length;
  return GENRE_COLOR_PALETTE[idx];
}

export function resolveTaskVisualGenre(
  task: ScheduledTask,
  folders: LinkedFolder[],
  tracks: TrackRecord[]
): {
  primaryGenre: string;
  allGenres: string[];
} {
  if (task.allowedGenres && task.allowedGenres.length > 0) {
    return {
      primaryGenre: task.allowedGenres[0],
      allGenres: task.allowedGenres,
    };
  }

  if (task.sourceScope === 'folder' && task.sourceFolderId) {
    const folderTracks = tracks.filter(
      (t) => t.folderId === task.sourceFolderId && !t.isSpotFolder
    );
    const counts = new Map<string, number>();
    for (const t of folderTracks) {
      if (t.genre && t.genre !== 'Desconocido') {
        counts.set(t.genre, (counts.get(t.genre) || 0) + 1);
      }
    }
    const sorted = Array.from(counts.entries()).sort((a, b) => b[1] - a[1]);
    if (sorted.length > 0 && sorted[0][1] >= Math.max(1, folderTracks.length * 0.35)) {
      return {
        primaryGenre: sorted[0][0],
        allGenres: sorted.slice(0, 2).map(([g]) => g),
      };
    }
    const folderName = folders.find((f) => f.id === task.sourceFolderId)?.name;
    if (folderName) {
      return {
        primaryGenre: folderName,
        allGenres: [folderName],
      };
    }
  }

  if (task.mood) {
    return {
      primaryGenre: task.mood,
      allGenres: [task.mood],
    };
  }

  return {
    primaryGenre: 'Mix Variado',
    allGenres: ['Mix Variado'],
  };
}
