/**
 * lib/export.ts —— 导出为 Markdown / 直写 Obsidian 目录
 *
 * 技术约束（重要）：
 *   · File System Access API 的 showDirectoryPicker() 需要 DOM 环境 + 用户手势，
 *     因此**不能在 MV3 Service Worker 中调用**，必须在侧边栏/选项页执行。
 *   · FileSystemDirectoryHandle 无法存进 chrome.storage（不可 JSON 序列化），
 *     但可以结构化克隆存进 IndexedDB，重启浏览器后仍可复用。
 *   · 重新获得句柄后需调用 requestPermission() 校验授权是否仍然有效
 *     （也可以在 queryPermission 为 granted 时直接使用）。
 */

import { sanitizeFilename, fmtDate } from './time';
import type { ObsidianConfig } from './types';

/* ================================================================== *
 * Obsidian 目录句柄的持久化（IndexedDB）
 * ================================================================== */

const DB_NAME = 'bililens';
const STORE = 'handles';
const HANDLE_KEY = 'obsidianDir';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 打开失败'));
  });
}

async function idbPut(key: string, value: unknown): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('写入失败'));
  });
  db.close();
}

async function idbGet<T>(key: string): Promise<T | null> {
  const db = await openDb();
  const val = await new Promise<T | null>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve((req.result as T) ?? null);
    req.onerror = () => reject(req.error ?? new Error('读取失败'));
  });
  db.close();
  return val;
}

async function idbDelete(key: string): Promise<void> {
  const db = await openDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('删除失败'));
  });
  db.close();
}

/** 是否支持 File System Access API */
export function supportsFileSystemAccess(): boolean {
  return typeof (globalThis as { showDirectoryPicker?: unknown }).showDirectoryPicker === 'function';
}

/**
 * 让用户选择 Obsidian 库目录并持久化句柄。
 * 必须由用户点击触发。
 */
export async function pickObsidianDir(): Promise<string | null> {
  if (!supportsFileSystemAccess()) {
    throw new Error('当前浏览器不支持目录直写（需 Chrome / Edge 86+）');
  }

  const picker = (
    globalThis as unknown as {
      showDirectoryPicker: (opts?: {
        mode?: 'read' | 'readwrite';
        id?: string;
      }) => Promise<FileSystemDirectoryHandle>;
    }
  ).showDirectoryPicker;

  const handle = await picker({ mode: 'readwrite', id: 'bililens-obsidian' });
  await idbPut(HANDLE_KEY, handle);
  return handle.name;
}

/** 读取已保存的目录句柄（不申请权限） */
export async function getSavedObsidianDir(): Promise<FileSystemDirectoryHandle | null> {
  return idbGet<FileSystemDirectoryHandle>(HANDLE_KEY);
}

/** 忘记已保存的目录 */
export async function forgetObsidianDir(): Promise<void> {
  await idbDelete(HANDLE_KEY);
}

/**
 * 取得可用（已授权）的目录句柄。
 * 返回 null 表示未选择目录；抛错表示用户拒绝授权。
 */
export async function getAuthorizedDir(): Promise<FileSystemDirectoryHandle | null> {
  const handle = await getSavedObsidianDir();
  if (!handle) return null;

  const opts = { mode: 'readwrite' as const };
  const h = handle as unknown as {
    queryPermission: (o: { mode: 'readwrite' }) => Promise<PermissionState>;
    requestPermission: (o: { mode: 'readwrite' }) => Promise<PermissionState>;
  };

  if ((await h.queryPermission(opts)) === 'granted') return handle;

  // 需要用户手势才能成功；侧边栏点击「保存」时已在手势上下文内
  const res = await h.requestPermission(opts);
  if (res !== 'granted') throw new Error('目录写入权限被拒绝，请重新选择 Obsidian 目录');
  return handle;
}

