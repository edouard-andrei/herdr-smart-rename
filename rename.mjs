// Smart rename: name the current tab or pane after the work happening inside it.
// --target tab  → dominant-pane hierarchy (focused agent > active agent > focused > first)
// --target pane → the invoking pane only.
// Signals: pane metadata + agent transcript prompts (the first, then a budget-filled tail),
// else recent terminal output. Known plain processes get deterministic names without a model call.
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, existsSync, globSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';

const BIN = process.env.HERDR_BIN_PATH || 'herdr';
const HOME = homedir();
const MAX_CONTEXT = 4500;
// The first prompt carries the mission, so it gets the larger budget. Recent
// prompts are capped individually, then fill a shared budget from the end.
const FIRST_PROMPT_CHARS = 800;
const RECENT_PROMPT_CHARS = 250;
const RECENT_BUDGET_CHARS = 2500;

// Config: real env vars win, then `.env` in the herdr-managed plugin config dir
// (`herdr plugin config-dir edi.smart-rename`). See README for the keys.
const CONFIG_DIR = process.env.HERDR_PLUGIN_CONFIG_DIR;
const ENV_FILE = CONFIG_DIR ? join(CONFIG_DIR, '.env') : null;
const fileEnv = ENV_FILE && existsSync(ENV_FILE) ? parseEnv(readFileSync(ENV_FILE, 'utf8')) : {};
const cfg = (key, fallback) => process.env[key] ?? fileEnv[key] ?? fallback;

const BASE_URL = cfg('SMART_RENAME_BASE_URL', 'https://api.openai.com/v1').replace(/\/+$/, '');
const MODEL = cfg('SMART_RENAME_MODEL', 'gpt-5.6-luna');
const API_KEY = cfg('SMART_RENAME_API_KEY') ?? cfg('OPENAI_API_KEY');
// Empty value omits the field, providers that reject it (Anthropic, Ollama) need that.
const REASONING_EFFORT = cfg('SMART_RENAME_REASONING_EFFORT', 'low');

const herdr = (...args) => {
  const out = execFileSync(BIN, args.map(String), { encoding: 'utf8' });
  return out.trim() ? JSON.parse(out) : null;
};

const fail = (msg) => { console.error(`smart-rename: ${msg}`); process.exit(1); };

// Cut marker included on purpose: the model should know content is missing
// instead of over-fitting to the fragment it sees.
const clip = (s, max) => (s.length <= max ? s : `${s.slice(0, max)}…`);

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
if (!selfId) fail('HERDR_PANE_ID not set, run as a herdr plugin action');

const self = herdr('pane', 'get', selfId).result.pane;
// The current label is a weak prior: it steadies re-runs on an already named target,
// and the prompt tells the model when to drop it.
const previous = target === 'tab' ? herdr('tab', 'get', self.tab_id).result.tab.label : self.label;
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

// A skill invocation arrives as `<command-name>/x</command-name><command-args>…</command-args>`,
// followed by the expanded skill body as a second user turn. The invocation carries the
// subject (ticket, PR number, intent); the body is the skill's generic mission, so it is
// dropped. Other '<'/'#' prefixes are injected noise: system reminders, env context, AGENTS.md.
function userPrompt(text) {
  if (!text) return null;
  const cmd = text.match(/<command-name>([^<]*)<\/command-name>(?:\s*<command-args>([^<]*)<\/command-args>)?/);
  if (cmd) return `${cmd[1]} ${cmd[2] ?? ''}`.trim();
  if (text.startsWith('<') || text.startsWith('#') || text.startsWith('Base directory for this skill:')) return null;
  return text.length < 10 ? null : text;
}

// User prompts from an agent session transcript: the first, then a budget-filled tail.
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
    const text = userPrompt(extract(entry));
    if (text) prompts.push(text);
  }
  if (!prompts.length) return null;
  // The first prompt never repeats as a recent one, so a short session sends it once.
  const rest = prompts.slice(1);
  // Fill the budget from the end rather than taking a fixed count. A pivot ("actually,
  // let's do X instead") lands mid-session, and a two-prompt window drops it.
  const recent = [];
  let used = 0;
  for (const text of rest.toReversed()) {
    const entry = clip(text, RECENT_PROMPT_CHARS);
    if (used + entry.length > RECENT_BUDGET_CHARS) break;
    recent.unshift(entry);
    used += entry.length;
  }
  return { first: clip(prompts[0], FIRST_PROMPT_CHARS), recent, omitted: rest.length - recent.length };
}

