// Smart rename: name the current tab or pane after the work happening inside it.
// --target tab  → dominant-pane hierarchy (focused agent > active agent > focused > first)
// --target pane → the invoking pane only.
// Signals: pane metadata + Claude transcript prompts (first + last two), else recent
// terminal output. Known plain processes get deterministic names without a model call.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, globSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

const BIN = process.env.HERDR_BIN_PATH || 'herdr';
const HOME = homedir();
const MAX_CONTEXT = 4500;

// Config: real env vars win, then `.env` in the herdr-managed plugin config dir
// (`herdr plugin config-dir edi.smart-rename`). See README for the keys.
const CONFIG_DIR = process.env.HERDR_PLUGIN_CONFIG_DIR;
const ENV_FILE = CONFIG_DIR ? join(CONFIG_DIR, '.env') : null;
const fileEnv = ENV_FILE && existsSync(ENV_FILE) ? parseEnv(readFileSync(ENV_FILE, 'utf8')) : {};
const cfg = (key, fallback) => process.env[key] ?? fileEnv[key] ?? fallback;

const BASE_URL = cfg('SMART_RENAME_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, '');
const MODEL = cfg('SMART_RENAME_MODEL', 'gpt-5.6-luna');
const API_KEY = cfg('SMART_RENAME_API_KEY') ?? cfg('OPENAI_API_KEY');
// Empty value omits the field — providers that reject it (Anthropic, Ollama) need that.
const REASONING_EFFORT = cfg('SMART_RENAME_REASONING_EFFORT', 'low');

const herdr = (...args) => {
  const out = execFileSync(BIN, args.map(String), { encoding: 'utf8' });
  return out.trim() ? JSON.parse(out) : null;
};

const fail = (msg) => { console.error(`smart-rename: ${msg}`); process.exit(1); };

const sanitize = (s) =>
  s
    .replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07/g, '') // ANSI/OSC
    // Secret-shaped strings: long unbroken runs. Many dashes = branch/slug, keep it.
    .replace(/[A-Za-z0-9_-]{40,}/g, (m) => (m.split('-').length > 3 ? m : '<token>'))
    .replaceAll(HOME, '~');

// ---------- pane selection ----------

const target = process.argv[process.argv.indexOf('--target') + 1];
if (target !== 'tab' && target !== 'pane') fail('need --target tab|pane');
const selfId = process.env.HERDR_PANE_ID;
if (!selfId) fail('HERDR_PANE_ID not set — run as a herdr plugin action');

const self = herdr('pane', 'get', selfId).result.pane;
let pane = self;
let siblings = [];
if (target === 'tab') {
  siblings = herdr('pane', 'list', '--workspace', self.workspace_id)
    .result.panes.filter((p) => p.tab_id === self.tab_id);
  const active = (p) => p.agent && ['working', 'blocked'].includes(p.agent_status);
  // The invoking pane is the focused one; prefer it, then any active agent.
  pane = (self.agent && self) || siblings.find(active) || self;
}

// ---------- context gathering ----------

// Last real user prompts from an agent session transcript: first + last two.
function agentPrompts(p) {
  const id = p.agent_session?.value;
  if (!id) return null;
  let file, extract;
  if (p.agent === 'claude') {
    const root = join(HOME, '.claude', 'projects');
    file = join(root, p.cwd.replace(/[/._]/g, '-'), `${id}.jsonl`);
    if (!existsSync(file)) {
      file = readdirSync(root)
        .map((d) => join(root, d, `${id}.jsonl`))
        .find(existsSync);
    }
    extract = (e) => {
      if (e.type !== 'user') return null;
      const c = e.message?.content;
      return typeof c === 'string' ? c : Array.isArray(c) && c[0]?.type === 'text' ? c[0].text : null;
    };
  } else if (p.agent === 'codex') {
    file = globSync(join(HOME, '.codex', 'sessions', '*', '*', '*', `rollout-*-${id}.jsonl`))[0];
    extract = (e) =>
      e.type === 'response_item' && e.payload?.role === 'user' ? e.payload.content?.[0]?.text : null;
  } else {
    return null;
  }
  if (!file) return null;
  const prompts = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const text = extract(entry);
    // '<'/'#' prefixes are injected noise: system reminders, env context, AGENTS.md.
    if (!text || text.startsWith('<') || text.startsWith('#') || text.length < 10) continue;
    prompts.push(text.slice(0, 250));
  }
  if (!prompts.length) return null;
  return { first: prompts[0], recent: prompts.slice(-2) };
}

function processInfo(p) {
  try {
    const info = herdr('pane', 'process-info', '--pane', p.pane_id).result.process_info;
    return info.foreground_processes?.[0] ?? null;
  } catch {
    return null;
  }
}

