import * as child_process from "node:child_process";
import { exec } from "node:child_process";

import { Range } from "core";
import { EXTENSION_NAME } from "core/control-plane/env";
import * as URI from "uri-js";
import * as vscode from "vscode";

import {
  executeGotoProvider,
  executeSignatureHelpProvider,
} from "./autocomplete/lsp";
import { Repository } from "./otherExtensions/git";
import { SecretStorage } from "./stubs/SecretStorage";
import { VsCodeIdeUtils } from "./util/ideUtils";
import { getExtensionUri, openEditorAndRevealRange } from "./util/vscode";
import { VsCodeWebviewProtocol } from "./webviewProtocol";

import type {
  FileStatsMap,
  FileType,
  IDE,
  IdeInfo,
  IdeSettings,
  IndexTag,
  Location,
  Problem,
  RangeInFile,
  SignatureHelp,
  TerminalOptions,
  Thread,
} from "core";
import { getExtensionVersion, isExtensionPrerelease } from "./util/util";

class VsCodeIde implements IDE {
  ideUtils: VsCodeIdeUtils;
  secretStorage: SecretStorage;

  constructor(
    private readonly vscodeWebviewProtocolPromise: Promise<VsCodeWebviewProtocol>,
    private readonly context: vscode.ExtensionContext,
  ) {
    this.ideUtils = new VsCodeIdeUtils();
    this.secretStorage = new SecretStorage(context);
  }

  async readSecrets(keys: string[]): Promise<Record<string, string>> {
    const secretValuePromises = keys.map((key) => this.secretStorage.get(key));
    const secretValues = await Promise.all(secretValuePromises);

    return keys.reduce(
      (acc, key, index) => {
        if (secretValues[index] === undefined) {
          return acc;
        }

        acc[key] = secretValues[index];
        return acc;
      },
      {} as Record<string, string>,
    );
  }

  async writeSecrets(secrets: { [key: string]: string }): Promise<void> {
    for (const [key, value] of Object.entries(secrets)) {
      await this.secretStorage.store(key, value);
    }
  }

  async fileExists(uri: string): Promise<boolean> {
    try {
      const stat = await this.ideUtils.stat(vscode.Uri.parse(uri));
      return stat !== null;
    } catch (error) {
      if (error instanceof vscode.FileSystemError) {
        return false;
      }
      throw error;
    }
  }

  async gotoDefinition(location: Location): Promise<RangeInFile[]> {
    const result = await executeGotoProvider({
      uri: vscode.Uri.parse(location.filepath),
      line: location.position.line,
      character: location.position.character,
      name: "vscode.executeDefinitionProvider",
    });

    return result;
  }

  async gotoTypeDefinition(location: Location): Promise<RangeInFile[]> {
    const result = await executeGotoProvider({
      uri: vscode.Uri.parse(location.filepath),
      line: location.position.line,
      character: location.position.character,
      name: "vscode.executeTypeDefinitionProvider",
    });

    return result;
  }

  async getSignatureHelp(location: Location): Promise<SignatureHelp | null> {
    const result = await executeSignatureHelpProvider({
      uri: vscode.Uri.parse(location.filepath),
      line: location.position.line,
      character: location.position.character,
      name: "vscode.executeSignatureHelpProvider",
    });

    return result;
  }

