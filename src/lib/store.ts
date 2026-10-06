/**
 * The storage starter — the pattern every app here re-derives without it.
 *
 * Shape (copy this rather than rediscover it):
 *  1. **Private settings first.** `openSettings()` is the app's own
 *     `~/.config`-style mount — auto-provisioned for the signed-in user,
 *     isolated to this app, no consent prompt. It is where small durable state
 *     (the id of the space below, UI prefs) belongs. If it rejects
 *     (`auth-required` when signed out, or absent on a fork), the app still
 *     runs — settings are an accelerator, not a dependency.
 *  2. **A remembered space for user data.** First run: `createSpace()` (one
 *     create consent, then re-openable forever via the recorded grant). Later
 *     runs: read the id back from settings and `mountSpace()` it; only the
 *     create path prompts.
 *  3. **One record per file, JSON.** The platform filesystem is
 *     last-write-wins per file — a record per file keeps writes from
 *     contending, keeps reads whole, and makes change events precise.
 *
 * Every write is idempotent and order-independent on purpose: React StrictMode
 * runs the boot effect twice, so first-run seeding runs concurrently with
 * itself (see CLAUDE.md "Platform truths"). The platform tolerates the race;
 * this file just never depends on ordering either — a `seeded` marker is
 * written LAST, after everything it stands for.
 */

import {
  createSpace,
  mountSpace,
  openFs,
  openSettings,
  sandboxFs,
  type MountFs,
  type SandboxMount,
} from '@immediately-run/sdk';

/** The app's private settings, read once at open. */
export interface AppSettings {
  /** The id of the space this app keeps its user data in (absent on first run). */
  dataSpaceId?: string;
}

const SETTINGS_FILE = 'settings.json';

/** The whole storage surface the pattern produces: settings + the data space. */
export interface AppStore {
  settings: AppSettings;
  saveSettings(settings: AppSettings): Promise<void>;
  data: MountFs;
}