/** 在目录下递归取/建子目录 */
async function ensureDir(
  root: FileSystemDirectoryHandle,
  sub: string,
): Promise<FileSystemDirectoryHandle> {
  let cur = root;
  const parts = sub
    .split(/[\\/]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  for (const part of parts) {
    cur = await cur.getDirectoryHandle(sanitizeFilename(part, 40), { create: true });
  }
  return cur;
}

/* ================================================================== *
 * 文件内容构造
 * ================================================================== */

export interface NoteMeta {
  title: string;
  upName: string;
  bvid: string;
  cid: number;
  pageIndex?: number;
  duration?: number;
  cover?: string;
  pubdate?: number;
  model: string;
  createdAt: number;
}

/** 生成文件名的变量替换 */
export function buildFilename(template: string, meta: NoteMeta): string {
  const pageSuffix = meta.pageIndex && meta.pageIndex > 1 ? `_P${meta.pageIndex}` : '';
  const raw = (template || '{title}')
    .replace(/\{title\}/g, meta.title)
    .replace(/\{up\}/g, meta.upName || '未知UP')
    .replace(/\{date\}/g, fmtDate(meta.createdAt / 1000))
    .replace(/\{bvid\}/g, meta.bvid);

  return sanitizeFilename(`${raw}${pageSuffix}`);
}

/**
 * 组装完整 Markdown。
 * 带 YAML frontmatter —— 这是 Obsidian 的属性区，
 * 便于后续用 Dataview 按 UP主 / 标签 做聚合检索。
 */
export function buildMarkdown(body: string, meta: NoteMeta): string {
  const videoUrl = `https://www.bilibili.com/video/${meta.bvid}${
    meta.pageIndex && meta.pageIndex > 1 ? `?p=${meta.pageIndex}` : ''
  }`;

  // YAML 值需要转义双引号
  const yq = (s: string): string => `"${s.replace(/"/g, '\\"')}"`;

  const frontmatter = [
    '---',
    `title: ${yq(meta.title)}`,
    `up: ${yq(meta.upName)}`,
    `source: ${videoUrl}`,
    `bvid: ${meta.bvid}`,
    `cid: ${meta.cid}`,
    `created: ${new Date(meta.createdAt).toISOString()}`,
    `model: ${yq(meta.model)}`,
    'tags:',
    '  - bilibili',
    '  - 视频笔记',
    '---',
    '',
  ].join('\n');

  const footer = [
    '',
    '---',
    '',
    `> 由 **BiliLens** 生成 · [原视频](${videoUrl}) · 模型 \`${meta.model}\``,
    '',
  ].join('\n');

  return `${frontmatter}${body.trim()}${footer}`;
}

/* ================================================================== *
 * 落盘
 * ================================================================== */

/** 方式一：浏览器下载 */
export async function downloadMarkdown(filename: string, content: string): Promise<void> {
  const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    await browser.downloads.download({
      url,
      filename: `${filename}.md`,
      saveAs: false,
    });
  } finally {
    // 交给浏览器读取后释放
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
}

/** 方式二：直写 Obsidian 库目录 */
export async function saveToObsidian(
  filename: string,
  content: string,
  cfg: ObsidianConfig,
): Promise<string> {
  const root = await getAuthorizedDir();
  if (!root) throw new Error('尚未选择 Obsidian 库目录，请到设置里选择');

  const dir = cfg.subfolder.trim() ? await ensureDir(root, cfg.subfolder) : root;

  const fileHandle = await dir.getFileHandle(`${filename}.md`, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();

  const rel = cfg.subfolder.trim() ? `${cfg.subfolder}/${filename}.md` : `${filename}.md`;
  return rel;
}

/** 统一入口：按设置选择落盘方式 */
export async function exportNote(
  body: string,
  meta: NoteMeta,
  opts: { saveMode: 'download' | 'obsidian'; obsidian: ObsidianConfig },
): Promise<string> {
  const filename = buildFilename(opts.obsidian.filenameTemplate, meta);
  const content = buildMarkdown(body, meta);

  if (opts.saveMode === 'obsidian' && opts.obsidian.enabled) {
    return await saveToObsidian(filename, content, opts.obsidian);
  }

  await downloadMarkdown(filename, content);
  return `${filename}.md（已下载）`;
}
