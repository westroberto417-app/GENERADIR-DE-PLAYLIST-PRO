export type DataOrigin = 'ETIQUETA' | 'ANÁLISIS PCM' | 'MANUAL' | 'CARPETA' | 'DESCONOCIDO';

export type AnalysisMode = 'fast-metadata-bpm' | 'full-dsp';

export type IntensityLevel = 'Muy suave' | 'Suave' | 'Media' | 'Alta' | 'Muy alta';

export type EnergyLevel = 'Muy baja' | 'Baja' | 'Media' | 'Alta' | 'Muy alta';

export type DanceabilityLabel = 'Baja' | 'Media' | 'Alta';

export type ValenceLabel = 'Alegre' | 'Neutral' | 'Melancólica';

export type ModuleId =
  | 'dashboard'
  | 'library'
  | 'analyzer'
  | 'generator'
  | 'scheduler'
  | 'radioboss'
  | 'history'
  | 'stats'
  | 'settings';

export type GenerationMode =
  | 'Aleatorio'
  | 'Por género'
  | 'Por década'
  | 'Por BPM'
  | 'Por intensidad'
  | 'Por ambiente'
  | 'Combinado'
  | 'Progresivo';

export type CurvePreset = 'Ascendente' | 'Pico central' | 'Descendente' | 'Onda radial' | 'Personalizada';

export type PathExportMode = 'relative' | 'absolute' | 'multi-drive';

export type SpotRotationMode = 'sequential' | 'random-no-repeat';

export interface TrackOrigins {
  title: DataOrigin;
  artist: DataOrigin;
  genre: DataOrigin;
  year: DataOrigin;
  bpm: DataOrigin;
  energy: DataOrigin;
  mood: DataOrigin;
}

