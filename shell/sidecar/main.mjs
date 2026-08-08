var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});

// ../OpenClaw-UI-saucer/sidecar/index.ts
import { createServer as createServer2 } from "node:http";
import { readFile as readFile2 } from "node:fs/promises";
import { appendFileSync as appendFileSync3 } from "node:fs";
import { extname, join as join8, normalize as normalize2, sep } from "node:path";
import { homedir as homedir6 } from "node:os";
import { execFile as execFile2, execFileSync } from "node:child_process";
import { writeFile as writeFile2, readdir as readdir2, readFile as readFileAsync, stat } from "node:fs/promises";
import { tmpdir as tmpdir2 } from "node:os";
import { createInterface } from "node:readline";
import process2 from "node:process";
import { randomUUID as randomUUID2 } from "node:crypto";

// ../OpenClaw-UI-saucer/src/shared/types.ts
var IPC = {
  // Request-response (renderer → main)
  START: "clui:start",
  CREATE_TAB: "clui:create-tab",
  PROMPT: "clui:prompt",
  CANCEL: "clui:cancel",
  STOP_TAB: "clui:stop-tab",
  RETRY: "clui:retry",
  STATUS: "clui:status",
  TAB_HEALTH: "clui:tab-health",
  CLOSE_TAB: "clui:close-tab",
  SELECT_DIRECTORY: "clui:select-directory",
  OPEN_EXTERNAL: "clui:open-external",
  OPEN_IN_TERMINAL: "clui:open-in-terminal",
  ATTACH_FILES: "clui:attach-files",
  TAKE_SCREENSHOT: "clui:take-screenshot",
  TRANSCRIBE_AUDIO: "clui:transcribe-audio",
  PASTE_IMAGE: "clui:paste-image",
  GET_DIAGNOSTICS: "clui:get-diagnostics",
  RESPOND_PERMISSION: "clui:respond-permission",
  INIT_SESSION: "clui:init-session",
  RESET_TAB_SESSION: "clui:reset-tab-session",
  ANIMATE_HEIGHT: "clui:animate-height",
  LIST_SESSIONS: "clui:list-sessions",
  LOAD_SESSION: "clui:load-session",
  EXPORT_CONVERSATION: "clui:export-conversation",
  // One-way events (main → renderer)
  TEXT_CHUNK: "clui:text-chunk",
  TOOL_CALL: "clui:tool-call",
  TOOL_CALL_UPDATE: "clui:tool-call-update",
  TOOL_CALL_COMPLETE: "clui:tool-call-complete",
  TASK_UPDATE: "clui:task-update",
  TASK_COMPLETE: "clui:task-complete",
  SESSION_DEAD: "clui:session-dead",
  SESSION_INIT: "clui:session-init",
  ERROR: "clui:error",
  RATE_LIMIT: "clui:rate-limit",
  // Window management
  RESIZE_HEIGHT: "clui:resize-height",
  SET_WINDOW_WIDTH: "clui:set-window-width",
  HIDE_WINDOW: "clui:hide-window",
  WINDOW_SHOWN: "clui:window-shown",
  SET_IGNORE_MOUSE_EVENTS: "clui:set-ignore-mouse-events",
  IS_VISIBLE: "clui:is-visible",
  DRAG_HOLDING: "clui:drag-holding",
  // Skill provisioning (main → renderer)
  SKILL_STATUS: "clui:skill-status",
  // Theme
  GET_THEME: "clui:get-theme",
  THEME_CHANGED: "clui:theme-changed",
  // Marketplace
  MARKETPLACE_FETCH: "clui:marketplace-fetch",
  MARKETPLACE_INSTALLED: "clui:marketplace-installed",
  MARKETPLACE_INSTALL: "clui:marketplace-install",
  MARKETPLACE_UNINSTALL: "clui:marketplace-uninstall",
  // OpenClaw controls
  OPENCLAW_HEALTH: "clui:openclaw-health",
  OPENCLAW_ONBOARD: "clui:openclaw-onboard",
  OPEN_PATH: "clui:open-path",
  OPENCLAW_MODEL_INFO: "clui:openclaw-model-info",
  OPENCLAW_SET_MODEL: "clui:openclaw-set-model",
  OPENCLAW_RUN: "clui:openclaw-run",
  GET_RUNTIME_METRICS: "clui:get-runtime-metrics",
  // Node host + gateway management
  NODE_STATUS: "clui:node-status",
  NODE_ACTION: "clui:node-action",
  GATEWAY_STATUS: "clui:gateway-status",
  GATEWAY_PROBE: "clui:gateway-probe",
  GATEWAY_CONFIG_GET: "clui:gateway-config-get",
  GATEWAY_CONFIG_SET: "clui:gateway-config-set",
  GET_CONNECTION_TARGET: "clui:get-connection-target",
  SET_CONNECTION_TARGET: "clui:set-connection-target",
  GET_SHORTCUTS: "clui:get-shortcuts",
  // Theming + branding
  THEME_EXPORT: "clui:theme-export",
  THEME_IMPORT: "clui:theme-import",
  SET_BRANDING: "clui:set-branding",
  TRACE_SHELL: "clui:trace-shell",
  /** main -> renderer: settle your DOM, you are about to become visible. */
  WINDOW_PREPARE: "clui:window-prepare",
  /** renderer -> main: prepare pass painted; safe to reveal. */
  WINDOW_READY: "clui:window-ready",
  /** main -> renderer: play your exit, you are about to be parked. */
  WINDOW_DISMISS: "clui:window-dismiss",
  /** renderer -> main: exit finished; safe to park off-screen. */
  WINDOW_DISMISS_READY: "clui:window-dismiss-ready",
  // Permission mode
  SET_PERMISSION_MODE: "clui:set-permission-mode",
  // Legacy (kept for backward compat during migration)
  STREAM_EVENT: "clui:stream-event",
  RUN_COMPLETE: "clui:run-complete",
  RUN_ERROR: "clui:run-error"
};

// ../OpenClaw-UI-saucer/src/shared/shortcuts.ts
function isMac(platform) {
  return platform === "darwin";
}
function getShortcuts(platform) {
  const mac = isMac(platform);
  const mod = mac ? "\u2318" : "Ctrl";
  const shift = mac ? "\u21E7" : "Shift";
  const alt = mac ? "\u2325" : "Alt";
  return [
    {
      id: "toggle-launcher",
      accelerator: "Alt+Space",
      keys: [alt, "Space"],
      action: "Toggle launcher"
    },
    {
      id: "toggle-launcher-fallback",
      accelerator: "CommandOrControl+Shift+K",
      keys: [mod, shift, "K"],
      action: "Toggle launcher (fallback)"
    },
    {
      id: "toggle-marketplace",
      accelerator: "CommandOrControl+Shift+M",
      keys: [mod, shift, "M"],
      action: "Open Community Skills"
    },
    {
      id: "open-agents",
      accelerator: "CommandOrControl+Shift+A",
      keys: [mod, shift, "A"],
      action: "Open Agents Control Center"
    },
    {
      id: "open-settings",
      accelerator: "CommandOrControl+Shift+S",
      keys: [mod, shift, "S"],
      action: "Open Settings Control Center"
    }
  ];
}

// ../OpenClaw-UI-saucer/src/main/claude/control-plane.ts
import { EventEmitter as EventEmitter5 } from "events";

// ../OpenClaw-UI-saucer/src/main/claude/run-manager.ts
import { spawn } from "child_process";
import { EventEmitter as EventEmitter2 } from "events";
import { homedir as homedir4 } from "os";
import { delimiter as delimiter3 } from "path";

// ../OpenClaw-UI-saucer/src/main/stream-parser.ts
import { EventEmitter } from "events";
var StreamParser = class _StreamParser extends EventEmitter {
  buffer = "";
  /**
   * Feed a chunk of data (from stdout) into the parser.
   * Emits 'event' for each parsed JSON line.
   */
  feed(chunk) {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() || "";
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        this.emit("event", parsed);
      } catch {
        this.emit("parse-error", trimmed);
      }
    }
  }
  /**
   * Flush any remaining data in the buffer (call when stream ends).
   */
  flush() {
    const trimmed = this.buffer.trim();
    if (trimmed) {
      try {
        const parsed = JSON.parse(trimmed);
        this.emit("event", parsed);
      } catch {
        this.emit("parse-error", trimmed);
      }
    }
    this.buffer = "";
  }
  /**
   * Convenience: pipe a readable stream through the parser.
   */
  static fromStream(stream) {
    const parser = new _StreamParser();
    stream.setEncoding("utf-8");
    stream.on("data", (chunk) => parser.feed(chunk));
    stream.on("end", () => parser.flush());
    return parser;
  }
};

// ../OpenClaw-UI-saucer/src/main/claude/event-normalizer.ts
function normalize(raw) {
  switch (raw.type) {
    case "system":
      return normalizeSystem(raw);
    case "stream_event":
      return normalizeStreamEvent(raw);
    case "assistant":
      return normalizeAssistant(raw);
    case "result":
      return normalizeResult(raw);
    case "rate_limit_event":
      return normalizeRateLimit(raw);
    case "permission_request":
      return normalizePermission(raw);
    default:
      return [];
  }
}
function normalizeSystem(event) {
  if (event.subtype !== "init") return [];
  return [{
    type: "session_init",
    sessionId: event.session_id,
    tools: event.tools || [],
    model: event.model || "unknown",
    mcpServers: event.mcp_servers || [],
    skills: event.skills || [],
    version: event.claude_code_version || "unknown"
  }];
}
function normalizeStreamEvent(event) {
  const sub = event.event;
  if (!sub) return [];
  switch (sub.type) {
    case "content_block_start": {
      if (sub.content_block.type === "tool_use") {
        return [{
          type: "tool_call",
          toolName: sub.content_block.name || "unknown",
          toolId: sub.content_block.id || "",
          index: sub.index
        }];
      }
      return [];
    }
    case "content_block_delta": {
      const delta = sub.delta;
      if (delta.type === "text_delta") {
        return [{ type: "text_chunk", text: delta.text }];
      }
      if (delta.type === "input_json_delta") {
        return [{
          type: "tool_call_update",
          toolId: "",
          // caller can associate via index tracking
          partialInput: delta.partial_json
        }];
      }
      return [];
    }
    case "content_block_stop": {
      return [{
        type: "tool_call_complete",
        index: sub.index
      }];
    }
    case "message_start":
    case "message_delta":
    case "message_stop":
      return [];
    default:
      return [];
  }
}
function normalizeAssistant(event) {
  return [{
    type: "task_update",
    message: event.message
  }];
}
function normalizeResult(event) {
  if (event.is_error || event.subtype === "error") {
    return [{
      type: "error",
      message: event.result || "Unknown error",
      isError: true,
      sessionId: event.session_id
    }];
  }
  const denials = Array.isArray(event.permission_denials) ? event.permission_denials.map((d) => ({
    toolName: d.tool_name || "",
    toolUseId: d.tool_use_id || ""
  })) : void 0;
  return [{
    type: "task_complete",
    result: event.result || "",
    costUsd: event.total_cost_usd || 0,
    durationMs: event.duration_ms || 0,
    numTurns: event.num_turns || 0,
    usage: event.usage || {},
    sessionId: event.session_id,
    ...denials && denials.length > 0 ? { permissionDenials: denials } : {}
  }];
}
function normalizeRateLimit(event) {
  const info = event.rate_limit_info;
  if (!info) return [];
  return [{
    type: "rate_limit",
    status: info.status,
    resetsAt: info.resetsAt,
    rateLimitType: info.rateLimitType
  }];
}
function normalizePermission(event) {
  return [{
    type: "permission_request",
    questionId: event.question_id,
    toolName: event.tool?.name || "unknown",
    toolDescription: event.tool?.description,
    toolInput: event.tool?.input,
    options: (event.options || []).map((o) => ({
      id: o.id,
      label: o.label,
      kind: o.kind
    }))
  }];
}