// Deterministic names for well-known plain processes — no model call needed.
const DETERMINISTIC = [
  [/\b(vitest|jest|playwright|pytest|cargo test)\b/, 'run-tests'],
  [/\b(vite|next dev|nuxt dev|astro dev|webpack)\b|\b(pnpm|npm|bun|yarn) (run )?dev\b/, 'dev-server'],
  [/\btail -[fF]\b|\bjournalctl\b.*-f/, 'view-logs'],
  [/^(ssh|mosh)\b/, 'remote-shell'],
];

const others = siblings.filter((p) => p.pane_id !== pane.pane_id);
// Two or more agents in a tab are peers: the name must cover their common
// theme, so no pane gets dominant treatment.
const agentPanes = siblings.filter((p) => p.agent);
const umbrella = agentPanes.length >= 2;

const proc = pane.agent ? null : processInfo(pane);
// Deterministic names only when the pane stands alone — a multi-pane tab
// should get a general name from the model instead.
if (proc && !others.length) {
  const hit = DETERMINISTIC.find(([re]) => re.test(proc.cmdline));
  if (hit) {
    apply(hit[1]);
    process.exit(0);
  }
}

const paneLine = (p) => {
  if (p.agent) return `- ${p.agent} agent, ${p.agent_status}${p.terminal_title_stripped ? `: ${p.terminal_title_stripped}` : ''}`;
  const pi = processInfo(p);
  return `- ${pi ? pi.cmdline.slice(0, 80) : 'shell'}`;
};

const parts = [];
if (umbrella) {
  parts.push(`Tab with ${siblings.length} panes, cwd ${pane.cwd}. The panes, agents in parallel first:`);
  parts.push(...agentPanes.map(paneLine));
  parts.push(...siblings.filter((p) => !p.agent).map(paneLine));
} else {
  parts.push(
    `Pane: ${pane.agent ? `${pane.agent} agent, status ${pane.agent_status}` : proc ? `running: ${proc.cmdline.slice(0, 120)}` : 'shell'}, cwd ${pane.cwd}.`,
  );
  if (pane.terminal_title_stripped) parts.push(`Terminal title: ${pane.terminal_title_stripped}`);

  const prompts = agentPrompts(pane);
  if (prompts) {
    parts.push(`First user request of the session:\n${prompts.first}`);
    parts.push(`Most recent requests:\n${prompts.recent.join('\n')}`);
  } else {
    const tail = execFileSync(BIN, ['pane', 'read', pane.pane_id], { encoding: 'utf8' })
      .split('\n').slice(-40).join('\n');
    parts.push(`Recent terminal output:\n${tail}`);
  }

  // Siblings are supporting evidence only: one bounded line each.
  if (others.length) {
    parts.push('Other panes in this tab (supporting evidence only):');
    parts.push(...others.map(paneLine));
  }
}
const context = sanitize(parts.join('\n')).slice(0, MAX_CONTEXT);
if (process.env.DEBUG) console.error(`--- context ---\n${context}\n---`);

// ---------- model call ----------

const SYSTEM =
  `You name terminal ${target}s. Reply with ONLY a label: 2-4 lowercase words joined by dashes, under 30 characters. ` +
  'Keep ticket ids (like fe-1234) when they identify the work. Never tool, model, or agent names. ' +
  (umbrella
    ? 'Several agents run in parallel in this tab: name their COMMON theme with one umbrella label.' +
      " Never name just one agent's task. Supporting processes (servers, logs, shells) never define the name."
    : 'Name the OVERALL task of the session, not the latest step; recent requests only refine the topic.' +
      (others.length
        ? ' The tab holds several panes: name the tab’s overall work. Supporting processes (servers, logs,' +
          ' shells) never define the name.'
        : ''));

if (!API_KEY) {
  fail(`no api key — set SMART_RENAME_API_KEY in ${ENV_FILE ?? 'the plugin config dir .env'}`);
}

const res = await fetch(`${BASE_URL}/chat/completions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: MODEL,
    ...(REASONING_EFFORT ? { reasoning_effort: REASONING_EFFORT } : {}),
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: context },
    ],
  }),
  signal: AbortSignal.timeout(30_000),
}).catch((e) => fail(`model call failed: ${e.message}`));
if (!res.ok) fail(`model call failed: HTTP ${res.status} from ${BASE_URL} (model ${MODEL})`);

const label = (await res.json()).choices?.[0]?.message?.content
  ?.trim().replace(/^["']|["']$/g, '').toLowerCase().replace(/[\s_]+/g, '-');
const words = label ? label.split('-').length : 0;
if (!label || words < 1 || words > 5 || label.length > 30) fail(`bad label from model: ${JSON.stringify(label)}`);

apply(label);

function apply(label) {
  if (target === 'tab') herdr('tab', 'rename', self.tab_id, label);
  else herdr('pane', 'rename', self.pane_id, label);
  console.log(label);
}
