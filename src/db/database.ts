import Dexie, { type Table } from 'dexie';
import type {
  ActivityLogEntry,
  AppSettings,
  FolderHandleRecord,
  GeneratorProfile,
  LinkedFolder,
  SavedPlaylist,
  ScheduledTask,
  TrackRecord,
  UsageHistoryEntry,
} from '../types/studio';

export const DEFAULT_SETTINGS: AppSettings = {
  id: 'default',
  antiRepeatHours: 24,
  artistSeparation: 2,
  defaultFormat: 'm3u8',
  defaultPathMode: 'multi-drive',
  storageRootPath: 'D:\\SMART PLAYLIST AI',
  globalFallbackPrefix: 'D:\\SMART PLAYLIST AI\\Biblioteca\\',
  organizeByYear: true,
  organizeByMonth: true,
  organizeByYearMonth: true,
  defaultExportSubfolder: 'Playlists',
  rmsThresholds: {
    verySoftMax: -24,
    softMax: -18,
    mediumMax: -13,
    highMax: -9,
  },
  customGenres: [
    'Pop',
    'Rock',
    'Dance',
    'House',
    'Techno',
    'Disco',
    'Latino',
    'Reggaeton',
    'Tropical',
    'Jazz',
    'Clásicos',
  ],
  desktopBridgeUrl: 'http://127.0.0.1:8765',
  autoBackgroundAnalysis: true,
  defaultAnalysisMode: 'fast-metadata-bpm',
  schedulerOutputFolderName: '',
  schedulerOutputWindowsPath: '',
};

class SmartPlaylistDatabase extends Dexie {
  tracks!: Table<TrackRecord, string>;
  folders!: Table<LinkedFolder, string>;
  folderHandles!: Table<FolderHandleRecord, string>;
  playlists!: Table<SavedPlaylist, string>;
  generatorProfiles!: Table<GeneratorProfile, string>;
  usageHistory!: Table<UsageHistoryEntry, string>;
  schedules!: Table<ScheduledTask, string>;
  activityLogs!: Table<ActivityLogEntry, string>;
  settings!: Table<AppSettings, string>;

  constructor() {
    super('SmartPlaylistAIStudioDB');
    this.version(1).stores({
      tracks: 'id, folderId, genre, artist, decade, analysisStatus, accessible, duplicateKey, isSpotFolder, updatedAt',
      folders: 'id, role, name, lastScannedAt',
      folderHandles: 'folderId',
      playlists: 'id, name, createdAt, updatedAt',
      usageHistory: 'id, trackId, artistNormalized, playlistId, usedAt',
      schedules: 'id, enabled, frequency, time',
      activityLogs: 'id, timestamp, category, level',
      settings: 'id',
    });
    this.version(2).stores({
      tracks: 'id, folderId, genre, artist, decade, analysisStatus, accessible, duplicateKey, isSpotFolder, updatedAt',
      folders: 'id, role, name, lastScannedAt',
      folderHandles: 'folderId',
      playlists: 'id, name, createdAt, updatedAt',
      generatorProfiles: 'id, name, createdAt',
      usageHistory: 'id, trackId, artistNormalized, playlistId, usedAt',
      schedules: 'id, enabled, frequency, time',
      activityLogs: 'id, timestamp, category, level',
      settings: 'id',
    });
  }
}

export const db = new SmartPlaylistDatabase();

// Ephemeral in-memory registry of File objects for the active browser session
export const sessionFileRegistry = new Map<string, File>();

export async function getSettings(): Promise<AppSettings> {
  const existing = await db.settings.get('default');
  if (existing) {
    return { ...DEFAULT_SETTINGS, ...existing, id: 'default' };
  }
  await db.settings.put(DEFAULT_SETTINGS);
  return DEFAULT_SETTINGS;
}

