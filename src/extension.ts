import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind,
	RevealOutputChannelOn,
	ErrorAction,
	CloseAction
} from 'vscode-languageclient/node';

let client: LanguageClient | undefined;
let restarting = false;

let outputChannel: vscode.OutputChannel | undefined;

const GH_OWNER = 'balthild';
const GH_REPO = 'php-cs-fixer-lsp';
const ASSET_NAME = 'php-cs-fixer-lsp.phar';
const META_FILENAME = 'meta.json';
const USER_AGENT = 'php-cs-fixer-lsp-vscode';

export async function activate(context: vscode.ExtensionContext) {
	try {
		await vscode.workspace.fs.createDirectory(context.globalStorageUri);
		outputChannel = vscode.window.createOutputChannel('php-cs-fixer-lsp');

		client = await startLanguageClient(context);

		const download = vscode.commands.registerCommand('php-cs-fixer-lsp.downloadServer', async () => {
			try {
				const binary = await ensureDownloadedBinary(context, true);
				vscode.window.showInformationMessage(`php-cs-fixer-lsp downloaded to ${binary}`);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`php-cs-fixer-lsp download failed: ${message}`);
			}
		});

		const restart = vscode.commands.registerCommand('php-cs-fixer-lsp.restartServer', async () => {
			try {
				if (client) {
					restarting = true;
					try {
						await client.stop(1000);
					} catch (err) {
						console.log('php-cs-fixer-lsp stop info:', err);
					}
					client.dispose();
					restarting = false;
				}

				client = await startLanguageClient(context);
				context.subscriptions.push(client);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				vscode.window.showErrorMessage(`php-cs-fixer-lsp failed to restart: ${message}`);
			}
		});

		context.subscriptions.push(download, restart, client);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		vscode.window.showErrorMessage(`php-cs-fixer-lsp failed to start: ${message}`);
		console.error(error);
	}
}

export function deactivate(): Thenable<void> | undefined {
	if (!client) {
		return undefined;
	}
	return client.stop(1000);
}

async function startLanguageClient(context: vscode.ExtensionContext): Promise<LanguageClient> {
	const config = vscode.workspace.getConfiguration('php-cs-fixer-lsp');
	const serverArgs = config.get<string[]>('serverArgs', []);
	const serverExec = await resolveServerExecutable(context, config);

	const serverOptions: ServerOptions = {
		command: serverExec,
		args: ['server', ...serverArgs],
		transport: TransportKind.stdio
	};

	const clientOptions: LanguageClientOptions = {
		documentSelector: [
			{ scheme: 'file', language: 'php' }
		],
		synchronize: {
			configurationSection: 'php-cs-fixer-lsp',
			fileEvents: vscode.workspace.createFileSystemWatcher('**/*')
		},
		outputChannel: outputChannel,
		revealOutputChannelOn: RevealOutputChannelOn.Never,
		middleware: {
			provideDocumentFormattingEdits: async (document, options, token, next) => {
				try {
					return await next(document, options, token);
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					if (outputChannel) {
						outputChannel.appendLine(`[formatting] ${message}`);
						if (error instanceof Error && error.stack) {
							outputChannel.appendLine(error.stack);
						}
					}
					return null;
				}
			}
		},
		errorHandler: {
			error: () => ({ action: ErrorAction.Continue }),
			closed: () => ({ action: CloseAction.DoNotRestart, handled: restarting })
		},
	};

	const client = new LanguageClient(
		'php-cs-fixer-lsp',
		'PHP CS Fixer Language Server',
		serverOptions,
		clientOptions
	);

	client.start();
	console.log('language server started');

	return client;
}

async function resolveServerExecutable(
	context: vscode.ExtensionContext,
	config: vscode.WorkspaceConfiguration
): Promise<string> {
	const configured = (config.get<string>('serverExec', '') ?? '').trim();
	if (configured) {
		return configured;
	}
	return ensureDownloadedBinary(context, false);
}

