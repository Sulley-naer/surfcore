// QQ 侧 owner-only 受控命令执行（一问一答式）。
//
// 安全模型（分层，任何一层被绕过都不至于裸奔）：
//   1) 调用层：bridge 只在 `key === private:${ownerQQ}`（owner 私聊）时放行到本模块；
//   2) 命令层：首词白名单 + 每条命令的参数正则 + 危险词黑名单；
//   3) 注入层：拒绝 shell 元字符（; | & < > ^ % $ 反引号 括号 与各类控制符），
//      因此单条命令只能是一个「简单命令」，无法拼接 / 重定向 / 变量展开；
//   4) 资源层：超时 + 输出长度截断 + maxBuffer 上限。
//
// 迁移友好：本模块不硬编码任何绝对路径，cwd 由调用方传入（repo 根 ROOT）；
// 输出里的根路径会被 maskRoot 脱敏成相对路径，既不把本机路径灌进模型上下文，
// 也不依赖任何本机布局。
import { exec } from 'node:child_process';

export const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
export const DEFAULT_EXEC_MAX_OUTPUT_CHARS = 8000;
export const EXEC_MAX_BUFFER_BYTES = 4 * 1024 * 1024; // 4MB，防 stdout 洪峰撑爆内存

// shell 元字符黑名单：命中即整条拒（在首词白名单之前就校验）。
// 覆盖 POSIX sh 与 Windows cmd 的拼接/重定向/变量展开/转义：
//   ; 命令分隔（sh/cmd）   | 管道（sh/cmd）   & 后台/分隔（sh/cmd）
//   < > 重定向（sh/cmd）   ` 命令替换（sh）   $ 变量/命令替换（sh）
//   % 变量展开（cmd）      ^ 转义（cmd）      ( ) 子 shell/分组
//   以及换行/回车/制表等控制符（防用控制符拼第二条命令）。
const SHELL_META_RE = /[;|&<>`$%^()\t\n\r\f\v\u0000]/;

// 首词 -> 策略。args 是「首词之后整段参数」的正则（去首尾空白后再匹配），
// deny 是危险词黑名单正则，命中任一条即拒。首词先剥掉 `.exe` 后缀再查表。
const EXEC_POLICY = {
  git: {
    args: /^(?:--version|-v|status(?:\s|$)|log(?:\s|$)|diff(?:\s|$)|show(?:\s|$)|branch(?:\s|$)|rev-parse(?:\s|$)|remote\s+-v\b)/,
    deny: /\b(?:push|pull|fetch|commit|merge|rebase|checkout|switch|reset|clean|stash|cherry-pick|tag|add|rm|mv|init|clone|restore|revert|gc|prune|apply|am|archive|bundle|fsck|reflog|config)\b|--output/,
  },
  // node/npm/pnpm 只放版本号查询：`node -e`、`node 任意.js`、`npm run 任意脚本`
  // 本质都是「执行任意代码」，第一版一律不放行，需要时再逐条白名单。
  node: { args: /^(?:-v|--version)$/ },
  npm: { args: /^(?:-v|--version)$/ },
  pnpm: { args: /^(?:-v|--version)$/ },
  ls: { args: /.*/ },
  dir: { args: /.*/ },
  cat: { args: /.*/ },
  type: { args: /.*/ },
  more: { args: /.*/ },
  grep: { args: /.*/ },
  rg: { args: /.*/ },
  find: { args: /.*/, deny: /(?:^|\s)(?:-exec|-execdir|-ok|-delete)(?:\s|=|$)/ },
  where: { args: /.*/ },
  which: { args: /.*/ },
  echo: { args: /.*/ },
  pwd: { args: /^$/ },
};

function clampInt(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

export function normalizeExecConfig(input = {}) {
  return {
    enabled: input.enabled !== false,
    timeoutMs: clampInt(input.timeoutMs, DEFAULT_EXEC_TIMEOUT_MS, 5000, 300_000),
    maxOutputChars: clampInt(input.maxOutputChars, DEFAULT_EXEC_MAX_OUTPUT_CHARS, 200, 40_000),
  };
}

/** 返回拒绝原因字符串，通过则返回 null。 */
export function policyError(command) {
  const raw = String(command ?? '').trim();
  if (!raw) return '命令不能为空';
  if (raw.length > 500) return '命令过长（>500 字符）';
  if (SHELL_META_RE.test(raw)) {
    return '命令含被禁止的 shell 元字符（; | & < > ` $ % ^ ( ) 或控制符），只允许单个简单命令';
  }
  const headMatch = /^(\S+)/.exec(raw);
  const headRaw = headMatch ? headMatch[1] : '';
  const head = headRaw.toLowerCase().replace(/\.exe$/i, '');
  const policy = EXEC_POLICY[head];
  if (!policy) return `命令不在白名单内：${headRaw || '(空)'}`;
  const rest = raw.slice(headRaw.length).trim();
  if (policy.args && !policy.args.test(rest)) return `命令参数不允许：${head} ${rest}`;
  if (policy.deny && policy.deny.test(rest)) return `命令被危险词拦截：${head} ${rest}`;
  return null;
}