// ../OpenClaw-UI-saucer/src/main/logger.ts
import { appendFile, appendFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
var LOG_FILE = join(homedir(), ".clui-debug.log");
var FLUSH_INTERVAL_MS = 500;
var MAX_BUFFER_SIZE = 64;
var buffer = [];
var timer = null;
var inFlight = /* @__PURE__ */ new Map();
var nextChunkId = 1;
function flush() {
  if (buffer.length === 0) return;
  const chunk = buffer.join("");
  buffer = [];
  const chunkId = nextChunkId++;
  inFlight.set(chunkId, chunk);
  appendFile(LOG_FILE, chunk, () => {
    inFlight.delete(chunkId);
  });
}
function ensureTimer() {
  if (timer) return;
  timer = setInterval(flush, FLUSH_INTERVAL_MS);
  if (timer && typeof timer === "object" && "unref" in timer) {
    timer.unref();
  }
}
function log(tag, msg) {
  buffer.push(`[${(/* @__PURE__ */ new Date()).toISOString()}] [${tag}] ${msg}
`);
  if (buffer.length >= MAX_BUFFER_SIZE) flush();
  ensureTimer();
}

// ../OpenClaw-UI-saucer/src/main/cli-env.ts
import { execSync } from "child_process";
import { homedir as homedir2 } from "os";
import { delimiter, join as join2 } from "path";
var IS_WIN = process.platform === "win32";
var cachedPath = null;
function appendPathEntries(target, seen, rawPath) {
  if (!rawPath) return;
  for (const entry of rawPath.split(delimiter)) {
    const p = entry.trim();
    if (!p) continue;
    const key = IS_WIN ? p.toLowerCase() : p;
    if (seen.has(key)) continue;
    seen.add(key);
    target.push(p);
  }
}
function getCliPath() {
  if (cachedPath) return cachedPath;
  const ordered = [];
  const seen = /* @__PURE__ */ new Set();
  appendPathEntries(ordered, seen, process.env.PATH || process.env.Path);
  if (IS_WIN) {
    const winExtras = [
      process.env.APPDATA ? join2(process.env.APPDATA, "npm") : "",
      process.env.LOCALAPPDATA ? join2(process.env.LOCALAPPDATA, "npm") : "",
      join2(homedir2(), "AppData", "Roaming", "npm"),
      process.env.ProgramFiles ? join2(process.env.ProgramFiles, "nodejs") : ""
    ].filter(Boolean);
    appendPathEntries(ordered, seen, winExtras.join(delimiter));
  } else {
    appendPathEntries(
      ordered,
      seen,
      ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(delimiter)
    );
    const pathCommands = [
      '/bin/zsh -ilc "echo $PATH"',
      '/bin/zsh -lc "echo $PATH"',
      '/bin/bash -lc "echo $PATH"'
    ];
    for (const cmd of pathCommands) {
      try {
        const discovered = execSync(cmd, { encoding: "utf-8", timeout: 3e3 }).trim();
        appendPathEntries(ordered, seen, discovered);
      } catch {
      }
    }
  }
  cachedPath = ordered.join(delimiter);
  return cachedPath;
}
function getCliEnv(extraEnv) {
  const env = {
    ...process.env,
    ...extraEnv,
    PATH: getCliPath()
  };
  if (IS_WIN && "Path" in env) delete env.Path;
  delete env.CLAUDECODE;
  return env;
}

// ../OpenClaw-UI-saucer/src/main/openclaw/runtime.ts
import { accessSync, constants, existsSync, readFileSync } from "fs";
import { homedir as homedir3 } from "os";
import { delimiter as delimiter2, dirname, isAbsolute, join as join3 } from "path";
var OPENCLAW_HOME_ENV = "OPENCLAW_HOME_DIR";
var OPENCLAW_CLI_ENV = "OPENCLAW_CLI";
var IS_WIN2 = process.platform === "win32";
function uniq(values) {
  return Array.from(new Set(values.filter(Boolean)));
}
function isExecutable(p) {
  try {
    accessSync(p, IS_WIN2 ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
function pathDirs() {
  const raw = process.env.PATH || process.env.Path || "";
  return raw.split(delimiter2).map((d) => d.trim()).filter(Boolean);
}
function globalBinDirs() {
  const dirs = [];
  if (IS_WIN2) {
    if (process.env.APPDATA) dirs.push(join3(process.env.APPDATA, "npm"));
    if (process.env.LOCALAPPDATA) dirs.push(join3(process.env.LOCALAPPDATA, "npm"));
    dirs.push(join3(homedir3(), "AppData", "Roaming", "npm"));
  } else {
    dirs.push("/usr/local/bin", "/opt/homebrew/bin", "/usr/bin");
    dirs.push(join3(homedir3(), ".npm-global", "bin"));
    dirs.push(join3(homedir3(), ".local", "bin"));
  }
  return uniq(dirs);
}
function shimNames(name) {
  return IS_WIN2 ? [`${name}.cmd`, `${name}.ps1`, `${name}.exe`, name] : [name];
}
function findShim(name) {
  for (const dir of [...pathDirs(), ...globalBinDirs()]) {
    for (const file of shimNames(name)) {
      const full = join3(dir, file);
      if (existsSync(full) && isExecutable(full)) return full;
    }
  }
  return null;
}
function findPackageEntry(binDir, pkg) {
  const roots = [
    join3(binDir, "node_modules", pkg),
    join3(binDir, "..", "lib", "node_modules", pkg)
    // POSIX npm prefix layout
  ];
  for (const root of roots) {
    const manifest = join3(root, "package.json");
    if (!existsSync(manifest)) continue;
    try {
      const parsed = JSON.parse(readFileSync(manifest, "utf-8"));
      const rel = typeof parsed.bin === "string" ? parsed.bin : parsed.bin?.[pkg] || Object.values(parsed.bin || {})[0];
      if (!rel) continue;
      const entry = join3(root, rel);
      if (existsSync(entry)) return entry;
    } catch {
    }
  }
  return null;
}
function findNodeExecutable() {
  const candidates = [];
  if (process.env.npm_node_execpath) candidates.push(process.env.npm_node_execpath);
  if (IS_WIN2) {
    candidates.push(
      join3(process.env.ProgramFiles || "C:\\Program Files", "nodejs", "node.exe"),
      join3(process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)", "nodejs", "node.exe"),
      join3(process.env.LOCALAPPDATA || "", "Programs", "nodejs", "node.exe")
    );
  } else {
    candidates.push("/usr/local/bin/node", "/opt/homebrew/bin/node", "/usr/bin/node");
  }
  for (const dir of pathDirs()) {
    candidates.push(join3(dir, IS_WIN2 ? "node.exe" : "node"));
  }
  for (const c of candidates) {
    if (c && existsSync(c) && isExecutable(c)) return { command: c, extraEnv: {} };
  }
  return { command: process.execPath, extraEnv: { ELECTRON_RUN_AS_NODE: "1" } };
}
function resolveKind(kind) {
  const shim = findShim(kind);
  const binDir = shim ? dirname(shim) : null;
  const searchDirs = uniq([...binDir ? [binDir] : [], ...globalBinDirs()]);
  for (const dir of searchDirs) {
    const entry = findPackageEntry(dir, kind);
    if (entry) {
      const node = findNodeExecutable();
      return {
        command: node.command,
        prefixArgs: [entry],
        kind,
        label: `${kind} (${entry})`,
        binDir: binDir || dir,
        extraEnv: node.extraEnv,
        resolved: true
      };
    }
  }
  if (shim) {
    return {
      command: shim,
      prefixArgs: [],
      kind,
      label: `${kind} (${shim})`,
      binDir,
      extraEnv: {},
      resolved: true
    };
  }
  return null;
}
function resolveOverride() {
  const raw = process.env[OPENCLAW_CLI_ENV]?.trim();
  if (!raw) return null;
  const kind = raw.includes("claude") && !raw.includes("openclaw") ? "claude" : "openclaw";
  if (isAbsolute(raw) && existsSync(raw)) {
    if (/\.(mjs|cjs|js)$/i.test(raw)) {
      const node = findNodeExecutable();
      return {
        command: node.command,
        prefixArgs: [raw],
        kind,
        label: `${kind} (override entry ${raw})`,
        binDir: dirname(raw),
        extraEnv: node.extraEnv,
        resolved: true
      };
    }
    return {
      command: raw,
      prefixArgs: [],
      kind,
      label: `${kind} (override ${raw})`,
      binDir: dirname(raw),
      extraEnv: {},
      resolved: true
    };
  }
  const shim = findShim(raw);
  if (shim) {
    return {
      command: shim,
      prefixArgs: [],
      kind,
      label: `${kind} (override ${shim})`,
      binDir: dirname(shim),
      extraEnv: {},
      resolved: true
    };
  }
  return {
    command: raw,
    prefixArgs: [],
    kind,
    label: `${kind} (override ${raw}, unverified)`,
    binDir: null,
    extraEnv: {},
    resolved: false
  };
}
var cached = null;
function getCliRuntime() {
  if (cached) return cached;
  cached = resolveOverride() || resolveKind("openclaw") || resolveKind("claude") || {
    // Nothing found. Keep the bare name so error messages stay legible;
    // the spawn will fail with a clear ENOENT rather than silently misbehaving.
    command: "openclaw",
    prefixArgs: [],
    kind: "openclaw",
    label: "openclaw (unresolved)",
    binDir: null,
    extraEnv: {},
    resolved: false
  };
  return cached;
}
function cliInvocation(args) {
  const rt = getCliRuntime();
  return { command: rt.command, args: [...rt.prefixArgs, ...args] };
}
function findCliBinary() {
  return getCliRuntime().command;
}
function getAgentDataHomes() {
  const envOverride = process.env[OPENCLAW_HOME_ENV]?.trim();
  return uniq([
    envOverride || "",
    join3(homedir3(), ".openclaw"),
    join3(homedir3(), ".claude")
  ]);
}
function getPrimaryAgentHome() {
  return getAgentDataHomes()[0];
}

// ../OpenClaw-UI-saucer/src/main/claude/run-manager.ts
var MAX_RING_LINES = 100;
var DEBUG = process.env.CLUI_DEBUG === "1";
var CLUI_SYSTEM_HINT = [
  "IMPORTANT: You are NOT running in a terminal. You are running inside CLUI,",
  "a desktop chat application with a rich UI that renders full markdown.",
  "CLUI is a GUI wrapper around Claude Code \u2014 the user sees your output in a",
  "styled conversation view, not a raw terminal.",
  "",
  "Because CLUI renders markdown natively, you MUST use rich formatting when it helps:",
  "- Always use clickable markdown links: [label](https://url) \u2014 they render as real buttons.",
  "- When the user asks for images, and public web images are appropriate, proactively find and render them in CLUI.",
  "- Workflow: WebSearch for relevant public pages -> WebFetch those pages -> extract real image URLs -> render with markdown ![alt](url).",
  "- Do not guess, fabricate, or construct image URLs from memory.",
  "- Only embed images when the URL is a real publicly accessible image URL found through tools or explicitly provided by the user.",
  "- If real image URLs cannot be obtained confidently, fall back to clickable links and briefly say so.",
  "- Do not ask whether CLUI can render images; assume it can.",
  "- Use tables, bold, headers, and bullet lists freely \u2014 they all render beautifully.",
  "- Use code blocks with language tags for syntax highlighting.",
  "",
  "You are still a software engineering assistant. Keep using your tools (Read, Edit, Bash, etc.)",
  "normally. But when presenting information, links, resources, or explanations to the user,",
  "take full advantage of the rich UI. The user expects a polished chat experience, not raw terminal text."
].join("\n");
var SAFE_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "LS",
  "TodoRead",
  "TodoWrite",
  "Agent",
  "Task",
  "TaskOutput",
  "Notebook",
  "WebSearch",
  "WebFetch"
];
var DEFAULT_ALLOWED_TOOLS = [
  "Bash",
  "Edit",
  "Write",
  "MultiEdit",
  ...SAFE_TOOLS
];
function log2(msg) {
  log("RunManager", msg);
}
var RunManager = class extends EventEmitter2 {
  activeRuns = /* @__PURE__ */ new Map();
  /** Holds recently-finished runs so diagnostics survive past process exit */
  _finishedRuns = /* @__PURE__ */ new Map();
  runtime;
  constructor() {
    super();
    this.runtime = getCliRuntime();
    log2(`CLI runtime: ${this.runtime.label}`);
  }
  _getEnv() {
    const env = getCliEnv(this.runtime.extraEnv);
    const binDir = this.runtime.binDir;
    if (binDir && env.PATH && !env.PATH.split(delimiter3).includes(binDir)) {
      env.PATH = `${binDir}${delimiter3}${env.PATH}`;
    }
    return env;
  }
  startRun(requestId, options) {
    const cwd = options.projectPath === "~" ? homedir4() : options.projectPath;
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--permission-mode",
      "default"
    ];
    if (options.sessionId) {
      args.push("--resume", options.sessionId);
    }
    if (options.model) {
      args.push("--model", options.model);
    }
    if (options.addDirs && options.addDirs.length > 0) {
      for (const dir of options.addDirs) {
        args.push("--add-dir", dir);
      }
    }
    if (options.hookSettingsPath) {
      args.push("--settings", options.hookSettingsPath);
      const safeAllowed = [
        ...SAFE_TOOLS,
        ...options.allowedTools || []
      ];
      args.push("--allowedTools", safeAllowed.join(","));
    } else {
      const allAllowed = [
        ...DEFAULT_ALLOWED_TOOLS,
        ...options.allowedTools || []
      ];
      args.push("--allowedTools", allAllowed.join(","));
    }
    if (options.maxTurns) {
      args.push("--max-turns", String(options.maxTurns));
    }
    if (options.maxBudgetUsd) {
      args.push("--max-budget-usd", String(options.maxBudgetUsd));
    }
    if (options.systemPrompt) {
      args.push("--system-prompt", options.systemPrompt);
    }
    args.push("--append-system-prompt", CLUI_SYSTEM_HINT);
    const spawnArgs = [...this.runtime.prefixArgs, ...args];
    if (DEBUG) {
      log2(`Starting run ${requestId}: ${this.runtime.command} ${spawnArgs.join(" ")}`);
      log2(`Prompt: ${options.prompt.substring(0, 200)}`);
    } else {
      log2(`Starting run ${requestId}`);
    }
    const child = spawn(this.runtime.command, spawnArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      cwd,
      env: this._getEnv()
    });
    log2(`Spawned PID: ${child.pid}`);
    const handle = {
      runId: requestId,
      sessionId: options.sessionId || null,
      process: child,
      pid: child.pid || null,
      startedAt: Date.now(),
      stderrTail: [],
      stdoutTail: [],
      toolCallCount: 0,
      sawPermissionRequest: false,
      permissionDenials: []
    };
    const parser = StreamParser.fromStream(child.stdout);
    parser.on("event", (raw) => {
      if (raw.type === "system" && "subtype" in raw && raw.subtype === "init") {
        handle.sessionId = raw.session_id;
      }
      if (raw.type === "permission_request" || raw.type === "system" && "subtype" in raw && raw.subtype === "permission_request") {
        handle.sawPermissionRequest = true;
        log2(`Permission request seen [${requestId}]`);
      }
      if (raw.type === "result") {
        const denials = raw.permission_denials;
        if (Array.isArray(denials) && denials.length > 0) {
          handle.permissionDenials = denials.map((d) => ({
            tool_name: d.tool_name || "",
            tool_use_id: d.tool_use_id || ""
          }));
          log2(`Permission denials [${requestId}]: ${JSON.stringify(handle.permissionDenials)}`);
        }
      }
      this._ringPush(handle.stdoutTail, JSON.stringify(raw).substring(0, 300));
      this.emit("raw", requestId, raw);
      const normalized = normalize(raw);
      for (const evt of normalized) {
        if (evt.type === "tool_call") handle.toolCallCount++;
        this.emit("normalized", requestId, evt);
      }
      if (raw.type === "result") {
        log2(`Run complete [${requestId}]: sawPermissionRequest=${handle.sawPermissionRequest}, denials=${handle.permissionDenials.length}`);
        try {
          child.stdin?.end();
        } catch {
        }
      }
    });
    parser.on("parse-error", (line) => {
      log2(`Parse error [${requestId}]: ${line.substring(0, 200)}`);
      this._ringPush(handle.stderrTail, `[parse-error] ${line.substring(0, 200)}`);
    });
    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (data) => {
      const lines = data.split("\n").filter((l) => l.trim());
      for (const line of lines) {
        this._ringPush(handle.stderrTail, line);
      }
      log2(`Stderr [${requestId}]: ${data.trim().substring(0, 500)}`);
    });
    child.on("close", (code, signal) => {
      log2(`Process closed [${requestId}]: code=${code} signal=${signal}`);
      this._finishedRuns.set(requestId, handle);
      this.activeRuns.delete(requestId);
      this.emit("exit", requestId, code, signal, handle.sessionId);
      setTimeout(() => this._finishedRuns.delete(requestId), 5e3);
    });
    child.on("error", (err) => {
      log2(`Process error [${requestId}]: ${err.message}`);
      this._finishedRuns.set(requestId, handle);
      this.activeRuns.delete(requestId);
      this.emit("error", requestId, err);
      setTimeout(() => this._finishedRuns.delete(requestId), 5e3);
    });
    const userMessage = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: options.prompt }]
      }
    });
    child.stdin.write(userMessage + "\n");
    this.activeRuns.set(requestId, handle);
    return handle;
  }
  /**
   * Write a message to a running process's stdin (for follow-up prompts, etc.)
   */
  writeToStdin(requestId, message) {
    const handle = this.activeRuns.get(requestId);
    if (!handle) return false;
    if (!handle.process.stdin || handle.process.stdin.destroyed) return false;
    const json = JSON.stringify(message);
    log2(`Writing to stdin [${requestId}]: ${json.substring(0, 200)}`);
    handle.process.stdin.write(json + "\n");
    return true;
  }
  /**
   * Cancel a running process: SIGINT, then SIGKILL after 5s.
   */
  cancel(requestId) {
    const handle = this.activeRuns.get(requestId);
    if (!handle) return false;
    log2(`Cancelling run ${requestId}`);
    handle.process.kill("SIGINT");
    setTimeout(() => {
      if (handle.process.exitCode === null) {
        log2(`Force killing run ${requestId} (SIGINT did not terminate)`);
        handle.process.kill("SIGKILL");
      }
    }, 5e3);
    return true;
  }
  /**
   * Get an enriched error object for a failed run.
   */
  getEnrichedError(requestId, exitCode) {
    const handle = this.activeRuns.get(requestId) || this._finishedRuns.get(requestId);
    return {
      message: `Run failed with exit code ${exitCode}`,
      stderrTail: handle?.stderrTail.slice(-20) || [],
      stdoutTail: handle?.stdoutTail.slice(-20) || [],
      exitCode,
      elapsedMs: handle ? Date.now() - handle.startedAt : 0,
      toolCallCount: handle?.toolCallCount || 0,
      sawPermissionRequest: handle?.sawPermissionRequest || false,
      permissionDenials: handle?.permissionDenials || []
    };
  }
  isRunning(requestId) {
    return this.activeRuns.has(requestId);
  }
  getHandle(requestId) {
    return this.activeRuns.get(requestId);
  }
  getActiveRunIds() {
    return Array.from(this.activeRuns.keys());
  }
  _ringPush(buffer2, line) {
    buffer2.push(line);
    if (buffer2.length > MAX_RING_LINES) {
      buffer2.shift();
    }
  }
};

