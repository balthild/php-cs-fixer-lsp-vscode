import { constants, createWriteStream } from 'fs';
import { access, readFile } from 'fs/promises';
import * as https from 'https';
import { Progress } from 'vscode';

const USER_AGENT = 'php-cs-fixer-lsp-vscode';

interface Asset {
  tag: string;
  url: string;
}

export async function fetchLatestReleaseAsset(repo: string, name: string): Promise<Asset> {
  interface GitHubRelease {
    tag_name: string;
    assets?: Array<{
      name: string;
      browser_download_url: string;
    }>;
  }

  const url = `https://api.github.com/repos/${repo}/releases/latest`;
  const release = await fetchJson<GitHubRelease>(url);

  const asset = release.assets?.find((item) => item.name === name);
  if (!asset) {
    throw new Error('Latest release missing expected asset');
  }

  return { tag: release.tag_name, url: asset.browser_download_url };
}

export async function fetchJson<T = any>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const headers = {
      'user-agent': USER_AGENT,
      'accept': 'application/vnd.github+json',
    };

    https.get(url, { headers }, (res) => {
      const { statusCode, headers } = res;

      if (statusCode && statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        fetchJson(headers.location).then(resolve).catch(reject);
        return;
      }

      if (statusCode !== 200) {
        reject(new Error(`GitHub API responded with status ${statusCode}`));
        return;
      }

      let raw = '';
      res.on('data', (chunk) => raw += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          reject(error);
        }
      });
    }).on('error', reject);
  });
}

export async function download(
  url: string,
  path: string,
  progress?: Progress<{ message?: string; increment?: number; }>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const headers = {
      'user-agent': USER_AGENT,
    };

    https.get(url, { headers }, (res) => {
      const { statusCode, headers } = res;

      if (statusCode && statusCode >= 300 && statusCode < 400 && headers.location) {
        res.resume();
        download(headers.location, path, progress).then(resolve).catch(reject);
        return;
      }

      if (statusCode !== 200) {
        reject(new Error(`Download failed with status ${statusCode}`));
        return;
      }

      const total = Number(headers['content-length'] ?? 0);
      let received = 0;

      progress?.report({ message: 'Starting...' });

      const report = (delta: number) => {
        if (!progress || !total) {
          return;
        }

        received += delta;
        const percent = Math.min((received / total) * 100, 100);

        progress.report({
          increment: (delta / total) * 100,
          message: `${percent.toFixed(2)}%`,
        });
      };

      const file = createWriteStream(path);
      res.pipe(file);
      res.on('data', (chunk) => report(chunk.length));
      file.on('finish', () => file.close((err) => err ? reject(err) : resolve()));
      file.on('error', reject);
    }).on('error', reject);
  });
}

export async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function readJson<T = any>(path: string): Promise<T | undefined> {
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export function errorText(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  return String(error);
}