// A first prompt that names a PR ("/pr-address 687", "PR 687", "#687") rarely says what
// the PR is about. One `gh` call (~0.5s) fetches the title so the label can name the
// feature, not just the number. Any failure (no gh, no auth, not a GitHub repo) is skipped.
function prTitle(first, cwd) {
  const m = first.match(/(?:\bpr\S*|\bpull request|#)\s*(\d{1,6})\b/i);
  if (!m) return null;
  try {
    const out = execFileSync('gh', ['pr', 'view', m[1], '--json', 'title,headRefName'], {
      cwd, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const { title, headRefName } = JSON.parse(out);
    return `PR ${m[1]}: ${title} (branch ${headRefName})`;
  } catch {
    return null;
  }
}

function processInfo(p) {
  try {
    const info = herdr('pane', 'process-info', '--pane', p.pane_id).result.process_info;
    return info.foreground_processes?.[0] ?? null;
  } catch {
    return null;
  }
}

// Deterministic names for well-known plain processes, no model call needed.
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
// Deterministic names only when the pane stands alone. A multi-pane tab
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
    const pr = prTitle(prompts.first, pane.cwd);
    if (pr) parts.push(pr);
    if (prompts.omitted) parts.push(`[${prompts.omitted} earlier requests omitted]`);
    if (prompts.recent.length) parts.push(`Most recent requests:\n${prompts.recent.join('\n')}`);
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
if (previous) parts.push(`Current label: ${previous}`);
const context = clip(sanitize(parts.join('\n')), MAX_CONTEXT);
if (process.env.DEBUG) console.error(`--- context ---\n${context}\n---`);

// ---------- model call ----------

// Scope rules first, then the general ones. The examples matter most: a small
// model at low effort learns "durable subject, not latest step" from a contrast
// pair far better than from another rule.
const scopeRules = umbrella
  ? [
      'Several agents run in parallel in this tab: label their COMMON theme with one umbrella label.',
      "Never label just one agent's task.",
    ]
  : [
      'Label the OVERALL task of the session, not the latest step. Recent requests only refine the topic.',
      // Both directions are needed. The narrowing rule alone anchors so hard on the
      // first request that a real pivot gets ignored.
      'The first request sets the subject until a later request clearly changes what the session is about.',
      'Later requests that only narrow to one detail, dependency or provider do not change the subject.',
      ...(others.length ? ["The tab holds several panes: label the tab's overall work."] : []),
    ];

const SYSTEM = [
  `You name terminal ${target}s. Reply with ONLY a label: 2-4 lowercase words joined by dashes, under 30 characters.`,
  '',
  'First, silently reduce the session to:',
  '- Subject: what system, feature or problem is this about?',
  '- Outcome: what does the user want to change or understand?',
  '- Incidental: what only describes how the agent should do the work?',
  'Label the subject and outcome. Discard the incidental instructions.',
  '',
  'Rules:',
  ...scopeRules.map((rule) => `- ${rule}`),
  '- Name the work, not the artifact used to produce it: a mock, plan, report, branch or PR.',
  '- Instructions about subagents, tools, output formats or background runs are incidental unless they are the topic.',
  '- Never tool, model or agent names.',
  '- Keep ticket ids (like fe-1234) when they identify the work.',
  '- A session about one PR or issue keeps its number as a word (pr-684, issue-12). Never drop it for a generic verb.',
  '- Do not imply the work is finished.',
  '- Do not repeat the cwd folder name: the workspace already shows it.',
  ...(previous
    ? [
        '- A current label is given. Keep its scope words when they are still accurate.',
        '  Replace it when it is generic, names an artifact or a finished step, or the session contradicts it.',
      ]
    : []),
  ...(umbrella || others.length
    ? ['- Supporting processes (servers, logs, shells) never define the name.']
    : []),
  '',
  'Examples:',
  '- A review session that finds one Codex roster bug stays "review-subagent-monitoring", not "codex-roster-bug".',
  '- A vague failing test later traced to a feed mismatch becomes "fix-lazy-feed-test", not "prevent-feed-regressions".',
  '- A QR sharing overhaul that ends in CI and merge work stays "qr-sharing", not "ci-merge-fixes".',
  '- Addressing review comments on PR 684 "fix(borrow): wallet states on loan routes" is "pr-684-wallet-states", not "address-pr-feedback". A question about one comment ("is this an architecture fault?") does not name the subject.',
].join('\n');

if (!API_KEY) {
  fail(`no api key: set SMART_RENAME_API_KEY in ${ENV_FILE ?? 'the plugin config dir .env'}`);
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

// Models wrap the label in quotes, backticks, a bullet or a sentence. Take the
// first non-empty line and strip the decoration before validating.
const label = ((await res.json()).choices?.[0]?.message?.content ?? '')
  .split(/\r?\n/)
  .map((line) => line.trim())
  .find((line) => line.length > 0)
  ?.replace(/[.,;:!?]+$/, '')
  .replace(/^['"`]+|['"`]+$/g, '')
  .toLowerCase()
  .replace(/[\s_]+/g, '-')
  .replace(/^-+|-+$/g, '');
// A label a few characters too long is still a good label. Drop trailing words
// until it fits instead of failing the keypress and renaming nothing.
const words = label ? label.split('-') : [];
while (words.length > 1 && (words.length > 5 || words.join('-').length > 30)) words.pop();
const trimmed = words.join('-');
if (!/^[a-z0-9-]+$/.test(trimmed) || trimmed.length > 30) fail(`bad label from model: ${JSON.stringify(label)}`);

apply(trimmed);

function apply(label) {
  if (target === 'tab') herdr('tab', 'rename', self.tab_id, label);
  else herdr('pane', 'rename', self.pane_id, label);
  console.log(label);
}
