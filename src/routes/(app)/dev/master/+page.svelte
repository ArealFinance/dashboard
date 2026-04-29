<script lang="ts">
  /*
   * Master E2E Runner — Layer 10 Substep 9.
   *
   * The dashboard is a static SPA (adapter-static, ssr=false), so it cannot
   * spawn `tsx --test` directly. Instead this page:
   *
   *   1. Documents the canonical CLI invocation per scenario (D35) so the
   *      operator drives execution from the terminal.
   *   2. Accepts the JSON artifact written by `scripts/lib/e2e-runner.ts`
   *      (`data/e2e-runner-<scenario>-<UTC>.json`) — operator pastes the
   *      content (or uploads the file) and the dashboard renders the
   *      structured per-flow report.
   *
   * This honours the constraint in the substep spec: "Operator drives
   * `--scenario all` via CLI; dashboard observes." (Simpler than IPC.)
   */
  import { PlayCircle, Upload, AlertTriangle, Check, X, SkipForward, Clock } from 'lucide-svelte';
  import { redactRpcUrl } from '$lib/utils/format';

  // --- Loaded report state -------------------------------------------------

  interface FlowResult {
    flow: string;
    status: 'ok' | 'skipped' | 'error';
    reason?: string;
    details?: Record<string, unknown>;
  }

  interface RunReport {
    generated_at_utc: string;
    scenario: string;
    bootstrap_path: string;
    rpc_url: string;
    flows: FlowResult[];
  }

  let pasteText = '';
  let report: RunReport | null = null;
  let parseError = '';

  // 6 named scenarios per D35.
  const SCENARIOS: Array<{ id: string; name: string; cli: string; description: string }> = [
    {
      id: 'scenario-1',
      name: 'Scenario 1 — Happy Path',
      cli: 'npx tsx scripts/lib/e2e-runner.ts --scenario scenario-1',
      description: 'mint_rwt + admin_mint + revenue→yield→claim end-to-end',
    },
    {
      id: 'scenario-2',
      name: 'Scenario 2 — Governance',
      cli: 'npx tsx scripts/lib/e2e-runner.ts --scenario scenario-2',
      description: 'Futarchy proposal lifecycle (mint_ot / spend_treasury / batch_update_destinations)',
    },
    {
      id: 'scenario-3',
      name: 'Scenario 3 — DEX Standard',
      cli: 'npx tsx scripts/lib/e2e-runner.ts --scenario scenario-3',
      description: 'LP add / swap / zap / remove + OT-pair fee routing',
    },
    {
      id: 'scenario-4',
      name: 'Scenario 4 — DEX Concentrated',
      cli: 'npx tsx scripts/lib/e2e-runner.ts --scenario scenario-4',
      description: 'Bin walk + shift_liquidity + reserve conservation invariants',
    },
    {
      id: 'scenario-5',
      name: 'Scenario 5 — Nexus 14-step',
      cli: 'npx tsx scripts/lib/e2e-runner.ts --scenario scenario-5',
      description: 'Nexus deposit + swap + add liquidity + withdraw_profits',
    },
    {
      id: 'scenario-6',
      name: 'Scenario 6 — Emergency / Authority Closure',
      cli: 'npx tsx scripts/lib/e2e-runner.ts --scenario scenario-6',
      description: 'Pause + authority transfer + R-G zero-deployer assertion (10 surfaces)',
    },
  ];

  const MASTER_CLI = 'npx tsx scripts/lib/e2e-runner.ts --scenario all';

  const pastePlaceholder =
    '{"generated_at_utc": "...", "scenario": "all", "flows": [...]}';

  function parsePaste(): void {
    parseError = '';
    if (!pasteText.trim()) {
      report = null;
      return;
    }
    try {
      const parsed = JSON.parse(pasteText) as Partial<RunReport>;
      if (!parsed || typeof parsed !== 'object') {
        throw new Error('Top-level must be an object.');
      }
      if (!Array.isArray(parsed.flows)) {
        throw new Error('Missing or non-array `flows` field.');
      }
      // Defensive cap against pathological pastes — typical reports list
      // 10–50 flows; 10_000 is a hard upper bound that keeps the table
      // render bounded (MED-3).
      const FLOWS_CAP = 10_000;
      if (parsed.flows.length > FLOWS_CAP) {
        // eslint-disable-next-line no-console
        console.warn(
          `parsePaste: flows truncated from ${parsed.flows.length} to ${FLOWS_CAP} (DoS guard).`,
        );
        parsed.flows = parsed.flows.slice(0, FLOWS_CAP);
      }
      // Coerce + validate each flow
      const flows: FlowResult[] = parsed.flows.map((f, i) => {
        if (!f || typeof f !== 'object') {
          throw new Error(`flows[${i}] is not an object.`);
        }
        const fr = f as unknown as Record<string, unknown>;
        if (typeof fr.flow !== 'string' || !fr.flow) {
          throw new Error(`flows[${i}].flow is not a string.`);
        }
        if (fr.status !== 'ok' && fr.status !== 'skipped' && fr.status !== 'error') {
          throw new Error(`flows[${i}].status invalid (got ${String(fr.status)}).`);
        }
        return {
          flow: fr.flow,
          status: fr.status,
          reason: typeof fr.reason === 'string' ? fr.reason : undefined,
          details:
            fr.details && typeof fr.details === 'object' && !Array.isArray(fr.details)
              ? (fr.details as Record<string, unknown>)
              : undefined,
        };
      });
      report = {
        generated_at_utc: typeof parsed.generated_at_utc === 'string' ? parsed.generated_at_utc : '',
        scenario: typeof parsed.scenario === 'string' ? parsed.scenario : '',
        bootstrap_path: typeof parsed.bootstrap_path === 'string' ? parsed.bootstrap_path : '',
        rpc_url: typeof parsed.rpc_url === 'string' ? parsed.rpc_url : '',
        flows,
      };
    } catch (err) {
      report = null;
      parseError = err instanceof Error ? err.message : String(err);
    }
  }

  async function handleFile(event: Event) {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      pasteText = text;
      parsePaste();
    } catch (err) {
      parseError = err instanceof Error ? err.message : String(err);
    }
  }

  function copy(text: string) {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      void navigator.clipboard.writeText(text);
    }
  }

  function statusForScenario(id: string): 'pending' | 'pass' | 'fail' | 'skipped' {
    if (!report) return 'pending';
    // Map flow naming. The runner emits flow names matching the scenario id
    // for scenarios 1-6; the legacy per-bot scenarios use 'revenue', etc.
    const direct = report.flows.find((f) => f.flow === id);
    if (direct) {
      if (direct.status === 'ok') return 'pass';
      if (direct.status === 'skipped') return 'skipped';
      return 'fail';
    }
    return 'pending';
  }

  function pillClass(status: ReturnType<typeof statusForScenario>): string {
    if (status === 'pass') return 'pill-pass';
    if (status === 'fail') return 'pill-fail';
    if (status === 'skipped') return 'pill-skip';
    return 'pill-pending';
  }