// ../OpenClaw-UI-saucer/src/main/claude/pty-run-manager.ts
import { EventEmitter as EventEmitter3 } from "events";
import { homedir as homedir5 } from "os";
import { join as join5, delimiter as delimiter4 } from "path";
import { appendFileSync as appendFileSync2, chmodSync, existsSync as existsSync2, statSync } from "fs";
var pty;
try {
  pty = __require("node-pty");
} catch (err) {
}
var LOG_FILE2 = join5(homedir5(), ".clui-debug.log");
var MAX_RING_LINES2 = 100;
var PTY_BUFFER_SIZE = 50;
var PERMISSION_TIMEOUT_MS = 5 * 60 * 1e3;
var QUIESCENCE_MS = 2e3;
function log3(msg) {
  const line = `[${(/* @__PURE__ */ new Date()).toISOString()}] [PtyRunManager] ${msg}
`;
  try {
    appendFileSync2(LOG_FILE2, line);
  } catch {
  }
}
function stripAnsi(str) {
  return str.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b[()][0-9A-Za-z]/g, "").replace(/\x1b[#=>\[\]]/g, "").replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "");
}
function normalizeForMatch(input) {
  let norm = "";
  const map = [];
  let lastSpace = false;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    const lower = ch.toLowerCase();
    if (/[a-z0-9]/.test(lower)) {
      norm += lower;
      map.push(i);
      lastSpace = false;
      continue;
    }
    if (/\s/.test(lower) || /[^a-z0-9]/.test(lower)) {
      if (!lastSpace && norm.length > 0) {
        norm += " ";
        map.push(i);
        lastSpace = true;
      }
    }
  }
  if (norm.endsWith(" ")) {
    norm = norm.slice(0, -1);
    map.pop();
  }
  return { norm, map };
}
function detectPermissionPrompt(lines) {
  const joined = lines.join("\n");
  let confidence = 0;
  let toolName = "";
  let rawPrompt = "";
  const toolMatch = joined.match(/(?:wants?\s+to\s+(?:use|run|execute)|Tool:\s*|tool_name:\s*)(\w+)/i);
  if (toolMatch) {
    toolName = toolMatch[1];
    confidence += 3;
  }
  const permissionKeywords = [
    /\ballow\b/i,
    /\bdeny\b/i,
    /\breject\b/i,
    /\bpermission\b/i,
    /\bapprove\b/i
  ];
  for (const kw of permissionKeywords) {
    if (kw.test(joined)) confidence++;
  }
  const hasOptions = /(?:❯|›|>)\s*(?:Allow|Deny|Yes|No)/i.test(joined) || /\b(?:Allow\s+(?:once|always|for\s+(?:this\s+)?(?:project|session)))\b/i.test(joined);
  if (hasOptions) confidence += 2;
  if (confidence < 4) return null;
  const options = [];
  const optionPatterns = [
    { pattern: /Allow\s+(?:for\s+(?:this\s+)?(?:project|session)|always)/i, label: "Allow for this project", kind: "allow" },
    { pattern: /Allow\s+once/i, label: "Allow once", kind: "allow" },
    { pattern: /\bAlways\s+allow\b/i, label: "Always allow", kind: "allow" },
    { pattern: /(?:^|\s)Allow(?:\s|$)/i, label: "Allow", kind: "allow" },
    { pattern: /\bDeny\b/i, label: "Deny", kind: "deny" },
    { pattern: /\bReject\b/i, label: "Reject", kind: "deny" }
  ];
  let optIdx = 0;
  for (const op of optionPatterns) {
    if (op.pattern.test(joined)) {
      optIdx++;
      options.push({
        optionId: `opt-${optIdx}`,
        label: op.label,
        // Terminal value: we'll use arrow key navigation + Enter
        // The position in the list determines how many down arrows to press
        terminalValue: String(optIdx)
      });
    }
  }
  if (options.length === 0 && confidence >= 4) {
    options.push(
      { optionId: "opt-1", label: "Allow", terminalValue: "1" },
      { optionId: "opt-2", label: "Deny", terminalValue: "2" }
    );
  }
  rawPrompt = lines.slice(-10).join("\n");
  return { toolName: toolName || "Unknown", rawPrompt, options };
}
function extractSessionId(text) {
  const match = text.match(/(?:session[_ ]?id|Session|Resuming session)[:\s]+([a-f0-9-]{36})/i);
  return match ? match[1] : null;
}
function isInputPrompt(line) {
  const cleaned = line.trim();
  if (cleaned === "\u276F" || cleaned === ">" || cleaned === "$") return true;
  if (/^[❯>]\s*(?:\?\s*for\s*shortcuts)?$/.test(cleaned)) return true;
  if (/^gateway\s+connected\s*\|\s*idle\b/i.test(cleaned)) return true;
  if (/^gateway\s+connected\s*\|\s*idle\/exit\b/i.test(cleaned)) return true;
  return false;
}
function isUiChrome(line) {
  const cleaned = line.trim();
  if (!cleaned) return true;
  if (/^🦞\s+OpenClaw\b/i.test(cleaned)) return true;
  if (/^\s*◇\s*Doctor warnings/i.test(cleaned)) return true;
  if (/^openclaw\s+tui\b/i.test(cleaned)) return true;
  if (/^\s*(?:connected|connecting|idle)\s*\|\s*idle\b/i.test(cleaned)) return true;
  if (/^gateway\s+connected\s*\|\s*idle\/exit\b/i.test(cleaned)) return true;
  if (/^gateway\s+connected\s*\|\s*idle\b/i.test(cleaned)) return true;
  if (/^connected\s*\|\s*press\s+ctrl\+c\s+again\s+to\s+exit\b/i.test(cleaned)) return true;
  if (/agent\s+[^\|]+\s+\|\s+session\s+[^\|]+/i.test(cleaned)) return true;
  if (/\|\s+think\s+\w+\s+\|\s+tokens\s+/i.test(cleaned)) return true;
  if (/^\s*tokens\s+\?\/\d+/i.test(cleaned)) return true;
  if (/^\s*session\s+agent:/i.test(cleaned)) return true;
  if (/^[╭│╰─┌└┃┏┗┐┘┤├┬┴┼]/.test(cleaned)) return true;
  if (/^[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏✢✳✶✻✽]/.test(cleaned)) return true;
  if (/^\s*(?:Medium|Low|High)\s/.test(cleaned) && /model/i.test(cleaned)) return true;
  if (/\/mcp|MCP server/i.test(cleaned)) return true;
  if (/Claude\s*Code\s*v/i.test(cleaned) || /ClaudeCodev/i.test(cleaned)) return true;
  if (/^[❯>$]\s*$/.test(cleaned)) return true;
  if (/^\$[\d.]+\s+·/.test(cleaned)) return true;
  if (/for\s*shortcuts/i.test(cleaned)) return true;
  if (/zigzagging|thinking|processing|nebulizing|Boondoggling/i.test(cleaned)) return true;
  if (/^esctointerrupt/i.test(cleaned)) return true;
  if (/^[❯>]\s*\?\s*for\s*shortcuts/i.test(cleaned)) return true;
  if (/Opus\s*[\d.]+\s*·/i.test(cleaned)) return true;
  if (/Claude\s*Max/i.test(cleaned)) return true;
  if (/settings?\s*issue|\/doctor/i.test(cleaned)) return true;
  if (/^[─━▪\-=]{4,}/.test(cleaned)) return true;
  if (/^[▗▖▘▝▀▄▌▐█░▒▓■□▪▫●○◆◇◈]+$/.test(cleaned)) return true;
  return false;
}
function buildConnectionArgs(target) {
  if (!target || target.mode === "auto") return [];
  if (target.mode === "local") return ["--local"];
  if (target.viaConfig) return [];
  const args = [];
  if (target.url) args.push("--url", target.url);
  if (target.token) {
    args.push("--token", target.token);
  } else if (target.password) {
    args.push("--password", target.password);
  } else if (target.url) {
    log3("Connection target has a URL but no credential \u2014 falling back to CLI config resolution");
    return [];
  }
  if (target.token || target.password) {
    log3("WARNING: emitting an explicit gateway credential on the command line \u2014 visible in the process table");
  }
  return args;
}
function redactArgs(args) {
  const secret = /* @__PURE__ */ new Set(["--token", "--password"]);
  return args.map((arg, i) => i > 0 && secret.has(args[i - 1]) ? "<redacted>" : arg);
}
function parseGatewayState(line) {
  const cleaned = line.trim();
  const disconnected = cleaned.match(/gateway\s+disconnected(?:\s*[:|-]\s*(.+))?$/i);
  if (disconnected) return { state: "disconnected", detail: disconnected[1]?.trim() };
  if (/gateway\s+connecting\b/i.test(cleaned)) return { state: "connecting" };
  if (/gateway\s+connected\b/i.test(cleaned)) return { state: "connected" };
  if (/^connecting\s*\|/i.test(cleaned)) return { state: "connecting" };
  if (/^connected\s*\|/i.test(cleaned)) return { state: "connected" };
  if (/pairing required|scope upgrade|missing scope/i.test(cleaned)) {
    return { state: "disconnected", detail: cleaned };
  }
  return null;
}
function parseToolCallLine(line) {
  const match = line.match(/^\s*(?:⏳|✓|✗|⚡|🔧|Running|Executing)\s+([A-Za-z_][\w-]*)\s*(.*)$/i) || line.match(/^\s*(?:Tool|Using):\s*([A-Za-z_][\w-]*)\s*(.*)$/i);
  if (match) {
    return { toolName: match[1], input: match[2].trim() };
  }
  return null;
}
var PtyRunManager = class extends EventEmitter3 {
  activeRuns = /* @__PURE__ */ new Map();
  _finishedRuns = /* @__PURE__ */ new Map();
  runtime;
  recentLineSet = /* @__PURE__ */ new Set();
  recentLines = [];
  constructor() {
    super();
    this.runtime = getCliRuntime();
    this._ensureSpawnHelperExecutable();
    log3(`CLI runtime: ${this.runtime.label} (kind=${this.runtime.kind}, resolved=${this.runtime.resolved})`);
  }
  _rememberLine(line) {
    if (!line) return;
    if (this.recentLineSet.has(line)) return;
    this.recentLineSet.add(line);
    this.recentLines.push(line);
    if (this.recentLines.length > 300) {
      const drop = this.recentLines.shift();
      if (drop) this.recentLineSet.delete(drop);
    }
  }
  _isDuplicateLine(line) {
    return this.recentLineSet.has(line);
  }
  // (moved to class methods below)
  /**
   * node-pty prebuilt spawn-helper may lose execute bit depending on install/archive flow.
   * Ensure it's executable at runtime to avoid "posix_spawnp failed".
   */
  _ensureSpawnHelperExecutable() {
    try {
      const pkgPath = __require.resolve("node-pty/package.json");
      const path = __require("path");
      const helperPath = path.join(
        path.dirname(pkgPath),
        "prebuilds",
        `${process.platform}-${process.arch}`,
        "spawn-helper"
      );
      if (!existsSync2(helperPath)) return;
      const st = statSync(helperPath);
      const isExecutable2 = (st.mode & 73) !== 0;
      if (!isExecutable2) {
        chmodSync(helperPath, 493);
        log3(`Fixed spawn-helper permissions: ${helperPath}`);
      }
    } catch (err) {
      log3(`spawn-helper permission check failed: ${err.message}`);
    }
  }
  _getEnv() {
    const env = getCliEnv(this.runtime.extraEnv);
    const binDir = this.runtime.binDir;
    if (binDir && env.PATH && !env.PATH.split(delimiter4).includes(binDir)) {
      env.PATH = `${binDir}${delimiter4}${env.PATH}`;
    }
    return env;
  }
  startRun(requestId, options) {
    if (!pty) {
      throw new Error("node-pty is not available \u2014 cannot use PTY transport");
    }
    const cwd = options.projectPath === "~" ? homedir5() : options.projectPath;
    const isOpenclaw = this.runtime.kind === "openclaw";
    const args = [...this.runtime.prefixArgs];
    if (isOpenclaw) {
      args.push("tui", "--message", options.prompt, "--session", options.sessionId || `clui-${requestId}`);
      args.push(...buildConnectionArgs(options.connection));
    } else {
      args.push("--permission-mode", "default");
      if (options.sessionId) {
        args.push("--resume", options.sessionId);
      }
      if (options.model) {
        args.push("--model", options.model);
      }
      if (options.allowedTools?.length) {
        args.push("--allowedTools", options.allowedTools.join(","));
      }
      if (options.systemPrompt) {
        args.push("--system-prompt", options.systemPrompt);
      }
      args.push(options.prompt);
    }
    log3(`Starting PTY run ${requestId}: ${this.runtime.command} ${redactArgs(args).join(" ")}`);
    log3(`Prompt: ${options.prompt.substring(0, 200)}`);
    const ptyProcess = pty.spawn(this.runtime.command, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd,
      env: this._getEnv()
    });
    log3(`Spawned PTY PID: ${ptyProcess.pid}`);
    const handle = {
      runId: requestId,
      sessionId: options.sessionId || null,
      pty: ptyProcess,
      pid: ptyProcess.pid,
      startedAt: Date.now(),
      rawOutputTail: [],
      stderrTail: [],
      toolCallCount: 0,
      pendingPermission: null,
      permissionPhase: "idle",
      ptyBuffer: [],
      permissionTimeout: null,
      textAccumulator: "",
      seenContent: false,
      pastInit: false,
      emittedSessionInit: false,
      selectorOptions: [],
      currentOptionIndex: 0,
      runCompleteEmitted: false,
      quiescenceTimer: null,
      lastOutputAt: Date.now(),
      lastMeaningfulOutputAt: Date.now(),
      promptSnippet: options.prompt.trim().toLowerCase().slice(0, 24),
      promptLine: (() => {
        const lines = options.prompt.split("\n").map((l) => l.trim()).filter(Boolean);
        return (lines[lines.length - 1] || options.prompt).trim();
      })(),
      promptKey: (() => {
        const lines = options.prompt.split("\n").map((l) => l.trim()).filter(Boolean);
        const line = (lines[lines.length - 1] || options.prompt).trim();
        return normalizeForMatch(line).norm;
      })(),
      sawPromptEcho: false,
      openclawTuiMode: isOpenclaw,
      sawIdleMarker: false,
      lastWorkingSignalAt: Date.now(),
      gatewayState: "unknown",
      gatewayDetail: null,
      terminalOutcome: null,
      connectionMode: options.connection?.mode || "auto"
    };
    if (isOpenclaw) {
      handle.sessionId = options.sessionId || `clui-${requestId}`;
      handle.emittedSessionInit = true;
      this.emit("normalized", requestId, {
        type: "session_init",
        sessionId: handle.sessionId,
        tools: [],
        model: options.model || "",
        mcpServers: [],
        skills: [],
        version: ""
      });
    }
    let lineBuffer = "";
    ptyProcess.onData((data) => {
      this._ringPush(handle.rawOutputTail, data.substring(0, 500));
      const chars = data;
      for (let ci = 0; ci < chars.length; ci++) {
        const ch = chars[ci];
        if (ch === "\n") {
          const completed = lineBuffer.endsWith("\r") ? lineBuffer.slice(0, -1) : lineBuffer;
          lineBuffer = "";
          this._processLine(requestId, handle, completed);
        } else if (ch === "\r") {
          const next = ci + 1 < chars.length ? chars[ci + 1] : null;
          if (next === "\n" || next === "\r") {
            lineBuffer += "\r";
          } else if (next === null) {
            lineBuffer += "\r";
          } else {
            lineBuffer = "";
          }
        } else {
          lineBuffer += ch;
        }
      }
      if (lineBuffer.length > 0) {
        const cleaned = stripAnsi(lineBuffer).trim();
        if (cleaned.length > 0) {
          this._checkPermissionInBuffer(requestId, handle, cleaned);
          if (isInputPrompt(cleaned)) {
            if (handle.ptyBuffer.length === 0 || handle.ptyBuffer[handle.ptyBuffer.length - 1] !== cleaned) {
              this._ringPushBuffer(handle.ptyBuffer, cleaned);
            }
            handle.lastMeaningfulOutputAt = Date.now();
            if (handle.quiescenceTimer) clearTimeout(handle.quiescenceTimer);
            handle.quiescenceTimer = setTimeout(
              () => this._checkQuiescenceCompletion(requestId, handle),
              QUIESCENCE_MS
            );
          }
        }
      }
    });
    ptyProcess.onExit(({ exitCode, signal }) => {
      log3(`PTY exited [${requestId}]: code=${exitCode} signal=${signal}`);
      if (handle.permissionTimeout) {
        clearTimeout(handle.permissionTimeout);
        handle.permissionTimeout = null;
      }
      if (handle.quiescenceTimer) {
        clearTimeout(handle.quiescenceTimer);
        handle.quiescenceTimer = null;
      }
      this._flushText(requestId, handle, true);
      this._emitTerminal(requestId, handle);
      this._finishedRuns.set(requestId, handle);
      this.activeRuns.delete(requestId);
      this.emit("exit", requestId, exitCode, signal, handle.sessionId);
      setTimeout(() => this._finishedRuns.delete(requestId), 5e3);
    });
    this.activeRuns.set(requestId, handle);
    return handle;
  }
  /**
   * Process a single line of PTY output.
   */
  _processLine(requestId, handle, rawLine) {
    let cleaned = stripAnsi(rawLine).trim();
    if (cleaned.length === 0) return;
    handle.lastOutputAt = Date.now();
    if (handle.openclawTuiMode) {
      const gw = parseGatewayState(cleaned);
      if (gw && gw.state !== handle.gatewayState) {
        handle.gatewayState = gw.state;
        handle.gatewayDetail = gw.detail || null;
        log3(`Gateway state [${requestId}]: ${gw.state}${gw.detail ? ` (${gw.detail})` : ""}`);
        this.emit("normalized", requestId, {
          type: "gateway_state",
          state: gw.state,
          detail: gw.detail
        });
      }
      if (/gateway\s+connected\s*\|\s*idle(?:\/exit)?\b/i.test(cleaned)) {
        handle.sawIdleMarker = true;
      }
      if (/\bworking\b|\bthinking\b|\brunning\b|\bexecuting\b|\bprocessing\b/i.test(cleaned)) {
        handle.lastWorkingSignalAt = Date.now();
      }
    }
    const promptMarker = isInputPrompt(cleaned);
    if (handle.openclawTuiMode && isUiChrome(cleaned) && !promptMarker) return;
    if (/^(?:\?[0-9;?]*[a-zA-Z])+$/i.test(cleaned)) return;
    if (handle.ptyBuffer.length > 0 && handle.ptyBuffer[handle.ptyBuffer.length - 1] === cleaned) return;
    this._ringPushBuffer(handle.ptyBuffer, cleaned);
    if (!isUiChrome(cleaned) || promptMarker) {
      handle.lastMeaningfulOutputAt = Date.now();
      if (handle.quiescenceTimer) clearTimeout(handle.quiescenceTimer);
      handle.quiescenceTimer = setTimeout(() => this._checkQuiescenceCompletion(requestId, handle), QUIESCENCE_MS);
    }
    log3(`PTY line [${requestId}]: ${cleaned.substring(0, 200)}`);
    if (!handle.emittedSessionInit) {
      const sid = extractSessionId(cleaned);
      if (sid) {
        handle.sessionId = sid;
        handle.emittedSessionInit = true;
        this.emit("normalized", requestId, {
          type: "session_init",
          sessionId: sid,
          tools: [],
          model: "",
          mcpServers: [],
          skills: [],
          version: ""
        });
      }
    }
    if (!handle.pastInit) {
      const isPromptEcho = handle.promptSnippet && cleaned.toLowerCase().startsWith(handle.promptSnippet) && cleaned.length <= handle.promptSnippet.length + 2;
      if (handle.openclawTuiMode) {
        if (!handle.promptKey) return;
        const { norm, map } = normalizeForMatch(cleaned);
        const idx = norm.lastIndexOf(handle.promptKey);
        if (idx === -1) {
          return;
        }
        handle.sawPromptEcho = true;
        handle.textAccumulator = "";
        handle.ptyBuffer = [];
        handle.seenContent = false;
        handle.pastInit = true;
        const endNorm = idx + handle.promptKey.length - 1;
        const endOrig = map[endNorm] ?? cleaned.length - 1;
        const after = cleaned.slice(endOrig + 1).trim();
        if (!after) return;
        cleaned = after;
      } else {
        if (/^[❯>]\s+/.test(cleaned)) {
          handle.sawPromptEcho = true;
        }
        if (handle.sawPromptEcho && cleaned.startsWith("\u23FA")) {
          handle.pastInit = true;
        } else {
          return;
        }
      }
    }
    if (handle.permissionPhase === "detecting" || handle.permissionPhase === "idle") {
      this._checkPermissionInBuffer(requestId, handle, cleaned);
      if (handle.permissionPhase === "waiting_user") {
        return;
      }
    }
    const toolCall = parseToolCallLine(cleaned);
    if (toolCall) {
      handle.toolCallCount++;
      this._flushText(requestId, handle);
      this.emit("normalized", requestId, {
        type: "tool_call",
        toolName: toolCall.toolName,
        toolId: `pty-tool-${handle.toolCallCount}`,
        index: handle.toolCallCount - 1
      });
      setTimeout(() => {
        this.emit("normalized", requestId, {
          type: "tool_call_complete",
          index: handle.toolCallCount - 1
        });
      }, 100);
      return;
    }
    if (isUiChrome(cleaned)) return;
    if (handle.openclawTuiMode && handle.sawPromptEcho && this._isDuplicateLine(cleaned)) {
      return;
    }
    if (handle.textAccumulator.length > 0) {
      handle.textAccumulator += "\n";
    }
    const textLine = cleaned.startsWith("\u23FA") ? cleaned.replace(/^⏺\s*/, "") : cleaned;
    handle.textAccumulator += textLine;
    handle.seenContent = true;
    if (handle.openclawTuiMode) this._rememberLine(cleaned);
    this._scheduleTextFlush(requestId, handle);
  }
  /**
   * Emit the single terminal event for a run.
   *
   * A run that produced no content while the gateway was never reachable is a
   * failure, not an empty success. Reporting task_complete in that case is
   * what made connection problems indistinguishable from a silent agent.
   */
  _emitTerminal(requestId, handle) {
    if (handle.runCompleteEmitted) return;
    handle.runCompleteEmitted = true;
    const targetedGateway = handle.openclawTuiMode && handle.connectionMode !== "local";
    const failed = targetedGateway && !handle.seenContent && (handle.gatewayState === "disconnected" || handle.gatewayState === "unknown" && !handle.sawIdleMarker);
    if (failed) {
      handle.terminalOutcome = "error";
      const detail = handle.gatewayDetail ? ` \u2014 ${handle.gatewayDetail}` : "";
      const reason = handle.gatewayState === "disconnected" ? `Gateway disconnected${detail}` : `No response from the agent gateway${detail}`;
      log3(`Run ${requestId} failed: ${reason}`);
      this.emit("normalized", requestId, {
        type: "error",
        message: `${reason}. Check the gateway connection in Control Center.`,
        isError: true,
        sessionId: handle.sessionId || void 0
      });
      return;
    }
    handle.terminalOutcome = "complete";
    this.emit("normalized", requestId, {
      type: "task_complete",
      result: "",
      costUsd: 0,
      durationMs: Date.now() - handle.startedAt,
      numTurns: 1,
      usage: {},
      sessionId: handle.sessionId || ""
    });
  }
  _checkQuiescenceCompletion(requestId, handle) {
    if (!this.activeRuns.has(requestId)) return;
    if (!handle.pastInit || handle.permissionPhase === "waiting_user") return;
    const silenceMs = Date.now() - handle.lastMeaningfulOutputAt;
    if (silenceMs < QUIESCENCE_MS - 50) {
      if (handle.quiescenceTimer) clearTimeout(handle.quiescenceTimer);
      handle.quiescenceTimer = setTimeout(() => this._checkQuiescenceCompletion(requestId, handle), QUIESCENCE_MS);
      return;
    }
    if (handle.openclawTuiMode && !handle.seenContent) {
      const waitedMs = Date.now() - handle.startedAt;
      if (waitedMs < 45e3) {
        if (handle.quiescenceTimer) clearTimeout(handle.quiescenceTimer);
        handle.quiescenceTimer = setTimeout(() => this._checkQuiescenceCompletion(requestId, handle), QUIESCENCE_MS);
        return;
      }
    }
    const lastLines = handle.ptyBuffer.slice(-3);
    const hasPromptMarker = lastLines.some((l) => isInputPrompt(l));
    const openclawSilence = handle.openclawTuiMode && handle.seenContent && !hasPromptMarker && Date.now() - handle.lastMeaningfulOutputAt >= QUIESCENCE_MS * 5 && Date.now() - handle.lastWorkingSignalAt >= QUIESCENCE_MS * 5;
    if (!hasPromptMarker && !openclawSilence) {
      if (handle.openclawTuiMode) {
        if (!handle.sawIdleMarker) {
          if (handle.quiescenceTimer) clearTimeout(handle.quiescenceTimer);
          handle.quiescenceTimer = setTimeout(() => this._checkQuiescenceCompletion(requestId, handle), QUIESCENCE_MS);
          return;
        }
        if (handle.quiescenceTimer) clearTimeout(handle.quiescenceTimer);
        handle.quiescenceTimer = setTimeout(() => this._checkQuiescenceCompletion(requestId, handle), QUIESCENCE_MS);
      }
      return;
    }
    this._flushText(requestId, handle, true);
    this._emitTerminal(requestId, handle);
    try {
      handle.pty.write("/exit\n");
    } catch {
    }
    setTimeout(() => {
      if (this.activeRuns.has(requestId)) {
        try {
          handle.pty.kill();
        } catch {
        }
      }
    }, 3e3);
  }
  _textFlushTimers = /* @__PURE__ */ new Map();
  _scheduleTextFlush(requestId, handle) {
    if (this._textFlushTimers.has(requestId)) return;
    const timer2 = setTimeout(() => {
      this._textFlushTimers.delete(requestId);
      this._flushText(requestId, handle);
    }, 50);
    this._textFlushTimers.set(requestId, timer2);
  }
  _flushText(requestId, handle, force = false) {
    const timer2 = this._textFlushTimers.get(requestId);
    if (timer2) {
      clearTimeout(timer2);
      this._textFlushTimers.delete(requestId);
    }
    if (handle.openclawTuiMode && !force) return;
    if (handle.textAccumulator.length > 0) {
      this.emit("normalized", requestId, {
        type: "text_chunk",
        text: handle.textAccumulator
      });
      handle.textAccumulator = "";
    }
  }
  /**
   * Check the current buffer for permission prompt patterns.
   */
  _checkPermissionInBuffer(requestId, handle, currentLine) {
    if (handle.openclawTuiMode) return;
    const detectionWindow = [...handle.ptyBuffer.slice(-10), currentLine];
    const permission = detectPermissionPrompt(detectionWindow);
    if (!permission) {
      const hasKeyword = /\b(?:permission|approve|allow|deny)\b/i.test(currentLine);
      if (hasKeyword && handle.permissionPhase === "idle") {
        handle.permissionPhase = "detecting";
      }
      return;
    }
    log3(`Permission prompt detected [${requestId}]: tool=${permission.toolName}, options=${permission.options.length}`);
    handle.pendingPermission = permission;
    handle.permissionPhase = "waiting_user";
    this._flushText(requestId, handle, true);
    const questionId = `pty-perm-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    this.emit("normalized", requestId, {
      type: "permission_request",
      questionId,
      toolName: permission.toolName,
      toolDescription: permission.rawPrompt,
      options: permission.options.map((o) => ({
        id: o.optionId,
        label: o.label,
        kind: o.label.toLowerCase().includes("deny") || o.label.toLowerCase().includes("reject") ? "deny" : "allow"
      }))
    });
    handle.permissionTimeout = setTimeout(() => {
      if (handle.permissionPhase === "waiting_user") {
        log3(`Permission timeout [${requestId}] \u2014 auto-denying`);
        this.emit("normalized", requestId, {
          type: "text_chunk",
          text: "\n[Permission timed out \u2014 automatically denied after 5 minutes]\n"
        });
        try {
          handle.pty.write("\x1B");
        } catch {
        }
        handle.permissionPhase = "idle";
        handle.pendingPermission = null;
      }
    }, PERMISSION_TIMEOUT_MS);
  }
  /**
   * Respond to a permission prompt by sending keystrokes to the PTY.
   */
  respondToPermission(requestId, _questionId, optionId) {
    const handle = this.activeRuns.get(requestId);
    if (!handle) {
      log3(`respondToPermission: no active run for ${requestId}`);
      return false;
    }
    if (handle.openclawTuiMode) {
      log3(`respondToPermission: refusing to write keystrokes in OpenClaw TUI mode (${requestId})`);
      return false;
    }
    if (handle.permissionPhase !== "waiting_user" || !handle.pendingPermission) {
      log3(`respondToPermission: not waiting for permission (phase=${handle.permissionPhase})`);
      return false;
    }
    if (handle.permissionTimeout) {
      clearTimeout(handle.permissionTimeout);
      handle.permissionTimeout = null;
    }
    const option = handle.pendingPermission.options.find((o) => o.optionId === optionId);
    if (!option) {
      log3(`respondToPermission: option ${optionId} not found`);
      return false;
    }
    log3(`respondToPermission [${requestId}]: optionId=${optionId}, label=${option.label}`);
    const optionIndex = handle.pendingPermission.options.indexOf(option);
    const isAllow = option.label.toLowerCase().includes("allow") || option.label.toLowerCase().includes("yes");
    const isDeny = option.label.toLowerCase().includes("deny") || option.label.toLowerCase().includes("reject");
    try {
      if (isDeny) {
        handle.pty.write("n");
      } else if (isAllow && optionIndex === 0) {
        handle.pty.write("\r");
      } else {
        for (let i = 0; i < optionIndex; i++) {
          handle.pty.write("\x1B[B");
        }
        setTimeout(() => {
          try {
            handle.pty.write("\r");
          } catch {
          }
        }, 50);
      }
    } catch (err) {
      log3(`respondToPermission: write error: ${err.message}`);
      return false;
    }
    handle.permissionPhase = "answered";
    handle.pendingPermission = null;
    setTimeout(() => {
      if (handle.permissionPhase === "answered") {
        handle.permissionPhase = "idle";
      }
    }, 500);
    return true;
  }
  /**
   * Cancel a running PTY process.
   */
  cancel(requestId) {
    const handle = this.activeRuns.get(requestId);
    if (!handle) return false;
    log3(`Cancelling PTY run ${requestId}`);
    if (handle.permissionTimeout) {
      clearTimeout(handle.permissionTimeout);
      handle.permissionTimeout = null;
    }
    try {
      handle.pty.write("");
    } catch {
    }
    setTimeout(() => {
      if (this.activeRuns.has(requestId)) {
        log3(`Force killing PTY run ${requestId}`);
        try {
          handle.pty.kill();
        } catch {
        }
      }
    }, 5e3);
    return true;
  }
  /**
   * Write arbitrary data to PTY stdin (for follow-up messages, etc.)
   */
  writeToStdin(requestId, message) {
    const handle = this.activeRuns.get(requestId);
    if (!handle) return false;
    log3(`Writing to PTY stdin [${requestId}]: ${message.substring(0, 200)}`);
    try {
      handle.pty.write(message);
      return true;
    } catch {
      return false;
    }
  }
  /**
   * Get an enriched error object for a failed PTY run.
   */
  getEnrichedError(requestId, exitCode) {
    const handle = this.activeRuns.get(requestId) || this._finishedRuns.get(requestId);
    return {
      message: `PTY run failed with exit code ${exitCode}`,
      stderrTail: handle?.stderrTail.slice(-20) || [],
      stdoutTail: handle?.rawOutputTail.slice(-20) || [],
      exitCode,
      elapsedMs: handle ? Date.now() - handle.startedAt : 0,
      toolCallCount: handle?.toolCallCount || 0,
      sawPermissionRequest: handle?.permissionPhase !== "idle" || false,
      permissionDenials: []
    };
  }
  isRunning(requestId) {
    return this.activeRuns.has(requestId);
  }
  getHandle(requestId) {
    return this.activeRuns.get(requestId) || this._finishedRuns.get(requestId) || null;
  }
  getActiveRunIds() {
    return Array.from(this.activeRuns.keys());
  }
  _ringPush(buffer2, line) {
    buffer2.push(line);
    if (buffer2.length > MAX_RING_LINES2) buffer2.shift();
  }
  _ringPushBuffer(buffer2, line) {
    buffer2.push(line);
    if (buffer2.length > PTY_BUFFER_SIZE) buffer2.shift();
  }
};

// ../OpenClaw-UI-saucer/src/main/hooks/permission-server.ts
import { createServer } from "http";
import { EventEmitter as EventEmitter4 } from "events";
import { writeFileSync, mkdirSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join as join6 } from "path";
import { randomUUID } from "crypto";
var PERMISSION_TIMEOUT_MS2 = 5 * 60 * 1e3;
var DEFAULT_PORT = 19836;
var MAX_BODY_SIZE = 1024 * 1024;
var DEBUG2 = process.env.CLUI_DEBUG === "1";
var PERMISSION_REQUIRED_TOOLS = ["Bash", "Edit", "Write", "MultiEdit"];
var SAFE_BASH_COMMANDS = /* @__PURE__ */ new Set([
  // Info / help
  "cat",
  "head",
  "tail",
  "less",
  "more",
  "wc",
  "file",
  "stat",
  "ls",
  "pwd",
  "echo",
  "printf",
  "date",
  "whoami",
  "hostname",
  "uname",
  "which",
  "whence",
  "where",
  "type",
  "command",
  "man",
  "help",
  "info",
  // Search
  "find",
  "grep",
  "rg",
  "ag",
  "ack",
  "fd",
  "fzf",
  "locate",
  // Git read-only
  "git",
  // further checked: only read-only subcommands
  // Env / config
  "env",
  "printenv",
  "set",
  // Package info (read-only)
  "npm",
  "yarn",
  "pnpm",
  "bun",
  "cargo",
  "pip",
  "pip3",
  "go",
  "rustup",
  "node",
  "python",
  "python3",
  "ruby",
  "java",
  "javac",
  // Claude CLI (read-only subcommands)
  "claude",
  // OpenClaw CLI (read-only subcommands)
  "openclaw",
  // Disk / system info
  "df",
  "du",
  "free",
  "top",
  "htop",
  "ps",
  "uptime",
  "lsof",
  "tree",
  "realpath",
  "dirname",
  "basename",
  // macOS
  "sw_vers",
  "system_profiler",
  "defaults",
  "mdls",
  "mdfind",
  // Diff / compare
  "diff",
  "cmp",
  "comm",
  "sort",
  "uniq",
  "cut",
  "awk",
  "sed",
  "jq",
  "yq",
  "xargs",
  "tr"
]);
var GIT_MUTATING_SUBCOMMANDS = /* @__PURE__ */ new Set([
  "push",
  "commit",
  "merge",
  "rebase",
  "reset",
  "checkout",
  "switch",
  "branch",
  "tag",
  "stash",
  "cherry-pick",
  "revert",
  "am",
  "apply",
  "clean",
  "rm",
  "mv",
  "restore",
  "bisect",
  "pull",
  "fetch",
  "clone",
  "init",
  "submodule",
  "worktree",
  "gc",
  "prune",
  "filter-branch"
]);
var CLAUDE_MUTATING_SUBCOMMANDS = /* @__PURE__ */ new Set([
  "config",
  "login",
  "logout"
]);
var OPENCLAW_MUTATING_SUBCOMMANDS = /* @__PURE__ */ new Set([
  "config",
  "login",
  "logout"
]);
function isSafeBashCommand(command) {
  if (typeof command !== "string") return false;
  const trimmed = command.trim();
  if (!trimmed) return false;
  const segments = trimmed.split(/\s*(?:;|&&|\|\||[|])\s*/);
  for (const segment of segments) {
    const parts = segment.trim().split(/\s+/);
    const cmd = parts[0];
    if (!cmd) continue;
    const actualCmd = cmd.includes("=") ? parts[1] : cmd;
    if (!actualCmd) continue;
    const base = actualCmd.split("/").pop() || actualCmd;
    if (!SAFE_BASH_COMMANDS.has(base)) return false;
    if (base === "git") {
      const subIdx = cmd.includes("=") ? 2 : 1;
      const sub = parts[subIdx];
      if (sub && GIT_MUTATING_SUBCOMMANDS.has(sub)) return false;
    }
    if (base === "claude" || base === "openclaw") {
      const subIdx = cmd.includes("=") ? 2 : 1;
      const sub = parts[subIdx];
      const mutating = base === "openclaw" ? OPENCLAW_MUTATING_SUBCOMMANDS : CLAUDE_MUTATING_SUBCOMMANDS;
      if (sub && mutating.has(sub)) return false;
      if (sub === "mcp") {
        const mcpSub = parts[subIdx + 1];
        if (mcpSub && mcpSub !== "list" && mcpSub !== "get" && mcpSub !== "--help") return false;
      }
    }
    if (["npm", "yarn", "pnpm", "bun"].includes(base)) {
      const subIdx = cmd.includes("=") ? 2 : 1;
      const sub = parts[subIdx];
      if (sub && ["install", "i", "add", "remove", "uninstall", "publish", "run", "exec", "dlx", "npx", "create", "init", "link", "unlink", "pack", "deprecate"].includes(sub)) return false;
    }
    if (segment.includes(">") && !segment.includes(">/dev/null") && !segment.includes("2>/dev/null") && !segment.includes("2>&1")) return false;
  }
  return true;
}
var HOOK_MATCHER = `^(${PERMISSION_REQUIRED_TOOLS.join("|")}|mcp__.*)$`;
var SENSITIVE_FIELD_RE = /token|password|secret|key|auth|credential|api.?key/i;
var VALID_ALLOW_DECISIONS = /* @__PURE__ */ new Set(["allow", "allow-session", "allow-domain"]);
var VALID_DECISIONS = /* @__PURE__ */ new Set([...VALID_ALLOW_DECISIONS, "deny"]);
function log4(msg) {
  log("PermissionServer", msg);
}
function extractDomain(url) {
  if (typeof url !== "string") return null;
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}
function denyResponse(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: reason
    }
  };
}
function allowResponse(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      permissionDecisionReason: reason
    }
  };
}
var PermissionServer = class extends EventEmitter4 {
  server = null;
  pendingRequests = /* @__PURE__ */ new Map();
  port;
  _actualPort = null;
  /** Per-launch secret — validates that requests come from our hooks */
  appSecret;
  /** Per-run tokens → run registration (tabId, requestId, sessionId) */
  runTokens = /* @__PURE__ */ new Map();
  /** Scoped "allow always" keys. Format varies by tool type. */
  scopedAllows = /* @__PURE__ */ new Set();
  /** Tracked generated settings files: runToken → filePath */
  settingsFiles = /* @__PURE__ */ new Map();
  constructor(port = DEFAULT_PORT) {
    super();
    this.port = port;
    this.appSecret = randomUUID();
  }
  async start() {
    if (this.server) {
      log4("Server already running");
      return this._actualPort || this.port;
    }
    return new Promise((resolve2, reject) => {
      this.server = createServer((req, res) => this._handleRequest(req, res));
      this.server.on("error", (err) => {
        if (err.code === "EADDRINUSE") {
          log4(`Port ${this.port} in use, trying ${this.port + 1}`);
          this.port++;
          this.server.listen(this.port, "127.0.0.1");
        } else {
          log4(`Server error: ${err.message}`);
          reject(err);
        }
      });
      this.server.listen(this.port, "127.0.0.1", () => {
        this._actualPort = this.port;
        log4(`Permission server listening on 127.0.0.1:${this.port}`);
        resolve2(this.port);
      });
    });
  }
  stop() {
    for (const [qid, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.resolve({ decision: "deny", reason: "Server shutting down" });
      this.pendingRequests.delete(qid);
    }
    for (const [, filePath] of this.settingsFiles) {
      try {
        unlinkSync(filePath);
      } catch {
      }
    }
    this.settingsFiles.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
      log4("Permission server stopped");
    }
  }
  getPort() {
    return this._actualPort;
  }
  // ─── Run Registration ───
  /**
   * Register a new run. Returns a unique run token.
   * The run token is embedded in the hook URL for per-run routing.
   */
  registerRun(tabId, requestId, sessionId) {
    const runToken = randomUUID();
    this.runTokens.set(runToken, { tabId, requestId, sessionId });
    log4(`Registered run: token=${runToken.substring(0, 8)}\u2026 tab=${tabId.substring(0, 8)}\u2026`);
    return runToken;
  }
  /**
   * Unregister a run. Denies any pending requests for this run and cleans up its settings file.
   */
  unregisterRun(runToken) {
    const reg = this.runTokens.get(runToken);
    if (!reg) return;
    for (const [qid, pending] of this.pendingRequests) {
      if (pending.runToken === runToken) {
        clearTimeout(pending.timeout);
        pending.resolve({ decision: "deny", reason: "Run ended" });
        this.pendingRequests.delete(qid);
      }
    }
    const filePath = this.settingsFiles.get(runToken);
    if (filePath) {
      try {
        unlinkSync(filePath);
      } catch {
      }
      this.settingsFiles.delete(runToken);
    }
    this.runTokens.delete(runToken);
    log4(`Unregistered run: token=${runToken.substring(0, 8)}\u2026`);
  }
  // ─── Permission Response ───
  /**
   * Respond to a pending permission request.
   * decision: 'allow' (once), 'allow-session' (for session), 'allow-domain' (WebFetch domain), 'deny'
   */
  respondToPermission(questionId, decision, reason) {
    const pending = this.pendingRequests.get(questionId);
    if (!pending) {
      log4(`respondToPermission: no pending request for ${questionId}`);
      return false;
    }
    clearTimeout(pending.timeout);
    this.pendingRequests.delete(questionId);
    if (!VALID_DECISIONS.has(decision)) {
      log4(`Unknown decision "${decision}" for [${questionId}] \u2014 denying (fail-closed)`);
      pending.resolve({ decision: "deny", reason: `Unknown decision: ${decision}` });
      return true;
    }
    const toolName = pending.toolRequest.tool_name;
    const sessionId = pending.toolRequest.session_id;
    if (decision === "allow-session") {
      const key = `session:${sessionId}:tool:${toolName}`;
      this.scopedAllows.add(key);
      log4(`Session-allowed ${toolName} for session ${sessionId.substring(0, 8)}\u2026`);
    } else if (decision === "allow-domain") {
      const domain = extractDomain(pending.toolRequest.tool_input?.url);
      if (domain) {
        const key = `session:${sessionId}:webfetch:${domain}`;
        this.scopedAllows.add(key);
        log4(`Domain-allowed ${domain} for session ${sessionId.substring(0, 8)}\u2026`);
      }
    }
    const hookDecision = VALID_ALLOW_DECISIONS.has(decision) ? "allow" : "deny";
    if (DEBUG2) {
      log4(`respondToPermission [${questionId}]: ${decision} (tool=${toolName})`);
    } else {
      log4(`Permission: ${toolName} \u2192 ${hookDecision}`);
    }
    pending.resolve({ decision: hookDecision, reason });
    return true;
  }
  // ─── Dynamic Options ───
  /**
   * Get permission card options for a given tool + input.
   * WebFetch gets domain-scoped options; all others get session-scoped.
   */
  getOptionsForTool(toolName, toolInput) {
    if (toolName === "Bash") {
      return [
        { id: "allow", label: "Allow Once", kind: "allow" },
        { id: "deny", label: "Deny", kind: "deny" }
      ];
    }
    return [
      { id: "allow", label: "Allow Once", kind: "allow" },
      { id: "allow-session", label: "Allow for Session", kind: "allow" },
      { id: "deny", label: "Deny", kind: "deny" }
    ];
  }
  // ─── Settings File Generation ───
  /**
   * Generate a per-run settings file with the PreToolUse HTTP hook.
   * The URL includes both appSecret and runToken for authentication.
   */
  generateSettingsFile(runToken) {
    const port = this._actualPort || this.port;
    const settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: HOOK_MATCHER,
            hooks: [
              {
                type: "http",
                url: `http://127.0.0.1:${port}/hook/pre-tool-use/${this.appSecret}/${runToken}`,
                timeout: 300
              }
            ]
          }
        ]
      }
    };
    const dir = join6(tmpdir(), "clui-hook-config");
    try {
      mkdirSync(dir, { recursive: true, mode: 448 });
    } catch {
    }
    const filePath = join6(dir, `clui-hook-${runToken}.json`);
    writeFileSync(filePath, JSON.stringify(settings, null, 2), { mode: 384 });
    this.settingsFiles.set(runToken, filePath);
    if (DEBUG2) {
      log4(`Generated settings file: ${filePath}`);
    }
    return filePath;
  }
  // ─── HTTP Request Handling ───
  async _handleRequest(req, res) {
    if (req.method !== "POST") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify(denyResponse("Not found")));
      return;
    }
    const segments = (req.url || "").split("/").filter(Boolean);
    if (segments.length !== 4 || segments[0] !== "hook" || segments[1] !== "pre-tool-use") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify(denyResponse("Invalid path")));
      return;
    }
    const urlSecret = segments[2];
    const urlToken = segments[3];
    if (urlSecret !== this.appSecret) {
      log4("Rejected request: invalid app secret");
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify(denyResponse("Invalid credentials")));
      return;
    }
    const registration = this.runTokens.get(urlToken);
    if (!registration) {
      log4(`Rejected request: unknown run token ${urlToken.substring(0, 8)}\u2026`);
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify(denyResponse("Unknown run")));
      return;
    }
    let body = "";
    let bodySize = 0;
    for await (const chunk of req) {
      bodySize += chunk.length;
      if (bodySize > MAX_BODY_SIZE) {
        log4("Rejected request: body too large");
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify(denyResponse("Request too large")));
        return;
      }
      body += chunk;
    }
    let toolRequest;
    try {
      toolRequest = JSON.parse(body);
    } catch {
      log4("Rejected request: invalid JSON");
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(denyResponse("Invalid JSON")));
      return;
    }
    if (!toolRequest.tool_name || !toolRequest.session_id || !toolRequest.hook_event_name) {
      log4("Rejected request: missing required fields");
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(denyResponse("Missing required fields")));
      return;
    }
    if (toolRequest.hook_event_name !== "PreToolUse") {
      log4(`Rejected request: unexpected hook event ${toolRequest.hook_event_name}`);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(denyResponse("Unexpected hook event")));
      return;
    }
    if (DEBUG2) {
      log4(`Hook request: tool=${toolRequest.tool_name} id=${toolRequest.tool_use_id} session=${toolRequest.session_id} tab=${registration.tabId.substring(0, 8)}\u2026`);
    } else {
      log4(`Hook: ${toolRequest.tool_name} \u2192 tab=${registration.tabId.substring(0, 8)}\u2026`);
    }
    const sessionId = toolRequest.session_id;
    const toolName = toolRequest.tool_name;
    if (this.scopedAllows.has(`session:${sessionId}:tool:${toolName}`)) {
      if (DEBUG2) log4(`Auto-allowing ${toolName} (session-allowed)`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(allowResponse("Allowed for session by user")));
      return;
    }
    if (toolName === "WebFetch") {
      const domain = extractDomain(toolRequest.tool_input?.url);
      if (domain && this.scopedAllows.has(`session:${sessionId}:webfetch:${domain}`)) {
        if (DEBUG2) log4(`Auto-allowing WebFetch to ${domain} (domain-allowed)`);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(allowResponse(`Domain ${domain} allowed by user`)));
        return;
      }
    }
    if (toolName === "Bash" && isSafeBashCommand(toolRequest.tool_input?.command)) {
      if (DEBUG2) log4(`Auto-allowing safe Bash: ${String(toolRequest.tool_input?.command).substring(0, 80)}`);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(allowResponse("Safe read-only command")));
      return;
    }
    const questionId = `hook-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    const decision = await new Promise((resolve2) => {
      const timeout = setTimeout(() => {
        log4(`Permission timeout [${questionId}] \u2014 auto-denying`);
        this.pendingRequests.delete(questionId);
        resolve2({ decision: "deny", reason: "Permission timed out after 5 minutes" });
      }, PERMISSION_TIMEOUT_MS2);
      this.pendingRequests.set(questionId, {
        toolRequest,
        resolve: resolve2,
        timeout,
        questionId,
        runToken: urlToken
      });
      const options = this.getOptionsForTool(toolName, toolRequest.tool_input);
      this.emit("permission-request", questionId, toolRequest, registration.tabId, options);
    });
    const hookResponse = decision.decision === "allow" ? allowResponse(decision.reason || "Approved by user") : denyResponse(decision.reason || "Denied by user");
    if (DEBUG2) {
      log4(`Hook response [${questionId}]: ${decision.decision}`);
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(hookResponse));
  }
};
function maskSensitiveFields(input) {
  const masked = {};
  for (const [key, value] of Object.entries(input)) {
    if (SENSITIVE_FIELD_RE.test(key)) {
      masked[key] = "***";
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      masked[key] = maskSensitiveFields(value);
    } else if (Array.isArray(value)) {
      masked[key] = value.map(
        (item) => item !== null && typeof item === "object" && !Array.isArray(item) ? maskSensitiveFields(item) : item
      );
    } else {
      masked[key] = value;
    }
  }
  return masked;
}

// ../OpenClaw-UI-saucer/src/main/claude/control-plane.ts
var MAX_QUEUE_DEPTH = 32;
function log5(msg) {
  log("ControlPlane", msg);
}
var ControlPlane = class extends EventEmitter5 {
  tabs = /* @__PURE__ */ new Map();
  inflightRequests = /* @__PURE__ */ new Map();
  requestQueue = [];
  runManager;
  ptyRunManager;
  /** Feature flag: use PTY transport for interactive permissions */
  interactivePty;
  /** Tracks which runs are using PTY transport (by requestId) */
  ptyRuns = /* @__PURE__ */ new Set();
  /** Tracks requestIds that are warmup init requests (invisible to renderer) */
  initRequestIds = /* @__PURE__ */ new Set();
  /** Permission hook server for PreToolUse HTTP hooks */
  permissionServer;
  /** Per-run tokens: requestId → runToken (for cleanup on exit/error) */
  runTokens = /* @__PURE__ */ new Map();
  /** Global permission mode: 'ask' shows cards, 'auto' auto-approves */
  permissionMode = "ask";
  /** Which agent runtime new runs target. 'auto' defers to the CLI's own config. */
  connectionTarget = { mode: "auto" };
  /** Resolves when the permission server is ready (or failed). Dispatch awaits this. */
  hookServerReady;
  constructor(interactivePty = false) {
    super();
    const isOpenclawCli = getCliRuntime().kind === "openclaw";
    this.interactivePty = isOpenclawCli ? true : interactivePty;
    this.runManager = new RunManager();
    this.ptyRunManager = new PtyRunManager();
    this.permissionServer = new PermissionServer();
    this.hookServerReady = this.permissionServer.start().then((port) => {
      log5(`Permission hook server ready on port ${port}`);
    }).catch((err) => {
      log5(`Failed to start permission hook server: ${err.message}`);
    });
    this.permissionServer.on("permission-request", (questionId, toolRequest, tabId, options) => {
      if (!this.tabs.has(tabId)) {
        log5(`Permission request for closed tab ${tabId.substring(0, 8)}\u2026 \u2014 auto-denying`);
        this.permissionServer.respondToPermission(questionId, "deny", "Tab closed");
        return;
      }
      log5(`Permission request [${questionId}]: tool=${toolRequest.tool_name} tab=${tabId.substring(0, 8)}\u2026 mode=${this.permissionMode}`);
      if (this.permissionMode === "auto") {
        this.permissionServer.respondToPermission(questionId, "allow", "Auto mode");
        return;
      }
      const safeInput = toolRequest.tool_input ? maskSensitiveFields(toolRequest.tool_input) : void 0;
      const permEvent = {
        type: "permission_request",
        questionId,
        toolName: toolRequest.tool_name,
        toolDescription: void 0,
        toolInput: safeInput,
        options
      };
      this.emit("event", tabId, permEvent);
    });
    log5(`Interactive PTY transport: ${this.interactivePty ? "ENABLED" : "disabled"}`);
    this._wirePtyEvents();
    this.runManager.on("normalized", (requestId, event) => {
      const tabId = this._findTabByRequest(requestId);
      if (!tabId) return;
      const tab = this.tabs.get(tabId);
      if (!tab) return;
      tab.lastActivityAt = Date.now();
      if (event.type === "session_init") {
        tab.claudeSessionId = event.sessionId;
        if (this.initRequestIds.has(requestId)) {
          this.emit("event", tabId, { ...event, isWarmup: true });
          return;
        }
        if (tab.status === "connecting") {
          this._setTabStatus(tabId, "running");
        }
      }
      if (this.initRequestIds.has(requestId)) {
        return;
      }
      this.emit("event", tabId, event);
    });
    this.runManager.on("exit", (requestId, code, signal, sessionId) => {
      const runToken = this.runTokens.get(requestId);
      if (runToken) {
        this.permissionServer.unregisterRun(runToken);
        this.runTokens.delete(requestId);
      }
      const tabId = this._findTabByRequest(requestId);
      const inflight = this.inflightRequests.get(requestId);
      if (!tabId || !this.tabs.get(tabId)) {
        if (inflight) {
          inflight.resolve();
          this.inflightRequests.delete(requestId);
        }
        return;
      }
      const tab = this.tabs.get(tabId);
      tab.activeRequestId = null;
      tab.runPid = null;
      if (sessionId) tab.claudeSessionId = sessionId;
      if (this.initRequestIds.has(requestId)) {
        this.initRequestIds.delete(requestId);
        this._setTabStatus(tabId, "idle");
        if (inflight) {
          inflight.resolve();
          this.inflightRequests.delete(requestId);
        }
        this._processQueue(tabId);
        return;
      }
      if (code === 0) {
        this._setTabStatus(tabId, "completed");
      } else if (signal === "SIGINT" || signal === "SIGKILL") {
        this._setTabStatus(tabId, "failed");
      } else {
        const enriched = this.runManager.getEnrichedError(requestId, code);
        this.emit("error", tabId, enriched);
        this._setTabStatus(tabId, code === null ? "dead" : "failed");
      }
      if (inflight) {
        inflight.resolve();
        this.inflightRequests.delete(requestId);
      }
      this._processQueue(tabId);
    });
    this.runManager.on("error", (requestId, err) => {
      const runToken = this.runTokens.get(requestId);
      if (runToken) {
        this.permissionServer.unregisterRun(runToken);
        this.runTokens.delete(requestId);
      }
      const tabId = this._findTabByRequest(requestId);
      const inflight = this.inflightRequests.get(requestId);
      if (!tabId || !this.tabs.get(tabId)) {
        if (inflight) {
          inflight.reject(err);
          this.inflightRequests.delete(requestId);
        }
        return;
      }
      const tab = this.tabs.get(tabId);
      tab.activeRequestId = null;
      tab.runPid = null;
      if (this.initRequestIds.has(requestId)) {
        this.initRequestIds.delete(requestId);
        log5(`Init session error for tab ${tabId}: ${err.message}`);
        this._setTabStatus(tabId, "idle");
        if (inflight) {
          inflight.reject(err);
          this.inflightRequests.delete(requestId);
        }
        this._processQueue(tabId);
        return;
      }
      this._setTabStatus(tabId, "dead");
      const enriched = this.runManager.getEnrichedError(requestId, null);
      enriched.message = err.message;
      this.emit("error", tabId, enriched);
      if (inflight) {
        inflight.reject(err);
        this.inflightRequests.delete(requestId);
      }
    });
  }
  /**
   * Wire PtyRunManager events using the same routing logic as RunManager.
   */
  _wirePtyEvents() {
    this.ptyRunManager.on("normalized", (requestId, event) => {
      const tabId = this._findTabByRequest(requestId);
      if (!tabId) return;
      const tab = this.tabs.get(tabId);
      if (!tab) return;
      tab.lastActivityAt = Date.now();
      if (event.type === "session_init") {
        tab.claudeSessionId = event.sessionId;
        if (this.initRequestIds.has(requestId)) {
          this.emit("event", tabId, { ...event, isWarmup: true });
          return;
        }
        if (tab.status === "connecting") {
          this._setTabStatus(tabId, "running");
        }
      }
      if (this.initRequestIds.has(requestId)) return;
      this.emit("event", tabId, event);
    });
    this.ptyRunManager.on("exit", (requestId, code, signal, sessionId) => {
      const runToken = this.runTokens.get(requestId);
      if (runToken) {
        this.permissionServer.unregisterRun(runToken);
        this.runTokens.delete(requestId);
      }
      const tabId = this._findTabByRequest(requestId);
      const inflight = this.inflightRequests.get(requestId);
      this.ptyRuns.delete(requestId);
      if (!tabId || !this.tabs.get(tabId)) {
        if (inflight) {
          inflight.resolve();
          this.inflightRequests.delete(requestId);
        }
        return;
      }
      const tab = this.tabs.get(tabId);
      tab.activeRequestId = null;
      tab.runPid = null;
      if (sessionId) tab.claudeSessionId = sessionId;
      if (this.initRequestIds.has(requestId)) {
        this.initRequestIds.delete(requestId);
        this._setTabStatus(tabId, "idle");
        if (inflight) {
          inflight.resolve();
          this.inflightRequests.delete(requestId);
        }
        this._processQueue(tabId);
        return;
      }
      const handle = this.ptyRunManager.getHandle(requestId);
      const openclawCompleted = !!(handle?.openclawTuiMode && handle.terminalOutcome === "complete");
      const openclawFailed = !!(handle?.openclawTuiMode && handle.terminalOutcome === "error");
      if (openclawFailed) {
        this._setTabStatus(tabId, "failed");
      } else if (code === 0 || openclawCompleted) {
        this._setTabStatus(tabId, "completed");
      } else if (signal) {
        this._setTabStatus(tabId, "failed");
      } else {
        const enriched = this.ptyRunManager.getEnrichedError(requestId, code);
        this.emit("error", tabId, enriched);
        this._setTabStatus(tabId, code === null ? "dead" : "failed");
      }
      if (inflight) {
        inflight.resolve();
        this.inflightRequests.delete(requestId);
      }
      this._processQueue(tabId);
    });
    this.ptyRunManager.on("error", (requestId, err) => {
      const runToken = this.runTokens.get(requestId);
      if (runToken) {
        this.permissionServer.unregisterRun(runToken);
        this.runTokens.delete(requestId);
      }
      const tabId = this._findTabByRequest(requestId);
      const inflight = this.inflightRequests.get(requestId);
      this.ptyRuns.delete(requestId);
      if (!tabId || !this.tabs.get(tabId)) {
        if (inflight) {
          inflight.reject(err);
          this.inflightRequests.delete(requestId);
        }
        return;
      }
      const tab = this.tabs.get(tabId);
      tab.activeRequestId = null;
      tab.runPid = null;
      if (this.initRequestIds.has(requestId)) {
        this.initRequestIds.delete(requestId);
        log5(`PTY init session error for tab ${tabId}: ${err.message}`);
        this._setTabStatus(tabId, "idle");
        if (inflight) {
          inflight.reject(err);
          this.inflightRequests.delete(requestId);
        }
        this._processQueue(tabId);
        return;
      }
      this._setTabStatus(tabId, "dead");
      const enriched = this.ptyRunManager.getEnrichedError(requestId, null);
      enriched.message = err.message;
      this.emit("error", tabId, enriched);
      if (inflight) {
        inflight.reject(err);
        this.inflightRequests.delete(requestId);
      }
    });
  }
  // ─── Tab Lifecycle ───
  createTab() {
    const tabId = crypto.randomUUID();
    const entry = {
      tabId,
      claudeSessionId: null,
      status: "idle",
      activeRequestId: null,
      runPid: null,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      promptCount: 0
    };
    this.tabs.set(tabId, entry);
    log5(`Tab created: ${tabId}`);
    return tabId;
  }
  /**
   * Eagerly initialize a session for a tab by running a minimal prompt.
   * Populates session metadata (model, MCP servers, tools) without visible messages.
   */
  initSession(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    const requestId = `init-${tabId}`;
    this.initRequestIds.add(requestId);
    this.submitPrompt(tabId, requestId, {
      prompt: "hi",
      projectPath: process.cwd(),
      maxTurns: 1
    }).catch((err) => {
      this.initRequestIds.delete(requestId);
      log5(`Init session failed for tab ${tabId}: ${err.message}`);
    });
  }
  /**
   * Clear stored session ID for a tab — used when working directory changes
   * so _dispatch won't inject a stale --resume from the old directory.
   */
  resetTabSession(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    log5(`Resetting session for tab ${tabId} (was: ${tab.claudeSessionId})`);
    tab.claudeSessionId = null;
  }
  /**
   * Set global permission mode.
   * 'ask' = show permission cards, 'auto' = auto-approve all tool calls.
   */
  setPermissionMode(mode) {
    log5(`Permission mode set to: ${mode}`);
    this.permissionMode = mode;
  }
  /**
   * Set which agent runtime subsequent runs target.
   * Credentials are held in the main process only and never echoed back.
   */
  setConnectionTarget(target) {
    this.connectionTarget = target;
    log5(`Connection target set to: mode=${target.mode} url=${target.url || "(config)"} auth=${target.token ? "token" : target.password ? "password" : "none"}`);
  }
  /** Returns the target with any credential stripped — safe to send to the renderer. */
  getConnectionTarget() {
    const { mode, url } = this.connectionTarget;
    return { mode, url };
  }
  closeTab(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    if (tab.activeRequestId) {
      this.cancel(tab.activeRequestId);
      const inflight = this.inflightRequests.get(tab.activeRequestId);
      if (inflight) {
        inflight.reject(new Error("Tab closed"));
        this.inflightRequests.delete(tab.activeRequestId);
      }
    }
    this.requestQueue = this.requestQueue.filter((r) => {
      if (r.tabId === tabId) {
        const reason = new Error("Tab closed");
        r.reject(reason);
        for (const w of r.extraWaiters) w.reject(reason);
        return false;
      }
      return true;
    });
    this.tabs.delete(tabId);
    log5(`Tab closed: ${tabId}`);
  }
  // ─── Submit Prompt ───
  /**
   * Submit a prompt to a specific tab. Returns a promise that resolves
   * when the run completes.
   *
   * Guards:
   *  - Rejects without targetSession (tabId)
   *  - Returns existing promise for duplicate requestId (idempotency)
   *  - Queues if tab is busy, rejects if queue is full
   */
  async submitPrompt(tabId, requestId, options) {
    if (!tabId) {
      throw new Error("No targetSession (tabId) provided \u2014 rejecting to prevent misrouting");
    }
    const tab = this.tabs.get(tabId);
    if (!tab) {
      throw new Error(`Tab ${tabId} does not exist`);
    }
    const existing = this.inflightRequests.get(requestId);
    if (existing) {
      log5(`Duplicate requestId ${requestId} \u2014 returning existing inflight promise`);
      return existing.promise;
    }
    const queued = this.requestQueue.find((r) => r.requestId === requestId);
    if (queued) {
      log5(`Duplicate requestId ${requestId} \u2014 already queued, adding waiter`);
      return new Promise((resolve2, reject) => {
        queued.extraWaiters.push({ resolve: resolve2, reject });
      });
    }
    if (tab.activeRequestId) {
      if (this.requestQueue.length >= MAX_QUEUE_DEPTH) {
        throw new Error("Request queue full \u2014 back-pressure");
      }
      log5(`Tab ${tabId} busy \u2014 queuing request ${requestId} (queue depth: ${this.requestQueue.length + 1})`);
      return new Promise((resolve2, reject) => {
        this.requestQueue.push({
          requestId,
          tabId,
          options,
          resolve: resolve2,
          reject,
          enqueuedAt: Date.now(),
          extraWaiters: []
        });
      });
    }
    return this._dispatch(tabId, requestId, options);
  }
  async _dispatch(tabId, requestId, options) {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`Tab ${tabId} disappeared`);
    await this.hookServerReady;
    if (!options.sessionId && tab.claudeSessionId) {
      options = { ...options, sessionId: tab.claudeSessionId };
    }
    if (!options.sessionId && getCliRuntime().kind === "openclaw") {
      options = { ...options, sessionId: `clui-${tabId}` };
    }
    if (!options.connection) {
      options = { ...options, connection: this.connectionTarget };
    }
    if (this.permissionServer.getPort()) {
      const runToken = this.permissionServer.registerRun(tabId, requestId, options.sessionId || null);
      this.runTokens.set(requestId, runToken);
      const hookSettingsPath = this.permissionServer.generateSettingsFile(runToken);
      options = { ...options, hookSettingsPath };
    }
    tab.activeRequestId = requestId;
    if (!this.initRequestIds.has(requestId)) tab.promptCount++;
    tab.lastActivityAt = Date.now();
    const newStatus = tab.claudeSessionId ? "running" : "connecting";
    this._setTabStatus(tabId, newStatus);
    const usePty = this.interactivePty;
    let pid = null;
    try {
      if (usePty) {
        log5(`Dispatching via PTY transport: ${requestId}`);
        const handle = this.ptyRunManager.startRun(requestId, options);
        this.ptyRuns.add(requestId);
        pid = handle.pid;
      } else {
        const handle = this.runManager.startRun(requestId, options);
        pid = handle.pid;
      }
      tab.runPid = pid;
    } catch (err) {
      tab.activeRequestId = null;
      tab.runPid = null;
      this._setTabStatus(tabId, "failed");
      throw err;
    }
    let resolve2;
    let reject;
    const promise = new Promise((res, rej) => {
      resolve2 = res;
      reject = rej;
    });
    this.inflightRequests.set(requestId, { requestId, tabId, promise, resolve: resolve2, reject });
    return promise;
  }
  // ─── Cancel ───
  cancel(requestId) {
    const queueIdx = this.requestQueue.findIndex((r) => r.requestId === requestId);
    if (queueIdx !== -1) {
      const req = this.requestQueue.splice(queueIdx, 1)[0];
      const reason = new Error("Request cancelled");
      req.reject(reason);
      for (const w of req.extraWaiters) w.reject(reason);
      log5(`Cancelled queued request ${requestId}`);
      return true;
    }
    if (this.ptyRuns.has(requestId)) {
      return this.ptyRunManager.cancel(requestId);
    }
    return this.runManager.cancel(requestId);
  }
  /**
   * Cancel active run on a tab (by tabId instead of requestId).
   */
  cancelTab(tabId) {
    const tab = this.tabs.get(tabId);
    if (!tab?.activeRequestId) return false;
    return this.cancel(tab.activeRequestId);
  }
  // ─── Retry ───
  /**
   * Retry: re-submit the same prompt on the same tab/session.
   * If the tab is dead, creates a fresh session.
   */
  async retry(tabId, requestId, options) {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new Error(`Tab ${tabId} does not exist`);
    if (tab.status === "dead") {
      tab.claudeSessionId = null;
      this._setTabStatus(tabId, "idle");
    }
    return this.submitPrompt(tabId, requestId, options);
  }
  // ─── Permission Response ───
  respondToPermission(tabId, questionId, optionId) {
    if (questionId.startsWith("hook-")) {
      return this.permissionServer.respondToPermission(questionId, optionId);
    }
    const tab = this.tabs.get(tabId);
    if (!tab?.activeRequestId) return false;
    if (this.ptyRuns.has(tab.activeRequestId)) {
      return this.ptyRunManager.respondToPermission(tab.activeRequestId, questionId, optionId);
    }
    const msg = {
      type: "permission_response",
      question_id: questionId,
      option_id: optionId
    };
    return this.runManager.writeToStdin(tab.activeRequestId, msg);
  }
  // ─── Health ───
  getHealth() {
    const tabEntries = [];
    for (const [tabId, tab] of this.tabs) {
      let alive = false;
      if (tab.activeRequestId) {
        alive = this.runManager.isRunning(tab.activeRequestId) || this.ptyRunManager.isRunning(tab.activeRequestId);
      }
      tabEntries.push({
        tabId,
        status: tab.status,
        activeRequestId: tab.activeRequestId,
        claudeSessionId: tab.claudeSessionId,
        alive
      });
    }
    return {
      tabs: tabEntries,
      queueDepth: this.requestQueue.length
    };
  }
  getTabStatus(tabId) {
    return this.tabs.get(tabId);
  }
  getEnrichedError(requestId, exitCode) {
    if (this.ptyRuns.has(requestId)) {
      return this.ptyRunManager.getEnrichedError(requestId, exitCode);
    }
    return this.runManager.getEnrichedError(requestId, exitCode);
  }
  // ─── Queue Processing ───
  _processQueue(tabId) {
    const idx = this.requestQueue.findIndex((r) => r.tabId === tabId);
    if (idx === -1) return;
    const req = this.requestQueue.splice(idx, 1)[0];
    log5(`Processing queued request ${req.requestId} for tab ${tabId}`);
    this._dispatch(tabId, req.requestId, req.options).then((v) => {
      req.resolve(v);
      for (const w of req.extraWaiters) w.resolve(v);
    }).catch((e) => {
      req.reject(e);
      for (const w of req.extraWaiters) w.reject(e);
    });
  }
  // ─── Internal ───
  _findTabByRequest(requestId) {
    const inflight = this.inflightRequests.get(requestId);
    if (inflight) return inflight.tabId;
    for (const [tabId, tab] of this.tabs) {
      if (tab.activeRequestId === requestId) return tabId;
    }
    return null;
  }
  _setTabStatus(tabId, newStatus) {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    const oldStatus = tab.status;
    if (oldStatus === newStatus) return;
    tab.status = newStatus;
    log5(`Tab ${tabId}: ${oldStatus} \u2192 ${newStatus}`);
    this.emit("tab-status-change", tabId, newStatus, oldStatus);
  }
  // ─── Shutdown ───
  shutdown() {
    log5("Shutting down control plane");
    this.permissionServer.stop();
    for (const [tabId] of this.tabs) {
      this.closeTab(tabId);
    }
  }
};

// ../OpenClaw-UI-saucer/src/main/marketplace/catalog.ts
import { execFile } from "child_process";
import { readFile, readdir, mkdir, writeFile, rm } from "fs/promises";
import { join as join7, resolve } from "path";
var SAFE_PLUGIN_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
var SAFE_REPO = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+$/;
function validatePluginName(name) {
  return SAFE_PLUGIN_NAME.test(name) && !name.includes("..");
}
function validateRepo(repo) {
  return SAFE_REPO.test(repo);
}
function validateSourcePath(p) {
  if (!p || /[\0\\]/.test(p) || p.startsWith("/") || p.includes("..")) return false;
  return true;
}
function assertSkillDirContained(skillsDir, base) {
  const resolved = resolve(skillsDir);
  if (!resolved.startsWith(base + "/") && resolved !== base) {
    throw new Error(`Path escapes skills directory: ${resolved}`);
  }
}
function log6(msg) {
  log("marketplace", msg);
}
var SOURCES = [
  { repo: "anthropics/skills", category: "Agent Skills" },
  { repo: "anthropics/knowledge-work-plugins", category: "Knowledge Work" },
  { repo: "anthropics/financial-services-plugins", category: "Financial Services" }
];
var AWESOME_REPO = "VoltAgent/awesome-openclaw-skills";
var AWESOME_RAW_BASE = `https://raw.githubusercontent.com/${AWESOME_REPO}/main`;
var AWESOME_README_URL = `${AWESOME_RAW_BASE}/README.md`;
var AWESOME_LIST_LIMIT = 1400;
var cachedPlugins = null;
var cacheTimestamp = 0;
var CACHE_TTL = 5 * 60 * 1e3;
var skillContentCache = /* @__PURE__ */ new Map();
async function fetchCatalog(forceRefresh) {
  if (!forceRefresh && cachedPlugins && Date.now() - cacheTimestamp < CACHE_TTL) {
    return { plugins: cachedPlugins, error: null };
  }
  const allPlugins = [];
  const errors = [];
  const results = await Promise.allSettled(
    SOURCES.map(async (source) => {
      const marketplaceUrl = `https://raw.githubusercontent.com/${source.repo}/main/.claude-plugin/marketplace.json`;
      log6(`Fetching marketplace: ${marketplaceUrl}`);
      const marketplaceRes = await netFetch(marketplaceUrl);
      if (!marketplaceRes.ok) {
        throw new Error(`Failed to fetch marketplace for ${source.repo}: ${marketplaceRes.status}`);
      }
      const marketplaceData = JSON.parse(marketplaceRes.body);
      const safeMarketplaceName = typeof marketplaceData.name === "string" && marketplaceData.name.trim().length > 0 ? marketplaceData.name.trim() : source.repo;
      const jobs = [];
      for (const entry of marketplaceData.plugins) {
        let entryAuthor = "";
        if (entry.author) {
          entryAuthor = typeof entry.author === "string" ? entry.author : entry.author.name || "";
        }
        if (entry.skills && entry.skills.length > 0) {
          for (const skillRef of entry.skills) {
            const skillPath = skillRef.replace(/^\.\//, "").replace(/\/$/, "");
            const individualName = skillPath.split("/").pop() || entry.name;
            jobs.push({
              installName: individualName,
              skillPath,
              entryDescription: entry.description || "",
              entryAuthor,
              useSkillMd: true
            });
          }
        } else {
          const normalizedSource = entry.source.replace(/^\.\//, "").replace(/\/$/, "");
          jobs.push({
            installName: entry.name,
            skillPath: normalizedSource || entry.name,
            entryDescription: entry.description || "",
            entryAuthor,
            useSkillMd: false
          });
        }
      }
      const jobResults = await Promise.allSettled(
        jobs.map(async (job) => {
          let name = "";
          let description = "";
          let version = "0.0.0";
          let author = job.entryAuthor || "Anthropic";
          if (job.useSkillMd) {
            const skillUrl = `https://raw.githubusercontent.com/${source.repo}/main/${job.skillPath}/SKILL.md`;
            try {
              const res = await netFetch(skillUrl);
              if (res.ok) {
                const parsed = parseSkillFrontmatter(res.body);
                name = parsed.name;
                description = parsed.description;
                skillContentCache.set(job.installName, res.body);
              }
            } catch (e) {
              log6(`SKILL.md fetch failed for ${job.skillPath}`);
            }
          } else {
            const pluginUrl = `https://raw.githubusercontent.com/${source.repo}/main/${job.skillPath}/.claude-plugin/plugin.json`;
            try {
              const res = await netFetch(pluginUrl);
              if (res.ok) {
                const data = JSON.parse(res.body);
                name = data.name?.trim() || "";
                description = data.description || "";
                version = data.version?.trim() || "0.0.0";
                author = data.author?.trim() || author;
              }
            } catch (e) {
              log6(`plugin.json fetch failed for ${job.skillPath}`);
            }
          }
          const dirName = job.skillPath.split("/").pop() || job.installName;
          if (!name) name = dirName;
          if (!description) description = job.entryDescription;
          const plugin = {
            id: `${source.repo}/${job.skillPath}`,
            name,
            description,
            version,
            author,
            marketplace: safeMarketplaceName,
            repo: source.repo,
            sourcePath: job.skillPath,
            installName: job.installName,
            category: source.category,
            tags: deriveSemanticTags(name, description, job.skillPath),
            isSkillMd: job.useSkillMd,
            installMode: "native"
          };
          return plugin;
        })
      );
      for (const r of jobResults) {
        if (r.status === "fulfilled") {
          allPlugins.push(r.value);
        } else {
          log6(`Plugin fetch warning: ${r.reason}`);
        }
      }
    })
  );
  try {
    const awesomePlugins = await fetchAwesomeOpenclawSkills();
    allPlugins.push(...awesomePlugins);
  } catch (err) {
    const msg = `Awesome source fetch error: ${String(err)}`;
    log6(msg);
    errors.push(msg);
  }
  for (const r of results) {
    if (r.status === "rejected") {
      log6(`Source fetch error: ${r.reason}`);
      errors.push(String(r.reason));
    }
  }
  if (allPlugins.length === 0 && errors.length > 0) {
    return { plugins: [], error: errors.join("; ") };
  }
  allPlugins.sort((a, b) => a.name.localeCompare(b.name));
  cachedPlugins = allPlugins;
  cacheTimestamp = Date.now();
  return { plugins: allPlugins, error: null };
}
async function listInstalled() {
  const cliHomeDir = getPrimaryAgentHome();
  const names = [];
  try {
    const raw = await readFile(join7(cliHomeDir, "plugins", "installed_plugins.json"), "utf-8");
    const data = JSON.parse(raw);
    if (data.plugins) {
      for (const key of Object.keys(data.plugins)) {
        const pluginName = key.split("@")[0];
        if (pluginName) names.push(pluginName);
        names.push(key);
      }
    }
  } catch (e) {
    log6(`listInstalled: no installed_plugins.json or parse error: ${e}`);
  }
  try {
    const entries = await readdir(join7(cliHomeDir, "skills"), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        names.push(entry.name);
      }
    }
  } catch (e) {
    log6(`listInstalled: no skills dir or read error: ${e}`);
  }
  return [...new Set(names)];
}
async function installPlugin(repo, pluginName, marketplace, sourcePath, isSkillMd) {
  try {
    if (!validatePluginName(pluginName)) {
      return { ok: false, error: `Invalid plugin name: ${pluginName}` };
    }
    if (!validateRepo(repo)) {
      return { ok: false, error: `Invalid repo format: ${repo}` };
    }
    if (sourcePath && !validateSourcePath(sourcePath)) {
      return { ok: false, error: `Invalid source path: ${sourcePath}` };
    }
    if (repo === AWESOME_REPO || marketplace === "Awesome OpenClaw Skills") {
      return { ok: false, error: "This skill is installed via ClawHub. Run: clawhub install <skill-slug>" };
    }
    if (isSkillMd !== false) {
      const skillsBase = join7(getPrimaryAgentHome(), "skills");
      const skillsDir = join7(skillsBase, pluginName);
      assertSkillDirContained(skillsDir, skillsBase);
      let content = skillContentCache.get(pluginName);
      if (!content) {
        const path = sourcePath || `skills/${pluginName}`;
        const url = `https://raw.githubusercontent.com/${repo}/main/${path}/SKILL.md`;
        log6(`installPlugin: fetching ${url}`);
        const res = await netFetch(url);
        if (!res.ok) {
          return { ok: false, error: `Failed to fetch SKILL.md (${res.status})` };
        }
        content = res.body;
      }
      await mkdir(skillsDir, { recursive: true });
      await writeFile(join7(skillsDir, "SKILL.md"), content, "utf-8");
      log6(`installPlugin: wrote ${skillsDir}/SKILL.md`);
    } else {
      const cliBin = findCliBinary();
      const addResult = await execAsync(cliBin, ["plugin", "marketplace", "add", repo], 15e3);
      if (addResult.exitCode !== 0 && !addResult.stdout.includes("already added") && !addResult.stderr.includes("already added")) {
        return { ok: false, error: addResult.stderr || "Failed to add marketplace" };
      }
      const marketplaceSlug = repo.split("/").pop() || marketplace;
      let installResult = await execAsync(cliBin, ["plugin", "install", `${pluginName}@${marketplaceSlug}`], 15e3);
      if (installResult.exitCode !== 0 && marketplaceSlug !== marketplace) {
        installResult = await execAsync(cliBin, ["plugin", "install", `${pluginName}@${marketplace}`], 15e3);
      }
      if (installResult.exitCode !== 0) {
        return { ok: false, error: installResult.stderr || installResult.stdout || "Failed to install plugin" };
      }
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log6(`installPlugin error: ${msg}`);
    return { ok: false, error: msg };
  }
}
async function uninstallPlugin(pluginName) {
  try {
    if (!validatePluginName(pluginName)) {
      return { ok: false, error: `Invalid plugin name: ${pluginName}` };
    }
    const skillsBase = join7(getPrimaryAgentHome(), "skills");
    const skillsDir = join7(skillsBase, pluginName);
    assertSkillDirContained(skillsDir, skillsBase);
    await rm(skillsDir, { recursive: true, force: true });
    log6(`uninstallPlugin: removed ${skillsDir}`);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log6(`uninstallPlugin error: ${msg}`);
    return { ok: false, error: msg };
  }
}
async function netFetch(url) {
  const response = await fetch(url);
  return { ok: response.ok, status: response.status, body: await response.text() };
}
async function fetchAwesomeOpenclawSkills() {
  const readmeRes = await netFetch(AWESOME_README_URL);
  if (!readmeRes.ok) {
    throw new Error(`Failed to fetch ${AWESOME_REPO} README (${readmeRes.status})`);
  }
  const categoryPaths = parseAwesomeCategoryPaths(readmeRes.body);
  const categoryDocs = await Promise.allSettled(
    categoryPaths.map(async (path) => {
      const url = `${AWESOME_RAW_BASE}/${path}`;
      const res = await netFetch(url);
      if (!res.ok) throw new Error(`Failed to fetch ${url} (${res.status})`);
      return { path, body: res.body };
    })
  );
  const plugins = [];
  for (const doc of categoryDocs) {
    if (doc.status !== "fulfilled") {
      log6(`Awesome category fetch warning: ${doc.reason}`);
      continue;
    }
    const parsed = parseAwesomeCategory(doc.value.path, doc.value.body);
    for (const p of parsed) {
      plugins.push(p);
      if (plugins.length >= AWESOME_LIST_LIMIT) return plugins;
    }
  }
  return plugins;
}
function parseAwesomeCategoryPaths(readme) {
  const matches = [...readme.matchAll(/\(categories\/([a-z0-9-]+\.md)\)/gi)];
  const dedup = /* @__PURE__ */ new Set();
  for (const m of matches) dedup.add(`categories/${m[1]}`);
  return [...dedup];
}
function parseAwesomeCategory(path, body) {
  const lines = body.split("\n");
  const heading = lines.find((l) => l.startsWith("# "))?.replace(/^#\s+/, "").trim() || "Community";
  const results = [];
  for (const line of lines) {
    const m = line.match(/^- \[([^\]]+)\]\((https:\/\/clawskills\.sh\/skills\/([^)\/\s]+))\)\s*-\s*(.+)$/i);
    if (!m) continue;
    const name = m[1].trim();
    const externalUrl = m[2].trim();
    const slug = m[3].trim().toLowerCase();
    const description = m[4].trim();
    const author = slug.includes("-") ? slug.split("-")[0] : "community";
    const id = `${AWESOME_REPO}/${slug}`;
    const tags = Array.from(/* @__PURE__ */ new Set(["Community", ...deriveSemanticTags(name, description, `${path}#${slug}`)]));
    results.push({
      id,
      name,
      description,
      version: "community",
      author,
      marketplace: "Awesome OpenClaw Skills",
      repo: AWESOME_REPO,
      sourcePath: `${path}#${slug}`,
      installName: slug,
      category: heading,
      tags,
      isSkillMd: false,
      installMode: "clawhub",
      installCommand: `clawhub install ${slug}`,
      externalUrl
    });
  }
  return results;
}
function parseSkillFrontmatter(content) {
  let name = "";
  let description = "";
  const lines = content.split("\n");
  for (const line of lines) {
    const nameMatch = line.match(/^name:\s*(.+)/);
    if (nameMatch && !name) {
      name = nameMatch[1].replace(/^["']|["']$/g, "").trim();
    }
    const descMatch = line.match(/^description:\s*(.+)/);
    if (descMatch && !description) {
      description = descMatch[1].replace(/^["']|["']$/g, "").trim();
      if (description.length > 200) {
        description = description.substring(0, 197) + "...";
      }
    }
    if (name && description) break;
    if (line.startsWith("# ")) break;
  }
  return { name, description };
}
var TAG_RULES = [
  { tag: "Design", patterns: /\b(figma|ui|ux|design|sketch|prototype|wireframe|layout|css|style|visual)\b/i },
  { tag: "Product", patterns: /\b(prd|roadmap|strategy|product|backlog|prioriti[sz]|feature\s*request|user\s*stor)\b/i },
  { tag: "Research", patterns: /\b(research|interview|insights?|survey|user\s*study|ethnograph|discover)\b/i },
  { tag: "Docs", patterns: /\b(doc(ument)?s?|writing|spec(ification)?|readme|markdown|technical\s*writ|content)\b/i },
  { tag: "Spreadsheet", patterns: /\b(sheet|spreadsheet|xlsx?|csv|tabular|pivot|formula)\b/i },
  { tag: "Slides", patterns: /\b(slides?|presentation|deck|pptx?|keynote|pitch)\b/i },
  { tag: "Analysis", patterns: /\b(analy[sz](is|e|ing)|insight|metric|dashboard|report(ing)?|data\s*viz|statistic)\b/i },
  { tag: "Finance", patterns: /\b(financ|accounting|budget|revenue|forecast|valuation|portfolio|investment)\b/i },
  { tag: "Compliance", patterns: /\b(risk|audit|policy|compliance|regulat|governance|sox|gdpr|hipaa)\b/i },
  { tag: "Management", patterns: /\b(manag|planning|meeting|ops|operations|team|workflow|project\s*plan)\b/i },
  { tag: "Automation", patterns: /\b(automat|workflow|pipeline|ci\s*cd|deploy|integrat|orchestrat|script)\b/i },
  { tag: "Code", patterns: /\b(code|coding|program|develop|engineer|debug|refactor|test(ing)?|linter?)\b/i },
  { tag: "Creative", patterns: /\b(creative|brainstorm|ideation|copywriting|storytelling|narrative)\b/i },
  { tag: "Sales", patterns: /\b(sales|crm|prospect|lead|deal|pipeline|outreach|cold\s*(call|email))\b/i },
  { tag: "Support", patterns: /\b(support|customer|helpdesk|ticket|troubleshoot|faq|knowledge\s*base)\b/i },
  { tag: "Security", patterns: /\b(secur|vulnerabilit|pentest|threat|encrypt|auth(enticat|ori[sz]))\b/i },
  { tag: "Data", patterns: /\b(data|database|sql|etl|warehouse|lake|ingest|transform|schema)\b/i },
  { tag: "AI/ML", patterns: /\b(ai|ml|machine\s*learn|model|train|inference|llm|prompt|embed)\b/i }
];
function deriveSemanticTags(name, description, skillPath) {
  const text = `${name} ${description} ${skillPath}`.toLowerCase();
  const matched = [];
  for (const rule of TAG_RULES) {
    if (rule.patterns.test(text)) {
      matched.push(rule.tag);
    }
    if (matched.length >= 2) break;
  }
  return matched;
}
function execAsync(cmd, args, timeout) {
  return new Promise((resolve2) => {
    execFile(cmd, args, { timeout, env: getCliEnv() }, (err, stdout, stderr) => {
      resolve2({
        exitCode: err ? 1 : 0,
        stdout: stdout || "",
        stderr: stderr || ""
      });
    });
  });
}

// ../OpenClaw-UI-saucer/sidecar/index.ts
var log7 = (...a) => console.error("[sidecar]", ...a);
function send(msg) {
  process2.stdout.write(JSON.stringify(msg) + "\n");
}
function emit(event, payload) {
  send({ event, payload });
}
var WEB_PORT = Number(process2.env.CLUI_WEB_PORT ?? 17817);
var WEB_ROOT = process2.env.CLUI_WEB_ROOT ?? process2.cwd();
var MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2"
};
function startWebServer() {
  const server = createServer2(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/__log") {
        const line = url.searchParams.get("m") ?? "";
        log7("[page]", line);
        try {
          appendFileSync3(join8(WEB_ROOT, "page.log"), `${line}
`);
        } catch {
        }
        res.writeHead(204).end();
        return;
      }
      const rel = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
      const full = normalize2(join8(WEB_ROOT, rel));
      if (!full.startsWith(normalize2(WEB_ROOT) + sep)) {
        res.writeHead(403).end("forbidden");
        return;
      }
      const body = await readFile2(full);
      res.writeHead(200, { "Content-Type": MIME[extname(full).toLowerCase()] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404).end("not found");
    }
  });
  return new Promise((resolve2) => {
    server.listen(WEB_PORT, "127.0.0.1", () => {
      log7(`serving ${WEB_ROOT} on http://127.0.0.1:${WEB_PORT}`);
      resolve2();
    });
  });
}
var INTERACTIVE_PTY = process2.env.CLUI_INTERACTIVE_PERMISSIONS_PTY !== "0";
var controlPlane = new ControlPlane(INTERACTIVE_PTY);
controlPlane.on("event", (tabId, event) => {
  emit("clui:normalized-event", { tabId, event });
});
controlPlane.on("tab-status-change", (tabId, newStatus, oldStatus) => {
  emit("clui:tab-status-change", { tabId, newStatus, oldStatus });
});
controlPlane.on("error", (tabId, error) => {
  emit("clui:enriched-error", { tabId, error });
});
function openWith(command, args) {
  return new Promise((resolve2) => {
    execFile2(
      command,
      args,
      { windowsHide: true },
      (err) => resolve2(err ? { ok: false, error: err.message } : { ok: true })
    );
  });
}
function runCli(args, timeoutMs = 5e3) {
  const { command, args: full } = cliInvocation(args);
  try {
    const stdout = String(
      execFileSync(command, full, {
        encoding: "utf-8",
        timeout: timeoutMs,
        env: getCliEnv(getCliRuntime().extraEnv),
        stdio: ["ignore", "pipe", "pipe"]
      })
    ).trim();
    return { ok: true, stdout };
  } catch (err) {
    return { ok: false, stdout: String(err?.stdout ?? "").trim() };
  }
}
var handlers = {
  // ── Boot path ──
  [IPC.START]: () => {
    const runtime = getCliRuntime();
    let version = "unknown";
    const short = runCli(["-v"]);
    if (short.ok && short.stdout) version = short.stdout;
    else {
      const long = runCli(["--version"]);
      if (long.ok && long.stdout) version = long.stdout;
    }
    let auth = {};
    let authSupported = true;
    const probe = runCli(["auth", "status"]);
    if (probe.ok) {
      try {
        auth = JSON.parse(probe.stdout);
      } catch {
      }
    } else {
      authSupported = false;
    }
    return {
      cliCommand: runtime.kind,
      version,
      homePath: homedir6(),
      email: auth.email ?? null,
      authSupported,
      agentDataHomes: getAgentDataHomes()
    };
  },
  [IPC.CREATE_TAB]: () => ({ tabId: controlPlane.createTab() }),
  // The theme drives every colour in the UI. App.tsx swallows a getTheme
  // rejection with .catch(() => {}), so a missing channel here does not throw —
  // it just renders the whole launcher with no palette, which looks exactly
  // like the app failing to mount. Dark is the shell's default background.
  [IPC.GET_THEME]: () => ({ isDark: true }),
  // Cheap, self-contained channels the UI touches early. Each returns the same
  // shape the Electron handler did; none of them need a window.
  [IPC.IS_VISIBLE]: () => true,
  [IPC.GET_DIAGNOSTICS]: () => ({ platform: process2.platform, node: process2.version }),
  [IPC.GET_RUNTIME_METRICS]: () => ({ cpu: 0, memory: process2.memoryUsage().rss }),
  [IPC.GET_SHORTCUTS]: () => ({ platform: process2.platform, shortcuts: getShortcuts(process2.platform) }),
  // ── Prompts, PTY and the CLI event stream: the reason this process exists ──
  [IPC.PROMPT]: async ({ tabId, requestId, options }) => {
    if (!tabId) throw new Error("No tabId provided \u2014 prompt rejected");
    if (!requestId) throw new Error("No requestId provided \u2014 prompt rejected");
    await controlPlane.submitPrompt(tabId, requestId, options);
    return { accepted: true };
  },
  [IPC.CANCEL]: ({ requestId }) => controlPlane.cancel(requestId),
  [IPC.RETRY]: ({ tabId, requestId, options }) => controlPlane.retry(tabId, requestId, options),
  [IPC.STOP_TAB]: ({ tabId }) => controlPlane.cancelTab(tabId),
  [IPC.CLOSE_TAB]: ({ tabId }) => {
    controlPlane.closeTab(tabId);
    return true;
  },
  [IPC.INIT_SESSION]: ({ tabId }) => {
    controlPlane.initSession(tabId);
    return true;
  },
  [IPC.RESET_TAB_SESSION]: ({ tabId }) => {
    controlPlane.resetTabSession(tabId);
    return true;
  },
  [IPC.SET_PERMISSION_MODE]: ({ mode }) => {
    controlPlane.setPermissionMode(mode);
    return true;
  },
  [IPC.RESPOND_PERMISSION]: ({ tabId, questionId, optionId }) => controlPlane.respondToPermission(tabId, questionId, optionId),
  [IPC.STATUS]: () => controlPlane.getHealth(),
  [IPC.TAB_HEALTH]: ({ tabId }) => controlPlane.getTabStatus(tabId) ?? null,
  [IPC.GET_CONNECTION_TARGET]: () => controlPlane.getConnectionTarget(),
  [IPC.SET_CONNECTION_TARGET]: ({ mode }) => {
    controlPlane.setConnectionTarget({ mode });
    return { ok: true };
  },
  // ── Window-layer channels ──
  //
  // The first four were already no-ops in the Electron main process: the native
  // window is fixed-size and every expand/collapse happens inside the renderer.
  // Kept so the surface is complete rather than erroring.
  [IPC.RESIZE_HEIGHT]: () => true,
  [IPC.SET_WINDOW_WIDTH]: () => true,
  [IPC.ANIMATE_HEIGHT]: () => true,
  [IPC.DRAG_HOLDING]: () => true,
  // SET_IGNORE_MOUSE_EVENTS, HIDE_WINDOW, WINDOW_READY and WINDOW_DISMISS_READY
  // are intercepted by the shim and handled by the shell, which owns the window.
  [IPC.TRACE_SHELL]: () => true,
  [IPC.SET_BRANDING]: () => true,
  // ── Marketplace: the real catalog module, now Electron-free ──
  [IPC.MARKETPLACE_FETCH]: ({ forceRefresh }) => fetchCatalog(forceRefresh),
  [IPC.MARKETPLACE_INSTALLED]: () => listInstalled(),
  [IPC.MARKETPLACE_INSTALL]: (a) => installPlugin(a),
  [IPC.MARKETPLACE_UNINSTALL]: (a) => uninstallPlugin(a),
  // ── CLI-backed channels ──
  [IPC.OPENCLAW_HEALTH]: () => runCli(["doctor"], 2e4),
  [IPC.OPENCLAW_MODEL_INFO]: () => {
    const r = runCli(["config", "get", "models"], 15e3);
    try {
      return { ok: r.ok, models: JSON.parse(r.stdout) };
    } catch {
      return { ok: false, models: null, raw: r.stdout };
    }
  },
  [IPC.OPENCLAW_SET_MODEL]: ({ model }) => runCli(["config", "set", "model", String(model)], 15e3),
  [IPC.OPENCLAW_ONBOARD]: () => runCli(["onboard"], 6e4),
  [IPC.OPENCLAW_RUN]: ({ args }) => runCli(Array.isArray(args) ? args.map(String) : [], 6e4),
  [IPC.NODE_STATUS]: () => runCli(["node", "status"], 2e4),
  [IPC.NODE_ACTION]: ({ action }) => runCli(["node", String(action)], 3e4),
  [IPC.GATEWAY_STATUS]: () => runCli(["gateway", "status"], 2e4),
  [IPC.GATEWAY_PROBE]: () => runCli(["gateway", "probe"], 2e4),
  [IPC.GATEWAY_CONFIG_GET]: async () => {
    try {
      const raw = await readFileAsync(join8(homedir6(), ".openclaw", "openclaw.json"), "utf-8");
      return { ok: true, config: JSON.parse(raw) };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  },
  [IPC.TRANSCRIBE_AUDIO]: ({ audioBase64 }) => {
    const file = join8(tmpdir2(), `clui-audio-${Date.now()}.webm`);
    try {
      __require("node:fs").writeFileSync(file, Buffer.from(String(audioBase64), "base64"));
      const r = runCli(["transcribe", file], 6e4);
      return { error: r.ok ? null : "transcription failed", transcript: r.ok ? r.stdout : null };
    } catch (err) {
      return { error: String(err?.message ?? err), transcript: null };
    }
  },
  // ── Sessions: read the CLI's own session directories ──
  [IPC.LIST_SESSIONS]: async () => {
    const out = [];
    for (const home of getAgentDataHomes()) {
      const root = join8(home, "projects");
      try {
        for (const dir of await readdir2(root)) {
          const full = join8(root, dir);
          try {
            out.push({ project: dir, path: full, mtime: (await stat(full)).mtimeMs });
          } catch {
          }
        }
      } catch {
      }
    }
    return out;
  },
  [IPC.LOAD_SESSION]: async ({ sessionId, projectPath }) => {
    try {
      return { ok: true, content: await readFileAsync(join8(String(projectPath), `${sessionId}.jsonl`), "utf-8") };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  },
  // ── Files ──
  [IPC.PASTE_IMAGE]: async ({ dataUrl }) => {
    const match = String(dataUrl).match(/^data:(image\/(\w+));base64,(.+)$/);
    if (!match) return null;
    const [, mimeType, ext, b64] = match;
    const file = join8(tmpdir2(), `clui-paste-${Date.now()}.${ext}`);
    const buf = Buffer.from(b64, "base64");
    await writeFile2(file, buf);
    return { id: randomUUID2(), type: "image", name: `pasted.${ext}`, path: file, mimeType, dataUrl, size: buf.length };
  },
  [IPC.EXPORT_CONVERSATION]: async ({ content, suggestedName }) => {
    const file = join8(homedir6(), "Downloads", String(suggestedName ?? `conversation-${Date.now()}.md`));
    try {
      await writeFile2(file, String(content), "utf-8");
      return { ok: true, path: file };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  },
  // ── Shell open: no Electron shell module, but Windows ships equivalents ──
  [IPC.OPEN_EXTERNAL]: ({ url }) => openWith("rundll32", ["url.dll,FileProtocolHandler", String(url)]),
  [IPC.OPEN_PATH]: ({ path: target }) => openWith("explorer", [String(target)]),
  [IPC.OPEN_IN_TERMINAL]: ({ projectPath }) => openWith(process2.env.ComSpec ?? "cmd.exe", ["/c", "start", "", "cmd", "/k", `cd /d "${String(projectPath)}"`]),
  // ── Support for the native-UI channels ──
  //
  // C++ owns the dialogs and the capture; it hands back plain paths. Turning
  // those into the attachment objects the renderer expects is file work, so it
  // belongs here rather than in C++.
  "clui:describe-files": async ({ paths }) => {
    const out = [];
    for (const path of (Array.isArray(paths) ? paths : []).map(String)) {
      try {
        const info = await stat(path);
        const ext = (path.split(".").pop() ?? "").toLowerCase();
        const image = ["png", "jpg", "jpeg", "gif", "webp", "bmp"].includes(ext);
        const mimeType = image ? `image/${ext === "jpg" ? "jpeg" : ext}` : "application/octet-stream";
        out.push({
          id: randomUUID2(),
          type: image ? "image" : "file",
          name: path.split(/[\/]/).pop(),
          path,
          mimeType,
          size: info.size,
          // Only images need a preview, and only small ones are worth inlining.
          dataUrl: image && info.size < 8 * 1024 * 1024 ? `data:${mimeType};base64,${(await readFileAsync(path)).toString("base64")}` : void 0
        });
      } catch {
      }
    }
    return out;
  },
  "clui:write-text-file": async ({ path, content }) => {
    try {
      await writeFile2(String(path), String(content), "utf-8");
      return { ok: true, path: String(path) };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  },
  "clui:read-text-file": async ({ path }) => {
    try {
      return { ok: true, content: await readFileAsync(String(path), "utf-8") };
    } catch (err) {
      return { ok: false, error: String(err?.message ?? err) };
    }
  },
  ping: () => "pong",
  /** Introspection so the UI can show exactly how much of the surface is live. */
  "sidecar:channels": () => {
    const all = Object.values(IPC);
    const wired = Object.keys(handlers).filter((k) => all.includes(k));
    return { wired: wired.sort(), wiredCount: wired.length, total: all.length };
  }
};
createInterface({ input: process2.stdin }).on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let req;
  try {
    req = JSON.parse(trimmed);
  } catch {
    log7("unparseable line:", trimmed.slice(0, 120));
    return;
  }
  const handler = handlers[req.channel];
  if (!handler) {
    send({ id: req.id, ok: false, error: `not implemented in sidecar: ${req.channel}` });
    return;
  }
  try {
    send({ id: req.id, ok: true, result: await handler(req.args ?? {}) });
  } catch (err) {
    send({ id: req.id, ok: false, error: String(err?.message ?? err) });
  }
}).on("close", () => {
  log7("stdin closed, shutting down");
  try {
    controlPlane.shutdown();
  } catch {
  }
  process2.exit(0);
});
await startWebServer();
{
  const all = Object.values(IPC);
  const wired = Object.keys(handlers).filter((k) => all.includes(k)).length;
  log7(`ready on node ${process2.version}; ${wired}/${all.length} channels wired`);
  emit("sidecar:ready", { nodeVersion: process2.version, wired, total: all.length, webPort: WEB_PORT });
}
