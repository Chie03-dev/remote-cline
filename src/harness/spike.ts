/**
 * Phase 1 SDK Spike — standalone script to probe @cline/sdk ClineCore behavior.
 *
 * Run with:  npx tsx src/harness/spike.ts   (or compile + node)
 *
 * This script:
 *  1. Creates ClineCore with backendMode "local"
 *  2. Starts a session asking the agent to create approve-test.txt
 *  3. Implements requestToolApproval: logs request (redacted), waits for y/n
 *  4. Subscribes to all events, logging type + fields with ms timestamps
 *  5. After the first session, starts a second session for reject-test.txt
 *     (reject flow), then reports results
 *
 * NOTES:
 * - You must set CLINE_PROVIDER_ID, CLINE_MODEL_ID, CLINE_API_KEY env vars
 *   (or edit the config below) before running.
 * - ClineCore.create() returns a thenable; we await it.
 * - The local proxy at http://127.0.0.1:31415/v1 was observed in Cline's
 *   globalState.json (openAiBaseUrl) and may work as an OpenAI-compatible
 *   baseUrl, but this is INFERRED — not confirmed for @cline/sdk.
 */

import { ClineCore } from '@cline/sdk'

// ---------- env ----------
const PROVIDER_ID = process.env.CLINE_PROVIDER_ID ?? 'cline'
const MODEL_ID = process.env.CLINE_MODEL_ID ?? 'nemotron-3.5-super-vl'
const API_KEY = process.env.CLINE_API_KEY ?? ''
const BASE_URL = process.env.CLINE_BASE_URL ?? 'http://127.0.0.1:31415/v1'
const WORK_DIR = process.env.CLINE_WORK_DIR ?? '/tmp/agent-bridge-spike'

const ts = () => new Date().toISOString()

