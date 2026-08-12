// js/services/updateCheck.js
//
// Owner-only, native-only. Compares the installed APK's versionName
// (read from the native shell via @capacitor/app) against the latest
// GitHub Release tag for this repo, and — if the owner accepts —
// downloads and hands the APK to the system installer.

import { Capacitor } from '@capacitor/core';
import { App } from '@capacitor/app';
import { Filesystem, Directory } from '@capacitor/filesystem';
import { FileOpener } from '@capacitor-community/file-opener';
import { getActiveRole } from './auth.js';

const GITHUB_REPO = 'vintexguesthouse/pms-apk';
const RELEASES_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;

function _isNewer(current, latest) {
  const a = current.replace(/^v/i, '').split('.').map(Number);
  const b = latest.replace(/^v/i, '').split('.').map(Number);
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0, bv = b[i] ?? 0;
    if (bv > av) return true;
    if (bv < av) return false;
  }
  return false;
}

export async function checkForUpdate() {
  if (getActiveRole() !== 'owner') return null;
  if (!Capacitor.isNativePlatform()) return null;

  try {
    const info = await App.getInfo();
    const res = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' } });
    if (!res.ok) return null;

    const release = await res.json();
    const latestVersion = release.tag_name ?? '';
    if (!latestVersion || !_isNewer(info.version, latestVersion)) return null;

    const apkAsset = (release.assets ?? []).find((a) => a.name.endsWith('.apk'));
    if (!apkAsset) return null;

    return { currentVersion: info.version, latestVersion, downloadUrl: apkAsset.browser_download_url };
  } catch (err) {
    console.error('[updateCheck]', err);
    return null;
  }
}

export async function downloadAndInstallUpdate(downloadUrl) {
  const response = await fetch(downloadUrl);
  const blob = await response.blob();
  const base64 = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });

  const { uri } = await Filesystem.writeFile({
    path: 'vintex-pms-update.apk',
    data: base64,
    directory: Directory.Cache   // must match file_paths.xml below
  });

  await FileOpener.open({ filePath: uri, contentType: 'application/vnd.android.package-archive' });
}