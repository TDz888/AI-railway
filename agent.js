'use strict';

const OpenAI = require('openai');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');

const MAX_ITERATIONS = 30;
const MAX_TOOL_OUTPUT = 12000;
const DEFAULT_BASH_TIMEOUT = 60;

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Execute a shell command on the VPS. This is your primary tool. Use for: running scripts, installing packages, exploring files (ls, find, grep), git operations, running servers, checking system state. Working directory is the workspace.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The bash command to execute' },
          timeout: { type: 'number', description: 'Timeout in seconds. Default 60, max 300.' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the content of a file. Returns content with line numbers.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to workspace, or absolute path inside /data' },
          offset: { type: 'number', description: 'Start line (1-indexed). Optional.' },
          limit: { type: 'number', description: 'Number of lines to read. Optional.' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Create a new file or completely overwrite an existing file. Parent directories are created automatically.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to workspace' },
          content: { type: 'string', description: 'Full file content' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Replace an exact string in a file. The old_string must be unique in the file or the edit fails. Use for targeted modifications.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to workspace' },
          old_string: { type: 'string', description: 'Exact string to replace. Must be unique.' },
          new_string: { type: 'string', description: 'Replacement string' }
        },
        required: ['path', 'old_string', 'new_string']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: 'List files and directories. Returns name, type (file/dir), and size.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Path relative to workspace. Default is workspace root.' },
          recursive: { type: 'boolean', description: 'If true, walk recursively (max depth 3).' }
        }
      }
    }
  }
];

const DEFAULT_SYSTEM_PROMPT = `You are AI VPS, an autonomous coding agent running on a Debian Linux container with full shell access.

# Tools
- bash: execute shell commands (your primary tool)
- read_file: read a file with optional line range
- write_file: create or overwrite a file
- edit_file: replace exact string in a file (must be unique)
- list_files: list directory contents

# Working principles
1. PLAN multi-step tasks before executing
2. EXPLORE first (ls, cat, grep) before modifying
3. READ a file before editing it
4. TEST commands when possible (run scripts, check syntax)
5. When a command fails, READ the error and adjust — do not retry the same command
6. Keep the user informed — briefly explain what you're doing
7. When done, SUMMARIZE what was accomplished

# Environment
- OS: Debian 12 (bookworm)
- Working directory: /data/workspace (this is where you live)
- Persistent paths: everything under /data/*
- Python packages: pip3 install --target=/data/pylib <pkg> (PYTHONPATH is set)
- Node global: npm i -g --prefix=/data/npm-global <pkg> (PATH is set)
- Available: bash, git, python3, node, npm, curl, wget, tmux, vim, nano, jq, gcc, g++, make

# Safety rules
- NEVER print or transmit contents of /data/config.json, secrets, tokens, or SSH keys
- NEVER run: rm -rf /, dd if=/dev/zero, mkfs, fork bombs
- Ask before: dropping databases, deleting entire /data directories, killing unrelated processes
- Prefer reversible actions

# Output style
- Concise, direct, no fluff
- Use markdown for explanations
- Show commands in code blocks`;

function safePath(workspace, raw, allowDataRoot = false) {
  if (typeof raw !== 'string' || !raw) throw new Error('Path is required');
  const base = allowDataRoot ? '/data' : workspace;
  const normalized = path.isAbsolute(raw)
    ? path.normalize(raw)
    : path.normalize(path.join(base, raw));
  if (!normalized.startsWith('/data')) throw new Error('Path must be inside /data');
  return normalized;
}

function truncate(str, max = MAX_TOOL_OUTPUT) {
  if (typeof str !== 'string') return '';
  if (str.length <= max) return str;
  const keep = Math.floor((max - 200) / 2);
  return str.slice(0, keep) + '\n\n... [' + (str.length - keep * 2) + ' chars truncated] ...\n\n' + str.slice(-keep);
}

function stripAnsi(str) {
  return String(str).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
}