export interface TrackRecord {
  id: string;
  folderId: string;
  folderName: string;
  relativePath: string;
  fileName: string;
  extension: string;
  size: number;
  lastModified: number;
  trackNumber: number | null;
  title: string;
  artist: string;
  album: string;
  genre: string;
  year: number | null;
  decade: string;
  duration: number;
  bitrate: number | null;
  sampleRate: number | null;
  bpm: number | null;
  bpmConfidence: number | null;
  energyRmsDb: number | null;
  energyScore: number | null;
  energyLevel: EnergyLevel | null;
  intensity: IntensityLevel | null;
  danceability: number | null;
  danceabilityLabel: DanceabilityLabel | null;
  valence: number | null;
  valenceLabel: ValenceLabel | null;
  mood: string;
  origins: TrackOrigins;
  analysisStatus: 'pending' | 'analyzed' | 'error';
  analysisError?: string;
  analyzedAt?: number;
  analyzedFileSignature?: string;
  accessible: boolean;
  missingOnDisk?: boolean;
  lastVerifiedAt: number;
  duplicateKey: string;
  isSpotFolder: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface LinkedFolder {
  id: string;
  name: string;
  role: 'music' | 'spots';
  sourceType: 'fs-access' | 'file-input';
  windowsBasePath: string;
  pathConfirmed?: boolean;
  trackCount: number;
  lastScannedAt: number;
}

export interface FolderHandleRecord {
  folderId: string;
  handle: FileSystemDirectoryHandle;
}

export interface PlaylistItem {
  uid: string;
  trackId: string;
  isSpot: boolean;
  title: string;
  artist: string;
  duration: number;
  bpm: number | null;
  intensity: IntensityLevel | null;
  genre: string;
  folderId: string;
  relativePath: string;
  fileName: string;
  accessible: boolean;
}

export interface SavedPlaylist {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  mode: GenerationMode;
  category?: string;
  format?: 'm3u8' | 'm3u';
  outputPathHint?: string;
  items: PlaylistItem[];
  totalDuration: number;
  musicCount: number;
  spotCount: number;
  warnings: string[];
}

export interface GeneratorProfile {
  id: string;
  name: string;
  createdAt: number;
  config: PlaylistGeneratorConfig;
}

export interface UsageHistoryEntry {
  id: string;
  trackId: string;
  artistNormalized: string;
  playlistId: string;
  playlistName: string;
  usedAt: number;
}

export interface ScheduledTask {
  id: string;
  name: string;
  enabled: boolean;
  frequency: 'daily' | 'weekly';
  time: string;
  extraTimes?: string[];
  daysOfWeek: number[];
  sourceScope?: 'all' | 'folder';
  sourceFolderId?: string;
  mode?: GenerationMode;
  noRepeatTracks?: boolean;
  noRepeatArtists?: boolean;
  respectAntiRepeat?: boolean;
  antiRepeatHours?: number;
  artistSeparation?: number;
  allowedGenres: string[];
  excludedGenres: string[];
  decades?: string[];
  mood: string;
  bpmMin: number | null;
  bpmMax: number | null;
  intensities: IntensityLevel[];
  spots?: SpotsMixerConfig;
  targetType: 'duration' | 'count' | 'both';
  targetDurationMin: number;
  targetCount: number;
  format: 'm3u8' | 'm3u';
  pathMode: PathExportMode;
  outputFileName?: string;
  overwriteExisting?: boolean;
  outputFolderMode?: 'global' | 'custom';
  namePattern: string;
  outputFolderName: string;
  lastRunAt: number | null;
  armedAt?: number;
  updatedAt?: number;
  lastSlotKey?: string;
  executedSlotKeys?: string[];
  fallbackToOldestOnExhaust?: boolean;
  lastStatus?: 'success' | 'warning' | 'error';
  lastMessage?: string;
  lastDiskWriteStatus?: 'written' | 'pending-permission' | 'no-folder' | 'unsupported' | 'error';
  lastDiskWritePath?: string;
  lastDiskWriteAt?: number | null;
}

export interface ActivityLogEntry {
  id: string;
  timestamp: number;
  category: 'scan' | 'analysis' | 'generator' | 'export' | 'scheduler' | 'validator' | 'backup';
  level: 'info' | 'success' | 'warning' | 'error';
  title: string;
  detail: string;
}

export interface RmsThresholds {
  verySoftMax: number;
  softMax: number;
  mediumMax: number;
  highMax: number;
}

export interface AppSettings {
  id: 'default';
  antiRepeatHours: number;
  artistSeparation: number;
  defaultFormat: 'm3u8' | 'm3u';
  defaultPathMode: PathExportMode;
  storageRootPath: string;
  globalFallbackPrefix: string;
  organizeByYear: boolean;
  organizeByMonth: boolean;
  organizeByYearMonth: boolean;
  defaultExportSubfolder: string;
  rmsThresholds: RmsThresholds;
  customGenres: string[];
  desktopBridgeUrl: string;
  autoBackgroundAnalysis: boolean;
  defaultAnalysisMode: AnalysisMode;
  schedulerOutputFolderName?: string;
  schedulerOutputWindowsPath?: string;
}

export interface ProgressiveCurveConfig {
  preset: CurvePreset;
  segments: [number, number, number, number];
}

export interface SpotsMixerConfig {
  enabled: boolean;
  spotFolderId: string;
  everyNSongs: number;
  rotationMode: SpotRotationMode;
  insertIntroAtStart: boolean;
}

export interface PlaylistGeneratorConfig {
  name: string;
  templateId: string;
  sourceScope?: 'all' | 'folder';
  sourceFolderId?: string;
  targetType: 'duration' | 'count' | 'both';
  targetDurationMin: number;
  targetCount: number;
  mode: GenerationMode;
  progressiveCurve: ProgressiveCurveConfig;
  allowedGenres: string[];
  excludedGenres: string[];
  decades: string[];
  years?: number[];
  includedArtists: string[];
  excludedArtists: string[];
  bpmMin: number | null;
  bpmMax: number | null;
  energyMin: number | null;
  energyMax: number | null;
  energyLevels?: EnergyLevel[];
  intensities: IntensityLevel[];
  moods: string[];
  noRepeatTracks?: boolean;
  noRepeatArtists?: boolean;
  respectAntiRepeat: boolean;
  antiRepeatHours: number;
  fallbackToOldestOnExhaust?: boolean;
  artistSeparation: number;
  spots: SpotsMixerConfig;
}

export interface GeneratorTemplate {
  id: string;
  name: string;
  description: string;
  matchingCount?: number;
  tags?: string[];
  patch: Partial<PlaylistGeneratorConfig>;
}

export const INTENSITY_LEVELS: IntensityLevel[] = [
  'Muy suave',
  'Suave',
  'Media',
  'Alta',
  'Muy alta',
];

export const ENERGY_LEVELS: EnergyLevel[] = [
  'Muy baja',
  'Baja',
  'Media',
  'Alta',
  'Muy alta',
];

export const MOOD_OPTIONS = [
  'Relajado',
  'Romántico',
  'Alegre',
  'Fiesta',
  'Entrenamiento',
  'Conducción',
  'Nocturno',
] as const;

export const SUPPORTED_AUDIO_EXTENSIONS = [
  '.mp3',
  '.flac',
  '.wav',
  '.m4a',
  '.aac',
  '.ogg',
  '.wma',
] as const;

export const CURVE_PRESETS: Record<Exclude<CurvePreset, 'Personalizada'>, [number, number, number, number]> = {
  'Ascendente': [28, 52, 76, 92],
  'Pico central': [35, 68, 92, 48],
  'Descendente': [88, 68, 46, 25],
  'Onda radial': [38, 82, 45, 86],
};

export const GENERATOR_TEMPLATES: GeneratorTemplate[] = [
  {
    id: 'pop-80s',
    name: 'Pop 80s',
    description: 'Pop internacional de los años 80 con pulso constante.',
    patch: {
      name: 'Pop Internacional 80s',
      mode: 'Por década',
      decades: ['1980s'],
      allowedGenres: ['Pop', 'Synthpop', 'New Wave', 'Disco'],
      bpmMin: 95,
      bpmMax: 132,
      intensities: ['Media', 'Alta'],
      targetType: 'duration',
      targetDurationMin: 60,
    },
  },
  {
    id: 'rock-90s',
    name: 'Rock 90s',
    description: 'Rock clásico, alternativo y grunge de los años 90.',
    patch: {
      name: 'Rock Clásico 90s',
      mode: 'Por década',
      decades: ['1990s'],
      allowedGenres: ['Rock', 'Alternative', 'Grunge', 'Clásicos'],
      intensities: ['Media', 'Alta', 'Muy alta'],
      targetType: 'duration',
      targetDurationMin: 60,
    },
  },
  {
    id: 'dance-120-128',
    name: 'Dance 120–128 BPM',
    description: 'Sesión Dance calibrada entre 120 y 128 BPM.',
    patch: {
      name: 'Dance 120-128 BPM',
      mode: 'Por BPM',
      allowedGenres: ['Dance', 'House', 'Techno', 'Disco'],
      bpmMin: 120,
      bpmMax: 128,
      intensities: ['Alta', 'Muy alta'],
      targetType: 'duration',
      targetDurationMin: 60,
    },
  },
  {
    id: 'latino-alta',
    name: 'Latino alta intensidad',
    description: 'Música latina, reggaeton y tropical de alta energía.',
    patch: {
      name: 'Latino Alta Intensidad',
      mode: 'Combinado',
      allowedGenres: ['Latino', 'Latin', 'Reggaeton', 'Tropical', 'Salsa', 'Cumbia', 'Merengue'],
      intensities: ['Alta', 'Muy alta'],
      bpmMin: 92,
      bpmMax: 145,
      targetType: 'duration',
      targetDurationMin: 60,
    },
  },
  {
    id: 'manana-suave',
    name: 'Mañana suave',
    description: 'Música suave y relajada para el bloque matinal.',
    patch: {
      name: 'Mañana Suave',
      mode: 'Por intensidad',
      intensities: ['Muy suave', 'Suave', 'Media'],
      moods: ['Relajado', 'Romántico'],
      bpmMin: 65,
      bpmMax: 112,
      targetType: 'duration',
      targetDurationMin: 90,
    },
  },
  {
    id: 'tarde-energetica',
    name: 'Tarde energética',
    description: 'Curva ascendente ideal para la franja vespertina.',
    patch: {
      name: 'Tarde Energética',
      mode: 'Progresivo',
      progressiveCurve: { preset: 'Ascendente', segments: [45, 65, 82, 92] },
      intensities: ['Media', 'Alta', 'Muy alta'],
      moods: ['Alegre', 'Fiesta', 'Entrenamiento', 'Conducción'],
      targetType: 'duration',
      targetDurationMin: 60,
    },
  },
  {
    id: 'house-progresivo',
    name: 'House progresivo',
    description: 'House y Techno con pico central de cabina.',
    patch: {
      name: 'House Progresivo',
      mode: 'Progresivo',
      allowedGenres: ['House', 'Techno', 'Dance', 'Electronic'],
      bpmMin: 118,
      bpmMax: 132,
      progressiveCurve: { preset: 'Pico central', segments: [40, 72, 94, 52] },
      targetType: 'duration',
      targetDurationMin: 60,
    },
  },
  {
    id: 'romantica',
    name: 'Romántica',
    description: 'Selección romántica y nocturna para cierre del día.',
    patch: {
      name: 'Selección Romántica',
      mode: 'Por ambiente',
      moods: ['Romántico', 'Relajado', 'Nocturno'],
      intensities: ['Muy suave', 'Suave'],
      bpmMin: 60,
      bpmMax: 102,
      targetType: 'duration',
      targetDurationMin: 60,
    },
  },
  {
    id: 'exitos-actuales',
    name: 'Éxitos actuales',
    description: 'Éxitos recientes (2010s–2020s) con rotación dinámica.',
    patch: {
      name: 'Éxitos Actuales',
      mode: 'Por década',
      decades: ['2020s', '2010s'],
      intensities: ['Media', 'Alta', 'Muy alta'],
      targetType: 'count',
      targetCount: 20,
    },
  },
  {
    id: 'mix-multigenero',
    name: 'Mix multi-género',
    description: 'Combinación de diferentes géneros en onda radial.',
    patch: {
      name: 'Mix Multi-Género',
      mode: 'Progresivo',
      progressiveCurve: { preset: 'Onda radial', segments: [38, 82, 45, 86] },
      targetType: 'duration',
      targetDurationMin: 60,
    },
  },
];