async function ensureDownloadedBinary(context: vscode.ExtensionContext, force: boolean): Promise<string> {
	const storageDir = path.join(context.globalStorageUri.fsPath, 'server');
	await fs.promises.mkdir(storageDir, { recursive: true });

	const binaryPath = path.join(storageDir, ASSET_NAME);
	const metaPath = path.join(storageDir, META_FILENAME);
	const cachedMeta = await readMeta(metaPath);

	let latest;
	try {
		latest = await fetchLatestRelease();
	} catch (error) {
		if (await fileExists(binaryPath)) {
			return binaryPath;
		}
		throw error;
	}

	if (!force && cachedMeta?.tag === latest.tag && await fileExists(binaryPath)) {
		return binaryPath;
	}

	await vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification,
		title: 'Downloading php-cs-fixer-lsp server...',
		cancellable: false
	}, async (progress) => {
		await downloadBinary(latest.downloadUrl, binaryPath, progress);
	});
	const meta = { tag: latest.tag, downloadedAt: new Date().toISOString() };
	await fs.promises.writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');

	return binaryPath;
}

async function fetchLatestRelease(): Promise<{ tag: string; downloadUrl: string; }> {
	const url = `https://api.github.com/repos/${GH_OWNER}/${GH_REPO}/releases/latest`;
	const body = await getJson(url);
	const assets: Array<{ name: string; browser_download_url: string; }> = body.assets ?? [];
	const asset = assets.find((item) => item.name === ASSET_NAME);
	if (!asset) {
		throw new Error('Latest release missing expected asset');
	}
	return { tag: body.tag_name as string, downloadUrl: asset.browser_download_url as string };
}

async function getJson(url: string): Promise<any> {
	return new Promise((resolve, reject) => {
		https.get(url, { headers: { 'user-agent': USER_AGENT, accept: 'application/vnd.github+json' } }, (res) => {
			const { statusCode, headers } = res;
			if (statusCode && statusCode >= 300 && statusCode < 400 && headers.location) {
				res.resume();
				getJson(headers.location).then(resolve).catch(reject);
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

async function downloadBinary(url: string, destination: string, progress?: vscode.Progress<{ message?: string; increment?: number; }>): Promise<void> {
	const tempPath = `${destination}.tmp`;
	await downloadToFile(url, tempPath, progress);
	await fs.promises.rename(tempPath, destination);
	await fs.promises.chmod(destination, 0o755);
}

async function downloadToFile(
	url: string,
	destination: string,
	progress?: vscode.Progress<{ message?: string; increment?: number; }>
): Promise<void> {
	return new Promise((resolve, reject) => {
		https.get(url, { headers: { 'user-agent': USER_AGENT } }, (res) => {
			const { statusCode, headers } = res;
			if (statusCode && statusCode >= 300 && statusCode < 400 && headers.location) {
				res.resume();
				downloadToFile(headers.location, destination, progress).then(resolve).catch(reject);
				return;
			}
			if (statusCode !== 200) {
				reject(new Error(`Download failed with status ${statusCode}`));
				return;
			}

			const total = Number(headers['content-length'] ?? 0);
			let received = 0;
			const report = () => {
				if (!progress || !total) {
					return;
				}
				const percent = Math.min(100, (received / total) * 100);
				progress.report({ increment: percent - (progress as any)._lastPercent, message: `${Math.round(percent)}%` });
				(progress as any)._lastPercent = percent;
			};
			if (progress) {
				(progress as any)._lastPercent = 0;
				progress.report({ message: 'Starting download...' });
			}

			const file = fs.createWriteStream(destination);
			res.pipe(file);
			res.on('data', (chunk) => {
				received += chunk.length;
				report();
			});
			file.on('finish', () => file.close((err) => err ? reject(err) : resolve()));
			file.on('error', reject);
		}).on('error', reject);
	});
}

async function fileExists(target: string): Promise<boolean> {
	try {
		await fs.promises.access(target, fs.constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

async function readMeta(metaPath: string): Promise<{ tag: string; downloadedAt: string; } | undefined> {
	try {
		const raw = await fs.promises.readFile(metaPath, 'utf8');
		return JSON.parse(raw);
	} catch {
		return undefined;
	}
}