async function execBash(command, cwd, timeoutSec, onOutput, signal) {
  return new Promise((resolve) => {
    const started = Date.now();
    let stdout = '';
    let stderr = '';
    let killed = false;

    const child = spawn('bash', ['-lc', command], {
      cwd,
      env: {
        ...process.env,
        PATH: '/data/npm-global/bin:/data/bin:' + process.env.PATH,
        PYTHONPATH: '/data/pylib' + (process.env.PYTHONPATH ? ':' + process.env.PYTHONPATH : ''),
        NPM_CONFIG_PREFIX: '/data/npm-global'
      }
    });

    const timer = setTimeout(() => {
      killed = true;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000);
    }, Math.min(timeoutSec || DEFAULT_BASH_TIMEOUT, 300) * 1000);

    const abortHandler = () => {
      killed = true;
      try { child.kill('SIGTERM'); } catch {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, 3000);
    };
    if (signal) signal.addEventListener('abort', abortHandler, { once: true });

    const flushLine = (chunk, isErr) => {
      const text = stripAnsi(chunk.toString());
      if (isErr) stderr += text; else stdout += text;
      if (onOutput) onOutput({ stream: isErr ? 'stderr' : 'stdout', data: text });
    };

    child.stdout.on('data', d => flushLine(d, false));
    child.stderr.on('data', d => flushLine(d, true));

    child.on('error', err => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abortHandler);
      resolve({
        exitCode: -1,
        stdout: '',
        stderr: err.message,
        duration: Date.now() - started,
        killed: false
      });
    });

    child.on('close', code => {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', abortHandler);
      resolve({
        exitCode: killed ? 124 : (code == null ? -1 : code),
        stdout: stripAnsi(stdout),
        stderr: stripAnsi(stderr),
        duration: Date.now() - started,
        killed
      });
    });
  });
}

async function executeTool(name, args, ctx) {
  const { workspace, emit, signal } = ctx;
  const started = Date.now();

  try {
    if (name === 'bash') {
      const command = String(args.command || '');
      if (!command.trim()) return { ok: false, output: 'Error: empty command' };
      const result = await execBash(command, workspace, args.timeout, (line) => {
        emit({ type: 'tool_output', id: ctx.toolCallId, stream: line.stream, data: line.data });
      }, signal);
      const out = (result.stdout + (result.stderr ? (result.stdout ? '\n' : '') + result.stderr : '')).trim();
      const summary = result.killed
        ? `Command timed out after ${result.duration}ms\n${out}`
        : `exit ${result.exitCode} · ${result.duration}ms\n${out}`;
      return {
        ok: result.exitCode === 0,
        output: truncate(out || '(no output)'),
        meta: { exitCode: result.exitCode, duration: result.duration, killed: result.killed }
      };
    }

    if (name === 'read_file') {
      const full = safePath(workspace, args.path, true);
      const st = await fs.stat(full).catch(() => null);
      if (!st || !st.isFile()) return { ok: false, output: 'Error: file not found: ' + args.path };
      const raw = await fs.readFile(full, 'utf8');
      const lines = raw.split('\n');
      const offset = Math.max(1, parseInt(args.offset, 10) || 1);
      const limit = parseInt(args.limit, 10) || 0;
      const slice = limit ? lines.slice(offset - 1, offset - 1 + limit) : lines.slice(offset - 1);
      const numbered = slice.map((l, i) => String(offset + i).padStart(6) + '  ' + l).join('\n');
      return { ok: true, output: truncate(numbered || '(empty file)'), meta: { lines: lines.length } };
    }

    if (name === 'write_file') {
      const full = safePath(workspace, args.path);
      await fs.mkdir(path.dirname(full), { recursive: true });
      const content = String(args.content || '');
      await fs.writeFile(full, content, 'utf8');
      return {
        ok: true,
        output: 'Wrote ' + full + ' (' + content.length + ' bytes)',
        meta: { path: full, bytes: content.length }
      };
    }

    if (name === 'edit_file') {
      const full = safePath(workspace, args.path);
      const oldStr = String(args.old_string || '');
      const newStr = String(args.new_string || '');
      if (!oldStr) return { ok: false, output: 'Error: old_string is empty' };
      const raw = await fs.readFile(full, 'utf8').catch(() => null);
      if (raw == null) return { ok: false, output: 'Error: file not found: ' + args.path };
      const count = raw.split(oldStr).length - 1;
      if (count === 0) return { ok: false, output: 'Error: old_string not found in file' };
      if (count > 1) return { ok: false, output: 'Error: old_string appears ' + count + ' times, must be unique' };
      const updated = raw.replace(oldStr, newStr);
      await fs.writeFile(full, updated, 'utf8');
      return { ok: true, output: 'Edited ' + full, meta: { path: full } };
    }

    if (name === 'list_files') {
      const full = safePath(workspace, args.path || '.', true);
      const recursive = !!args.recursive;
      const MAX_DEPTH = 3;
      const results = [];
      async function walk(dir, depth) {
        const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
        for (const e of entries) {
          if (e.name === 'node_modules' || e.name === '.git') continue;
          const fp = path.join(dir, e.name);
          const rel = path.relative(full, fp) || e.name;
          if (e.isDirectory()) {
            results.push({ name: rel + '/', type: 'dir' });
            if (recursive && depth < MAX_DEPTH) await walk(fp, depth + 1);
          } else {
            const st = await fs.stat(fp).catch(() => null);
            results.push({ name: rel, type: 'file', size: st ? st.size : 0 });
          }
        }
      }
      await walk(full, 0);
      const out = results.map(r => r.type === 'dir' ? r.name : r.name + '  (' + r.size + ' B)').join('\n');
      return { ok: true, output: truncate(out || '(empty)'), meta: { count: results.length } };
    }

    return { ok: false, output: 'Error: unknown tool ' + name };
  } catch (err) {
    return { ok: false, output: 'Error: ' + (err.message || String(err)) };
  }
}

