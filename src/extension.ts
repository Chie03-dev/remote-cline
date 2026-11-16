import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Agent Bridge — Phase 1 Spike
//
// Reads-only inspection of Cline's exported API and on-disk session storage.
// Writes nothing to Cline's files. All output goes to the
// "Agent Bridge Spike" Output Channel.
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Agent Bridge Spike');
  output.appendLine('=== Agent Bridge Spike activated ===');
  output.appendLine(`Time: ${new Date().toISOString()}`);
  output.appendLine('');

  // ------------------------------------------------------------------
  // 1. Get Cline's exports and log the available methods
  // ------------------------------------------------------------------
  const clineExt: any = vscode.extensions.getExtension('saoudrizwan.claude-dev');
  if (!clineExt) {
    output.appendLine('ERROR: Cline extension (saoudrizwan.claude-dev) is not installed.');
    output.show(true);
    return;
  }

  const cline = (clineExt.exports as Record<string, unknown>) || {};
  const methodNames = cline ? Object.keys(cline) : [];
  output.appendLine(`Cline extension id: ${clineExt.id}`);
  output.appendLine(`Cline extensionUri: ${clineExt.extensionUri.fsPath}`);
  output.appendLine(`Cline globalStorageUri: ${clineExt.globalStorageUri?.fsPath}`);
  output.appendLine(`Our globalStorageUri: ${context.globalStorageUri.fsPath}`);
  output.appendLine(`Cline exported methods (${methodNames.length}): ${methodNames.join(', ') || '(none)'}`);
  for (const name of methodNames) {
    output.appendLine(`  ${name}: ${typeof cline[name]}`);
  }
  output.appendLine('');

  // ------------------------------------------------------------------
  // 2. Locate Cline's global storage folder.
  //    Prefer clineExt.globalStorageUri; fall back to deriving the sibling
  //    folder from our own globalStorageUri.
  // ------------------------------------------------------------------
  let clineStorageDir: string | undefined;
  if (clineExt.globalStorageUri?.fsPath) {
    clineStorageDir = clineExt.globalStorageUri.fsPath;
    output.appendLine(`Using Cline globalStorageUri: ${clineStorageDir}`);
  } else {
    const ourDir = path.dirname(context.globalStorageUri.fsPath);
    clineStorageDir = path.join(ourDir, 'saoudrizwan.claude-dev');
    output.appendLine(`Derived Cline storage (sibling): ${clineStorageDir}`);
  }
  output.appendLine('');
  // ------------------------------------------------------------------
  // 3. Discover storage artifacts (read-only).
  //    Prioritize .jsonl session files. Also track sessions.db (+ WAL/SHM).
  // ------------------------------------------------------------------
  const SECRET_RE = /(sk-[A-Za-z0-9]{20,}|[A-Za-z0-9]{32,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*)/g;

  function redact(text: string): string {
    return text.replace(SECRET_RE, '[REDACTED]');
  }

  function summarizeJsonlLine(line: string): string {
    if (!line.trim()) return '(empty line)';
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return `RAW: ${redact(line.slice(0, 200))}${line.length > 200 ? '...' : ''}`;
    }
    return `JSON: ${redact(JSON.stringify(parsed).slice(0, 300))}`;
  }

  interface FileState {
    size: number;
    mtimeMs: number;
  }

  const watchedFiles = new Map<string, FileState>();

  function discoverFiles(dir: string): string[] {
    const results: string[] = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...discoverFiles(full));
        } else {
          const lower = entry.name.toLowerCase();
          if (lower.endsWith('.jsonl') || lower.endsWith('.db') || lower.endsWith('-wal') || lower.endsWith('-shm')) {
            results.push(full);
          }
        }
      }
    } catch (e) {
      output.appendLine(`Could not list storage dir ${dir}: ${e}`);
    }
    results.sort((a, b) => {
      const rank = (f: string) => {
        const l = f.toLowerCase();
        if (l.endsWith('.jsonl')) return 0;
        if (l.endsWith('.db')) return 1;
        if (l.endsWith('-wal')) return 2;
        return 3;
      };
      return rank(a) - rank(b);
    });
    return results;
  }

  // ------------------------------------------------------------------
  // 4. Log a storage change: timestamp, size, message count, last 3 msgs
  // ------------------------------------------------------------------
  function logStorageChange(file: string, reason: string): void {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(file);
    } catch {
      return;
    }
    const prev = watchedFiles.get(file);
    watchedFiles.set(file, { size: stat.size, mtimeMs: stat.mtimeMs });

    const lower = file.toLowerCase();
    output.appendLine(`[${new Date().toISOString()}] ${reason} :: ${file}`);
    output.appendLine(`  size=${stat.size} mtime=${new Date(stat.mtime).toISOString()}`);

    if (lower.endsWith('.jsonl')) {
      let lines: string[] = [];
      try {
        const content = fs.readFileSync(file, 'utf8');
        lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
      } catch (e) {
        output.appendLine(`  read error: ${e}`);
        return;
      }
      output.appendLine(`  message lines=${lines.length}`);
      const last3 = lines.slice(-3);
      for (const ln of last3) {
        output.appendLine(`  last: ${redact(summarizeJsonlLine(ln))}`);
      }
    } else if (lower.endsWith('.db') || lower.endsWith('-wal') || lower.endsWith('-shm')) {
      output.appendLine('  (SQLite/WAL/SHM — read-only: size & mtime logged above, no content read)');
    }
    output.appendLine('');
  }
  // ------------------------------------------------------------------
  // 5. Watch storage: fs.watch with 500 ms polling fallback (Windows)
  // ------------------------------------------------------------------
  let pollTimer: NodeJS.Timeout | null = null;
  let watcher: fs.FSWatcher | null = null;

  function startWatching(dir: string): void {
    output.appendLine(`Watching storage dir: ${dir}`);
    // initial discovery + log
    const files = discoverFiles(dir);
    output.appendLine(`Discovered ${files.length} tracked file(s):`);
    for (const f of files) {
      output.appendLine(`  - ${f}`);
      logStorageChange(f, 'initial');
    }

    // Try fs.watch on the directory (recursive not reliably supported on Windows)
    try {
      watcher = fs.watch(dir, { recursive: true }, (eventType, filename) => {
        if (!filename) return;
        const full = path.join(dir, filename);
        const lower = filename.toLowerCase();
        if (lower.endsWith('.jsonl') || lower.endsWith('.db') || lower.endsWith('-wal') || lower.endsWith('-shm')) {
          output.appendLine(`fs.watch event: ${eventType} ${filename}`);
          setTimeout(() => logStorageChange(full, 'watch'), 100);
        }
      });
      output.appendLine('fs.watch active (recursive).');
    } catch (e) {
      output.appendLine(`fs.watch failed: ${e}; falling back to polling.`);
    }

    // 500 ms polling fallback / supplement
    pollTimer = setInterval(() => {
      const files = discoverFiles(dir);
      for (const f of files) {
        try {
          const stat = fs.statSync(f);
          const prev = watchedFiles.get(f);
          if (!prev || prev.size !== stat.size || prev.mtimeMs !== stat.mtimeMs) {
            logStorageChange(f, 'poll');
          }
        } catch {
          // file may have been removed
        }
      }
    }, 500);
    output.appendLine('Polling at 500 ms interval.');
  }

  // ------------------------------------------------------------------
  // 6. Register the "Agent Bridge: Spike" command
  // ------------------------------------------------------------------
  context.subscriptions.push(
    vscode.commands.registerCommand('agent-bridge.spike', async () => {
      output.appendLine('--- Command: Agent Bridge: Spike ---');
      if (!cline || typeof cline.startNewTask !== 'function') {
        output.appendLine('ERROR: Cline startNewTask is not available.');
        output.show(true);
        return;
      }
      try {
        await (cline.startNewTask as (...args: unknown[]) => Promise<unknown>)(
          'Say hello and list the files in the workspace root'
        );
        output.appendLine('startNewTask("Say hello and list the files in the workspace root") completed.');
      } catch (e) {
        output.appendLine(`startNewTask error: ${e}`);
      }
      // Kick off storage watching now that a task may exist
      if (clineStorageDir && fs.existsSync(clineStorageDir)) {
        if (!watcher && !pollTimer) {
          startWatching(clineStorageDir);
        }
      } else {
        output.appendLine(`Cline storage dir not found yet: ${clineStorageDir}`);
        output.appendLine('(Create a task in Cline first, then re-run this command.)');
      }
      output.show(true);
    })
  );

  // Start watching immediately if storage already exists
  if (clineStorageDir && fs.existsSync(clineStorageDir)) {
    startWatching(clineStorageDir);
  }

  output.appendLine('Setup complete. Run "Agent Bridge: Spike" to start a task and watch storage.');
  output.show(true);
}

export function deactivate(): void {
  // nothing to clean up (no writes were ever made to Cline's files)
}