export async function saveSettings(patch: Partial<AppSettings>): Promise<AppSettings> {
  const current = await getSettings();
  const next: AppSettings = { ...current, ...patch, id: 'default' };
  next.organizeByYearMonth = next.organizeByYear || next.organizeByMonth;
  await db.settings.put(next);
  return next;
}

export async function addActivityLog(
  category: ActivityLogEntry['category'],
  level: ActivityLogEntry['level'],
  title: string,
  detail: string
): Promise<void> {
  await db.activityLogs.add({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    category,
    level,
    title,
    detail,
  });
}

export interface StudioBackupPayload {
  schemaVersion: number;
  exportedAt: string;
  app: 'SMART PLAYLIST AI STUDIO';
  data: {
    tracks: TrackRecord[];
    folders: LinkedFolder[];
    playlists: SavedPlaylist[];
    generatorProfiles?: GeneratorProfile[];
    usageHistory: UsageHistoryEntry[];
    schedules: ScheduledTask[];
    activityLogs: ActivityLogEntry[];
    settings: AppSettings;
  };
}

export async function exportFullBackup(): Promise<StudioBackupPayload> {
  const [tracks, folders, playlists, generatorProfiles, usageHistory, schedules, activityLogs, settings] =
    await Promise.all([
      db.tracks.toArray(),
      db.folders.toArray(),
      db.playlists.toArray(),
      db.generatorProfiles.toArray(),
      db.usageHistory.toArray(),
      db.schedules.toArray(),
      db.activityLogs.toArray(),
      getSettings(),
    ]);

  await addActivityLog(
    'backup',
    'success',
    'Respaldo JSON exportado',
    `${tracks.length} canciones y ${playlists.length} playlists respaldadas.`
  );

  return {
    schemaVersion: 2,
    exportedAt: new Date().toISOString(),
    app: 'SMART PLAYLIST AI STUDIO',
    data: {
      tracks,
      folders,
      playlists,
      generatorProfiles,
      usageHistory,
      schedules,
      activityLogs,
      settings,
    },
  };
}

export async function importFullBackup(
  payload: StudioBackupPayload
): Promise<{ tracks: number; playlists: number; schedules: number }> {
  if (!payload || payload.app !== 'SMART PLAYLIST AI STUDIO' || !payload.data) {
    throw new Error('Archivo de respaldo inválido o incompatible con SMART PLAYLIST AI STUDIO.');
  }

  const {
    tracks = [],
    folders = [],
    playlists = [],
    generatorProfiles = [],
    usageHistory = [],
    schedules = [],
    activityLogs = [],
    settings,
  } = payload.data;

  await db.transaction(
    'rw',
    [
      db.tracks,
      db.folders,
      db.playlists,
      db.generatorProfiles,
      db.usageHistory,
      db.schedules,
      db.activityLogs,
      db.settings,
    ],
    async () => {
      await db.tracks.clear();
      await db.folders.clear();
      await db.playlists.clear();
      await db.generatorProfiles.clear();
      await db.usageHistory.clear();
      await db.schedules.clear();
      await db.activityLogs.clear();

      if (tracks.length) await db.tracks.bulkPut(tracks);
      if (folders.length) await db.folders.bulkPut(folders);
      if (playlists.length) await db.playlists.bulkPut(playlists);
      if (generatorProfiles.length) await db.generatorProfiles.bulkPut(generatorProfiles);
      if (usageHistory.length) await db.usageHistory.bulkPut(usageHistory);
      if (schedules.length) await db.schedules.bulkPut(schedules);
      if (activityLogs.length) await db.activityLogs.bulkPut(activityLogs);
      if (settings) await db.settings.put({ ...DEFAULT_SETTINGS, ...settings, id: 'default' });
    }
  );

  await addActivityLog(
    'backup',
    'success',
    'Respaldo JSON restaurado',
    `Importados ${tracks.length} registros de audio y ${playlists.length} playlists.`
  );
  return { tracks: tracks.length, playlists: playlists.length, schedules: schedules.length };
}
