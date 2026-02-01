import { chmod, mkdir, rename, writeFile } from 'fs/promises';
import { join } from 'path';
import * as vscode from 'vscode';
import {
  CloseAction,
  ErrorAction,
  LanguageClient,
  LanguageClientOptions,
  RevealOutputChannelOn,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';

import { download, errorText, fetchLatestReleaseAsset, fileExists, readJson } from './utils';

let extension: PhpCsFixerExtension;

export async function activate(context: vscode.ExtensionContext) {
  extension = new PhpCsFixerExtension(context);
  await extension.activate();
}

export async function deactivate() {
  await extension.deactivate();
}

const SERVER_REPO = 'balthild/php-cs-fixer-lsp';
const SERVER_ASSET = 'php-cs-fixer-lsp.phar';

class PhpCsFixerExtension {
  private context: vscode.ExtensionContext;
  private output: vscode.OutputChannel;

  private client: LanguageClient | undefined;
  private restarting: boolean = false;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.output = vscode.window.createOutputChannel('php-cs-fixer-lsp');
  }

  public async activate() {
    await this.startServer();

    this.context.subscriptions.push(
      vscode.commands.registerCommand('php-cs-fixer-lsp.restartServer', () => this.restartServer()),
      vscode.commands.registerCommand('php-cs-fixer-lsp.downloadServer', () => this.downloadServer()),
    );
  }

  public async deactivate() {
    await this.stopServer();
  }

  private async startServer() {
    try {
      const config = this.getExtensionConfig();
      const serverArgs = config.get<string[]>('serverArgs', []);
      const serverExec = await this.resolveServerExec(config);

      const serverOptions: ServerOptions = {
        command: serverExec,
        args: ['server', ...serverArgs],
        transport: TransportKind.stdio,
      };

      const clientOptions: LanguageClientOptions = {
        documentSelector: [
          { scheme: 'file', language: 'php' },
        ],
        synchronize: {
          configurationSection: 'php-cs-fixer-lsp',
          fileEvents: vscode.workspace.createFileSystemWatcher('**/*'),
        },
        outputChannel: this.output,
        revealOutputChannelOn: RevealOutputChannelOn.Never,
        middleware: {
          provideDocumentFormattingEdits: async (document, options, token, next) => {
            try {
              return await next(document, options, token);
            } catch (error) {
              this.output.appendLine(errorText(error));
              return null;
            }
          },
        },
        errorHandler: {
          error: () => ({ action: ErrorAction.Continue }),
          closed: () => ({ action: CloseAction.DoNotRestart, handled: this.restarting }),
        },
      };

      this.client = new LanguageClient(
        'php-cs-fixer-lsp',
        'PHP CS Fixer Language Server',
        serverOptions,
        clientOptions,
      );

      this.client.start();
      this.output.appendLine('language server started');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`php-cs-fixer-lsp server failed to start: ${message}`);
      this.output.appendLine('server start failed');
      this.output.appendLine(errorText(error));
    }
  }

  private async stopServer() {
    try {
      await this.client?.stop(1000);
    } catch (error) {
      this.output.appendLine('server stop failed');
      this.output.appendLine(errorText(error));
    }
    await this.client?.dispose();
  }

  private async restartServer() {
    if (this.client) {
      this.restarting = true;
      await this.stopServer();
      this.restarting = false;
    }

    await this.startServer();
  }

  private async downloadServer() {
    try {
      const path = await this.downloadServerExec(true);
      vscode.window.showInformationMessage(`php-cs-fixer-lsp downloaded to ${path}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      vscode.window.showErrorMessage(`php-cs-fixer-lsp failed to download: ${message}`);
      this.output.appendLine('download failed');
      this.output.appendLine(errorText(error));
    }
  }

  private async resolveServerExec(config: vscode.WorkspaceConfiguration) {
    const configured = config.get<string>('serverExec', '').trim();
    if (configured) {
      return configured;
    }

    return await this.downloadServerExec(false);
  }

  private async downloadServerExec(update: boolean) {
    interface ExecMeta {
      tag: string;
      downloadedAt: string;
    }

    const storageDir = join(this.context.globalStorageUri.fsPath, 'server');
    await mkdir(storageDir, { recursive: true });

    const execPath = join(storageDir, SERVER_ASSET);
    const metaPath = join(storageDir, `${SERVER_ASSET}.json`);

    if (!update && await fileExists(execPath)) {
      return execPath;
    }

    const current = await readJson<ExecMeta>(metaPath);
    const latest = await fetchLatestReleaseAsset(SERVER_REPO, SERVER_ASSET);
    if (current?.tag === latest.tag && await fileExists(execPath)) {
      return execPath;
    }

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Downloading php-cs-fixer-lsp',
        cancellable: false,
      },
      async (progress) => {
        const execTmp = `${execPath}.tmp`;
        await download(latest.url, execTmp, progress);
        await rename(execTmp, execPath);
        await chmod(execPath, 0o755);
      },
    );

    const meta: ExecMeta = {
      tag: latest.tag,
      downloadedAt: new Date().toISOString(),
    };

    await writeFile(metaPath, JSON.stringify(meta, null, 2), 'utf8');

    return execPath;
  }

  private getExtensionConfig() {
    return vscode.workspace.getConfiguration('php-cs-fixer-lsp');
  }
}
