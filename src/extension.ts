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

  // 4. Create Hub
  const hub = new Hub(policy, auditLog);

  // 5. ClineAdapter (created on first phone connection)
  let clineAdapter: ClineAdapter | null = null;

  // 6. WebSocket server (127.0.0.1 only)
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 9876 });
  output.appendLine('WebSocket server: ws://127.0.0.1:9876');

  wss.on('connection', (ws: WebSocket) => {
    output.appendLine('Phone WebSocket connected');
    hub.setPhoneWebSocket(ws);

    if (!clineAdapter) {
      clineAdapter = new ClineAdapter(
        (msg) => hub.handleIncoming(msg),
        auditLog
      );
      clineAdapter.onEvent((event) => {
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
        await (cline.startNewTask as any)('Say hello and list the files in the workspace root');
        output.appendLine('startNewTask completed.');
      } catch (e) {
        output.appendLine(`startNewTask error: ${e}`);
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

