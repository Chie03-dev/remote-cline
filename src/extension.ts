import * as vscode from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
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

  // 4. Derive Cline's data directory (~/.cline/data) and sessions dir
  const clineDataDir = path.join(os.homedir(), '.cline', 'data');
  const sessionsDir = path.join(clineDataDir, 'sessions');
  output.appendLine(`Cline data dir: ${clineDataDir}`);
  output.appendLine(`Sessions dir: ${sessionsDir}`);
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

  // ----- Storage watcher: tail Cline's session messages.json, feed adapter events -----

  interface MsgFileState { processedMsgs: number }
  const msgFileStates = new Map<string, MsgFileState>();

  interface SessionStatusState { status: string }
  const sessionStatus = new Map<string, SessionStatusState>();

  function discoverSessions(dir: string): string[] {
    const results: string[] = [];
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) results.push(path.join(dir, entry.name));
      }
    } catch {}
    return results.sort((a, b) => b.localeCompare(a));
  }

  function readSessionMessages(sessionDir: string): { messages: any[]; updated_at?: string } | null {
    const sessionId = path.basename(sessionDir);
    const messagesPath = path.join(sessionDir, `${sessionId}.messages.json`);
    try {
      const content = fs.readFileSync(messagesPath, 'utf8');
      return JSON.parse(content);
    } catch { return null; }
  }

  function readSessionStatus(sessionDir: string): { status?: string } | null {
    const sessionId = path.basename(sessionDir);
    const sessionPath = path.join(sessionDir, `${sessionId}.json`);
    try {
      return JSON.parse(fs.readFileSync(sessionPath, 'utf8'));
    } catch { return null; }
  }

  const SECRET_RE = /(sk-[A-Za-z0-9]{20,}|[A-Za-z0-9]{32,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*)/g;
  function redact(text: string): string {
    return text.replace(SECRET_RE, '[REDACTED]');
  }

  function toolKind(name: string): 'command' | 'edit' | 'other' {
    const n = String(name || '').toLowerCase();
    if (n === 'run_commands' || n === 'execute_command' || n === 'run_command') return 'command';
    if (n.includes('file') || n.includes('edit') || n === 'write_file' || n === 'read_file' || n === 'edit_file') return 'edit';
    return 'other';
  }

  function feedMessage(m: any): void {
    if (!m || typeof m !== 'object') return;
    const role = m.role;
    const content: any[] = m.content || [];
    const id = m.id;
    const ts = m.ts ? new Date(m.ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '--:--';
    for (const part of content) {
      if (!part || typeof part !== 'object') continue;
      const type = part.type;
      if (role === 'assistant') {
        if (type === 'thinking') {
          const text = String(part.thinking || '');
          output.appendLine(`THINK[${ts}]: ${redact(text.substring(0, 120))}`);
          clineAdapter?.think(text);
        } else if (type === 'text') {
          const text = String(part.text || '');
          output.appendLine(`SAY[${ts}]: ${redact(text.substring(0, 120))}`);
          clineAdapter?.say(text, false);
        } else if (type === 'tool_use') {
          const kind = toolKind(part.name);
          const body = JSON.stringify(part.input || {});
          output.appendLine(`ASK[${ts}][${kind}]: ${redact(body.substring(0, 120))}`);
          clineAdapter?.ask(String(id), kind, body);
        } else if (type === 'tool_result') {
          const result = String(part.content || '');
          output.appendLine(`SAY[${ts}][tool_result]: ${redact(result.substring(0, 120))}`);
          clineAdapter?.say(result, false);
        }
      }
    }
  }

  function pollSessions(dir: string): void {
    for (const sessionDir of discoverSessions(dir)) {
      try {
        const data = readSessionMessages(sessionDir);
        if (!data) continue;
        const sessionId = path.basename(sessionDir);
        const messages: any[] = data.messages || [];
        const prev = msgFileStates.get(sessionId);
        if (!prev) {
          // First discovery: seed with current length so we don't replay history
          msgFileStates.set(sessionId, { processedMsgs: messages.length });
          output.appendLine(`SESSION[${sessionId}]: discovered, ${messages.length} existing messages`);
          continue;
        }
        if (prev.processedMsgs !== messages.length) {
          msgFileStates.set(sessionId, { processedMsgs: messages.length });
          const newMsgs = messages.slice(prev.processedMsgs);
          for (const m of newMsgs) feedMessage(m);
        }

        // Session status -> state event
        const st = readSessionStatus(sessionDir);
        const newStatus = st?.status;
        if (newStatus) {
          const prevStatus = sessionStatus.get(sessionId);
          if (!prevStatus || prevStatus.status !== newStatus) {
            sessionStatus.set(sessionId, { status: newStatus });
            const mapStatus = (s: string): 'working' | 'waiting' | 'done' => {
              if (s === 'working' || s === 'running') return 'working';
              if (s === 'waiting' || s === 'pending') return 'waiting';
              return 'done';
            };
            output.appendLine(`STATE[${sessionId}]: ${newStatus}`);
            clineAdapter?.state(mapStatus(newStatus));
          }
        }
      } catch {}
    }
  }

  let pollTimer: NodeJS.Timeout | null = null;
  let watcher: fs.FSWatcher | null = null;

  function pollSessionsDir(dir: string): void {
    pollSessions(dir);
  }

  function startWatching(dir: string): void {
    output.appendLine(`Watching sessions dir: ${dir}`);
    try {
      watcher = fs.watch(dir, { recursive: true }, () => {
        setTimeout(() => pollSessionsDir(dir), 100);
      });
      output.appendLine('fs.watch active.');
    } catch (e) {
      output.appendLine(`fs.watch failed: ${e}; polling only.`);
    }
    pollTimer = setInterval(() => pollSessionsDir(dir), 500);
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
      if (fs.existsSync(sessionsDir)) {
        if (!watcher && !pollTimer) startWatching(sessionsDir);
      } else {
        output.appendLine(`Cline sessions dir not found yet: ${sessionsDir}`);
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