function redact(input: unknown): string {
  const s = JSON.stringify(input)
  return s.replace(/(sk-[A-Za-z0-9]{20,}|[A-Za-z0-9]{32,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*\.[A-Za-z0-9_-]*)/g, '[REDACTED]')
}

// ---------- approval broker (interactive terminal) ----------
let approveResolve: ((v: boolean) => void) | null = null

function askApproval(req: any): Promise<boolean> {
  console.log(`\n[${ts()}] APPROVAL REQUEST:`)
  console.log('  toolName :', req.toolName)
  console.log('  toolCallId:', req.toolCallId)
  console.log('  iteration:', req.iteration)
  console.log('  sessionId:', req.sessionId)
  console.log('  agentId  :', req.agentId)
  console.log('  input    :', redact(req.input))
  console.log('  policy   :', JSON.stringify(req.policy))
  console.log('  (type y to approve, n to reject, then Enter)')
  return new Promise<boolean>((resolve) => {
    approveResolve = resolve
  })
}

process.stdin.on('data', (chunk: Buffer) => {
  const line = chunk.toString().trim().toLowerCase()
  if (approveResolve && (line === 'y' || line === 'n')) {
    approveResolve(line === 'y')
    approveResolve = null
  }
})

// ---------- event subscriber ----------
const events: any[] = []

function onEvent(event: any) {
  events.push({ ts: Date.now(), ...event })
  const fields = { ...event }
  delete fields.type
  console.log(`[${ts()}] EVENT type=${event.type} fields=${JSON.stringify(fields).slice(0, 400)}`)
}

// ---------- main ----------
async function main() {
  console.log(`[${ts()}] Node ${process.version}`)
  console.log(`[${ts()}] ClineCore SDK spike starting`)
  console.log(`[${ts()}] Provider: ${PROVIDER_ID}, Model: ${MODEL_ID}, BaseURL: ${BASE_URL}`)
  console.log(`[${ts()}] Work dir: ${WORK_DIR}`)

  // 1. Create ClineCore
  const cline = await ClineCore.create({
    clientName: 'agent-bridge-spike',
    backendMode: 'local',
    capabilities: {
      requestToolApproval: async (req: any) => {
        console.log(`\n[${ts()}] >>> requestToolApproval invoked`)
        const approved = await askApproval(req)
        return { approved }
      },
    },
    toolPolicies: {
      // Default: require approval for anything that writes or runs
      run_commands: { autoApprove: false },
      editor: { autoApprove: false },
      apply_patch: { autoApprove: false },
      write_files: { autoApprove: false },
      // Read-only tools can auto-approve
      read_files: { autoApprove: true },
      search_codebase: { autoApprove: true },
      fetch_web_content: { autoApprove: true },
    },
  })

  console.log(`[${ts()}] ClineCore created`)

  // 2. Start session — approve-test.txt
  console.log(`\n[${ts()}] === SESSION 1: approve-test.txt ===`)
  const session1 = await cline.start({
    prompt: `Create a file named approve-test.txt in the current directory with the content "approved". Then stop.`,
    config: {
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      workspaceRoot: WORK_DIR,
      cwd: WORK_DIR,
      systemPrompt: 'You are a helpful coding assistant. Use tools to complete the user\'s request.',
      enableTools: true,
      enableSpawnAgent: false,
      enableAgentTeams: false,
    },
    source: 'spike',
  })

  console.log(`[${ts()}] Session 1 started: sessionId=${session1.sessionId}`)

  // Subscribe to events
  cline.subscribe(onEvent)

  // Wait a bit for events to flow
  await new Promise((r) => setTimeout(r, 15000))

  // Check if file was created
  const fs = await import('fs')
  const path = await import('path')
  const approvePath = path.join(WORK_DIR, 'approve-test.txt')
  let approveExists = false
  try { approveExists = fs.existsSync(approvePath) } catch {}
  console.log(`\n[${ts()}] approve-test.txt exists: ${approveExists}`)
  if (approveExists) {
    console.log(`[${ts()}] Content: ${fs.readFileSync(approvePath, 'utf8')}`)
  }

  // Stop session 1
  await cline.stop(session1.sessionId)
  console.log(`[${ts()}] Session 1 stopped`)

  // 3. Second session — reject-test.txt (reject flow)
  console.log(`\n[${ts()}] === SESSION 2: reject-test.txt (REJECT) ===`)
  const session2 = await cline.start({
    prompt: `Create a file named reject-test.txt in the current directory with the content "rejected". Then stop.`,
    config: {
      providerId: PROVIDER_ID,
      modelId: MODEL_ID,
      apiKey: API_KEY,
      baseUrl: BASE_URL,
      workspaceRoot: WORK_DIR,
      cwd: WORK_DIR,
      systemPrompt: 'You are a helpful coding assistant. Use tools to complete the user\'s request.',
      enableTools: true,
      enableSpawnAgent: false,
      enableAgentTeams: false,
    },
    source: 'spike',
  })

  console.log(`[${ts()}] Session 2 started: sessionId=${session2.sessionId}`)
  await new Promise((r) => setTimeout(r, 15000))

  const rejectPath = path.join(WORK_DIR, 'reject-test.txt')
  let rejectExists = false
  try { rejectExists = fs.existsSync(rejectPath) } catch {}
  console.log(`\n[${ts()}] reject-test.txt exists: ${rejectExists}`)

  await cline.stop(session2.sessionId)
  console.log(`[${ts()}] Session 2 stopped`)

  // 4. Report
  console.log(`\n[${ts()}] === EVENT SUMMARY ===`)
  console.log(`Total events captured: ${events.length}`)
  const byType: Record<string, number> = {}
  for (const e of events) { byType[e.type] = (byType[e.type] || 0) + 1 }
  console.log('Event types:', JSON.stringify(byType, null, 2))

  await cline.dispose()
  console.log(`[${ts()}] Spike complete`)
}

main().catch((err) => {
  console.error(`[${ts()}] FATAL:`, err)
  process.exit(1)
})