</script>

<div class="master-page">
  <div class="dev-warning">
    <AlertTriangle size={18} />
    <span>DEV ONLY — Master E2E reads CLI artifacts; never use against mainnet</span>
  </div>

  <header class="page-header">
    <PlayCircle size={24} />
    <div>
      <h1>Master E2E Runner</h1>
      <p class="page-desc">
        Sequential runner for the 6 Layer 10 scenarios. Operator runs
        <code>--scenario all</code> via CLI (halt-after-error chain enforced
        in the runner); dashboard ingests the resulting JSON artifact.
      </p>
    </div>
  </header>

  <section class="card">
    <h2 class="section-title">Run All</h2>
    <p class="section-desc">
      Runs Scenario 1 → 2 → 3 → 4 → 5 → 6 in sequence. Halts on first failure
      (re-run individual scenarios after diagnosing).
    </p>
    <div class="cli-row">
      <code class="cli">{MASTER_CLI}</code>
      <button class="btn btn-secondary" on:click={() => copy(MASTER_CLI)}>Copy</button>
    </div>
  </section>

  <section class="card">
    <h2 class="section-title">Scenarios</h2>
    <div class="scenario-grid">
      {#each SCENARIOS as s (s.id)}
        {@const status = statusForScenario(s.id)}
        <div class="scenario-card">
          <div class="scenario-head">
            <span class="scenario-name">{s.name}</span>
            <span class="pill {pillClass(status)}">
              {#if status === 'pass'}<Check size={12} /> Pass{/if}
              {#if status === 'fail'}<X size={12} /> Fail{/if}
              {#if status === 'skipped'}<SkipForward size={12} /> Skipped{/if}
              {#if status === 'pending'}<Clock size={12} /> Pending{/if}
            </span>
          </div>
          <p class="scenario-desc">{s.description}</p>
          <div class="cli-row">
            <code class="cli">{s.cli}</code>
            <button class="btn btn-secondary" on:click={() => copy(s.cli)}>Copy</button>
          </div>
        </div>
      {/each}
    </div>
  </section>

  <section class="card">
    <h2 class="section-title">Load report artifact</h2>
    <p class="section-desc">
      After the CLI run, paste the contents of
      <code>data/e2e-runner-&lt;scenario&gt;-&lt;UTC&gt;.json</code> below
      (or use the file picker).
    </p>

    <div class="loader-row">
      <label class="upload">
        <Upload size={14} />
        <span>Upload JSON</span>
        <input type="file" accept="application/json,.json" on:change={handleFile} />
      </label>
      <button class="btn btn-run" on:click={parsePaste}>Parse pasted text</button>
      <button class="btn btn-secondary" on:click={() => { pasteText = ''; report = null; parseError = ''; }}>
        Clear
      </button>
    </div>

    <textarea
      class="paste"
      bind:value={pasteText}
      placeholder={pastePlaceholder}
      rows="10"
    ></textarea>

    {#if parseError}
      <p class="error">{parseError}</p>
    {/if}
  </section>

  {#if report}
    <section class="card">
      <h2 class="section-title">Report — {report.scenario || 'unknown'}</h2>
      <div class="report-meta">
        <span><strong>generated:</strong> <code>{report.generated_at_utc || '—'}</code></span>
        <span><strong>rpc:</strong> <code>{redactRpcUrl(report.rpc_url) || '—'}</code></span>
        <span><strong>bootstrap:</strong> <code>{report.bootstrap_path || '—'}</code></span>
      </div>
      <table class="report-table">
        <thead>
          <tr>
            <th>Flow</th>
            <th>Status</th>
            <th>Reason</th>
          </tr>
        </thead>
        <tbody>
          {#each report.flows as f, i (f.flow + i)}
            <tr>
              <td class="mono">{f.flow}</td>
              <td>
                <span class="pill pill-{f.status === 'ok' ? 'pass' : f.status === 'skipped' ? 'skip' : 'fail'}">
                  {f.status}
                </span>
              </td>
              <td class="reason">{f.reason ?? '—'}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </section>
  {/if}
</div>

<style>
  .master-page {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .dev-warning {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    background: var(--color-danger-muted);
    color: var(--color-danger);
    border: 1px solid var(--color-danger);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .page-header {
    display: flex;
    align-items: flex-start;
    gap: var(--space-3);
    color: var(--color-text);
  }

  .page-header h1 {
    font-size: var(--text-2xl);
    font-weight: 700;
    margin: 0;
  }

  .page-desc {
    margin-top: var(--space-1);
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    max-width: 70ch;
  }

  .card {
    background: var(--color-surface);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .section-title {
    font-size: var(--text-md);
    font-weight: 600;
    margin: 0;
  }

  .section-desc {
    font-size: var(--text-sm);
    color: var(--color-text-secondary);
    margin: 0;
  }

  .cli-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .cli {
    font-family: var(--font-mono);
    font-size: var(--text-sm);
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3);
    flex: 1;
    overflow-x: auto;
    white-space: nowrap;
  }

  .scenario-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
    gap: var(--space-3);
  }

  .scenario-card {
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  .scenario-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }

  .scenario-name {
    font-weight: 600;
    font-size: var(--text-sm);
  }

  .scenario-desc {
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
    margin: 0;
    line-height: 1.5;
  }

  .pill {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    font-size: var(--text-xs);
    font-weight: 600;
    padding: 2px var(--space-2);
    border-radius: var(--radius-sm);
  }

  .pill-pass {
    color: var(--color-success);
    background: var(--color-success-muted);
  }

  .pill-fail {
    color: var(--color-danger);
    background: var(--color-danger-muted);
  }

  .pill-skip {
    color: var(--color-text-muted);
    background: var(--color-surface-hover);
  }

  .pill-pending {
    color: var(--color-text-muted);
    background: var(--color-surface-hover);
  }

  .loader-row {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .upload {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-2) var(--space-3);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-surface);
    color: var(--color-text);
    font-size: var(--text-sm);
    cursor: pointer;
  }

  .upload input {
    display: none;
  }

  .upload:hover {
    background: var(--color-surface-hover);
  }

  .btn {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md);
    font-size: var(--text-sm);
    font-weight: 500;
    cursor: pointer;
    border: 1px solid var(--color-border);
  }

  .btn-secondary {
    background: var(--color-surface);
    color: var(--color-text);
  }

  .btn-secondary:hover {
    background: var(--color-surface-hover);
  }

  .btn-run {
    background: var(--color-success);
    color: white;
    border-color: var(--color-success);
  }

  .btn-run:hover {
    filter: brightness(1.1);
  }

  .paste {
    width: 100%;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-2);
    background: var(--color-bg);
    color: var(--color-text);
    resize: vertical;
  }

  .error {
    font-size: var(--text-sm);
    color: var(--color-danger);
    background: var(--color-danger-muted);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-sm);
    margin: 0;
  }

  .report-meta {
    display: flex;
    gap: var(--space-3);
    flex-wrap: wrap;
    font-size: var(--text-xs);
    color: var(--color-text-secondary);
  }

  .report-meta code {
    font-family: var(--font-mono);
  }

  .report-table {
    width: 100%;
    border-collapse: collapse;
    font-size: var(--text-sm);
  }

  .report-table th,
  .report-table td {
    text-align: left;
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--color-border);
  }

  .report-table th {
    font-size: var(--text-xs);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-text-muted);
    font-weight: 500;
  }

  .reason {
    color: var(--color-text-secondary);
  }

  .mono {
    font-family: var(--font-mono);
  }

  code {
    font-family: var(--font-mono);
    background: var(--color-bg);
    padding: 1px 4px;
    border-radius: var(--radius-xs);
    font-size: 0.95em;
  }
</style>
