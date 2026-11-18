import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { WebSocketServer } from 'ws';
import { Hub } from './hub';
import { ClineAdapter } from './adapters/cline';

// ---------------------------------------------------------------------------
// Agent Bridge — Phase 2
// WebSocket server for phone UI, hub for routing/policy, ClineAdapter for
// Cline integration. Reads-only: never writes to Cline's files.
// ---------------------------------------------------------------------------

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Agent Bridge');
  output.appendLine('=== Agent Bridge activated ===');
  output.appendLine(`Time: ${new Date().toISOString()}`);
  output.appendLine('');

  // 1. Get Cline's exports
  const clineExt: any = vscode.extensions.getExtension('saoudrizwan.claude-dev');
  if (!clineExt) {
    output.appendLine('ERROR: Cline extension (saoudrizwan.claude-dev) is not installed.');
    output.show(true);
    return;
  }
  const cline = (clineExt.exports as Record<string, unknown>) || {};
  const methodNames = cline ? Object.keys(cline) : [];
  output.appendLine(`Cline exported methods: ${methodNames.join(', ') || '(none)'}`);
  output.appendLine('');

  const callCline = (name: string, ...args: unknown[]): unknown => {
    const fn = cline[name];
    if (typeof fn !== 'function') {
      const msg = `Cline ${name} is not available.`;
      output.appendLine(msg);
      throw new Error(msg);
    }
    return fn(...args);
  };

  // 2. Load policy.json
  const policyPath = path.join(context.extensionPath, 'media', 'policy.json');
  let policy: any[] = [];
  try {
    policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  } catch (e) {
    output.appendLine(`WARN: could not load policy.json: ${e}`);
  }
  output.appendLine(`Policy rules: ${policy.length}`);
  output.appendLine('');

  // 3. Audit log (JSONL to extension global storage)
  const auditLogPath = path.join(context.globalStorageUri.fsPath, 'audit.log');
  function auditLog(entry: string): void {
    const line = JSON.stringify({ t: new Date().toISOString(), msg: entry }) + '\n';
    try { fs.appendFileSync(auditLogPath, line); } catch {}
    output.appendLine(entry);
  }
  output.appendLine(`Audit log: ${auditLogPath}`);
  output.appendLine('');

  // 4. Derive Cline's global storage directory
  let clineStorageDir: string | undefined;
  if (clineExt.globalStorageUri?.fsPath) {
    clineStorageDir = clineExt.globalStorageUri.fsPath;
    output.appendLine(`Cline storage: ${clineStorageDir}`);
  } else {
    const ourDir = path.dirname(context.globalStorageUri.fsPath);
    clineStorageDir = path.join(ourDir, 'saoudrizwan.claude-dev');
    output.appendLine(`Derived Cline storage: ${clineStorageDir}`);
  }
  output.appendLine('');

  // 5. Create Hub
  const hub = new Hub(policy, auditLog);

  // Wire hub callbacks to Cline's exported API
  hub.setOnPrompt((text: string) => {
    output.appendLine(`HUB->Cline startNewTask: ${text}`);
    callCline('startNewTask', text);
  });
  hub.setOnApprove((id: string) => {
    output.appendLine(`HUB->Cline pressPrimaryButton (approve ${id})`);
    callCline('pressPrimaryButton');
  });
  hub.setOnReject((id: string, reason: string) => {
    output.appendLine(`HUB->Cline pressSecondaryButton (reject ${id}: ${reason})`);
    callCline('pressSecondaryButton');
  });
  hub.setOnCancel(() => {
    output.appendLine(`HUB->Cline pressSecondaryButton (cancel)`);
    callCline('pressSecondaryButton');
  });

  // 6. ClineAdapter (created on first phone connection)
  let clineAdapter: ClineAdapter | null = null;

  // ----- Storage watcher: tail Cline's JSONL, feed adapter events -----

  interface FileState { size: number; mtimeMs: number }
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
          if (lower.endsWith('.jsonl')) results.push(full);
        }
      }
    } catch {}
    return results.sort((a, b) => b.localeCompare(a));
  }

  const fileOffsets = new Map<string, number>();

  function readNewLines(file: string): string[] {
    const prevOffset = fileOffsets.get(file) ?? 0;
    let content: string;
    try { content = fs.readFileSync(file, 'utf8'); }
    catch { return []; }
    const lines = content.split(/\r?\n/).filter(l => l.trim().length > 0);
    const newLines = lines.slice(prevOffset);
    if (newLines.length > 0) {
      fileOffsets.set(file, lines.length);
    }
    return newLines;
  }

  const SECRET_RE = /(sk-[A-Za-z0-9]{20,}|[A-Za-z0-9]{32,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*)/g;
  function redact(text: string): string {
    return text.replace(SECRET_RE, '[REDACTED]');
  }

  function summarizeJsonlLine(line: string): string {
    try {
      const parsed = JSON.parse(line);
      return redact(JSON.stringify(parsed).slice(0, 300));
    } catch {
      return `RAW: ${redact(line.slice(0, 200))}${line.length > 200 ? '...' : ''}`;
    }
  }

  let askSeq = 0;

  function feedJsonlLine(line: string): void {
    let parsed: any;
    try { parsed = JSON.parse(line); } catch { return; }
    if (!parsed || typeof parsed !== 'object') return;
    const { type, say, ask, text, reasoning, partial } = parsed;
    const body = typeof text === 'string' ? text : (typeof reasoning === 'string' ? reasoning : '');
    if (!body) return;

    switch (type) {
      case 'say': {
        const kind = String(say || '');
        if (kind === 'reasoning' || kind === 'thinking') {
          clineAdapter?.think(body);
        } else if (kind === 'text' || kind === 'error' || kind === 'user_message' || kind === '') {
          clineAdapter?.say(body, partial !== false);
        } else if (kind === 'api_req_started') {
          clineAdapter?.state('working');
        } else if (kind === 'api_req_finished') {
          clineAdapter?.state('done');
        } else {
          clineAdapter?.say(body, partial !== false);
        }
        break;
      }
      case 'ask': {
        const kind = String(ask || 'other');
        const id = `ask-${++askSeq}`;
        const k = kind as 'command' | 'edit' | 'other';
        if (kind === 'command') clineAdapter?.ask(id, 'command', body);
        else if (kind === 'followup') clineAdapter?.ask(id, 'other', body);
        else clineAdapter?.ask(id, k, body);
        break;
      }
      case 'state':
        clineAdapter?.state(parsed.status ?? 'done', parsed.progress);
        break;
      default:
        output.appendLine(`JSONL: ${redact(summarizeJsonlLine(line))}`);
    }
  }

  let pollTimer: NodeJS.Timeout | null = null;
  let watcher: fs.FSWatcher | null = null;

  function pollStorage(dir: string): void {
    for (const f of discoverFiles(dir)) {
      try {
        const stat = fs.statSync(f);
        const prev = watchedFiles.get(f);
        if (!prev || prev.size !== stat.size || prev.mtimeMs !== stat.mtimeMs) {
          watchedFiles.set(f, { size: stat.size, mtimeMs: stat.mtimeMs });
          const lines = readNewLines(f);
          for (const ln of lines) feedJsonlLine(ln);
        }
      } catch {}
    }
  }

  function startWatching(dir: string): void {
    output.appendLine(`Watching storage dir: ${dir}`);
    const files = discoverFiles(dir);
    for (const f of files) {
      try { watchedFiles.set(f, fs.statSync(f)); } catch {}
    }
    try {
      watcher = fs.watch(dir, { recursive: true }, () => {
        setTimeout(() => pollStorage(dir), 100);
      });
      output.appendLine('fs.watch active.');
    } catch (e) {
      output.appendLine(`fs.watch failed: ${e}; polling only.`);
    }
    pollTimer = setInterval(() => pollStorage(dir), 500);
    output.appendLine('Polling at 500 ms interval.');
  }

  // 7. WebSocket server (127.0.0.1 only)
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 9876 });
  output.appendLine('WebSocket server: ws://127.0.0.1:9876');

  wss.on('connection', (ws: WebSocket) => {
    output.appendLine('Phone WebSocket connected');
    hub.setPhoneWebSocket(ws);

    if (!clineAdapter) {
      clineAdapter = new ClineAdapter(
        (m: any) => hub.handleIncoming(m),
        auditLog
      );
      clineAdapter.onEvent((event: any) => {
        const out: any = { t: event.type, agent: 'cline' };
        if (event.type === 'say') { out.text = event.text; out.partial = event.partial; }
        if (event.type === 'think') { out.text = event.text; }
        if (event.type === 'ask') { out.id = event.id; out.kind = event.kind; out.text = event.text; }
        if (event.type === 'state') { out.status = event.status; out.progress = event.progress; }
        hub.sendToPhone(out);
      });
    }
  });

  wss.on('error', (e: Error) => {
    output.appendLine(`WebSocket server error: ${e.message}`);
  });

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand('agent-bridge.spike', async () => {
      output.appendLine('--- Command: Agent Bridge: Spike ---');
      if (!cline || typeof (cline.startNewTask as any) !== 'function') {
        output.appendLine('ERROR: Cline startNewTask is not available.');
        output.show(true);
        return;
      }
      try {
        await callCline('startNewTask', 'Say hello and list the files in the workspace root');
        output.appendLine('startNewTask completed.');
      } catch (e) {
        output.appendLine(`startNewTask error: ${e}`);
      }
      if (clineStorageDir && fs.existsSync(clineStorageDir)) {
        if (!watcher && !pollTimer) startWatching(clineStorageDir);
      } else {
        output.appendLine(`Cline storage dir not found yet: ${clineStorageDir}`);
      }
      output.show(true);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('agent-bridge.show-pairing', () => {
      const url = 'ws://127.0.0.1:9876/ws';
      output.appendLine(`Pairing URL: ${url}`);
      vscode.window.showInformationMessage(`Agent Bridge pairing URL: ${url}`);
      output.show(true);
    })
  );

  output.appendLine('Setup complete. Run "Agent Bridge: Show Pairing URL" to get the WebSocket URL.');
  output.show(true);
}

export function deactivate(): void {
  // nothing to clean up (WebSocket server closed on extension deactivate)
}
