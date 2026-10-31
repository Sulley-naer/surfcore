// QQ 侧 owner-only 受控命令执行（一问一答式）。
//
// 安全模型（分层，任何一层被绕过都不至于裸奔）：
//   1) 调用层：bridge 只在 `key === private:${ownerQQ}`（owner 私聊）时放行到本模块；
//   2) 模式层：默认「黑名单」模式——放行任意命令，只拦破坏性指令；可切回「白名单」
//      模式（首词白名单 + 参数正则 + 危险词）作为保守回退；
//   3) 注入层：两种模式都拒绝命令替换/变量展开/转义（` $ % ^ ( ) 与控制符），
//      白名单模式额外拒绝拼接/重定向（; | & < >）；
//   4) 资源层：超时 + 输出长度截断 + maxBuffer 上限。
//
// 迁移友好：不硬编码绝对路径；cwd 与 maskRoot 由调用方传入（黑名单模式传用户主目录、
// 不脱敏；白名单模式传 repo 根 ROOT 并脱敏成 `.`）。
import { exec } from 'node:child_process';

export const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
export const DEFAULT_EXEC_MAX_OUTPUT_CHARS = 8000;
export const EXEC_MAX_BUFFER_BYTES = 4 * 1024 * 1024; // 4MB，防 stdout 洪峰撑爆内存

// —— 白名单模式的元字符黑名单：命中即整条拒（在首词白名单之前就校验）。
// 覆盖 POSIX sh 与 Windows cmd 的拼接/重定向/变量展开/转义。
const SHELL_META_RE = /[;|&<>`$%^()\t\n\r\f\v\u0000]/;

// —— 黑名单模式的元字符黑名单：比白名单宽松，放行拼接/重定向/分组（; | & < > ( )），
// 只拒「命令替换/变量展开/转义」这类能隐藏真实意图的高危元字符：
//   ` 命令替换（sh）   $ 变量/命令替换（sh）   % 变量展开（cmd）
//   ^ 转义（cmd，可绕过关键字匹配）
//   以及换行/回车/制表等控制符（防用控制符拼第二条命令）。
// 注：不拦 ( )——分组/子 shell 内的命令同样会被下方的破坏性黑名单整串扫描命中。
const BLACKLIST_META_RE = /[`$%^\t\n\r\f\v\u0000]/;

// —— 白名单模式：首词 -> 策略（args 是「首词之后整段参数」的正则，deny 是危险词黑名单）。
const EXEC_POLICY = {
  git: {
    args: /^(?:--version|-v|status(?:\s|$)|log(?:\s|$)|diff(?:\s|$)|show(?:\s|$)|branch(?:\s|$)|rev-parse(?:\s|$)|remote\s+-v\b)/,
    deny: /\b(?:push|pull|fetch|commit|merge|rebase|checkout|switch|reset|clean|stash|cherry-pick|tag|add|rm|mv|init|clone|restore|revert|gc|prune|apply|am|archive|bundle|fsck|reflog|config)\b|--output/,
  },
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

// —— 黑名单模式：破坏性指令黑名单（扫描整条命令字符串，命中任一条即整条拒）。
// 聚焦「不可逆、大范围、或系统级」的破坏；单文件删除（del x.txt / rm x.txt 不带
// 递归/强制参数）等常规操作放行，保证「权限大」的定位。
const DANGEROUS_RULES = [
  { re: /\b(?:del|erase)\b[^|&;<]*\/[sq]/i, note: '递归/静默删除（del /s /q）' },
  { re: /\b(?:rd|rmdir)\b[^|&;<]*\/s/i, note: '递归删除目录（rd /s）' },
  { re: /\brm\b[^|&;<]*(?:-[A-Za-z]*[rf]|--recursive|--force)/i, note: '递归/强制删除（rm -r/-f）' },
  { re: /\bdeltree\b/i, note: '递归删除（deltree）' },
  { re: /\bformat\b/i, note: '格式化磁盘' },
  { re: /\bmkfs(?:\.\w+)?\b/i, note: '创建文件系统（格式化）' },
  { re: /\bdiskpart\b/i, note: '磁盘分区（破坏性）' },
  { re: /\bdd\b/i, note: '磁盘扇区读写（dd）' },
  { re: /\bmountvol\b/i, note: '卷挂载操作' },
  { re: /\b(?:shutdown|reboot|halt|poweroff|logoff)\b/i, note: '关机/重启/注销' },
  { re: /\binit\s+[06]\b/i, note: '运行级切换（关机/重启）' },
  { re: /\bbcdedit\b/i, note: '修改引导配置' },
  { re: /\bfsutil\b/i, note: '文件系统底层工具' },
  { re: /\b(?:icacls|cacls|xcacls|takeown)\b/i, note: 'ACL/文件所有权修改' },
  { re: /\bchmod\b/i, note: '修改文件权限' },
  { re: /\bchown\b/i, note: '修改文件属主' },
  { re: /\breg\b[^|&;<]*\b(?:add|delete|import|copy|load|unload|save)\b/i, note: '注册表写入/删除' },
  { re: /\b(?:taskkill|killall|pkill|kill)\b/i, note: '杀进程' },
  { re: /\bsc\b\s+(?:stop|delete|config|create)\b/i, note: '服务停止/删除/配置' },
  { re: /\bnet\s+(?:user|localgroup|stop|share|use|accounts|session)\b/i, note: '账户/服务/共享操作' },
  { re: /\bnetsh\b/i, note: '网络配置修改' },
  { re: /\bcipher\b/i, note: '磁盘覆写（cipher）' },
  { re: /\brobocopy\b[^|&;<]*\/mir\b/i, note: '镜像复制（破坏目标）' },
  { re: /:\(\)\s*\{/i, note: 'fork bomb' },
  { re: /:\|\s*:\s*&/i, note: 'fork bomb' },
];

function clampInt(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(n)));
}

export function normalizeExecConfig(input = {}) {
  return {
    enabled: input.enabled !== false,
    mode: input.mode === 'whitelist' ? 'whitelist' : 'blacklist',
    timeoutMs: clampInt(input.timeoutMs, DEFAULT_EXEC_TIMEOUT_MS, 5000, 300_000),
    maxOutputChars: clampInt(input.maxOutputChars, DEFAULT_EXEC_MAX_OUTPUT_CHARS, 200, 40_000),
  };
}

/** 返回拒绝原因字符串，通过则返回 null。mode: 'blacklist'（默认）| 'whitelist'。 */
export function policyError(command, { mode = 'blacklist' } = {}) {
  const raw = String(command ?? '').trim();
  if (!raw) return '命令不能为空';
  if (raw.length > 500) return '命令过长（>500 字符）';

  if (mode === 'whitelist') {
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

  // 黑名单模式：默认放行，只拦破坏性指令 + 高危元字符。
  if (BLACKLIST_META_RE.test(raw)) {
    return '命令含被禁止的 shell 元字符（` $ % ^ 或控制符），不允许命令替换/变量展开/转义';
  }
  for (const rule of DANGEROUS_RULES) {
    if (rule.re.test(raw)) return `命令被破坏性指令黑名单拦截：${rule.note}`;
  }
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
  mode = 'blacklist',
} = {}) {
  const cmd = String(command ?? '').trim();
  const reason = policyError(cmd, { mode });
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