const readJson = async (fsMount: MountFs, relPath: string): Promise<unknown> => {
  try {
    const raw = await fsMount.readFile(relPath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null; // absent or unreadable — both mean "no value yet"
  }
};

const writeJson = async (fsMount: MountFs, relPath: string, value: unknown): Promise<void> => {
  const dir = relPath.slice(0, relPath.lastIndexOf('/'));
  if (dir) await fsMount.mkdir(dir, { recursive: true }).catch(() => undefined);
  await fsMount.writeFile(relPath, JSON.stringify(value, null, 2) + '\n');
};

/**
 * Open the app's storage: private settings first, then the remembered data
 * space (creating it on first run). `onFirstRun` lets the caller seed the
 * space's initial records — it runs BEFORE the `seeded` marker is written, so a
 * crashed/interrupted seed re-runs cleanly on the next boot.
 */
export const openAppStore = async (onFirstRun?: (data: MountFs) => Promise<void>): Promise<AppStore> => {
  // 1. Private settings (an accelerator, not a dependency — null when signed out).
  const settingsMount = await openSettings().catch(() => null);
  let settings: AppSettings = {};
  if (settingsMount) {
    const settingsFs = openFs(settingsMount);
    settings = ((await readJson(settingsFs, SETTINGS_FILE)) as AppSettings | null) ?? {};
    const saveSettings = async (next: AppSettings): Promise<void> => {
      settings = next;
      await writeJson(settingsFs, SETTINGS_FILE, next);
    };
    const finish = async (data: MountFs): Promise<AppStore> => ({ settings, saveSettings, data });

    // 2. The data space: remember the id in settings so later boots never prompt.
    let dataMount: SandboxMount | null = null;
    if (settings.dataSpaceId) {
      dataMount = await mountSpace({ spaceId: settings.dataSpaceId }).catch(() => null);
    }
    if (!dataMount) {
      // First run (or the remembered grant was revoked): one create consent.
      const created = await createSpace({ name: 'App data' }).catch(() => null);
      if (created) {
        dataMount = created;
        await saveSettings({ ...settings, dataSpaceId: created.id });
      }
    }
    if (!dataMount) {
      // No storage available (signed out, declined, revoked): an in-memory
      // session keeps the app usable — persistence is optional, never required.
      return { settings, saveSettings, data: memoryFs() };
    }

    const data = openFs(dataMount);
    // 3. First-run seeding: the marker is written LAST (see the header).
    if (!(await data.exists('seeded'))) {
      if (onFirstRun) await onFirstRun(data);
      await data.writeFile('seeded', new Date().toISOString());
    }
    return finish(data);
  }

  // No settings mount at all (vite dev / signed out): in-memory session.
  return { settings, saveSettings: async () => undefined, data: memoryFs() };
};

/**
 * Read one JSON record from a directory, writing `initial` first if absent —
 * the one-record-per-file read path. Idempotent under a concurrent first boot:
 * a lost create-race resolves for both callers (platform-guaranteed), and both
 * write the same `initial`.
 */
export const readRecord = async <T extends object>(
  fsMount: MountFs,
  dir: string,
  name: string,
  initial: T,
): Promise<T> => {
  const relPath = `${dir ? `${dir}/` : ''}${name}.json`;
  const existing = await readJson(fsMount, relPath);
  if (existing !== null) return existing as T;
  await writeJson(fsMount, relPath, initial);
  return initial;
};

/** Write one JSON record (whole-file, last-write-wins). */
export const writeRecord = async <T>(fsMount: MountFs, dir: string, name: string, value: T): Promise<void> =>
  writeJson(fsMount, `${dir ? `${dir}/` : ''}${name}.json`, value);

/** List the record names in a directory (no `.json` suffix), sorted. */
export const listRecords = async (fsMount: MountFs, dir: string): Promise<string[]> => {
  try {
    const entries = await fsMount.readdir(dir);
    return entries
      .map((e) => e.name)
      .filter((n) => n.endsWith('.json'))
      .map((n) => n.slice(0, -'.json'.length))
      .sort();
  } catch {
    return [];
  }
};

/**
 * Subscribe to record changes under a mount directory. `fs.promises.watch`
 * delivers REMOTE changes (another tab, another member) as watch events, so no
 * polling loop is needed; a light poll is the fallback for hosts older than
 * the watch relay. Returns an unsubscribe function.
 */
export const watchRecords = (
  fsMount: MountFs,
  dir: string,
  onChange: () => void,
  opts: { pollMs?: number } = {},
): (() => void) => {
  const root = fsMount.mount.path;
  const abs = `${root.replace(/\/$/, '')}/${dir.replace(/^\/|\/$/g, '')}`;
  const promises = sandboxFs()?.promises;
  if (promises && typeof (promises as unknown as { watch?: unknown }).watch === 'function') {
    let stopped = false;
    void (async () => {
      try {
        const watchFn = (promises as unknown as { watch(p: string, o: unknown): AsyncIterable<unknown> }).watch;
        for await (const _event of watchFn(abs, { recursive: true })) {
          void _event;
          if (stopped) break;
          onChange();
        }
      } catch {
        /* watch failed (mount gone) — nothing to do */
      }
    })();
    return () => {
      stopped = true;
    };
  }
  const interval = setInterval(onChange, opts.pollMs ?? 3000);
  return () => clearInterval(interval);
};

// A two-overload readFile in object-literal form (the MountFs shape: utf8 →
// string, omitted → bytes) needs a declared function — object methods cannot
// carry overloads.
function memoryReadFile(files: Map<string, string>) {
  async function read(relPath: string, encoding: 'utf8'): Promise<string>;
  async function read(relPath: string): Promise<Uint8Array>;
  async function read(relPath: string, encoding?: 'utf8'): Promise<string | Uint8Array> {
    const v = files.get(relPath);
    if (v === undefined) throw new Error(`not-found: ${relPath}`);
    return encoding === 'utf8' ? v : new TextEncoder().encode(v);
  }
  return read;
}

/** An in-memory MountFs stand-in for the no-storage session (see openAppStore). */
const memoryFs = (): MountFs => {
  const files = new Map<string, string>();
  const fakeMount = { path: '/memory', mode: 'rw' as const } as unknown as SandboxMount;
  const api: MountFs = {
    mount: fakeMount,
    readFile: memoryReadFile(files),
    readBlob: async (relPath: string) => new Blob([await api.readFile(relPath, 'utf8')]),
    readObjectUrl: async (relPath: string) => ({ url: URL.createObjectURL(await api.readBlob(relPath)), revoke: () => undefined }),
    async writeFile(relPath: string, data: string | Uint8Array): Promise<void> {
      files.set(relPath, typeof data === 'string' ? data : new TextDecoder().decode(data));
    },
    async readdir(dir = ''): Promise<Array<{ name: string; kind: 'file' | 'dir' }> > {
      const prefix = dir ? `${dir}/` : '';
      return [...new Set([...files.keys()].filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length).split('/')[0]))]
        .filter(Boolean)
        .map((name) => ({ name, kind: files.has(`${prefix}${name}`) ? ('file' as const) : ('dir' as const) }));
    },
    async stat(relPath: string): Promise<{ kind: 'file' | 'dir'; size: number; mtimeMs?: number }> {
      if (!files.has(relPath)) throw new Error(`not-found: ${relPath}`);
      return { kind: 'file', size: files.get(relPath)!.length, mtimeMs: 0 };
    },
    async exists(relPath: string): Promise<boolean> {
      return files.has(relPath);
    },
    async mkdir(): Promise<void> {},
    async rm(relPath: string): Promise<void> {
      files.delete(relPath);
    },
    async rename(fromRel: string, toRel: string): Promise<void> {
      files.set(toRel, files.get(fromRel) ?? '');
      files.delete(fromRel);
    },
    canWrite: () => true,
    onChange: () => () => undefined,
  };
  return api;
};