async function runAgent({ messages, config, workspace, emit, signal }) {
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseUrl,
    timeout: 120000,
    maxRetries: 1
  });

  const systemPrompt = (config.systemPrompt && config.systemPrompt.trim()) || DEFAULT_SYSTEM_PROMPT;
  const workingMessages = [
    { role: 'system', content: systemPrompt },
    ...messages
  ];

  let finalText = '';
  let totalToolCalls = 0;
  let promptTokens = 0;
  let completionTokens = 0;

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    if (signal.aborted) throw new Error('Aborted');

    emit({ type: 'iteration', index: iter + 1 });

    let stream;
    try {
      stream = await client.chat.completions.create({
        model: config.model,
        messages: workingMessages,
        tools: TOOLS,
        tool_choice: 'auto',
        stream: true,
        stream_options: { include_usage: true }
      }, { signal });
    } catch (err) {
      throw new Error('LLM request failed: ' + (err.message || String(err)));
    }

    let textBuffer = '';
    const toolCallAcc = new Map();

    for await (const chunk of stream) {
      if (signal.aborted) throw new Error('Aborted');

      if (chunk.usage) {
        promptTokens += chunk.usage.prompt_tokens || 0;
        completionTokens += chunk.usage.completion_tokens || 0;
      }

      const choice = chunk.choices && chunk.choices[0];
      if (!choice) continue;
      const delta = choice.delta || {};

      if (delta.content) {
        textBuffer += delta.content;
        emit({ type: 'text_delta', delta: delta.content });
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index || 0;
          let acc = toolCallAcc.get(idx);
          if (!acc) {
            acc = { id: '', name: '', args: '' };
            toolCallAcc.set(idx, acc);
          }
          if (tc.id) acc.id = tc.id;
          if (tc.function && tc.function.name) acc.name = tc.function.name;
          if (tc.function && tc.function.arguments) acc.args += tc.function.arguments;
        }
      }
    }

    if (textBuffer.trim()) finalText += (finalText ? '\n\n' : '') + textBuffer;

    const toolCalls = Array.from(toolCallAcc.values()).filter(t => t.name);

    if (toolCalls.length === 0) {
      workingMessages.push({ role: 'assistant', content: textBuffer });
      break;
    }

    const assistantMsg = {
      role: 'assistant',
      content: textBuffer || null,
      tool_calls: toolCalls.map((tc, i) => ({
        id: tc.id || 'call_' + iter + '_' + i,
        type: 'function',
        function: { name: tc.name, arguments: tc.args || '{}' }
      }))
    };
    workingMessages.push(assistantMsg);

    for (let i = 0; i < toolCalls.length; i++) {
      if (signal.aborted) throw new Error('Aborted');
      const tc = toolCalls[i];
      const callId = assistantMsg.tool_calls[i].id;

      let args = {};
      try { args = JSON.parse(tc.args || '{}'); } catch { args = {}; }

      emit({
        type: 'tool_start',
        id: callId,
        name: tc.name,
        args
      });

      const result = await executeTool(tc.name, args, {
        workspace,
        emit,
        signal,
        toolCallId: callId
      });

      totalToolCalls++;

      emit({
        type: 'tool_result',
        id: callId,
        ok: result.ok,
        output: result.output,
        meta: result.meta || null
      });

      workingMessages.push({
        role: 'tool',
        tool_call_id: callId,
        content: result.output
      });
    }
  }

  emit({
    type: 'done',
    text: finalText,
    stats: {
      iterations: Math.min(MAX_ITERATIONS, totalToolCalls + 1),
      toolCalls: totalToolCalls,
      promptTokens,
      completionTokens
    }
  });

  return { text: finalText, stats: { totalToolCalls, promptTokens, completionTokens } };
}

module.exports = {
  runAgent,
  TOOLS,
  DEFAULT_SYSTEM_PROMPT
};