  onDidChangeActiveTextEditor(callback: (uri: string) => void): void {
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (editor) {
        callback(editor.document.uri.toString());
      }
    });
  }

  showToast: IDE["showToast"] = async (...params) => {
    const [type, message, ...otherParams] = params;
    const { showErrorMessage, showWarningMessage, showInformationMessage } =
      vscode.window;

    switch (type) {
      case "error":
        return showErrorMessage(message, "Show logs").then((selection) => {
          if (selection === "Show logs") {
            vscode.commands.executeCommand("workbench.action.toggleDevTools");
          }
        });
      case "info":
        return showInformationMessage(message, ...otherParams);
      case "warning":
        return showWarningMessage(message, ...otherParams);
    }
  };

  async getRepoName(dir: string): Promise<string | undefined> {
    const repo = await this.getRepo(dir);
    const remotes = repo?.state.remotes;
    if (!remotes) {
      return undefined;
    }
    const remote =
      remotes?.find((r: any) => r.name === "origin") ?? remotes?.[0];
    if (!remote) {
      return undefined;
    }
    const ownerAndRepo = remote.fetchUrl
      ?.replace(".git", "")
      .split("/")
      .slice(-2);
    return ownerAndRepo?.join("/");
  }

  async getTags(artifactId: string): Promise<IndexTag[]> {
    const workspaceDirs = await this.getWorkspaceDirs();

    const branches = await Promise.all(
      workspaceDirs.map((dir) => this.getBranch(dir)),
    );

    const tags: IndexTag[] = workspaceDirs.map((directory, i) => ({
      directory,
      branch: branches[i],
      artifactId,
    }));

    return tags;
  }

  getIdeInfo(): Promise<IdeInfo> {
    return Promise.resolve({
      ideType: "vscode",
      name: vscode.env.appName,
      version: vscode.version,
      remoteName: vscode.env.remoteName || "local",
      extensionVersion: getExtensionVersion(),
      isPrerelease: isExtensionPrerelease(),
    });
  }

  readRangeInFile(fileUri: string, range: Range): Promise<string> {
    return this.ideUtils.readRangeInFile(
      vscode.Uri.parse(fileUri),
      new vscode.Range(
        new vscode.Position(range.start.line, range.start.character),
        new vscode.Position(range.end.line, range.end.character),
      ),
    );
  }

  async getFileStats(files: string[]): Promise<FileStatsMap> {
    const pathToLastModified: FileStatsMap = {};
    await Promise.all(
      files.map(async (file) => {
        const stat = await this.ideUtils.stat(
          vscode.Uri.parse(file),
          false /* No need to catch ENOPRO exceptions */,
        );
        pathToLastModified[file] = {
          lastModified: stat!.mtime,
          size: stat!.size,
        };
      }),
    );

    return pathToLastModified;
  }

  async getRepo(dir: string): Promise<Repository | undefined> {
    return this.ideUtils.getRepo(vscode.Uri.parse(dir));
  }

  async isTelemetryEnabled(): Promise<boolean> {
    const globalEnabled = vscode.env.isTelemetryEnabled;
    const continueEnabled: boolean =
      (await vscode.workspace
        .getConfiguration(EXTENSION_NAME)
        .get("telemetryEnabled")) ?? true;
    return globalEnabled && continueEnabled;
  }

  isWorkspaceRemote(): Promise<boolean> {
    return Promise.resolve(vscode.env.remoteName !== undefined);
  }

  getUniqueId(): Promise<string> {
    return Promise.resolve(vscode.env.machineId);
  }

  async getDiff(includeUnstaged: boolean): Promise<string[]> {
    return await this.ideUtils.getDiff(includeUnstaged);
  }

  async getClipboardContent() {
    return this.context.workspaceState.get("continue.copyBuffer", {
      text: "",
      copiedAt: new Date("1900-01-01").toISOString(),
    });
  }

  async getTerminalContents(): Promise<string> {
    return await this.ideUtils.getTerminalContents(1);
  }

  async getDebugLocals(threadIndex: number): Promise<string> {
    return await this.ideUtils.getDebugLocals(threadIndex);
  }

  async getTopLevelCallStackSources(
    threadIndex: number,
    stackDepth: number,
  ): Promise<string[]> {
    return await this.ideUtils.getTopLevelCallStackSources(
      threadIndex,
      stackDepth,
    );
  }
  async getAvailableThreads(): Promise<Thread[]> {
    return await this.ideUtils.getAvailableThreads();
  }

  async getWorkspaceDirs(): Promise<string[]> {
    return this.ideUtils.getWorkspaceDirectories().map((uri) => uri.toString());
  }

  async writeFile(fileUri: string, contents: string): Promise<void> {
    await vscode.workspace.fs.writeFile(
      vscode.Uri.parse(fileUri),
      Buffer.from(contents),
    );
  }

  async showVirtualFile(title: string, contents: string): Promise<void> {
    this.ideUtils.showVirtualFile(title, contents);
  }

  async openFile(fileUri: string): Promise<void> {
    await this.ideUtils.openFile(vscode.Uri.parse(fileUri));
  }

  async showLines(
    fileUri: string,
    startLine: number,
    endLine: number,
  ): Promise<void> {
    const range = new vscode.Range(
      new vscode.Position(startLine, 0),
      new vscode.Position(endLine, 0),
    );
    openEditorAndRevealRange(vscode.Uri.parse(fileUri), range).then(
      (editor) => {
        // Select the lines
        editor.selection = new vscode.Selection(
          new vscode.Position(startLine, 0),
          new vscode.Position(endLine, 0),
        );
      },
    );
  }

  async runCommand(
    command: string,
    options: TerminalOptions = { reuseTerminal: true },
  ): Promise<void> {
    let terminal: vscode.Terminal | undefined;
    if (vscode.window.terminals.length && options.reuseTerminal) {
      if (options.terminalName) {
        terminal = vscode.window.terminals.find(
          (t) => t?.name === options.terminalName,
        );
      } else {
        terminal = vscode.window.activeTerminal ?? vscode.window.terminals[0];
      }
    }

    if (!terminal) {
      terminal = vscode.window.createTerminal(options?.terminalName);
    }
    terminal.show();
    terminal.sendText(command, false);
  }

  async saveFile(fileUri: string): Promise<void> {
    await this.ideUtils.saveFile(vscode.Uri.parse(fileUri));
  }

  private static MAX_BYTES = 100000;

  async readFile(fileUri: string): Promise<string> {
    try {
      const uri = vscode.Uri.parse(fileUri);

      // First, check whether it's a notebook document
      // Need to iterate over the cells to get full contents
      const notebook =
        vscode.workspace.notebookDocuments.find((doc) =>
          URI.equal(doc.uri.toString(), uri.toString()),
        ) ??
        (uri.path.endsWith("ipynb")
          ? await vscode.workspace.openNotebookDocument(uri)
          : undefined);
      if (notebook) {
        return notebook
          .getCells()
          .map((cell) => cell.document.getText())
          .join("\n\n");
      }

      // Check whether it's an open document
      const openTextDocument = vscode.workspace.textDocuments.find((doc) =>
        URI.equal(doc.uri.toString(), uri.toString()),
      );
      if (openTextDocument !== undefined) {
        return openTextDocument.getText();
      }

      const fileStats = await this.ideUtils.stat(uri);
      if (fileStats === null || fileStats.size > 10 * VsCodeIde.MAX_BYTES) {
        return "";
      }

      const bytes = await this.ideUtils.readFile(uri);
      if (bytes === null) {
        return "";
      }

      // Truncate the buffer to the first MAX_BYTES
      const truncatedBytes = bytes.slice(0, VsCodeIde.MAX_BYTES);
      const contents = new TextDecoder().decode(truncatedBytes);
      return contents;
    } catch (e) {
      return "";
    }
  }

  async openUrl(url: string): Promise<void> {
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  async getOpenFiles(): Promise<string[]> {
    return this.ideUtils.getOpenFiles().map((uri) => uri.toString());
  }

  async getCurrentFile() {
    if (!vscode.window.activeTextEditor) {
      return undefined;
    }
    return {
      isUntitled: vscode.window.activeTextEditor.document.isUntitled,
      path: vscode.window.activeTextEditor.document.uri.toString(),
      contents: vscode.window.activeTextEditor.document.getText(),
    };
  }

  async getPinnedFiles(): Promise<string[]> {
    const tabArray = vscode.window.tabGroups.all[0].tabs;

    return tabArray
      .filter((t) => t.isPinned)
      .map((t) => (t.input as vscode.TabInputText).uri.toString());
  }

  runRipgrepQuery(dirUri: string, args: string[]) {
    const relativeDir = vscode.Uri.parse(dirUri).fsPath;
    const ripGrepUri = vscode.Uri.joinPath(
      getExtensionUri(),
      "out/node_modules/@vscode/ripgrep/bin/rg",
    );
    const p = child_process.spawn(ripGrepUri.fsPath, args, {
      cwd: relativeDir,
    });
    let output = "";

    p.stdout.on("data", (data) => {
      output += data.toString();
    });

    return new Promise<string>((resolve, reject) => {
      p.on("error", reject);
      p.on("close", (code) => {
        if (code === 0) {
          resolve(output);
        } else if (code === 1) {
          // No matches
          resolve("No matches found");
        } else {
          reject(new Error(`Process exited with code ${code}`));
        }
      });
    });
  }

  async getFileResults(
    pattern: string,
    maxResults?: number,
  ): Promise<string[]> {
    if (vscode.env.remoteName) {
      // TODO better tests for this remote search implementation
      // throw new Error("Ripgrep not supported, this workspace is remote");

      // IMPORTANT: findFiles automatically accounts for .gitignore
      const ignoreFiles = await vscode.workspace.findFiles(
        "**/.continueignore",
        null,
      );

      const ignoreGlobs: Set<string> = new Set();
      for (const file of ignoreFiles) {
        const content = await this.ideUtils.readFile(file);
        if (content === null) {
          continue;
        }
        const filePath = vscode.workspace.asRelativePath(file);
        const fileDir = filePath
          .replace(/\\/g, "/")
          .replace(/\/$/, "")
          .split("/")
          .slice(0, -1)
          .join("/");

        const patterns = Buffer.from(content)
          .toString()
          .split("\n")
          .map((line) => line.trim())
          .filter(
            (line) => line && !line.startsWith("#") && !pattern.startsWith("!"),
          );
        // VSCode does not support negations

        patterns
          // Handle prefix
          .map((pattern) => {
            const normalizedPattern = pattern.replace(/\\/g, "/");

            if (normalizedPattern.startsWith("/")) {
              if (fileDir) {
                return `{/,}${normalizedPattern}`;
              } else {
                return `${fileDir}/${normalizedPattern.substring(1)}`;
              }
            } else {
              if (fileDir) {
                return `${fileDir}/${normalizedPattern}`;
              } else {
                return `**/${normalizedPattern}`;
              }
            }
          })
          // Handle suffix
          .map((pattern) => {
            return pattern.endsWith("/") ? `${pattern}**/*` : pattern;
          })
          .forEach((pattern) => {
            ignoreGlobs.add(pattern);
          });
      }

      const ignoreGlobsArray = Array.from(ignoreGlobs);

      const results = await vscode.workspace.findFiles(
        pattern,
        ignoreGlobs.size ? `{${ignoreGlobsArray.join(",")}}` : null,
        maxResults,
      );
      return results.map((result) => vscode.workspace.asRelativePath(result));
    } else {
      const results: string[] = [];
      for (const dir of await this.getWorkspaceDirs()) {
        const dirResults = await this.runRipgrepQuery(dir, [
          "--files",
          "--iglob",
          pattern,
          "--ignore-file",
          ".continueignore",
          "--ignore-file",
          ".gitignore",
          ...(maxResults ? ["--max-count", String(maxResults)] : []),
        ]);

        results.push(dirResults);
      }

      const allResults = results.join("\n").split("\n");
      if (maxResults) {
        // In the case of multiple workspaces, maxResults will be applied to each workspace
        // And then the combined results will also be truncated
        return allResults.slice(0, maxResults);
      } else {
        return allResults;
      }
    }
  }

  async getSearchResults(query: string, maxResults?: number): Promise<string> {
    if (vscode.env.remoteName) {
      throw new Error("Ripgrep not supported, this workspace is remote");
    }
    const results: string[] = [];
    for (const dir of await this.getWorkspaceDirs()) {
      const dirResults = await this.runRipgrepQuery(dir, [
        "-i", // Case-insensitive search
        "--ignore-file",
        ".continueignore",
        "--ignore-file",
        ".gitignore",
        "-C",
        "2", // Show 2 lines of context
        "--heading", // Only show filepath once per result
        ...(maxResults ? ["-m", maxResults.toString()] : []),
        "-e",
        query, // Pattern to search for
        ".", // Directory to search in
      ]);

      results.push(dirResults);
    }

    const allResults = results.join("\n");
    if (maxResults) {
      // In case of multiple workspaces, do max results per workspace and then truncate to maxResults
      // Will prioritize first workspace results, fine for now
      // Results are separated by either ./ or --
      const matches = Array.from(allResults.matchAll(/(\n--|\n\.\/)/g));
      if (matches.length > maxResults) {
        return allResults.substring(0, matches[maxResults].index);
      } else {
        return allResults;
      }
    } else {
      return allResults;
    }
  }

  async getProblems(fileUri?: string | undefined): Promise<Problem[]> {
    const uri = fileUri
      ? vscode.Uri.parse(fileUri)
      : vscode.window.activeTextEditor?.document.uri;
    if (!uri) {
      return [];
    }
    return vscode.languages.getDiagnostics(uri).map((d) => {
      return {
        filepath: uri.toString(),
        range: {
          start: {
            line: d.range.start.line,
            character: d.range.start.character,
          },
          end: { line: d.range.end.line, character: d.range.end.character },
        },
        message: d.message,
      };
    });
  }

  async subprocess(command: string, cwd?: string): Promise<[string, string]> {
    return new Promise((resolve, reject) => {
      exec(command, { cwd }, (error, stdout, stderr) => {
        if (error) {
          console.warn(error);
          reject(stderr);
        }
        resolve([stdout, stderr]);
      });
    });
  }

  async getBranch(dir: string): Promise<string> {
    return this.ideUtils.getBranch(vscode.Uri.parse(dir));
  }

  async getGitRootPath(dir: string): Promise<string | undefined> {
    const root = await this.ideUtils.getGitRoot(vscode.Uri.parse(dir));
    return root?.toString();
  }

  async listDir(dir: string): Promise<[string, FileType][]> {
    const entries = await this.ideUtils.readDirectory(vscode.Uri.parse(dir));
    return entries === null ? [] : (entries as any);
  }

  private getIdeSettingsSync(): IdeSettings {
    const settings = vscode.workspace.getConfiguration(EXTENSION_NAME);
    const remoteConfigServerUrl = settings.get<string | undefined>(
      "remoteConfigServerUrl",
      undefined,
    );
    const ideSettings: IdeSettings = {
      remoteConfigServerUrl,
      remoteConfigSyncPeriod: settings.get<number>(
        "remoteConfigSyncPeriod",
        60,
      ),
      userToken: settings.get<string>("userToken", ""),
      continueTestEnvironment: "production",
      pauseCodebaseIndexOnStart: settings.get<boolean>(
        "pauseCodebaseIndexOnStart",
        false,
      ),
    };
    return ideSettings;
  }

  async getIdeSettings(): Promise<IdeSettings> {
    const ideSettings = this.getIdeSettingsSync();
    return ideSettings;
  }
}

export { VsCodeIde };