/** 把输出里出现的根路径（Win/POSIX 两种写法）替换成相对占位 `.`。 */
function maskPaths(text, root) {
  if (!root || !text) return text;
  const win = String(root).replace(/\//g, '\\');
  const posix = String(root).replace(/\\/g, '/');
  return text.split(win).join('.').split(posix).join('.');
}

/**
 * 执行一条已通过 policyError 的命令，返回结构化结果（永不 reject）。
 * 返回 { ok, command, code, stdout, stderr, output, truncated, durationMs, error }。
 */
export function runCommand(command, {
  cwd,
  timeoutMs = DEFAULT_EXEC_TIMEOUT_MS,
  maxOutputChars = DEFAULT_EXEC_MAX_OUTPUT_CHARS,
  maskRoot = null,
} = {}) {
  const cmd = String(command ?? '').trim();
  const reason = policyError(cmd);
  if (reason) {
    return Promise.resolve({
      ok: false, command: cmd, code: null, stdout: '', stderr: '',
      output: '', truncated: false, durationMs: 0, error: reason,
    });
  }
  return new Promise((resolve) => {
    const started = Date.now();
    exec(cmd, {
      cwd: cwd || undefined,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: EXEC_MAX_BUFFER_BYTES,
      encoding: 'utf8',
    }, (error, stdout, stderr) => {
      const durationMs = Date.now() - started;
      let out = maskPaths(String(stdout ?? ''), maskRoot);
      let err = maskPaths(String(stderr ?? ''), maskRoot);
      const rawLen = out.length + err.length;

      let code = 0;
      let errMsg = null;
      if (error) {
        if (error.killed) {
          code = 'TIMEOUT';
          errMsg = `超时（>${timeoutMs}ms），已终止`;
        } else if (typeof error.code === 'number') {
          code = error.code; // 正常退出但码非 0：正文在 stderr
        } else {
          code = 1;
          errMsg = String(error.message || error);
        }
        if (/maxBuffer/i.test(String(error.message || ''))) {
          errMsg = `输出超过 ${EXEC_MAX_BUFFER_BYTES} 字节上限，已终止`;
        }
      }

      let combined = (err.trim() ? `[stderr]\n${err.trim()}\n` : '') + out;
      const truncated = combined.length > maxOutputChars;
      if (truncated) {
        combined = combined.slice(0, maxOutputChars) + `\n…（已截断，原始约 ${rawLen} 字符）`;
      }

      resolve({
        ok: code === 0,
        command: cmd,
        code,
        stdout: out,
        stderr: err,
        output: combined.trim(),
        truncated,
        durationMs,
        error: errMsg,
      });
    });
  });
}
